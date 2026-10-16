import { Matrix4, type Matrix4Like } from "../math/Matrix4";
import { CubismDefaultParameterId } from "../../vendor/cubism/cubismdefaultparameterid";
import { CubismModelSettingJson } from "../../vendor/cubism/cubismmodelsettingjson";
import { BreathParameterData, CubismBreath } from "../../vendor/cubism/effect/cubismbreath";
import { CubismEyeBlink, EyeState } from "../../vendor/cubism/effect/cubismeyeblink";
import type { CubismIdHandle } from "../../vendor/cubism/id/cubismid";
import { CubismFramework } from "../../vendor/cubism/live2dcubismframework";
import { CubismMatrix44 } from "../../vendor/cubism/math/cubismmatrix44";
import { CubismUserModel } from "../../vendor/cubism/model/cubismusermodel";
import type { CubismExpressionMotion } from "../../vendor/cubism/motion/cubismexpressionmotion";
import type { CubismMotion } from "../../vendor/cubism/motion/cubismmotion";
import { CubismMotionCurveTarget } from "../../vendor/cubism/motion/cubismmotioninternal";
import type { CubismMotionQueueEntry } from "../../vendor/cubism/motion/cubismmotionqueueentry";
import { csmVector } from "../../vendor/cubism/type/csmvector";
import type { AdvMotionSyncRuntime, AdvMotionSyncSetting, AdvVoiceMotionSyncPcmSnapshot } from "../../types";
import {
  AdvMotionSyncCoreAdapter,
  applyAdvMotionSyncOnCapturedBase,
  selectAdvMotionSyncSetting,
  type AdvMotionSyncCoreStatus,
} from "./AdvMotionSyncCore";
import type { StoryCharacterModel } from "../StoryCharacterModel";
import { ensureCubismFramework } from "./CubismCoreRuntime";
import { resolveCubismFadeIn } from "./AdvCubismMotionFade";
import { positionAdvCubismMotionQueueEntry, type AdvCubismMotionPositionOptions } from "./AdvCubismMotionPosition";
import { PausedCubismRequest } from "./PausedCubismRequest";
import {
  AdvCubismParameterLoop,
  type CubismParameterLoopSnapshot,
  type CubismParameterLoopTimeline,
} from "./AdvCubismParameterLoop";
import {
  cachedCubismModelResourceLoader,
  createOwnedAbortSignal,
  resolveCubismResourceUrl,
  type CubismModelResourceLoader,
  type OwnedAbortSignal,
} from "./CubismResourceCache";
import { cubismRetryClockSeconds, CubismResourceRetrySchedule } from "./CubismResourceRetry";
import { threeMatrix4ToUnity } from "../three/UnityTransform";
import {
  DEFAULT_UNITY_CUBISM_LIGHTING,
  DEFAULT_UNITY_CUBISM_MULTIPLY_TEXTURE,
  type UnityCubismLightingState,
  type UnityCubismMultiplyTextureParameters,
} from "./UnityCubismAdvLighting";

import { resetCubismExpressionBaseline } from "../../../runtime/CubismExpressionBaseline";
import { createCubismTexture } from "./CubismTexture";
import { normalizeCubismTextureVariants, type CubismTextureVariant } from "../../../runtime/CubismTextureVariant";

const MOTION_PRIORITY_FORCE = 3;

export interface CubismParameterFrame {
  angleX?: number;
  bodyAngleX?: number;
  lookX?: number;
  lookY?: number;
  /** Smoothed interactive focus, normalized to [-1, 1]. */
  focusX?: number;
  /** Smoothed interactive focus, normalized to [-1, 1]. */
  focusY?: number;
  mouthOpenY?: number;
  mouthForm?: number;
  motionSyncPcm?: AdvVoiceMotionSyncPcmSnapshot | null;
  motionSyncWeight?: number;
  overrides?: Readonly<Record<string, number>>;
  blends?: readonly CubismParameterBlend[];
}

export interface CubismParameterBlend {
  readonly id: string;
  readonly value: number;
  /** CubismParameterBlendMode: 0=override, 1=additive, 2=multiply. */
  readonly mode: 0 | 1 | 2;
}

export interface CubismParameterValue {
  readonly index: number;
  readonly id: string;
  readonly value: number;
  readonly minimum: number;
  readonly maximum: number;
  readonly defaultValue: number;
}

export interface AdvCubismViewerChannelMetadata {
  readonly eyeBlinkParameterIds: readonly string[];
  readonly standardBreathParameterId: string | null;
}

export interface CubismPartValue {
  readonly index: number;
  readonly id: string;
  readonly opacity: number;
}

export interface CubismDrawableBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface AdvCubismModelOptions {
  gl: WebGL2RenderingContext;
  modelUrl: string;
  /** Explicit compressed alternatives; the model manifest retains its PNG slots. */
  textureVariants?: readonly CubismTextureVariant[];
  /** Explicit consumer permission for lossy re-encoded alternatives. */
  allowLossyTextureVariants?: boolean;
  /** Cancels browser-side resource waits when this character load loses ownership. */
  signal?: AbortSignal;
  /** Live2DCharacter.DefaultMotionName; its finite clip is restarted by the controller. */
  defaultMotionName?: string;
  maskBufferSize?: number;
  anisotropy?: number;
  physics?: boolean;
  breath?: boolean;
  lighting?: UnityCubismLightingState;
  motionSync?: AdvMotionSyncRuntime | AdvMotionSyncSetting | null;
  /** Resolver-backed immutable bytes and decoded-image cache. */
  resourceLoader?: CubismModelResourceLoader;
}

export interface AdvCubismDrawState {
  /** Three-basis matrixWorld; converted back to Unity basis before shader upload. */
  readonly objectToWorld?: Matrix4Like;
  readonly timeSeconds?: number;
}

export type AdvCubismMultiplyTextureOptions = Partial<UnityCubismMultiplyTextureParameters>;

interface CubismPlaybackRequest {
  readonly sequence: number;
  readonly name: string;
  readonly fadeInSeconds?: number;
  readonly positionSeconds?: number;
  readonly positionOptions?: AdvCubismMotionPositionOptions;
}

function resolveResourceUrl(baseUrl: string, resource: string): string {
  return new URL(resource, new URL(baseUrl, globalThis.location?.href || "http://localhost/")).toString();
}

function fileStem(path: string): string {
  const file = path.split("/").pop() || path;
  return file.replace(/\.(?:motion3|exp3)\.json$/i, "");
}

function createWhiteTexture(gl: WebGL2RenderingContext): WebGLTexture {
  const texture = gl.createTexture();
  if (!texture) throw new Error("Unable to allocate the Cubism multiply fallback texture");
  const binding = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
  try {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    return texture;
  } finally {
    if (!gl.isContextLost()) gl.bindTexture(gl.TEXTURE_2D, binding);
  }
}

const IDENTITY_MATRIX = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as const);

/**
 * A renderer-independent Cubism model. The official Web Framework owns model,
 * motion, expression, physics, pose and mask semantics; Three only supplies the
 * final Unity-compatible matrix and render target.
 */
export class AdvCubismModel extends CubismUserModel implements StoryCharacterModel {
  readonly format = "cubism3" as const;
  readonly modelUrl: string;
  readonly textures: WebGLTexture[] = [];
  readonly motions = new Map<string, CubismMotion>();
  readonly expressions = new Map<string, CubismExpressionMotion>();
  private readonly motionFadeInTimes = new Map<string, number>();
  private readonly expressionFadeInTimes = new Map<string, number>();
  // Lazy motion/expression loading: model3.json's full catalog is indexed once,
  // and each motion/expression is fetched + registered on first play instead of
  // all at character placement. The rolling preload warms the URLs that will play
  // soon, so lazy loads are usually browser-cache hits.
  private motionIndex: Map<string, { group: string; index: number; file: string }> | null = null;
  private expressionIndex: Map<string, { index: number; file: string }> | null = null;
  private readonly loadingMotions = new Map<string, Promise<CubismMotion | null>>();
  private readonly loadingExpressions = new Map<string, Promise<CubismExpressionMotion | null>>();
  private readonly motionRetries = new CubismResourceRetrySchedule();
  private readonly expressionRetries = new CubismResourceRetrySchedule();
  private motionRequestSequence = 0;
  private expressionRequestSequence = 0;
  private requestedMotion: CubismPlaybackRequest | null = null;
  private activeMotionName = "";
  private requestedExpression: CubismPlaybackRequest | null = null;
  private readonly pausedMotionRequest = new PausedCubismRequest<CubismPlaybackRequest>();
  private readonly pausedExpressionRequest = new PausedCubismRequest<CubismPlaybackRequest>();
  private pixelsPerUnitValue = 1;

  private readonly gl: WebGL2RenderingContext;
  private readonly resourceAbort: OwnedAbortSignal;
  private readonly resourceSignal: AbortSignal;
  private readonly resourceLoader: CubismModelResourceLoader;
  private readonly releaseResourceLoader?: () => void;
  private readonly eyeBlinkIds = new csmVector<CubismIdHandle>();
  private readonly lipSyncIds = new csmVector<CubismIdHandle>();
  private readonly parameterIds = new Map<string, CubismIdHandle>();
  private readonly mvp = new CubismMatrix44();
  private readonly unityObjectToWorld = new Matrix4();
  private readonly angleXId: CubismIdHandle;
  private readonly angleYId: CubismIdHandle;
  private readonly angleZId: CubismIdHandle;
  private readonly bodyAngleXId: CubismIdHandle;
  private readonly bodyAngleXAddId: CubismIdHandle;
  private readonly eyeBallXId: CubismIdHandle;
  private readonly eyeBallYId: CubismIdHandle;
  private readonly mouthOpenYId: CubismIdHandle;
  private readonly mouthFormId: CubismIdHandle;
  private readonly standardBreathId: CubismIdHandle;
  private readonly physicsEnabled: boolean;
  private readonly breathEnabled: boolean;
  private readonly defaultMotionName: string;
  private setting: CubismModelSettingJson;
  private elapsedSeconds = 0;
  private paused = false;
  private motionClockFrozen = false;
  private animationTimeFrozen = false;
  private frozenParameters: Float32Array | null = null;
  private frozenParts: Float32Array | null = null;
  private readonly authoredParameterIndices = new Map<CubismIdHandle, number>();
  private readonly authoredPartIndices = new Map<string, number>();
  private readonly partOpacityOverrides = new Map<number, number>();
  private defaultMotionRestartSuppressed = false;
  private motionSpeed = 1;
  private readonly eyeBlinkBaseValues: number[] = [];
  private eyeBlinkEnabled = true;
  private eyeBlinkOpening = 1;
  private eyeBlinkStopped = false;
  private eyeBlinkBeforeStopEnabled = true;
  private eyeBlinkStopStartOpening = 1;
  private eyeBlinkStopElapsed = 0;
  private eyeBlinkStopDuration = 0;
  private readonly eyeBlinkNeutralizeTargets: Array<{ id: CubismIdHandle; index: number; defaultValue: number }> = [];
  private readonly defaultEyeFadeCurves = new WeakMap<
    CubismMotion,
    readonly ({ fadeIn: number; fadeOut: number } | null)[]
  >();
  private parameterLoopName: string | null = null;
  private readonly parameterLoop = new AdvCubismParameterLoop();
  private parameterLoopRequestSequence = 0;
  private activeParameterLoopSequence = 0;
  private requestedParameterLoop: CubismPlaybackRequest | null = null;
  private readonly pausedParameterLoopRequest = new PausedCubismRequest<CubismPlaybackRequest>();
  private multiplyFallbackTexture: WebGLTexture | null = null;
  private ownedMultiplyTexture: WebGLTexture | null = null;
  private motionSync: AdvMotionSyncCoreAdapter | null = null;
  private resourceGeneration = 0;
  private released = false;
  private gpuContextInvalidated = false;
  private readonly handleContextLost = (): void => {
    this.gpuContextInvalidated = true;
    // A late image/motion completion must not allocate into a restored context
    // on behalf of this permanently invalidated model generation.
    this.resourceAbort.abort();
  };
  private updateSerialValue = 0;
  private drawSerialValue = 0;

  get isOperational(): boolean {
    return !this.released && this.isInitialized() && !this.gpuContextInvalidated && !this.gl.isContextLost();
  }

  get updateSerial(): number {
    return this.updateSerialValue;
  }

  get drawSerial(): number {
    return this.drawSerialValue;
  }

  private constructor(options: AdvCubismModelOptions) {
    super();
    this.gl = options.gl;
    this.gl.canvas?.addEventListener("webglcontextlost", this.handleContextLost);
    this.resourceAbort = createOwnedAbortSignal(options.signal);
    this.resourceSignal = this.resourceAbort.signal;
    this.resourceLoader = options.resourceLoader ?? cachedCubismModelResourceLoader;
    this.releaseResourceLoader = this.resourceLoader.retain?.();
    this.modelUrl = options.modelUrl;
    this.defaultMotionName = String(options.defaultMotionName || "");
    this.physicsEnabled = options.physics !== false;
    // The reference runtime uses CubismHarmonicMotionController. Stock SDK
    // breathing is opt-in so the same parameter is not animated twice.
    this.breathEnabled = options.breath === true;
    const ids = CubismFramework.getIdManager();
    this.angleXId = ids.getId(CubismDefaultParameterId.ParamAngleX);
    this.angleYId = ids.getId(CubismDefaultParameterId.ParamAngleY);
    this.angleZId = ids.getId(CubismDefaultParameterId.ParamAngleZ);
    this.bodyAngleXId = ids.getId(CubismDefaultParameterId.ParamBodyAngleX);
    this.bodyAngleXAddId = ids.getId("ParamBodyAngleXAdd");
    this.eyeBallXId = ids.getId(CubismDefaultParameterId.ParamEyeBallX);
    this.eyeBallYId = ids.getId(CubismDefaultParameterId.ParamEyeBallY);
    this.mouthOpenYId = ids.getId(CubismDefaultParameterId.ParamMouthOpenY);
    this.mouthFormId = ids.getId(CubismDefaultParameterId.ParamMouthForm);
    this.standardBreathId = ids.getId(CubismDefaultParameterId.ParamBreath);
  }

  static async create(options: AdvCubismModelOptions): Promise<AdvCubismModel> {
    await ensureCubismFramework(options.signal);
    if (options.signal?.aborted) {
      const error = new Error(`Cubism model loading was aborted: ${options.modelUrl}`);
      error.name = "AbortError";
      throw error;
    }
    const instance = new AdvCubismModel(options);
    try {
      await instance.initialize(options);
      return instance;
    } catch (error) {
      // initialize() allocates the moc/model, motions and GL textures in
      // stages. The caller cannot observe the instance until it succeeds, so
      // creation itself must own partial-construction cleanup.
      try {
        instance.release();
      } catch {
        // Preserve the actual load/decode failure if a partially initialized
        // SDK object cannot complete every release hook.
      }
      throw error;
    }
  }

  private async initialize(options: AdvCubismModelOptions): Promise<void> {
    const settingBuffer = await this.resourceLoader.loadArrayBuffer(this.modelUrl, this.resourceSignal);
    this.setting = new CubismModelSettingJson(settingBuffer, settingBuffer.byteLength);
    const manifest = JSON.parse(new TextDecoder().decode(settingBuffer));
    const textureVariants = normalizeCubismTextureVariants(
      options.textureVariants ?? manifest.TextureVariants ?? manifest.FileReferences?.TextureVariants,
    );
    const mocUrl = resolveResourceUrl(this.modelUrl, this.setting.getModelFileName());
    this.loadModel(await this.resourceLoader.loadArrayBuffer(mocUrl, this.resourceSignal), false);
    if (!this._model) throw new Error(`Cubism model could not be created from ${mocUrl}`);
    for (let index = 0; index < this._model.getParameterCount(); index += 1) {
      const handle = this._model.getParameterId(index);
      this.authoredParameterIndices.set(handle, index);
      this.parameterIds.set(handle.getString().s, handle);
    }
    for (let index = 0; index < this._model.getPartCount(); index += 1) {
      this.authoredPartIndices.set(this._model.getPartId(index).getString().s, index);
    }
    this.pixelsPerUnitValue = Math.max(0.001, Number(this._model.getPixelsPerUnit()) || 1);

    const motionSyncSetting = selectAdvMotionSyncSetting(options.motionSync);
    if (motionSyncSetting) {
      this.motionSync = new AdvMotionSyncCoreAdapter(motionSyncSetting);
    }

    // CubismSdkForUnity's CubismDrawable copies Core drawable vertices directly
    // into the Unity Mesh. It does not apply model3.json's Web-framework layout
    // matrix. Keep the SDK model matrix at identity and apply only the authored
    // Unity Transform in ThreeStoryScene.

    for (let index = 0; index < this.setting.getEyeBlinkParameterCount(); index += 1) {
      this.eyeBlinkIds.pushBack(this.setting.getEyeBlinkParameterId(index));
    }
    const neutralizeIds = new Set<CubismIdHandle>();
    for (let index = 0; index < this.eyeBlinkIds.getSize(); index += 1) neutralizeIds.add(this.eyeBlinkIds.at(index));
    neutralizeIds.add(CubismFramework.getIdManager().getId("ParamEyeLOpen"));
    neutralizeIds.add(CubismFramework.getIdManager().getId("ParamEyeROpen"));
    for (const id of neutralizeIds) {
      const index = this.realParameterIndex(id);
      if (index != null)
        this.eyeBlinkNeutralizeTargets.push({ id, index, defaultValue: this._model.getParameterDefaultValue(index) });
    }
    for (let index = 0; index < this.setting.getLipSyncParameterCount(); index += 1) {
      this.lipSyncIds.pushBack(this.setting.getLipSyncParameterId(index));
    }
    if (this.eyeBlinkIds.getSize() > 0) {
      this._eyeBlink = CubismEyeBlink.create(this.setting);
      // CubismAutoEyeBlinkInput: Mean=2.5, MaximumDeviation=2.0;
      // Closing/Closed/Opening resolve through Timescale=10.
      this._eyeBlink.setBlinkingIntervalRange(0.5, 4.5);
      this._eyeBlink.setBlinkingSetting(0.1, 0.05, 0.15);
    }
    this.configureBreath();

    await Promise.all([this.loadOptionalDynamics(), this.motionSync?.prepare()]);

    this.createRenderer(1);
    const renderer = this.getRenderer();
    renderer.startUp(this.gl);
    renderer.setIsPremultipliedAlpha(true);
    renderer.useHighPrecisionMask(false);
    renderer.setClippingMaskBufferSize(Math.max(256, Math.min(2048, options.maskBufferSize ?? 1024)));
    renderer.setAnisotropy(Math.max(1, options.anisotropy ?? 1));
    this.multiplyFallbackTexture = createWhiteTexture(this.gl);
    renderer.setUnityAdvLightingState(options.lighting ?? DEFAULT_UNITY_CUBISM_LIGHTING);
    renderer.setUnityAdvMultiplyTexture(this.multiplyFallbackTexture, DEFAULT_UNITY_CUBISM_MULTIPLY_TEXTURE);

    const generation = this.resourceGeneration;
    const anisotropy = options.anisotropy ?? 1;
    const textureLoads: Promise<void>[] = [];
    for (let index = 0; index < this.setting.getTextureCount(); index += 1) {
      const resource = this.setting.getTextureFileName(index);
      if (!resource) continue;
      const url = resolveResourceUrl(this.modelUrl, resource);
      textureLoads.push(
        createCubismTexture(
          this.gl,
          url,
          anisotropy,
          this.resourceLoader,
          this.resourceSignal,
          textureVariants.filter((variant) =>
            variant.texture
              ? resolveCubismResourceUrl(this.modelUrl, variant.texture) === url
              : variant.textureIndex === index,
          ),
          this.modelUrl,
          { allowLossyReencoded: options.allowLossyTextureVariants === true },
        ).then(({ texture, flipY }) => {
          // Promise.all rejects as soon as one resource fails. Creation then
          // releases the partially built model while sibling requests may
          // still resolve; never bind into that released renderer, and release
          // the texture this async pass allocated after the model was released.
          if (this.released || generation !== this.resourceGeneration) {
            this.deleteGpuTexture(texture);
            return;
          }
          this.textures.push(texture);
          renderer.bindTexture(index, texture, flipY);
        }),
      );
    }
    await Promise.all(textureLoads);
    this._model.saveParameters();
    this.setInitialized(true);
    this.setUpdating(false);
  }

  private configureBreath(): void {
    if (!this.breathEnabled) return;
    this._breath = CubismBreath.create();
    const values = new csmVector<BreathParameterData>();
    values.pushBack(new BreathParameterData(this.angleXId, 0, 15, 6.5345, 0.5));
    values.pushBack(new BreathParameterData(this.bodyAngleXId, 0, 4, 15.5345, 0.5));
    values.pushBack(
      new BreathParameterData(
        CubismFramework.getIdManager().getId(CubismDefaultParameterId.ParamBreath),
        0.5,
        0.5,
        3.2345,
        1,
      ),
    );
    this._breath.setParameters(values);
  }

  private async loadOptionalDynamics(): Promise<void> {
    const generation = this.resourceGeneration;
    const isCurrent = (): boolean => !this.released && generation === this.resourceGeneration;
    const physics = this.setting.getPhysicsFileName();
    const pose = this.setting.getPoseFileName();
    const userData = this.setting.getUserDataFile();
    await Promise.all([
      physics && this.physicsEnabled
        ? this.resourceLoader
            .loadArrayBuffer(resolveResourceUrl(this.modelUrl, physics), this.resourceSignal)
            .then((buffer) => {
              if (isCurrent()) this.loadPhysics(buffer, buffer.byteLength);
            })
        : Promise.resolve(),
      pose
        ? this.resourceLoader
            .loadArrayBuffer(resolveResourceUrl(this.modelUrl, pose), this.resourceSignal)
            .then((buffer) => {
              if (isCurrent()) this.loadPose(buffer, buffer.byteLength);
            })
        : Promise.resolve(),
      userData
        ? this.resourceLoader
            .loadArrayBuffer(resolveResourceUrl(this.modelUrl, userData), this.resourceSignal)
            .then((buffer) => {
              if (isCurrent()) this.loadUserData(buffer, buffer.byteLength);
            })
        : Promise.resolve(),
    ]);
  }

  /** Build (once) a motion-name -> catalog location index from model3.json. */
  private buildMotionIndex(): Map<string, { group: string; index: number; file: string }> {
    if (this.motionIndex) return this.motionIndex;
    const map = new Map<string, { group: string; index: number; file: string }>();
    for (let groupIndex = 0; groupIndex < this.setting.getMotionGroupCount(); groupIndex += 1) {
      const group = this.setting.getMotionGroupName(groupIndex);
      for (let index = 0; index < this.setting.getMotionCount(group); index += 1) {
        const file = this.setting.getMotionFileName(group, index);
        if (file) map.set(fileStem(file), { group, index, file });
      }
    }
    this.motionIndex = map;
    return map;
  }

  /** Build (once) an expression-name -> catalog location index from model3.json. */
  private buildExpressionIndex(): Map<string, { index: number; file: string }> {
    if (this.expressionIndex) return this.expressionIndex;
    const map = new Map<string, { index: number; file: string }>();
    for (let index = 0; index < this.setting.getExpressionCount(); index += 1) {
      const name = this.setting.getExpressionName(index);
      const file = this.setting.getExpressionFileName(index);
      if (name && file) map.set(name, { index, file });
    }
    this.expressionIndex = map;
    return map;
  }

  /**
   * Lazily fetch + register a motion on first play, then start it. Cached in
   * `this.motions` so replays are instant. Deduped so concurrent plays load once.
   * Any failure (unknown name, fetch error, model released mid-load) is silent:
   * the character holds its current pose rather than breaking the scene.
   */
  private ensureMotion(name: string): Promise<CubismMotion | null> {
    if (this.released) return Promise.resolve(null);
    const loaded = this.motions.get(name);
    if (loaded) return Promise.resolve(loaded);
    const loading = this.loadingMotions.get(name);
    if (loading) return loading;
    const entry = this.buildMotionIndex().get(name);
    if (!entry) return Promise.resolve(null);
    if (!this.motionRetries.isDue(name)) return Promise.resolve(null);
    const generation = this.resourceGeneration;
    const task = (async (): Promise<CubismMotion | null> => {
      try {
        const buffer = await this.resourceLoader.loadArrayBuffer(
          resolveResourceUrl(this.modelUrl, entry.file),
          this.resourceSignal,
        );
        if (this.released || generation !== this.resourceGeneration) return null;
        const motion = this.loadMotion(
          buffer,
          buffer.byteLength,
          fileStem(entry.file),
          undefined,
          undefined,
          this.setting,
          entry.group,
          entry.index,
        );
        if (!motion) throw new Error(`Cubism motion ${name} could not be decoded`);
        motion.setEffectIds(this.eyeBlinkIds, this.lipSyncIds);
        this.motionFadeInTimes.set(name, motion.getFadeInTime());
        this.motions.set(name, motion);
        this.motionRetries.succeed(name);
        if (this.released || generation !== this.resourceGeneration) return null;
        const request = this.requestedMotion;
        if (request?.name === name) this.startMotionRequestWithRecovery(request);
        const loop = this.requestedParameterLoop;
        if (loop?.name === name) this.startParameterLoopRequest(loop);
        return motion;
      } catch (error) {
        this.recordResourceFailure("motion", name, error);
        return null;
      } finally {
        this.loadingMotions.delete(name);
      }
    })();
    this.loadingMotions.set(name, task);
    return task;
  }

  /** Lazily fetch + register an expression on first play, then start it. See ensureMotion. */
  private ensureExpression(name: string): Promise<CubismExpressionMotion | null> {
    if (this.released) return Promise.resolve(null);
    const loaded = this.expressions.get(name);
    if (loaded) return Promise.resolve(loaded);
    const loading = this.loadingExpressions.get(name);
    if (loading) return loading;
    const entry = this.buildExpressionIndex().get(name);
    if (!entry) return Promise.resolve(null);
    if (!this.expressionRetries.isDue(name)) return Promise.resolve(null);
    const generation = this.resourceGeneration;
    const task = (async (): Promise<CubismExpressionMotion | null> => {
      try {
        const buffer = await this.resourceLoader.loadArrayBuffer(
          resolveResourceUrl(this.modelUrl, entry.file),
          this.resourceSignal,
        );
        if (this.released || generation !== this.resourceGeneration) return null;
        const expression = this.loadExpression(buffer, buffer.byteLength, name) as CubismExpressionMotion | null;
        if (!expression) throw new Error(`Cubism expression ${name} could not be decoded`);
        this.expressionFadeInTimes.set(name, expression.getFadeInTime());
        this.expressions.set(name, expression);
        this.expressionRetries.succeed(name);
        if (this.released || generation !== this.resourceGeneration) return null;
        const request = this.requestedExpression;
        if (request?.name === name) this.startExpressionRequestWithRecovery(request);
        return expression;
      } catch (error) {
        this.recordResourceFailure("expression", name, error);
        return null;
      } finally {
        this.loadingExpressions.delete(name);
      }
    })();
    this.loadingExpressions.set(name, task);
    return task;
  }

  setPaused(paused: boolean): void {
    const next = Boolean(paused);
    const resuming = this.paused && !next;
    this.paused = next;
    if (!next && this.isInitialized()) {
      // Live2DCharacter.ResumeAnimation resets expression-authored parameter
      // values unconditionally (including a repeated Resume) before
      // dispatching any motion/expression queued by Pause.
      this.resetExpressionParametersToDefault();
    }
    if (!resuming) return;

    const motion = this.pausedMotionRequest.take();
    if (motion && this.requestedMotion?.sequence === motion.sequence) {
      if (this.motions.has(motion.name)) this.startMotionRequestWithRecovery(motion);
      else void this.ensureMotion(motion.name);
    }
    const expression = this.pausedExpressionRequest.take();
    if (expression && this.requestedExpression?.sequence === expression.sequence) {
      if (this.expressions.has(expression.name)) this.startExpressionRequestWithRecovery(expression);
      else void this.ensureExpression(expression.name);
    }
    const loop = this.pausedParameterLoopRequest.take();
    if (loop && this.requestedParameterLoop?.sequence === loop.sequence) this.startParameterLoopRequest(loop);
  }

  /** Show/Hide discard deferred requests while Resume consumes them. */
  clearPausedRequests(): void {
    const motion = this.pausedMotionRequest.take();
    if (motion && this.requestedMotion?.sequence === motion.sequence) {
      this.requestedMotion = null;
      this.motionRequestSequence++;
    }
    const expression = this.pausedExpressionRequest.take();
    if (expression && this.requestedExpression?.sequence === expression.sequence) {
      this.requestedExpression = null;
      this.expressionRequestSequence++;
    }
    const loop = this.pausedParameterLoopRequest.take();
    if (loop && this.requestedParameterLoop?.sequence === loop.sequence) {
      this.requestedParameterLoop = null;
      this.parameterLoopRequestSequence++;
    }
    const active = this.parameterLoop.capture();
    this.parameterLoopName = active && !active.stopping ? active.name : null;
  }

  /**
   * Reset loaded expression parameters on the saved motion baseline, then
   * refresh Core. Restoring the baseline first keeps repeated Resume calls
   * from accumulating late additive inputs in subsequent rendered frames.
   */
  resetExpressionParametersToDefault(): void {
    if (!this.isInitialized()) return;
    const resetIndices = new Set<number>();
    for (const expression of this.expressions.values()) {
      const parameters = expression.getExpressionParameters();
      for (let index = 0; index < parameters.getSize(); index += 1) {
        const parameterIndex = this.realParameterIndex(parameters.at(index).parameterId);
        if (parameterIndex != null) resetIndices.add(parameterIndex);
      }
    }
    resetCubismExpressionBaseline(this._model, resetIndices);
  }

  setEyeBlinkEnabled(enabled: boolean): void {
    this.eyeBlinkEnabled = enabled;
  }

  /**
   * Freeze authored motion/expression clocks and procedural animation without
   * touching the pause-time request slots. The standalone viewer combines this
   * with setAnimationTimeFrozen() when it needs a complete temporal snapshot.
   */
  setMotionClockFrozen(frozen: boolean): void {
    this.motionClockFrozen = Boolean(frozen);
  }

  /** Freeze every time-based effect for the standalone viewer's pose mode. */
  setAnimationTimeFrozen(
    frozen: boolean,
    snapshot?: { readonly parameters: readonly CubismParameterValue[]; readonly parts: readonly CubismPartValue[] },
  ): void {
    const next = Boolean(frozen);
    if (this.animationTimeFrozen === next && !snapshot) return;
    this.animationTimeFrozen = next;
    // Capture the composited pose once. Re-evaluating a zero-delta frame can
    // still alter physics outputs, pose links and expression blends.
    this.frozenParameters =
      next && this.isInitialized() ? Float32Array.from(this.parameterValues(), (parameter) => parameter.value) : null;
    this.frozenParts =
      next && this.isInitialized() ? Float32Array.from(this.partValues(), (part) => part.opacity) : null;
    // Context recovery restores a temporal snapshot without turning every
    // channel into a permanent manual override when animation resumes.
    if (next && snapshot && this.frozenParameters && this.frozenParts) {
      for (const parameter of snapshot.parameters) {
        const handle = this.parameterIds.get(parameter.id);
        const index = handle ? this.realParameterIndex(handle) : null;
        if (index != null && Number.isFinite(parameter.value)) this.frozenParameters[index] = parameter.value;
      }
      for (const part of snapshot.parts) {
        const index = this.authoredPartIndices.get(part.id);
        if (index != null && Number.isFinite(part.opacity)) {
          this.frozenParts[index] = Math.max(0, Math.min(1, part.opacity));
        }
      }
    }
  }

  /** Suppress only the controller's automatic default-idle restart. */
  setDefaultMotionRestartSuppressed(suppressed: boolean): void {
    this.defaultMotionRestartSuppressed = Boolean(suppressed);
  }

  /** Live2DCharacter.SetMotionSpeed: motion and auto-blink, not expression. */
  setMotionSpeed(speed: number): void {
    this.motionSpeed = Math.max(0.001, Number(speed) || 1);
  }

  get isMotionPlaying(): boolean {
    return !this._motionManager.isFinished();
  }

  /** True while the requested motion is still loading or playing. */
  get isMotionBusy(): boolean {
    if (!this.requestedMotion) return false;
    if (this.loadingMotions.has(this.requestedMotion.name)) return true;
    return !this._motionManager.isFinished();
  }

  hasMotion(name: string): boolean {
    return Boolean(name) && (this.motions.has(name) || this.buildMotionIndex().has(name));
  }

  stopMotions(): void {
    // A resource request can still be in flight after the visible queue stops.
    // Invalidate it so completion cannot resurrect an obsolete motion.
    if (this.requestedMotion) this.motionRetries.succeed(this.requestedMotion.name);
    this.requestedMotion = null;
    this.activeMotionName = "";
    this.pausedMotionRequest.clear();
    this.motionRequestSequence += 1;
    this._motionManager.stopAllMotions();
  }

  parameterValues(): CubismParameterValue[] {
    const values: CubismParameterValue[] = [];
    for (let index = 0; index < this._model.getParameterCount(); index += 1) {
      values.push({
        index,
        id: this._model.getParameterId(index).getString().s,
        value: this._model.getParameterValueByIndex(index),
        minimum: this._model.getParameterMinimumValue(index),
        maximum: this._model.getParameterMaximumValue(index),
        defaultValue: this._model.getParameterDefaultValue(index),
      });
    }
    return values;
  }

  viewerChannelMetadata(): AdvCubismViewerChannelMetadata {
    const eyeBlinkParameterIds: string[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < this.eyeBlinkIds.getSize(); index += 1) {
      const parameterIndex = this.realParameterIndex(this.eyeBlinkIds.at(index));
      if (parameterIndex == null) continue;
      const id = this._model.getParameterId(parameterIndex).getString().s;
      if (seen.has(id)) continue;
      seen.add(id);
      eyeBlinkParameterIds.push(id);
    }
    const breathIndex = this.realParameterIndex(this.standardBreathId);
    return {
      eyeBlinkParameterIds,
      standardBreathParameterId: breathIndex == null ? null : this._model.getParameterId(breathIndex).getString().s,
    };
  }

  partValues(): CubismPartValue[] {
    const values: CubismPartValue[] = [];
    for (let index = 0; index < this._model.getPartCount(); index += 1) {
      values.push({
        index,
        id: this._model.getPartId(index).getString().s,
        opacity: this._model.getPartOpacityByIndex(index),
      });
    }
    return values;
  }

  setPartOpacity(id: string, opacity: number): void {
    if (this.released || !Number.isFinite(opacity)) return;
    const index = this.authoredPartIndices.get(id);
    if (index == null) return;
    const value = Math.max(0, Math.min(1, opacity));
    this.partOpacityOverrides.set(index, value);
    this._model.setPartOpacityByIndex(index, value);
    if (this.frozenParts) this.frozenParts[index] = value;
  }

  drawableBounds(visibleOnly = true): CubismDrawableBounds | null {
    let minimumX = Infinity;
    let minimumY = Infinity;
    let maximumX = -Infinity;
    let maximumY = -Infinity;
    let vertexCount = 0;
    for (let drawableIndex = 0; drawableIndex < this._model.getDrawableCount(); drawableIndex += 1) {
      if (visibleOnly) {
        if (!this._model.getDrawableDynamicFlagIsVisible(drawableIndex)) continue;
        if (this._model.getDrawableOpacity(drawableIndex) <= 0.001) continue;
      }
      const vertices = this._model.getDrawableVertices(drawableIndex);
      for (let index = 0; index + 1 < vertices.length; index += 2) {
        const x = vertices[index];
        const y = vertices[index + 1];
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        minimumX = Math.min(minimumX, x);
        minimumY = Math.min(minimumY, y);
        maximumX = Math.max(maximumX, x);
        maximumY = Math.max(maximumY, y);
        vertexCount += 1;
      }
    }
    const width = maximumX - minimumX;
    const height = maximumY - minimumY;
    if (vertexCount === 0 || width <= 0 || height <= 0) return null;
    return { x: minimumX, y: minimumY, width, height };
  }

  canvasBounds(): CubismDrawableBounds {
    const width = Math.max(0.001, this._model.getCanvasWidth());
    const height = Math.max(0.001, this._model.getCanvasHeight());
    return { x: -width * 0.5, y: -height * 0.5, width, height };
  }

  get pixelsPerUnit(): number {
    return this.pixelsPerUnitValue;
  }

  get motionSyncStatus(): AdvMotionSyncCoreStatus | "unconfigured" {
    return this.motionSync?.status ?? "unconfigured";
  }

  resetMotionSync(): void {
    this.motionSync?.reset();
  }

  playMotion(name: string, fadeInSeconds?: number): boolean {
    return this.requestMotion(name, fadeInSeconds);
  }

  playParameterLoopMotion(name: string, fadeInSeconds?: number): boolean {
    if (!this.hasMotion(name)) return false;
    this.parameterLoopName = name;
    const request: CubismPlaybackRequest = {
      name,
      fadeInSeconds,
      sequence: ++this.parameterLoopRequestSequence,
    };
    this.requestedParameterLoop = request;
    return this.startParameterLoopRequest(request);
  }

  /** Stop retires only the independent parameter channel. */
  stopParameterLoopMotion(fadeSeconds?: number): void {
    this.parameterLoopName = null;
    const request: CubismPlaybackRequest = {
      name: "",
      fadeInSeconds: fadeSeconds,
      sequence: ++this.parameterLoopRequestSequence,
    };
    this.requestedParameterLoop = request;
    this.startParameterLoopRequest(request);
  }

  private startParameterLoopRequest(request: CubismPlaybackRequest): boolean {
    if (this.released || this.requestedParameterLoop?.sequence !== request.sequence) return false;
    if (this.paused) {
      this.pausedParameterLoopRequest.retain(request);
      if (request.name && !this.motions.has(request.name)) void this.ensureMotion(request.name);
      return false;
    }
    if (this.activeParameterLoopSequence === request.sequence) return true;
    if (!request.name) {
      this.parameterLoop.stop(this._model, request.fadeInSeconds);
      this.activeParameterLoopSequence = request.sequence;
      return true;
    }
    const motion = this.motions.get(request.name);
    if (!motion) {
      void this.ensureMotion(request.name);
      return false;
    }
    if (!this.parameterLoop.play(this._model, request.name, motion, request.fadeInSeconds)) return false;
    this.activeParameterLoopSequence = request.sequence;
    return true;
  }

  createSnapshot(): unknown {
    const pending = this.pausedParameterLoopRequest.peek();
    const request = this.requestedParameterLoop;
    return {
      kind: "cubism3-parameter-loop-v1",
      loop: this.parameterLoop.capture(),
      pending: pending ? { name: pending.name, fadeInSeconds: pending.fadeInSeconds } : null,
      request:
        !pending && request && request.sequence !== this.activeParameterLoopSequence
          ? { name: request.name, fadeInSeconds: request.fadeInSeconds }
          : null,
    };
  }

  async restoreSnapshot(input: unknown): Promise<void> {
    const snapshot = input as {
      kind: string;
      loop: CubismParameterLoopSnapshot | null;
      pending: { name: string; fadeInSeconds?: number } | null;
      request?: { name: string; fadeInSeconds?: number } | null;
    };
    if (snapshot?.kind !== "cubism3-parameter-loop-v1") throw new TypeError("cubism_parameter_loop_snapshot");
    this.requestedParameterLoop = null;
    this.pausedParameterLoopRequest.clear();
    const sequence = ++this.parameterLoopRequestSequence;
    if (snapshot.loop) {
      for (const key of ["phase", "weight", "fadeStart", "fadeTarget", "fadeElapsed", "fadeDuration"] as const) {
        if (!Number.isFinite(snapshot.loop[key])) throw new TypeError("cubism_parameter_loop_snapshot_clock");
      }
      const motion = await this.ensureMotion(snapshot.loop.name);
      if (this.released || sequence !== this.parameterLoopRequestSequence) return;
      if (!motion) throw new Error(`cubism_parameter_loop_resource:${snapshot.loop.name}`);
      this.parameterLoop.restore(this._model, motion, snapshot.loop);
      this.parameterLoopName = snapshot.loop.stopping ? null : snapshot.loop.name;
    } else {
      this.parameterLoop.stopImmediately(this._model);
      this.parameterLoopName = null;
    }
    if (snapshot.pending) {
      this.requestedParameterLoop = { ...snapshot.pending, sequence };
      this.pausedParameterLoopRequest.retain(this.requestedParameterLoop);
    } else if (snapshot.request) {
      this.requestedParameterLoop = { ...snapshot.request, sequence };
      this.startParameterLoopRequest(this.requestedParameterLoop);
    }
    this._model.update();
    this.updateSerialValue++;
  }

  restoreParameterLoopTimeline(timeline: CubismParameterLoopTimeline): void | Promise<void> {
    const sequence = ++this.parameterLoopRequestSequence;
    this.requestedParameterLoop = null;
    this.pausedParameterLoopRequest.clear();
    const names = new Set(
      timeline.events.flatMap((event) => (event.kind === "loop" && event.name ? [event.name] : [])),
    );
    if ([...names].every((name) => this.motions.has(name))) {
      this.projectParameterLoopTimeline(timeline, sequence);
      return;
    }
    return Promise.all([...names].map((name) => this.ensureMotion(name))).then(() =>
      this.projectParameterLoopTimeline(timeline, sequence),
    );
  }

  private projectParameterLoopTimeline(timeline: CubismParameterLoopTimeline, sequence: number): void {
    if (this.released || sequence !== this.parameterLoopRequestSequence) return;
    const values = new Float32Array(this._model.getParameterCount());
    for (let index = 0; index < values.length; index++) values[index] = this._model.getParameterValueByIndex(index);
    this.parameterLoop.stopImmediately(this._model);
    let at = timeline.events[0]?.atSeconds ?? timeline.atSeconds;
    let paused = false;
    let rate = 1;
    let pending: Extract<CubismParameterLoopTimeline["events"][number], { kind: "loop" }> | null = null;
    const apply = (event: NonNullable<typeof pending>): void => {
      if (!event.name) this.parameterLoop.stop(this._model, event.fadeSeconds);
      else {
        const motion = this.motions.get(event.name);
        if (!motion) throw new Error(`cubism_parameter_loop_resource:${event.name}`);
        this.parameterLoop.play(this._model, event.name, motion, event.fadeSeconds);
      }
    };
    for (const event of timeline.events) {
      if (!paused) this.parameterLoop.advance(this._model, Math.max(0, event.atSeconds - at) * rate);
      at = event.atSeconds;
      if (event.kind === "loop") {
        if (paused) pending = event;
        else apply(event);
      } else if (event.kind === "pause") {
        paused = event.paused;
        if (!paused && pending) {
          apply(pending);
          pending = null;
        }
      } else if (event.kind === "speed") {
        rate = event.rate;
      } else {
        paused = false;
        pending = null;
      }
    }
    if (!paused) this.parameterLoop.advance(this._model, Math.max(0, timeline.atSeconds - at) * rate);
    const state = this.parameterLoop.capture();
    this.parameterLoopName = state && !state.stopping ? state.name : null;
    if (pending) {
      this.requestedParameterLoop = { name: pending.name, fadeInSeconds: pending.fadeSeconds, sequence };
      this.pausedParameterLoopRequest.retain(this.requestedParameterLoop);
    }
    for (let index = 0; index < values.length; index++) this._model.setParameterValueByIndex(index, values[index]);
    this.parameterLoop.apply(this._model);
    this._model.update();
    this.updateSerialValue++;
  }

  /** AdvCharacterController.SetEyeBlinkStopped(stopped, transition = 0.2 s). */
  setEyeBlinkStopped(stopped: boolean, transitionSeconds = 0): void {
    if (!stopped) {
      if (!this.eyeBlinkStopped) return;
      this.eyeBlinkStopped = false;
      this.eyeBlinkEnabled = this.eyeBlinkBeforeStopEnabled;
      this.eyeBlinkStopElapsed = this.eyeBlinkStopDuration = 0;
      return;
    }
    const duration = Math.max(0, Number.isFinite(transitionSeconds) ? transitionSeconds : 0);
    if (this.eyeBlinkStopped) {
      if (duration === 0) this.eyeBlinkStopElapsed = this.eyeBlinkStopDuration = 0;
      return;
    }
    this.eyeBlinkBeforeStopEnabled = this.eyeBlinkEnabled;
    this.eyeBlinkEnabled = false;
    this.eyeBlinkStopped = true;
    this.eyeBlinkStopStartOpening = this.eyeBlinkOpening;
    this.eyeBlinkStopElapsed = 0;
    this.eyeBlinkStopDuration = duration;
  }

  /** Restore an authored motion at an absolute clip-local transport phase. */
  playMotionAt(
    name: string,
    positionSeconds: number,
    fadeInSeconds?: number,
    positionOptions: AdvCubismMotionPositionOptions = {},
  ): boolean {
    return this.requestMotion(name, fadeInSeconds, positionSeconds, positionOptions);
  }

  private requestMotion(
    name: string,
    fadeInSeconds?: number,
    positionSeconds?: number,
    positionOptions?: AdvCubismMotionPositionOptions,
  ): boolean {
    if (!name || (!this.motions.has(name) && !this.buildMotionIndex().has(name))) return false;
    if (this.requestedMotion?.name && this.requestedMotion.name !== name) {
      this.motionRetries.succeed(this.requestedMotion.name);
    }
    const request: CubismPlaybackRequest = {
      sequence: ++this.motionRequestSequence,
      name,
      fadeInSeconds,
      positionSeconds,
      positionOptions,
    };
    this.requestedMotion = request;
    if (this.paused) {
      this.pausedMotionRequest.retain(request);
      if (!this.motions.has(name)) void this.ensureMotion(name);
      return false;
    }
    const motion = this.motions.get(name);
    if (motion) return this.startMotionRequestWithRecovery(request);
    // Not loaded yet: fetch on demand and start once resolved. The rolling
    // preload warms likely-soon motions, so this is usually a cache hit. Loading
    // Completion must consult requestedMotion. Native PlayMotion dispatch is
    // synchronous, so a later call always owns the channel; its single pause
    // pending slot confirms the same overwrite rule. Browser fetch completion
    // order is not.
    void this.ensureMotion(name);
    return false;
  }

  playExpression(name: string, fadeInSeconds?: number): boolean {
    if (!name || (!this.expressions.has(name) && !this.buildExpressionIndex().has(name))) return false;
    if (this.requestedExpression?.name && this.requestedExpression.name !== name) {
      this.expressionRetries.succeed(this.requestedExpression.name);
    }
    const request: CubismPlaybackRequest = {
      sequence: ++this.expressionRequestSequence,
      name,
      fadeInSeconds,
    };
    this.requestedExpression = request;
    if (this.paused) {
      this.pausedExpressionRequest.retain(request);
      if (!this.expressions.has(name)) void this.ensureExpression(name);
      return false;
    }
    const expression = this.expressions.get(name);
    if (expression) return this.startExpressionRequestWithRecovery(request);
    // Expression dispatch and its pause pending slot use the same single-channel
    // overwrite rule. A stale lazy load must never overwrite a later face.
    void this.ensureExpression(name);
    return false;
  }

  isCurrentExpression(name: string): boolean {
    return Boolean(name && this.requestedExpression?.name === name);
  }

  /** Refresh the controller field used by a duplicate expression request. */
  refreshCurrentExpressionFadeIn(name: string, fadeInSeconds?: number): void {
    if (!name || this.requestedExpression?.name !== name) return;
    this.requestedExpression = { ...this.requestedExpression, fadeInSeconds };
  }

  /** Parse a lazy motion before a character becomes render-visible. */
  async prepareMotion(name: string): Promise<boolean> {
    if (!name) return false;
    return Boolean(await this.ensureMotion(name));
  }

  /** Parse a lazy expression before a character becomes render-visible. */
  async prepareExpression(name: string): Promise<boolean> {
    if (!name) return false;
    return Boolean(await this.ensureExpression(name));
  }

  private startMotionRequest(request: CubismPlaybackRequest): boolean {
    if (this.released || this.requestedMotion?.sequence !== request.sequence) return false;
    if (this.paused) {
      // A lazy request may have started before Pause and completed during it.
      // Route that completion through the same single resume slot.
      this.pausedMotionRequest.retain(request);
      return false;
    }
    const motion = this.motions.get(request.name);
    if (!motion) return false;
    motion.setFadeInTime(resolveCubismFadeIn(request.fadeInSeconds, this.motionFadeInTimes.get(request.name)));
    motion.setLoop(false);
    motion.setLoopFadeIn(true);
    const handle = this._motionManager.startMotionPriority(motion, false, MOTION_PRIORITY_FORCE);
    this.activeMotionName = request.name;
    if (request.positionSeconds != null) {
      const entry = this._motionManager.getCubismMotionQueueEntry(handle);
      if (!entry) return false;
      positionAdvCubismMotionQueueEntry(
        entry,
        motion,
        this._motionManager._userTimeSeconds,
        request.positionSeconds,
        request.positionOptions,
      );
    }
    return true;
  }

  private startMotionRequestWithRecovery(request: CubismPlaybackRequest): boolean {
    try {
      const started = this.startMotionRequest(request);
      if (started) this.motionRetries.succeed(request.name);
      return started;
    } catch (error) {
      this.recordResourceFailure("motion", request.name, error);
      return false;
    }
  }

  private startExpressionRequest(request: CubismPlaybackRequest): boolean {
    if (this.released || this.requestedExpression?.sequence !== request.sequence) return false;
    if (this.paused) {
      this.pausedExpressionRequest.retain(request);
      return false;
    }
    const expression = this.expressions.get(request.name);
    if (!expression) return false;
    expression.setFadeInTime(resolveCubismFadeIn(request.fadeInSeconds, this.expressionFadeInTimes.get(request.name)));
    this._expressionManager.startMotion(expression, false);
    return true;
  }

  private startExpressionRequestWithRecovery(request: CubismPlaybackRequest): boolean {
    try {
      const started = this.startExpressionRequest(request);
      if (started) this.expressionRetries.succeed(request.name);
      return started;
    } catch (error) {
      this.recordResourceFailure("expression", request.name, error);
      return false;
    }
  }

  private recordResourceFailure(channel: "motion" | "expression", name: string, error: unknown): void {
    if (this.released || this.resourceSignal?.aborted) return;
    const schedule = channel === "motion" ? this.motionRetries : this.expressionRetries;
    const attempt = schedule.fail(name);
    if (attempt === 1 || (attempt & (attempt - 1)) === 0) {
      console.warn(`[AdvCubismModel] ${channel} ${name} failed (attempt ${attempt}); retrying`, error);
    }
  }

  /** Unscaled resource housekeeping, independent of authored pose evaluation. */
  pollResourceReadiness(): void {
    if (this.isInitialized()) this.retryRequestedResources();
  }

  private retryRequestedResources(): void {
    if (this.motionRetries.empty && this.expressionRetries.empty) return;
    const now = cubismRetryClockSeconds();
    const motion = this.requestedMotion;
    if (
      motion &&
      this.motionRetries.has(motion.name) &&
      this.motionRetries.isDue(motion.name, now) &&
      !this.loadingMotions.has(motion.name)
    ) {
      if (this.motions.has(motion.name)) this.startMotionRequestWithRecovery(motion);
      else void this.ensureMotion(motion.name);
    }
    const expression = this.requestedExpression;
    if (
      expression &&
      this.expressionRetries.has(expression.name) &&
      this.expressionRetries.isDue(expression.name, now) &&
      !this.loadingExpressions.has(expression.name)
    ) {
      if (this.expressions.has(expression.name)) this.startExpressionRequestWithRecovery(expression);
      else void this.ensureExpression(expression.name);
    }
    const loop = this.requestedParameterLoop;
    if (
      loop?.name &&
      this.motionRetries.has(loop.name) &&
      this.motionRetries.isDue(loop.name, now) &&
      !this.loadingMotions.has(loop.name)
    ) {
      this.startParameterLoopRequest(loop);
    }
  }

  /**
   * Evaluate motion/expression time zero before a newly loaded character can
   * enter the render list. Unity exposes the same immediate lifecycle escape
   * hatch as Live2DCharacter.ForceUpdateNow. Passing the complete frame also
   * prevents default mouth/breath values from becoming visible.
   */
  primeInitialFrame(frame: CubismParameterFrame): void {
    this.update(0, frame);
  }

  setParameter(id: string, value: number, weight = 1): void {
    if (this.released || !Number.isFinite(value) || !Number.isFinite(weight)) return;
    const handle = this.parameterIds.get(id);
    const index = handle ? this.realParameterIndex(handle) : null;
    if (index != null) this._model.setParameterValueByIndex(index, value, weight);
  }

  eyeBallPosition(): { x: number; y: number } {
    return {
      x: this._model.getParameterValueById(this.eyeBallXId),
      y: this._model.getParameterValueById(this.eyeBallYId),
    };
  }

  setEyeBallPosition(x: number, y: number): void {
    this._model.setParameterValueById(this.eyeBallXId, x);
    this._model.setParameterValueById(this.eyeBallYId, y);
  }

  /** SmoothChangeToLook(duration <= 0) calls ForceUpdateNow immediately. */
  forceEyeBallPosition(x: number, y: number): void {
    this.setEyeBallPosition(x, y);
    this._model.update();
  }

  parameterRange(id: string): { minimum: number; maximum: number } | null {
    if (this.released) return null;
    const handle = this.parameterIds.get(id);
    const index = handle ? this.realParameterIndex(handle) : null;
    if (index == null) return null;
    return {
      minimum: this._model.getParameterMinimumValue(index),
      maximum: this._model.getParameterMaximumValue(index),
    };
  }

  private realParameterIndex(handle: CubismIdHandle): number | null {
    return this.authoredParameterIndices.get(handle) ?? null;
  }

  private applyMotionSync(source: AdvVoiceMotionSyncPcmSnapshot, deltaSeconds: number, weight: number): void {
    const adapter = this.motionSync;
    if (!adapter || adapter.status !== "ready") return;
    const output = adapter.updateReusable(this._model, source, deltaSeconds);
    if (!output) return;
    for (const id in output.values) {
      if (!Object.hasOwn(output.values, id)) continue;
      const analyzedValue = output.values[id];
      let handle = this.parameterIds.get(id);
      if (!handle) {
        handle = CubismFramework.getIdManager().getId(id);
        this.parameterIds.set(id, handle);
      }
      const index = this.realParameterIndex(handle);
      if (index == null) continue;
      const baseValue = this._model.getParameterValueByIndex(index);
      this._model.setParameterValueByIndex(
        index,
        applyAdvMotionSyncOnCapturedBase(
          baseValue,
          analyzedValue,
          adapter.neutralValue(id),
          this._model.getParameterMinimumValue(index),
          this._model.getParameterMaximumValue(index),
          weight,
        ),
      );
    }
  }

  update(deltaSeconds: number, frame: CubismParameterFrame): void {
    if (!this.isOperational) return;
    this.retryRequestedResources();
    if (this.animationTimeFrozen && this.frozenParameters) {
      for (let index = 0; index < this.frozenParameters.length; index += 1) {
        this._model.setParameterValueByIndex(index, this.frozenParameters[index]);
      }
      for (let index = 0; index < (this.frozenParts?.length ?? 0); index += 1) {
        this._model.setPartOpacityByIndex(index, this.frozenParts![index]);
      }
      for (const id in frame.overrides) {
        if (Object.hasOwn(frame.overrides, id)) this.setParameter(id, frame.overrides[id]);
      }
      this._model.update();
      this.updateSerialValue += 1;
      return;
    }
    if (this.paused) return;
    const delta = Math.max(0, Math.min(0.1, Number(deltaSeconds) || 0));
    const effectDelta = this.animationTimeFrozen ? 0 : delta;
    this.elapsedSeconds += effectDelta;
    if (this.eyeBlinkStopped && this.eyeBlinkStopElapsed < this.eyeBlinkStopDuration)
      this.eyeBlinkStopElapsed += effectDelta * this.motionSpeed;
    const motionDelta = this.motionClockFrozen || this.animationTimeFrozen ? 0 : delta * this.motionSpeed;
    this.parameterLoop.advance(this._model, motionDelta);
    this._model.loadParameters();
    // loadParameters restored the pre-ADV saved frame, including removal of
    // the additive values retained from the preceding rendered frame.
    // Role Pause returns before any simulation. Explicit viewer pose mode
    // above can still install manually edited parameters on a captured frame.
    const motionUpdated = this._motionManager.updateMotion(this._model, motionDelta);
    this.neutralizeDefaultMotionEyeBlink();
    this._model.saveParameters();
    this._pose?.updateParameters(this._model, effectDelta);
    this._expressionManager.updateMotion(
      this._model,
      this.paused || this.motionClockFrozen || this.animationTimeFrozen ? 0 : delta,
    );
    this.parameterLoop.apply(this._model);
    // PlayMotion disables AutoEyeBlinkInput for an ordinary authored motion,
    // while Idle immediately restores the controller's configured blink flag
    // after starting DefaultMotionName. The default clip is finite and gets
    // restarted below, so basing this only on motionUpdated would suppress
    // every idle blink and make the eyes look permanently posed.
    const defaultIdleIsUpdating = Boolean(this.defaultMotionName) && this.activeMotionName === this.defaultMotionName;
    this.applyMultiplicativeEyeBlink(
      effectDelta,
      this.eyeBlinkEnabled &&
        !this.motionClockFrozen &&
        !this.animationTimeFrozen &&
        ((!this.defaultMotionName && !motionUpdated) || defaultIdleIsUpdating),
    );

    // Cubism's interactive focus is additive: eyes lead, the head follows over
    // the full authored angle range, and the body turns at one third strength.
    // This matches the official sample/pixi-live2d-display focus mapping while
    // leaving authored motion and expression curves intact.
    if (frame.focusX != null || frame.focusY != null) {
      const focusX = Math.max(-1, Math.min(1, Number(frame.focusX) || 0));
      const focusY = Math.max(-1, Math.min(1, Number(frame.focusY) || 0));
      this._model.addParameterValueById(this.eyeBallXId, focusX);
      this._model.addParameterValueById(this.eyeBallYId, focusY);
      this._model.addParameterValueById(this.angleXId, focusX * 30);
      this._model.addParameterValueById(this.angleYId, focusY * 30);
      this._model.addParameterValueById(this.angleZId, focusX * focusY * -30);
      this._model.addParameterValueById(this.bodyAngleXId, focusX * 10);
    }

    if (frame.motionSyncPcm && this.motionSync?.status === "ready") {
      // The game's managed MotionSync path captures motion/expression values,
      // analyzes PCM, then adds the viseme delta over that captured base.
      const motionSyncWeight = Number(frame.motionSyncWeight);
      this.applyMotionSync(
        frame.motionSyncPcm,
        effectDelta,
        Math.max(0, Number.isFinite(motionSyncWeight) ? motionSyncWeight : 1),
      );
    } else {
      if (frame.mouthOpenY != null) this._model.setParameterValueById(this.mouthOpenYId, frame.mouthOpenY);
      if (frame.mouthForm != null) this._model.setParameterValueById(this.mouthFormId, frame.mouthForm);
    }
    const overrides = frame.overrides;
    // Harmonic-motion blends are applied before the model-owned procedural
    // channels. Host overrides are intentionally installed below those
    // channels, immediately before the late ADV path, so a posed parameter
    // remains absolute even when physics or Cubism pose evaluation runs with
    // a zero delta during a frozen frame.
    for (const blend of frame.blends || []) {
      let handle = this.parameterIds.get(blend.id);
      if (!handle) {
        handle = CubismFramework.getIdManager().getId(blend.id);
        this.parameterIds.set(blend.id, handle);
      }
      if (blend.mode === 1) this._model.addParameterValueById(handle, blend.value, 1);
      else if (blend.mode === 2) this._model.multiplyParameterValueById(handle, blend.value, 1);
      else this._model.setParameterValueById(handle, blend.value, 1);
    }
    this._breath?.updateParameters(this._model, effectDelta);
    this._physics?.evaluate(this._model, effectDelta);

    if (overrides) {
      for (const id in overrides) {
        if (Object.hasOwn(overrides, id)) this.setParameter(id, overrides[id]);
      }
    }

    this.applyLateAdvOverrides(frame);
    for (const [index, opacity] of this.partOpacityOverrides) {
      this._model.setPartOpacityByIndex(index, opacity);
    }
    this._model.update();
    this.updateSerialValue += 1;

    // Live2DCharacterController.OnUpdate calls HandlingLoopMotion as soon as
    // the active Cubism clip finishes.  That path compares CurrentMotionName
    // with Live2DCharacter.DefaultMotionName and, only for the default clip,
    // calls Idle(0) to restart it.  The authored idle motion3.json files are
    // finite (Loop=false), so omitting this controller lifecycle leaves a
    // character permanently on the idle clip's last frame after a few seconds.
    // Non-default motions intentionally keep their native final-frame hold.
    if (
      !this.paused &&
      !this.motionClockFrozen &&
      !this.animationTimeFrozen &&
      !this.defaultMotionRestartSuppressed &&
      this.defaultMotionName &&
      this.motions.has(this.defaultMotionName) &&
      this.requestedMotion?.name === this.defaultMotionName &&
      this._motionManager.isFinished()
    ) {
      this.playMotion(this.defaultMotionName, 0);
    }
  }

  private get eyeBlinkStopWeight(): number {
    return this.eyeBlinkStopDuration > 0
      ? Math.max(0, Math.min(1, this.eyeBlinkStopElapsed / this.eyeBlinkStopDuration))
      : 1;
  }

  private defaultMotionOverridesEyeTargets(motion: CubismMotion, entry: CubismMotionQueueEntry): boolean {
    if (entry.getStateWeight() < 1) return false;
    let curves = this.defaultEyeFadeCurves.get(motion);
    if (!curves) {
      curves = this.eyeBlinkNeutralizeTargets.map(({ id }) => {
        for (let index = 0; index < motion._motionData.curveCount; index += 1) {
          const curve = motion._motionData.curves.at(index);
          if (curve.type === CubismMotionCurveTarget.CubismMotionCurveTarget_Parameter && curve.id === id)
            return { fadeIn: curve.fadeInTime, fadeOut: curve.fadeOutTime };
        }
        return null;
      });
      this.defaultEyeFadeCurves.set(motion, curves);
    }
    const elapsed = this._motionManager._userTimeSeconds - entry.getFadeInStartTime();
    for (const curve of curves) {
      if (!curve || (curve.fadeIn >= 0 && elapsed < curve.fadeIn)) return false;
      // Unity's per-parameter gate subtracts clip elapsed, independently of
      // the global fade weight checked above.
      const remaining = entry.getEndTime() - elapsed;
      if (curve.fadeOut >= 0 && remaining >= 0 && remaining < curve.fadeOut) return false;
    }
    return true;
  }

  /** EyeBlinkStopNeutralizer runs immediately before ParameterStore.Save. */
  private neutralizeDefaultMotionEyeBlink(): void {
    if (
      !this.eyeBlinkStopped ||
      !this.defaultMotionName ||
      this.activeMotionName !== this.defaultMotionName ||
      this.eyeBlinkNeutralizeTargets.length === 0
    )
      return;
    const defaultMotion = this.motions.get(this.defaultMotionName);
    if (!defaultMotion) return;
    const entries = this._motionManager.getCubismMotionQueueEntries();
    let hasOtherMotion = false;
    let latestDefault: CubismMotionQueueEntry | null = null;
    for (let index = 0; index < entries.getSize(); index += 1) {
      const entry = entries.at(index);
      if (!entry || !entry.isAvailable() || entry.isFinished()) continue;
      if (entry._motion === defaultMotion) latestDefault = entry;
      else hasOtherMotion = true;
    }
    if (hasOtherMotion && (!latestDefault || !this.defaultMotionOverridesEyeTargets(defaultMotion, latestDefault)))
      return;
    const weight = this.eyeBlinkStopWeight;
    for (const target of this.eyeBlinkNeutralizeTargets) {
      const value = this._model.getParameterValueByIndex(target.index);
      this._model.setParameterValueByIndex(target.index, value + (target.defaultValue - value) * weight);
    }
  }

  private applyMultiplicativeEyeBlink(deltaSeconds: number, canStartBlink: boolean): void {
    if (!this._eyeBlink) return;
    const phase = this._eyeBlink._blinkingState;
    const blinkInProgress =
      phase === EyeState.EyeState_Closing || phase === EyeState.EyeState_Closed || phase === EyeState.EyeState_Opening;
    // Native IsBlinking is consulted only by UpdateEyeBlinkIdling
    // (0x835c174). PlayMotion clears it, but a blink already in its closing,
    // closed or opening phase continues until the eyes are fully open.
    if (!this.eyeBlinkStopped && !canStartBlink && !blinkInProgress) return;
    const count = this.eyeBlinkIds.getSize();
    this.eyeBlinkBaseValues.length = count;
    for (let index = 0; index < count; index += 1) {
      this.eyeBlinkBaseValues[index] = this._model.getParameterValueById(this.eyeBlinkIds.at(index));
    }
    // The Web SDK helper writes its sampled opening as an absolute value.
    // Native CubismAutoEyeBlinkInput is BlendMode.Multiply, so capture that
    // sample and reapply it over every motion/expression-authored eye value.
    if (this.eyeBlinkStopped) {
      this.eyeBlinkOpening =
        this.eyeBlinkStopStartOpening + this.eyeBlinkStopWeight * (1 - this.eyeBlinkStopStartOpening);
    } else {
      this._eyeBlink.updateParameters(this._model, deltaSeconds, this.motionSpeed);
      this.eyeBlinkOpening = count > 0 ? this._model.getParameterValueById(this.eyeBlinkIds.at(0)) : 1;
    }
    for (let index = 0; index < count; index += 1) {
      const id = this.eyeBlinkIds.at(index);
      this._model.setParameterValueById(id, this.eyeBlinkBaseValues[index] * this.eyeBlinkOpening);
    }
  }

  private applyLateAdvOverrides(frame: CubismParameterFrame): void {
    // Live2DCharacter.OnLateUpdateInternal applies ADV Angle and Look after
    // motion, harmonic motion, breath, physics and pose. Role Pause skips the
    // complete update. Angle is additive (SetOverrideAngleEnabled(true, true)); Look is a
    // final absolute eye parameter. Cubism setters clamp to each authored range.
    const angleXIndex = this.realParameterIndex(this.angleXId);
    if (frame.angleX != null && angleXIndex != null) {
      this._model.addParameterValueByIndex(angleXIndex, frame.angleX);
    }
    if (frame.bodyAngleX != null) {
      const addIndex = this.realParameterIndex(this.bodyAngleXAddId);
      if (addIndex != null) {
        this._model.setParameterValueByIndex(addIndex, frame.bodyAngleX);
      } else {
        const bodyIndex = this.realParameterIndex(this.bodyAngleXId);
        if (bodyIndex != null) {
          this._model.addParameterValueByIndex(bodyIndex, frame.bodyAngleX);
        }
      }
    }
    const eyeBallXIndex = this.realParameterIndex(this.eyeBallXId);
    const eyeBallYIndex = this.realParameterIndex(this.eyeBallYId);
    if (frame.lookX != null && eyeBallXIndex != null) {
      this._model.setParameterValueByIndex(eyeBallXIndex, frame.lookX);
    }
    if (frame.lookY != null && eyeBallYIndex != null) {
      this._model.setParameterValueByIndex(eyeBallYIndex, frame.lookY);
    }
  }

  draw(
    mvp: Matrix4Like,
    framebuffer: WebGLFramebuffer | null,
    viewport: readonly [number, number, number, number],
    color: readonly [number, number, number, number],
    drawState: AdvCubismDrawState = {},
  ): void {
    if (!this.isOperational) return;
    // CubismMatrix44.setMatrix copies its input, while Matrix4.elements is
    // already the required 16-value column-major sequence. Copy directly into
    // the model-owned storage instead of allocating a Float32Array per draw.
    this.mvp.getArray().set(mvp.elements);
    const renderer = this.getRenderer();
    renderer.setMvpMatrix(this.mvp);
    renderer.setModelColor(color[0], color[1], color[2], color[3]);
    const objectToWorld = drawState.objectToWorld
      ? threeMatrix4ToUnity(drawState.objectToWorld, this.unityObjectToWorld).elements
      : IDENTITY_MATRIX;
    renderer.setUnityAdvDrawState(objectToWorld, drawState.timeSeconds ?? this.elapsedSeconds);
    // Cubism consumes the viewport synchronously during drawModel and never
    // mutates it. Keep the post-pipeline's stable tuple instead of cloning it
    // for every character draw.
    renderer.setRenderState(framebuffer as WebGLFramebuffer, viewport as unknown as number[]);
    // Both ThreeStoryScene and CubismModelViewer put an explicit resetState /
    // default-VAO boundary around this synchronous draw. Avoid the SDK's
    // generic profile save/restore, whose many getParameter/isEnabled queries
    // otherwise stall the driver once per character per frame.
    renderer.drawModelWithoutStatePreservation();
    this.drawSerialValue += 1;
  }

  setUnityLighting(state: UnityCubismLightingState): void {
    if (this.released) return;
    this.getRenderer().setUnityAdvLightingState(state);
  }

  setUnityMultiplyTexture(texture: WebGLTexture | null, options: AdvCubismMultiplyTextureOptions = {}): void {
    if (this.released) return;
    const renderer = this.getRenderer();
    const current = renderer.getUnityAdvMultiplyTextureParameters();
    const parameters: UnityCubismMultiplyTextureParameters = {
      enabled: options.enabled ?? true,
      uv: options.uv ?? current.uv,
      intensity: options.intensity ?? current.intensity,
      amplitude: options.amplitude ?? current.amplitude,
      frequency: options.frequency ?? current.frequency,
    };
    renderer.setUnityAdvMultiplyTexture(texture ?? this.multiplyFallbackTexture, parameters);
  }

  clearUnityMultiplyTexture(): void {
    if (this.released) return;
    this.getRenderer().setUnityAdvMultiplyTexture(this.multiplyFallbackTexture, DEFAULT_UNITY_CUBISM_MULTIPLY_TEXTURE);
  }

  async loadUnityMultiplyTexture(url: string, options: AdvCubismMultiplyTextureOptions = {}): Promise<void> {
    const generation = this.resourceGeneration;
    const { texture, flipY } = await createCubismTexture(this.gl, url, 1, this.resourceLoader, this.resourceSignal);
    if (flipY) {
      this.deleteGpuTexture(texture);
      throw new Error("Multiply textures require top-left texture orientation");
    }
    // createCubismTexture allocates before this async caller regains control, so
    // release the texture if the model was torn down while it was loading.
    if (this.released || generation !== this.resourceGeneration) {
      this.deleteGpuTexture(texture);
      return;
    }
    this.deleteGpuTexture(this.ownedMultiplyTexture);
    this.ownedMultiplyTexture = texture;
    this.setUnityMultiplyTexture(texture, options);
  }

  private deleteGpuTexture(texture: WebGLTexture | null): void {
    // Context loss already reclaimed this generation's GPU storage. A restored
    // context rejects its old handles even though isContextLost() is now false.
    if (texture && !this.gpuContextInvalidated && !this.gl.isContextLost()) this.gl.deleteTexture(texture);
  }

  override release(): void {
    if (this.released) return;
    this.released = true;
    const errors: unknown[] = [];
    const cleanup = (action: () => void): void => {
      try {
        action();
      } catch (error) {
        errors.push(error);
      }
    };
    try {
      cleanup(() => this.gl.canvas?.removeEventListener("webglcontextlost", this.handleContextLost));
      cleanup(() => this.resourceAbort.abort());
      this.resourceGeneration += 1;
      cleanup(() => this._motionManager?.stopAllMotions());
      cleanup(() => this.motionSync?.release());
      this.motionSync = null;
      for (const texture of this.textures) cleanup(() => this.deleteGpuTexture(texture));
      this.textures.length = 0;
      cleanup(() => this.deleteGpuTexture(this.ownedMultiplyTexture));
      cleanup(() => this.deleteGpuTexture(this.multiplyFallbackTexture));
      this.ownedMultiplyTexture = null;
      this.multiplyFallbackTexture = null;
      this.motions.clear();
      this.expressions.clear();
      this.motionFadeInTimes.clear();
      this.expressionFadeInTimes.clear();
      this.motionIndex = null;
      this.expressionIndex = null;
      this.loadingMotions.clear();
      this.loadingExpressions.clear();
      this.motionRetries.clear();
      this.expressionRetries.clear();
      this.requestedMotion = null;
      this.requestedExpression = null;
      this.pausedMotionRequest.clear();
      this.pausedExpressionRequest.clear();
      this.motionRequestSequence += 1;
      this.expressionRequestSequence += 1;
      cleanup(() => this.setting?.release());
      this.frozenParameters = null;
      this.frozenParts = null;
      this.authoredParameterIndices.clear();
      this.authoredPartIndices.clear();
      this.partOpacityOverrides.clear();
      this.parameterIds.clear();
      this.setInitialized(false);
    } catch (error) {
      errors.push(error);
    } finally {
      // Isolate manager failures so CubismUserModel can still release Core and
      // the renderer. The owner boundary covers every preceding cleanup exit.
      cleanup(() => {
        const manager = this._motionManager;
        this._motionManager = null;
        manager?.release();
      });
      cleanup(() => {
        const manager = this._expressionManager;
        this._expressionManager = null;
        manager?.release();
      });
      cleanup(() => super.release());
      cleanup(() => {
        if (this.getRenderer()) this.deleteRenderer();
      });
      cleanup(() => this.releaseResourceLoader?.());
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Cubism model release failed");
  }
}
