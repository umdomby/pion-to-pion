import React, { useEffect, useRef } from 'react';

function App() {
  const localVideoRef = useRef();
  const remoteVideoRef = useRef();
  const ws = useRef();
  const pc = useRef();

  useEffect(() => {
    // Подключаемся к WebSocket серверу
    ws.current = new WebSocket('wss://anybet.site/ws');

    // Настраиваем WebRTC
    const config = {
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    };

    pc.current = new RTCPeerConnection(config);

    // Получаем видеопоток с камеры
    navigator.mediaDevices.getUserMedia({ video: true, audio: false })
        .then(stream => {
          localVideoRef.current.srcObject = stream;
          stream.getTracks().forEach(track => {
            pc.current.addTrack(track, stream);
          });
        });

    // Обработка ICE кандидатов
    pc.current.onicecandidate = (event) => {
      if (event.candidate) {
        ws.current.send(JSON.stringify({ ice: event.candidate }));
      }
    };

    // Получаем удаленный поток
    pc.current.ontrack = (event) => {
      remoteVideoRef.current.srcObject = event.streams[0];
    };

    // Обработка сообщений от сервера
    ws.current.onmessage = async (event) => {
      const data = JSON.parse(event.data);
      if (data.sdp) {
        await pc.current.setRemoteDescription(new RTCSessionDescription(data.sdp));
        if (data.sdp.type === 'offer') {
          const answer = await pc.current.createAnswer();
          await pc.current.setLocalDescription(answer);
          ws.current.send(JSON.stringify({ sdp: answer }));
        }
      } else if (data.ice) {
        await pc.current.addIceCandidate(new RTCIceCandidate(data.ice));
      }
    };

    return () => {
      pc.current.close();
      ws.current.close();
    };
  }, []);

  const startCall = async () => {
    const offer = await pc.current.createOffer();
    await pc.current.setLocalDescription(offer);
    ws.current.send(JSON.stringify({ sdp: offer }));
  };

  return (
      <div>
        <video ref={localVideoRef} autoPlay muted width="300" />
        <video ref={remoteVideoRef} autoPlay width="300" />
        <button onClick={startCall}>Start Call</button>
      </div>
  );
}

export default App;