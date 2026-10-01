/** Canonical PNG's producer lineage, distinct from the downloadable KTX output. */
export interface CubismTextureSourceIdentity {
  readonly sourcePath: string;
  readonly serializedFile: string;
  readonly objectId: string;
  readonly bundleSha256: string;
  readonly type: string;
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

/** Explicit alternatives to a model manifest's positional PNG texture slots. */
export interface CubismTextureVariant {
  readonly textureIndex: number;
  readonly source: string;
  readonly format: "astc6x6" | "bc7" | "etc2" | "basis";
  readonly container: "ktx2";
  /** Canonical texture identity, when supplied by a catalog producer. */
  readonly texture?: string;
  readonly lossyReencoded?: boolean;
  readonly requiresTranscoding?: boolean;
  readonly width?: number;
  readonly height?: number;
  readonly mipCount?: number;
  readonly orientation?: "ru" | "rd";
  readonly transferFunction?: "linear";
  readonly alphaMode?: "straight" | "opaque";
  /** Integrity of the entire downloadable KTX output, including metadata/mips. */
  readonly sha256?: string;
  readonly byteLength?: number;
  /** Opaque producer cache/profile identity; not an alternative download digest. */
  readonly cacheKey?: string;
  readonly server?: string;
  readonly sourceId?: string;
  readonly producerTextureIndex?: number;
  /** Original Unity mip blocks and canonical PNG provenance; not rehashed at upload. */
  readonly sourcePayloadSha256?: string;
  readonly sourceTextureSha256?: string;
  readonly sourceIdentity?: CubismTextureSourceIdentity;
}

export function normalizeCubismTextureVariants(value: unknown): readonly CubismTextureVariant[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): CubismTextureVariant[] => {
    if (!entry || typeof entry !== "object") return [];
    const { textureIndex, source, format, container, texture } = entry;
    if (
      !Number.isSafeInteger(textureIndex) ||
      textureIndex < 0 ||
      typeof source !== "string" ||
      !source.trim() ||
      container !== "ktx2" ||
      !["astc6x6", "bc7", "etc2", "basis"].includes(format)
    )
      return [];
    for (const field of ["lossyReencoded", "requiresTranscoding"]) {
      if (entry[field] !== undefined && typeof entry[field] !== "boolean") return [];
    }
    if (format === "basis" && entry.requiresTranscoding === false) return [];
    for (const field of ["width", "height", "mipCount"]) {
      if (entry[field] !== undefined && (!Number.isSafeInteger(entry[field]) || entry[field] <= 0)) return [];
    }
    if (entry.orientation !== undefined && !["ru", "rd"].includes(entry.orientation)) return [];
    if (entry.transferFunction !== undefined && entry.transferFunction !== "linear") return [];
    if (entry.alphaMode !== undefined && !["straight", "opaque"].includes(entry.alphaMode)) return [];
    const provenance: Partial<CubismTextureVariant> = {};
    const fields = provenance as Record<string, unknown>;
    for (const field of ["sha256", "sourcePayloadSha256", "sourceTextureSha256"]) {
      if (entry[field] === undefined) continue;
      if (typeof entry[field] !== "string" || !/^[a-f0-9]{64}$/iu.test(entry[field])) return [];
      fields[field] = entry[field].toLowerCase();
    }
    for (const field of ["cacheKey", "server", "sourceId"]) {
      if (entry[field] === undefined) continue;
      if (typeof entry[field] !== "string" || !entry[field].trim()) return [];
      fields[field] = entry[field];
    }
    if (entry.byteLength !== undefined) {
      if (!Number.isSafeInteger(entry.byteLength) || entry.byteLength <= 0) return [];
      fields.byteLength = entry.byteLength;
    }
    if (entry.producerTextureIndex !== undefined) {
      if (!Number.isSafeInteger(entry.producerTextureIndex) || entry.producerTextureIndex < 0) return [];
      fields.producerTextureIndex = entry.producerTextureIndex;
    }
    if (entry.sourceIdentity !== undefined) {
      const identity = entry.sourceIdentity;
      if (!identity || typeof identity !== "object" || Array.isArray(identity)) return [];
      for (const field of ["sourcePath", "serializedFile", "objectId", "type", "path"]) {
        if (typeof identity[field] !== "string" || !identity[field].trim()) return [];
      }
      for (const field of ["bundleSha256", "sha256"]) {
        if (typeof identity[field] !== "string" || !/^[a-f0-9]{64}$/iu.test(identity[field])) return [];
      }
      if (!Number.isSafeInteger(identity.bytes) || identity.bytes <= 0) return [];
      fields.sourceIdentity = {
        sourcePath: identity.sourcePath,
        serializedFile: identity.serializedFile,
        objectId: identity.objectId,
        type: identity.type,
        path: identity.path,
        bundleSha256: identity.bundleSha256.toLowerCase(),
        sha256: identity.sha256.toLowerCase(),
        bytes: identity.bytes,
      };
    }
    return [
      {
        textureIndex,
        source: source.trim(),
        format,
        container,
        ...provenance,
        ...(typeof texture === "string" && texture.trim() ? { texture: texture.trim() } : {}),
        ...(entry.lossyReencoded !== undefined ? { lossyReencoded: entry.lossyReencoded } : {}),
        ...(format === "basis"
          ? { requiresTranscoding: true }
          : entry.requiresTranscoding !== undefined
            ? { requiresTranscoding: entry.requiresTranscoding }
            : {}),
        ...(entry.width !== undefined ? { width: entry.width } : {}),
        ...(entry.height !== undefined ? { height: entry.height } : {}),
        ...(entry.mipCount !== undefined ? { mipCount: entry.mipCount } : {}),
        ...(entry.orientation !== undefined ? { orientation: entry.orientation } : {}),
        ...(entry.transferFunction !== undefined ? { transferFunction: entry.transferFunction } : {}),
        ...(entry.alphaMode !== undefined ? { alphaMode: entry.alphaMode } : {}),
      },
    ];
  });
}
