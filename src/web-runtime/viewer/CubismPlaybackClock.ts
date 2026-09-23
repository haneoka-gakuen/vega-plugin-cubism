const MINIMUM_PLAYBACK_RATE = 0.001;
const MAXIMUM_MOTION_STEP_SECONDS = 1 / 30;

export function normalizeCubismPlaybackRate(value: unknown): number {
  const rate = Number(value);
  return Number.isFinite(rate) && rate > 0 ? Math.max(MINIMUM_PLAYBACK_RATE, rate) : 1;
}

export interface CubismMotionSpeedTarget {
  setMotionSpeed(rate: number): void;
}

/** Model-independent state so a newly loaded or context-restored model inherits the rate. */
export class CubismViewerPlaybackState {
  private currentRate = 1;

  get rate(): number {
    return this.currentRate;
  }

  set(rate: number, target?: CubismMotionSpeedTarget | null): boolean {
    const nextRate = normalizeCubismPlaybackRate(rate);
    if (this.currentRate === nextRate) return false;
    this.currentRate = nextRate;
    target?.setMotionSpeed(this.currentRate);
    return true;
  }

  apply(target: CubismMotionSpeedTarget): void {
    target.setMotionSpeed(this.currentRate);
  }
}

/**
 * Splits one rendered frame so the rate-scaled Cubism motion clock never
 * jumps by more than one 30 Hz tick. This keeps 2x playback on the same
 * continuous update path as 0.5x and 1x, including after a delayed RAF.
 */
export function cubismPlaybackSteps(elapsedSeconds: number, playbackRate: number): readonly number[] {
  const elapsed = Math.max(0, Number.isFinite(elapsedSeconds) ? elapsedSeconds : 0);
  if (elapsed === 0) return [0];
  const rate = normalizeCubismPlaybackRate(playbackRate);
  const count = Math.max(1, Math.ceil((elapsed * rate) / MAXIMUM_MOTION_STEP_SECONDS));
  const step = elapsed / count;
  return Array.from({ length: count }, () => step);
}
