import { CubismFramework, LogLevel, Option } from "../../vendor/cubism/live2dcubismframework";

export interface CubismWebRuntimeSources {
  readonly cubismCoreUrl?: string;
  readonly cubism2CoreUrl?: string;
  readonly motionSyncCoreUrl?: string;
}

const runtimeSources: {
  cubismCoreUrl: string;
  cubism2CoreUrl: string;
  motionSyncCoreUrl: string;
} = {
  cubismCoreUrl: "/Core/live2dcubismcore.js",
  cubism2CoreUrl: "/Core/live2d.min.js",
  motionSyncCoreUrl: "/Core/CRI/live2dcubismmotionsynccore.min.js",
};

export function configureCubismWebRuntime(sources: CubismWebRuntimeSources): void {
  if (sources.cubismCoreUrl) runtimeSources.cubismCoreUrl = sources.cubismCoreUrl;
  if (sources.cubism2CoreUrl) runtimeSources.cubism2CoreUrl = sources.cubism2CoreUrl;
  if (sources.motionSyncCoreUrl) runtimeSources.motionSyncCoreUrl = sources.motionSyncCoreUrl;
}

interface CubismGlobalState {
  corePromise: Promise<void> | null;
  cubism2Promise: Promise<void> | null;
  motionSyncPromise: Promise<unknown> | null;
}

const globalKey = "__vegaCubismWebRuntime";
// CubismFramework keeps its ID manager in module-local state. Different ESM
// identities (for example Vite's `?import` module and a viewer's relative
// import) therefore need independent framework initialization even though
// they can share the same externally loaded Core script.
let frameworkPromise: Promise<void> | null = null;

function isLocalFrameworkReady(): boolean {
  return CubismFramework.isInitialized() && Boolean(CubismFramework.getIdManager());
}

function globalState(): CubismGlobalState {
  const target = globalThis as typeof globalThis & Record<string, unknown>;
  const current = target[globalKey];
  if (current && typeof current === "object") {
    const state = current as Partial<CubismGlobalState>;
    state.corePromise ??= null;
    state.cubism2Promise ??= null;
    state.motionSyncPromise ??= null;
    return state as CubismGlobalState;
  }
  const created: CubismGlobalState = {
    corePromise: null,
    cubism2Promise: null,
    motionSyncPromise: null,
  };
  target[globalKey] = created;
  return created;
}

function waitForSharedRuntime<T>(pending: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return pending;
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new DOMException("Cubism runtime initialization was aborted", "AbortError"));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      callback();
    };
    const abort = (): void =>
      finish(() =>
        reject(signal.reason ?? new DOMException("Cubism runtime initialization was aborted", "AbortError")),
      );
    signal.addEventListener("abort", abort, { once: true });
    pending.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function loadClassicScript(url: string, ready: () => boolean, label: string): Promise<void> {
  if (ready()) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const selector = `script[data-story-runtime="${label}"]`;
    const existing = document.querySelector<HTMLScriptElement>(selector);
    const script = existing || document.createElement("script");
    let settled = false;
    const cleanup = (): void => {
      script.removeEventListener("load", finish);
      script.removeEventListener("error", failed);
    };
    const succeed = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      script.remove();
      reject(error);
    };
    const finish = (): void => {
      if (ready()) succeed();
      else fail(new Error(`${label} loaded without creating its global API`));
    };
    const failed = (): void => fail(new Error(`Failed to load ${label} from ${url}`));
    script.addEventListener("load", finish, { once: true });
    script.addEventListener("error", failed, { once: true });
    if (existing) return;
    script.src = url;
    script.async = true;
    script.dataset.storyRuntime = label;
    document.head.appendChild(script);
  });
}

export async function ensureCubismFramework(signal?: AbortSignal): Promise<void> {
  const state = globalState();
  if (isLocalFrameworkReady()) return;
  if (!frameworkPromise) {
    const pending = (async () => {
      if (!state.corePromise) {
        const globals = globalThis as typeof globalThis & {
          Live2DCubismCore?: unknown;
        };
        state.corePromise = loadClassicScript(
          runtimeSources.cubismCoreUrl,
          () => Boolean(globals.Live2DCubismCore),
          "live2d-cubism-core",
        ).catch((error: unknown) => {
          state.corePromise = null;
          throw error;
        });
      }
      await state.corePromise;
      if (isLocalFrameworkReady()) return;

      const option = new Option();
      option.loggingLevel = LogLevel.LogLevel_Warning;
      option.logFunction = (message: string) => console.warn(`[Cubism] ${message}`);
      CubismFramework.startUp(option);
      CubismFramework.initialize(64 * 1024 * 1024);
      if (!isLocalFrameworkReady()) {
        throw new Error("Cubism Framework initialized without an ID manager");
      }
    })();
    frameworkPromise = pending;
    const clearPending = (): void => {
      if (frameworkPromise === pending) frameworkPromise = null;
    };
    pending.then(clearPending, clearPending);
  }
  await waitForSharedRuntime(frameworkPromise, signal);
  if (!isLocalFrameworkReady()) {
    throw new Error("Cubism Framework is unavailable after initialization");
  }
}

export async function ensureCubism2Framework(signal?: AbortSignal): Promise<void> {
  const state = globalState();
  if (!state.cubism2Promise) {
    const globals = globalThis as typeof globalThis & { Live2D?: { init?: () => void } };
    state.cubism2Promise = loadClassicScript(
      runtimeSources.cubism2CoreUrl,
      () => Boolean(globals.Live2D),
      "live2d-2-core",
    )
      .then(() => {
        if (!globals.Live2D) throw new Error("Live2D (Cubism 2) core is unavailable");
        globals.Live2D.init?.();
      })
      .catch((error: unknown) => {
        state.cubism2Promise = null;
        throw error;
      });
  }
  await waitForSharedRuntime(state.cubism2Promise, signal);
}

export async function ensureMotionSyncCore(errorMessage = "Live2D MotionSync Core is unavailable"): Promise<unknown> {
  const state = globalState();
  const globals = globalThis as typeof globalThis & { Live2DCubismMotionSyncCore?: unknown };
  if (globals.Live2DCubismMotionSyncCore) return globals.Live2DCubismMotionSyncCore;
  if (!state.motionSyncPromise) {
    state.motionSyncPromise = loadClassicScript(
      runtimeSources.motionSyncCoreUrl,
      () => Boolean(globals.Live2DCubismMotionSyncCore),
      "live2d-motion-sync-core",
    )
      .then(() => {
        if (!globals.Live2DCubismMotionSyncCore) throw new Error(errorMessage);
        return globals.Live2DCubismMotionSyncCore;
      })
      .catch((error: unknown) => {
        state.motionSyncPromise = null;
        throw error;
      });
  }
  return state.motionSyncPromise;
}
