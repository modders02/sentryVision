/**
 * MSDS Electron — packaged local service supervisor (Windows-first).
 *
 * Starts the existing Python bridge (local-server/camera_server.py) which in
 * turn supervises MediaMTX + per-camera FFmpeg processes (msds/manager.py).
 * We deliberately never spawn ffmpeg/mediamtx ourselves — that would create
 * duplicate services fighting over ports 8554/8888.
 *
 * Packaged layout (electron-builder.yml extraResources):
 *   <resources>/local-server/camera_server.py
 *   <resources>/local-server/bin/{ffmpeg,ffprobe,mediamtx}.exe
 *   <resources>/local-server/mediamtx.yml
 *
 * Binary discovery in msds/binaries.py resolves <local-server>/bin relative to
 * the script location, so simply running camera_server.py from that directory
 * is enough. We additionally pin FFMPEG_EXE/FFPROBE_EXE/MEDIAMTX_EXE when the
 * files exist, which makes resolution deterministic in a packaged install.
 */
const { app } = require('electron');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const http = require('http');

const IS_WINDOWS = process.platform === 'win32';
const STATUS_URL = process.env.MSDS_CAMERA_SERVER_URL || 'http://127.0.0.1:5000';

/** @type {import('child_process').ChildProcess | null} */
let child = null;
let stopping = false;

/**
 * First-run bootstrap progress, surfaced to the renderer through main.cjs.
 * phase: idle | venv | deps | binaries | starting | ready | error | skipped
 */
let bootstrap = { phase: 'idle', message: '', firstRun: false };
const setPhase = (phase, message) => {
  bootstrap = { ...bootstrap, phase, message };
  log(`[${phase}] ${message}`);
};

const log = (...args) => console.log('[msds:local-server]', ...args);
const logErr = (...args) => console.error('[msds:local-server]', ...args);


/** Resolve the packaged (or repo) local-server directory. */
function localServerDir() {
  const candidates = [
    process.env.MSDS_LOCAL_SERVER_DIR,
    app.isPackaged ? path.join(process.resourcesPath, 'local-server') : null,
    path.join(__dirname, '..', 'local-server'),
  ].filter(Boolean);
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'camera_server.py'))) return dir;
  }
  return null;
}

/** Find a usable Python interpreter, preferring a bundled venv on Windows. */
function resolvePython(dir) {
  const candidates = [];
  if (process.env.MSDS_PYTHON_EXE) candidates.push(process.env.MSDS_PYTHON_EXE);
  // Bundled/packaged virtualenv shipped alongside the bridge, if present.
  candidates.push(
    IS_WINDOWS
      ? path.join(dir, '.venv', 'Scripts', 'python.exe')
      : path.join(dir, '.venv', 'bin', 'python')
  );
  for (const cand of candidates) {
    if (cand && fs.existsSync(cand)) return { exe: cand, args: [] };
  }
  // Fall back to a system interpreter on PATH.
  const probes = IS_WINDOWS
    ? [{ exe: 'py', args: ['-3'] }, { exe: 'python', args: [] }]
    : [{ exe: 'python3', args: [] }, { exe: 'python', args: [] }];
  for (const probe of probes) {
    try {
      const res = spawnSync(probe.exe, [...probe.args, '--version'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      if (res.status === 0) return probe;
    } catch { /* keep probing */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// First-run bootstrap: virtualenv -> pip install -r requirements.txt -> binaries
// ---------------------------------------------------------------------------

const venvPython = (dir) =>
  IS_WINDOWS ? path.join(dir, '.venv', 'Scripts', 'python.exe') : path.join(dir, '.venv', 'bin', 'python');

/** Find any interpreter on PATH that can create a virtualenv. */
function systemPython() {
  const probes = IS_WINDOWS
    ? [{ exe: 'py', args: ['-3'] }, { exe: 'python', args: [] }]
    : [{ exe: 'python3', args: [] }, { exe: 'python', args: [] }];
  for (const probe of probes) {
    try {
      const res = spawnSync(probe.exe, [...probe.args, '--version'], { stdio: 'ignore', windowsHide: true });
      if (res.status === 0) return probe;
    } catch { /* keep probing */ }
  }
  return null;
}

/** Run a command synchronously, streaming output to the Electron console. */
function run(exe, args, opts, timeoutMs = 15 * 60 * 1000) {
  const res = spawnSync(exe, args, {
    stdio: 'inherit',
    windowsHide: true,
    timeout: timeoutMs,
    ...opts,
  });
  return res.status === 0;
}

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

/**
 * Make sure the bridge can actually run: a virtualenv exists, requirements are
 * installed (faster-whisper included) and ffmpeg/ffprobe/mediamtx are present.
 *
 * Everything is idempotent and guarded by a marker file, so only the very first
 * launch pays the download cost. Failures are non-fatal: we still try to start
 * the bridge with whatever is available and report the problem.
 */
function bootstrapEnvironment(dir) {
  if (process.env.MSDS_SKIP_BOOTSTRAP === '1') {
    bootstrap = { phase: 'skipped', message: 'MSDS_SKIP_BOOTSTRAP=1', firstRun: false };
    return { ok: true, error: null };
  }

  const reqFile = path.join(dir, 'requirements.txt');
  const hasReq = fs.existsSync(reqFile);
  const marker = path.join(dir, '.venv', '.msds-deps');
  const wanted = hasReq ? sha1(fs.readFileSync(reqFile, 'utf8')) : 'none';

  let py = venvPython(dir);
  const hadVenv = fs.existsSync(py);
  bootstrap.firstRun = !hadVenv;

  // 1) virtualenv
  if (!hadVenv && !process.env.MSDS_PYTHON_EXE) {
    const sys = systemPython();
    if (!sys) {
      const error = 'Python 3.10+ was not found. Install it from python.org (tick "Add python.exe to PATH") and restart the app.';
      bootstrap = { phase: 'error', message: error, firstRun: true };
      return { ok: false, error };
    }
    setPhase('venv', 'Creating the Python environment (first run, one time only)…');
    if (!run(sys.exe, [...sys.args, '-m', 'venv', '.venv'], { cwd: dir }, 5 * 60 * 1000)) {
      logErr('venv creation failed — falling back to the system interpreter.');
    }
  }

  const useVenv = fs.existsSync(venvPython(dir));
  py = useVenv ? venvPython(dir) : null;
  const sys = py ? null : systemPython();
  if (!py && !sys) {
    const error = 'No usable Python interpreter found for dependency installation.';
    bootstrap = { phase: 'error', message: error, firstRun: bootstrap.firstRun };
    return { ok: false, error };
  }
  const pyExe = py ?? sys.exe;
  const pyArgs = py ? [] : sys.args;

  // 2) python dependencies (fastapi, uvicorn, faster-whisper, …)
  let installed = false;
  try { installed = fs.readFileSync(marker, 'utf8').trim() === wanted; } catch { installed = false; }
  if (!installed && hasReq) {
    setPhase('deps', 'Installing camera + Whisper dependencies (first run, this can take a few minutes)…');
    run(pyExe, [...pyArgs, '-m', 'pip', 'install', '--upgrade', 'pip'], { cwd: dir }, 5 * 60 * 1000);
    const ok = run(pyExe, [...pyArgs, '-m', 'pip', 'install', '-r', 'requirements.txt'], { cwd: dir });
    if (ok) {
      try {
        fs.mkdirSync(path.dirname(marker), { recursive: true });
        fs.writeFileSync(marker, wanted);
      } catch { /* marker is an optimisation only */ }
    } else {
      logErr('pip install failed — CCTV audio (Whisper) may be unavailable.');
    }
  }

  // 3) ffmpeg / ffprobe / mediamtx
  const ext = IS_WINDOWS ? '.exe' : '';
  const needBinaries = ['ffmpeg', 'ffprobe', 'mediamtx']
    .some((n) => !fs.existsSync(path.join(dir, 'bin', n + ext)));
  if (needBinaries && fs.existsSync(path.join(dir, 'fetch_binaries.py'))) {
    setPhase('binaries', 'Downloading FFmpeg and MediaMTX…');
    if (!run(pyExe, [...pyArgs, 'fetch_binaries.py'], { cwd: dir }, 10 * 60 * 1000)) {
      logErr('binary download failed — place ffmpeg/ffprobe/mediamtx in local-server/bin manually.');
    }
  }

  setPhase('starting', 'Starting the local camera bridge…');
  return { ok: true, error: null };
}

/** Current bootstrap phase (for the renderer). */
const getBootstrapStatus = () => ({ ...bootstrap });


/** Env for the child: pin the packaged binaries when they exist. */
function childEnv(dir) {
  const env = { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' };
  const bin = path.join(dir, 'bin');
  const ext = IS_WINDOWS ? '.exe' : '';
  for (const [name, key] of [
    ['ffmpeg', 'FFMPEG_EXE'],
    ['ffprobe', 'FFPROBE_EXE'],
    ['mediamtx', 'MEDIAMTX_EXE'],
  ]) {
    const p = path.join(bin, name + ext);
    if (fs.existsSync(p)) env[key] = p;
  }
  // Prefer a manually downloaded local faster-whisper model when present.
  // This avoids first-run Hugging Face downloads on machines that already have
  // local-server/models/faster-whisper-small populated.
  const localWhisperModel = path.join(dir, 'models', 'faster-whisper-small');
  if (!env.MSD_WHISPER_MODEL && fs.existsSync(path.join(localWhisperModel, 'model.bin'))) {
    env.MSD_WHISPER_MODEL = localWhisperModel;
  }

  // Stable CPU defaults for live CCTV transcription. Every value remains
  // overrideable through the environment for faster/slower machines.
  if (!env.MSD_WHISPER_DEVICE) env.MSD_WHISPER_DEVICE = 'cpu';
  if (!env.MSD_WHISPER_COMPUTE_TYPE) env.MSD_WHISPER_COMPUTE_TYPE = 'int8';
  if (!env.MSD_WHISPER_CPU_THREADS) env.MSD_WHISPER_CPU_THREADS = '4';
  if (!env.MSD_AUDIO_MIN_RMS) env.MSD_AUDIO_MIN_RMS = '0.0005';
  if (!env.MSD_AUDIO_SILENCE_SECONDS) env.MSD_AUDIO_SILENCE_SECONDS = '0.6';
  if (!env.MSD_AUDIO_CHUNK_SECONDS) env.MSD_AUDIO_CHUNK_SECONDS = '6';

  return env;
}

/** Single GET /status probe. Resolves true when the bridge answers. */
function probeStatus(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(`${STATUS_URL}/status`, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode !== undefined && res.statusCode < 500);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

/** Poll /status until ready or the budget expires. Never blocks forever. */
async function waitForReady(totalMs = 30000, intervalMs = 1000) {
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    if (await probeStatus()) return true;
    if (child && child.exitCode !== null) return false; // died early
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/**
 * Should Electron own the local server?
 *  - packaged builds: yes
 *  - development: only with MSDS_MANAGE_LOCAL_SERVER=1 (so a dev running
 *    local:dev / start_server.bat manually never gets a second instance)
 */
function shouldManage() {
  // Auto-manage the local camera stack in BOTH development and packaged builds.
  // The startup path probes /status first, so an already-running manual bridge
  // is reused instead of creating a duplicate instance.
  //
  // Set MSDS_MANAGE_LOCAL_SERVER=0 only when you explicitly want to run
  // local-server\\start_server.bat yourself.
  if (process.env.MSDS_MANAGE_LOCAL_SERVER === '0') return false;
  return true;
}

/**
 * Start the bridge if needed. Returns a status object; never throws.
 * @returns {Promise<{managed:boolean, running:boolean, error:string|null, pythonPath?:string, dir?:string}>}
 */
async function startLocalServer() {
  if (!shouldManage()) {
    log('not managed (development). Set MSDS_MANAGE_LOCAL_SERVER=1 to enable.');
    return { managed: false, running: await probeStatus(), error: null };
  }

  // Someone else (manual run, previous instance) already owns port 5000.
  if (await probeStatus()) {
    log('an instance is already listening on', STATUS_URL, '- reusing it.');
    return { managed: false, running: true, error: null };
  }

  const dir = localServerDir();
  if (!dir) {
    const error = 'local-server/camera_server.py not found (checked resourcesPath and repo).';
    logErr(error);
    return { managed: true, running: false, error };
  }

  // First run: build the venv, install requirements, fetch ffmpeg/mediamtx.
  const boot = bootstrapEnvironment(dir);
  if (!boot.ok) {
    logErr(boot.error);
    return { managed: true, running: false, error: boot.error, dir, bootstrap: getBootstrapStatus() };
  }

  const python = resolvePython(dir);
  if (!python) {
    const error =
      'No Python interpreter found. Install Python 3.10+ or set MSDS_PYTHON_EXE to python.exe.';
    logErr(error);
    return { managed: true, running: false, error, dir, bootstrap: getBootstrapStatus() };
  }


  log('dir     :', dir);
  log('python  :', python.exe, python.args.join(' '));

  try {
    child = spawn(python.exe, [...python.args, 'camera_server.py'], {
      cwd: dir,                 // binaries.py resolves bin/ relative to this
      env: childEnv(dir),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });
  } catch (exc) {
    const error = `Failed to spawn Python: ${exc.message}`;
    logErr(error);
    return { managed: true, running: false, error, dir };
  }

  child.stdout.on('data', (b) => process.stdout.write(`[local-server] ${b}`));
  child.stderr.on('data', (b) => process.stderr.write(`[local-server] ${b}`));
  child.on('exit', (code, signal) => {
    if (!stopping) logErr(`exited unexpectedly (code=${code} signal=${signal})`);
    child = null;
  });

  const ready = await waitForReady();
  if (ready) {
    setPhase('ready', `ready at ${STATUS_URL}`);
    return { managed: true, running: true, error: null, pythonPath: python.exe, dir, bootstrap: getBootstrapStatus() };
  }

  const error =
    'Local camera server did not answer /status within 30s. The app will open, but CCTV ' +
    'streaming/Whisper will be unavailable until it starts. Check the log above, or run ' +
    'local-server\\start_server.bat manually.';
  logErr(error);
  bootstrap = { ...bootstrap, phase: 'error', message: error };
  return { managed: true, running: false, error, pythonPath: python.exe, dir, bootstrap: getBootstrapStatus() };
}


/**
 * Kill the bridge and every descendant (MediaMTX, ffmpeg).
 * Windows: taskkill /T /F is the only reliable tree kill.
 */
function stopLocalServer() {
  if (!child || child.exitCode !== null) { child = null; return; }
  stopping = true;
  const pid = child.pid;
  log('stopping local server (pid', pid, ')');
  try {
    if (IS_WINDOWS) {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } else {
      try { process.kill(-pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
      setTimeout(() => { try { child && child.kill('SIGKILL'); } catch { /* gone */ } }, 3000);
    }
  } catch (exc) {
    logErr('stop failed (process may already be gone):', exc.message);
  }
  child = null;
}

module.exports = { startLocalServer, stopLocalServer, probeStatus, shouldManage, getBootstrapStatus };
