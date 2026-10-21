import test from 'node:test';
import assert from 'node:assert/strict';
import { assToVtt } from '../server/assToVtt.js';

const document = (events, styles = 'Style: Default,DejaVu Sans,44,&H00FFFFFF,&H000000FF,&H00101010,&H80000000,-1,0,0,0,100,100,0,0,1,3,1,2,40,40,56,1') => `[Script Info]
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${styles}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events}`;

test('produces a WebVTT document with converted timestamps', () => {
  const vtt = assToVtt(document('Dialogue: 0,0:00:01.50,0:00:04.20,Default,,0,0,0,,Hello there'));
  assert.ok(vtt.startsWith('WEBVTT'));
  assert.match(vtt, /00:00:01\.500 --> 00:00:04\.200/);
  assert.match(vtt, /Hello there/);
});

test('strips override blocks that WebVTT cannot express', () => {
  const vtt = assToVtt(
    document('Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\fad(300,300)\\blur2\\t(0,500,\\fs60)}Clean text'),
  );
  assert.match(vtt, /Clean text/);
  assert.doesNotMatch(vtt, /fad|blur|\\t\(/);
});

test('keeps italics and bold from inline tags', () => {
  // A non-bold style, so the inline tags are the only source of styling.
  const plain = 'Style: Default,DejaVu Sans,44,&H00FFFFFF,&H000000FF,&H00101010,&H80000000,0,0,0,0,100,100,0,0,1,3,1,2,40,40,56,1';
  const vtt = assToVtt(
    document('Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\i1}italic{\\i0} then {\\b1}bold{\\b0}', plain),
  );
  assert.match(vtt, /<i>italic<\/i> then <b>bold<\/b>/);
});

test('maps \\an8 to the top of the frame', () => {
  const vtt = assToVtt(document('Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\an8}Top sign'));
  assert.match(vtt, /line:8%/);
  // centre is the default alignment, so it is deliberately not spelled out
  assert.doesNotMatch(vtt, /align:start|align:end/);
});

test('turns absolute positions into percentages', () => {
  const vtt = assToVtt(document('Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\pos(100,120)}Left corner'));
  assert.match(vtt, /position:7\.8%/);
  assert.match(vtt, /line:16\.7%/);
  assert.match(vtt, /align:start/);
});

test('a right-hand position aligns to the end', () => {
  const vtt = assToVtt(document('Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\pos(1200,700)}Right'));
  assert.match(vtt, /align:end/);
});

test('takes alignment from the style when the line has no override', () => {
  const styles = 'Style: Sign,DejaVu Sans,64,&H00FFD479,&H000000FF,&H00101010,&H80000000,-1,0,0,0,100,100,2,0,1,4,0,8,40,40,30,1';
  const vtt = assToVtt(document('Dialogue: 0,0:00:01.00,0:00:02.00,Sign,,0,0,0,,Style driven', styles));
  assert.match(vtt, /line:8%/);
});

test('keeps explicit line breaks as separate lines', () => {
  const vtt = assToVtt(document('Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,First\\NSecond'));
  assert.match(vtt, /First\nSecond/);
});

test('escapes markup characters in the source text', () => {
  const vtt = assToVtt(document('Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,5 < 6 & 7 > 3'));
  assert.match(vtt, /5 &lt; 6 &amp; 7 &gt; 3/);
  assert.doesNotMatch(vtt, /<6/);
});

test('drops vector drawings and empty lines', () => {
  const vtt = assToVtt(
    document(
      [
        'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\p1}m 0 0 l 100 0 100 100{\\p0}',
        'Dialogue: 0,0:00:02.00,0:00:03.00,Default,,0,0,0,,{\\fad(200,200)}',
        'Dialogue: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,Real line',
      ].join('\n'),
    ),
  );
  assert.doesNotMatch(vtt, /m 0 0/);
  assert.match(vtt, /^1\n00:00:03\.000/m, 'only the real line is numbered first');
});

test('comment lines are ignored', () => {
  const vtt = assToVtt(
    document(
      ['Comment: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,not shown', 'Dialogue: 0,0:00:02.00,0:00:03.00,Default,,0,0,0,,shown'].join('\n'),
    ),
  );
  assert.doesNotMatch(vtt, /not shown/);
  assert.match(vtt, /shown/);
});

test('an empty script produces a valid, empty document', () => {
  const vtt = assToVtt(document(''));
  assert.equal(vtt.trim(), 'WEBVTT');
});
