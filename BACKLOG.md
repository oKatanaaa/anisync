anime-sync — playback follow-ups
================================

1. Quality switch mid-episode sends everyone back to 00:00
----------------------------------------------------------
Reported 2026-10-21 19:17 (+03). Source-switch handling was reworked and
regression-tested locally on 2026-10-21; confirmation in the original watch
party remains pending. The homeserver has not been updated.

What happened
  A friend changed the quality from 720p to 1080p while an episode was
  playing. Playback jumped back to 00:00 instead of continuing at the
  current position.

Implemented protection
  - StreamPlayer owns each source lifetime and cancels obsolete asynchronous
    preparation/metadata callbacks. Restore uses the current room timeline.
  - Play actions also use the room timeline, rather than a fresh element's
    temporary currentTime=0. Buffering reports cannot rewind the room from
    a loading source at zero.
  - HLS packaging preserves timestamps across B-frame video and separate audio.
  - Quality remains per viewer. A sustained source load can pause/refill the
    room together, without skipping missed content.

Validation
  - Existing quality scenario now switches at a paused 12-second midpoint
    in a 24-second fixture: both directions and the other viewer remain
    within 300 ms. It waits for decoded video at the requested resolution.
  - npm run test:playback uses a 90-second fixture and two independent
    browsers: delayed and rapid source changes, both qualities, soft
    subtitle toggles, alternate audio, and MP4 fallback/retry.
  - The original full rewind was not reproduced before these changes;
    the earlier outgoing-seek explanation was a hypothesis, not a proven cause.


Parked, not bugs — just notes
------------------------------
- Episode 06 is the only missing episode in the season; its upload died on
  the .part sweep bug (fixed) and it has not been re-sent.
- "Subtitle choice survives a reload" failed in three throwaway test
  instances but has not been reproduced against the live app. Suspected
  test-environment contamination (several instances sharing one media
  folder and cache). Verify on a pristine instance before believing it.
