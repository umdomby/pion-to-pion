// file: client2/app/webrtc/hooks/useWebRTC.ts
import { useEffect, useRef, useState } from 'react';
import { SignalingClient } from '../lib/signaling';
import { User } from '../types';

export const useWebRTC = (deviceIds: { video: string; audio: string }, username: string) => {
    const [localStream, setLocalStream] = useState<MediaStream | null>(null);
    const [remoteUsers, setRemoteUsers] = useState<User[]>([]);
    const [roomId, setRoomId] = useState<string | null>(null);
    const [isCaller, setIsCaller] = useState(false);
    const [connectionStatus, setConnectionStatus] = useState('disconnected');
    const [error, setError] = useState<string | null>(null);

    const signalingClient = useRef<SignalingClient | null>(null);
    const localStreamRef = useRef<MediaStream | null>(null);
    const peerConnections = useRef<Record<string, RTCPeerConnection>>({});

    const initPeerConnection = (userId: string): RTCPeerConnection => {
        const pc = new RTCPeerConnection({
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' }
            ]
        });

        pc.onicecandidate = (event) => {
            if (event.candidate && signalingClient.current?.isConnected) {
                signalingClient.current.sendCandidate(event.candidate.toJSON())
                    .catch(e => console.error('Failed to send ICE candidate:', e));
            }
        };

        pc.ontrack = (event) => {
            if (!event.streams || event.streams.length === 0) return;

            setRemoteUsers(prev => {
                const existingUser = prev.find(u => u.username === userId);
                const newStream = new MediaStream();
                event.streams[0].getTracks().forEach(track => newStream.addTrack(track));

                if (existingUser) {
                    return prev.map(u =>
                        u.username === userId
                            ? { ...u, stream: newStream }
                            : u
                    );
                }
                return [...prev, { username: userId, stream: newStream, peerConnection: pc }];
            });
        };

        pc.oniceconnectionstatechange = () => {
            console.log(`ICE state for ${userId}:`, pc.iceConnectionState);
            if (pc.iceConnectionState === 'connected') {
                setConnectionStatus('connected');
            } else if (pc.iceConnectionState === 'disconnected') {
                setConnectionStatus('disconnected');
            }
        };

        return pc;
    };

    const createOffer = async (toUsername: string) => {
        if (peerConnections.current[toUsername]) {
            console.log('Connection already exists for user:', toUsername);
            return;
        }

        const pc = initPeerConnection(toUsername);
        peerConnections.current[toUsername] = pc;

        if (!localStreamRef.current) {
            console.error('Local stream not available');
            return;
        }

        try {
            localStreamRef.current.getTracks().forEach(track => {
                pc.addTrack(track, localStreamRef.current!);
            });

            const offer = await pc.createOffer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: true
            });

            await pc.setLocalDescription(offer);

            if (!signalingClient.current) {
                throw new Error('Signaling client not available');
            }

            await signalingClient.current.sendOffer(offer);

            setRemoteUsers(prev => {
                const existingUser = prev.find(u => u.username === toUsername);
                if (existingUser) {
                    return prev.map(u =>
                        u.username === toUsername ? { ...u, peerConnection: pc } : u
                    );
                }
                return [...prev, { username: toUsername, peerConnection: pc }];
            });

        } catch (err) {
            console.error('Error in createOffer:', err);
            setError(`Failed to create offer: ${err instanceof Error ? err.message : String(err)}`);
            pc.close();
            delete peerConnections.current[toUsername];
        }
    };

    const handleRemoteOffer = async (offer: RTCSessionDescriptionInit, from: string) => {
        const pc = initPeerConnection(from);
        peerConnections.current[from] = pc;

        await pc.setRemoteDescription(new RTCSessionDescription(offer));

        if (localStreamRef.current) {
            localStreamRef.current.getTracks().forEach(track => {
                pc.addTrack(track, localStreamRef.current!);
            });
        }

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        signalingClient.current?.sendAnswer(answer);

        setRemoteUsers(prev => {
            const existingUser = prev.find(u => u.username === from);
            if (existingUser) {
                return prev.map(u =>
                    u.username === from ? { ...u, peerConnection: pc } : u
                );
            }
            return [...prev, { username: from, peerConnection: pc }];
        });
    };

    const handleRemoteAnswer = async (answer: RTCSessionDescriptionInit, from: string) => {
        const pc = peerConnections.current[from];
        if (pc) {
            await pc.setRemoteDescription(new RTCSessionDescription(answer));
        }
    };

    const handleCandidate = async (candidate: RTCIceCandidateInit, from: string) => {
        const pc = peerConnections.current[from];
        if (pc && candidate) {
            try {
                await pc.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (err) {
                console.error('Error adding ICE candidate:', err);
            }
        }
    };

    const startCall = async (isInitiator: boolean, existingRoomId?: string) => {
        try {
            setIsCaller(isInitiator);
            await getLocalMedia();

            const roomId = existingRoomId || generateRoomId();
            setRoomId(roomId);

            signalingClient.current = new SignalingClient('wss://anybet.site/ws');

            // Подключаем обработчики событий
            signalingClient.current.onRoomInfo = (data) => {
                data.users.forEach(user => {
                    if (user !== username && !peerConnections.current[user]) {
                        if (isInitiator) {
                            createOffer(user);
                        }
                        setRemoteUsers(prev => {
                            if (!prev.some(u => u.username === user)) {
                                return [...prev, { username: user }];
                            }
                            return prev;
                        });
                    }
                });
            };

            signalingClient.current.onOffer = (offer) => {
                // В реальном приложении нужно определить отправителя
                // Для демо просто используем первого пользователя
                const fromUser = remoteUsers.find(u => u.username !== username)?.username || 'unknown';
                handleRemoteOffer(offer, fromUser);
            };

            signalingClient.current.onAnswer = (answer) => {
                const fromUser = remoteUsers.find(u => u.username !== username)?.username || 'unknown';
                handleRemoteAnswer(answer, fromUser);
            };

            signalingClient.current.onCandidate = (candidate) => {
                const fromUser = remoteUsers.find(u => u.username !== username)?.username || 'unknown';
                handleCandidate(candidate, fromUser);
            };

            signalingClient.current.onError = (error) => {
                setError(error);
                setConnectionStatus('failed');
            };

            // Подключаемся к серверу
            await signalingClient.current.connect(roomId, username);

        } catch (error) {
            console.error('Error starting call:', error);
            setError(`Failed to start call: ${error instanceof Error ? error.message : String(error)}`);
            setConnectionStatus('failed');
            cleanup();
        }
    };

    const generateRoomId = (): string => {
        return Math.random().toString(36).substring(2, 8);
    };

    const getLocalMedia = async () => {
        try {
            const constraints = {
                video: deviceIds.video ? { deviceId: { exact: deviceIds.video } } : true,
                audio: deviceIds.audio ? { deviceId: { exact: deviceIds.audio } } : true
            };

            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            localStreamRef.current = stream;
            setLocalStream(new MediaStream(stream.getTracks()));
            return stream;
        } catch (err) {
            console.error('Error getting media devices:', err);
            setError('Could not access camera/microphone');
            throw err;
        }
    };

    const joinRoom = (roomId: string) => {
        startCall(false, roomId);
    };

    const stopCall = () => {
        cleanup();
        setRoomId(null);
        setConnectionStatus('disconnected');
    };

    const cleanup = () => {
        Object.values(peerConnections.current).forEach(pc => pc.close());
        peerConnections.current = {};

        if (signalingClient.current) {
            signalingClient.current.close();
            signalingClient.current = null;
        }

        if (localStreamRef.current) {
            localStreamRef.current.getTracks().forEach(track => track.stop());
            localStreamRef.current = null;
            setLocalStream(null);
        }

        setRemoteUsers([]);
    };

    useEffect(() => {
        return () => {
            cleanup();
        };
    }, []);

    return {
        localStream,
        remoteUsers,
        roomId,
        connectionStatus,
        error,
        isConnected: connectionStatus === 'connected',
        startCall,
        joinRoom,
        stopCall
    };
};