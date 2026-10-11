import { useEffect, useRef, useState } from 'react';

interface UseWebRTCSessionOptions {
  sessionId: string | null;
  token: string | null;
  signalingUrl: string | null;
}

export function useWebRTCSession({
  sessionId,
  token,
  signalingUrl,
}: UseWebRTCSessionOptions) {
  const [connectionStatus, setConnectionStatus] = useState('idle');
  const [dataChannel, setDataChannel] = useState<RTCDataChannel | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const hasActiveSession = Boolean(sessionId && token && signalingUrl);

  useEffect(() => {
    if (!sessionId || !token || !signalingUrl) {
      return;
    }

    let stopped = false;
    let reconnectTimer: number | undefined;
    let peerConnection: RTCPeerConnection;
    let socket: WebSocket;
    let disconnectNotified = false;
    let signalingReady = false;
    const pendingCandidates: RTCIceCandidate[] = [];

    const apiBase = new URL(signalingUrl);
    apiBase.protocol = apiBase.protocol === 'wss:' ? 'https:' : 'http:';

    const reportSessionState = async (action: 'disconnect' | 'reconnect') => {
      try {
        const response = await fetch(
          new URL(`/api/v1/session/${action}`, apiBase),
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
      setConnectionStatus(iceRestart ? 'reconnecting' : 'connecting');
      peerConnection = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      });
      peerConnectionRef.current = peerConnection;
      peerConnection.addTransceiver('video', { direction: 'recvonly' });
      const channel = peerConnection.createDataChannel('controller-input');
      setDataChannel(channel);

      peerConnection.ontrack = (event) => {
        setRemoteStream(event.streams[0] ?? new MediaStream([event.track]));
      };

      const signaling = new URL(signalingUrl);
      if (!signaling.searchParams.has('sessionId')) {
        signaling.searchParams.set('sessionId', sessionId);
      }
      socket = new WebSocket(signaling);
      wsRef.current = socket;

      peerConnection.onicecandidate = (event) => {
        if (!event.candidate) return;
        const candidate = {
          type: 'candidate',
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
        };
        if (signalingReady && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify(candidate));
        } else {
          pendingCandidates.push(event.candidate);
        }
      };

      peerConnection.oniceconnectionstatechange = () => {
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
              socket.close();
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
        socket.send(JSON.stringify({ type: 'auth', role: 'client', token }));
        const offer = await peerConnection.createOffer({ iceRestart });
        await peerConnection.setLocalDescription(offer);
        const sdp = peerConnection.localDescription?.sdp;
        if (!sdp) throw new Error('Peer connection did not produce an SDP offer');
        socket.send(JSON.stringify({ type: 'offer', sdp }));
        signalingReady = true;
        for (const candidate of pendingCandidates.splice(0)) {
          socket.send(
            JSON.stringify({
              type: 'candidate',
              candidate: candidate.candidate,
              sdpMid: candidate.sdpMid,
              sdpMLineIndex: candidate.sdpMLineIndex,
            }),
          );
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
          await peerConnection.setRemoteDescription({ type: 'answer', sdp: message.sdp });
        } else if (message.type === 'candidate' && message.candidate !== undefined) {
          await peerConnection.addIceCandidate({
            candidate: message.candidate,
            sdpMid: message.sdpMid,
            sdpMLineIndex: message.sdpMLineIndex,
          });
        } else if (message.type === 'authenticated') {
          setConnectionStatus('signaling');
        }
      };

      socket.onerror = () => setConnectionStatus('signaling-error');
      socket.onclose = () => {
        if (!stopped) setConnectionStatus('signaling-disconnected');
      };
    };

    void connect();

    return () => {
      stopped = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      setDataChannel(null);
      setRemoteStream(null);
      peerConnectionRef.current?.close();
      wsRef.current?.close();
      peerConnectionRef.current = null;
      wsRef.current = null;
    };
  }, [sessionId, token, signalingUrl]);

  return {
    connectionStatus: hasActiveSession ? connectionStatus : 'idle',
    dataChannel: hasActiveSession ? dataChannel : null,
    remoteStream: hasActiveSession ? remoteStream : null,
    peerConnectionRef,
  };
}
