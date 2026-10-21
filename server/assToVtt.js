/**
 * ASS → WebVTT, keeping what a browser can actually honour.
 *
 * ffmpeg's own `-c:s webvtt` throws away every override tag, so a sign drawn at
 * the top of the frame ends up as bottom-centred dialogue. This keeps
 * alignment, position, italics/bold/underline and line breaks, and drops the
 * rest (karaoke sweeps, fades, vector drawings) because WebVTT has no way to
 * express them.
 *
 * Only used for the soft/switchable subtitle tracks; the burned-in rendition
 * still goes through libass and keeps everything.
 */

const TIME = /^(\d+):(\d{2}):(\d{2})[.,](\d{1,3})$/;

function toVttTime(stamp) {
  const m = TIME.exec(stamp.trim());
  if (!m) return null;
  const [, h, min, s, frac] = m;
  return `${h.padStart(2, '0')}:${min}:${s}.${frac.padEnd(3, '0').slice(0, 3)}`;
}

function parseFormat(line) {
  return line
    .replace(/^Format:\s*/i, '')
    .split(',')
    .map((name) => name.trim().toLowerCase());
}

/** Escape text so it cannot be mistaken for markup, then re-apply safe tags. */
const escapeText = (text) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const NUMERIC_ALIGN = {
  1: { line: null, align: 'start' },
  2: { line: null, align: 'center' },
  3: { line: null, align: 'end' },
  4: { line: '50%', align: 'start' },
  5: { line: '50%', align: 'center' },
  6: { line: '50%', align: 'end' },
  7: { line: '8%', align: 'start' },
  8: { line: '8%', align: 'center' },
  9: { line: '8%', align: 'end' },
};

/**
 * @param {string} ass contents of a .ass file
 * @param {{width?: number, height?: number}} [video] used to turn absolute
 *   \pos coordinates into percentages
 * @returns {string} a WebVTT document
 */
export function assToVtt(ass, { width = 1280, height = 720 } = {}) {
  const lines = ass.split(/\r?\n/);
  let section = '';
  let styleFields = [];
  let eventFields = [];
  let playResX = width;
  let playResY = height;
  const styles = new Map();
  const cues = [];

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line) continue;

    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      section = header[1].toLowerCase();
      continue;
    }

    if (section === 'script info') {
      const info = /^(PlayResX|PlayResY):\s*(\d+)/i.exec(line);
      if (info) {
        if (info[1].toLowerCase() === 'playresx') playResX = Number(info[2]) || playResX;
        else playResY = Number(info[2]) || playResY;
      }
      continue;
    }

    if (section.startsWith('v4') && line.startsWith('Format:')) {
      styleFields = parseFormat(line);
      continue;
    }

    if (section.startsWith('v4') && line.startsWith('Style:')) {
      const values = line.replace(/^Style:\s*/, '').split(',').map((v) => v.trim());
      const style = {};
      styleFields.forEach((name, i) => {
        style[name] = values[i];
      });
      if (style.name) styles.set(style.name.toLowerCase(), style);
      continue;
    }

    if (section === 'events' && line.startsWith('Format:')) {
      eventFields = parseFormat(line);
      continue;
    }

    if (section === 'events' && line.startsWith('Dialogue:')) {
      // The text field can contain commas, so split only the known fields.
      const body = line.replace(/^Dialogue:\s*/, '');
      const values = [];
      let rest = body;
      for (let i = 0; i < eventFields.length - 1; i += 1) {
        const comma = rest.indexOf(',');
        if (comma === -1) break;
        values.push(rest.slice(0, comma));
        rest = rest.slice(comma + 1);
      }
      values.push(rest);

      const event = {};
      eventFields.forEach((name, i) => {
        event[name] = values[i];
      });

      const cue = buildCue(event, styles, { playResX, playResY });
      if (cue) cues.push(cue);
    }
  }

  const body = cues
    .map((cue, i) => `${i + 1}\n${cue.time}${cue.settings ? ` ${cue.settings}` : ''}\n${cue.text}\n`)
    .join('\n');

  return `WEBVTT\n\n${body}`;
}

function buildCue(event, styles, { playResX, playResY }) {
  const start = toVttTime(event.start ?? '');
  const end = toVttTime(event.end ?? '');
  if (!start || !end) return null;

  const style = styles.get((event.style ?? '').toLowerCase()) || {};
  let text = event.text ?? '';

  // Vector drawings are shapes, not words; there is nothing sensible to show.
  if (/\\p[1-9]/.test(text)) return null;

  // --- tags inside {...} blocks -------------------------------------------
  // Styling is applied per text run, not per line: `{\i1}this{\i0} and that`
  // must italicise only the first part.
  const state = {
    italic: Number(style.italic ?? 0) === -1 || style.italic === '1',
    bold: Number(style.bold ?? 0) === -1 || style.bold === '1',
    underline: false,
    align: NUMERIC_ALIGN[Number(style.alignment) || 2] || NUMERIC_ALIGN[2],
    position: null,
  };

  let rendered = '';
  let cursor = 0;
  const block = /\{([^}]*)\}/g;
  let match;
  while ((match = block.exec(text))) {
    rendered += renderRun(text.slice(cursor, match.index), state);
    applyTags(match[1], state, style, playResX, playResY);
    cursor = match.index + match[0].length;
  }
  rendered += renderRun(text.slice(cursor), state);

  rendered = rendered.replace(/\n[ \t]+/g, '\n').trim();
  if (!rendered) return null;

  const { align, position } = state;

  const settings = [];
  if (position) {
    settings.push(`position:${position.xPct.toFixed(1)}%`);
    settings.push(`line:${position.yPct.toFixed(1)}%`);
    settings.push(`align:${position.align}`);
  } else {
    if (align.line) settings.push(`line:${align.line}`);
    if (align.align !== 'center') settings.push(`align:${align.align}`);
  }

  return { time: `${start} --> ${end}`, settings: settings.join(' '), text: rendered };
}

const clamp = (n) => Math.max(0, Math.min(100, Number.isFinite(n) ? n : 50));

/** One run of text, wrapped in whatever styling is active at that point. */
function renderRun(raw, state) {
  if (!raw) return '';
  let text = raw.replace(/\\N/g, '\n').replace(/\\n/g, '\n').replace(/\\h/g, '\u00a0');
  if (!text) return '';
  let out = escapeText(text);
  if (state.italic) out = `<i>${out}</i>`;
  if (state.bold) out = `<b>${out}</b>`;
  if (state.underline) out = `<u>${out}</u>`;
  return out;
}

/** Apply a {...} override block to the running state. */
function applyTags(tags, state, style, playResX, playResY) {
  const an = /\\an([1-9])/.exec(tags);
  if (an) state.align = NUMERIC_ALIGN[Number(an[1])] || state.align;

  const pos = /\\pos\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/.exec(tags);
  if (pos) {
    const xPct = clamp((Number(pos[1]) / playResX) * 100);
    const yPct = clamp((Number(pos[2]) / playResY) * 100);
    state.position = { xPct, yPct, align: xPct < 33 ? 'start' : xPct > 66 ? 'end' : 'center' };
  }

  if (/\\i1/.test(tags)) state.italic = true;
  if (/\\i0/.test(tags)) state.italic = false;
  if (/\\b1/.test(tags)) state.bold = true;
  if (/\\b(?:0|[2-9])/.test(tags)) state.bold = false;
  if (/\\u1/.test(tags)) state.underline = true;
  if (/\\u0/.test(tags)) state.underline = false;
  // \r resets to the style defaults.
  if (/\\r[a-z]/i.test(tags)) {
    state.italic = Number(style.italic ?? 0) === -1;
    state.bold = Number(style.bold ?? 0) === -1;
    state.underline = false;
  }
}
