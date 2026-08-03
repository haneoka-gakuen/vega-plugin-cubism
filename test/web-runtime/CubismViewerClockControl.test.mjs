import assert from "node:assert/strict";
import test from "node:test";

import { CubismViewerPlaybackState } from "../../src/web-runtime/viewer/CubismPlaybackClock.ts";
import { UnityTargetFrameClock } from "../../src/web-runtime/rendering/three/UnityTargetFrameClock.ts";

test("unchanged viewer playback rates do not request a frame-clock reset", () => {
  const applied = [];
  const playback = new CubismViewerPlaybackState();
  const target = { setMotionSpeed: (rate) => applied.push(rate) };

  assert.equal(playback.set(1, target), false);
  assert.equal(playback.set(1.25, target), true);
  assert.equal(playback.set(1.25, target), false);
  assert.deepEqual(applied, [1.25]);
});

test("a 25 FPS target clock survives 30 Hz transport snapshots when they are idempotent", () => {
  const clock = new UnityTargetFrameClock();
  const targetFrameRate = 25;
  let renderedFrames = 0;

  for (let hostFrame = 0; hostFrame < 60; hostFrame += 1) {
    // The host receives a transport snapshot every other 60 Hz frame. An
    // unchanged snapshot no longer resets this clock.
    if (clock.advance(1 / 60, targetFrameRate) != null) renderedFrames += 1;
  }

  assert.equal(renderedFrames, 25);
});
