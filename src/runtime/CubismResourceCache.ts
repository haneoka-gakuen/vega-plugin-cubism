/* Copyright 2026 Haneoka Gakuen contributors. MPL-2.0 licensed. */
interface ArrayBufferCacheEntry {
  pending: Promise<ArrayBuffer>;
  byteLength: number | null;
}

const arrayBufferCache = new Map<string, ArrayBufferCacheEntry>();
const imageCache = new Map<string, Promise<HTMLImageElement>>();
const DEFAULT_IMAGE_ENTRY_LIMIT = 64;
const DEFAULT_ARRAY_BUFFER_BYTE_LIMIT = 64 * 1024 * 1024;
let imageEntryLimit = DEFAULT_IMAGE_ENTRY_LIMIT;
let arrayBufferByteLimit = DEFAULT_ARRAY_BUFFER_BYTE_LIMIT;
let arrayBufferBytes = 0;

export interface CubismResourceCacheOptions {
  /** Maximum decoded image objects retained by the shared fallback loader. */
  readonly imageEntryLimit?: number;
  /** Maximum total bytes retained for fulfilled model, motion, and metadata buffers. */
  readonly arrayBufferByteLimit?: number;
}

export interface OwnedAbortSignal {
  readonly signal: AbortSignal;
  abort(): void;
  detach(): void;
}

export interface CubismModelResourceLoader {
  loadArrayBuffer(url: string, signal?: AbortSignal): Promise<ArrayBuffer>;
  loadImage(url: string, signal?: AbortSignal): Promise<HTMLImageElement>;
}

/**
 * Resolve manifest-relative files for both hierarchical URLs and host-owned
 * opaque schemes such as `haneoka:assets/models/hero.model3.json`.
 */
export function resolveCubismResourceUrl(baseUrl: string, resource: string): string {
  const fallbackBase = globalThis.location?.href || "http://localhost/";
  try {
    return new URL(resource, new URL(baseUrl, fallbackBase)).toString();
  } catch (error) {
    const opaque = /^([A-Za-z][A-Za-z0-9+.-]*:)(?!\/\/)([^?#]*)(?:[?#].*)?$/u.exec(baseUrl);
    if (!opaque) throw error;
    if (resource.startsWith("//")) return `${opaque[1]}${resource}`;
    const syntheticOrigin = "https://haneoka-opaque.invalid";
    const syntheticBase = new URL(`/${opaque[2]!.replace(/^\/+/u, "")}`, syntheticOrigin);
    const resolved = new URL(resource, syntheticBase);
    if (resolved.origin !== syntheticOrigin) return resolved.toString();
    return `${opaque[1]}${resolved.pathname.replace(/^\/+/u, "")}${resolved.search}${resolved.hash}`;
  }
}

export function createOwnedAbortSignal(parent?: AbortSignal): OwnedAbortSignal {
  const controller = new AbortController();
  let attached = false;
  const detach = (): void => {
    if (!attached) return;
    attached = false;
    parent?.removeEventListener("abort", abortFromParent);
  };
  const abortFromParent = (): void => {
    detach();
    controller.abort();
  };
  if (parent?.aborted) controller.abort();
  else if (parent) {
    attached = true;
    parent.addEventListener("abort", abortFromParent, { once: true });
  }
  return {
    signal: controller.signal,
    abort: () => {
      detach();
      controller.abort();
    },
    detach,
  };
}

function touchImage(key: string, value: Promise<HTMLImageElement>): void {
  imageCache.delete(key);
  imageCache.set(key, value);
  while (imageCache.size > imageEntryLimit) {
    const oldest = imageCache.keys().next().value as string | undefined;
    if (oldest == null) break;
    imageCache.delete(oldest);
  }
}

function touchArrayBuffer(key: string, entry: ArrayBufferCacheEntry): void {
  if (arrayBufferCache.get(key) !== entry) return;
  arrayBufferCache.delete(key);
  arrayBufferCache.set(key, entry);
}

function deleteArrayBufferEntry(key: string, expected?: ArrayBufferCacheEntry): void {
  const entry = arrayBufferCache.get(key);
  if (!entry || (expected && entry !== expected)) return;
  arrayBufferCache.delete(key);
  arrayBufferBytes = Math.max(0, arrayBufferBytes - (entry.byteLength ?? 0));
}

function trimArrayBufferCache(): void {
  while (arrayBufferBytes > arrayBufferByteLimit) {
    let removed = false;
    for (const [key, entry] of arrayBufferCache) {
      // In-flight requests have no known cost yet and remain shared. Their
      // completion path applies the current budget before retaining them.
      if (entry.byteLength == null) continue;
      deleteArrayBufferEntry(key, entry);
      removed = true;
      break;
    }
    if (!removed) break;
  }
}

function cacheLimit(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : fallback;
}

/**
 * Configure the process-wide fallback resource cache.
 *
 * The numeric overload is retained for compatibility and now controls images
 * only. Binary resources use an independent byte budget.
 */
export function configureCubismResourceCache(entryLimit: number): void;
export function configureCubismResourceCache(options: CubismResourceCacheOptions): void;
export function configureCubismResourceCache(options: number | CubismResourceCacheOptions): void {
  if (typeof options === "number") {
    imageEntryLimit = Math.max(8, cacheLimit(options, DEFAULT_IMAGE_ENTRY_LIMIT));
  } else {
    if (options.imageEntryLimit !== undefined) {
      imageEntryLimit = cacheLimit(options.imageEntryLimit, DEFAULT_IMAGE_ENTRY_LIMIT);
    }
    if (options.arrayBufferByteLimit !== undefined) {
      arrayBufferByteLimit = cacheLimit(options.arrayBufferByteLimit, DEFAULT_ARRAY_BUFFER_BYTE_LIMIT);
    }
  }
  while (imageCache.size > imageEntryLimit) {
    const oldest = imageCache.keys().next().value;
    if (oldest == null) break;
    imageCache.delete(oldest);
  }
  trimArrayBufferCache();
}

function retainFulfilledArrayBuffer(url: string, entry: ArrayBufferCacheEntry, buffer: ArrayBuffer): ArrayBuffer {
  if (arrayBufferCache.get(url) !== entry) return buffer;
  if (buffer.byteLength > arrayBufferByteLimit) {
    deleteArrayBufferEntry(url, entry);
    return buffer;
  }
  entry.byteLength = buffer.byteLength;
  arrayBufferBytes += buffer.byteLength;
  touchArrayBuffer(url, entry);
  trimArrayBufferCache();
  return buffer;
}

function assertResponse(response: Response, url: string): Response {
  if (!response.ok) throw new Error(`Failed to load ${url}: HTTP ${response.status}`);
  return response;
}

function abortError(url: string): Error {
  const error = new Error(`Loading was aborted: ${url}`);
  error.name = "AbortError";
  return error;
}

async function fetchArrayBuffer(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  return assertResponse(response, url).arrayBuffer();
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    let settled = false;
    const cleanup = (): void => {
      image.removeEventListener("load", loaded);
      image.removeEventListener("error", failed);
    };
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const loaded = (): void => finish(() => resolve(image));
    const failed = (): void => finish(() => reject(new Error(`Failed to load image ${url}`)));
    image.decoding = "async";
    image.crossOrigin = "anonymous";
    image.addEventListener("load", loaded, { once: true });
    image.addEventListener("error", failed, { once: true });
    image.src = url;
  });
}

function waitForCachedResource<T>(pending: Promise<T>, signal: AbortSignal | undefined, url: string): Promise<T> {
  if (!signal) return pending;
  if (signal.aborted) return Promise.reject(abortError(url));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      callback();
    };
    const abort = (): void => finish(() => reject(abortError(url)));
    signal.addEventListener("abort", abort, { once: true });
    pending.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

export function fetchCachedArrayBuffer(url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  if (signal?.aborted) return Promise.reject(abortError(url));
  let entry = arrayBufferCache.get(url);
  if (!entry) {
    entry = {
      pending: Promise.resolve(new ArrayBuffer(0)),
      byteLength: null,
    };
    const created = entry;
    created.pending = fetchArrayBuffer(url)
      .then((buffer) => retainFulfilledArrayBuffer(url, created, buffer))
      .catch((error: unknown) => {
        deleteArrayBufferEntry(url, created);
        throw error;
      });
    arrayBufferCache.set(url, created);
  } else {
    touchArrayBuffer(url, entry);
  }
  return waitForCachedResource(entry.pending, signal, url).then((buffer) => buffer.slice(0));
}

export function loadCachedImage(url: string, signal?: AbortSignal): Promise<HTMLImageElement> {
  if (signal?.aborted) return Promise.reject(abortError(url));
  let pending = imageCache.get(url);
  if (!pending) {
    const created = loadImage(url).catch((error: unknown) => {
      if (imageCache.get(url) === created) imageCache.delete(url);
      throw error;
    });
    pending = created;
    touchImage(url, created);
  } else {
    touchImage(url, pending);
  }
  return waitForCachedResource(pending, signal, url);
}

export const cachedCubismModelResourceLoader: CubismModelResourceLoader = {
  loadArrayBuffer: fetchCachedArrayBuffer,
  loadImage: loadCachedImage,
};

export function clearCubismResourceCache(): void {
  arrayBufferCache.clear();
  arrayBufferBytes = 0;
  imageCache.clear();
}
