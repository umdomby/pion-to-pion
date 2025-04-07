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
}

type RoomInfo struct {
	Users []string `json:"users"`
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
		Room     string `json:"room"`
		Username string `json:"username"`
	}
	err = conn.ReadJSON(&initData)
	if err != nil {
		log.Println("Read init data error:", err)
		return
	}

	// Проверяем уникальность ника в комнате
	mu.Lock()
	if roomPeers, exists := rooms[initData.Room]; exists {
		if _, userExists := roomPeers[initData.Username]; userExists {
			conn.WriteJSON(map[string]interface{}{
				"type": "error",
				"data": "Username already exists in this room",
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
		for username := range roomPeers {
			users = append(users, username)
		}

		roomInfo := RoomInfo{Users: users}

		for _, peer := range roomPeers {
			peer.conn.WriteJSON(map[string]interface{}{
				"type": "room_info",
				"data": roomInfo,
			})
		}
	}
}

func listRooms(w http.ResponseWriter, r *http.Request) {
	mu.Lock()
	defer mu.Unlock()

	roomList := make(map[string][]string)
	for room, peers := range rooms {
		users := make([]string, 0, len(peers))
		for user := range peers {
			users = append(users, user)
		}
		roomList[room] = users
	}

	json.NewEncoder(w).Encode(roomList)
}