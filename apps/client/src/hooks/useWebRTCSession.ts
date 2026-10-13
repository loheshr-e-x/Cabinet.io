import { useCallback, useEffect, useRef, useState } from 'react';
import { ORCHESTRATOR_URL } from '../config';

interface UseWebRTCSessionOptions {
  sessionId: string | null;
  token: string | null;
  edgeWsUrl: string | null;
}

export function useWebRTCSession({
  sessionId,
  token,
  edgeWsUrl,
}: UseWebRTCSessionOptions) {
  const [connectionStatus, setConnectionStatus] = useState('idle');
  const [dataChannel, setDataChannel] = useState<RTCDataChannel | null>(null);
  const [isDataChannelOpen, setIsDataChannelOpen] = useState(false);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const closeSessionRef = useRef<() => void>(() => {});
  const hasActiveSession = Boolean(sessionId && token && edgeWsUrl);
  const closeSession = useCallback(() => closeSessionRef.current(), []);

  useEffect(() => {
    if (!dataChannel) return;

    const syncReadyState = () => {
      setIsDataChannelOpen(dataChannel.readyState === 'open');
    };
    dataChannel.addEventListener('open', syncReadyState);
    dataChannel.addEventListener('close', syncReadyState);
    const initialSyncId = window.setTimeout(syncReadyState, 0);
    const pollId = window.setInterval(syncReadyState, 100);

    return () => {
      dataChannel.removeEventListener('open', syncReadyState);
      dataChannel.removeEventListener('close', syncReadyState);
      window.clearTimeout(initialSyncId);
      window.clearInterval(pollId);
    };
  }, [dataChannel]);

  useEffect(() => {
    if (!sessionId || !token || !edgeWsUrl) {
      return;
    }

    let stopped = false;
    let reconnectTimer: number | undefined;
    let peerConnection: RTCPeerConnection;
    let socket: WebSocket;
    let disconnectNotified = false;
    let signalingReady = false;
    const peerConnections = new Set<RTCPeerConnection>();
    const sockets = new Set<WebSocket>();
    const pendingCandidates: RTCIceCandidate[] = [];
    const sendSignalingMessage = (activeSocket: WebSocket, payload: unknown) => {
      if (activeSocket.readyState !== WebSocket.OPEN) return false;
      activeSocket.send(JSON.stringify(payload));
      return true;
    };

    const closeSessionResources = () => {
      if (stopped) return;
      stopped = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      setDataChannel(null);
      setIsDataChannelOpen(false);
      setRemoteStream(null);
      for (const connection of peerConnections) {
        if (connection.signalingState !== 'closed') connection.close();
      }
      for (const activeSocket of sockets) {
        if (activeSocket.readyState < WebSocket.CLOSING) activeSocket.close();
      }
      peerConnectionRef.current = null;
      wsRef.current = null;
    };
    closeSessionRef.current = closeSessionResources;

    const reportSessionState = async (action: 'disconnect' | 'reconnect') => {
      try {
        const response = await fetch(
          new URL(`/api/v1/session/${action}`, ORCHESTRATOR_URL),
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ sessionId }),
          },
        );
        if (!response.ok) {
          throw new Error(`Session ${action} request failed (${response.status})`);
        }
      } catch (error) {
        console.error(`[Cabinet] Could not report ${action} state:`, error);
      }
    };

    const connect = async (iceRestart = false) => {
      if (stopped) return;
      signalingReady = false;
      pendingCandidates.length = 0;
      setIsDataChannelOpen(false);
      setConnectionStatus(iceRestart ? 'reconnecting' : 'connecting');
      peerConnection = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
        ],
      });
      peerConnectionRef.current = peerConnection;
      peerConnections.add(peerConnection);
      peerConnection.addTransceiver('video', { direction: 'recvonly' });
      peerConnection.addTransceiver('audio', { direction: 'recvonly' });
      const channel = peerConnection.createDataChannel('input');
      setDataChannel(channel);
      const updateDataChannelReadyState = () => {
        if (!stopped && peerConnectionRef.current === peerConnection) {
          setIsDataChannelOpen(channel.readyState === 'open');
        }
      };
      channel.onopen = updateDataChannelReadyState;
      channel.onclose = updateDataChannelReadyState;
      channel.addEventListener('open', updateDataChannelReadyState);
      channel.addEventListener('close', updateDataChannelReadyState);
      updateDataChannelReadyState();

      peerConnection.ontrack = (event) => {
        if (stopped) return;
        console.info('[Cabinet UI] Incoming track received:', event.track.kind);
        setRemoteStream((stream) => {
          const incomingStream = event.streams[0];
          if (incomingStream) return incomingStream;
          if (stream) {
            stream.addTrack(event.track);
            return stream;
          }
          return new MediaStream([event.track]);
        });
      };

      socket = new WebSocket(edgeWsUrl);
      wsRef.current = socket;
      sockets.add(socket);

      peerConnection.onicecandidate = (event) => {
        if (stopped) return;
        if (!event.candidate) return;
        const candidate = {
          type: 'candidate',
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
        };
        if (signalingReady) {
          sendSignalingMessage(socket, candidate);
        } else if (socket.readyState === WebSocket.CONNECTING) {
          pendingCandidates.push(event.candidate);
        }
      };

      peerConnection.oniceconnectionstatechange = () => {
        if (stopped) return;
        setConnectionStatus(peerConnection.iceConnectionState);
        if (
          peerConnection.iceConnectionState === 'disconnected' ||
          peerConnection.iceConnectionState === 'failed'
        ) {
          if (!disconnectNotified) {
            disconnectNotified = true;
            void reportSessionState('disconnect');
          }
          if (reconnectTimer === undefined) {
            reconnectTimer = window.setTimeout(async () => {
              reconnectTimer = undefined;
              await reportSessionState('reconnect');
              if (socket.readyState < WebSocket.CLOSING) socket.close();
              peerConnection.close();
              if (!stopped) void connect(true);
            }, 2_000);
          }
        } else if (peerConnection.iceConnectionState === 'connected' ||
                   peerConnection.iceConnectionState === 'completed') {
          disconnectNotified = false;
          if (reconnectTimer !== undefined) {
            window.clearTimeout(reconnectTimer);
            reconnectTimer = undefined;
          }
          void reportSessionState('reconnect');
        }
      };

      socket.onopen = async () => {
        if (stopped) return;
        try {
          const offer = await peerConnection.createOffer({ iceRestart });
          if (stopped) return;
          await peerConnection.setLocalDescription(offer);
          if (stopped) return;
          const sdp = peerConnection.localDescription?.sdp;
          if (!sdp) throw new Error('Peer connection did not produce an SDP offer');
          if (!sendSignalingMessage(socket, { type: 'offer', sdp })) return;
          signalingReady = true;
          for (const candidate of pendingCandidates.splice(0)) {
            if (
              !sendSignalingMessage(socket, {
                type: 'candidate',
                candidate: candidate.candidate,
                sdpMid: candidate.sdpMid,
                sdpMLineIndex: candidate.sdpMLineIndex,
              })
            ) break;
          }
        } catch (error) {
          console.error('[Cabinet] Could not create WebRTC offer:', error);
          setConnectionStatus('offer-error');
          if (socket.readyState < WebSocket.CLOSING) socket.close();
        }
      };

      socket.onmessage = async ({ data }) => {
        let message: {
          type?: string;
          sdp?: string;
          candidate?: string;
          sdpMid?: string | null;
          sdpMLineIndex?: number | null;
        };
        try {
          message = JSON.parse(String(data));
        } catch (error) {
          console.error('[Cabinet] Invalid signaling response:', error);
          return;
        }

        if (message.type === 'answer' && message.sdp) {
          try {
            await peerConnection.setRemoteDescription({ type: 'answer', sdp: message.sdp });
          } catch (error) {
            console.error('[Cabinet] Could not apply WebRTC answer:', error);
            setConnectionStatus('answer-error');
          }
        } else if (message.type === 'candidate' && message.candidate !== undefined) {
          try {
            await peerConnection.addIceCandidate({
              candidate: message.candidate,
              sdpMid: message.sdpMid,
              sdpMLineIndex: message.sdpMLineIndex,
            });
          } catch (error) {
            console.error('[Cabinet] Could not add remote ICE candidate:', error);
            setConnectionStatus('ice-error');
          }
        }
      };

      socket.onerror = () => {
        if (!stopped) setConnectionStatus('signaling-error');
      };
      socket.onclose = () => {
        if (!stopped) setConnectionStatus('signaling-disconnected');
      };
    };

    void connect();

    return () => {
      closeSessionResources();
      if (closeSessionRef.current === closeSessionResources) {
        closeSessionRef.current = () => {};
      }
    };
  }, [sessionId, token, edgeWsUrl]);

  return {
    connectionStatus: hasActiveSession ? connectionStatus : 'idle',
    dataChannel: hasActiveSession ? dataChannel : null,
    isDataChannelOpen: hasActiveSession && isDataChannelOpen,
    remoteStream: hasActiveSession ? remoteStream : null,
    peerConnectionRef,
    closeSession,
  };
}
