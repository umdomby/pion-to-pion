'use client'

import { useWebRTC } from './hooks/useWebRTC';
import styles from './styles.module.css';
import { VideoPlayer } from './components/VideoPlayer';
import { DeviceSelector } from './components/DeviceSelector';
import { useEffect, useState } from 'react';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const VideoCallApp = () => {
    const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
    const [selectedDevices, setSelectedDevices] = useState({
        video: '',
        audio: ''
    });
    const [roomId, setRoomId] = useState('room1');
    const [username, setUsername] = useState(`User${Math.floor(Math.random() * 1000)}`);
    const [originalUsername, setOriginalUsername] = useState('');
    const [hasPermission, setHasPermission] = useState(false);
    const [devicesLoaded, setDevicesLoaded] = useState(false);

    const {
        localStream,
        remoteStream,
        users,
        startCall,
        endCall,
        joinRoom,
        leaveRoom,
        isCallActive,
        isConnected,
        isInRoom,
        error,
        isCallInitiator
    } = useWebRTC(selectedDevices, username, roomId);

    const generateUniqueUsername = (base: string) => {
        return `${base}_${Math.floor(Math.random() * 1000)}`;
    };

    const loadDevices = async () => {
        try {
            // Сначала запрашиваем разрешение на доступ к устройствам
            const stream = await navigator.mediaDevices.getUserMedia({
                video: true,
                audio: true
            });

            // Останавливаем треки, так как нам нужно только разрешение
            stream.getTracks().forEach(track => track.stop());

            // Теперь получаем список устройств
            const devices = await navigator.mediaDevices.enumerateDevices();
            setDevices(devices);
            setHasPermission(true);
            setDevicesLoaded(true);

            // Устанавливаем первые доступные устройства по умолчанию
            const videoDevice = devices.find(d => d.kind === 'videoinput');
            const audioDevice = devices.find(d => d.kind === 'audioinput');

            setSelectedDevices({
                video: videoDevice?.deviceId || '',
                audio: audioDevice?.deviceId || ''
            });
        } catch (error) {
            console.error('Device access error:', error);
            setHasPermission(false);
            setDevicesLoaded(true);
        }
    };

    const handleDeviceChange = (type: 'video' | 'audio', deviceId: string) => {
        setSelectedDevices(prev => ({
            ...prev,
            [type]: deviceId
        }));
    };

    const handleJoinRoom = async () => {
        if (!originalUsername) {
            setOriginalUsername(username);
        }
        const uniqueUsername = generateUniqueUsername(originalUsername || username);
        setUsername(uniqueUsername);
        await joinRoom(uniqueUsername);
    };

    // Автоматически загружаем устройства при монтировании компонента
    useEffect(() => {
        loadDevices();
    }, []);

    return (
        <div className={styles.container}>
            <h1 className={styles.title}>WebRTC Video Call</h1>

            {error && <div className={styles.error}>{error}</div>}

            <div className={styles.controls}>
                <div className={styles.connectionStatus}>
                    Status: {isConnected ? (isInRoom ? `In room ${roomId}` : 'Connected') : 'Disconnected'}
                    {isCallActive && ' (Call active)'}
                    {isCallInitiator && ' (Initiator)'}
                </div>

                <div className={styles.inputGroup}>
                    <Label htmlFor="room">Room:</Label>
                    <Input
                        id="room"
                        value={roomId}
                        onChange={(e) => setRoomId(e.target.value)}
                        disabled={isInRoom}
                    />
                </div>

                <div className={styles.inputGroup}>
                    <Label htmlFor="username">Username:</Label>
                    <Input
                        id="username"
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        disabled={isInRoom}
                    />
                </div>

                {!isInRoom ? (
                    <Button
                        onClick={handleJoinRoom}
                        disabled={!isConnected || !hasPermission}
                        className={styles.button}
                    >
                        Join Room
                    </Button>
                ) : (
                    <Button
                        onClick={leaveRoom}
                        className={styles.button}
                    >
                        Leave Room
                    </Button>
                )}

                <div className={styles.userList}>
                    <h3>Users in room ({users.length}):</h3>
                    <ul>
                        {users.map((user, index) => (
                            <li key={index}>{user}</li>
                        ))}
                    </ul>
                </div>

                <div>
                    {!isCallActive ? (
                        <Button
                            onClick={startCall}
                            disabled={!isInRoom || users.length < 2}
                            className={styles.button}
                        >
                            Start Call
                        </Button>
                    ) : (
                        <Button
                            onClick={endCall}
                            className={styles.button}
                            variant="destructive"
                        >
                            End Call
                        </Button>
                    )}
                </div>
            </div>

            <div className={styles.videoContainer}>
                <div className={styles.videoWrapper}>
                    <VideoPlayer
                        stream={localStream}
                        muted
                        className={styles.localVideo}
                    />
                    <div className={styles.videoLabel}>You ({username})</div>
                </div>

                <div className={styles.videoWrapper}>
                    <VideoPlayer
                        stream={remoteStream}
                        className={styles.remoteVideo}
                    />
                    <div className={styles.videoLabel}>Remote</div>
                </div>
            </div>

            <div className={styles.deviceSelection}>
                <h3>Select devices:</h3>
                {devicesLoaded ? (
                    <DeviceSelector
                        devices={devices}
                        selectedDevices={selectedDevices}
                        onChange={handleDeviceChange}
                        onRefresh={loadDevices}
                    />
                ) : (
                    <div>Loading devices...</div>
                )}
            </div>
        </div>
    );
};