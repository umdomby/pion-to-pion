'use client'

import { useState, useEffect, useRef, forwardRef } from 'react';
import styles from './page.module.css';

// Define video components directly in the same file to avoid import issues
const LocalVideo = forwardRef<HTMLVideoElement>((props, ref) => (
    <video
        ref={ref}
        autoPlay
        muted
        className={styles.localVideo}
        {...props}
    />
));

const RemoteVideo = forwardRef<HTMLVideoElement>((props, ref) => (
    <video
        ref={ref}
        autoPlay
        className={styles.remoteVideo}
        {...props}
    />
));

type User = string;

export default function Home() {
  const [isLoading, setIsLoading] = useState(true);
  const [username, setUsername] = useState('');
  const [room, setRoom] = useState('room1');
  const [users, setUsers] = useState<User[]>([]);
  const [isCallActive, setIsCallActive] = useState(false);
  const [error, setError] = useState('');
  const [isConnected, setIsConnected] = useState(false);

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const ws = useRef<WebSocket | null>(null);
  const pc = useRef<RTCPeerConnection | null>(null);

  const cleanup = () => {
    if (pc.current) {
      pc.current.onicecandidate = null;
      pc.current.ontrack = null;
      pc.current.close();
      pc.current = null;
    }

    if (localVideoRef.current?.srcObject) {
      (localVideoRef.current.srcObject as MediaStream).getTracks().forEach(track => track.stop());
      localVideoRef.current.srcObject = null;
    }

    if (remoteVideoRef.current?.srcObject) {
      (remoteVideoRef.current.srcObject as MediaStream).getTracks().forEach(track => track.stop());
      remoteVideoRef.current.srcObject = null;
    }

    setIsCallActive(false);
  };

  const connectWebSocket = () => {
    try {
      ws.current = new WebSocket('wss://anybet.site/ws');

      ws.current.onopen = () => {
        setIsConnected(true);
        ws.current?.send(JSON.stringify({
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
        cleanup();
      };

      return true;
    } catch (err) {
      console.error('WebSocket connection failed:', err);
      setError('Failed to connect to server');
      return false;
    }
  };

  const initializeWebRTC = async () => {
    try {
      if (pc.current) {
        cleanup();
      }

      const config: RTCConfiguration = {
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
      };

      pc.current = new RTCPeerConnection(config);

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: true
        });
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
        }
        stream.getTracks().forEach(track => {
          pc.current?.addTrack(track, stream);
        });
      } catch (err) {
        console.error('Error accessing media devices:', err);
        setError('Could not access camera/microphone');
        return false;
      }

      pc.current.onicecandidate = (event) => {
        if (event.candidate && ws.current?.readyState === WebSocket.OPEN) {
          ws.current.send(JSON.stringify({ ice: event.candidate }));
        }
      };

      pc.current.ontrack = (event) => {
        if (remoteVideoRef.current) {
          remoteVideoRef.current.srcObject = event.streams[0];
        }
      };

      ws.current.onmessage = async (event) => {
        try {
          const data = JSON.parse(event.data);

          if (data.type === 'room_info') {
            setUsers(data.data.users);
          }
          else if (data.type === 'error') {
            setError(data.data);
          }
          else if (data.sdp && pc.current) {
            await pc.current.setRemoteDescription(new RTCSessionDescription(data.sdp));
            if (data.sdp.type === 'offer') {
              const answer = await pc.current.createAnswer();
              await pc.current.setLocalDescription(answer);
              if (ws.current?.readyState === WebSocket.OPEN) {
                ws.current.send(JSON.stringify({ sdp: answer }));
              }
            }
          } else if (data.ice && pc.current) {
            try {
              await pc.current.addIceCandidate(new RTCIceCandidate(data.ice));
            } catch (e) {
              console.error('Error adding ICE candidate:', e);
            }
          }
        } catch (err) {
          console.error('Error processing message:', err);
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

  const startCall = async () => {
    if (!pc.current || !ws.current || ws.current.readyState !== WebSocket.OPEN) {
      setError('Not connected to server');
      return;
    }

    try {
      const offer = await pc.current.createOffer();
      await pc.current.setLocalDescription(offer);
      ws.current.send(JSON.stringify({ sdp: offer }));
      setIsCallActive(true);
      setError('');
    } catch (err) {
      console.error('Error starting call:', err);
      setError('Failed to start call');
    }
  };

  const endCall = () => {
    cleanup();
  };

  const joinRoom = async () => {
    setError('');

    if (!connectWebSocket()) {
      return;
    }

    await new Promise(resolve => setTimeout(resolve, 500));

    if (!(await initializeWebRTC())) {
      return;
    }
  };

  useEffect(() => {
    setUsername(`User${Math.floor(Math.random() * 1000)}`);
    setIsLoading(false);
    joinRoom();

    return () => {
      if (ws.current) {
        ws.current.close();
      }
      cleanup();
    };
  }, []);

  if (isLoading) {
    return <div className={styles.loading}>Loading...</div>;
  }

  return (
      <div className={styles.appContainer}>
        <div className={styles.controlPanel}>
          <div className={styles.connectionStatus}>
            Status: {isConnected ? 'Connected' : 'Disconnected'}
          </div>

          <div className={styles.inputGroup}>
            <label>Room:</label>
            <input
                type="text"
                value={room}
                onChange={(e) => setRoom(e.target.value)}
            />
          </div>

          <div className={styles.inputGroup}>
            <label>Username:</label>
            <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
            />
          </div>

          <button
              onClick={joinRoom}
              disabled={isConnected}
              className={styles.button}
          >
            {isConnected ? 'Joined' : 'Join Room'}
          </button>

          <div className={styles.userList}>
            <h3>Users in room ({users.length}):</h3>
            <ul>
              {users.map((user, index) => (
                  <li key={index}>{user}</li>
              ))}
            </ul>
          </div>

          <div className={styles.callControls}>
            {!isCallActive ? (
                <button
                    onClick={startCall}
                    disabled={!isConnected || users.length < 2}
                    className={styles.button}
                >
                  Start Call
                </button>
            ) : (
                <button
                    onClick={endCall}
                    className={styles.button}
                >
                  End Call
                </button>
            )}
          </div>

          {error && <div className={styles.errorMessage}>{error}</div>}
        </div>

        <div className={styles.videoContainer}>
          <div className={styles.videoWrapper}>
            <LocalVideo ref={localVideoRef} />
            <div className={styles.videoLabel}>You ({username})</div>
          </div>

          <div className={styles.videoWrapper}>
            <RemoteVideo ref={remoteVideoRef} />
            <div className={styles.videoLabel}>Remote</div>
          </div>
        </div>
      </div>
  );
}