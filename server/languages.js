/** Enough ISO-639 codes to label a menu; anything else shows the raw tag. */
export const LANGUAGES = {
  jpn: 'Japanese',
  ja: 'Japanese',
  japanese: 'Japanese',
  eng: 'English',
  en: 'English',
  english: 'English',
  spa: 'Spanish',
  es: 'Spanish',
  spanish: 'Spanish',
  fre: 'French',
  fra: 'French',
  fr: 'French',
  french: 'French',
  ger: 'German',
  deu: 'German',
  de: 'German',
  german: 'German',
  ita: 'Italian',
  it: 'Italian',
  italian: 'Italian',
  por: 'Portuguese',
  pt: 'Portuguese',
  portuguese: 'Portuguese',
  rus: 'Russian',
  ru: 'Russian',
  russian: 'Russian',
  kor: 'Korean',
  ko: 'Korean',
  korean: 'Korean',
  chi: 'Chinese',
  zho: 'Chinese',
  zh: 'Chinese',
  chinese: 'Chinese',
  ara: 'Arabic',
  ar: 'Arabic',
  dut: 'Dutch',
  nl: 'Dutch',
  pol: 'Polish',
  pl: 'Polish',
  tur: 'Turkish',
  tr: 'Turkish',
  ukr: 'Ukrainian',
  uk: 'Ukrainian',
  und: '',
};

/** Track kinds that are not languages, even when they look like a code. */
export const TRACK_FLAGS = {
  sdh: 'SDH',
  cc: 'CC',
  forced: 'Forced',
  signs: 'Signs',
  sign: 'Signs',
  songs: 'Songs',
  commentary: 'Commentary',
  dub: 'Dub',
  sub: 'Subs',
};

/** A two- or three-letter tag we recognise, e.g. "en", "eng", "English". */
export const languageName = (code) => {
  if (!code) return '';
  const key = String(code).toLowerCase().replace(/[^a-z]/g, '');
  if (!key || TRACK_FLAGS[key]) return '';
  return LANGUAGES[key] ?? (/^[a-z]{2,3}$/.test(key) ? key.toUpperCase() : '');
};

/** Full names back to codes, so a sidecar's srclang is a real BCP47 tag. */
const CODES = {
  english: 'en',
  japanese: 'ja',
  spanish: 'es',
  french: 'fr',
  german: 'de',
  italian: 'it',
  portuguese: 'pt',
  russian: 'ru',
  korean: 'ko',
  chinese: 'zh',
  arabic: 'ar',
  dutch: 'nl',
  polish: 'pl',
  turkish: 'tr',
  ukrainian: 'uk',
};

export function languageCode(token) {
  const key = String(token || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!key || TRACK_FLAGS[key] || !languageName(key)) return '';
  return CODES[key] ?? (key.length <= 3 ? key : '');
}

/** True when a token is a language tag rather than a label. */
export const isLanguageToken = (token) => Boolean(languageName(token));
