export interface CameraWebRtcCallbacks {
  onStream: (stream: MediaStream) => void;
  onError: (error: Error) => void;
}

/** Read a MediaMTX WHEP stream directly, without a segmented video buffer. */
export function openCameraWebRtc(url: string, callbacks: CameraWebRtcCallbacks): { close: () => void } {
  const peer = new RTCPeerConnection({ bundlePolicy: 'max-bundle' });
  const controller = new AbortController();
  let closed = false;
  let failed = false;
  let sessionUrl: string | null = null;
  let disconnectTimer: ReturnType<typeof setTimeout> | undefined;
  const tracks = new MediaStream();
  const deleteSession = () => {
    const target = sessionUrl;
    sessionUrl = null;
    if (target) void fetch(target, { method: 'DELETE', keepalive: true }).catch(() => {});
  };
  const close = () => {
    if (closed) return;
    closed = true;
    controller.abort();
    clearTimeout(disconnectTimer);
    peer.ontrack = null;
    peer.onconnectionstatechange = null;
    peer.close();
    tracks.getTracks().forEach(track => track.stop());
    deleteSession();
  };
  const fail = (error: unknown) => {
    if (closed || failed) return;
    failed = true;
    close();
    callbacks.onError(error instanceof Error ? error : new Error('Realtime camera connection failed.'));
  };
  peer.addTransceiver('video', { direction: 'recvonly' });
  peer.addTransceiver('audio', { direction: 'recvonly' });
  peer.ontrack = event => {
    if (closed) return;
    // Use one stable stream for both tracks, including servers without msid.
    if (!tracks.getTracks().some(track => track.id === event.track.id)) tracks.addTrack(event.track);
    callbacks.onStream(tracks);
  };
  peer.onconnectionstatechange = () => {
    clearTimeout(disconnectTimer);
    if (peer.connectionState === 'failed') fail(new Error('Realtime camera connection failed.'));
    else if (peer.connectionState === 'disconnected') {
      disconnectTimer = setTimeout(() => fail(new Error('Realtime camera connection was interrupted.')), 2500);
    }
  };

  void (async () => {
    try {
      await peer.setLocalDescription(await peer.createOffer());
      if (closed) return;
      // Submit gathered host candidates in the offer. LAN playback needs no
      // external STUN service or continuous trickle-ICE HTTP requests.
      if (peer.iceGatheringState !== 'complete') {
        await new Promise<void>((resolve, reject) => {
          const finish = () => {
            clearTimeout(timer);
            peer.removeEventListener('icegatheringstatechange', gathered);
            controller.signal.removeEventListener('abort', aborted);
          };
          const gathered = () => {
            if (peer.iceGatheringState === 'complete') { finish(); resolve(); }
          };
          const aborted = () => { finish(); reject(new DOMException('Camera closed.', 'AbortError')); };
          const timer = setTimeout(() => { finish(); resolve(); }, 1500);
          peer.addEventListener('icegatheringstatechange', gathered);
          controller.signal.addEventListener('abort', aborted, { once: true });
          gathered();
          if (controller.signal.aborted) aborted();
        });
      }
      if (closed) return;
      const sdp = peer.localDescription?.sdp;
      if (!sdp) throw new Error('Unable to prepare realtime camera playback.');
      const timeout = setTimeout(() => controller.abort(), 8000);
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST', headers: { 'Content-Type': 'application/sdp' },
          body: sdp, signal: controller.signal,
        });
      } finally { clearTimeout(timeout); }
      if (!response.ok) throw new Error(`Realtime camera unavailable (HTTP ${response.status}).`);
      const location = response.headers.get('Location');
      if (location) {
        const resource = new URL(location, url);
        if (resource.origin !== new URL(url).origin) throw new Error('Camera returned an invalid playback session.');
        sessionUrl = resource.href;
      }
      if (closed) { deleteSession(); return; }
      const answer = await response.text();
      if (closed) { deleteSession(); return; }
      await peer.setRemoteDescription({ type: 'answer', sdp: answer });
    } catch (error) { fail(error); }
  })();
  return { close };
}
