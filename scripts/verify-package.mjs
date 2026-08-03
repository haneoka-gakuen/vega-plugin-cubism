import {
  access,
  lstat,
  readFile,
  readdir,
  realpath,
  stat,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  restrictedCubismContentReason,
  restrictedCubismPathReason,
} from "./distribution-policy.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const manifestPath = resolve(root, "package.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

const policies = {
  "@haneoka/vega-plugin-cubism": {
    repository:
      "git+https://github.com/haneoka-gakuen/vega-plugin-cubism.git",
    peerDependencies: ["@haneoka/vega"],
    allowedImports: [
      "@haneoka/vega",
      "@haneoka/vega/plugin",
    ],
    runtimeDependencies: [],
    forbiddenDependency: /(?:live2d|cubism|motionsync)/iu,
    externalRuntime: true,
    forbidMedia: true,
  },
  "@haneoka/vega-plugin-spine": {
    repository:
      "git+https://github.com/haneoka-gakuen/vega-plugin-spine.git",
    peerDependencies: ["@haneoka/vega"],
    allowedImports: ["@haneoka/vega", "@haneoka/vega/plugin"],
    forbiddenDependency: /(?:@esotericsoftware|spine)/iu,
    externalRuntime: true,
    forbidMedia: true,
  },
  "@haneoka/vega-renderer-pixi": {
    repository:
      "git+https://github.com/haneoka-gakuen/vega-renderer-pixi.git",
    peerDependencies: ["@haneoka/vega", "pixi.js"],
    allowedImports: ["@haneoka/vega", "pixi.js"],
    forbiddenDependency:
      /(?:live2d|cubism|motionsync|@esotericsoftware|spine)/iu,
    externalRuntime: false,
    forbidMedia: false,
  },
};

const policy = policies[manifest.name];
if (!policy) {
  throw new Error(`No distribution policy exists for ${manifest.name}`);
}

const fail = (message) => {
  throw new Error(`Package verification failed: ${message}`);
};

if (manifest.license !== "MPL-2.0") fail("package must use MPL-2.0");
if (manifest.private === true) fail("package cannot be private");
if (manifest.sideEffects !== false) fail("sideEffects must be false");
if (manifest.publishConfig?.access !== "public") {
  fail("publishConfig.access must be public");
}
if (manifest.publishConfig?.provenance !== true) {
  fail("publishConfig.provenance must be enabled");
}
if (manifest.repository?.url !== policy.repository) {
  fail(`repository.url must be ${policy.repository}`);
}
if (policy.externalRuntime && manifest.vega?.externalRuntime !== true) {
  fail("adapter-only packages must declare vega.externalRuntime");
}

const dependencySections = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
for (const section of dependencySections) {
  for (const name of Object.keys(manifest[section] ?? {})) {
    if (policy.forbiddenDependency.test(name)) {
      fail(`forbidden SDK/runtime dependency ${name} in ${section}`);
    }
  }
}
const actualRuntimeDependencies = Object.keys(manifest.dependencies ?? {}).sort();
const expectedRuntimeDependencies = [...(policy.runtimeDependencies ?? [])].sort();
if (JSON.stringify(actualRuntimeDependencies) !== JSON.stringify(expectedRuntimeDependencies)) {
  fail(`runtime dependencies must be exactly ${expectedRuntimeDependencies.join(", ") || "(none)"}`);
}
if (Object.keys(manifest.optionalDependencies ?? {}).length > 0) {
  fail("optional runtime dependencies are not allowed");
}
if (
  Array.isArray(manifest.bundledDependencies) &&
  manifest.bundledDependencies.length > 0
) {
  fail("bundled dependencies are not allowed");
}
if (
  Array.isArray(manifest.bundleDependencies) &&
  manifest.bundleDependencies.length > 0
) {
  fail("bundleDependencies are not allowed");
}

const actualPeers = Object.keys(manifest.peerDependencies ?? {}).sort();
const expectedPeers = [...policy.peerDependencies].sort();
if (JSON.stringify(actualPeers) !== JSON.stringify(expectedPeers)) {
  fail(
    `peer dependencies must be exactly ${expectedPeers.join(", ") || "(none)"}`,
  );
}

const collectTargets = (value) => {
  if (typeof value === "string") {
    return value.startsWith("./dist/") ? [value] : [];
  }
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap(collectTargets);
};

const targets = new Set(
  [
    manifest.main,
    manifest.module,
    manifest.types,
    ...collectTargets(manifest.exports),
  ].filter(
    (value) => typeof value === "string" && value.startsWith("./dist/"),
  ),
);
if (targets.size === 0) fail("manifest has no dist export targets");
for (const target of targets) {
  try {
    await access(resolve(root, target));
  } catch {
    fail(`manifest references missing build output ${target}`);
  }
}

const ignoredRoots = new Set([".dependencies", ".git", "coverage", "dist", "node_modules"]);
const repositoryFiles = [];

const insideRoot = (path) => {
  const pathFromRoot = relative(root, path);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) &&
      pathFromRoot !== ".." &&
      !pathFromRoot.startsWith(sep))
  );
};

const walkRepository = async (path, relativePath = "") => {
  if (!insideRoot(path)) fail(`path escapes repository: ${path}`);
  const info = await lstat(path);
  if (info.isSymbolicLink()) fail(`symbolic links are not allowed: ${relativePath}`);
  if (info.isDirectory()) {
    for (const entry of await readdir(path)) {
      if (!relativePath && ignoredRoots.has(entry)) continue;
      await walkRepository(
        resolve(path, entry),
        relativePath ? `${relativePath}/${entry}` : entry,
      );
    }
    return;
  }
  repositoryFiles.push(relativePath);
};

await walkRepository(root);
const restrictedRepositoryFiles = repositoryFiles.filter(
  (path) => restrictedCubismPathReason(path),
);
if (restrictedRepositoryFiles.length > 0) {
  fail(
    `restricted SDK, runtime, model, or asset payload:\n${restrictedRepositoryFiles.join("\n")}`,
  );
}

for (const path of repositoryFiles) {
  const reason = restrictedCubismContentReason(
    await readFile(resolve(root, path)),
    path,
  );
  if (reason) fail(`${reason} found in repository file ${path}`);
}

if (manifest.name === "@haneoka/vega-plugin-cubism") {
  for (const required of [
    "LICENSE",
    "CUBISM-LICENSE.md",
    "NOTICE.md",
  ]) {
    if (!repositoryFiles.includes(required)) {
      fail(`package is missing distribution notice ${required}`);
    }
  }
  const { stdout: reachableObjects } = await promisify(execFile)(
    "git",
    // Tree objects have directory paths such as `.../vendor/cubism` even when
    // every file below that directory is an explicitly permitted TypeScript
    // source file. Inspect blobs only so the policy evaluates distributable
    // content rather than rejecting a parent tree name.
    ["rev-list", "--objects", "--all", "--filter=object:type=blob"],
    { cwd: root, encoding: "utf8" },
  );
  const restrictedHistory = reachableObjects
    .split(/\r?\n/u)
    .filter((row) =>
      restrictedCubismPathReason(row.replace(/^[0-9a-f]+\s+/u, "")),
    );
  if (restrictedHistory.length > 0) {
    fail(
      `reachable Git history still contains restricted SDK/runtime/model paths:\n${restrictedHistory.join("\n")}`,
    );
  }
}

const publishableFiles = [];
let publishableBytes = 0;
const walkPublishable = async (path, relativePath) => {
  if (!insideRoot(path)) fail(`publish path escapes repository: ${relativePath}`);
  const canonical = await realpath(path);
  if (!insideRoot(canonical)) {
    fail(`publish path resolves outside repository: ${relativePath}`);
  }
  const info = await lstat(path);
  if (info.isSymbolicLink()) fail(`publish path is a symbolic link: ${relativePath}`);
  if (info.isDirectory()) {
    for (const entry of await readdir(path)) {
      await walkPublishable(
        resolve(path, entry),
        relativePath ? `${relativePath}/${entry}` : entry,
      );
    }
    return;
  }
  publishableFiles.push(relativePath);
  publishableBytes += (await stat(path)).size;
  const bytes = await readFile(path);
  const reason = restrictedCubismContentReason(bytes, relativePath);
  if (reason) fail(`${reason} found in publishable file ${relativePath}`);
};

for (const entry of manifest.files ?? []) {
  if (
    typeof entry !== "string" ||
    !entry ||
    entry.startsWith("/") ||
    entry.includes("\\") ||
    entry.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    fail(`invalid package files entry ${String(entry)}`);
  }
  const path = resolve(root, entry);
  if (!insideRoot(path)) fail(`package files entry escapes repository: ${entry}`);
  await walkPublishable(path, entry);
}

const restrictedPublishableFiles = publishableFiles.filter(
  (path) => restrictedCubismPathReason(path),
);
if (restrictedPublishableFiles.length > 0) {
  fail(
    `restricted publish payload:\n${restrictedPublishableFiles.join("\n")}`,
  );
}
if (publishableBytes > 5 * 1024 * 1024) {
  fail(`publish payload is unexpectedly large (${publishableBytes} bytes)`);
}

const builtJavaScript = await readFile(resolve(root, "dist/index.js"), "utf8");
const importPattern =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["']([^"']+)["']/gu;
const externalImports = new Set(
  [...builtJavaScript.matchAll(importPattern)]
    .map((match) => match[1])
    .filter((specifier) => specifier && !specifier.startsWith(".")),
);
const unexpectedImports = [...externalImports].filter(
  (specifier) => !policy.allowedImports.includes(specifier),
);
if (unexpectedImports.length > 0) {
  fail(`unexpected runtime imports: ${unexpectedImports.join(", ")}`);
}

if (manifest.name === "@haneoka/vega-plugin-cubism") {
  for (const output of [
    "dist/web-runtime/vega-cubism-web-runtime.mjs",
    "dist/web-runtime/vega-cubism-web-viewer.mjs",
  ]) {
    const source = await readFile(resolve(root, output), "utf8");
    if (
      source.includes("Multiple instances of Three.js") ||
      source.includes("__THREE__")
    ) {
      fail(`${output} embeds a second Three.js runtime`);
    }
  }

  // Different ESM identities have independent CubismFramework module state.
  // They may share the externally loaded Core script, but each must initialize
  // its own ID manager instead of trusting another bundle's ready flag.
  const coreGlobalName = ["Live2D", "Cubism", "Core"].join("");
  const versionGetterName = ["csm", "Get", "Version"].join("");
  const previousCore = globalThis[coreGlobalName];
  const previousRuntimeState = globalThis.__vegaCubismWebRuntime;
  const logging = { callback: null };
  try {
    delete globalThis.__vegaCubismWebRuntime;
    globalThis[coreGlobalName] = {
      Logging: {
        csmSetLogFunction(callback) {
          logging.callback = callback;
        },
        csmGetLogFunction() {
          return logging.callback;
        },
      },
      Version: { [versionGetterName]: () => 0 },
      Memory: { initializeAmountOfMemory() {} },
    };
    const runtimeUrl = new URL(
      "../dist/web-runtime/vega-cubism-web-runtime.mjs",
      import.meta.url,
    ).href;
    const first = await import(`${runtimeUrl}?verify-instance=first`);
    const second = await import(`${runtimeUrl}?verify-instance=second`);
    await first.createCubismWebRuntimeAdapter().prepare(3);
    await second.createCubismWebRuntimeAdapter().prepare(3);
    new second.AdvCubismModel({
      gl: {},
      modelUrl: "memory://verify-model3.json",
    });
  } catch (error) {
    fail(`duplicate runtime framework initialization failed: ${String(error)}`);
  } finally {
    if (previousCore === undefined) delete globalThis[coreGlobalName];
    else globalThis[coreGlobalName] = previousCore;
    if (previousRuntimeState === undefined) {
      delete globalThis.__vegaCubismWebRuntime;
    } else {
      globalThis.__vegaCubismWebRuntime = previousRuntimeState;
    }
  }
}

console.log(
  `Verified ${manifest.name}: ${targets.size} exports, ${publishableFiles.length} files, ${publishableBytes} bytes.`,
);
