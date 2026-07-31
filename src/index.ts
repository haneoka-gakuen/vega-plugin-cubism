import {
  defineVegaPlugin,
  type StoryCharacterModel,
  type StoryCharacterModelContext,
  type StoryCharacterProvider,
  type StoryCharacterResource,
  type StoryCharacterResourceEnumerationContext,
  type StoryCharacterRendererModel,
  type StoryCharacterRendererModelContext,
  type VegaVisemeFrame,
  type VegaVoiceAnalyzer,
} from "@haneoka/vega/plugin";

/**
 * Resource family inferred before Core reads the MOC header. `3` represents
 * the shared Model3 manifest family used by Cubism 3, 4 and 5.
 */
export type CubismRuntimeVersion = 2 | 3;
export type CubismModelSourceKind = "manifest" | "moc";
export type CubismVowel = "A" | "I" | "U" | "E" | "O";

/**
 * One host-resolved Cubism animation file.
 *
 * Model manifests remain authoritative when they contain their own catalog.
 * This optional projection is needed only when a host supplies an ordinary
 * direct MOC plus the sidecar motion/expression files that belong to it.
 */
export interface CubismAnimationDescriptor {
  readonly name: string;
  readonly source: string;
}

export interface CubismModelDescriptor {
  readonly version: CubismRuntimeVersion;
  /**
   * Identifies whether `modelSource` must be decoded as a JSON manifest or
   * passed directly to the Cubism 2 Core as MOC bytes.
   */
  readonly sourceKind: CubismModelSourceKind;
  readonly modelSource: string;
  readonly textures?: readonly string[];
  readonly physicsSource?: string;
  readonly motions?: readonly CubismAnimationDescriptor[];
  readonly expressions?: readonly CubismAnimationDescriptor[];
  readonly pixelsPerUnit?: number;
  readonly canvasWorldHeight?: number;
  readonly defaultMotionName?: string;
  readonly maskBufferSize?: number;
  readonly maskBufferMaximum?: number;
  readonly maskResolutionScale?: number;
  readonly anisotropy?: number;
  readonly physicsEnabled?: boolean;
  readonly breathEnabled?: boolean;
  readonly motionSync?: unknown;
  /**
   * Source-neutral fallback calibration. Source adapters may populate it from
   * importer metadata; the Cubism runtime never embeds game-specific profiles.
   */
  readonly fallbackMotionSyncAudioScales?: Readonly<
    Partial<Record<CubismVowel, number>>
  >;
}

export interface CubismRendererCharacterRequest
  extends StoryCharacterRendererModelContext<string, object> {
  /**
   * Callers may pass a previously inspected descriptor, but the provider
   * always derives and validates its own descriptor from `entry`.
   */
  readonly descriptor?: unknown;
}

export interface CubismRendererCharacterContext
  extends StoryCharacterRendererModelContext<string, object> {
  readonly renderer: string;
  readonly descriptor: CubismModelDescriptor;
}

export type CubismRendererCharacterModel = StoryCharacterRendererModel;

/**
 * The application supplies the separately licensed runtime adapter. The
 * official Vega plugin owns discovery, lifecycle routing and portable visemes;
 * it never downloads or redistributes an SDK/Core.
 */
export interface CubismRuntimeAdapter {
  readonly id: string;
  prepare?(
    version: CubismRuntimeVersion,
    signal: AbortSignal,
  ): void | Promise<void>;
  create(
    context: StoryCharacterModelContext & {
      readonly descriptor: CubismModelDescriptor;
    },
  ): StoryCharacterModel | Promise<StoryCharacterModel>;
  createForRenderer?(
    context: CubismRendererCharacterContext,
  ): CubismRendererCharacterModel | Promise<CubismRendererCharacterModel>;
  /**
   * Releases a renderer-owned model when construction finishes after its
   * request was aborted. If omitted, the plugin falls back to a conventional
   * `dispose()` or `destroy()` method when one is present.
   */
  disposeRendererModel?(
    model: CubismRendererCharacterModel,
    context: CubismRendererCharacterContext,
  ): void | Promise<void>;
  /**
   * Resolves authored parameter IDs and ranges without exposing an SDK to the
   * plugin. Returning `null` intentionally disables parameter mapping; a
   * custom `applyLipSync` hook can still consume the portable viseme frame.
   */
  getMouthParameterProfile?(
    context: CubismLipSyncModelContext,
  ): CubismMouthParameterProfile | null;
  /**
   * Applies one smoothed frame at the runtime's correct late-update phase.
   * This hook is synchronous because it is called from a render frame.
   */
  applyLipSync?(context: CubismLipSyncApplyContext): void;
}

export interface CreateCubismPluginOptions {
  readonly adapter: CubismRuntimeAdapter;
  /**
   * @deprecated Compatibility family filter. Cubism 3/4/5 all select the
   * Model3 family; an exact MOC version cannot be inferred from its filename.
   */
  readonly formats?: readonly string[];
  readonly contributionId?: string;
  readonly lipSync?: CubismLipSyncOptions;
}

export interface CubismAudioFeatures {
  readonly rms: number;
  readonly centroid?: number;
  readonly low?: number;
  readonly mid?: number;
  readonly high?: number;
}

export interface CubismVisemeFrame {
  readonly silence: number;
  readonly vowels: Readonly<Record<CubismVowel, number>>;
  readonly mouthOpen: number;
  readonly mouthForm: number;
}

export interface CubismVisemeOptions {
  readonly sensitivity?: number;
  readonly silenceThreshold?: number;
  readonly attackSeconds?: number;
  readonly releaseSeconds?: number;
}

export interface CubismParameterRange {
  readonly id: string;
  readonly minimum: number;
  readonly maximum: number;
}

export interface CubismMouthParameterProfile {
  readonly mouthOpen: CubismParameterRange;
  readonly mouthForm?: CubismParameterRange;
  readonly vowels?: Partial<Record<CubismVowel, CubismParameterRange>>;
}

export interface CubismParameterValue {
  readonly id: string;
  readonly value: number;
}

export type CubismLipSyncInputFrame = CubismAudioFeatures | CubismVisemeFrame;

/**
 * A model-scoped, host-supplied analysis source. It samples already available
 * audio state and never grants this package microphone or capture ownership.
 */
export interface CubismAudioAnalysisProvider {
  sample(): CubismLipSyncInputFrame | null;
  dispose?(): void;
}

export interface CubismLipSyncModelContext {
  readonly model: unknown;
  readonly descriptor: CubismModelDescriptor;
  readonly target: string;
  readonly entry: StoryCharacterModelContext["entry"];
  readonly resources: StoryCharacterModelContext["resources"];
  readonly signal: AbortSignal;
  readonly renderer?: string;
  readonly rendererContext?: unknown;
}

export type CubismMouthParameterProfileResolver = (
  context: CubismLipSyncModelContext,
) => CubismMouthParameterProfile | null;

export interface CubismLipSyncOptions extends CubismVisemeOptions {
  /**
   * Creates a model-scoped analyzer facade. The returned provider is disposed
   * with the model. Omit it when the host pushes frames directly.
   */
  readonly createAudioProvider?: (
    context: CubismLipSyncModelContext,
  ) => CubismAudioAnalysisProvider | null;
  readonly parameterProfile?:
    CubismMouthParameterProfile | CubismMouthParameterProfileResolver | null;
  /**
   * When a provider is present, sample it from a renderer model's conventional
   * `update(deltaSeconds, ...)` method. Hosts with a custom frame loop can turn
   * this off and call `cubismLipSync.update` themselves.
   */
  readonly autoUpdate?: boolean;
  /**
   * Runtime adapters that queue late inputs generally use `before`; adapters
   * that write final parameters can select `after`.
   */
  readonly updatePhase?: "before" | "after";
}

export interface CubismLipSyncApplyContext extends CubismLipSyncModelContext {
  readonly deltaSeconds: number;
  readonly origin: "audio-provider" | "audio-features" | "viseme";
  readonly frame: CubismVisemeFrame;
  readonly profile: CubismMouthParameterProfile | null;
  readonly parameters: readonly CubismParameterValue[];
}

/**
 * Optional structural hooks implemented by an application-owned model.
 * `setParameter` matches the common Cubism 2 and Cubism 3+ model boundary.
 */
export interface CubismLipSyncModelHooks {
  getCubismMouthParameterProfile?(
    context: CubismLipSyncModelContext,
  ): CubismMouthParameterProfile | null;
  applyCubismLipSync?(context: CubismLipSyncApplyContext): void;
  applyCubismParameters?(
    parameters: readonly CubismParameterValue[],
    context: CubismLipSyncApplyContext,
  ): void;
  setParameter?(id: string, value: number, weight?: number): void;
  parameterRange?(
    id: string,
  ): { readonly minimum: number; readonly maximum: number } | null;
}

export interface CubismLipSyncController {
  readonly disposed: boolean;
  readonly hasAudioProvider: boolean;
  readonly currentFrame: CubismVisemeFrame;
  update(deltaSeconds?: number): CubismVisemeFrame | null;
  inputAudioFeatures(
    features: CubismAudioFeatures,
    deltaSeconds?: number,
  ): CubismVisemeFrame | null;
  inputViseme(
    frame: CubismVisemeFrame,
    deltaSeconds?: number,
  ): CubismVisemeFrame | null;
  reset(): CubismVisemeFrame;
  dispose(): void;
}

export const CUBISM_LIP_SYNC = Symbol.for(
  "@haneoka/vega-plugin-cubism/lip-sync",
);

export interface CubismLipSyncModel {
  readonly cubismLipSync: CubismLipSyncController;
  readonly [CUBISM_LIP_SYNC]: CubismLipSyncController;
}

export type CubismStoryCharacterModel = StoryCharacterModel &
  CubismLipSyncModel;

export interface CubismCharacterProvider
  extends StoryCharacterProvider<
    string,
    object,
    CubismRendererCharacterModel
  > {
  create(
    context: StoryCharacterModelContext,
  ): Promise<CubismStoryCharacterModel>;
  createForRenderer(
    context: CubismRendererCharacterRequest,
  ): CubismRendererCharacterModel | Promise<CubismRendererCharacterModel>;
}

const DEFAULT_FORMATS = Object.freeze([
  "cubism2",
  "cubism3",
  "cubism4",
  "cubism5",
  "live2d",
]);

export const CUBISM_VOWEL_ORDER = Object.freeze([
  "A",
  "I",
  "U",
  "E",
  "O",
] as const);
const VOWELS = CUBISM_VOWEL_ORDER;
const MOUTH_OPEN: Readonly<Record<CubismVowel, number>> = Object.freeze({
  A: 1,
  I: 0.4,
  U: 0.4,
  E: 0.7,
  O: 1,
});
const MOUTH_FORM: Readonly<Record<CubismVowel, number>> = Object.freeze({
  A: 1,
  I: 1,
  U: -1,
  E: 1,
  O: -1,
});
export const CUBISM_VOWEL_SHAPES: Readonly<
  Record<CubismVowel, { readonly mouthOpen: number; readonly mouthForm: number }>
> = Object.freeze(
  Object.fromEntries(
    CUBISM_VOWEL_ORDER.map((vowel) => [
      vowel,
      Object.freeze({
        mouthOpen: MOUTH_OPEN[vowel],
        mouthForm: MOUTH_FORM[vowel],
      }),
    ]),
  ) as Record<
    CubismVowel,
    { readonly mouthOpen: number; readonly mouthForm: number }
  >,
);

const finite = (value: unknown, fallback = 0): number => {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
};

const clamp = (value: unknown, minimum = 0, maximum = 1): number =>
  Math.max(minimum, Math.min(maximum, finite(value, minimum)));

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

const firstString = (...values: unknown[]): string =>
  values
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .find(Boolean) ?? "";

const firstFinite = (...values: unknown[]): number | undefined => {
  for (const value of values) {
    if (
      typeof value !== "number" &&
      !(typeof value === "string" && value.trim())
    ) {
      continue;
    }
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return undefined;
};

const firstBoolean = (...values: unknown[]): boolean | undefined => {
  for (const value of values) {
    if (typeof value === "boolean") return value;
  }
  return undefined;
};

const standardCubismFormat = (
  entry: StoryCharacterModelContext["entry"],
): string => {
  const source = object(entry);
  const runtime = object(source.runtime);
  const model = firstString(
    runtime.model,
    runtime.modelUrl,
    source.model,
    source.modelUrl,
  );
  const moc = firstString(runtime.moc, source.moc);
  if (/model3\.json(?:[?#].*)?$/iu.test(model)) return "cubism3";
  if (/model\.json(?:[?#].*)?$/iu.test(model)) return "cubism2";
  const textures = Array.isArray(runtime.textures)
    ? runtime.textures
    : Array.isArray(source.textures)
      ? source.textures
      : [];
  if (
    /\.moc(?:[?#].*)?$/iu.test(moc) &&
    textures.some((value) => firstString(value))
  ) {
    return "cubism2";
  }
  const explicit = firstString(runtime.format, source.format).toLowerCase();
  if (explicit === "cubism2") return explicit;
  if (
    explicit === "cubism3" ||
    explicit === "cubism4" ||
    explicit === "cubism5"
  ) {
    return explicit;
  }
  if (explicit === "live2d") {
    return moc && !model ? "cubism2" : "cubism3";
  }
  return "";
};

const abortReason = (signal: AbortSignal): unknown => {
  if (signal.reason !== undefined) return signal.reason;
  const error = new Error("The Cubism model request was aborted");
  error.name = "AbortError";
  return error;
};

const throwIfAborted = (signal: AbortSignal): void => {
  if (signal.aborted) throw abortReason(signal);
};

const disposeRendererModel = async (
  adapter: CubismRuntimeAdapter,
  model: CubismRendererCharacterModel,
  context: CubismRendererCharacterContext,
): Promise<void> => {
  if (adapter.disposeRendererModel) {
    await adapter.disposeRendererModel(model, context);
    return;
  }
  if (!model || typeof model !== "object") return;
  const candidate = model as {
    dispose?: () => void | Promise<void>;
    destroy?: () => void | Promise<void>;
    release?: () => void | Promise<void>;
  };
  if (typeof candidate.dispose === "function") await candidate.dispose();
  else if (typeof candidate.destroy === "function") await candidate.destroy();
  else if (typeof candidate.release === "function") await candidate.release();
};

const cubismAnimationCatalog = (
  entry: StoryCharacterModelContext["entry"],
  field: "motions" | "expressions",
): readonly unknown[] => {
  const source = object(entry);
  const runtime = object(source.runtime);
  const direct = Array.isArray(source[field]) ? source[field] : [];
  return direct.length
    ? direct
    : Array.isArray(runtime[field])
      ? runtime[field]
      : [];
};

const cubismAnimationSource = (value: unknown): string => {
  const entry = object(value);
  const runtime = object(entry.runtime);
  return firstString(
    typeof entry.runtime === "string" ? entry.runtime : "",
    entry.url,
    entry.src,
    entry.source,
    entry.file,
    runtime.url,
    runtime.src,
    runtime.source,
    runtime.file,
  );
};

const cubismAnimationDescriptors = (
  entry: StoryCharacterModelContext["entry"],
  field: "motions" | "expressions",
): readonly CubismAnimationDescriptor[] => {
  const seen = new Set<string>();
  return Object.freeze(
    cubismAnimationCatalog(entry, field).flatMap((value) => {
      const animation = object(value);
      const name = firstString(animation.name);
      const source = cubismAnimationSource(animation);
      if (!name || !source || seen.has(name)) return [];
      seen.add(name);
      return [Object.freeze({ name, source })];
    }),
  );
};

export const describeCubismModel = (
  entry: StoryCharacterModelContext["entry"],
): CubismModelDescriptor | null => {
  const source = object(entry);
  const runtime = object(source.runtime);
  const profile = object(source.profile);
  const format = standardCubismFormat(entry);
  if (!format) return null;
  const version: CubismRuntimeVersion = format === "cubism2" ? 2 : 3;
  const model = firstString(
    runtime.model,
    runtime.modelUrl,
    source.model,
    source.modelUrl,
  );
  const moc = firstString(runtime.moc, source.moc);
  // A populated MOC field is an explicit low-level override. Preserve that
  // long-standing both-fields behavior even when `model` also names a
  // standard manifest. With only `model`, an ordinary `.moc` suffix remains a
  // compatibility fallback; an opaque explicit Cubism 2 model is a manifest.
  const sourceKind: CubismModelSourceKind =
    version === 2 &&
    (Boolean(moc) || /\.moc(?:[?#].*)?$/iu.test(model))
      ? "moc"
      : "manifest";
  const modelSource = sourceKind === "moc" ? moc || model : model;
  const textureValues = Array.isArray(runtime.textures)
    ? runtime.textures
    : Array.isArray(source.textures)
      ? source.textures
      : [];
  const physicsSource = firstString(runtime.physics, source.physics);
  const motions = cubismAnimationDescriptors(entry, "motions");
  const expressions = cubismAnimationDescriptors(entry, "expressions");
  const pixelsPerUnit = firstFinite(
    runtime.pixelsPerUnit,
    source.pixelsPerUnit,
  );
  const canvasWorldHeight = firstFinite(
    runtime.canvasWorldHeight,
    source.canvasWorldHeight,
  );
  const defaultMotionName = firstString(
    profile.defaultMotionName,
    runtime.defaultMotionName,
    source.defaultMotionName,
  );
  const maskBufferSize = firstFinite(
    runtime.maskBufferSize,
    source.maskBufferSize,
  );
  const maskBufferMaximum = firstFinite(
    runtime.maskBufferMaximum,
    source.maskBufferMaximum,
  );
  const maskResolutionScale = firstFinite(
    runtime.maskResolutionScale,
    source.maskResolutionScale,
  );
  const anisotropy = firstFinite(runtime.anisotropy, source.anisotropy);
  const physicsEnabled = firstBoolean(
    runtime.physicsEnabled,
    source.physicsEnabled,
  );
  const breathEnabled = firstBoolean(
    runtime.breathEnabled,
    runtime.breath,
    source.breathEnabled,
    source.breath,
  );
  if (!modelSource) return null;
  return {
    version,
    sourceKind,
    modelSource,
    ...(textureValues.length
      ? {
          // MOC texture indices are positional. Preserve empty or malformed
          // slots so later atlases never shift onto a different index.
          textures: textureValues.map((value) =>
            typeof value === "string" ? value.trim() : "",
          ),
        }
      : {}),
    ...(physicsSource ? { physicsSource } : {}),
    ...(motions.length ? { motions } : {}),
    ...(expressions.length ? { expressions } : {}),
    ...(pixelsPerUnit !== undefined ? { pixelsPerUnit } : {}),
    ...(canvasWorldHeight !== undefined ? { canvasWorldHeight } : {}),
    ...(defaultMotionName ? { defaultMotionName } : {}),
    ...(maskBufferSize !== undefined ? { maskBufferSize } : {}),
    ...(maskBufferMaximum !== undefined ? { maskBufferMaximum } : {}),
    ...(maskResolutionScale !== undefined ? { maskResolutionScale } : {}),
    ...(anisotropy !== undefined ? { anisotropy } : {}),
    ...(physicsEnabled !== undefined ? { physicsEnabled } : {}),
    ...(breathEnabled !== undefined ? { breathEnabled } : {}),
    ...((runtime.motionSync ?? source.motionSync) !== undefined
      ? { motionSync: runtime.motionSync ?? source.motionSync }
      : {}),
    ...((runtime.fallbackMotionSyncAudioScales ??
      source.fallbackMotionSyncAudioScales) !== undefined
      ? {
          fallbackMotionSyncAudioScales: object(
            runtime.fallbackMotionSyncAudioScales ??
              source.fallbackMotionSyncAudioScales,
          ) as Readonly<Partial<Record<CubismVowel, number>>>,
        }
      : {}),
  };
};

/**
 * Enumerate directly addressable Cubism files from standard model fields.
 *
 * Model3 manifests may declare more nested dependencies; runtime adapters can
 * resolve those during `prepareDescriptors` without teaching Vega their
 * schema.
 */
export const enumerateCubismResources = (
  context: Pick<
    StoryCharacterResourceEnumerationContext,
    "entry" | "animationUsage"
  >,
): readonly StoryCharacterResource[] => {
  const descriptor = describeCubismModel(context.entry);
  if (!descriptor) return [];
  const resources: StoryCharacterResource[] = [
    {
      source: descriptor.modelSource,
      label:
        descriptor.sourceKind === "manifest"
          ? "Cubism manifest"
          : "Cubism model",
    },
  ];
  for (const source of descriptor.textures ?? []) {
    if (source) {
      resources.push({ source, kind: "texture", label: "Cubism texture" });
    }
  }
  if (descriptor.physicsSource) {
    resources.push({
      source: descriptor.physicsSource,
      label: "Cubism physics",
    });
  }
  const source = object(context.entry);
  const runtime = object(source.runtime);
  const profile = object(source.profile);
  const enumerateAnimations = (
    field: "motions" | "expressions",
    selected: readonly string[] | undefined,
    defaultName: string,
  ) => {
    for (const value of cubismAnimationCatalog(context.entry, field)) {
      const animation = object(value);
      const name = firstString(animation.name);
      if (
        selected &&
        name !== defaultName &&
        (!name || !selected.includes(name))
      ) {
        continue;
      }
      const animationSource = cubismAnimationSource(animation);
      if (animationSource) {
        resources.push({
          source: animationSource,
          label:
            field === "motions" ? "Cubism motion" : "Cubism expression",
        });
      }
    }
  };
  enumerateAnimations(
    "motions",
    context.animationUsage?.motions,
    firstString(
      profile.defaultMotionName,
      runtime.defaultMotionName,
      source.defaultMotionName,
    ),
  );
  enumerateAnimations(
    "expressions",
    context.animationUsage?.expressions,
    firstString(
      profile.defaultExpressionName,
      runtime.defaultExpressionName,
      source.defaultExpressionName,
    ),
  );
  const seen = new Set<string>();
  return Object.freeze(
    resources.filter((resource) => {
      const key = `${resource.kind ?? "file"}\u0000${resource.source}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  );
};

export const createCubismCharacterProvider = (
  options: CreateCubismPluginOptions,
): CubismCharacterProvider => {
  if (!options.adapter?.id?.trim()) {
    throw new TypeError("A named Cubism runtime adapter is required");
  }
  const formats = new Set(
    (options.formats ?? DEFAULT_FORMATS)
      .map((format) => format.trim().toLowerCase())
      .filter(Boolean),
  );
  if (formats.size === 0) {
    throw new TypeError("At least one Cubism format must be enabled");
  }
  const cubism2Enabled = formats.has("cubism2") || formats.has("live2d");
  const model3Enabled =
    formats.has("live2d") ||
    formats.has("cubism3") ||
    formats.has("cubism4") ||
    formats.has("cubism5");
  const contributionId = options.contributionId?.trim() || "vega.cubism";
  return {
    id: contributionId,
    supports(entry) {
      const format = standardCubismFormat(entry);
      if (!format) return false;
      return (
        (format === "cubism2" ? cubism2Enabled : model3Enabled) &&
        describeCubismModel(entry) !== null
      );
    },
    async prepareDescriptors({ descriptors, signal }) {
      throwIfAborted(signal);
      if (!options.adapter.prepare) return;
      const versions = new Set<CubismRuntimeVersion>();
      for (const entry of descriptors) {
        const descriptor = describeCubismModel(entry);
        if (descriptor) versions.add(descriptor.version);
      }
      await Promise.all(
        [...versions].map((version) =>
          options.adapter.prepare!(version, signal),
        ),
      );
      throwIfAborted(signal);
    },
    enumerateResources(context) {
      return enumerateCubismResources(context);
    },
    async create(context) {
      const descriptor = describeCubismModel(context.entry);
      if (!descriptor)
        throw new TypeError("Cubism model descriptor is incomplete");
      throwIfAborted(context.signal);
      await options.adapter.prepare?.(descriptor.version, context.signal);
      throwIfAborted(context.signal);
      const model = await options.adapter.create({ ...context, descriptor });
      if (context.signal.aborted) {
        const reason = abortReason(context.signal);
        await model.dispose();
        throw reason;
      }
      const lipSyncContext: CubismLipSyncModelContext = {
        model,
        descriptor,
        target: context.target,
        entry: context.entry,
        resources: context.resources,
        signal: context.signal,
      };
      try {
        return attachCubismLipSync(model, lipSyncContext, options, ["dispose"]);
      } catch (error) {
        await model.dispose();
        throw error;
      }
    },
    async createForRenderer(context) {
      const descriptor = describeCubismModel(context.entry);
      if (!descriptor)
        throw new TypeError("Cubism model descriptor is incomplete");
      const adapterContext: CubismRendererCharacterContext = {
        ...context,
        descriptor,
      };
      if (!options.adapter.createForRenderer) {
        throw new Error(
          `Cubism adapter ${options.adapter.id} does not support renderer ${context.renderer}`,
        );
      }
      throwIfAborted(context.signal);
      await options.adapter.prepare?.(descriptor.version, context.signal);
      throwIfAborted(context.signal);
      const model = await options.adapter.createForRenderer(adapterContext);
      if (context.signal.aborted) {
        const reason = abortReason(context.signal);
        await disposeRendererModel(options.adapter, model, adapterContext);
        throw reason;
      }
      const lipSyncContext: CubismLipSyncModelContext = {
        model,
        descriptor,
        target: context.target,
        entry: context.entry,
        resources: context.resources,
        signal: context.signal,
        renderer: context.renderer,
        rendererContext: context.rendererContext,
      };
      try {
        return attachCubismLipSync(model, lipSyncContext, options, [
          "dispose",
          "destroy",
          "release",
        ]);
      } catch (error) {
        await disposeRendererModel(options.adapter, model, adapterContext);
        throw error;
      }
    },
  };
};

export const createCubismPlugin = (options: CreateCubismPluginOptions) => {
  const provider = createCubismCharacterProvider(options);
  return defineVegaPlugin({
    manifest: {
      id: "haneoka.cubism",
      name: "Vega Cubism",
      version: "0.1.0",
      apiVersion: 1,
      description:
        "Cubism 2/3/4/5 model discovery, lifecycle routing and AIUEO visemes",
      capabilities: ["character"],
    },
    setup(context) {
      context.contribute("character", provider);
    },
  });
};

/**
 * Deterministic low-cost vowel estimator suitable for immediate preview. A
 * speech-recognition or MotionSync plugin can replace it by supplying its own
 * viseme frames through the same model adapter.
 */
export const estimateCubismViseme = (
  features: CubismAudioFeatures,
  options: CubismVisemeOptions = {},
): CubismVisemeFrame => {
  const sensitivity = Math.max(0, finite(options.sensitivity, 1));
  const threshold =
    options.silenceThreshold === undefined
      ? 0.018
      : clamp(finite(options.silenceThreshold, 0.018), 0, 0.5);
  const energy = clamp(features.rms * sensitivity);
  if (energy <= threshold) {
    return {
      silence: 1,
      vowels: { A: 0, I: 0, U: 0, E: 0, O: 0 },
      mouthOpen: 0,
      mouthForm: 0,
    };
  }

  const low = clamp(features.low, 0, 1);
  const mid = clamp(features.mid, 0, 1);
  const high = clamp(features.high, 0, 1);
  const centroid = clamp(features.centroid, 0, 1);
  const raw: Record<CubismVowel, number> = {
    A: 0.42 * mid + 0.32 * energy + 0.26 * (1 - Math.abs(centroid - 0.48)),
    I: 0.48 * high + 0.36 * centroid + 0.16 * mid,
    U: 0.54 * low + 0.3 * (1 - centroid) + 0.16 * energy,
    E: 0.52 * mid + 0.3 * high + 0.18 * centroid,
    O: 0.58 * low + 0.28 * mid + 0.14 * (1 - centroid),
  };
  const total =
    VOWELS.reduce((sum, vowel) => sum + Math.max(0, raw[vowel]), 0) || 1;
  const vowels = Object.fromEntries(
    VOWELS.map((vowel) => [vowel, (Math.max(0, raw[vowel]) / total) * energy]),
  ) as Record<CubismVowel, number>;
  const mouthOpen = VOWELS.reduce(
    (sum, vowel) => sum + vowels[vowel] * MOUTH_OPEN[vowel],
    0,
  );
  const weighted = VOWELS.reduce(
    (sum, vowel) => sum + vowels[vowel] * MOUTH_FORM[vowel],
    0,
  );
  return {
    silence: 1 - energy,
    vowels,
    mouthOpen: clamp(mouthOpen),
    mouthForm: clamp(weighted, -1, 1),
  };
};

export class CubismVisemeSmoother {
  private current: CubismVisemeFrame = estimateCubismViseme({ rms: 0 });

  reset(): CubismVisemeFrame {
    this.current = estimateCubismViseme({ rms: 0 });
    return this.current;
  }

  update(
    next: CubismVisemeFrame,
    deltaSeconds: number,
    options: CubismVisemeOptions = {},
  ): CubismVisemeFrame {
    const delta = Math.max(0, finite(deltaSeconds));
    const opening = next.mouthOpen > this.current.mouthOpen;
    const time = Math.max(
      0.001,
      finite(
        opening ? options.attackSeconds : options.releaseSeconds,
        opening ? 0.045 : 0.11,
      ),
    );
    const amount = 1 - Math.exp(-delta / time);
    const lerp = (left: number, right: number) =>
      left + (right - left) * amount;
    this.current = {
      silence: clamp(lerp(this.current.silence, next.silence)),
      vowels: Object.fromEntries(
        VOWELS.map((vowel) => [
          vowel,
          clamp(lerp(this.current.vowels[vowel], next.vowels[vowel])),
        ]),
      ) as Record<CubismVowel, number>,
      mouthOpen: clamp(lerp(this.current.mouthOpen, next.mouthOpen)),
      mouthForm: clamp(lerp(this.current.mouthForm, next.mouthForm), -1, 1),
    };
    return this.current;
  }
}

export const mapCubismVisemeToParameters = (
  frame: CubismVisemeFrame,
  profile: CubismMouthParameterProfile,
): readonly CubismParameterValue[] => {
  const valueInRange = (
    range: CubismParameterRange,
    normalized: number,
    bipolar = false,
  ): CubismParameterValue => {
    if (
      !range.id?.trim() ||
      !Number.isFinite(range.minimum) ||
      !Number.isFinite(range.maximum)
    ) {
      throw new TypeError(
        "Cubism parameter ranges require an id and finite minimum/maximum values",
      );
    }
    const ratio = bipolar
      ? (clamp(normalized, -1, 1) + 1) / 2
      : clamp(normalized);
    return {
      id: range.id,
      value: range.minimum + ratio * (range.maximum - range.minimum),
    };
  };
  const values: CubismParameterValue[] = [
    valueInRange(profile.mouthOpen, frame.mouthOpen),
  ];
  if (profile.mouthForm) {
    values.push(valueInRange(profile.mouthForm, frame.mouthForm, true));
  }
  for (const vowel of VOWELS) {
    const range = profile.vowels?.[vowel];
    if (range) values.push(valueInRange(range, frame.vowels[vowel]));
  }
  return values;
};

export const createDefaultCubismMouthParameterProfile = (
  version: CubismRuntimeVersion,
): CubismMouthParameterProfile =>
  version === 2
    ? {
        mouthOpen: {
          id: "PARAM_MOUTH_OPEN_Y",
          minimum: 0,
          maximum: 1,
        },
        mouthForm: {
          id: "PARAM_MOUTH_FORM",
          minimum: -1,
          maximum: 1,
        },
      }
    : {
        mouthOpen: {
          id: "ParamMouthOpenY",
          minimum: 0,
          maximum: 1,
        },
        mouthForm: {
          id: "ParamMouthForm",
          minimum: -1,
          maximum: 1,
        },
      };

export const cubismVisemeFromVega = (
  frame: VegaVisemeFrame,
): CubismVisemeFrame => {
  const vowels: Readonly<Record<CubismVowel, number>> = {
    A: clamp(frame.weights.a),
    I: clamp(frame.weights.i),
    U: clamp(frame.weights.u),
    E: clamp(frame.weights.e),
    O: clamp(frame.weights.o),
  };
  return {
    silence: clamp(frame.weights.silence),
    vowels,
    mouthOpen: clamp(
      VOWELS.reduce((sum, vowel) => sum + vowels[vowel] * MOUTH_OPEN[vowel], 0),
    ),
    mouthForm: clamp(
      VOWELS.reduce((sum, vowel) => sum + vowels[vowel] * MOUTH_FORM[vowel], 0),
      -1,
      1,
    ),
  };
};

/**
 * Adapts Vega's decoded-playback analyzer to the plugin's pull port. The
 * analyzer remains host-owned unless `disposeAnalyzer` is explicitly enabled.
 */
export const createCubismVoiceAnalyzerProvider = (
  analyzer: VegaVoiceAnalyzer,
  options: { readonly disposeAnalyzer?: boolean } = {},
): CubismAudioAnalysisProvider => {
  if (!analyzer || typeof analyzer.sampleSpectrum !== "function") {
    throw new TypeError(
      "A Vega voice analyzer with sampleSpectrum() is required",
    );
  }
  return {
    sample() {
      const viseme = analyzer.sampleViseme?.();
      if (viseme) return cubismVisemeFromVega(viseme);
      return analyzer.sampleSpectrum();
    },
    ...(options.disposeAnalyzer
      ? {
          dispose() {
            analyzer.dispose();
          },
        }
      : {}),
  };
};

const cubismLipSyncControllers = new WeakMap<object, CubismLipSyncController>();

class RuntimeCubismLipSyncController implements CubismLipSyncController {
  private readonly smoother = new CubismVisemeSmoother();
  private disposedValue = false;
  private currentValue = this.smoother.reset();

  constructor(
    private readonly provider: CubismAudioAnalysisProvider | null,
    private readonly options: CubismVisemeOptions,
    private readonly applyFrame: (
      frame: CubismVisemeFrame,
      deltaSeconds: number,
      origin: CubismLipSyncApplyContext["origin"],
    ) => void,
  ) {}

  get disposed(): boolean {
    return this.disposedValue;
  }

  get hasAudioProvider(): boolean {
    return this.provider !== null;
  }

  get currentFrame(): CubismVisemeFrame {
    return this.currentValue;
  }

  update(deltaSeconds = 1 / 60): CubismVisemeFrame | null {
    if (this.disposedValue || !this.provider) return null;
    const input = this.provider.sample();
    if (input == null) return null;
    return this.consume(input, deltaSeconds, "audio-provider");
  }

  inputAudioFeatures(
    features: CubismAudioFeatures,
    deltaSeconds = 1 / 60,
  ): CubismVisemeFrame | null {
    if (this.disposedValue) return null;
    return this.consume(features, deltaSeconds, "audio-features");
  }

  inputViseme(
    frame: CubismVisemeFrame,
    deltaSeconds = 1 / 60,
  ): CubismVisemeFrame | null {
    if (this.disposedValue) return null;
    return this.consume(frame, deltaSeconds, "viseme");
  }

  reset(): CubismVisemeFrame {
    this.currentValue = this.smoother.reset();
    return this.currentValue;
  }

  dispose(): void {
    if (this.disposedValue) return;
    this.disposedValue = true;
    this.currentValue = this.smoother.reset();
    this.provider?.dispose?.();
  }

  private consume(
    input: CubismLipSyncInputFrame,
    deltaSeconds: number,
    origin: CubismLipSyncApplyContext["origin"],
  ): CubismVisemeFrame {
    const source = object(input);
    const frame =
      "vowels" in source
        ? sanitizeCubismViseme(input as CubismVisemeFrame)
        : estimateCubismViseme(input as CubismAudioFeatures, this.options);
    const delta = Math.max(0, finite(deltaSeconds, 1 / 60));
    this.currentValue = this.smoother.update(frame, delta, this.options);
    this.applyFrame(this.currentValue, delta, origin);
    return this.currentValue;
  }
}

const sanitizeCubismViseme = (frame: CubismVisemeFrame): CubismVisemeFrame => {
  const vowels = object(frame.vowels);
  return {
    silence: clamp(frame.silence),
    vowels: Object.fromEntries(
      VOWELS.map((vowel) => [vowel, clamp(vowels[vowel])]),
    ) as Record<CubismVowel, number>,
    mouthOpen: clamp(frame.mouthOpen),
    mouthForm: clamp(frame.mouthForm, -1, 1),
  };
};

const validParameterRange = (
  id: string,
  value: ReturnType<NonNullable<CubismLipSyncModelHooks["parameterRange"]>>,
): CubismParameterRange | null =>
  value && Number.isFinite(value.minimum) && Number.isFinite(value.maximum)
    ? { id, minimum: value.minimum, maximum: value.maximum }
    : null;

const defaultProfileForModel = (
  context: CubismLipSyncModelContext,
): CubismMouthParameterProfile | null => {
  const profile = createDefaultCubismMouthParameterProfile(
    context.descriptor.version,
  );
  const target = context.model as CubismLipSyncModelHooks;
  if (typeof target.parameterRange !== "function") return profile;
  const discoveredMouthOpen = validParameterRange(
    profile.mouthOpen.id,
    target.parameterRange(profile.mouthOpen.id),
  );
  // Cubism 2 SDKs commonly cannot expose authored ranges through the model
  // wrapper. Later generations can, so a missing ID must not be synthesized.
  const mouthOpen =
    discoveredMouthOpen ??
    (context.descriptor.version === 2 ? profile.mouthOpen : null);
  if (!mouthOpen) return null;
  const discoveredMouthForm = profile.mouthForm
    ? validParameterRange(
        profile.mouthForm.id,
        target.parameterRange(profile.mouthForm.id),
      )
    : null;
  const mouthForm =
    discoveredMouthForm ??
    (context.descriptor.version === 2 ? profile.mouthForm : undefined);
  return {
    mouthOpen,
    ...(mouthForm ? { mouthForm } : {}),
  };
};

const resolveMouthParameterProfile = (
  context: CubismLipSyncModelContext,
  options: CreateCubismPluginOptions,
): CubismMouthParameterProfile | null => {
  const configured = options.lipSync?.parameterProfile;
  let profile: CubismMouthParameterProfile | null | undefined;
  if (typeof configured === "function") profile = configured(context);
  else if (configured !== undefined) profile = configured;
  else if (options.adapter.getMouthParameterProfile) {
    profile = options.adapter.getMouthParameterProfile(context);
  } else {
    const model = context.model as CubismLipSyncModelHooks;
    profile =
      typeof model.getCubismMouthParameterProfile === "function"
        ? model.getCubismMouthParameterProfile(context)
        : defaultProfileForModel(context);
  }
  if (profile) {
    mapCubismVisemeToParameters(estimateCubismViseme({ rms: 0 }), profile);
  }
  return profile ?? null;
};

const createLipSyncApply =
  (
    context: CubismLipSyncModelContext,
    options: CreateCubismPluginOptions,
    profile: CubismMouthParameterProfile | null,
  ) =>
  (
    frame: CubismVisemeFrame,
    deltaSeconds: number,
    origin: CubismLipSyncApplyContext["origin"],
  ): void => {
    const parameters = profile
      ? mapCubismVisemeToParameters(frame, profile)
      : [];
    const applyContext: CubismLipSyncApplyContext = {
      ...context,
      deltaSeconds,
      origin,
      frame,
      profile,
      parameters,
    };
    if (options.adapter.applyLipSync) {
      options.adapter.applyLipSync(applyContext);
      return;
    }
    const model = context.model as CubismLipSyncModelHooks;
    if (typeof model.applyCubismLipSync === "function") {
      model.applyCubismLipSync(applyContext);
      return;
    }
    if (typeof model.applyCubismParameters === "function") {
      model.applyCubismParameters(parameters, applyContext);
      return;
    }
    if (typeof model.setParameter === "function" && parameters.length > 0) {
      for (const parameter of parameters) {
        model.setParameter(parameter.id, parameter.value, 1);
      }
      return;
    }
    throw new TypeError(
      `Cubism adapter ${options.adapter.id} must apply lip sync through an adapter or model hook`,
    );
  };

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
  Boolean(
    value &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function",
  );

const lifecycleCall = (
  controller: CubismLipSyncController,
  method: (...args: unknown[]) => unknown,
  receiver: object,
  args: unknown[],
): unknown => {
  let controllerError: unknown;
  try {
    controller.dispose();
  } catch (error) {
    controllerError = error;
  }
  let result: unknown;
  try {
    result = Reflect.apply(method, receiver, args);
  } catch (error) {
    if (controllerError !== undefined) {
      throw new AggregateError(
        [controllerError, error],
        "Cubism lip-sync and model disposal both failed",
      );
    }
    throw error;
  }
  if (controllerError === undefined) return result;
  if (isPromiseLike(result)) {
    return Promise.resolve(result).then(
      () => {
        throw controllerError;
      },
      (error: unknown) => {
        throw new AggregateError(
          [controllerError, error],
          "Cubism lip-sync and model disposal both failed",
        );
      },
    );
  }
  throw controllerError;
};

function attachCubismLipSync(
  model: StoryCharacterModel,
  context: CubismLipSyncModelContext,
  options: CreateCubismPluginOptions,
  lifecycleMethods: readonly string[],
): CubismStoryCharacterModel;
function attachCubismLipSync(
  model: CubismRendererCharacterModel,
  context: CubismLipSyncModelContext,
  options: CreateCubismPluginOptions,
  lifecycleMethods: readonly string[],
): CubismRendererCharacterModel;
function attachCubismLipSync(
  model: unknown,
  context: CubismLipSyncModelContext,
  options: CreateCubismPluginOptions,
  lifecycleMethods: readonly string[],
): unknown;
function attachCubismLipSync(
  model: unknown,
  context: CubismLipSyncModelContext,
  options: CreateCubismPluginOptions,
  lifecycleMethods: readonly string[],
): unknown {
  if (!model || typeof model !== "object") return model;
  const profile = resolveMouthParameterProfile(context, options);
  const provider = options.lipSync?.createAudioProvider?.(context) ?? null;
  if (provider && typeof provider.sample !== "function") {
    throw new TypeError("Cubism audio analysis providers require sample()");
  }
  const controller = new RuntimeCubismLipSyncController(
    provider,
    options.lipSync ?? {},
    createLipSyncApply(context, options, profile),
  );
  const target = model as object;
  const lifecycle = new Set(lifecycleMethods);
  const methodCache = new Map<PropertyKey, unknown>();
  let lifecycleInvoked = false;
  let lifecycleResult: unknown;
  let lifecycleFailed = false;
  let lifecycleError: unknown;
  const autoUpdate =
    controller.hasAudioProvider && options.lipSync?.autoUpdate !== false;
  const updatePhase = options.lipSync?.updatePhase ?? "before";
  const proxy = new Proxy(target, {
    get(targetModel, property) {
      if (property === CUBISM_LIP_SYNC || property === "cubismLipSync") {
        return controller;
      }
      const value = Reflect.get(targetModel, property, targetModel);
      if (typeof value !== "function") return value;
      const cached = methodCache.get(property);
      if (cached) return cached;
      let bound: (...args: unknown[]) => unknown;
      if (typeof property === "string" && lifecycle.has(property)) {
        bound = (...args) => {
          if (lifecycleInvoked) {
            if (lifecycleFailed) throw lifecycleError;
            return lifecycleResult;
          }
          lifecycleInvoked = true;
          try {
            lifecycleResult = lifecycleCall(
              controller,
              value,
              targetModel,
              args,
            );
            return lifecycleResult;
          } catch (error) {
            lifecycleFailed = true;
            lifecycleError = error;
            throw error;
          }
        };
      } else if (property === "update" && autoUpdate) {
        bound = (...args) => {
          const deltaSeconds = typeof args[0] === "number" ? args[0] : 1 / 60;
          if (updatePhase === "before") controller.update(deltaSeconds);
          const result = Reflect.apply(value, targetModel, args);
          if (updatePhase === "after") {
            if (isPromiseLike(result)) {
              return Promise.resolve(result).then((resolved) => {
                controller.update(deltaSeconds);
                return resolved;
              });
            }
            controller.update(deltaSeconds);
          }
          return result;
        };
      } else {
        bound = (...args) => Reflect.apply(value, targetModel, args);
      }
      methodCache.set(property, bound);
      return bound;
    },
    set(targetModel, property, value) {
      return Reflect.set(targetModel, property, value, targetModel);
    },
  });
  cubismLipSyncControllers.set(target, controller);
  cubismLipSyncControllers.set(proxy, controller);
  return proxy;
}

export const getCubismLipSyncController = (
  model: unknown,
): CubismLipSyncController | null => {
  if (!model || typeof model !== "object") return null;
  return cubismLipSyncControllers.get(model) ?? null;
};

export {
  AdvHarmonicMotionController,
  evaluateAdvHarmonicMotion,
  type AdvHarmonicMotionData,
  type AdvHarmonicMotionParameter,
  type AdvHarmonicParameterSource,
} from "./runtime/AdvHarmonicMotion.js";
export {
  clearCubismResourceCache,
  configureCubismResourceCache,
  type CubismModelResourceLoader,
  type CubismResourceCacheOptions,
} from "./runtime/CubismResourceCache.js";
export {
  createAdvVowelMotionSyncSetting as createCubismVowelMotionSyncSetting,
  type AdvVowelMotionSyncAudioScales as CubismVowelMotionSyncAudioScales,
  type AdvVowelMotionSyncParameter as CubismVowelMotionSyncParameter,
  type AdvVowelMotionSyncTargets as CubismVowelMotionSyncTargets,
} from "./runtime/AdvVowelMotionSync.js";
export {
  type CubismMotionSyncRuntime,
  type CubismMotionSyncSetting,
  type CubismParameterBlend as CubismRuntimeParameterBlend,
} from "./runtime/types.js";

export default createCubismPlugin;
