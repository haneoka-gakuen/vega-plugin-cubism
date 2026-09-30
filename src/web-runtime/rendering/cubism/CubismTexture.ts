import { Unzlib } from "fflate";
import type { CubismTextureVariant } from "../../../runtime/CubismTextureVariant";
import { createOwnedAbortSignal, resolveCubismResourceUrl, type CubismModelResourceLoader } from "./CubismResourceCache";

export interface CubismUploadedTexture {
  readonly texture: WebGLTexture;
  /** Flip the shader's normal top-left image coordinates for bottom-left blocks. */
  readonly flipY: boolean;
}

interface BlockFormat {
  readonly extension: string;
  readonly internalFormat: number;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly name: CubismTextureVariant["format"];
}

const formats: Readonly<Record<number, BlockFormat>> = {
  165: {
    extension: "WEBGL_compressed_texture_astc",
    internalFormat: 0x93b4,
    width: 6,
    height: 6,
    bytes: 16,
    name: "astc6x6",
  },
  145: {
    extension: "EXT_texture_compression_bptc",
    internalFormat: 0x8e8c,
    width: 4,
    height: 4,
    bytes: 16,
    name: "bc7",
  },
  147: {
    extension: "WEBGL_compressed_texture_etc",
    internalFormat: 0x9274,
    width: 4,
    height: 4,
    bytes: 8,
    name: "etc2",
  },
  151: {
    extension: "WEBGL_compressed_texture_etc",
    internalFormat: 0x9278,
    width: 4,
    height: 4,
    bytes: 16,
    name: "etc2",
  },
};

const supports = (gl: WebGL2RenderingContext, format: BlockFormat): boolean =>
  Boolean(gl.getExtension(format.extension));

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
): CubismUploadedTexture {
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
    ![0, 3].includes(compression)
  ) {
    throw new Error("Unsupported KTX2 dimensions, levels, or supercompression");
  }
  range(80, levels * 24);
  const dfd = range(u32(48), u32(52));
  // Gamma-space ADV shaders consume straight UNORM samples and premultiply
  // once at fragment exit. Reject incompatible transfer/alpha encodings.
  if (dfd.length < 28 || dfd[14] !== 1 || (dfd[15]! & 1) !== 0) {
    throw new Error("Cubism KTX2 requires linear-transfer UNORM blocks and straight alpha");
  }
  let orientation = "rd";
  const kvd = range(u32(56), u32(60));
  for (let offset = 0; offset < kvd.length;) {
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

  const texture = gl.createTexture();
  if (!texture) throw new Error("Unable to allocate a Cubism texture");
  try {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    configureTexture(gl, anisotropy, levels);
    for (let level = 0; level < levels; level++) {
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
    if (gl.isContextLost()) throw new Error("Cubism texture context was lost");
    return { texture, flipY: orientation === "ru" };
  } catch (error) {
    gl.deleteTexture(texture);
    throw error;
  } finally {
    gl.bindTexture(gl.TEXTURE_2D, null);
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
): Promise<CubismUploadedTexture> {
  throwIfAborted(signal);
  const priority = { astc6x6: 0, bc7: 1, etc2: 2 };
  // Alternatives are optional optimizations. Required PNGs are already ready
  // for stories; an unavailable alternative must not hold up their upload.
  const deadline = performance.now() + 5000;
  for (const variant of [...variants].sort((left, right) => priority[left.format] - priority[right.format])) {
    const format = Object.values(formats).find((value) => value.name === variant.format);
    if (!format || !supports(gl, format)) continue;
    if (variant.texture && resolveCubismResourceUrl(modelUrl, variant.texture) !== url) continue;
    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    const request = createOwnedAbortSignal(signal);
    const timer = setTimeout(request.abort, remaining);
    try {
      const buffer = await resources.loadArrayBuffer(resolveCubismResourceUrl(modelUrl, variant.source), request.signal);
      throwIfAborted(signal);
      return uploadCubismKtx2(gl, buffer, anisotropy, variant.format);
    } catch (error) {
      throwIfAborted(signal);
      if (gl.isContextLost()) throw error;
      // A declared optional variant can fail independently of the PNG source.
    } finally {
      clearTimeout(timer);
      request.detach();
    }
  }
  if (/\.ktx2(?:[?#]|$)/iu.test(url)) {
    const buffer = await resources.loadArrayBuffer(url, signal);
    throwIfAborted(signal);
    return uploadCubismKtx2(gl, buffer, anisotropy);
  }
  const image = await resources.loadImage(url, signal);
  throwIfAborted(signal);
  const texture = gl.createTexture();
  if (!texture) throw new Error("Unable to allocate a Cubism texture");
  try {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
    configureTexture(gl, anisotropy);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, image);
    return { texture, flipY: false };
  } catch (error) {
    gl.deleteTexture(texture);
    throw error;
  } finally {
    gl.bindTexture(gl.TEXTURE_2D, null);
  }
}
