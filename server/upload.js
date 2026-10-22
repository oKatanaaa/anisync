import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import busboy from 'busboy';

const destinations = new Set();
const uploadError = (message, status = 400) => Object.assign(new Error(message), { status });

/** Publish only after both the multipart request and its file have finished. */
export async function receiveUpload(req, { mediaDir, maxUploadBytes, activeUploads }) {
  let bus;
  try {
    bus = busboy({ headers: req.headers, limits: { files: 1, fileSize: maxUploadBytes } });
  } catch {
    throw uploadError('expected multipart upload');
  }

  let destination;
  let destinationKey;
  let temp;
  let output;
  let failure;
  let received = 0;
  let writeDone = Promise.resolve();
  const stop = (err) => {
    failure ||= err;
    bus.destroy(err);
  };
  const aborted = () => stop(uploadError('upload aborted'));
  const closed = () => { if (!req.complete) aborted(); };
  req.on('aborted', aborted);
  req.on('close', closed);
  req.on('error', stop);

  const parsed = new Promise((resolve, reject) => {
    bus.once('close', resolve);
    bus.once('error', reject);
  });
  bus.on('filesLimit', () => { failure ||= uploadError('only one file per upload'); });
  bus.on('file', (_field, file, info) => {
    const safe = path.basename(info.filename || '').replace(/[^\w.\- ()[\]]+/g, '_').slice(0, 180);
    if (!/\.(mkv|mp4|webm|avi|mov|m4v|ts|m2ts|m4a|aac|opus|flac|mp3|ogg|wav|ass|ssa|srt|vtt)$/i.test(safe)) {
      failure = uploadError('unsupported file type');
      file.resume();
      return;
    }
    const dest = path.join(mediaDir, safe);
    const key = process.platform === 'win32' ? dest.toLowerCase() : dest;
    if (destinations.has(key)) {
      failure = uploadError('another upload with that name is in progress — try again when it finishes', 409);
      file.resume();
      return;
    }
    destinations.add(key);
    destinationKey = key;
    destination = dest;
    temp = `${dest}.${crypto.randomUUID()}.part`;
    activeUploads.add(path.basename(temp));
    output = fs.createWriteStream(temp, { flags: 'wx' });
    file.on('data', (chunk) => { received += chunk.length; });
    file.on('limit', () => { failure ||= uploadError('file too large', 413); });
    writeDone = pipeline(file, output).catch((err) => {
      stop(failure || uploadError(`could not receive upload: ${err.message}`));
    });
  });

  try {
    req.pipe(bus);
    await parsed;
    await writeDone;
    if (failure) throw failure;
    if (!destination) throw uploadError('no file received');
    try {
      await fsp.rename(temp, destination);
    } catch (err) {
      throw uploadError(`could not save upload: ${err.message}`, 500);
    }
    return { savedPath: destination, received };
  } catch (err) {
    throw failure || (err.status ? err : uploadError(`invalid upload: ${err.message}`));
  } finally {
    req.unpipe(bus);
    bus.destroy();
    output?.destroy();
    await writeDone;
    if (temp) {
      await fsp.rm(temp, { force: true }).catch(() => {});
      activeUploads.delete(path.basename(temp));
    }
    if (destinationKey) destinations.delete(destinationKey);
    req.removeListener('aborted', aborted);
    req.removeListener('close', closed);
    req.removeListener('error', stop);
    // Drain malformed bodies so an HTTP error can still reach the browser.
    req.resume();
  }
}
