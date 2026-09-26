import { zip, type AsyncZippable } from "fflate";

export type CubismExportStage = "manifest" | "resources" | "archive";

export interface CubismExportProgress {
  readonly stage: CubismExportStage;
  readonly completed: number;
  readonly total?: number;
  readonly loadedBytes: number;
}

export interface ExportCubismModelOptions {
  readonly modelUrl: string;
  readonly name?: string;
  readonly signal?: AbortSignal;
  readonly load?: (url: string, signal?: AbortSignal) => Promise<Uint8Array>;
  readonly onProgress?: (progress: CubismExportProgress) => void;
}

export interface ExportCubismModelResult {
  readonly fileName: string;
  readonly bytes: Uint8Array;
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

interface ResourceEntry {
  readonly fetchUrl: string;
  readonly archivePath: string;
  bytes: Uint8Array | null;
}

const hasOwn = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

const isObject = (value: JsonValue | undefined): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const abortError = (reason: unknown): Error => {
  if (reason instanceof Error) return reason;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
};

const throwIfAborted = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) throw abortError(signal.reason);
};

const splitUrlSuffix = (value: string): { readonly path: string; readonly suffix: string } => {
  const index = value.search(/[?#]/u);
  return index < 0 ? { path: value, suffix: "" } : { path: value.slice(0, index), suffix: value.slice(index) };
};

const normalizeOpaquePath = (value: string): string => {
  const leadingSlash = value.startsWith("/");
  const output: string[] = [];
  for (const segment of value.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (output.length > 0 && output[output.length - 1] !== "..") output.pop();
      else if (!leadingSlash) output.push(segment);
      continue;
    }
    output.push(segment);
  }
  return `${leadingSlash ? "/" : ""}${output.join("/")}`;
};

const resolveOpaqueUrl = (reference: string, base: string): string => {
  const scheme = base.match(/^[A-Za-z][A-Za-z\d+.-]*:/u)?.[0];
  if (!scheme) throw new TypeError(`The model URL must be absolute: ${base}`);
  const baseWithoutSuffix = splitUrlSuffix(base).path;
  const referenceParts = splitUrlSuffix(reference);
  if (referenceParts.path === "") return `${baseWithoutSuffix}${referenceParts.suffix}`;
  const basePath = baseWithoutSuffix.slice(scheme.length);
  const baseDirectory = basePath.slice(0, basePath.lastIndexOf("/") + 1);
  const joinedPath = referenceParts.path.startsWith("/")
    ? referenceParts.path
    : `${baseDirectory}${referenceParts.path}`;
  return `${scheme}${normalizeOpaquePath(joinedPath)}${referenceParts.suffix}`;
};

const resolveResourceUrl = (reference: string, base: string): string => {
  if (!reference) throw new TypeError("Cubism resource references must not be empty");
  try {
    return new URL(reference, base).href;
  } catch {
    return resolveOpaqueUrl(reference, base);
  }
};

const urlPathname = (value: string): string => {
  try {
    return new URL(value).pathname;
  } catch {
    return splitUrlSuffix(value).path.replace(/^[A-Za-z][A-Za-z\d+.-]*:/u, "");
  }
};

const hashText = (value: string): string => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

const safeComponent = (value: string, fallback: string): string => {
  let result = value
    .normalize("NFC")
    .replace(/[\\/\u0000-\u001f\u007f?#<>:"|*]/gu, "-")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[. ]+$/u, "");
  if (!result || result === "." || result === "..") result = fallback;
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(result)) result = `_${result}`;
  return result;
};

const resourceBasename = (fetchUrl: string, reference: string): string => {
  const fromUrl = urlPathname(fetchUrl).split("/").filter(Boolean).pop();
  const fromReference = splitUrlSuffix(reference).path.split(/[\\/]/u).filter(Boolean).pop();
  let basename = fromUrl || fromReference || `resource-${hashText(fetchUrl)}`;
  try {
    basename = decodeURIComponent(basename);
  } catch {
    // Keep the encoded filename when the source URL has malformed escaping.
  }
  return safeComponent(basename, `resource-${hashText(fetchUrl)}`);
};

const reservePath = (desired: string, used: Set<string>): string => {
  const key = (value: string) => value.normalize("NFC").toLowerCase();
  if (!used.has(key(desired))) {
    used.add(key(desired));
    return desired;
  }
  const extensionIndex = desired.lastIndexOf(".");
  const stem = extensionIndex > 0 ? desired.slice(0, extensionIndex) : desired;
  const extension = extensionIndex > 0 ? desired.slice(extensionIndex) : "";
  let suffix = 2;
  let candidate = `${stem}-${suffix}${extension}`;
  while (used.has(key(candidate))) {
    suffix += 1;
    candidate = `${stem}-${suffix}${extension}`;
  }
  used.add(key(candidate));
  return candidate;
};

const isSafeArchivePath = (value: string): boolean => {
  if (!value || value.startsWith("/") || value.includes("\\") || value.includes("?") || value.includes("#")) {
    return false;
  }
  return value.split("/").every((segment) => Boolean(segment) && segment !== "." && segment !== "..");
};

class ResourceCollector {
  private readonly byUrl = new Map<string, ResourceEntry>();
  private readonly usedPaths = new Set<string>();
  private readonly resources: ResourceEntry[] = [];

  constructor(
    private readonly baseUrl: string,
    descriptorPath: string,
  ) {
    this.usedPaths.add(descriptorPath.normalize("NFC").toLowerCase());
  }

  add(reference: string, folder: string): string {
    if (typeof reference !== "string" || reference.length === 0) {
      throw new TypeError("Cubism resource references must be non-empty strings");
    }
    const fetchUrl = resolveResourceUrl(reference, this.baseUrl);
    const existing = this.byUrl.get(fetchUrl);
    if (existing) return existing.archivePath;

    const basename = resourceBasename(fetchUrl, reference);
    const desired = folder ? `${folder}/${basename}` : basename;
    const archivePath = reservePath(desired, this.usedPaths);
    if (!isSafeArchivePath(archivePath)) throw new Error(`Unsafe archive path generated for ${reference}`);
    const entry: ResourceEntry = { fetchUrl, archivePath, bytes: null };
    this.byUrl.set(fetchUrl, entry);
    this.resources.push(entry);
    return archivePath;
  }

  list(): readonly ResourceEntry[] {
    return this.resources;
  }
}

const rewriteFileProperties = (
  record: JsonObject,
  fields: readonly string[],
  folder: string,
  collector: ResourceCollector,
): void => {
  for (const field of fields) {
    if (!hasOwn(record, field)) continue;
    const value = record[field];
    if (value === null) continue;
    if (typeof value !== "string" || value.length === 0) {
      throw new TypeError(`Cubism ${field} references must be non-empty strings`);
    }
    record[field] = collector.add(value, folder);
  }
};

const rewriteSingleFields = (
  record: JsonObject,
  fields: readonly string[],
  folder: string,
  collector: ResourceCollector,
  required = false,
): boolean => {
  let found = false;
  for (const field of fields) {
    if (!hasOwn(record, field)) continue;
    const value = record[field];
    if (value === null) continue;
    if (typeof value !== "string" || value.length === 0) {
      throw new TypeError(`Cubism ${field} references must be non-empty strings`);
    }
    record[field] = collector.add(value, folder);
    found = true;
  }
  if (required && !found) throw new Error(`Cubism descriptor is missing ${fields[0]} reference`);
  return found;
};

const rewriteTextures = (record: JsonObject, fields: readonly string[], collector: ResourceCollector): void => {
  for (const field of fields) {
    if (!hasOwn(record, field)) continue;
    const value = record[field];
    if (value === null) continue;
    if (!Array.isArray(value)) throw new TypeError(`Cubism ${field} must be an array`);
    record[field] = value.map((item) => {
      if (typeof item !== "string" || item.length === 0) {
        throw new TypeError(`Cubism ${field} references must be non-empty strings`);
      }
      return collector.add(item, "textures");
    });
  }
};

const rewriteExpressions = (record: JsonObject, fields: readonly string[], collector: ResourceCollector): void => {
  for (const field of fields) {
    if (!hasOwn(record, field)) continue;
    const value = record[field];
    if (value === null) continue;
    if (!Array.isArray(value)) throw new TypeError(`Cubism ${field} must be an array`);
    for (const item of value) {
      if (!isObject(item)) throw new TypeError(`Cubism ${field} entries must be objects`);
      rewriteFileProperties(item, ["File", "file"], "expressions", collector);
    }
  }
};

const rewriteMotionList = (value: JsonValue, collector: ResourceCollector): void => {
  if (!Array.isArray(value)) throw new TypeError("Cubism motion groups must be arrays");
  for (const item of value) {
    if (!isObject(item)) throw new TypeError("Cubism motion entries must be objects");
    rewriteFileProperties(item, ["File", "file"], "motions", collector);
    rewriteFileProperties(item, ["Sound", "sound"], "sounds", collector);
  }
};

const rewriteMotions = (record: JsonObject, fields: readonly string[], collector: ResourceCollector): void => {
  for (const field of fields) {
    if (!hasOwn(record, field)) continue;
    const value = record[field];
    if (value === null) continue;
    if (!isObject(value)) throw new TypeError(`Cubism ${field} must be an object`);
    for (const [group, groupValue] of Object.entries(value)) {
      if (Array.isArray(groupValue)) {
        rewriteMotionList(groupValue, collector);
        continue;
      }
      if (!isObject(groupValue)) throw new TypeError(`Cubism motion group ${group} must be an array or object`);
      const motionList = groupValue.Motion ?? groupValue.motion;
      if (!Array.isArray(motionList)) throw new TypeError(`Cubism motion group ${group} has no motion array`);
      rewriteMotionList(motionList, collector);
      // Standard model descriptors map each group directly to an array.
      value[group] = motionList;
    }
  }
};

const rewriteMotionSync = (record: JsonObject, fields: readonly string[], collector: ResourceCollector): void => {
  const rewriteValue = (value: JsonValue): JsonValue => {
    if (typeof value === "string") return collector.add(value, "");
    if (Array.isArray(value)) {
      return value.map((item) => {
        if (typeof item === "string") return collector.add(item, "");
        if (!isObject(item)) return item;
        rewriteFileProperties(item, ["File", "file"], "", collector);
        return item;
      });
    }
    if (isObject(value)) {
      rewriteFileProperties(value, ["File", "file"], "", collector);
    }
    return value;
  };

  for (const field of fields) {
    if (!hasOwn(record, field)) continue;
    const value = record[field];
    if (value === null || value === undefined) continue;
    record[field] = rewriteValue(value);
  }
};

const descriptorName = (modelUrl: string, requestedName: string | undefined): string => {
  let candidate = requestedName?.trim() || "";
  if (!candidate) {
    const segments = urlPathname(modelUrl).split("/").filter(Boolean);
    const decoded = segments.map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
    const last = decoded[decoded.length - 1] || "";
    if (/^(?:model3|model)\.json$/iu.test(last)) {
      candidate = decoded[decoded.length - 2] || "model";
    } else candidate = last || "model";
  }
  candidate = candidate.replace(/[._ -]+(?:model3|model)(?:\.json)?$/iu, "").replace(/\.zip$/iu, "");
  return safeComponent(candidate, "model");
};

const isAlreadyCompressed = (path: string): boolean => /\.(?:avif|gif|jpe?g|png|mp3|ogg|webm|webp)$/iu.test(path);

const defaultLoad = async (url: string, signal?: AbortSignal): Promise<Uint8Array> => {
  const response = await fetch(url, signal === undefined ? undefined : { signal });
  if (!response.ok) throw new Error(`Cubism resource request failed with HTTP ${response.status}: ${url}`);
  return new Uint8Array(await response.arrayBuffer());
};

const compressArchive = (files: AsyncZippable, signal: AbortSignal): Promise<Uint8Array> =>
  new Promise((resolve, reject) => {
    let settled = false;
    let terminate: (() => void) | undefined;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      terminate?.();
      cleanup();
      reject(abortError(signal.reason));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    terminate = zip(files, { level: 6 }, (error, data) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else {
        try {
          throwIfAborted(signal);
          resolve(data);
        } catch (abort) {
          reject(abort);
        }
      }
    });
  });

export const exportCubismModel = async ({
  modelUrl,
  name,
  signal,
  load = defaultLoad,
  onProgress,
}: ExportCubismModelOptions): Promise<ExportCubismModelResult> => {
  if (typeof modelUrl !== "string" || modelUrl.length === 0) throw new TypeError("modelUrl is required");
  try {
    new URL(modelUrl);
  } catch {
    if (!/^[A-Za-z][A-Za-z\d+.-]*:/u.test(modelUrl)) {
      throw new TypeError("modelUrl must be an absolute URL or custom resource URL");
    }
  }
  throwIfAborted(signal);

  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", forwardAbort, { once: true });
  let loadedBytes = 0;
  const report = (stage: CubismExportStage, completed: number, total?: number): void => {
    onProgress?.({ ...(total === undefined ? {} : { total }), stage, completed, loadedBytes });
  };

  try {
    report("manifest", 0, 1);
    const manifestBytes = await (async () => {
      throwIfAborted(controller.signal);
      const bytes = await load(modelUrl, controller.signal);
      if (!(bytes instanceof Uint8Array)) throw new TypeError("Cubism resource loaders must return Uint8Array values");
      throwIfAborted(controller.signal);
      return bytes;
    })();
    loadedBytes += manifestBytes.byteLength;
    report("manifest", 1, 1);

    let descriptor: JsonValue;
    try {
      descriptor = JSON.parse(new TextDecoder().decode(manifestBytes)) as JsonValue;
    } catch (error) {
      throw new Error(
        `Cubism model descriptor is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!isObject(descriptor)) throw new TypeError("Cubism model descriptor must be a JSON object");

    const hasFileReferences = hasOwn(descriptor, "FileReferences");
    const model3 = hasFileReferences;
    if (model3 && !isObject(descriptor.FileReferences)) {
      throw new TypeError("Cubism FileReferences must be an object");
    }
    const references = model3 ? (descriptor.FileReferences as JsonObject) : descriptor;
    const rootName = descriptorName(modelUrl, name);
    const descriptorPath = `${rootName}.${model3 ? "model3.json" : "model.json"}`;
    const collector = new ResourceCollector(modelUrl, descriptorPath);

    if (model3) rewriteSingleFields(references, ["Moc", "moc"], "", collector, true);
    else rewriteSingleFields(references, ["model", "Model", "Moc", "moc"], "", collector, true);
    rewriteSingleFields(references, ["Physics", "physics"], "", collector);
    rewriteSingleFields(references, ["Pose", "pose"], "", collector);
    rewriteSingleFields(references, ["UserData", "userData", "userdata"], "", collector);
    rewriteSingleFields(references, ["DisplayInfo", "displayInfo"], "", collector);
    rewriteTextures(references, ["Textures", "textures"], collector);
    rewriteExpressions(references, ["Expressions", "expressions"], collector);
    rewriteMotions(references, ["Motions", "motions"], collector);
    rewriteMotionSync(references, ["MotionSync", "motionSync"], collector);

    const resources = collector.list();
    report("resources", 0, resources.length);
    let nextResource = 0;
    let completedResources = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        throwIfAborted(controller.signal);
        const index = nextResource;
        nextResource += 1;
        const resource = resources[index];
        if (!resource) return;
        const bytes = await load(resource.fetchUrl, controller.signal);
        if (!(bytes instanceof Uint8Array))
          throw new TypeError("Cubism resource loaders must return Uint8Array values");
        throwIfAborted(controller.signal);
        resource.bytes = bytes;
        loadedBytes += bytes.byteLength;
        completedResources += 1;
        report("resources", completedResources, resources.length);
      }
    };
    const workerCount = Math.min(4, resources.length);
    try {
      await Promise.all(Array.from({ length: workerCount }, () => worker()));
    } catch (error) {
      controller.abort(error);
      throw error;
    }

    const archiveFiles: AsyncZippable = Object.create(null);
    const descriptorBytes = new TextEncoder().encode(JSON.stringify(descriptor, null, 2));
    archiveFiles[descriptorPath] = [descriptorBytes, { level: 6 }];
    for (const resource of resources) {
      if (!resource.bytes) throw new Error(`Cubism resource was not loaded: ${resource.fetchUrl}`);
      if (hasOwn(archiveFiles, resource.archivePath))
        throw new Error(`Duplicate archive path: ${resource.archivePath}`);
      archiveFiles[resource.archivePath] = [
        resource.bytes,
        { level: isAlreadyCompressed(resource.archivePath) ? 0 : 6 },
      ];
    }
    for (const path of Object.keys(archiveFiles)) {
      if (!isSafeArchivePath(path)) throw new Error(`Unsafe archive path: ${path}`);
    }

    throwIfAborted(controller.signal);
    report("archive", 0, 1);
    const bytes = await compressArchive(archiveFiles, controller.signal);
    report("archive", 1, 1);
    return { fileName: `${rootName}.zip`, bytes };
  } catch (error) {
    if (!controller.signal.aborted) controller.abort(error);
    throw error;
  } finally {
    signal?.removeEventListener("abort", forwardAbort);
  }
};
