'use client'

import { useState, useEffect, useRef, forwardRef } from 'react';
import styles from './page.module.css';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

// Компоненты видео (локальное и удаленное)
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

// Тип для пользователей
type User = string;

export default function Home() {
  // Состояния приложения
  const [isLoading, setIsLoading] = useState(true);
  const [username, setUsername] = useState('');
  const [room, setRoom] = useState('room1');
  const [users, setUsers] = useState<User[]>([]);
  const [isCallActive, setIsCallActive] = useState(false);
  const [error, setError] = useState('');
  const [isConnected, setIsConnected] = useState(false);

  // Рефы для DOM элементов и WebRTC
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const ws = useRef<WebSocket | null>(null);
  const pc = useRef<RTCPeerConnection | null>(null);

  // Очистка ресурсов
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

  // Подключение к WebSocket серверу
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
        console.error('Ошибка WebSocket:', error);
        setError('Ошибка подключения');
        setIsConnected(false);
      };

      ws.current.onclose = () => {
        console.log('WebSocket отключен');
        setIsConnected(false);
        cleanup();
      };

      return true;
    } catch (err) {
      console.error('Ошибка подключения WebSocket:', err);
      setError('Не удалось подключиться к серверу');
      return false;
    }
  };

  // Инициализация WebRTC
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
        // Получаем доступ к камере и микрофону
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
        console.error('Ошибка доступа к медиаустройствам:', err);
        setError('Не удалось получить доступ к камере/микрофону');
        return false;
      }

      // Обработка ICE кандидатов
      pc.current.onicecandidate = (event) => {
        if (event.candidate && ws.current?.readyState === WebSocket.OPEN) {
          ws.current.send(JSON.stringify({ ice: event.candidate }));
        }
      };

      // Получение удаленного потока
      pc.current.ontrack = (event) => {
        if (remoteVideoRef.current) {
          remoteVideoRef.current.srcObject = event.streams[0];
        }
      };

      // Обработка сообщений от сервера
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
              console.error('Ошибка добавления ICE кандидата:', e);
            }
          }
        } catch (err) {
          console.error('Ошибка обработки сообщения:', err);
        }
      };

      return true;
    } catch (err) {
      console.error('Ошибка инициализации WebRTC:', err);
      setError('Не удалось инициализировать WebRTC');
      cleanup();
      return false;
    }
  };

  // Начало звонка
  const startCall = async () => {
    if (!pc.current || !ws.current || ws.current.readyState !== WebSocket.OPEN) {
      setError('Нет подключения к серверу');
      return;
    }

    try {
      const offer = await pc.current.createOffer();
      await pc.current.setLocalDescription(offer);
      ws.current.send(JSON.stringify({ sdp: offer }));
      setIsCallActive(true);
      setError('');
    } catch (err) {
      console.error('Ошибка начала звонка:', err);
      setError('Не удалось начать звонок');
    }
  };

  // Завершение звонка
  const endCall = () => {
    cleanup();
  };

  // Подключение к комнате
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

  // Эффект при монтировании компонента
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
    return <div className={styles.loading}>Загрузка...</div>;
  }

  return (
      <div className={styles.appContainer}>
        {/* Боковое меню (Sheet) */}
        <Sheet>
          <SheetTrigger asChild>
            <Button
                variant="outline"
                className={styles.menuButton}
            >
              ☰ Меню
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className={styles.sheetContent}>
            <SheetHeader>
              <SheetTitle>Управление видеозвонком</SheetTitle>
              <SheetDescription>
                Настройки подключения и параметры звонка
              </SheetDescription>
            </SheetHeader>

            <div className={styles.sheetForm}>
              <div className={styles.inputGroup}>
                <Label htmlFor="room">Комната:</Label>
                <Input
                    id="room"
                    value={room}
                    onChange={(e) => setRoom(e.target.value)}
                />
              </div>

              <div className={styles.inputGroup}>
                <Label htmlFor="username">Имя пользователя:</Label>
                <Input
                    id="username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                />
              </div>

              <Button
                  onClick={joinRoom}
                  disabled={isConnected}
                  className={styles.button}
              >
                {isConnected ? 'Подключен' : 'Войти в комнату'}
              </Button>

              <div className={styles.userList}>
                <h3>Участники ({users.length}):</h3>
                <ul>
                  {users.map((user, index) => (
                      <li key={index}>{user}</li>
                  ))}
                </ul>
              </div>

              <div className={styles.callControls}>
                {!isCallActive ? (
                    <Button
                        onClick={startCall}
                        disabled={!isConnected || users.length < 2}
                        className={styles.button}
                    >
                      Начать звонок
                    </Button>
                ) : (
                    <Button
                        onClick={endCall}
                        className={styles.button}
                        variant="destructive"
                    >
                      Завершить звонок
                    </Button>
                )}
              </div>
            </div>

            {error && <div className={styles.errorMessage}>{error}</div>}
          </SheetContent>
        </Sheet>

        {/* Контейнер с видео */}
        <div className={styles.videoContainer}>
          <div className={styles.videoWrapper}>
            <LocalVideo ref={localVideoRef} />
            <div className={styles.videoLabel}>Вы ({username})</div>
          </div>

          <div className={styles.videoWrapper}>
            <RemoteVideo ref={remoteVideoRef} />
            <div className={styles.videoLabel}>Собеседник</div>
          </div>
        </div>
      </div>
  );
}