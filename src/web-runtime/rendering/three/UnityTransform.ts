import { Matrix4, type Matrix4Like } from "../math/Matrix4";

const HANDEDNESS_REFLECTION = new Matrix4().set(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1);

/** Converts a renderer matrix back to Unity's basis. C is its own inverse. */
export function threeMatrix4ToUnity(source: Matrix4Like, target = new Matrix4()): Matrix4 {
  return target.copy(HANDEDNESS_REFLECTION).multiply(source).multiply(HANDEDNESS_REFLECTION);
}
