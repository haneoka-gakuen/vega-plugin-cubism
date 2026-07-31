/**
 * Copyright 2026 Haneoka Gakuen contributors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/.
 */

export interface CubismMotionSyncParameter {
  readonly id: string;
  readonly min?: number;
  readonly max?: number;
  readonly smooth?: number;
}

export interface CubismMotionSyncAudioParameter {
  readonly id: string;
  readonly name?: string;
  readonly min?: number;
  readonly max?: number;
  readonly scale?: number;
  readonly enabled?: boolean;
}

export interface CubismMotionSyncMapping {
  readonly type?: number;
  readonly audioParameterId: string;
  readonly targets: readonly {
    readonly id: string;
    readonly value: number;
  }[];
}

export interface CubismMotionSyncSetting {
  readonly id?: string;
  readonly analysisType?: number;
  readonly useCase?: number;
  readonly parameters: readonly CubismMotionSyncParameter[];
  readonly audioParameters: readonly CubismMotionSyncAudioParameter[];
  readonly mappings: readonly CubismMotionSyncMapping[];
  readonly postProcessing?: {
    readonly blendRatio?: number;
    readonly smoothing?: number;
    readonly sampleRate?: number;
  };
  readonly emphasisLevel?: number;
}

export interface CubismMotionSyncRuntime {
  readonly settings: readonly CubismMotionSyncSetting[];
  readonly source?: Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
}

export interface CubismParameterBlend {
  readonly id: string;
  readonly value: number;
  /** 0=override, 1=additive, 2=multiply. */
  readonly mode: 0 | 1 | 2;
}
