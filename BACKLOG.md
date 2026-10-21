anime-sync — open bugs
======================

1. Quality switch mid-episode sends everyone back to 00:00
----------------------------------------------------------
Reported 2026-10-21 19:17 (+03) by the user. Not investigated yet — user
explicitly said "just remember it for now, we'll look into it later".

What happened
  A friend changed the quality from 720p to 1080p while an episode was
  playing. Playback jumped back to 00:00 instead of continuing at the
  current position.

Why it matters
  Quality selection is per-viewer, but the room's position is shared. If
  the switching client announces position 0 (the fresh <video> element's
  currentTime) to the room, the jump is not local to that friend — it
  drags the whole party back to the start. Worth confirming whether the
  other viewers also jumped.

Where to start looking
  - public/app.js  chooseQuality() -> applyTracks() -> setSource(url, track,
    { keepPosition })
    setSource does keep position, so the suspect is either a zero-value
    read before metadata loads (position saved while the new source has
    readyState 0 / duration NaN), or the sync loop pushing that 0 to the
    server as a legitimate seek.
  - The 1080p rendition is a different file with a different duration from
    the 720p one. If the restore step clamps position against a duration
    that is still NaN/0 when it runs, the clamp lands on 0.
  - Server side: Room.seek() accepts any position; nothing rejects 0, so a
    single bad client can move everyone.
  - Same risk applies to switching subtitle mode (styled <-> clean) since
    that is also a source swap — test both.

Acceptance
  Switching quality (any direction, any time) keeps the position within a
  few hundred ms, and never moves the other viewers. Add a UI scenario:
  play to ~4 s on a 8 s fixture, switch 720 -> 1080, assert position > 3 s
  and that a second client stayed put.

Repro fixture
  test/make-tracks-fixture.sh produces an 8 s episode with two renditions
  (720p prepared, 1080 rebuilt on demand), which is fast enough for a test.


Parked, not bugs — just notes
------------------------------
- Episode 06 is the only missing episode in the season; its upload died on
  the .part sweep bug (fixed) and it has not been re-sent.
- "Subtitle choice survives a reload" failed in three throwaway test
  instances but has not been reproduced against the live app. Suspected
  test-environment contamination (several instances sharing one media
  folder and cache). Verify on a pristine instance before believing it.
