import type { StoryCharacterModel, StoryCharacterModelContext, StoryCharacterPresentation } from "@haneoka/vega/plugin";
import { Matrix4 } from "./rendering/math/Matrix4";
import type { CubismModelDescriptor, CubismRendererCharacterContext, CubismRuntimeAdapter } from "../index";
import {
  AdvCubismModel,
  type CubismDrawableBounds,
  type CubismParameterFrame,
} from "./rendering/cubism/AdvCubismModel";
import { Cubism2Model } from "./rendering/cubism/Cubism2Model";
import {
  configureCubismWebRuntime,
  ensureCubism2Framework,
  ensureCubismFramework,
  type CubismWebRuntimeSources,
} from "./rendering/cubism/CubismCoreRuntime";
import {
  configureCubismResourceCache,
  cubismResourceLoaderFor,
  type CubismResourceCacheOptions,
  type CubismStoryResourceResolver,
} from "./rendering/cubism/CubismResourceCache";
import { acquireCubismShaderContext, releaseCubismShaderContext } from "./vendor/cubism/rendering/cubismshader_webgl";
import { cubismPlaybackSteps, CubismViewerPlaybackState } from "./viewer/CubismPlaybackClock";

type RuntimeModel = AdvCubismModel | Cubism2Model;

export interface CubismWebRendererContext {
  readonly gl: WebGL2RenderingContext;
}

export interface CreateCubismWebRuntimeAdapterOptions {
  readonly id?: string;
  readonly runtime?: CubismWebRuntimeSources;
  readonly resourceCache?: CubismResourceCacheOptions;
  readonly createCanvas?: () => HTMLCanvasElement;
  readonly targetFrameRate?: number;
}

const abortReason = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException("The Cubism model request was aborted", "AbortError");

const throwIfAborted = (signal: AbortSignal): void => {
  if (signal.aborted) throw abortReason(signal);
};

const finite = (value: unknown, fallback = 0): number => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const resolveResource = (base: string, resource: unknown): string => {
  const value = String(resource ?? "").trim();
  if (!value) return "";
  try {
    return new URL(value, new URL(base, globalThis.location?.href || "http://localhost/")).toString();
  } catch {
    return value;
  }
};

const fileStem = (source: string): string => {
  const file = source.split(/[?#]/u, 1)[0]?.split("/").pop() || source;
  return file.replace(/\.(?:motion3|exp3|mtn|exp)\.json$/iu, "").replace(/\.mtn$/iu, "");
};

const loadJsonObject = async (
  context: Pick<StoryCharacterModelContext, "resources" | "signal">,
  source: string,
): Promise<Record<string, unknown>> => {
  const resources = context.resources as CubismStoryResourceResolver;
  const bytes = resources.canLoad(source)
    ? await (resources.loadSharedBytes
        ? resources.loadSharedBytes(source, context.signal)
        : resources.load(source, context.signal))
    : new Uint8Array(await (await fetch(source, { signal: context.signal })).arrayBuffer());
  const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Cubism manifest is not an object: ${source}`);
  }
  return value as Record<string, unknown>;
};

interface Cubism2ResolvedSource {
  readonly mocUrl: string;
  readonly textureUrls: readonly string[];
  readonly physicsUrl?: string;
  readonly motions: ReadonlyArray<{ name: string; url: string }>;
  readonly expressions: ReadonlyArray<{ name: string; url: string }>;
}

const resolveCubism2Source = async (
  context: Pick<StoryCharacterModelContext, "resources" | "signal"> & {
    readonly descriptor: CubismModelDescriptor;
  },
): Promise<Cubism2ResolvedSource> => {
  const { descriptor } = context;
  if (descriptor.sourceKind === "moc") {
    return {
      mocUrl: descriptor.modelSource,
      textureUrls: descriptor.textures ?? [],
      ...(descriptor.physicsSource ? { physicsUrl: descriptor.physicsSource } : {}),
      motions: (descriptor.motions ?? []).map(({ name, source }) => ({ name, url: source })),
      expressions: (descriptor.expressions ?? []).map(({ name, source }) => ({ name, url: source })),
    };
  }

  const manifest = await loadJsonObject(context, descriptor.modelSource);
  const textures = Array.isArray(manifest.textures) ? manifest.textures : [];
  const motions: Array<{ name: string; url: string }> = [];
  const motionGroups = manifest.motions;
  if (motionGroups && typeof motionGroups === "object" && !Array.isArray(motionGroups)) {
    for (const [group, entries] of Object.entries(motionGroups)) {
      if (!Array.isArray(entries)) continue;
      entries.forEach((entry, index) => {
        if (!entry || typeof entry !== "object") return;
        const source = resolveResource(descriptor.modelSource, (entry as { file?: unknown }).file);
        if (source) motions.push({ name: index === 0 ? group : `${group}_${index}`, url: source });
      });
    }
  }
  const expressions: Array<{ name: string; url: string }> = [];
  if (Array.isArray(manifest.expressions)) {
    for (const entry of manifest.expressions) {
      if (!entry || typeof entry !== "object") continue;
      const value = entry as { name?: unknown; file?: unknown };
      const url = resolveResource(descriptor.modelSource, value.file);
      const name = String(value.name ?? "").trim() || fileStem(url);
      if (name && url) expressions.push({ name, url });
    }
  }
  const mocUrl = resolveResource(descriptor.modelSource, manifest.model ?? manifest.moc);
  if (!mocUrl) throw new TypeError(`Cubism 2 manifest has no model: ${descriptor.modelSource}`);
  const physicsUrl = resolveResource(descriptor.modelSource, manifest.physics);
  return {
    mocUrl,
    textureUrls: textures.map((entry) => resolveResource(descriptor.modelSource, entry)).filter(Boolean),
    ...(physicsUrl ? { physicsUrl } : {}),
    motions,
    expressions,
  };
};

interface ShaderLease {
  references: number;
}

const shaderLeases = new WeakMap<WebGL2RenderingContext, ShaderLease>();

const acquireShaderLease = (gl: WebGL2RenderingContext): (() => void) => {
  let lease = shaderLeases.get(gl);
  if (!lease) {
    acquireCubismShaderContext(gl);
    lease = { references: 0 };
    shaderLeases.set(gl, lease);
  }
  lease.references += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = shaderLeases.get(gl);
    if (!current) return;
    current.references -= 1;
    if (current.references > 0) return;
    shaderLeases.delete(gl);
    releaseCubismShaderContext(gl);
  };
};

const ownRelease = (model: RuntimeModel, releaseContext?: () => void): RuntimeModel => {
  const original = model.release.bind(model);
  let released = false;
  return new Proxy(model, {
    get(target, property) {
      if (property === "release" || property === "dispose") {
        return () => {
          if (released) return;
          released = true;
          try {
            original();
          } finally {
            releaseContext?.();
          }
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
};

export const createCubismWebGlModel = async (
  context: Pick<StoryCharacterModelContext, "resources" | "signal" | "target"> & {
    readonly descriptor: CubismModelDescriptor;
    readonly gl: WebGL2RenderingContext;
    readonly rendererContext?: unknown;
  },
): Promise<RuntimeModel> => {
  throwIfAborted(context.signal);
  const resourceLoader = cubismResourceLoaderFor(context.resources as CubismStoryResourceResolver);
  if (context.descriptor.version === 2) {
    await ensureCubism2Framework(context.signal);
    const resolved = await resolveCubism2Source(context);
    const model = await Cubism2Model.create({
      gl: context.gl,
      signal: context.signal,
      mocUrl: resolved.mocUrl,
      textureUrls: [...resolved.textureUrls],
      ...(resolved.physicsUrl ? { physicsUrl: resolved.physicsUrl } : {}),
      ...(context.descriptor.pixelsPerUnit ? { pixelsPerUnit: context.descriptor.pixelsPerUnit } : {}),
      ...(context.descriptor.canvasWorldHeight ? { canvasWorldHeight: context.descriptor.canvasWorldHeight } : {}),
      physicsEnabled: context.descriptor.physicsEnabled !== false,
      resourceLoader,
    });
    if (!model) throw new Error(`Cubism 2 model could not be created for ${context.target}`);
    model.registerCatalog([...resolved.motions], [...resolved.expressions]);
    return ownRelease(model);
  }

  await ensureCubismFramework(context.signal);
  const releaseShader = acquireShaderLease(context.gl);
  try {
    const model = await AdvCubismModel.create({
      gl: context.gl,
      modelUrl: context.descriptor.modelSource,
      signal: context.signal,
      ...(context.descriptor.defaultMotionName ? { defaultMotionName: context.descriptor.defaultMotionName } : {}),
      maskBufferSize: context.descriptor.maskBufferSize ?? 1024,
      anisotropy: context.descriptor.anisotropy ?? 1,
      physics: context.descriptor.physicsEnabled !== false,
      breath: context.descriptor.breathEnabled === true,
      motionSync: context.descriptor.motionSync as never,
      resourceLoader,
    });
    throwIfAborted(context.signal);
    return ownRelease(model, releaseShader);
  } catch (error) {
    releaseShader();
    throw error;
  }
};

const requestFrame = (callback: FrameRequestCallback): number =>
  typeof requestAnimationFrame === "function"
    ? requestAnimationFrame(callback)
    : Number(setTimeout(() => callback(performance.now()), 16));

const cancelFrame = (handle: number): void => {
  if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(handle);
  else clearTimeout(handle);
};

const createWebGl2Context = (canvas: HTMLCanvasElement): WebGL2RenderingContext => {
  const gl = canvas.getContext("webgl2", {
    alpha: true,
    antialias: true,
    depth: false,
    premultipliedAlpha: true,
    powerPreference: "high-performance",
    stencil: false,
  });
  if (!gl) throw new Error("Cubism canvas rendering requires WebGL2");
  return gl;
};

const createDisplayContext = (canvas: HTMLCanvasElement): CanvasRenderingContext2D => {
  const context = canvas.getContext("2d", { alpha: true });
  if (!context) throw new Error("Cubism canvas rendering requires a 2D presentation context");
  return context;
};

const waitForGpuCompletion = (
  gl: WebGL2RenderingContext,
  signal: AbortSignal,
  timeoutMilliseconds = 2_000,
): Promise<void> => {
  throwIfAborted(signal);
  if (gl.isContextLost()) {
    return Promise.reject(new Error("Cubism WebGL context was lost during first-frame preparation"));
  }

  let fence: WebGLSync | null = null;
  try {
    fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  } catch {
    // Some embedded WebViews expose WebGL2 but reject sync objects. `finish`
    // remains the only portable completion guarantee in that environment.
  }
  gl.flush();
  if (!fence) {
    throwIfAborted(signal);
    gl.finish();
    return Promise.resolve();
  }

  const startedAt = performance.now();
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    const cleanup = (): void => {
      if (timer !== null) clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      gl.deleteSync(fence);
    };
    const settle = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error === undefined) resolve();
      else reject(error);
    };
    const aborted = (): void => settle(abortReason(signal));
    const poll = (): void => {
      if (signal.aborted) {
        aborted();
        return;
      }
      if (gl.isContextLost()) {
        settle(new Error("Cubism WebGL context was lost during first-frame preparation"));
        return;
      }
      const status = gl.clientWaitSync(fence, 0, 0);
      if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED) {
        settle();
        return;
      }
      if (status === gl.WAIT_FAILED || performance.now() - startedAt >= timeoutMilliseconds) {
        // A driver can fail or indefinitely defer polling while still accepting
        // commands. The bounded fallback is deliberately rare but preserves the
        // contract that a resolved warmup has completed its GPU work.
        try {
          gl.finish();
          settle();
        } catch (error) {
          settle(error);
        }
        return;
      }
      timer = setTimeout(poll, 4);
    };
    signal.addEventListener("abort", aborted, { once: true });
    poll();
  });
};

interface CanvasCubismContextLease {
  readonly gl: WebGL2RenderingContext;
  release(): void;
}

/**
 * Portable Canvas characters share one WebGL context per runtime adapter.
 *
 * The episode loader intentionally keeps every referenced controller resident.
 * Giving every resident controller its own context quickly exceeds browser and
 * WebView context limits. Models can safely share one context because their GPU
 * resources remain distinct and draws are submitted serially on the JS thread;
 * each character presents the shared drawing buffer into its own 2D canvas.
 */
class CanvasCubismRenderPool {
  private canvas: HTMLCanvasElement | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private references = 0;
  private pendingPreparations = 0;
  private preparing = false;
  private preparationQueue: Promise<void> = Promise.resolve();

  acquire(): CanvasCubismContextLease {
    if (!this.gl || this.gl.isContextLost() || !this.canvas) {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      this.canvas = canvas;
      this.gl = createWebGl2Context(canvas);
    }
    this.references += 1;
    const gl = this.gl;
    let released = false;
    return {
      gl,
      release: () => {
        if (released) return;
        released = true;
        this.references = Math.max(0, this.references - 1);
        this.teardownIfIdle();
      },
    };
  }

  get canDrawSynchronously(): boolean {
    return !this.preparing;
  }

  drawingCanvas(gl: WebGL2RenderingContext, width: number, height: number): HTMLCanvasElement {
    if (gl !== this.gl || !this.canvas || gl.isContextLost()) {
      throw new Error("Cubism shared WebGL context is unavailable");
    }
    // Grow monotonically so alternating characters do not reset the drawing
    // buffer and driver state every frame.
    if (this.canvas.width < width) this.canvas.width = width;
    if (this.canvas.height < height) this.canvas.height = height;
    return this.canvas;
  }

  prepareFirstFrame(
    gl: WebGL2RenderingContext,
    signal: AbortSignal,
    submit: () => void,
    present: () => void,
  ): Promise<void> {
    this.pendingPreparations += 1;
    const prepare = this.preparationQueue
      .catch(() => undefined)
      .then(async () => {
        throwIfAborted(signal);
        if (gl !== this.gl || gl.isContextLost()) {
          throw new Error("Cubism shared WebGL context is unavailable");
        }
        this.preparing = true;
        try {
          submit();
          // Capture the default framebuffer in the same task. WebGL is allowed
          // to discard it after compositing when preserveDrawingBuffer is off;
          // the fence below still keeps warmup pending until the submitted GPU
          // work itself has completed.
          present();
          await waitForGpuCompletion(gl, signal);
          throwIfAborted(signal);
        } finally {
          this.preparing = false;
        }
      });
    this.preparationQueue = prepare.catch(() => undefined).then(() => undefined);
    return prepare.finally(() => {
      this.pendingPreparations = Math.max(0, this.pendingPreparations - 1);
      this.teardownIfIdle();
    });
  }

  private teardownIfIdle(): void {
    if (this.references > 0 || this.pendingPreparations > 0 || this.preparing) return;
    try {
      this.gl?.getExtension("WEBGL_lose_context")?.loseContext();
    } catch {
      // Context loss is a best-effort release path on older embedded WebViews.
    }
    this.canvas = null;
    this.gl = null;
  }
}

class CanvasCubismStoryModel implements StoryCharacterModel {
  readonly format: string;
  readonly source: string;
  readonly element: HTMLCanvasElement;
  private readonly mvp = new Matrix4();
  private readonly frame: CubismParameterFrame = { overrides: {} };
  private previousTime = performance.now();
  private accumulatedTime = 0;
  private readonly playback = new CubismViewerPlaybackState();
  private frameHandle: number | null = null;
  private paused = true;
  private disposed = false;
  private selectedMotionName = "";
  private selectedExpressionName = "";

  private constructor(
    private readonly pool: CanvasCubismRenderPool,
    private readonly gl: WebGL2RenderingContext,
    private readonly display: CanvasRenderingContext2D,
    private readonly model: RuntimeModel,
    canvas: HTMLCanvasElement,
    descriptor: CubismModelDescriptor,
    private readonly signal: AbortSignal,
    private readonly releaseContext: () => void,
    private readonly targetFrameInterval: number,
  ) {
    this.element = canvas;
    this.format = descriptor.version === 2 ? "cubism2" : "cubism3";
    this.source = descriptor.modelSource;
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.display = "block";
    this.resize();
    model.primeInitialFrame(this.frame);
    model.setPaused(true);
  }

  static async create(
    context: StoryCharacterModelContext & { readonly descriptor: CubismModelDescriptor },
    options: CreateCubismWebRuntimeAdapterOptions,
    pool: CanvasCubismRenderPool,
  ): Promise<CanvasCubismStoryModel> {
    const canvas = options.createCanvas?.() ?? document.createElement("canvas");
    const display = createDisplayContext(canvas);
    const lease = pool.acquire();
    try {
      const model = await createCubismWebGlModel({ ...context, gl: lease.gl });
      return new CanvasCubismStoryModel(
        pool,
        lease.gl,
        display,
        model,
        canvas,
        context.descriptor,
        context.signal,
        lease.release,
        1 / Math.max(1, options.targetFrameRate ?? 60),
      );
    } catch (error) {
      lease.release();
      throw error;
    }
  }

  get isOperational(): boolean {
    return !this.disposed && this.model.isOperational;
  }

  setPaused(paused: boolean): void {
    const next = Boolean(paused);
    const changed = this.paused !== next;
    if (!changed) return;
    this.paused = next;
    this.model.setPaused(this.paused);
    this.previousTime = performance.now();
    this.accumulatedTime = 0;
    if (this.paused) {
      if (this.frameHandle !== null) cancelFrame(this.frameHandle);
      this.frameHandle = null;
    } else {
      this.scheduleFrame();
    }
  }

  setPlaybackSpeed(rate: number): void {
    this.playback.set(rate, this.model);
  }

  prepareMotion(name: string): Promise<boolean> {
    return this.model.prepareMotion(name);
  }

  prepareExpression(name: string): Promise<boolean> {
    return this.model.prepareExpression(name);
  }

  async prepareFirstFrame(): Promise<void> {
    this.resize();
    await this.pool.prepareFirstFrame(
      this.gl,
      this.signal,
      () => this.draw(false, true),
      () => this.present(),
    );
  }

  playMotion(name: string, fadeInSeconds?: number): boolean {
    this.selectedMotionName = name.trim();
    return this.model.playMotion(name, fadeInSeconds);
  }

  /** Restore an authored motion after host transport seek/retry. */
  playMotionAt(name: string, positionSeconds: number, fadeInSeconds?: number, options?: { loop?: boolean }): boolean {
    this.selectedMotionName = name.trim();
    return this.model.playMotionAt(name, positionSeconds, fadeInSeconds, options);
  }

  playExpression(name: string, fadeInSeconds?: number): boolean {
    this.selectedExpressionName = name.trim();
    return this.model.playExpression(name, fadeInSeconds);
  }

  applyPresentation(presentation: StoryCharacterPresentation): void {
    this.frame.angleX = presentation.angle;
    this.frame.bodyAngleX = presentation.bodyAngle;
    this.frame.lookX = presentation.lookX;
    this.frame.lookY = presentation.lookY;
    this.element.style.opacity = String(Math.max(0, Math.min(1, finite(presentation.alpha, 1))));
    this.setPaused(presentation.paused);
    this.setPlaybackSpeed(presentation.playbackSpeed);
    const motionName = presentation.motionName.trim();
    const expressionName = presentation.expressionName.trim();
    if (motionName && motionName !== this.selectedMotionName) this.playMotion(motionName);
    else if (!motionName) this.selectedMotionName = "";
    if (expressionName && expressionName !== this.selectedExpressionName) {
      this.playExpression(expressionName);
    } else if (!expressionName) {
      this.selectedExpressionName = "";
    }
  }

  resetExpressionParameters(): void {
    this.model.resetExpressionParametersToDefault();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.frameHandle !== null) cancelFrame(this.frameHandle);
    this.frameHandle = null;
    try {
      this.model.release();
    } finally {
      this.releaseContext();
    }
  }

  private readonly animate = (time: number): void => {
    this.frameHandle = null;
    if (this.disposed || this.paused) return;
    const elapsed = Math.max(0, Math.min(0.1, (time - this.previousTime) / 1000));
    this.previousTime = time;
    this.accumulatedTime += elapsed;
    if (!this.paused && this.accumulatedTime >= this.targetFrameInterval) {
      const delta = this.accumulatedTime;
      this.accumulatedTime %= this.targetFrameInterval;
      for (const step of cubismPlaybackSteps(delta, this.playback.rate)) {
        this.model.update(step, this.frame);
      }
      this.draw();
    }
    this.scheduleFrame();
  };

  private scheduleFrame(): void {
    if (this.disposed || this.paused || this.frameHandle !== null) return;
    this.frameHandle = requestFrame(this.animate);
  }

  private resize(): void {
    const ratio = Math.max(1, finite(globalThis.devicePixelRatio, 1));
    const width = Math.max(1, Math.round((this.element.clientWidth || 960) * ratio));
    const height = Math.max(1, Math.round((this.element.clientHeight || 1080) * ratio));
    if (this.element.width !== width) this.element.width = width;
    if (this.element.height !== height) this.element.height = height;
    const bounds: CubismDrawableBounds =
      this.model.drawableBounds(true) ?? this.model.drawableBounds(false) ?? this.model.canvasBounds();
    const fill = Math.min(
      this.element.width / Math.max(0.001, bounds.width),
      this.element.height / Math.max(0.001, bounds.height),
    );
    const scaleX = (2 * fill) / this.element.width;
    const scaleY = (2 * fill) / this.element.height;
    const centerX = bounds.x + bounds.width / 2;
    const centerY = bounds.y + bounds.height / 2;
    this.mvp.set(scaleX, 0, 0, -centerX * scaleX, 0, scaleY, 0, -centerY * scaleY, 0, 0, 1, 0, 0, 0, 0, 1);
  }

  private draw(present = true, duringPreparation = false): void {
    if (this.disposed || this.gl.isContextLost() || (!duringPreparation && !this.pool.canDrawSynchronously)) return;
    this.pool.drawingCanvas(this.gl, this.element.width, this.element.height);
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
    this.gl.viewport(0, 0, this.element.width, this.element.height);
    // The pool exclusively owns this context, so establish a small explicit
    // boundary between models instead of querying and restoring the complete
    // WebGL profile around every Cubism draw.
    this.gl.disable(this.gl.DEPTH_TEST);
    this.gl.disable(this.gl.SCISSOR_TEST);
    this.gl.disable(this.gl.STENCIL_TEST);
    this.gl.disable(this.gl.CULL_FACE);
    this.gl.colorMask(true, true, true, true);
    this.gl.depthMask(false);
    this.gl.activeTexture(this.gl.TEXTURE0);
    this.gl.clearColor(0, 0, 0, 0);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    this.gl.bindVertexArray(null);
    this.model.draw(this.mvp, null, [0, 0, this.element.width, this.element.height], [1, 1, 1, 1]);
    if (present) this.present();
  }

  private present(): void {
    if (this.disposed || this.gl.isContextLost()) return;
    const source = this.pool.drawingCanvas(this.gl, this.element.width, this.element.height);
    this.display.clearRect(0, 0, this.element.width, this.element.height);
    this.display.drawImage(
      source,
      0,
      0,
      this.element.width,
      this.element.height,
      0,
      0,
      this.element.width,
      this.element.height,
    );
  }
}

const rendererGl = (value: unknown): WebGL2RenderingContext => {
  const gl = (value as Partial<CubismWebRendererContext> | null)?.gl;
  if (!gl || typeof gl.createTexture !== "function") {
    throw new TypeError("Cubism renderer integration requires rendererContext.gl (WebGL2)");
  }
  return gl;
};

export const createCubismWebRuntimeAdapter = (
  options: CreateCubismWebRuntimeAdapterOptions = {},
): CubismRuntimeAdapter => {
  const canvasPool = new CanvasCubismRenderPool();
  configureCubismWebRuntime(options.runtime ?? {});
  if (options.resourceCache) configureCubismResourceCache(options.resourceCache);
  return {
    id: options.id?.trim() || "vega.cubism-web-runtime",
    async prepare(version, signal) {
      configureCubismWebRuntime(options.runtime ?? {});
      if (version === 2) await ensureCubism2Framework(signal);
      else await ensureCubismFramework(signal);
    },
    create(context) {
      return CanvasCubismStoryModel.create(context, options, canvasPool);
    },
    createForRenderer(context: CubismRendererCharacterContext) {
      return createCubismWebGlModel({
        ...context,
        gl: rendererGl(context.rendererContext),
        rendererContext: context.rendererContext,
      });
    },
    disposeRendererModel(model) {
      const candidate = model as { release?: () => void; dispose?: () => void };
      if (candidate.release) candidate.release();
      else candidate.dispose?.();
    },
    getMouthParameterProfile(context) {
      const model = context.model as {
        parameterRange?: (id: string) => { readonly minimum: number; readonly maximum: number } | null;
      };
      const ids =
        context.descriptor.version === 2
          ? { open: "PARAM_MOUTH_OPEN_Y", form: "PARAM_MOUTH_FORM" }
          : { open: "ParamMouthOpenY", form: "ParamMouthForm" };
      const open = model.parameterRange?.(ids.open);
      if (!open) return null;
      const form = model.parameterRange?.(ids.form);
      return {
        mouthOpen: { id: ids.open, ...open },
        ...(form ? { mouthForm: { id: ids.form, ...form } } : {}),
      };
    },
  };
};
