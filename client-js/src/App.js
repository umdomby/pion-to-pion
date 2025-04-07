import React, { useState, useEffect, useRef } from 'react';
import './App.css';

function App() {
  const [username, setUsername] = useState(`User${Math.floor(Math.random() * 1000)}`);
  const [room, setRoom] = useState('default');
  const [users, setUsers] = useState([]);
  const [streamingUsers, setStreamingUsers] = useState([]);
  const [error, setError] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);

  const localVideoRef = useRef();
  const remoteVideoRefs = useRef({});
  const ws = useRef();
  const pc = useRef({});
  const localStream = useRef();

  const cleanupMedia = () => {
    // Останавливаем медиапотоки
    if (localVideoRef.current?.srcObject) {
      localVideoRef.current.srcObject.getTracks().forEach(track => track.stop());
      localVideoRef.current.srcObject = null;
    }

    // Очищаем все удаленные видео
    Object.values(remoteVideoRefs.current).forEach(videoRef => {
      if (videoRef?.current?.srcObject) {
        videoRef.current.srcObject.getTracks().forEach(track => track.stop());
        videoRef.current.srcObject = null;
        // Создаем черный экран
        videoRef.current.srcObject = new MediaStream();
      }
    });
  };

  const cleanupWebRTC = () => {
    // Закрываем все PeerConnection
    Object.values(pc.current).forEach(connection => {
      if (connection) {
        connection.onicecandidate = null;
        connection.ontrack = null;
        connection.close();
      }
    });
    pc.current = {};
  };

  const cleanupWebSocket = () => {
    if (ws.current) {
      ws.current.close();
      ws.current = null;
    }
  };

  const cleanupAll = () => {
    cleanupMedia();
    cleanupWebRTC();
    setIsStreaming(false);
  };

  const connectWebSocket = () => {
    try {
      ws.current = new WebSocket('ws://localhost:8080/ws');

      ws.current.onopen = () => {
        setIsConnected(true);
        // Отправляем данные для подключения (комната и ник)
        ws.current.send(JSON.stringify({
          action: 'join',
          room,
          username
        }));
      };

      ws.current.onerror = (error) => {
        console.error('WebSocket error:', error);
        setError('Connection error');
        setIsConnected(false);
      };

      ws.current.onclose = () => {
        console.log('WebSocket disconnected');
        setIsConnected(false);
        cleanupAll();
      };

      return true;
    } catch (err) {
      console.error('WebSocket connection failed:', err);
      setError('Failed to connect to server');
      return false;
    }
  };

  const createPeerConnection = async (targetUsername) => {
    try {
      const config = {
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
      };

      const connection = new RTCPeerConnection(config);

      // Добавляем наш поток, если он есть
      if (localStream.current) {
        localStream.current.getTracks().forEach(track => {
          connection.addTrack(track, localStream.current);
        });
      }

      // Обработка ICE кандидатов
      connection.onicecandidate = (event) => {
        if (event.candidate && ws.current?.readyState === WebSocket.OPEN) {
          ws.current.send(JSON.stringify({
            ice: event.candidate,
            target: targetUsername
          }));
        }
      };

      // Получаем удаленный поток
      connection.ontrack = (event) => {
        if (remoteVideoRefs.current[targetUsername]?.current) {
          remoteVideoRefs.current[targetUsername].current.srcObject = event.streams[0];
        }
      };

      return connection;
    } catch (err) {
      console.error('Error creating peer connection:', err);
      return null;
    }
  };

  const startStream = async () => {
    try {
      // Получаем видеопоток с камеры
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true
      });

      localStream.current = stream;
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }

      // Уведомляем сервер о начале трансляции
      if (ws.current?.readyState === WebSocket.OPEN) {
        ws.current.send(JSON.stringify({ action: 'start_stream' }));
      }

      setIsStreaming(true);
      setError('');
    } catch (err) {
      console.error('Error starting stream:', err);
      setError('Failed to access camera/microphone');
    }
  };

  const endStream = () => {
    cleanupMedia();
    cleanupWebRTC();
    setIsStreaming(false);

    // Уведомляем сервер о завершении трансляции
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify({ action: 'end_stream' }));
    }
  };

  const leaveRoom = () => {
    endStream();
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify({ action: 'leave' }));
    }
    cleanupAll();
    cleanupWebSocket();
  };

  const connectToPeer = async (targetUsername) => {
    if (!localStream.current) return;

    // Создаем новое соединение, если его еще нет
    if (!pc.current[targetUsername]) {
      pc.current[targetUsername] = await createPeerConnection(targetUsername);
    }

    const connection = pc.current[targetUsername];

    try {
      const offer = await connection.createOffer();
      await connection.setLocalDescription(offer);

      if (ws.current?.readyState === WebSocket.OPEN) {
        ws.current.send(JSON.stringify({
          sdp: offer,
          target: targetUsername
        }));
      }
    } catch (err) {
      console.error('Error creating offer:', err);
    }
  };

  useEffect(() => {
    // Автоподключение при монтировании
    connectWebSocket();

    // Обработка сообщений от сервера
    if (ws.current) {
      ws.current.onmessage = async (event) => {
        try {
          const data = JSON.parse(event.data);

          if (data.type === 'room_info') {
            setUsers(data.data.users);
            setStreamingUsers(data.data.streamingUsers || []);

            // Подключаемся ко всем стримерам
            (data.data.streamingUsers || []).forEach(user => {
              if (user !== username && !pc.current[user]) {
                connectToPeer(user);
              }
            });
          }
          else if (data.type === 'error') {
            setError(data.data);
          }
          else if (data.type === 'stream_ended') {
            // Очищаем видео, когда стрим завершен
            if (remoteVideoRefs.current[data.data]?.current) {
              remoteVideoRefs.current[data.data].current.srcObject = new MediaStream();
            }
            // Закрываем соединение
            if (pc.current[data.data]) {
              pc.current[data.data].close();
              delete pc.current[data.data];
            }
            setStreamingUsers(prev => prev.filter(u => u !== data.data));
          }
          else if (data.type === 'user_left') {
            // Очищаем видео, когда пользователь вышел
            if (remoteVideoRefs.current[data.data]?.current) {
              remoteVideoRefs.current[data.data].current.srcObject = new MediaStream();
            }
            // Закрываем соединение
            if (pc.current[data.data]) {
              pc.current[data.data].close();
              delete pc.current[data.data];
            }
            setUsers(prev => prev.filter(u => u !== data.data));
            setStreamingUsers(prev => prev.filter(u => u !== data.data));
          }
          else if (data.sdp && data.target === username && pc.current[data.sender]) {
            const connection = pc.current[data.sender] || await createPeerConnection(data.sender);

            await connection.setRemoteDescription(new RTCSessionDescription(data.sdp));
            if (data.sdp.type === 'offer') {
              const answer = await connection.createAnswer();
              await connection.setLocalDescription(answer);
              if (ws.current?.readyState === WebSocket.OPEN) {
                ws.current.send(JSON.stringify({
                  sdp: answer,
                  target: data.sender
                }));
              }
            }
          } else if (data.ice && data.target === username && pc.current[data.sender]) {
            try {
              await pc.current[data.sender].addIceCandidate(new RTCIceCandidate(data.ice));
            } catch (e) {
              console.error('Error adding ICE candidate:', e);
            }
          }
        } catch (err) {
          console.error('Error processing message:', err);
        }
      };
    }

    return () => {
      leaveRoom();
    };
  }, []);

  // Создаем refs для всех пользователей
  useEffect(() => {
    streamingUsers.forEach(user => {
      if (!remoteVideoRefs.current[user]) {
        remoteVideoRefs.current[user] = React.createRef();
      }
    });
  }, [streamingUsers]);

  return (
      <div className="app-container">
        <div className="control-panel">
          <div className="connection-status">
            Status: {isConnected ? 'Connected' : 'Disconnected'}
          </div>

          <div className="user-info">
            <div className="input-group">
              <label>Username:</label>
              <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  disabled={isConnected}
              />
            </div>

            <div className="room-info">
              Room: {room}
            </div>
          </div>

          <div className="stream-controls">
            {!isStreaming ? (
                <button onClick={startStream} disabled={!isConnected}>
                  Start Stream
                </button>
            ) : (
                <button onClick={endStream}>End Stream</button>
            )}

            <button onClick={leaveRoom} disabled={!isConnected}>
              Leave Room
            </button>
          </div>

          <div className="user-list">
            <h3>Users in room ({users.length}):</h3>
            <ul>
              {users.map((user, index) => (
                  <li key={index}>
                    {user}
                    {streamingUsers.includes(user) && ' (Streaming)'}
                  </li>
              ))}
            </ul>
          </div>

          {error && <div className="error-message">{error}</div>}
        </div>

        <div className="video-container">
          <div className="video-wrapper">
            <video
                ref={localVideoRef}
                autoPlay
                muted
                className="local-video"
            />
            <div className="video-label">You ({username}) {isStreaming && '(Streaming)'}</div>
          </div>

          {streamingUsers.map(user => (
              user !== username && (
                  <div className="video-wrapper" key={user}>
                    <video
                        ref={remoteVideoRefs.current[user]}
                        autoPlay
                        className="remote-video"
                    />
                    <div className="video-label">{user}</div>
                  </div>
              )
          ))}
        </div>
      </div>
  );
}

export default App;