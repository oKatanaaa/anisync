import { spawn } from 'node:child_process';

/** Every live child, so a shutdown never leaves an encoder running. */
const children = new Set();

/**
 * Run a process and collect its output. Deliberately shell-free: every argument
 * is passed as an array element so filenames with quotes or spaces can never be
 * reinterpreted as syntax.
 *
 * `stallMs` is the watchdog: if the child produces no output at all for that
 * long it is terminated. A hung ffmpeg otherwise blocks the single-slot encode
 * queue for the rest of the process's life.
 *
 * @returns {Promise<{code:number, stdout:string, stderr:string, killedBy:string|null}>}
 */
export function run(cmd, args, { onStdout, signal, cwd, stallMs = 0, maxRuntimeMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], signal, cwd });
    } catch (err) {
      return reject(err);
    }
    children.add(child);

    let stdout = '';
    let stderr = '';
    let killedBy = null;
    let lastOutput = Date.now();
    let watchdog = null;
    let hardKill = null;

    const stop = (reason) => {
      if (killedBy) return;
      killedBy = reason;
      child.kill('SIGTERM');
      // A process that already ignores output may also ignore SIGTERM.
      hardKill = setTimeout(() => child.kill('SIGKILL'), 3000);
      hardKill.unref?.();
    };

    if (stallMs || maxRuntimeMs) {
      const started = Date.now();
      watchdog = setInterval(() => {
        const now = Date.now();
        if (stallMs && now - lastOutput > stallMs) stop(`no output for ${Math.round((now - lastOutput) / 1000)}s`);
        else if (maxRuntimeMs && now - started > maxRuntimeMs) stop('time limit');
      }, 1000);
      watchdog.unref?.();
    }

    child.stdout.on('data', (chunk) => {
      lastOutput = Date.now();
      const text = chunk.toString();
      stdout += text;
      onStdout?.(text);
      if (stdout.length > 4_000_000) stdout = stdout.slice(-2_000_000);
    });
    child.stderr.on('data', (chunk) => {
      lastOutput = Date.now();
      stderr += chunk.toString();
      if (stderr.length > 40_000) stderr = stderr.slice(-20_000);
    });
    child.on('error', (err) => {
      cleanup();
      reject(err);
    });
    child.on('close', (code) => {
      cleanup();
      if (killedBy) stderr += `\n[killed: ${killedBy}]`;
      resolve({ code: code ?? -1, stdout, stderr, killedBy });
    });

    function cleanup() {
      children.delete(child);
      if (watchdog) clearInterval(watchdog);
      if (hardKill) clearTimeout(hardKill);
    }
  });
}

/** Terminate every running child; used on shutdown so restarts cannot orphan an encode. */
export function killAll() {
  for (const child of children) {
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
  children.clear();
}

/** How many children are alive — used by tests and the health endpoint. */
export function runningChildren() {
  return children.size;
}

export async function ffprobeJson(file) {
  const { code, stdout, stderr } = await run('ffprobe', [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    file,
  ]);
  if (code !== 0) throw new Error(`ffprobe failed: ${stderr.slice(0, 400)}`);
  return JSON.parse(stdout);
}

let encoderPromise = null;

/**
 * Pick a video encoder once per process. Hardware encoders are probed with a
 * throwaway frame instead of being assumed, because a present `/dev/dri` does
 * not mean the current user can actually open it.
 */
export function detectEncoder(preference = 'auto') {
  if (!encoderPromise) {
    encoderPromise = (async () => {
      if (preference !== 'auto') return preference;
      const probe = await run('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'testsrc=size=256x144:rate=10',
        '-t', '0.4', '-c:v', 'h264_nvenc', '-f', 'null', '-',
      ]);
      return probe.code === 0 ? 'nvenc' : 'x264';
    })();
  }
  return encoderPromise;
}

export function encoderArgs(encoder, { crf }) {
  if (encoder === 'nvenc') {
    return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'hq', '-rc', 'vbr', '-cq', String(crf), '-b:v', '0'];
  }
  if (encoder === 'vaapi') {
    return ['-c:v', 'h264_vaapi', '-qp', String(crf)];
  }
  return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), '-profile:v', 'high'];
}

/**
 * ffmpeg writes machine-readable progress when asked; parse the subset we need.
 * @param {string} chunk raw `-progress pipe:1` text
 */
export function parseProgress(chunk) {
  const out = {};
  for (const line of chunk.split('\n')) {
    const [key, value] = line.split('=');
    if (!key || value === undefined) continue;
    if (key === 'out_time_us' || key === 'out_time_ms') out.timeUs = Number(value);
    if (key === 'progress') out.done = value.trim() === 'end';
  }
  if (Number.isFinite(out.timeUs) && out.timeUs > 0) out.seconds = out.timeUs / 1_000_000;
  return out;
}
