# MSD Local Camera Server

Bridges RTSP CCTVs into browser-playable WebRTC for the Cameras page, serves
dashboard snapshots, and runs CCTV-audio wake-word transcription with Whisper.

```
CCTV (RTSP) -> ffmpeg -> MediaMTX -> WebRTC http://<pc-ip>:8889/<cam>/whep
                               -> HLS fallback http://<pc-ip>:8888/<cam>/index.m3u8
                               -> JPEG /cameras/<id>/snapshot
                               -> PCM chunks -> faster-whisper -> /cameras/<id>/audio-events
```

## Folder structure

```
local-server/
├── camera_server.py      entry point (thin — just wiring + startup banner)
├── msds/
│   ├── config.py         ports, limits, distress keywords
│   ├── binaries.py       ffmpeg/ffprobe/mediamtx discovery (cached)
│   ├── whisper_engine.py one shared faster-whisper model
│   ├── camera.py         one independent pipeline per camera
│   ├── manager.py        registry, MediaMTX supervision, watchdog
│   └── api.py            FastAPI routes
├── bin/                  ffmpeg.exe / ffprobe.exe / mediamtx.exe (downloaded)
├── mediamtx.yml          MediaMTX config (RTSP :8554, HLS :8888, WebRTC :8889)
├── fetch_binaries.py     downloads the three binaries into bin/
├── get_binaries.bat      Windows wrapper for the above
├── setup_windows.bat     venv + pip install + binaries
├── start_server.bat      runs the server with the venv interpreter
└── requirements.txt
```

Binaries are **not** committed (size + licensing). `bin/` is populated by
`fetch_binaries.py`, and every module resolves them in this order:
`FFMPEG_EXE`/`FFPROBE_EXE`/`MEDIAMTX_EXE` env var → `bin/` → `local-server/` → PATH.

## Install (Windows — recommended)

```bat
setup_windows.bat     :: venv + Python deps + downloads ffmpeg/ffprobe/mediamtx
start_server.bat      :: runs .venv\Scripts\python.exe camera_server.py
```

## macOS / Linux

```bash
python3 -m venv .venv && source .venv/bin/activate
python -m pip install -r requirements.txt
python fetch_binaries.py
python camera_server.py
```

## Whisper / CCTV wake words

`faster-whisper` downloads its model on first use (`MSD_WHISPER_MODEL`,
default `small`, a multilingual model; use `base` or `tiny` for a smaller
download and lower CPU cost). Video keeps streaming when
audio is unavailable, and `/status` reports which failure mode you hit:

| `whisper_state`   | meaning                                                  |
| ----------------- | -------------------------------------------------------- |
| `package_missing` | faster-whisper is not installed in the running Python.    |
| `model_error`     | package present, but the model failed to download/load.   |
| `ready`           | transcription is running.                                 |

The bridge publishes only finalized original-language transcription. It
decodes each independent phrase after 600 ms of quiet or a six-second maximum
context window, without interim captions or translation. Capture runs
independently of inference, with at most four phrases queued. The bounded queue
reports skipped phrases in `dropped_caption_jobs` if the machine cannot keep
up. Rejected noise clears the current transcript without adding an event.

Final decoding starts with a five-beam search and retries repetitive or weak
output at modest temperatures. Silero voice detection, word timestamps,
silence-aware hallucination rejection, and acoustic-confidence checks reduce
phantom text. A highly compressed result with at least twelve words at more
than eight words per second is rejected as a decoder loop. Credible spoken
repetitions and ordinary phrases are retained, without distress-word prompts
or rewriting the speaker's words.

Background noise, accents, overlapping speakers, camera/network delay, and
CPU load still affect accuracy and latency; 100% transcription accuracy cannot
be guaranteed. The larger default model needs more memory and initialization
time than `base`. Check recognition using recordings from the actual camera.

Tune `MSD_AUDIO_SILENCE_SECONDS` (default `0.6`, range `0.2`–`1`) and
`MSD_AUDIO_CHUNK_SECONDS` (maximum final context, default `6`, range `1`–`15`).
`MSD_AUDIO_MIN_RMS` (default `0.001`) only gates very quiet PCM before Whisper
VAD; decrease it for a quiet camera microphone. `MSD_WHISPER_LANGUAGE` is unset
by default for multilingual English/Tagalog detection; set `en` or `tl` only
when that microphone uses one language. `MSD_WHISPER_CPU_THREADS` defaults to
`4`. GPU-equipped systems may set `MSD_WHISPER_DEVICE=cuda` and
`MSD_WHISPER_COMPUTE_TYPE=float16` when their faster-whisper CUDA runtime is
installed. Larger multilingual models can improve recognition at the cost of
more memory and decode time; benchmark with recordings from the actual camera.

`/cameras/<id>/audio-events` exposes `last_transcript`,
`last_transcription_at`, `transcription_mode: "final"`,
`caption_silence_seconds`, and `transcription_latency_ms`. The latter measures
queue plus inference time since the submitted audio boundary, not camera or
network delay. Legacy partial fields remain empty and `caption_update_seconds`
is zero. `MSD_AUDIO_CAPTION_UPDATE_SECONDS` no longer schedules drafts.
Restart the local camera service after changing these settings.
The decode parameters and direct PCM input follow the official
[faster-whisper transcription implementation](https://github.com/SYSTRAN/faster-whisper/blob/master/faster_whisper/transcribe.py).

## Environment variables

`MSD_API_PORT` (5000), `MSD_HLS_PORT` (8888), `MSD_RTSP_PORT` (8554), `MSD_WEBRTC_PORT` (8889),
`MSD_WHISPER_MODEL`, `FFMPEG_EXE`, `FFPROBE_EXE`, `MEDIAMTX_EXE`.

The live publisher normalizes video to baseline H264 with no B-frames or
encoder lookahead, a half-second keyframe interval, and Opus sound. It defaults
to at most 1280 pixels wide, 20 fps and two encoder threads per camera. Set
`MSD_VIDEO_MAX_WIDTH` (320–1920), `MSD_VIDEO_FPS` (5–30), or
`MSD_VIDEO_THREADS` (1–4) before starting the bridge to change these limits.
Lower width/fps if several cameras overload the bridge CPU. Port overrides
also need matching listeners in `mediamtx.yml` or the corresponding `MTX_*`
environment overrides.

## Live-video latency and LAN connections

The Cameras page prefers WebRTC/WHEP, avoiding an HLS segment buffer. The
bundled MediaMTX 1.21.1 configuration listens on HTTP/TCP 8889 for signaling
and UDP 8189 for media, with TCP 8189 as a connectivity fallback. Keep these
ports reachable from devices viewing cameras on the LAN. Interface discovery
advertises the computer's LAN IPs, and explicit `127.0.0.1`/`localhost`
candidates support the desktop app and local browser. Remote networks may
need an additional reachable host or a TURN server in `mediamtx.yml`.

HLS remains a fallback, with 500 ms segments and 100 ms parts. Steady live
video is configured to target less than one second of delay on a healthy LAN;
camera encoding, network congestion and CPU load can still add delay, and
initial connection/keyframe startup is separate. Restart the local camera
service after updating the publisher so existing camera processes use the
new codec settings.

These settings follow the official [MediaMTX WebRTC codec/connectivity
guide](https://mediamtx.org/docs/features/webrtc-specific-features) and
[MediaMTX HLS codec reference](https://mediamtx.org/docs/read/hls).

## Electron

`electron-builder.yml` ships `local-server/**` as an extra resource, so the
packaged desktop app carries the Python bridge, `mediamtx.yml` and whatever is
in `bin/` at build time. Run `python fetch_binaries.py` before
`npm run electron:build` if you want the binaries inside the installer.

## Connect from the dashboard

Open the dashboard on the same machine/Wi-Fi, press **Connect**, enter the
server URL (default `http://127.0.0.1:5000`) and start monitoring. Dashboard
cards fetch JPEG snapshots; live video and sound play inside the Cameras page.

- An HTTPS page cannot load a plain-HTTP local stream; use `http://` or the
  desktop app.
- From a phone use `http://<pc-lan-ip>:5000`; `/status` reports the LAN IP.
