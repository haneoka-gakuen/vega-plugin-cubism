const normalizePath = (path) =>
  String(path)
    .replaceAll("\\", "/")
    .replace(/^\.\/+/u, "");

const permittedWebRuntimeSource = (path) => {
  const normalized = normalizePath(path);
  return normalized === "CUBISM-LICENSE.md" || /^(?:src|dist)\/web-runtime\/.+\.(?:d\.ts|js|mjs|ts)$/u.test(normalized);
};

const documentationBrandFiles = new Set([
  "docs/brand/favicon.svg",
  "docs/brand/icon-512.png",
  "docs/brand/social.svg",
  "docs/brand/social.png",
]);

const nativeAdapterSource =
  /^(?:dart\/(?:lib|tool)\/.+\.dart|dart\/(?:android\/build\.gradle|(?:ios|macos)\/[^/]+\.podspec|(?:linux|windows)\/CMakeLists\.txt)|native\/motion-sync\/(?:src|jsc)\/.+\.(?:c|cpp|h|in|js))$/u;

const restrictedDirectory =
  /^(?:atlases?|character-models?|core|cubism(?:-?sdk)?|expressions?|framework|game-assets?|live2d|models?|motions?|physics|poses?|samples?|sdk|skeletons?|spine(?:-runtimes?)?|textures?|userdata|vendor)$/iu;

const cubismAssetName =
  /(?:^|[._-])(?:cdi3|exp(?:3)?|model(?:3)?|motion(?:3)?|motionsync3|physics(?:3)?|pose(?:3)?|userdata3)\.json$/iu;

const restrictedExtension = /\.(?:bin|dat|dll|dylib|exp|gz|moc3?|mtn|node|so|tar|tgz|wasm|zip)$/iu;

const spineAssetName = /\.(?:atlas(?:\.(?:json|txt))?|skel|skeleton\.json|spine(?:\.json)?|spineproj)$/iu;

const mediaExtension = /\.(?:avif|bmp|gif|jpe?g|m4a|mp3|mp4|ogg|png|svg|wav|webm|webp)$/iu;

const sdkFileName =
  /^(?:live2d(?:\.min)?|live2dcubism(?:core|framework|motionsynccore)(?:\.min)?)\.(?:js|mjs|cjs|wasm)$/iu;

const live2dCopyright =
  /copyright\s*(?:(?:\(\s*c\s*\)|©)\s*)?(?:(?:19|20)\d{2}(?:\s*[-–—,]\s*(?:19|20)\d{2})?\s*)?live2d\s*,?\s*inc\.?/iu;

const live2dLicense = /live2d\s+(?:open\s+software|proprietary\s+software)\s+license\s+agreement/iu;

const cubismSdkProduct = /(?:live2d\s+)?cubism\s+(?:motion\s*sync\s+)?sdk\s+for\s+(?:native|unity|web)/iu;

const bundledRuntimeMarker =
  /\blive2dcubism(?:core|framework|motionsynccore)\b|\blive2d\s*\.\s*(?:geterror|init)\s*\(|\bcsm(?:getversion|initializemodelinplace|revivemocinplace)\b/iu;

export const restrictedCubismPathReason = (path) => {
  const normalized = normalizePath(path);
  if (
    permittedWebRuntimeSource(normalized) ||
    documentationBrandFiles.has(normalized) ||
    normalized === "native/motion-sync/vendor/miniaudio.h"
  )
    return null;
  const segments = normalized.split("/").filter(Boolean);
  const basename = segments.at(-1) ?? "";

  if (segments.slice(0, -1).some((segment) => restrictedDirectory.test(segment))) {
    return "restricted SDK, runtime, model, or asset directory";
  }
  if (
    cubismAssetName.test(basename) ||
    spineAssetName.test(basename) ||
    restrictedExtension.test(basename) ||
    sdkFileName.test(basename)
  ) {
    return "Cubism model, SDK, Core, or runtime filename";
  }
  if (mediaExtension.test(basename)) {
    return "media or texture payload";
  }
  return null;
};

export const restrictedCubismContentReason = (bytes, path = "") => {
  const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (documentationBrandFiles.has(normalizePath(path)) && path.endsWith(".png")) {
    return body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      ? null
      : "invalid documentation PNG signature";
  }
  if (body.some((byte) => byte === 0 || byte === 0x7f || byte < 0x09 || (byte > 0x0d && byte < 0x20))) {
    return "binary payload";
  }

  let text;
  try {
    text = utf8.decode(body).normalize("NFKC");
  } catch {
    return "binary payload";
  }
  if (permittedWebRuntimeSource(path) || ["README.md", "NOTICE.md", "SECURITY.md"].includes(normalizePath(path)))
    return null;
  if (live2dCopyright.test(text)) return "Live2D copyright signature";
  if (live2dLicense.test(text)) return "Live2D license signature";
  if (cubismSdkProduct.test(text)) return "Live2D Cubism SDK product signature";
  if (bundledRuntimeMarker.test(text) && !nativeAdapterSource.test(normalizePath(path))) {
    return "Live2D Cubism SDK/Core runtime signature";
  }
  return null;
};
import { TextDecoder } from "node:util";

const utf8 = new TextDecoder("utf-8", { fatal: true });
