/* Copyright 2026 Haneoka Gakuen contributors. MPL-2.0 licensed. */
interface ArrayBufferCacheEntry {
  pending: Promise<ArrayBuffer>;
  byteLength: number | null;
}

const arrayBufferCache = new Map<string, ArrayBufferCacheEntry>();
const imageCache = new Map<string, Promise<TexImageSource>>();
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
  loadImage(url: string, signal?: AbortSignal): Promise<TexImageSource>;
}

/** Structural subset of Vega's resource resolver used by the web runtime. */
export interface CubismStoryResourceResolver {
  canLoad(source: string): boolean;
  load(source: string, signal?: AbortSignal): Promise<Uint8Array>;
  /** Trusted immutable fast path introduced by Vega 0.1. */
  loadSharedBytes?(
    source: string,
    signal?: AbortSignal,
  ): Promise<Readonly<Uint8Array>>;
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

function touchImage(key: string, value: Promise<TexImageSource>): void {
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

function deleteArrayBufferEntry(
  key: string,
  expected?: ArrayBufferCacheEntry,
): void {
  const entry = arrayBufferCache.get(key);
  if (!entry || (expected && entry !== expected)) return;
  arrayBufferCache.delete(key);
  arrayBufferBytes = Math.max(
    0,
    arrayBufferBytes - (entry.byteLength ?? 0),
  );
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
  return Number.isFinite(number)
    ? Math.max(0, Math.trunc(number))
    : fallback;
}

/**
 * Configure the process-wide fallback resource cache.
 *
 * The numeric overload is retained for compatibility and now controls images
 * only. Binary resources use an independent byte budget.
 */
export function configureCubismResourceCache(entryLimit: number): void;
export function configureCubismResourceCache(
  options: CubismResourceCacheOptions,
): void;
export function configureCubismResourceCache(
  options: number | CubismResourceCacheOptions,
): void {
  if (typeof options === "number") {
    imageEntryLimit = Math.max(
      8,
      cacheLimit(options, DEFAULT_IMAGE_ENTRY_LIMIT),
    );
  } else {
    if (options.imageEntryLimit !== undefined) {
      imageEntryLimit = cacheLimit(
        options.imageEntryLimit,
        DEFAULT_IMAGE_ENTRY_LIMIT,
      );
    }
    if (options.arrayBufferByteLimit !== undefined) {
      arrayBufferByteLimit = cacheLimit(
        options.arrayBufferByteLimit,
        DEFAULT_ARRAY_BUFFER_BYTE_LIMIT,
      );
    }
  }
  while (imageCache.size > imageEntryLimit) {
    const oldest = imageCache.keys().next().value;
    if (oldest == null) break;
    imageCache.delete(oldest);
  }
  trimArrayBufferCache();
}

function retainFulfilledArrayBuffer(
  url: string,
  entry: ArrayBufferCacheEntry,
  buffer: ArrayBuffer,
): ArrayBuffer {
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

function loadImage(url: string): Promise<TexImageSource> {
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

export function loadCachedImage(url: string, signal?: AbortSignal): Promise<TexImageSource> {
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

const resolverLoaders = new WeakMap<object, CubismModelResourceLoader>();

function cubismContentType(source: string): string {
  const pathname = source.split(/[?#]/u, 1)[0]?.toLowerCase() ?? "";
  if (pathname.endsWith(".png")) return "image/png";
  if (pathname.endsWith(".webp")) return "image/webp";
  if (pathname.endsWith(".gif")) return "image/gif";
  if (pathname.endsWith(".svg")) return "image/svg+xml";
  if (pathname.endsWith(".jpg") || pathname.endsWith(".jpeg")) return "image/jpeg";
  if (pathname.endsWith(".avif")) return "image/avif";
  return "application/octet-stream";
}

function ownedArrayBuffer(bytes: Readonly<Uint8Array>): ArrayBuffer {
  // Resolver bytes are canonical shared cache state. Cubism Core, legacy
  // runtimes, and framework parsers accept mutable ArrayBuffers and do not
  // promise that they neither retain nor alter them. Give every parser/model
  // an owned boundary buffer so SDK behavior can never corrupt Vega's resident
  // bytes or another model instance.
  return Uint8Array.from(bytes).buffer;
}

function decodeImageBuffer(
  source: string,
  buffer: ArrayBuffer,
  signal?: AbortSignal,
): Promise<TexImageSource> {
  const objectUrl = URL.createObjectURL(
    new Blob([buffer], { type: cubismContentType(source) }),
  );
  return new Promise<TexImageSource>((resolve, reject) => {
    const image = new Image();
    let settled = false;
    const cleanup = (): void => {
      image.removeEventListener("load", loaded);
      image.removeEventListener("error", failed);
      signal?.removeEventListener("abort", aborted);
      URL.revokeObjectURL(objectUrl);
    };
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const loaded = (): void => finish(() => resolve(image));
    const failed = (): void =>
      finish(() => reject(new Error(`Failed to decode Cubism image ${source}`)));
    const aborted = (): void =>
      finish(() => {
        image.src = "";
        reject(abortError(source));
      });
    if (signal?.aborted) {
      aborted();
      return;
    }
    image.decoding = "async";
    image.addEventListener("load", loaded, { once: true });
    image.addEventListener("error", failed, { once: true });
    signal?.addEventListener("abort", aborted, { once: true });
    image.src = objectUrl;
  });
}

interface ResolverImageCacheEntry {
  pending: Promise<TexImageSource>;
  readonly controller: AbortController;
  waiters: number;
  settled: boolean;
}

function waitForResolverImage(
  entry: ResolverImageCacheEntry,
  signal: AbortSignal | undefined,
  url: string,
  onIdle: () => void,
): Promise<TexImageSource> {
  if (signal?.aborted) return Promise.reject(abortError(url));
  entry.waiters += 1;
  return new Promise<TexImageSource>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", aborted);
      entry.waiters = Math.max(0, entry.waiters - 1);
      if (!entry.settled && entry.waiters === 0) onIdle();
      callback();
    };
    const aborted = (): void => finish(() => reject(abortError(url)));
    signal?.addEventListener("abort", aborted, { once: true });
    entry.pending.then(
      (image) => finish(() => resolve(image)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

/**
 * Adapts Vega's preloaded canonical bytes to Cubism's parser and image APIs.
 * One adapter is retained per resolver, so model instances share decoded
 * textures without allowing identically named resources from another project
 * to alias each other.
 */
export function cubismResourceLoaderFor(
  resources: CubismStoryResourceResolver,
): CubismModelResourceLoader {
  const owner = resources as object;
  const existing = resolverLoaders.get(owner);
  if (existing) return existing;

  const images = new Map<string, ResolverImageCacheEntry>();
  const touchResolverImage = (
    url: string,
    entry: ResolverImageCacheEntry,
  ): void => {
    if (images.get(url) !== entry) return;
    images.delete(url);
    images.set(url, entry);
  };
  const trimResolverImages = (): void => {
    while (images.size > imageEntryLimit) {
      let removed = false;
      for (const [url, entry] of images) {
        if (!entry.settled) continue;
        images.delete(url);
        removed = true;
        break;
      }
      if (!removed) return;
    }
  };
  const loadBuffer = (url: string, signal?: AbortSignal): Promise<ArrayBuffer> => {
    if (!resources.canLoad(url)) return fetchCachedArrayBuffer(url, signal);
    // Vega already owns the bounded byte LRU and in-flight deduplication. Do
    // not retain a second unbounded ArrayBuffer map in this plugin.
    return Promise.resolve(
      resources.loadSharedBytes
        ? resources.loadSharedBytes(url, signal)
        : resources.load(url, signal),
    ).then(ownedArrayBuffer);
  };
  const loadDecodedImage = (
    url: string,
    signal?: AbortSignal,
  ): Promise<TexImageSource> => {
    if (signal?.aborted) return Promise.reject(abortError(url));
    if (!resources.canLoad(url)) return loadCachedImage(url, signal);
    let entry = images.get(url);
    if (!entry) {
      const controller = new AbortController();
      entry = {
        pending: Promise.resolve(null as unknown as TexImageSource),
        controller,
        waiters: 0,
        settled: false,
      };
      const created = entry;
      created.pending = loadBuffer(url, controller.signal).then(
        (buffer) => decodeImageBuffer(url, buffer, controller.signal),
      ).then(
        (image) => {
          created.settled = true;
          touchResolverImage(url, created);
          trimResolverImages();
          return image;
        },
        (error: unknown) => {
          created.settled = true;
          if (images.get(url) === created) images.delete(url);
          throw error;
        },
      );
      images.set(url, created);
      trimResolverImages();
    } else {
      touchResolverImage(url, entry);
    }
    const current = entry;
    return waitForResolverImage(current, signal, url, () => {
      if (images.get(url) === current) images.delete(url);
      current.controller.abort();
    });
  };

  const loader: CubismModelResourceLoader = {
    loadArrayBuffer: loadBuffer,
    loadImage: loadDecodedImage,
  };
  resolverLoaders.set(owner, loader);
  return loader;
}

export function clearCubismResourceCache(): void {
  arrayBufferCache.clear();
  arrayBufferBytes = 0;
  imageCache.clear();
}
