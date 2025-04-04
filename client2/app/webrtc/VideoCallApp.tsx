// app/webrtc/VideoCallApp.tsx
import { useWebRTC } from './hooks/useWebRTC';
import styles from './styles.module.css';
import { VideoPlayer } from './components/VideoPlayer';
import { DeviceSelector } from './components/DeviceSelector';
import { useEffect, useState } from 'react';

export const VideoCallApp = () => {
    const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
    const [selectedDevices, setSelectedDevices] = useState({
        video: '',
        audio: ''
    });
    const [roomIdInput, setRoomIdInput] = useState('');
    const [username, setUsername] = useState(`User${Math.floor(Math.random() * 1000)}`);
    const [hasPermission, setHasPermission] = useState(false);

    const {
        localStream,
        remoteUsers,
        roomId,
        startCall,
        joinRoom,
        stopCall,
        isConnected,
        connectionStatus,
        error
    } = useWebRTC(selectedDevices, username);

    const loadDevices = async () => {
        try {
            // Сначала запрашиваем разрешения
            const stream = await navigator.mediaDevices.getUserMedia({
                video: true,
                audio: true
            });

            // Останавливаем треки сразу после получения разрешений
            stream.getTracks().forEach(track => track.stop());

            // Теперь получаем список устройств
            const devices = await navigator.mediaDevices.enumerateDevices();
            setDevices(devices);
            setHasPermission(true);

            // Автоматически выбираем устройства если они есть
            const videoDevice = devices.find(d => d.kind === 'videoinput');
            const audioDevice = devices.find(d => d.kind === 'audioinput');

            setSelectedDevices({
                video: videoDevice?.deviceId || '',
                audio: audioDevice?.deviceId || ''
            });

        } catch (error) {
            console.error('Device access error:', error);
            setHasPermission(false);
        }
    };

    useEffect(() => {
        loadDevices();
    }, []);

    const handleStartCall = () => {
        if (roomIdInput.trim()) {
            joinRoom(roomIdInput.trim());
        } else {
            startCall(true);
        }
    };

    const handleRefreshDevices = async () => {
        await loadDevices();
    };

    return (
        <div className={styles.container}>
            <h1 className={styles.title}>WebRTC Video Call</h1>

            {error && <div className={styles.error}>{error}</div>}

            <div className={styles.controls}>
                <input
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="Ваше имя"
                    className={styles.input}
                />
                <input
                    type="text"
                    value={roomIdInput}
                    onChange={(e) => setRoomIdInput(e.target.value)}
                    placeholder="ID комнаты (оставьте пустым для создания новой)"
                    className={styles.input}
                />
                <button
                    onClick={handleStartCall}
                    className={styles.button}
                    disabled={isConnected}
                >
                    {isConnected ? 'Подключено' : 'Подключиться'}
                </button>
                {isConnected && (
                    <button onClick={stopCall} className={styles.stopButton}>
                        Завершить
                    </button>
                )}
            </div>

            {roomId && (
                <div className={styles.roomInfo}>
                    <p>ID комнаты: <strong>{roomId}</strong></p>
                </div>
            )}

            <div className={styles.connectionStatus}>
                <span>Статус: </span>
                <div className={`${styles.connectionDot} ${
                    isConnected ? styles.connected : styles.disconnected
                }`} />
                <span>{connectionStatus}</span>
            </div>

            <div className={styles.videoContainer}>
                {/* Локальное видео */}
                {localStream && (
                    <div className={styles.videoWrapper}>
                        <VideoPlayer
                            stream={localStream}
                            muted
                            className={styles.video}
                        />
                        <div className={styles.videoLabel}>Вы: {username}</div>
                    </div>
                )}

                {/* Удаленные видео */}
                {remoteUsers.map((user) => (
                    <div key={user.username} className={styles.videoWrapper}>
                        {user.stream ? (
                            <>
                                <VideoPlayer
                                    stream={user.stream}
                                    className={styles.video}
                                />
                                <div className={styles.videoLabel}>{user.username}</div>
                            </>
                        ) : (
                            <div className={styles.videoPlaceholder}>
                                <div className={styles.userAvatar}>
                                    {user.username.charAt(0).toUpperCase()}
                                </div>
                                <div>{user.username}</div>
                                <div>Подключается...</div>
                            </div>
                        )}
                    </div>
                ))}
            </div>

            {!isConnected && (
                <div className={styles.deviceSelection}>
                    <h3>Выберите устройства:</h3>
                    {!hasPermission ? (
                        <button
                            onClick={loadDevices}
                            className={styles.refreshButton}
                        >
                            Запросить доступ к камере и микрофону
                        </button>
                    ) : (
                        <DeviceSelector
                            devices={devices}
                            selectedDevices={selectedDevices}
                            onChange={(type, deviceId) =>
                                setSelectedDevices(prev => ({...prev, [type]: deviceId}))
                            }
                            onRefresh={handleRefreshDevices}
                        />
                    )}
                </div>
            )}
        </div>
    );
};