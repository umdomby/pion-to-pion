import React, { useState, useEffect, useRef } from 'react';
import './App.css';

function App() {
  const [username, setUsername] = useState(`User${Math.floor(Math.random() * 1000)}`);
  const [originalUsername, setOriginalUsername] = useState('');
  const [room, setRoom] = useState('room1');
  const [users, setUsers] = useState([]);
  const [isCallActive, setIsCallActive] = useState(false);
  const [error, setError] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [isInRoom, setIsInRoom] = useState(false);
  const [isCallInitiator, setIsCallInitiator] = useState(false);
  const [iceCandidates, setIceCandidates] = useState([]);

  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const ws = useRef(null);
  const pc = useRef(null);
  const pendingIceCandidates = useRef([]);

  // Генерация уникального имени пользователя
  const generateUniqueUsername = (base) => {
    return `${base}_${Math.floor(Math.random() * 1000)}`;
  };

  // Очистка ресурсов
  const cleanup = () => {
    console.log('Cleaning up resources...');

    if (pc.current) {
      console.log('Closing peer connection...');
      pc.current.onicecandidate = null;
      pc.current.ontrack = null;
      pc.current.onnegotiationneeded = null;
      pc.current.oniceconnectionstatechange = null;
      pc.current.close();
      pc.current = null;
    }

    if (localVideoRef.current?.srcObject) {
      console.log('Stopping local media tracks...');
      localVideoRef.current.srcObject.getTracks().forEach(track => track.stop());
      localVideoRef.current.srcObject = null;
    }

    if (remoteVideoRef.current?.srcObject) {
      console.log('Stopping remote media tracks...');
      remoteVideoRef.current.srcObject.getTracks().forEach(track => track.stop());
      remoteVideoRef.current.srcObject = null;
    }

    setIsCallActive(false);
    setIsCallInitiator(false);
    pendingIceCandidates.current = [];
  };

  // Подключение к WebSocket
  const connectWebSocket = () => {
    console.log('Connecting to WebSocket...');
    try {
      ws.current = new WebSocket('wss://anybet.site/ws');

      ws.current.onopen = () => {
        console.log('WebSocket connected');
        setIsConnected(true);
        setError('');
      };

      ws.current.onerror = (error) => {
        console.error('WebSocket error:', error);
        setError('Connection error');
        setIsConnected(false);
      };

      ws.current.onclose = () => {
        console.log('WebSocket disconnected');
        setIsConnected(false);
        setTimeout(() => {
          if (!isConnected) {
            console.log('Attempting to reconnect...');
            connectWebSocket();
          }
        }, 3000);
      };

      ws.current.onmessage = async (event) => {
        try {
          const data = JSON.parse(event.data);
          console.log('Received message:', data);

          if (data.type === 'room_info') {
            setUsers(data.data.users || []);
          }
          else if (data.type === 'error') {
            setError(data.data);
          }
          else if (data.type === 'start_call') {
            if (!isCallActive && pc.current) {
              console.log('Creating offer...');
              const offer = await pc.current.createOffer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: true,
                voiceActivityDetection: false
              });
              await pc.current.setLocalDescription(offer);
              ws.current.send(JSON.stringify({
                type: 'offer',
                sdp: offer,
                room,
                username
              }));
              setIsCallActive(true);
              setIsCallInitiator(true);
            }
          }
          else if (data.type === 'offer') {
            console.log('Received offer:', data.sdp);
            if (pc.current) {
              await pc.current.setRemoteDescription(new RTCSessionDescription(data.sdp));

              const answer = await pc.current.createAnswer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: true
              });
              await pc.current.setLocalDescription(answer);

              ws.current.send(JSON.stringify({
                type: 'answer',
                sdp: answer,
                room,
                username
              }));

              setIsCallActive(true);
            }
          }
          else if (data.type === 'answer') {
            console.log('Received answer:', data.sdp);
            if (pc.current && pc.current.signalingState !== 'stable') {
              await pc.current.setRemoteDescription(new RTCSessionDescription(data.sdp));
              setIsCallActive(true);

              // Добавляем ожидающие ICE кандидаты
              pendingIceCandidates.current.forEach(candidate => {
                pc.current.addIceCandidate(new RTCIceCandidate(candidate));
              });
              pendingIceCandidates.current = [];
            }
          }
          else if (data.type === 'ice_candidate') {
            console.log('Received ICE candidate:', data.ice);
            const candidate = new RTCIceCandidate(data.ice);

            if (pc.current && pc.current.remoteDescription) {
              await pc.current.addIceCandidate(candidate);
            } else {
              console.log('Adding ICE candidate to pending list');
              pendingIceCandidates.current.push(candidate);
            }
          }
        } catch (err) {
          console.error('Error processing message:', err);
          setError('Error processing server message');
        }
      };

      return true;
    } catch (err) {
      console.error('WebSocket connection failed:', err);
      setError('Failed to connect to server');
      return false;
    }
  };

  // Инициализация WebRTC
  const initializeWebRTC = async () => {
    console.log('Initializing WebRTC...');
    try {
      cleanup();

      const config = {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          // Добавьте TURN серверы при необходимости
          // { urls: 'turn:your-turn-server.com', username: 'user', credential: 'pass' }
        ],
        sdpSemantics: 'unified-plan',
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require',
        iceTransportPolicy: 'all'
      };

      pc.current = new RTCPeerConnection(config);

      // Получение медиапотока
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 640 },
            height: { ideal: 480 },
            frameRate: { ideal: 30 }
          },
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          }
        });

        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
        }

        // Добавление треков в соединение
        stream.getTracks().forEach(track => {
          pc.current.addTrack(track, stream);
        });
      } catch (err) {
        console.error('Error accessing media devices:', err);
        setError('Could not access camera/microphone');
        return false;
      }

      // Обработка ICE кандидатов
      pc.current.onicecandidate = (event) => {
        if (event.candidate && ws.current?.readyState === WebSocket.OPEN) {
          console.log('Sending ICE candidate:', event.candidate);
          ws.current.send(JSON.stringify({
            type: 'ice_candidate',
            ice: event.candidate,
            room,
            username
          }));
        }
      };

      // Обработка входящих треков
      pc.current.ontrack = (event) => {
        console.log('Received track:', event.track.kind);
        if (event.streams && event.streams[0]) {
          if (remoteVideoRef.current.srcObject !== event.streams[0]) {
            remoteVideoRef.current.srcObject = event.streams[0];
          }
        }
      };

      // Обработка изменений состояния ICE
      pc.current.oniceconnectionstatechange = () => {
        console.log('ICE connection state:', pc.current.iceConnectionState);
        if (pc.current.iceConnectionState === 'disconnected' ||
            pc.current.iceConnectionState === 'failed') {
          console.log('ICE connection failed, attempting to restart...');
          reconnect();
        }
      };

      return true;
    } catch (err) {
      console.error('WebRTC initialization failed:', err);
      setError('Failed to initialize WebRTC');
      cleanup();
      return false;
    }
  };

  // Начало звонка
  const startCall = async () => {
    console.log('Starting call...');
    if (!pc.current || !ws.current || ws.current.readyState !== WebSocket.OPEN) {
      setError('Not connected to server');
      return;
    }

    try {
      ws.current.send(JSON.stringify({
        type: "start_call",
        room,
        username
      }));

      const offer = await pc.current.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true,
        voiceActivityDetection: false
      });
      await pc.current.setLocalDescription(offer);

      ws.current.send(JSON.stringify({
        type: "offer",
        sdp: offer,
        room,
        username
      }));

      setIsCallActive(true);
      setIsCallInitiator(true);
      setError('');
    } catch (err) {
      console.error('Error starting call:', err);
      setError('Failed to start call');
    }
  };

  // Завершение звонка
  const endCall = () => {
    console.log('Ending call...');
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify({
        type: "end_call",
        room,
        username
      }));
    }
    cleanup();
    setIsInRoom(false);
    setUsers([]);
  };

  // Переподключение
  const reconnect = async () => {
    console.log('Attempting to reconnect...');
    cleanup();

    if (ws.current) {
      ws.current.close();
    }

    await new Promise(resolve => setTimeout(resolve, 1000));

    if (isInRoom) {
      await joinRoom();
    } else {
      connectWebSocket();
    }
  };

  // Вход в комнату
  const joinRoom = async () => {
    console.log('Joining room...');
    setError('');

    if (!isConnected) {
      if (!connectWebSocket()) {
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    // Сохраняем оригинальное имя пользователя
    if (!originalUsername) {
      setOriginalUsername(username);
    }

    // Генерируем уникальное имя пользователя для повторного входа
    const uniqueUsername = generateUniqueUsername(originalUsername || username);
    setUsername(uniqueUsername);

    if (!(await initializeWebRTC())) {
      return;
    }

    ws.current.send(JSON.stringify({
      action: "join",
      room,
      username: uniqueUsername
    }));

    setIsInRoom(true);
  };

  // Выход из комнаты
  const leaveRoom = () => {
    console.log('Leaving room...');
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify({
        type: "leave",
        room,
        username
      }));
    }
    setIsInRoom(false);
    cleanup();
    setUsers([]);
  };

  // Эффект при монтировании
  useEffect(() => {
    connectWebSocket();

    return () => {
      console.log('Component unmounting, cleaning up...');
      if (ws.current) {
        ws.current.close();
      }
      cleanup();
    };
  }, []);

  return (
      <div className="app-container">
        <div className="control-panel">
          <div className="connection-status">
            Status: {isConnected ? (isInRoom ? `In room ${room}` : 'Connected') : 'Disconnected'}
            {isCallActive && ' (Call active)'}
          </div>

          <div className="input-group">
            <label>Room:</label>
            <input
                type="text"
                value={room}
                onChange={(e) => setRoom(e.target.value)}
                disabled={isInRoom}
            />
          </div>

          <div className="input-group">
            <label>Username:</label>
            <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                disabled={isInRoom}
            />
          </div>

          {!isInRoom ? (
              <button onClick={joinRoom} disabled={!isConnected}>
                Join Room
              </button>
          ) : (
              <button onClick={leaveRoom}>Leave Room</button>
          )}

          <div className="user-list">
            <h3>Users in room ({users.length}):</h3>
            <ul>
              {users.map((user, index) => (
                  <li key={index}>{user}</li>
              ))}
            </ul>
          </div>

          <div className="call-controls">
            {!isCallActive ? (
                <button
                    onClick={startCall}
                    disabled={!isInRoom || users.length < 2}
                >
                  Start Call
                </button>
            ) : (
                <button onClick={endCall}>End Call</button>
            )}
          </div>

          {error && <div className="error-message">{error}</div>}
        </div>

        <div className="video-container">
          <div className="video-wrapper">
            <video
                ref={localVideoRef}
                autoPlay
                muted
                playsInline
                className="local-video"
            />
            <div className="video-label">You ({username})</div>
          </div>

          <div className="video-wrapper">
            <video
                ref={remoteVideoRef}
                autoPlay
                playsInline
                className="remote-video"
            />
            <div className="video-label">Remote</div>
          </div>
        </div>
      </div>
  );
}

export default App;