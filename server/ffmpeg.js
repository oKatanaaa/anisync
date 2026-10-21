import { spawn } from 'node:child_process';

/**
 * Run a process and collect its output. Deliberately shell-free: every argument
 * is passed as an array element so filenames with quotes or spaces can never be
 * reinterpreted as syntax.
 *
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
export function run(cmd, args, { onStdout, signal, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], signal, cwd });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      onStdout?.(text);
      if (stdout.length > 4_000_000) stdout = stdout.slice(-2_000_000);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 40_000) stderr = stderr.slice(-20_000);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
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
