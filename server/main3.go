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
	letters = []rune("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ")
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

func logStatus() {
	mu.Lock()
	defer mu.Unlock()

	log.Printf("Current status - Total connections: %d, Total rooms: %d", len(peers), len(rooms))
	for room, roomPeers := range rooms {
		log.Printf("Room '%s' has %d users: %v", room, len(roomPeers), getUsernames(roomPeers))
	}
}

func getUsernames(peers map[string]*Peer) []string {
	usernames := make([]string, 0, len(peers))
	for username := range peers {
		usernames = append(usernames, username)
	}
	return usernames
}

func sendRoomInfoToUser(peer *Peer, room string) {
	mu.Lock()
	defer mu.Unlock()

	if roomPeers, exists := rooms[room]; exists {
		users := make([]string, 0, len(roomPeers))
		for username := range roomPeers {
			users = append(users, username)
		}

		roomInfo := RoomInfo{Users: users}

		err := peer.conn.WriteJSON(map[string]interface{}{
			"type": "room_info",
			"data": roomInfo,
		})
		if err != nil {
			log.Printf("Error sending room info to %s: %v", peer.conn.RemoteAddr().String(), peer.username, err)
		}
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
			err := peer.conn.WriteJSON(map[string]interface{}{
				"type": "room_info",
				"data": roomInfo,
			})
			if err != nil {
				log.Printf("Error sending room info to %s: %v", peer.conn.RemoteAddr().String(), peer.username, err)
			}
		}
		log.Printf("Sent room info to %d users in room '%s'", len(roomPeers), room)
	}
}


func main() {
	http.HandleFunc("/ws", handleWebSocket)
	http.HandleFunc("/status", func(w http.ResponseWriter, r *http.Request) {
		logStatus()
		w.Write([]byte("Status logged to console"))
	})

	log.Println("Server started on :8080")
	logStatus()
	log.Fatal(http.ListenAndServe(":8080", nil))
}

func handleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("WebSocket upgrade error:", err)
		return
	}
	defer conn.Close()

	remoteAddr := conn.RemoteAddr().String()
	log.Printf("New connection from: %s", remoteAddr)

	var initData struct {
		Room     string `json:"room"`
		Username string `json:"username"`
		Create   bool   `json:"create"`
	}
	err = conn.ReadJSON(&initData)
	if err != nil {
		log.Printf("Read init data error from %s: %v", remoteAddr, err)
		return
	}

	log.Printf("Connection %s trying to join room '%s' as '%s'", remoteAddr, initData.Room, initData.Username)

	mu.Lock()
	if roomPeers, exists := rooms[initData.Room]; exists {
		if _, userExists := roomPeers[initData.Username]; userExists {
			log.Printf("Username '%s' already exists in room '%s'", initData.Username, initData.Room)
			conn.WriteJSON(map[string]interface{}{
				"type": "error",
				"data": "Username already exists in this room",
			})
			mu.Unlock()
			return
		}
	} else {
		log.Printf("Creating new room: '%s'", initData.Room)
		rooms[initData.Room] = make(map[string]*Peer)
	}
	mu.Unlock()

	config := webrtc.Configuration{
		ICEServers: []webrtc.ICEServer{{URLs: []string{"stun:stun.l.google.com:19302"}}},
	}

	peerConnection, err := webrtc.NewPeerConnection(config)
	if err != nil {
		log.Printf("PeerConnection error for %s: %v", remoteAddr, err)
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

	log.Printf("User '%s' joined room '%s' (connection: %s)", initData.Username, initData.Room, remoteAddr)
	logStatus()

	sendRoomInfoToUser(peer, initData.Room)
	sendRoomInfo(initData.Room)

	for {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			log.Printf("Connection closed by %s (user: '%s', room: '%s'): %v", remoteAddr, initData.Username, initData.Room, err)
			break
		}

		var data map[string]interface{}
		if err := json.Unmarshal(msg, &data); err != nil {
			log.Printf("JSON unmarshal error from %s: %v", remoteAddr, err)
			continue
		}

		if data["type"] == "leave" {
			log.Printf("User %s requested to leave room %s", initData.Username, initData.Room)
			break
		}

		log.Printf("Message from %s (user: '%s'): %v", remoteAddr, initData.Username, data)

		if data["sdp"] != nil || data["ice"] != nil {
			mu.Lock()
			for username, p := range rooms[peer.room] {
				if username != peer.username {
					log.Printf("Forwarding message to %s", username)
					err := p.conn.WriteMessage(websocket.TextMessage, msg)
					if err != nil {
						log.Printf("Error sending message to %s (user: '%s'): %v", p.conn.RemoteAddr().String(), username, err)
					}
				}
			}
			mu.Unlock()
		}
	}

	mu.Lock()
	delete(peers, remoteAddr)
	delete(rooms[peer.room], peer.username)
	if len(rooms[peer.room]) == 0 {
		delete(rooms, peer.room)
		log.Printf("Room '%s' is now empty and has been removed", peer.room)
	} else {
		sendRoomInfo(peer.room)
	}
	mu.Unlock()

	log.Printf("User '%s' left room '%s' (connection: %s closed)", peer.username, peer.room, remoteAddr)
	logStatus()
}