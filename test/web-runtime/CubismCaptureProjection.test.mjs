import assert from "node:assert/strict";
import test from "node:test";

import { resolveCubismOrthographicCaptureMatrix } from "../../src/web-runtime/viewer/CubismCaptureProjection.ts";

const stageCapture = {
  halfHeight: 3.5,
  nearClip: 0.009999999776482582,
  farClip: 50,
  cameraPosition: [0, 2.299999952316284, -2],
  modelPosition: [0, 2.299999952316284, 0],
  modelScale: 3,
};

test("fixed square capture preserves the authored model scale and center", () => {
  const matrix = resolveCubismOrthographicCaptureMatrix(2048, 2048, stageCapture);
  assert.equal(matrix.scaleX, 6 / 7);
  assert.equal(matrix.scaleY, 6 / 7);
  assert.equal(matrix.offsetX, 0);
  assert.equal(matrix.offsetY, 0);
  assert.equal(matrix.scaleX * (7 / 6) + matrix.offsetX, 1);
  assert.equal(matrix.scaleX * (-7 / 6) + matrix.offsetX, -1);
  assert.equal(matrix.scaleY * (7 / 6) + matrix.offsetY, 1);
  assert.equal(matrix.scaleY * (-7 / 6) + matrix.offsetY, -1);
});

test("orthographic capture derives its horizontal extent from the target aspect", () => {
  const matrix = resolveCubismOrthographicCaptureMatrix(2048, 1024, {
    ...stageCapture,
    modelPosition: [0, 0, 0],
    cameraPosition: [0, 0, -2],
    modelScale: 1,
  });
  assert.equal(matrix.scaleX * 7, 1);
  assert.equal(matrix.scaleX * -7, -1);
  assert.equal(matrix.scaleY * 3.5, 1);
  assert.equal(matrix.scaleY * -3.5, -1);
});

test("orthographic capture rejects invalid lens ranges", () => {
  assert.throws(
    () => resolveCubismOrthographicCaptureMatrix(2048, 2048, { ...stageCapture, halfHeight: 0 }),
    RangeError,
  );
  assert.throws(
    () => resolveCubismOrthographicCaptureMatrix(2048, 2048, { ...stageCapture, farClip: stageCapture.nearClip }),
    RangeError,
  );
});
