package main

import (
	"encoding/json"
	"log"
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
	peers   = make(map[string]*Peer) // key: remoteAddr
	rooms   = make(map[string]map[string]*Peer) // key: room name, value: map of peers in room
	mu      sync.Mutex
)

func cleanupPeer(peer *Peer) {
	if peer == nil {
		return
	}

	log.Printf("[CLEANUP] Cleaning up peer %s in room %s", peer.username, peer.room)

	if peer.pc != nil {
		peer.pc.Close()
	}
	if peer.conn != nil {
		peer.conn.Close()
	}
}

func handleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("[ERROR] WebSocket upgrade failed: %v", err)
		return
	}

	remoteAddr := conn.RemoteAddr().String()
	log.Printf("[CONNECT] New connection from: %s", remoteAddr)

	// Устанавливаем таймауты для соединения
	conn.SetReadDeadline(time.Now().Add(10 * time.Second)) // Таймаут для начальных данных
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(30 * time.Second))
		return nil
	})

	var peer *Peer
	defer func() {
		mu.Lock()
		defer mu.Unlock()

		if peer != nil {
			// Удаляем peer из комнаты
			if roomPeers, exists := rooms[peer.room]; exists {
				delete(roomPeers, peer.username)
				if len(roomPeers) == 0 {
					delete(rooms, peer.room)
					log.Printf("[ROOM] Room '%s' is now empty", peer.room)
				} else {
					sendRoomInfo(peer.room)
				}
			}
			// Удаляем peer из общего списка
			delete(peers, remoteAddr)
			cleanupPeer(peer)
		}
		conn.Close()
		log.Printf("[DISCONNECT] Connection closed for %s", remoteAddr)
	}()

	// Читаем начальные данные
	var initData struct {
		Room     string `json:"room"`
		Username string `json:"username"`
		Create   bool   `json:"create"`
	}

	if err := conn.ReadJSON(&initData); err != nil {
		log.Printf("[ERROR] Failed to read init data from %s: %v", remoteAddr, err)
		return
	}

	// Сбрасываем таймаут после успешного чтения начальных данных
	conn.SetReadDeadline(time.Time{})

	log.Printf("[JOIN] User '%s' joining room '%s' (create: %v)", initData.Username, initData.Room, initData.Create)

	mu.Lock()
	// Проверяем, существует ли комната и пользователь
	if roomPeers, exists := rooms[initData.Room]; exists {
		if _, userExists := roomPeers[initData.Username]; userExists {
			log.Printf("[ERROR] Username '%s' already in room '%s'", initData.Username, initData.Room)
			conn.WriteJSON(map[string]interface{}{
				"type": "error",
				"data": "Username already exists in this room",
			})
			mu.Unlock()
			return
		}
	} else if !initData.Create {
		log.Printf("[ERROR] Room '%s' doesn't exist", initData.Room)
		conn.WriteJSON(map[string]interface{}{
			"type": "error",
			"data": "Room doesn't exist",
		})
		mu.Unlock()
		return
	}

	// Создаем новую peer connection
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{
		ICEServers: []webrtc.ICEServer{{URLs: []string{"stun:stun.l.google.com:19302"}}},
	})
	if err != nil {
		log.Printf("[ERROR] Failed to create PeerConnection: %v", err)
		mu.Unlock()
		return
	}

	// Создаем peer и добавляем его в комнату
	peer = &Peer{
		conn:     conn,
		pc:       pc,
		username: initData.Username,
		room:     initData.Room,
	}

	if _, exists := rooms[initData.Room]; !exists {
		rooms[initData.Room] = make(map[string]*Peer)
	}
	rooms[initData.Room][initData.Username] = peer
	peers[remoteAddr] = peer
	mu.Unlock()

	// Отправляем информацию о комнате
	sendRoomInfo(initData.Room)

	// Запускаем пинг-понг для поддержания соединения
	go func() {
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()

		for {
			select {
			case <-ticker.C:
				if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
					log.Printf("[PING] Failed to send ping to %s: %v", initData.Username, err)
					return
				}
			}
		}
	}()

	// Обработка входящих сообщений
	for {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("[ERROR] Unexpected close from %s: %v", initData.Username, err)
			}
			break
		}

		var data map[string]interface{}
		if err := json.Unmarshal(msg, &data); err != nil {
			log.Printf("[ERROR] Failed to parse message: %v", err)
			continue
		}

		if typ, ok := data["type"].(string); ok && typ == "leave" {
			log.Printf("[LEAVE] User %s leaving room %s", initData.Username, initData.Room)
			break
		}

		// Пересылаем сообщение другим участникам комнаты
		mu.Lock()
		roomPeers, exists := rooms[initData.Room]
		if !exists {
			mu.Unlock()
			continue
		}

		for username, p := range roomPeers {
			if username != initData.Username && p.conn != nil {
				if err := p.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
					log.Printf("[ERROR] Failed to send message to %s: %v", username, err)
					// Если ошибка при отправке, закрываем соединение
					p.conn.Close()
				}
			}
		}
		mu.Unlock()
	}
}

func sendRoomInfo(room string) {
	mu.Lock()
	defer mu.Unlock()

	if roomPeers, exists := rooms[room]; exists {
		users := make([]string, 0, len(roomPeers))
		for username := range roomPeers {
			users = append(users, username)
		}

		info := map[string]interface{}{
			"type": "room_info",
			"data": RoomInfo{Users: users},
		}

		for _, peer := range roomPeers {
			if peer.conn != nil {
				if err := peer.conn.WriteJSON(info); err != nil {
					log.Printf("[ERROR] Failed to send room info to %s: %v", peer.username, err)
					// Если ошибка при отправке, закрываем соединение
					peer.conn.Close()
				}
			}
		}
	}
}

func logStatus() {
	mu.Lock()
	defer mu.Unlock()

	log.Printf("[STATUS] Total connections: %d, Total rooms: %d", len(peers), len(rooms))
	for room, roomPeers := range rooms {
		users := make([]string, 0, len(roomPeers))
		for username := range roomPeers {
			users = append(users, username)
		}
		log.Printf("[ROOM] '%s' has %d users: %v", room, len(roomPeers), users)
	}
}

func main() {
	// Логирование статуса каждую минуту
	go func() {
		ticker := time.NewTicker(1 * time.Minute)
		for range ticker.C {
			logStatus()
		}
	}()

	http.HandleFunc("/ws", handleWebSocket)
	http.HandleFunc("/status", func(w http.ResponseWriter, r *http.Request) {
		logStatus()
		w.Write([]byte("OK"))
	})

	log.Println("Server started on :8080")
	log.Fatal(http.ListenAndServe(":8080", nil))
}