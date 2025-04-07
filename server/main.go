package main

import (
	"encoding/json"
	"fmt"
	"log"
	"math/rand"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v3"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

type Peer struct {
	conn     *websocket.Conn
	pc       *webrtc.PeerConnection
	username string
	room     string
	isStreaming bool
}

type RoomInfo struct {
	Users []string `json:"users"`
	StreamingUsers []string `json:"streamingUsers"`
}

type Message struct {
	Type string      `json:"type"`
	Data interface{} `json:"data"`
}

var (
	peers     = make(map[string]*Peer) // key: conn.RemoteAddr().String()
	rooms     = make(map[string]map[string]*Peer) // key: room name
	mu        sync.Mutex
	letters   = []rune("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ")
)

func init() {
	rand.Seed(time.Now().UnixNano())
}

func randSeq(n int) string {
	b := make([]rune, n)
	for i := range b {
		b[i] = letters[rand.Intn(len(letters))]
	}
	return string(b)
}

func main() {
	http.HandleFunc("/ws", handleWebSocket)
	http.HandleFunc("/rooms", listRooms)
	fs := http.FileServer(http.Dir("./static"))
	http.Handle("/", fs)

	fmt.Println("Сервер запущен на :8080")
	log.Fatal(http.ListenAndServe(":8080", nil))
}

func handleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("WebSocket upgrade error:", err)
		return
	}
	defer conn.Close()

	// Получаем начальные данные (комнату и ник)
	var initData struct {
		Action   string `json:"action"`
		Room     string `json:"room"`
		Username string `json:"username"`
	}
	err = conn.ReadJSON(&initData)
	if err != nil {
		log.Println("Read init data error:", err)
		return
	}

	if initData.Action != "join" {
		return
	}

	// Проверяем уникальность ника в комнате
	mu.Lock()
	if roomPeers, exists := rooms[initData.Room]; exists {
		if _, userExists := roomPeers[initData.Username]; userExists {
			conn.WriteJSON(Message{
				Type: "error",
				Data: "Username already exists in this room",
			})
			mu.Unlock()
			return
		}
	}
	mu.Unlock()

	// Создаем PeerConnection
	config := webrtc.Configuration{
		ICEServers: []webrtc.ICEServer{{URLs: []string{"stun:stun.l.google.com:19302"}}},
	}

	peerConnection, err := webrtc.NewPeerConnection(config)
	if err != nil {
		log.Println("PeerConnection error:", err)
		return
	}

	peer := &Peer{
		conn:     conn,
		pc:       peerConnection,
		username: initData.Username,
		room:     initData.Room,
		isStreaming: false,
	}

	// Добавляем в комнату
	mu.Lock()
	if _, exists := rooms[initData.Room]; !exists {
		rooms[initData.Room] = make(map[string]*Peer)
	}
	rooms[initData.Room][initData.Username] = peer
	peers[conn.RemoteAddr().String()] = peer
	mu.Unlock()

	// Отправляем информацию о комнате
	sendRoomInfo(initData.Room)

	// Обработка сообщений от клиента
	for {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			log.Println("Read error:", err)
			break
		}

		var data map[string]interface{}
		if err := json.Unmarshal(msg, &data); err != nil {
			log.Println("JSON unmarshal error:", err)
			continue
		}

		// Обработка выхода из комнаты
		if action, ok := data["action"]; ok && action == "leave" {
			break
		}

		// Обработка старта трансляции
		if action, ok := data["action"]; ok && action == "start_stream" {
			mu.Lock()
			peer.isStreaming = true
			mu.Unlock()
			sendRoomInfo(peer.room)
			continue
		}

		// Обработка завершения трансляции
		if action, ok := data["action"]; ok && action == "end_stream" {
			mu.Lock()
			peer.isStreaming = false
			mu.Unlock()
			sendRoomInfo(peer.room)

			// Отправляем уведомление о завершении трансляции
			mu.Lock()
			for username, p := range rooms[peer.room] {
				if username != peer.username {
					p.conn.WriteJSON(Message{
						Type: "stream_ended",
						Data: peer.username,
					})
				}
			}
			mu.Unlock()
			continue
		}

		// Передаем только WebRTC данные другим участникам комнаты
		if _, isRTCMessage := data["sdp"]; isRTCMessage || data["ice"] != nil {
			mu.Lock()
			for username, p := range rooms[peer.room] {
				if username != peer.username {
					p.conn.WriteMessage(websocket.TextMessage, msg)
				}
			}
			mu.Unlock()
		}
	}

	// Удаляем при отключении
	mu.Lock()
	delete(peers, conn.RemoteAddr().String())
	delete(rooms[peer.room], peer.username)
	if len(rooms[peer.room]) == 0 {
		delete(rooms, peer.room)
	} else {
		// Отправляем уведомление о выходе пользователя
		for _, p := range rooms[peer.room] {
			p.conn.WriteJSON(Message{
				Type: "user_left",
				Data: peer.username,
			})
		}
	}
	mu.Unlock()

	// Обновляем информацию о комнате
	sendRoomInfo(peer.room)
}

func sendRoomInfo(room string) {
	mu.Lock()
	defer mu.Unlock()

	if roomPeers, exists := rooms[room]; exists {
		users := make([]string, 0, len(roomPeers))
		streamingUsers := make([]string, 0)
		for username, peer := range roomPeers {
			users = append(users, username)
			if peer.isStreaming {
				streamingUsers = append(streamingUsers, username)
			}
		}

		roomInfo := RoomInfo{
			Users: users,
			StreamingUsers: streamingUsers,
		}

		for _, peer := range roomPeers {
			peer.conn.WriteJSON(Message{
				Type: "room_info",
				Data: roomInfo,
			})
		}
	}
}

func listRooms(w http.ResponseWriter, r *http.Request) {
	mu.Lock()
	defer mu.Unlock()

	roomList := make(map[string]RoomInfo)
	for room, peers := range rooms {
		users := make([]string, 0, len(peers))
		streamingUsers := make([]string, 0)
		for user, peer := range peers {
			users = append(users, user)
			if peer.isStreaming {
				streamingUsers = append(streamingUsers, user)
			}
		}
		roomList[room] = RoomInfo{
			Users: users,
			StreamingUsers: streamingUsers,
		}
	}

	json.NewEncoder(w).Encode(roomList)
}