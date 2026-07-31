/* Copyright 2026 Haneoka Gakuen contributors. MPL-2.0 licensed. */
export interface Cubism2ParameterContext {
  /** Present on unobfuscated or adapter-provided Cubism 2 builds. */
  getParamCount?: () => number;
  getParamId?: (index: number) => unknown;
  getParamID?: (index: number) => unknown;
  getParamMin?: (index: number) => number;
  getParamMax?: (index: number) => number;
  /** Minified parameter count field used by a common Cubism 2.1 Web build. */
  readonly _$qo?: number;
  /** Minified authored ParamID table used by that Cubism 2.1 Web build. */
  readonly _$pb?: readonly unknown[];
}

export interface Cubism2AuthoredParameter {
  readonly id: string;
  readonly index: number;
  readonly minimum: number;
  readonly maximum: number;
}

const SYNTHETIC_PARAMETER_MINIMUM = -1_000_000;
const SYNTHETIC_PARAMETER_MAXIMUM = 1_000_000;

function finite(value: unknown, fallback: number): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function parameterIdString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value == null) return "";
  try {
    const id = String(value).trim();
    return id && id !== "[object Object]" ? id : "";
  } catch {
    return "";
  }
}

/**
 * Enumerates an already-loaded Cubism 2 parameter table without calling
 * getParamIndex. The latter creates unknown parameters in the 2.1 runtime.
 */
export function enumerateCubism2AuthoredParameters(
  context: Cubism2ParameterContext | null | undefined,
): Cubism2AuthoredParameter[] | null {
  if (!context || typeof context.getParamMin !== "function" || typeof context.getParamMax !== "function") {
    return null;
  }

  let publicCount = Number.NaN;
  try {
    if (typeof context.getParamCount === "function") {
      publicCount = finite(context.getParamCount(), Number.NaN);
    }
  } catch {
    // The guarded vendored count remains usable.
  }
  const vendoredCount = finite(context._$qo, Number.NaN);
  const countCandidates = [publicCount, vendoredCount].filter((value) => Number.isFinite(value) && value > 0);
  const count = countCandidates.length ? Math.trunc(Math.min(...countCandidates)) : 0;
  if (!count) return null;

  const publicParameterId =
    typeof context.getParamId === "function"
      ? context.getParamId.bind(context)
      : typeof context.getParamID === "function"
        ? context.getParamID.bind(context)
        : null;
  const vendoredParameterIds = Array.isArray(context._$pb) ? context._$pb : null;
  if (!publicParameterId && !vendoredParameterIds) return null;

  const result: Cubism2AuthoredParameter[] = [];
  const seenIds = new Set<string>();
  for (let index = 0; index < count; index += 1) {
    let id = "";
    try {
      if (publicParameterId) id = parameterIdString(publicParameterId(index));
    } catch {
      // Fall through to the guarded vendored table.
    }
    if (!id) id = parameterIdString(vendoredParameterIds?.[index]);
    if (!id || seenIds.has(id)) return null;

    let minimum = Number.NaN;
    let maximum = Number.NaN;
    try {
      minimum = finite(context.getParamMin(index), Number.NaN);
      maximum = finite(context.getParamMax(index), Number.NaN);
    } catch {
      return null;
    }
    if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) return null;
    if (minimum === SYNTHETIC_PARAMETER_MINIMUM && maximum === SYNTHETIC_PARAMETER_MAXIMUM) continue;

    seenIds.add(id);
    result.push({ id, index, minimum, maximum });
  }
  return result.length ? result : null;
}
