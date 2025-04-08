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
    const [hasPermission, setHasPermission] = useState(false);

    const {
        localStream,
        remoteUsers,
        startCall,
        endCall,
        joinRoom,
        leaveRoom,
        isCallActive,
        isConnected,
        error
    } = useWebRTC(selectedDevices, username, roomId);

    const loadDevices = async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: true,
                audio: true
            });
            stream.getTracks().forEach(track => track.stop());

            const devices = await navigator.mediaDevices.enumerateDevices();
            setDevices(devices);
            setHasPermission(true);

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

    const handleRefreshDevices = async () => {
        await loadDevices();
    };

    return (
        <div className={styles.container}>
            <h1 className={styles.title}>WebRTC Video Call</h1>

            {error && <div className={styles.error}>{error}</div>}

            <div className={styles.controls}>
                <div className={styles.inputGroup}>
                    <Label htmlFor="room">Room:</Label>
                    <Input
                        id="room"
                        value={roomId}
                        onChange={(e) => setRoomId(e.target.value)}
                        disabled={isConnected}
                    />
                </div>

                <div className={styles.inputGroup}>
                    <Label htmlFor="username">Username:</Label>
                    <Input
                        id="username"
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        disabled={isConnected}
                    />
                </div>

                {!isConnected ? (
                    <Button
                        onClick={joinRoom}
                        className={styles.button}
                    >
                        Join Room
                    </Button>
                ) : (
                    <Button
                        onClick={() => {
                            endCall();
                            leaveRoom();
                        }}
                        className={styles.button}
                        variant="destructive"
                    >
                        Leave Room
                    </Button>
                )}

                {isConnected && !isCallActive && (
                    <Button
                        onClick={startCall}
                        disabled={remoteUsers.length < 1}
                        className={styles.button}
                    >
                        Start Call
                    </Button>
                )}

                {isCallActive && (
                    <Button
                        onClick={endCall}
                        className={styles.button}
                        variant="destructive"
                    >
                        End Call
                    </Button>
                )}
            </div>

            <div className={styles.userList}>
                <h3>Participants ({remoteUsers.length}):</h3>
                <ul>
                    {remoteUsers.map((user, index) => (
                        <li key={index}>{user.username}</li>
                    ))}
                </ul>
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
                        stream={remoteUsers[0]?.stream || null}
                        className={styles.remoteVideo}
                    />
                    <div className={styles.videoLabel}>
                        {remoteUsers[0]?.username || 'Connecting...'}
                    </div>
                </div>
            </div>

            {!isConnected && (
                <div className={styles.deviceSelection}>
                    <h3>Select devices:</h3>
                    {!hasPermission ? (
                        <Button
                            onClick={loadDevices}
                            className={styles.refreshButton}
                        >
                            Request camera & microphone access
                        </Button>
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