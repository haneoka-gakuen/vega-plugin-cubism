/**
 * Runtime primitives shared by the story adapter and the optional standalone
 * viewer. Keeping this boundary explicit lets the viewer import the already
 * loaded runtime module instead of bundling a second Cubism implementation.
 */
export {
  AdvCubismModel,
  type CubismDrawableBounds,
  type CubismParameterValue,
} from "./rendering/cubism/AdvCubismModel";
export {
  AdvHarmonicMotionController,
  type AdvHarmonicMotionData,
} from "./rendering/cubism/AdvHarmonicMotion";
export {
  DEFAULT_UNITY_CUBISM_LIGHTING,
  type UnityCubismLightingState,
} from "./rendering/cubism/UnityCubismAdvLighting";
export { UnityTargetFrameClock } from "./rendering/three/UnityTargetFrameClock";
export {
  acquireCubismShaderContext,
  releaseCubismShaderContext,
} from "./vendor/cubism/rendering/cubismshader_webgl";
export {
  cubismPlaybackSteps,
  CubismViewerPlaybackState,
} from "./viewer/CubismPlaybackClock";
export { Matrix4 } from "./rendering/math/Matrix4";
