/* Copyright 2026 Haneoka Gakuen contributors. MPL-2.0 licensed. */
import type { CubismMotionSyncSetting } from "./types";

export interface AdvVowelMotionSyncParameter {
  readonly id: string;
  readonly minimum: number;
  readonly maximum: number;
}

export type AdvVowel = "A" | "I" | "U" | "E" | "O";
export type AdvVowelMotionSyncAudioScales = Partial<Readonly<Record<AdvVowel, number>>>;

export interface AdvVowelMotionSyncTargets {
  readonly mouthOpenY: AdvVowelMotionSyncParameter;
  readonly mouthForm?: AdvVowelMotionSyncParameter | null;
  readonly vowels?: Partial<Record<AdvVowel, AdvVowelMotionSyncParameter>>;
  /** Per-model CRI sensitivity overrides copied from authored MotionSyncData. */
  readonly audioParameterScales?: AdvVowelMotionSyncAudioScales;
}

const VOWEL_SHAPES = Object.freeze({
  A: { mouthOpenY: 1, mouthForm: 1 },
  I: { mouthOpenY: 0.4, mouthForm: 1 },
  U: { mouthOpenY: 0.4, mouthForm: -1 },
  E: { mouthOpenY: 0.7, mouthForm: 1 },
  O: { mouthOpenY: 1, mouthForm: -1 },
} as const);

const AUDIO_PARAMETER_SCALES = Object.freeze({
  A: 0.3,
  I: 0.1,
  U: 1.5,
  E: 6,
  O: 8,
} as const);

const VOWELS = Object.freeze(["A", "I", "U", "E", "O"] as const satisfies readonly AdvVowel[]);

function audioParameterScale(targets: AdvVowelMotionSyncTargets, vowel: AdvVowel): number {
  const authored = Number(targets.audioParameterScales?.[vowel]);
  return Number.isFinite(authored) ? authored : AUDIO_PARAMETER_SCALES[vowel];
}

function parameterRows(targets: AdvVowelMotionSyncTargets): AdvVowelMotionSyncParameter[] {
  const result = [targets.mouthOpenY];
  if (targets.mouthForm) result.push(targets.mouthForm);
  for (const vowel of VOWELS) {
    const parameter = targets.vowels?.[vowel];
    if (parameter) result.push(parameter);
  }
  const seen = new Set<string>();
  return result.filter((parameter) => {
    const id = String(parameter.id || "");
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function mappedTargets(
  targets: AdvVowelMotionSyncTargets,
  vowel: (typeof VOWELS)[number] | "Silence",
): Array<{ id: string; value: number }> {
  const result = [
    {
      id: targets.mouthOpenY.id,
      value: vowel === "Silence" ? 0 : VOWEL_SHAPES[vowel].mouthOpenY,
    },
  ];
  if (targets.mouthForm) {
    result.push({
      id: targets.mouthForm.id,
      value: vowel === "Silence" ? 0 : VOWEL_SHAPES[vowel].mouthForm,
    });
  }
  for (const candidate of VOWELS) {
    const parameter = targets.vowels?.[candidate];
    if (parameter) result.push({ id: parameter.id, value: vowel === candidate ? 1 : 0 });
  }
  return result;
}

/**
 * Creates the source-neutral CRI MotionSync vowel mapping. Authored profiles
 * still take precedence; this fallback gives legacy and low-detail models one
 * A/I/U/E/O contract across Cubism generations.
 */
export function createAdvVowelMotionSyncSetting(targets: AdvVowelMotionSyncTargets): CubismMotionSyncSetting {
  const parameters = parameterRows(targets);
  if (!parameters.length || !targets.mouthOpenY.id) {
    throw new Error("A vowel MotionSync profile requires a real mouth-open parameter");
  }
  return {
    id: "CubismAIUEOVowelMotionSync",
    analysisType: 0,
    useCase: 0,
    parameters: parameters.map((parameter) => ({
      id: parameter.id,
      min: parameter.minimum,
      max: parameter.maximum,
      damper: 0,
      smooth: 25,
    })),
    audioParameters: [
      { id: "Silence", name: "Silence", min: 0, max: 1, scale: 1, enabled: true },
      ...VOWELS.map((vowel) => ({
        id: vowel,
        name: vowel,
        min: 0,
        max: 1,
        scale: audioParameterScale(targets, vowel),
        enabled: true,
      })),
    ],
    mappings: [
      { type: 0, audioParameterId: "Silence", targets: mappedTargets(targets, "Silence") },
      ...VOWELS.map((vowel) => ({
        type: 0,
        audioParameterId: vowel,
        targets: mappedTargets(targets, vowel),
      })),
    ],
    postProcessing: {
      blendRatio: 1,
      smoothing: 100,
      sampleRate: 30,
    },
    emphasisLevel: 0,
  };
}
