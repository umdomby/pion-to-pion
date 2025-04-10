// file: client/app/webrtc/hooks/useWebRTC.ts
import { useEffect, useRef, useState } from 'react';

interface WebSocketMessage {
    type: string;
    data?: any;
    sdp?: RTCSessionDescriptionInit;
    ice?: RTCIceCandidateInit;
    room?: string;
    username?: string;
}

export const useWebRTC = (
    deviceIds: { video: string; audio: string },
    username: string,
    roomId: string
) => {
    const [localStream, setLocalStream] = useState<MediaStream | null>(null);
    const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
    const [users, setUsers] = useState<string[]>([]);
    const [isCallActive, setIsCallActive] = useState(false);
    const [isConnected, setIsConnected] = useState(false);
    const [isInRoom, setIsInRoom] = useState(false);
    const [isCallInitiator, setIsCallInitiator] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const ws = useRef<WebSocket | null>(null);
    const pc = useRef<RTCPeerConnection | null>(null);
    const pendingIceCandidates = useRef<RTCIceCandidate[]>([]);

    const cleanup = () => {
        if (pc.current) {
            pc.current.onicecandidate = null;
            pc.current.ontrack = null;
            pc.current.onnegotiationneeded = null;
            pc.current.oniceconnectionstatechange = null;
            pc.current.close();
            pc.current = null;
        }

        if (localStream) {
            localStream.getTracks().forEach(track => track.stop());
            setLocalStream(null);
        }

        if (remoteStream) {
            remoteStream.getTracks().forEach(track => track.stop());
            setRemoteStream(null);
        }

        setIsCallActive(false);
        setIsCallInitiator(false);
        pendingIceCandidates.current = [];
    };

    const leaveRoom = () => {
        if (ws.current?.readyState === WebSocket.OPEN) {
            ws.current.send(JSON.stringify({
                type: 'leave',
                room: roomId,
                username
            }));
        }
        cleanup();
        setUsers([]);
        setIsInRoom(false);
    };

    const connectWebSocket = () => {
        try {
            ws.current = new WebSocket('wss://anybet.site/ws');

            ws.current.onopen = () => {
                setIsConnected(true);
                setError(null);
                console.log('WebSocket connected');
            };

            ws.current.onerror = (event) => {
                console.error('WebSocket error:', event);
                setError('Connection error');
                setIsConnected(false);

                // Попытка переподключения при ошибке
                setTimeout(() => {
                    if (!isConnected && isInRoom) {
                        console.log('Attempting to reconnect after error...');
                        connectWebSocket();
                    }
                }, 3000);
            };

            ws.current.onclose = (event) => {
                console.log('WebSocket disconnected, code:', event.code, 'reason:', event.reason);
                setIsConnected(false);

                // Попытка переподключения только если это не было преднамеренным закрытием
                if (event.code !== 1000) { // 1000 - нормальное закрытие
                    setTimeout(() => {
                        if (!isConnected && isInRoom) {
                            console.log('Attempting to reconnect after close...');
                            connectWebSocket();
                        }
                    }, 3000);
                }
            };

            ws.current.onmessage = async (event) => {
                try {
                    const data: WebSocketMessage = JSON.parse(event.data);
                    console.log('Received message:', data);

                    if (data.type === 'room_info') {
                        setUsers(data.data.users || []);
                    }
                    else if (data.type === 'error') {
                        setError(data.data);
                    }
                    else if (data.type === 'start_call') {
                        if (!isCallActive && pc.current && ws.current?.readyState === WebSocket.OPEN) {
                            const offer = await pc.current.createOffer({
                                offerToReceiveAudio: true,
                                offerToReceiveVideo: true
                            });
                            await pc.current.setLocalDescription(offer);
                            ws.current.send(JSON.stringify({
                                type: 'offer',
                                sdp: offer,
                                room: roomId,
                                username
                            }));
                            setIsCallActive(true);
                            setIsCallInitiator(true);
                        }
                    }
                    else if (data.type === 'offer') {
                        if (pc.current && ws.current?.readyState === WebSocket.OPEN && data.sdp) {
                            await pc.current.setRemoteDescription(new RTCSessionDescription(data.sdp));

                            const answer = await pc.current.createAnswer({
                                offerToReceiveAudio: true,
                                offerToReceiveVideo: true
                            });
                            await pc.current.setLocalDescription(answer);

                            ws.current.send(JSON.stringify({
                                type: 'answer',
                                sdp: answer,
                                room: roomId,
                                username
                            }));

                            setIsCallActive(true);
                        }
                    }
                    else if (data.type === 'answer') {
                        if (pc.current && pc.current.signalingState !== 'stable' && data.sdp) {
                            await pc.current.setRemoteDescription(new RTCSessionDescription(data.sdp));
                            setIsCallActive(true);

                            pendingIceCandidates.current.forEach(candidate => {
                                pc.current?.addIceCandidate(new RTCIceCandidate(candidate));
                            });
                            pendingIceCandidates.current = [];
                        }
                    }
                    else if (data.type === 'ice_candidate') {
                        if (data.ice) {
                            const candidate = new RTCIceCandidate(data.ice);

                            if (pc.current && pc.current.remoteDescription) {
                                await pc.current.addIceCandidate(candidate);
                            } else {
                                pendingIceCandidates.current.push(candidate);
                            }
                        }
                    }
                } catch (err) {
                    console.error('Error processing message:', err);
                    setError('Error processing server message');
                }
            };

            return true;
        } catch (err) {
            console.error('WebSocket connection error:', err);
            setError('Failed to connect to server');
            return false;
        }
    };

    // Остальной код остается без изменений...
    const initializeWebRTC = async () => {
        try {
            cleanup();

            const config = {
                iceServers: [
                    { urls: 'stun:stun.l.google.com:19302' }
                ],
                sdpSemantics: 'unified-plan' as const,
                bundlePolicy: 'max-bundle' as const,
                rtcpMuxPolicy: 'require' as const,
                iceTransportPolicy: 'all' as const
            };

            pc.current = new RTCPeerConnection(config);

            const stream = await navigator.mediaDevices.getUserMedia({
                video: deviceIds.video ? {
                    deviceId: { exact: deviceIds.video },
                    width: { ideal: 640 },
                    height: { ideal: 480 },
                    frameRate: { ideal: 30 }
                } : true,
                audio: deviceIds.audio ? {
                    deviceId: { exact: deviceIds.audio },
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                } : true
            });

            setLocalStream(stream);
            stream.getTracks().forEach(track => {
                pc.current?.addTrack(track, stream);
            });

            pc.current.onicecandidate = (event) => {
                if (event.candidate && ws.current?.readyState === WebSocket.OPEN) {
                    ws.current.send(JSON.stringify({
                        type: 'ice_candidate',
                        ice: event.candidate,
                        room: roomId,
                        username
                    }));
                }
            };

            pc.current.ontrack = (event) => {
                if (event.streams && event.streams[0]) {
                    setRemoteStream(event.streams[0]);
                }
            };

            pc.current.oniceconnectionstatechange = () => {
                if (pc.current?.iceConnectionState === 'disconnected' ||
                    pc.current?.iceConnectionState === 'failed') {
                    console.log('ICE connection failed, attempting to restart...');
                    reconnect();
                }
            };

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
            ws.current.send(JSON.stringify({
                type: "start_call",
                room: roomId,
                username
            }));

            const offer = await pc.current.createOffer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: true
            });
            await pc.current.setLocalDescription(offer);

            ws.current.send(JSON.stringify({
                type: "offer",
                sdp: offer,
                room: roomId,
                username
            }));

            setIsCallActive(true);
            setIsCallInitiator(true);
            setError(null);
        } catch (err) {
            console.error('Error starting call:', err);
            setError('Failed to start call');
        }
    };

    const endCall = () => {
        if (ws.current?.readyState === WebSocket.OPEN) {
            ws.current.send(JSON.stringify({
                type: "end_call",
                room: roomId,
                username
            }));
        }
        cleanup();
    };

    const reconnect = async () => {
        cleanup();

        if (ws.current) {
            ws.current.close();
        }

        await new Promise(resolve => setTimeout(resolve, 1000));

        if (isInRoom) {
            await joinRoom(username);
        } else {
            connectWebSocket();
        }
    };

    const joinRoom = async (uniqueUsername: string) => {
        setError(null);

        if (!isConnected) {
            if (!connectWebSocket()) {
                return;
            }
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        if (!(await initializeWebRTC())) {
            return;
        }

        if (ws.current?.readyState === WebSocket.OPEN) {
            ws.current.send(JSON.stringify({
                action: "join",
                room: roomId,
                username: uniqueUsername
            }));
        }

        setIsInRoom(true);
    };

    useEffect(() => {
        connectWebSocket();

        return () => {
            if (ws.current) {
                // Используем код 1000 (нормальное закрытие) при размонтировании
                ws.current.close(1000, 'Component unmounted');
            }
            cleanup();
        };
    }, []);

    return {
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
        isCallInitiator,
        error
    };
};