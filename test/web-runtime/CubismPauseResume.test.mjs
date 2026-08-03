import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { AdvHarmonicMotionController } from "../../src/web-runtime/rendering/cubism/AdvHarmonicMotion.ts";
import { PausedCubismRequest } from "../../src/web-runtime/rendering/cubism/PausedCubismRequest.ts";

const parameterSource = {
  parameterRange: (id) => (id === "ParamBreath" ? { minimum: 0, maximum: 1 } : null),
};

test("pause-time request slot retains only the latest request and consumes it once", () => {
  const slot = new PausedCubismRequest();
  slot.retain({ name: "first" });
  slot.retain({ name: "latest" });

  assert.deepEqual(slot.take(), { name: "latest" });
  assert.equal(slot.take(), null);
});

test("harmonic motion freezes on pause and resumes from the same phase", () => {
  const harmonic = new AdvHarmonicMotionController({
    channelTimescales: [1],
    parameters: [
      {
        id: "ParamBreath",
        channel: 0,
        direction: 2,
        normalizedOrigin: 0.5,
        normalizedRange: 0.2,
        duration: 4,
      },
    ],
  });

  const beforePause = harmonic.advance(1, parameterSource)[0].value;
  harmonic.setPaused(true);
  const whilePaused = harmonic.advance(2, parameterSource)[0].value;
  harmonic.setPaused(false);
  const afterResume = harmonic.advance(1, parameterSource)[0].value;

  assert.equal(beforePause, 0.7);
  assert.equal(whilePaused, beforePause);
  assert.ok(Math.abs(afterResume - 0.5) < Number.EPSILON * 2);
});

test("viewer load and pause wiring remain part of the public runtime contract", () => {
  const viewerSource = readFileSync(
    new URL("../../src/web-runtime/viewer/CubismModelViewer.ts", import.meta.url),
    "utf8",
  );
  const modelSource = readFileSync(
    new URL("../../src/web-runtime/rendering/cubism/AdvCubismModel.ts", import.meta.url),
    "utf8",
  );

  assert.match(viewerSource, /readonly defaultExpressionName\?: string;/);
  assert.match(viewerSource, /readonly physics\?: boolean;/);
  assert.match(viewerSource, /physics: options\.physics \?\? true,/);
  assert.match(viewerSource, /this\.model\?\.setPaused\(true\);/);
  assert.match(viewerSource, /this\.harmonicMotion\.setPaused\(true\);/);
  assert.match(viewerSource, /this\.harmonicMotion\.setPaused\(false\);[\s\S]*this\.model\?\.setPaused\(false\);/);
  assert.match(viewerSource, /if \(this\.model && deltaSeconds != null\) \{/);
  assert.match(viewerSource, /setTargetFrameRate\(rate: number\): void \{/);
  assert.match(viewerSource, /if \(this\.targetFrameRate === next\) return;/);
  assert.match(viewerSource, /this\.targetFrameRate = next;[\s\S]*this\.frameClock\.reset\(\);/);
  assert.match(viewerSource, /options\?: CubismModelViewerMotionPositionOptions,/);
  assert.match(viewerSource, /\{ loop: options\?\.loop \?\? this\.loopMotionName === name \},/);
  assert.match(modelSource, /this\.pausedMotionRequest\.retain\(request\);/);
  assert.match(modelSource, /const motion = this\.pausedMotionRequest\.take\(\);/);
  assert.match(modelSource, /A lazy request may have started before Pause and completed during it\./);
  assert.match(modelSource, /readonly positionSeconds\?: number;/);
  assert.match(modelSource, /positionAdvCubismMotionQueueEntry\([\s\S]*request\.positionSeconds,[\s\S]*request\.positionOptions,/);
});
