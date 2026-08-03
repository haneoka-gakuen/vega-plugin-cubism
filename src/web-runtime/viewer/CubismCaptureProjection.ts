export interface CubismModelViewerOrthographicCapture {
  readonly halfHeight: number;
  readonly nearClip: number;
  readonly farClip: number;
  readonly cameraPosition: readonly [number, number, number];
  readonly modelPosition: readonly [number, number, number];
  readonly modelScale: number;
}

export interface CubismOrthographicCaptureMatrix {
  readonly scaleX: number;
  readonly scaleY: number;
  readonly scaleZ: number;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly offsetZ: number;
}

const finite = (value: unknown, fallback = 0) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const safeDimension = (value: unknown) => Math.max(1, Math.round(finite(value, 1)));

export function resolveCubismOrthographicCaptureMatrix(
  width: number,
  height: number,
  capture: CubismModelViewerOrthographicCapture,
): CubismOrthographicCaptureMatrix {
  const resolvedWidth = safeDimension(width);
  const resolvedHeight = safeDimension(height);
  const halfHeight = finite(capture.halfHeight);
  const nearClip = finite(capture.nearClip);
  const farClip = finite(capture.farClip);
  const modelScale = finite(capture.modelScale);
  if (!(halfHeight > 0) || !(nearClip > 0) || !(farClip > nearClip) || !(modelScale > 0)) {
    throw new RangeError("Cubism orthographic capture dimensions must be positive and finite");
  }
  const aspect = resolvedWidth / resolvedHeight;
  const cameraX = finite(capture.cameraPosition[0]);
  const cameraY = finite(capture.cameraPosition[1]);
  const cameraZ = finite(capture.cameraPosition[2]);
  const modelX = finite(capture.modelPosition[0]);
  const modelY = finite(capture.modelPosition[1]);
  const modelZ = finite(capture.modelPosition[2]);
  const depth = farClip - nearClip;
  return {
    scaleX: modelScale / (halfHeight * aspect),
    scaleY: modelScale / halfHeight,
    // The capture view flips Z after worldToLocal. Cubism is explicitly
    // sorted and rendered without a depth buffer, but retain the authored
    // orthographic depth row for hosts that inspect the complete MVP.
    scaleZ: (2 * modelScale) / depth,
    offsetX: (modelX - cameraX) / (halfHeight * aspect),
    offsetY: (modelY - cameraY) / halfHeight,
    offsetZ: (-2 * (cameraZ - modelZ) - (farClip + nearClip)) / depth,
  };
}
