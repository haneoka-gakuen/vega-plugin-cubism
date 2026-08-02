import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import {
  cubismPlaybackSteps,
  normalizeCubismPlaybackRate,
  CubismViewerPlaybackState,
} from "../../dist/web-runtime/viewer/CubismPlaybackClock.js";

describe("Cubism playback clock", () => {
  for (const rate of [0.5, 1, 2]) {
    it(`continuously advances at ${rate}x`, () => {
      let wallSeconds = 0;
      let motionSeconds = 0;
      let updates = 0;
      for (let frame = 0; frame < 120; frame += 1) {
        for (const step of cubismPlaybackSteps(1 / 60, rate)) {
          assert.ok(step > 0);
          assert.ok(step * rate <= 1 / 30 + Number.EPSILON);
          wallSeconds += step;
          motionSeconds += step * rate;
          updates += 1;
        }
      }
      assert.ok(Math.abs(wallSeconds - 2) < 1e-10);
      assert.ok(Math.abs(motionSeconds - 2 * rate) < 1e-10);
      assert.ok(updates >= 120);
    });
  }

  it("normalizes invalid rates without stopping the clock", () => {
    assert.equal(normalizeCubismPlaybackRate(0), 1);
    assert.equal(normalizeCubismPlaybackRate(Number.NaN), 1);
    assert.equal(normalizeCubismPlaybackRate(2), 2);
  });

  it("reapplies a pre-load rate to initial and context-restored models", () => {
    const playback = new CubismViewerPlaybackState();
    const initial = [];
    const restored = [];
    playback.set(2);
    playback.apply({ setMotionSpeed: (rate) => initial.push(rate) });
    playback.apply({ setMotionSpeed: (rate) => restored.push(rate) });
    assert.deepEqual(initial, [2]);
    assert.deepEqual(restored, [2]);
  });

  it("publishes playback speed and readonly model bounds on the viewer", async () => {
    const declaration = await readFile(
      new URL("../../dist/web-runtime/viewer/CubismModelViewer.d.ts", import.meta.url),
      "utf8",
    );
    assert.match(declaration, /get modelBounds\(\): CubismDrawableBounds \| null;/u);
    assert.match(declaration, /setPlaybackSpeed\(rate: number\): void;/u);
  });
});
