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

  const localVideoRef = useRef();
  const remoteVideoRef = useRef();
  const ws = useRef();
  const pc = useRef();
  const localStream = useRef();

  const generateUniqueUsername = (base) => {
    return `${base}_${Math.floor(Math.random() * 1000)}`;
  };

  const cleanup = () => {
    if (pc.current) {
      pc.current.onicecandidate = null;
      pc.current.ontrack = null;
      pc.current.onnegotiationneeded = null;
      pc.current.close();
      pc.current = null;
    }

    if (localStream.current) {
      localStream.current.getTracks().forEach(track => track.stop());
      localStream.current = null;
    }

    if (localVideoRef.current?.srcObject) {
      localVideoRef.current.srcObject = null;
    }

    if (remoteVideoRef.current?.srcObject) {
      remoteVideoRef.current.srcObject = null;
    }

    setIsCallActive(false);
    setIsCallInitiator(false);
  };

  const connectWebSocket = () => {
    try {
      ws.current = new WebSocket('wss://anybet.site/ws');

      ws.current.onopen = () => {
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
      };

      ws.current.onmessage = async (event) => {
        try {
          const data = JSON.parse(event.data);

          if (data.type === 'room_info') {
            setUsers(data.data.users || []);
          }
          else if (data.type === 'error') {
            setError(data.data);
          }
          else if (data.type === 'start_call') {
            if (!isCallActive && pc.current) {
              const offer = await pc.current.createOffer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: true
              });
              await pc.current.setLocalDescription(offer);
              ws.current.send(JSON.stringify({
                type: 'sdp',
                sdp: offer
              }));
              setIsCallActive(true);
              setIsCallInitiator(true);
            }
          }
          else if (data.type === 'sdp' && data.sdp && pc.current) {
            try {
              const description = new RTCSessionDescription(data.sdp);
              await pc.current.setRemoteDescription(description);

              if (description.type === 'offer') {
                const answer = await pc.current.createAnswer();
                await pc.current.setLocalDescription(answer);
                ws.current.send(JSON.stringify({
                  type: 'sdp',
                  sdp: answer
                }));
                setIsCallActive(true);
              }
            } catch (err) {
              console.error('Error processing SDP:', err);
              setError('Error processing call data');
            }
          } else if (data.type === 'ice' && data.ice && pc.current) {
            try {
              await pc.current.addIceCandidate(new RTCIceCandidate(data.ice));
            } catch (e) {
              console.error('Error adding ICE candidate:', e);
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

  const initializeWebRTC = async () => {
    try {
      cleanup();

      const config = {
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require',
        sdpSemantics: 'unified-plan'
      };

      pc.current = new RTCPeerConnection(config);

      try {
        localStream.current = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: true
        });

        if (localVideoRef.current) {
          localVideoRef.current.srcObject = localStream.current;
        }

        localStream.current.getTracks().forEach(track => {
          pc.current.addTrack(track, localStream.current);
        });
      } catch (err) {
        console.error('Error accessing media devices:', err);
        setError('Could not access camera/microphone');
        return false;
      }

      pc.current.onicecandidate = (event) => {
        if (event.candidate && ws.current?.readyState === WebSocket.OPEN) {
          ws.current.send(JSON.stringify({
            type: 'ice',
            ice: event.candidate
          }));
        }
      };

      pc.current.ontrack = (event) => {
        if (event.track.kind === 'video') {
          event.track.onunmute = () => {
            if (remoteVideoRef.current && !remoteVideoRef.current.srcObject) {
              remoteVideoRef.current.srcObject = event.streams[0];
            }
          };
        }
      };

      pc.current.onnegotiationneeded = async () => {
        try {
          const offer = await pc.current.createOffer();
          await pc.current.setLocalDescription(offer);
          ws.current.send(JSON.stringify({
            type: 'sdp',
            sdp: offer
          }));
        } catch (err) {
          console.error('Error in negotiation:', err);
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
      ws.current.send(JSON.stringify({ type: "start_call" }));
      setError('');
    } catch (err) {
      console.error('Error starting call:', err);
      setError('Failed to start call');
    }
  };

  const endCall = () => {
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify({ type: "end_call" }));
    }
    cleanup();
  };

  const joinRoom = async () => {
    setError('');

    if (!isConnected) {
      if (!connectWebSocket()) {
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    if (!originalUsername) {
      setOriginalUsername(username);
    }

    const uniqueUsername = generateUniqueUsername(originalUsername || username);
    setUsername(uniqueUsername);

    if (!(await initializeWebRTC())) {
      return;
    }

    ws.current.send(JSON.stringify({
      type: "join",
      room,
      username: uniqueUsername
    }));

    setIsInRoom(true);
  };

  const leaveRoom = () => {
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify({
        type: "leave",
        room,
        username
      }));
    }
    cleanup();
    setIsInRoom(false);
    setUsers([]);

    if (originalUsername) {
      setUsername(generateUniqueUsername(originalUsername));
    }
  };

  useEffect(() => {
    connectWebSocket();

    return () => {
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
                <button onClick={startCall} disabled={!isInRoom || users.length < 2}>
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