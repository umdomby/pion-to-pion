package main

import (
	"encoding/json"
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
	peers   = make(map[string]*Peer)
	rooms   = make(map[string]map[string]*Peer)
	mu      sync.Mutex
)

func init() {
	rand.Seed(time.Now().UnixNano())
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
			if peer.conn != nil {
				err := peer.conn.WriteJSON(map[string]interface{}{
					"type": "room_info",
					"data": roomInfo,
				})
				if err != nil {
					log.Printf("[ERROR] Failed to send room info to %s: %v", peer.username, err)
				}
			}
		}
		log.Printf("[INFO] Sent room info to %d users in room '%s'", len(roomPeers), room)
	}
}

func cleanupPeer(peer *Peer) {
	log.Printf("[CLEANUP] Cleaning up peer %s in room %s", peer.username, peer.room)

	if peer.pc != nil {
		peer.pc.Close()
		peer.pc = nil
	}
	if peer.conn != nil {
		peer.conn.Close()
		peer.conn = nil
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

	defer func() {
		mu.Lock()
		if peer, exists := peers[remoteAddr]; exists {
			cleanupPeer(peer)
			delete(peers, remoteAddr)

			if roomPeers, roomExists := rooms[peer.room]; roomExists {
				delete(roomPeers, peer.username)
				if len(roomPeers) == 0 {
					delete(rooms, peer.room)
					log.Printf("[ROOM] Room '%s' is now empty and has been removed", peer.room)
				} else {
					sendRoomInfo(peer.room)
				}
			}
		}
		mu.Unlock()

		conn.Close()
		log.Printf("[DISCONNECT] Connection closed for %s", remoteAddr)
		logStatus()
	}()

	var initData struct {
		Room     string `json:"room"`
		Username string `json:"username"`
		Create   bool   `json:"create"`
	}

	// Установка таймаута для чтения начальных данных
	conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	err = conn.ReadJSON(&initData)
	if err != nil {
		log.Printf("[ERROR] Failed to read init data from %s: %v", remoteAddr, err)
		return
	}
	conn.SetReadDeadline(time.Time{}) // Сброс таймаута

	log.Printf("[JOIN] User '%s' joining room '%s' (create: %v)", initData.Username, initData.Room, initData.Create)

	mu.Lock()
	if roomPeers, exists := rooms[initData.Room]; exists {
		if _, userExists := roomPeers[initData.Username]; userExists {
			log.Printf("[ERROR] Username '%s' already exists in room '%s'", initData.Username, initData.Room)
			conn.WriteJSON(map[string]interface{}{
				"type": "error",
				"data": "Username already exists in this room",
			})
			mu.Unlock()
			return
		}
	} else {
		if !initData.Create {
			log.Printf("[ERROR] Room '%s' does not exist", initData.Room)
			conn.WriteJSON(map[string]interface{}{
				"type": "error",
				"data": "Room does not exist",
			})
			mu.Unlock()
			return
		}
		log.Printf("[ROOM] Creating new room: '%s'", initData.Room)
		rooms[initData.Room] = make(map[string]*Peer)
	}
	mu.Unlock()

	config := webrtc.Configuration{
		ICEServers: []webrtc.ICEServer{{URLs: []string{"stun:stun.l.google.com:19302"}}},
	}

	peerConnection, err := webrtc.NewPeerConnection(config)
	if err != nil {
		log.Printf("[ERROR] Failed to create PeerConnection for %s: %v", initData.Username, err)
		return
	}

	peer := &Peer{
		conn:     conn,
		pc:       peerConnection,
		username: initData.Username,
		room:     initData.Room,
	}

	mu.Lock()
	rooms[initData.Room][initData.Username] = peer
	peers[remoteAddr] = peer
	mu.Unlock()

	log.Printf("[JOIN] User '%s' successfully joined room '%s'", initData.Username, initData.Room)
	sendRoomInfo(initData.Room)

	// Обработка сообщений
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
			log.Printf("[ERROR] Failed to parse message from %s: %v", initData.Username, err)
			continue
		}

		if data["type"] == "leave" {
			log.Printf("[LEAVE] User '%s' requested to leave room '%s'", initData.Username, initData.Room)
			break
		}

		log.Printf("[MESSAGE] Received message from '%s' in room '%s': %v", initData.Username, initData.Room, data)

		mu.Lock()
		roomPeers, exists := rooms[peer.room]
		if !exists {
			mu.Unlock()
			log.Printf("[ERROR] Room '%s' no longer exists", peer.room)
			continue
		}

		for username, p := range roomPeers {
			if username != peer.username && p.conn != nil {
				log.Printf("[FORWARD] Forwarding message to '%s' in room '%s'", username, peer.room)
				if err := p.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
					log.Printf("[ERROR] Failed to send message to '%s': %v", username, err)
				}
			}
		}
		mu.Unlock()
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