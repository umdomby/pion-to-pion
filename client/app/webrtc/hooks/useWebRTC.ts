// file: client/app/webrtc/hooks/useWebRTC.ts
import { useEffect, useRef, useState } from 'react';

interface WebSocketMessage {
    type: string;
    data?: any;
    sdp?: RTCSessionDescriptionInit;
    ice?: RTCIceCandidateInit;
}

export const useWebRTC = (
    deviceIds: { video: string; audio: string },
    username: string,
    roomId: string
) => {
    const [localStream, setLocalStream] = useState<MediaStream | null>(null);
    const [remoteUsers, setRemoteUsers] = useState<any[]>([]);
    const [isCallActive, setIsCallActive] = useState(false);
    const [isConnected, setIsConnected] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const ws = useRef<WebSocket | null>(null);
    const pc = useRef<RTCPeerConnection | null>(null);

    useEffect(() => {
        // Автоматически устанавливаем isCallActive в true, если есть удаленный поток
        const hasRemoteStream = remoteUsers.some(user => user.stream);
        if (hasRemoteStream && !isCallActive) {
            setIsCallActive(true);
        }
    }, [remoteUsers]);

    const cleanup = () => {
        if (pc.current) {
            pc.current.onicecandidate = null;
            pc.current.ontrack = null;
            pc.current.close();
            pc.current = null;
        }

        if (localStream) {
            localStream.getTracks().forEach(track => track.stop());
            setLocalStream(null);
        }

        if (ws.current) {
            ws.current.close();
            ws.current = null;
        }

        setIsCallActive(false);
    };

    const leaveRoom = () => {
        if (ws.current?.readyState === WebSocket.OPEN) {
            ws.current.send(JSON.stringify({ type: 'leave' }));
        }
        cleanup();
        setRemoteUsers([]);
    };

    const connectWebSocket = () => {
        try {
            ws.current = new WebSocket('wss://anybet.site/ws');

            ws.current.onopen = () => {
                setIsConnected(true);
                ws.current?.send(JSON.stringify({
                    type: 'join',
                    room: roomId,
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

            ws.current.onmessage = async (event) => {
                try {
                    const data: WebSocketMessage = JSON.parse(event.data);

                    if (data.type === 'room_info') {
                        setRemoteUsers(
                            data.data.users
                                .filter((u: string) => u !== username)
                                .map((u: string) => ({ username: u }))
                        );
                    }
                    else if (data.type === 'join') {
                        setRemoteUsers(prev => {
                            if (prev.some(user => user.username === data.data)) {
                                return prev;
                            }
                            return [...prev, { username: data.data }];
                        });
                    }
                    else if (data.type === 'leave') {
                        setRemoteUsers(prev =>
                            prev.filter(user => user.username !== data.data)
                        );
                    }
                    else if (data.type === 'error') {
                        setError(data.data);
                    } else if (data.sdp && pc.current) {
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
            console.error('WebSocket connection error:', err);
            setError('Failed to connect to server');
            return false;
        }
    };

    const initializeWebRTC = async () => {
        try {
            if (pc.current) {
                cleanup();
            }

            pc.current = new RTCPeerConnection({
                iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
            });

            const stream = await navigator.mediaDevices.getUserMedia({
                video: deviceIds.video ? { deviceId: { exact: deviceIds.video } } : true,
                audio: deviceIds.audio ? { deviceId: { exact: deviceIds.audio } } : true
            });

            setLocalStream(stream);
            stream.getTracks().forEach(track => {
                pc.current?.addTrack(track, stream);
            });

            pc.current.onicecandidate = (event) => {
                if (event.candidate && ws.current?.readyState === WebSocket.OPEN) {
                    ws.current.send(JSON.stringify({ ice: event.candidate }));
                }
            };

            pc.current.ontrack = (event) => {
                setRemoteUsers(prev => {
                    const existingUser = prev.find(u => u.username !== username);
                    if (existingUser) {
                        return prev.map(u => ({
                            ...u,
                            stream: event.streams[0]
                        }));
                    }
                    return [...prev, { username: 'Remote', stream: event.streams[0] }];
                });
            };

            if (!ws.current) {
                throw new Error('WebSocket connection not established');
            }

            return true;
        } catch (err) {
            console.error('WebRTC initialization error:', err);
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
            setError(null);
        } catch (err) {
            console.error('Error starting call:', err);
            setError('Failed to start call');
        }
    };

    const endCall = () => {
        cleanup();
        setRemoteUsers([]);
    };

    const joinRoom = async () => {
        setError(null);

        if (!connectWebSocket()) {
            return;
        }

        await new Promise(resolve => setTimeout(resolve, 500));

        if (!(await initializeWebRTC())) {
            return;
        }
    };

    useEffect(() => {
        return () => {
            cleanup();
        };
    }, []);

    return {
        localStream,
        remoteUsers,
        startCall,
        endCall,
        joinRoom,
        isCallActive,
        isConnected,
        leaveRoom,
        error
    };
};