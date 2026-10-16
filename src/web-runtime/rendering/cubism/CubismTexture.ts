import { Unzlib } from "fflate";
import type { CubismTextureVariant } from "../../../runtime/CubismTextureVariant";
import {
  createOwnedAbortSignal,
  resolveCubismResourceUrl,
  type CubismModelResourceLoader,
  type CubismOptionalBytesLease,
} from "./CubismResourceCache";

export interface CubismUploadedTexture {
  readonly texture: WebGLTexture;
  /** Flip the shader's normal top-left image coordinates for bottom-left blocks. */
  readonly flipY: boolean;
}

export interface CubismTextureSelectionOptions {
  /** Explicitly permit producer-marked or unclassified BC7/ETC re-encodes. */
  readonly allowLossyReencoded?: boolean;
  /** One total budget for optional variants; canonical PNG has its own owner signal. */
  readonly optionalTimeoutMilliseconds?: number;
}

interface BlockFormat {
  readonly extension: string;
  readonly internalFormat: number;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly name: CubismTextureVariant["format"];
  readonly colorModel: number;
}

const formats: Readonly<Record<number, BlockFormat>> = {
  165: {
    extension: "WEBGL_compressed_texture_astc",
    internalFormat: 0x93b4,
    width: 6,
    height: 6,
    bytes: 16,
    name: "astc6x6",
    colorModel: 162,
  },
  145: {
    extension: "EXT_texture_compression_bptc",
    internalFormat: 0x8e8c,
    width: 4,
    height: 4,
    bytes: 16,
    name: "bc7",
    colorModel: 134,
  },
  147: {
    extension: "WEBGL_compressed_texture_etc",
    internalFormat: 0x9274,
    width: 4,
    height: 4,
    bytes: 8,
    name: "etc2",
    colorModel: 161,
  },
  151: {
    extension: "WEBGL_compressed_texture_etc",
    internalFormat: 0x9278,
    width: 4,
    height: 4,
    bytes: 16,
    name: "etc2",
    colorModel: 161,
  },
};

const supports = (gl: WebGL2RenderingContext, format: BlockFormat): boolean => {
  if (gl.isContextLost()) return false;
  const extension = gl.getExtension(format.extension);
  if (!extension) return false;
  if (format.name === "astc6x6" && !extension.getSupportedProfiles?.().includes("ldr")) return false;
  const supported = gl.getParameter(gl.COMPRESSED_TEXTURE_FORMATS) as Int32Array | null;
  return Boolean(supported && Array.from(supported).includes(format.internalFormat));
};

const isLossy = (variant: CubismTextureVariant): boolean =>
  variant.lossyReencoded === true || (variant.lossyReencoded === undefined && variant.format !== "astc6x6");

/** Current-context native eligibility; Basis/transcoding entries remain PNG fallbacks. */
export function supportsCubismTextureVariant(
  gl: WebGL2RenderingContext,
  variant: CubismTextureVariant,
  options: CubismTextureSelectionOptions = {},
): boolean {
  if (variant.requiresTranscoding || (isLossy(variant) && options.allowLossyReencoded !== true)) return false;
  const maximum = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE));
  if (!Number.isFinite(maximum) || maximum <= 0 || (variant.width ?? 1) > maximum || (variant.height ?? 1) > maximum)
    return false;
  return Object.entries(formats).some(
    ([vk, format]) =>
      format.name === variant.format && (Number(vk) !== 147 || variant.alphaMode === "opaque") && supports(gl, format),
  );
}

function waitForTextureResource<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", aborted);
      callback();
    };
    const aborted = (): void => finish(() => reject(signal.reason));
    signal.addEventListener("abort", aborted, { once: true });
    pending.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

async function optionalTextureBuffer(
  resources: CubismModelResourceLoader,
  source: string,
  signal: AbortSignal,
  expiresAt: number,
): Promise<ArrayBuffer> {
  if (!resources.retainOptionalBytes) return waitForTextureResource(resources.loadArrayBuffer(source, signal), signal);
  let abandoned = false;
  let lease: CubismOptionalBytesLease | undefined;
  const pending = resources.retainOptionalBytes(source, { signal, expiresAt });
  void pending.then(
    (value) => {
      if (!abandoned) return;
      try {
        value.release();
      } catch (error) {
        // This operation already settled; report background cleanup failure
        // without creating an unobserved rejection or delaying PNG fallback.
        console.error("Cubism late optional byte lease release failed", error);
      }
    },
    () => {},
  );
  try {
    lease = await waitForTextureResource(pending, signal);
    throwIfAborted(signal);
    // The preparation scope owns this buffer; the encoded-file lease can end
    // before synchronous upload without retaining a decoder or GPU handle.
    return Uint8Array.from(lease.bytes).buffer;
  } finally {
    abandoned = true;
    lease?.release();
  }
}

async function verifyTextureVariantBytes(
  buffer: ArrayBuffer,
  variant: CubismTextureVariant,
  signal: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  if (variant.byteLength !== undefined && buffer.byteLength !== variant.byteLength)
    throw new Error("Cubism KTX output byte length does not match its declared integrity");
  // Legacy manifests without a digest keep their physical KTX validation;
  // they are not treated as cryptographically verified downloads.
  if (variant.sha256 === undefined) return;
  if (typeof variant.sha256 !== "string" || !/^[a-f0-9]{64}$/iu.test(variant.sha256))
    throw new Error("Cubism KTX output SHA-256 is invalid");
  if (globalThis.isSecureContext === false || !globalThis.crypto?.subtle)
    throw new Error("Cubism KTX output SHA-256 verification is unavailable in this context");
  const digest = await waitForTextureResource(globalThis.crypto.subtle.digest("SHA-256", buffer), signal);
  throwIfAborted(signal);
  const actual = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
  if (actual !== variant.sha256.toLowerCase()) throw new Error("Cubism KTX output SHA-256 mismatch");
}

function configureTexture(gl: WebGL2RenderingContext, anisotropy: number, levels = 1): void {
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, levels > 1 ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, levels - 1);
  if (anisotropy > 1) {
    const ext = gl.getExtension("EXT_texture_filter_anisotropic");
    if (ext)
      gl.texParameterf(
        gl.TEXTURE_2D,
        ext.TEXTURE_MAX_ANISOTROPY_EXT,
        Math.min(anisotropy, Number(gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT)) || 1),
      );
  }
}

/** Keep a synchronous raw upload from changing its shared context's caller state. */
function saveTextureUploadState(gl: WebGL2RenderingContext, unpackParameters: readonly number[] = []): () => void {
  const binding = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
  const unpack = unpackParameters.map((parameter) => [parameter, Number(gl.getParameter(parameter))] as const);
  return () => {
    if (gl.isContextLost()) return;
    for (const [parameter, value] of unpack) gl.pixelStorei(parameter, value);
    gl.bindTexture(gl.TEXTURE_2D, binding);
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Texture loading was aborted", "AbortError");
}

function inflateBlocks(payload: Uint8Array, expected: number): Uint8Array {
  if (payload.length < 6) throw new Error("KTX2 zlib level is truncated");
  const output = new Uint8Array(expected);
  let written = 0;
  let adlerA = 1,
    adlerB = 0;
  const decoder = new Unzlib((chunk) => {
    if (written + chunk.length > expected) throw new Error("KTX2 zlib level exceeds its declared block size");
    output.set(chunk, written);
    written += chunk.length;
    for (let offset = 0; offset < chunk.length; offset += 5552) {
      for (let index = offset; index < Math.min(offset + 5552, chunk.length); index++) {
        adlerA += chunk[index]!;
        adlerB += adlerA;
      }
      adlerA %= 65521;
      adlerB %= 65521;
    }
  });
  for (let offset = 0; offset < payload.length; offset += 4096) {
    decoder.push(payload.subarray(offset, offset + 4096), offset + 4096 >= payload.length);
  }
  if (written !== expected) throw new Error("KTX2 zlib level does not match its declared block size");
  const checksum = new DataView(payload.buffer, payload.byteOffset + payload.length - 4, 4).getUint32(0);
  if (((adlerB << 16) | adlerA) >>> 0 !== checksum) throw new Error("KTX2 zlib checksum does not match");
  return output;
}

/** Validated native blocks only: no RGBA decode, resampling, or Basis transcoding. */
export function uploadCubismKtx2(
  gl: WebGL2RenderingContext,
  buffer: ArrayBuffer,
  anisotropy = 1,
  expectedFormat?: CubismTextureVariant["format"],
  metadata?: CubismTextureVariant,
  signal?: AbortSignal,
): CubismUploadedTexture {
  throwIfAborted(signal);
  if (gl.isContextLost()) throw new Error("Cubism texture context was lost");
  const bytes = new Uint8Array(buffer);
  const magic = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 13, 10, 26, 10];
  if (bytes.length < 104 || magic.some((byte, i) => bytes[i] !== byte)) throw new Error("Invalid KTX2 header");
  const view = new DataView(buffer);
  const u32 = (offset: number): number => view.getUint32(offset, true);
  const u64 = (offset: number): number => {
    const value = Number(view.getBigUint64(offset, true));
    if (!Number.isSafeInteger(value)) throw new Error("KTX2 range exceeds safe integer size");
    return value;
  };
  const range = (offset: number, length: number): Uint8Array => {
    if (offset < 0 || length < 0 || offset + length > bytes.length) throw new Error("KTX2 range is truncated");
    return bytes.subarray(offset, offset + length);
  };
  const format = formats[u32(12)];
  if (!format || (expectedFormat && format.name !== expectedFormat) || !supports(gl, format)) {
    throw new Error("KTX2 native format is unsupported by this context");
  }
  const width = u32(20),
    height = u32(24),
    levels = u32(40),
    compression = u32(44);
  const maximum = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE));
  if (
    !width ||
    !height ||
    width > maximum ||
    height > maximum ||
    u32(16) !== 1 ||
    u32(28) !== 0 ||
    u32(32) !== 0 ||
    u32(36) !== 1 ||
    !levels ||
    levels > 1 + Math.floor(Math.log2(Math.max(width, height))) ||
    ![0, 3].includes(compression) ||
    !Number.isFinite(maximum) ||
    maximum <= 0
  ) {
    throw new Error("Unsupported KTX2 dimensions, levels, or supercompression");
  }
  const indexEnd = 80 + levels * 24;
  range(80, levels * 24);
  if (u32(48) < indexEnd || (u32(60) > 0 && u32(56) < indexEnd) || u64(64) !== 0 || u64(72) !== 0) {
    throw new Error("Invalid KTX2 metadata layout");
  }
  const dfd = range(u32(48), u32(52));
  // Gamma-space ADV shaders consume straight UNORM samples and premultiply
  // once at fragment exit. Reject incompatible transfer/alpha encodings.
  const dfdView = new DataView(dfd.buffer, dfd.byteOffset, dfd.byteLength);
  if (
    dfd.length < 44 ||
    dfdView.getUint32(0, true) !== dfd.length ||
    dfdView.getUint32(4, true) !== 0 ||
    dfdView.getUint16(8, true) !== 2 ||
    dfdView.getUint16(10, true) !== dfd.length - 4 ||
    (dfd.length - 28) % 16 !== 0 ||
    dfd[12] !== format.colorModel ||
    dfd[14] !== 1 ||
    dfd[15] !== 0 ||
    dfd[16] !== format.width - 1 ||
    dfd[17] !== format.height - 1 ||
    dfd[18] !== 0 ||
    dfd[19] !== 0 ||
    dfd[20] !== format.bytes ||
    dfd.subarray(21, 28).some((value) => value !== 0)
  ) {
    throw new Error("Cubism KTX2 requires linear-transfer UNORM blocks and straight alpha");
  }
  let orientation = "rd";
  const kvd = range(u32(56), u32(60));
  for (let offset = 0; offset < kvd.length; ) {
    if (offset + 4 > kvd.length) throw new Error("Invalid KTX2 metadata");
    const length = new DataView(kvd.buffer, kvd.byteOffset + offset, 4).getUint32(0, true);
    offset += 4;
    if (!length || offset + length > kvd.length) throw new Error("Invalid KTX2 metadata length");
    const item = kvd.subarray(offset, offset + length);
    const separator = item.indexOf(0);
    if (separator < 0) throw new Error("Invalid KTX2 metadata key");
    const decoder = new TextDecoder();
    const key = decoder.decode(item.subarray(0, separator));
    const value = decoder.decode(item.subarray(separator + 1)).replace(/\0+$/u, "");
    if (key === "KTXorientation") orientation = value;
    if (key === "KTXswizzle" && value !== "rgba") throw new Error("Unsupported KTX2 channel swizzle");
    offset += (length + 3) & ~3;
  }
  if (orientation !== "ru" && orientation !== "rd") throw new Error("Unsupported KTX2 orientation");
  if (
    (metadata?.width !== undefined && metadata.width !== width) ||
    (metadata?.height !== undefined && metadata.height !== height) ||
    (metadata?.mipCount !== undefined && metadata.mipCount !== levels) ||
    (metadata?.orientation !== undefined && metadata.orientation !== orientation) ||
    (metadata?.transferFunction !== undefined && metadata.transferFunction !== "linear") ||
    (metadata?.alphaMode !== undefined && !["straight", "opaque"].includes(metadata.alphaMode)) ||
    (u32(12) === 147 && metadata?.alphaMode !== "opaque")
  )
    throw new Error("KTX2 header does not match texture sampling metadata");

  const payloadStart = Math.max(indexEnd, u32(48) + u32(52), u32(56) + u32(60));
  const mipRanges: Array<{ offset: number; length: number }> = [];
  for (let level = 0; level < levels; level++) {
    const index = 80 + level * 24;
    const offset = u64(index),
      length = u64(index + 8);
    if (offset < payloadStart || length === 0 || (compression === 0 && offset % format.bytes !== 0))
      throw new Error("Invalid KTX2 mip layout");
    range(offset, length);
    if (mipRanges.some((previous) => offset < previous.offset + previous.length && previous.offset < offset + length))
      throw new Error("KTX2 mip payloads overlap");
    mipRanges.push({ offset, length });
  }

  let contextInvalidated = false;
  const lost = (): void => {
    contextInvalidated = true;
  };
  gl.canvas?.addEventListener("webglcontextlost", lost);
  const restoreUploadState = saveTextureUploadState(gl);
  let texture: WebGLTexture | null = null;
  try {
    texture = gl.createTexture();
    if (!texture) throw new Error("Unable to allocate a Cubism texture");
    gl.bindTexture(gl.TEXTURE_2D, texture);
    configureTexture(gl, anisotropy, levels);
    for (let level = 0; level < levels; level++) {
      throwIfAborted(signal);
      if (contextInvalidated || gl.isContextLost()) throw new Error("Cubism texture context was lost");
      const w = Math.max(1, Math.floor(width / 2 ** level));
      const h = Math.max(1, Math.floor(height / 2 ** level));
      const expected = Math.ceil(w / format.width) * Math.ceil(h / format.height) * format.bytes;
      const index = 80 + level * 24;
      if (u64(index + 16) !== expected) throw new Error("Invalid KTX2 decoded block size");
      const payload = range(u64(index), u64(index + 8));
      const data = compression === 3 ? inflateBlocks(payload, expected) : payload;
      if (data.byteLength !== expected) throw new Error("Invalid KTX2 block payload size");
      gl.compressedTexImage2D(gl.TEXTURE_2D, level, format.internalFormat, w, h, 0, data);
      if (gl.getError() !== gl.NO_ERROR) throw new Error("Cubism compressed texture upload failed");
    }
    throwIfAborted(signal);
    if (contextInvalidated || gl.isContextLost()) throw new Error("Cubism texture context was lost");
    return { texture, flipY: orientation === "ru" };
  } catch (error) {
    if (texture && !contextInvalidated && !gl.isContextLost()) gl.deleteTexture(texture);
    throw error;
  } finally {
    gl.canvas?.removeEventListener("webglcontextlost", lost);
    if (!contextInvalidated) restoreUploadState();
  }
}

export async function createCubismTexture(
  gl: WebGL2RenderingContext,
  url: string,
  anisotropy: number,
  resources: CubismModelResourceLoader,
  signal?: AbortSignal,
  variants: readonly CubismTextureVariant[] = [],
  modelUrl = url,
  options: CubismTextureSelectionOptions = {},
): Promise<CubismUploadedTexture> {
  const operation = createOwnedAbortSignal(signal);
  let contextInvalidated = false;
  const lost = (): void => {
    contextInvalidated = true;
    operation.abort();
  };
  gl.canvas?.addEventListener("webglcontextlost", lost);
  const available = (): void => {
    if (contextInvalidated || gl.isContextLost()) throw new Error("Cubism texture context was lost");
    throwIfAborted(signal);
    throwIfAborted(operation.signal);
  };
  try {
    available();
    const priority = { astc6x6: 0, bc7: 1, etc2: 2, basis: 3 };
    const budget = Number(options.optionalTimeoutMilliseconds ?? 5000);
    const deadline = performance.now() + (Number.isFinite(budget) ? Math.max(0, budget) : 5000);
    const ordered = [...variants].sort(
      (left, right) => Number(isLossy(left)) - Number(isLossy(right)) || priority[left.format] - priority[right.format],
    );
    for (const variant of ordered) {
      available();
      if (!supportsCubismTextureVariant(gl, variant, options)) continue;
      if (variant.texture && resolveCubismResourceUrl(modelUrl, variant.texture) !== url) continue;
      const remaining = deadline - performance.now();
      if (remaining <= 0) break;
      const request = createOwnedAbortSignal(operation.signal);
      const timer = setTimeout(request.abort, remaining);
      try {
        const buffer = await optionalTextureBuffer(
          resources,
          resolveCubismResourceUrl(modelUrl, variant.source),
          request.signal,
          deadline,
        );
        available();
        await verifyTextureVariantBytes(buffer, variant, request.signal);
        available();
        if (performance.now() >= deadline) break;
        return uploadCubismKtx2(gl, buffer, anisotropy, variant.format, variant, operation.signal);
      } catch {
        // Optional failure can use PNG; owner cancellation or an invalid GPU
        // generation always exits instead of allocating a fallback texture.
        available();
        if (request.signal.aborted) break;
      } finally {
        clearTimeout(timer);
        request.abort();
      }
    }
    available();
    if (/\.ktx2(?:[?#]|$)/iu.test(url)) {
      const buffer = await waitForTextureResource(resources.loadArrayBuffer(url, operation.signal), operation.signal);
      available();
      return uploadCubismKtx2(gl, buffer, anisotropy, undefined, undefined, operation.signal);
    }
    const image = await waitForTextureResource(resources.loadImage(url, operation.signal), operation.signal);
    available();
    const dimensions = image as {
      readonly naturalWidth?: number;
      readonly naturalHeight?: number;
      readonly width?: number;
      readonly height?: number;
    };
    const maximum = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE));
    if (
      (dimensions.naturalWidth ?? dimensions.width ?? 0) > maximum ||
      (dimensions.naturalHeight ?? dimensions.height ?? 0) > maximum
    )
      throw new Error("Cubism PNG exceeds this context's maximum texture size");
    const restoreUploadState = saveTextureUploadState(gl, [
      gl.UNPACK_FLIP_Y_WEBGL,
      gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,
      gl.UNPACK_ROW_LENGTH,
      gl.UNPACK_SKIP_PIXELS,
      gl.UNPACK_SKIP_ROWS,
    ]);
    let texture: WebGLTexture | null = null;
    try {
      texture = gl.createTexture();
      if (!texture) throw new Error("Unable to allocate a Cubism texture");
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
      gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
      gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
      configureTexture(gl, anisotropy);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, image);
      available();
      if (gl.getError() !== gl.NO_ERROR) throw new Error("Cubism PNG texture upload failed");
      return { texture, flipY: false };
    } catch (error) {
      if (texture && !contextInvalidated && !gl.isContextLost()) gl.deleteTexture(texture);
      throw error;
    } finally {
      if (!contextInvalidated) restoreUploadState();
    }
  } finally {
    gl.canvas?.removeEventListener("webglcontextlost", lost);
    operation.abort();
  }
}
