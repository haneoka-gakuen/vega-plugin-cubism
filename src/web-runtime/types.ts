export interface AdvVoiceMotionSyncPcmSnapshot {
  readonly sourceKey: number | string;
  readonly channelData: Float32Array;
  readonly sampleRate: number;
  readonly samplePosition: number;
}

export interface AdvMotionSyncParameter {
  readonly id: string;
  readonly min?: number;
  readonly max?: number;
  readonly damper?: number;
  readonly smooth?: number;
}

export interface AdvMotionSyncAudioParameter {
  readonly id: string;
  readonly name?: string;
  readonly min?: number;
  readonly max?: number;
  readonly scale?: number;
  readonly enabled?: boolean;
}

export interface AdvMotionSyncMapping {
  readonly type?: number;
  readonly audioParameterId: string;
  readonly targets: ReadonlyArray<{ readonly id: string; readonly value: number }>;
}

export interface AdvMotionSyncSetting {
  readonly id?: string;
  readonly analysisType?: number;
  readonly useCase?: number;
  readonly parameters: readonly AdvMotionSyncParameter[];
  readonly audioParameters: readonly AdvMotionSyncAudioParameter[];
  readonly mappings: readonly AdvMotionSyncMapping[];
  readonly postProcessing?: {
    readonly blendRatio?: number;
    readonly smoothing?: number;
    readonly sampleRate?: number;
  };
  readonly emphasisLevel?: number;
}

export interface AdvMotionSyncRuntime {
  readonly settings: readonly AdvMotionSyncSetting[];
  readonly source?: {
    readonly asset?: string;
    readonly unity?: string;
    readonly [key: string]: unknown;
  };
  readonly [key: string]: unknown;
}
