import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openCameraWebRtc } from '@/lib/cameraWebRtc';
import { DEFAULT_SETTINGS, webrtcUrlFor, type CameraConfig } from '@/types/multicam';

type Track = { id: string; stop: ReturnType<typeof vi.fn> };
class FakeStream {
  tracks: Track[] = [];
  getTracks() { return this.tracks; }
  addTrack(track: Track) { this.tracks.push(track); }
}

const peers: FakePeer[] = [];
class FakePeer extends EventTarget {
  iceGatheringState = 'complete';
  connectionState = 'new';
  localDescription: RTCSessionDescriptionInit | null = null;
  ontrack: ((event: { track: Track }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  addTransceiver = vi.fn();
  createOffer = vi.fn().mockResolvedValue({ type: 'offer', sdp: 'camera offer' });
  setLocalDescription = vi.fn(async (offer: RTCSessionDescriptionInit) => { this.localDescription = offer; });
  setRemoteDescription = vi.fn().mockResolvedValue(undefined);
  close = vi.fn();
  constructor(readonly configuration: RTCConfiguration) { super(); peers.push(this); }
  state(value: string) { this.connectionState = value; this.onconnectionstatechange?.(); }
}

const endpoint = 'http://192.168.1.10:8889/cam1/whep';
const session = `${endpoint}/session`;
const clients: ReturnType<typeof openCameraWebRtc>[] = [];
const fetchMock = vi.fn();
const response = () => ({
  ok: true, status: 201, headers: new Headers({ Location: 'whep/session' }),
  text: vi.fn().mockResolvedValue('camera answer'),
}) as unknown as Response;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
function open() {
  const callbacks = { onStream: vi.fn(), onError: vi.fn() };
  const client = openCameraWebRtc(endpoint, callbacks);
  clients.push(client);
  return { client, callbacks, peer: peers[peers.length - 1] };
}
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  peers.length = 0;
  clients.length = 0;
  fetchMock.mockReset().mockImplementation(async () => response());
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('MediaStream', FakeStream);
  vi.stubGlobal('RTCPeerConnection', FakePeer);
});
afterEach(() => {
  clients.forEach(client => client.close());
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('camera WebRTC playback', () => {
  it('negotiates receive-only audio and video, combines tracks, and releases the session on close', async () => {
    const { client, callbacks, peer } = open();
    await flush();
    expect(peer.configuration).toEqual({ bundlePolicy: 'max-bundle' });
    expect(peer.addTransceiver.mock.calls).toEqual([
      ['video', { direction: 'recvonly' }], ['audio', { direction: 'recvonly' }],
    ]);
    expect(fetchMock).toHaveBeenCalledWith(endpoint, expect.objectContaining({
      method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: 'camera offer',
    }));
    expect(peer.setRemoteDescription).toHaveBeenCalledWith({ type: 'answer', sdp: 'camera answer' });
    const audio = { id: 'audio', stop: vi.fn() };
    const video = { id: 'video', stop: vi.fn() };
    peer.ontrack?.({ track: audio });
    peer.ontrack?.({ track: video });
    peer.ontrack?.({ track: video });
    const combined = callbacks.onStream.mock.calls[0][0] as FakeStream;
    expect(combined.getTracks()).toEqual([audio, video]);
    expect(callbacks.onStream.mock.calls.every(([stream]) => stream === combined)).toBe(true);

    const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    client.close();
    client.close();
    expect(signal.aborted).toBe(true);
    expect(peer.close).toHaveBeenCalledOnce();
    expect(audio.stop).toHaveBeenCalledOnce();
    expect(video.stop).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(session, { method: 'DELETE', keepalive: true });
    expect(callbacks.onError).not.toHaveBeenCalled();
  });

  it('reports a rejected SDP request and closes the peer', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, headers: new Headers() });
    const { callbacks, peer } = open();
    await flush();
    expect(callbacks.onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('503') }));
    expect(peer.close).toHaveBeenCalledOnce();
    expect(peer.setRemoteDescription).not.toHaveBeenCalled();
  });

  it('deletes a late server session after closing an in-flight request', async () => {
    const pending = deferred<Response>();
    fetchMock.mockImplementation((_url, init) => init.method === 'POST' ? pending.promise : Promise.resolve(response()));
    const { client, callbacks, peer } = open();
    await flush();
    client.close();
    expect((fetchMock.mock.calls[0][1].signal as AbortSignal).aborted).toBe(true);
    pending.resolve(response());
    await flush();
    expect(fetchMock).toHaveBeenCalledWith(session, { method: 'DELETE', keepalive: true });
    expect(peer.setRemoteDescription).not.toHaveBeenCalled();
    expect(callbacks.onError).not.toHaveBeenCalled();
  });

  it('discards an SDP answer that completes after the view closes', async () => {
    const answer = deferred<string>();
    fetchMock.mockResolvedValue({ ...response(), text: () => answer.promise });
    const { client, callbacks, peer } = open();
    await flush();
    client.close();
    answer.resolve('late answer');
    await flush();
    expect(peer.setRemoteDescription).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.filter(([, init]) => init.method === 'DELETE')).toHaveLength(1);
    expect(callbacks.onError).not.toHaveBeenCalled();
  });

  it('allows a short reconnect and closes an interrupted connection after the grace period', async () => {
    const { callbacks, peer } = open();
    await flush();
    peer.state('disconnected');
    await vi.advanceTimersByTimeAsync(2000);
    peer.state('connected');
    await vi.advanceTimersByTimeAsync(1000);
    expect(callbacks.onError).not.toHaveBeenCalled();
    peer.state('disconnected');
    await vi.advanceTimersByTimeAsync(2500);
    expect(callbacks.onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('interrupted') }));
    expect(peer.close).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(session, { method: 'DELETE', keepalive: true });
  });
});

describe('camera WebRTC endpoint', () => {
  const camera = { path: '/front/', streamUrl: '' } as CameraConfig;
  it('prefers reported WebRTC metadata', () => {
    expect(webrtcUrlFor({ ...camera, webrtcUrl: ' https://cameras.example/front/whep?token=abc ' }, DEFAULT_SETTINGS))
      .toBe('https://cameras.example/front/whep?token=abc');
  });
  it('uses the configured WebRTC host', () => {
    expect(webrtcUrlFor(camera, { ...DEFAULT_SETTINGS, webrtcHost: 'https://cameras.example:8443/relay/' }))
      .toBe('https://cameras.example:8443/relay/front/whep');
  });
  it('uses port 8889 on the authoritative camera host or the default server', () => {
    expect(webrtcUrlFor({ ...camera, streamUrl: 'http://192.168.1.20:8888/front/index.m3u8?token=abc' }, DEFAULT_SETTINGS))
      .toBe('http://192.168.1.20:8889/front/whep');
    expect(webrtcUrlFor(camera, DEFAULT_SETTINGS)).toBe('http://127.0.0.1:8889/front/whep');
  });
});
