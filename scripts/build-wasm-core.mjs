/* Copyright 2026 Haneoka Gakuen contributors. MPL-2.0 licensed. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    archive: { type: "string" },
    sysroot: { type: "string" },
    output: { type: "string" },
  },
});
if (!values.archive || !values.sysroot || !values.output)
  throw new Error(
    "Usage: node scripts/build-wasm-core.mjs --archive <official WebGL Core> --sysroot <WASI libc> --output <wasm>",
  );
const archive = resolve(values.archive),
  sysroot = resolve(values.sysroot),
  output = resolve(values.output);
const expectedArchive = "48321caaae6f50fd72bb8d9d124a82baa75b3d5cdd3bca7e053cd324668b4e62";
if (createHash("sha256").update(readFileSync(archive)).digest("hex") !== expectedArchive)
  throw new Error("Expected the unchanged Core 5.1.0 WebGL archive from CubismSdkForUnity-5-r.4");
const temporary = mkdtempSync(join(tmpdir(), "vega-cubism-core-"));
try {
  const bridge = fileURLToPath(new URL("../native/web-core-bridge.c", import.meta.url));
  const object = join(temporary, "bridge.o");
  execFileSync("clang", ["--target=wasm32-wasip1", `--sysroot=${sysroot}`, "-O3", "-c", bridge, "-o", object], {
    stdio: "inherit",
  });
  const symbols = execFileSync("llvm-nm", ["--defined-only", archive], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim().split(/\s+/u))
    .filter((line) => line.length === 3 && /^csm[A-Z]/u.test(line[2]))
    .map((line) => line[2]);
  mkdirSync(dirname(output), { recursive: true });
  execFileSync(
    "wasm-ld",
    [
      "--no-entry",
      "--export-memory",
      "--export-table",
      "--initial-memory=67108864",
      "--max-memory=1073741824",
      "-z",
      "stack-size=1048576",
      "-O3",
      "--strip-all",
      "--export=malloc",
      "--export=free",
      "--export=aligned_alloc",
      "--export=haneokaSetLogEnabled",
      "--export=__wasm_call_ctors",
      ...symbols.map((name) => `--export=${name}`),
      object,
      archive,
      `-L${join(sysroot, "lib/wasm32-wasi")}`,
      "-lc",
      "-lm",
      "--allow-undefined",
      "-o",
      output,
    ],
    { stdio: "inherit" },
  );
  const bytes = readFileSync(output),
    module = new WebAssembly.Module(bytes);
  const imports = WebAssembly.Module.imports(module);
  if (
    imports.some(
      (entry) =>
        !["env", "wasi_snapshot_preview1"].includes(entry.module) ||
        (entry.module === "env" && entry.name !== "coreLog"),
    )
  )
    throw new Error("Unexpected native Core imports");
  console.log(
    JSON.stringify({ output, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }),
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
