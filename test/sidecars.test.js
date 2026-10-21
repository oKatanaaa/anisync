import test from 'node:test';
import assert from 'node:assert/strict';
import { findSidecars, parseTrackTokens } from '../server/sidecars.js';

const names = (...list) => list;

test('finds a language-tagged subtitle sidecar', () => {
  const { subs } = findSidecars('Episode 01.mkv', names('Episode 01.mkv', 'Episode 01.en.ass', 'readme.txt'));
  assert.equal(subs.length, 1);
  assert.equal(subs[0].name, 'Episode 01.en.ass');
  assert.equal(subs[0].lang, 'en');
  assert.equal(subs[0].label, 'English');
});

test('finds an audio dub sidecar', () => {
  const { audios } = findSidecars('Episode 01.mkv', names('Episode 01.mkv', 'Episode 01.eng.m4a'));
  assert.equal(audios.length, 1);
  assert.equal(audios[0].label, 'English');
});

test('a bare stem sidecar counts as an untagged external track', () => {
  const { subs } = findSidecars('Episode 01.mkv', names('Episode 01.mkv', 'Episode 01.srt'));
  assert.equal(subs.length, 1);
  assert.equal(subs[0].label, 'External track');
});

test('forced and SDH variants are labelled, not treated as languages', () => {
  const { subs } = findSidecars(
    'Episode 01.mkv',
    names('Episode 01.mkv', 'Episode 01.en.forced.ass', 'Episode 01.en.sdh.srt'),
  );
  assert.equal(subs.length, 2);
  assert.deepEqual(subs.map((s) => s.label).sort(), ['English · Forced', 'English · SDH']);
});

test('full language names work too', () => {
  const { subs } = findSidecars('Show - 03.mkv', names('Show - 03.mkv', 'Show - 03.Spanish.vtt'));
  assert.equal(subs[0].lang, 'es');
  assert.equal(subs[0].label, 'Spanish');
});

test('a different episode of the same show is not swept in', () => {
  const { subs, audios } = findSidecars(
    'Episode 01.mkv',
    names('Episode 01.mkv', 'Episode 011.en.ass', 'Episode 02.en.ass', 'Episode 1.srt'),
  );
  assert.equal(subs.length, 0);
  assert.equal(audios.length, 0);
});

test('image-based subtitles are skipped', () => {
  const { subs } = findSidecars('Episode 01.mkv', names('Episode 01.mkv', 'Episode 01.en.sup', 'Episode 01.en.idx'));
  assert.equal(subs.length, 0);
});

test('video and unrelated files are ignored', () => {
  const { subs, audios } = findSidecars(
    'Episode 01.mkv',
    names('Episode 01.mkv', 'Episode 01.1080p.mkv', 'Episode 01.nfo', 'Episode 01.jpg', 'notes.txt'),
  );
  assert.equal(subs.length, 0);
  assert.equal(audios.length, 0);
});

test('fansub-style names keep the tag they were given', () => {
  const { subs } = findSidecars(
    '[SubsPlease] Show - 01 (1080p).mkv',
    names('[SubsPlease] Show - 01 (1080p).mkv', '[SubsPlease] Show - 01 (1080p).en.ass'),
  );
  assert.equal(subs[0].lang, 'en');
  assert.equal(subs[0].label, 'English');
});

test('free-form tokens become part of the label', () => {
  const { subs } = findSidecars('Episode 01.mkv', names('Episode 01.mkv', 'Episode 01.en.director.srt'));
  assert.equal(subs[0].label, 'English · director');
});

test('token parsing handles empty input', () => {
  assert.equal(parseTrackTokens('').label, 'External track');
});
