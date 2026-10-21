import path from 'node:path';
import { languageCode, languageName, TRACK_FLAGS } from './languages.js';

/**
 * External tracks: plenty of releases ship the subtitle or dub as a separate
 * file next to the episode instead of muxed into the container.
 *
 *     Episode 01.mkv
 *     Episode 01.en.ass          <- dialogue
 *     Episode 01.en.forced.ass   <- signs
 *     Episode 01.eng.m4a         <- English dub
 *
 * Matching is deliberately conservative: the sidecar must share the episode's
 * full stem (so `Episode 011.en.ass` never attaches to `Episode 01`), the
 * extension has to be one we can actually use, and the leftover tokens are
 * parsed for a language tag and a handful of well-known flags.
 */

const SUB_EXT = new Set(['.ass', '.ssa', '.srt', '.vtt']);
// Image-based subtitles cannot become text, so they are not offered.
const BITMAP_SUB_EXT = new Set(['.sup', '.sub']);
const AUDIO_EXT = new Set(['.m4a', '.aac', '.opus', '.flac', '.mp3', '.ogg', '.oga', '.wav', '.eac3', '.ac3', '.dts', '.mka']);

const stripExt = (name) => name.slice(0, name.length - path.extname(name).length);

/**
 * Parse `en.forced` style leftovers into a language and a human label.
 * @returns {{lang: string, label: string, flags: string[]}}
 */
export function parseTrackTokens(rest) {
  const tokens = rest ? rest.split('.').filter(Boolean) : [];
  const flags = [];
  let code = '';
  let name = '';

  for (const token of tokens) {
    const key = token.toLowerCase();
    const flag = TRACK_FLAGS[key];
    if (flag) {
      flags.push(flag);
      continue;
    }
    if (!code) {
      const candidate = languageCode(token);
      if (candidate) {
        code = candidate;
        name = languageName(token);
        continue;
      }
    }
    // Anything else is a free-form label word ("director", "v2", "web").
    flags.push(token);
  }

  const pretty = name || flags.join(' ');
  const suffix = name ? flags.filter(Boolean).join(' · ') : '';
  return { lang: code, label: [pretty, suffix].filter(Boolean).join(' · ') || 'External track', flags };
}

/**
 * @param {string} videoName file name of the episode, e.g. "Episode 01.mkv"
 * @param {string[]} names every file name in the same directory
 * @returns {{subs: object[], audios: object[]}} matches, sorted by label
 */
export function findSidecars(videoName, names) {
  const stem = stripExt(videoName);
  const subs = [];
  const audios = [];

  for (const name of names) {
    if (name === videoName) continue;
    const ext = path.extname(name).toLowerCase();
    const isSub = SUB_EXT.has(ext) || BITMAP_SUB_EXT.has(ext);
    const isAudio = AUDIO_EXT.has(ext);
    if (!isSub && !isAudio) continue;

    const base = stripExt(name);
    // Must be "stem" or "stem.<something>" — never a different episode.
    if (base !== stem && !base.startsWith(`${stem}.`)) continue;
    const rest = base === stem ? '' : base.slice(stem.length + 1);

    const { lang, label, flags } = parseTrackTokens(rest);
    const entry = {
      name,
      ext,
      lang,
      label,
      flags,
      forced: flags.includes('Forced'),
    };

    if (isSub) {
      if (BITMAP_SUB_EXT.has(ext)) continue; // image-based: nothing to render as text
      subs.push({ ...entry, kind: 'sub' });
    } else {
      audios.push({ ...entry, kind: 'audio' });
    }
  }

  const byLabel = (a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
  return { subs: subs.sort(byLabel), audios: audios.sort(byLabel) };
}
