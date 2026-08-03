import type { ACubismMotion } from "../../vendor/cubism/motion/acubismmotion";
import type { CubismMotionQueueEntry } from "../../vendor/cubism/motion/cubismmotionqueueentry";

export interface AdvCubismMotionPositionOptions {
  /** Wrap the requested phase by the authored clip duration without changing the cached motion's loop flag. */
  readonly loop?: boolean;
}

function finiteNonNegative(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, numeric) : 0;
}

/**
 * Initializes a newly queued Cubism motion at an authored local phase.
 *
 * ACubismMotion normally initializes start/fade/end timestamps on its first
 * update. Calling setup first preserves that lifecycle (including the began
 * callback), then rebasing every related timestamp prevents the first render
 * update from snapping the motion back to frame zero.
 */
export function positionAdvCubismMotionQueueEntry(
  entry: CubismMotionQueueEntry,
  motion: ACubismMotion,
  userTimeSeconds: number,
  positionSeconds: number,
  options: AdvCubismMotionPositionOptions = {},
): number {
  const now = finiteNonNegative(userTimeSeconds);
  let position = finiteNonNegative(positionSeconds);
  const loopDuration = finiteNonNegative(motion.getLoopDuration());
  if (options.loop && loopDuration > 0) position %= loopDuration;

  motion.setupMotionQueueEntry(entry, now);
  const start = now - position;
  entry.setStartTime(start);
  // A transport restore must also restore fade progress. Starting a new fade
  // at `now` would produce a different pose after seek/retry.
  entry.setFadeInStartTime(start);
  const duration = motion.getDuration();
  entry.setEndTime(Number.isFinite(duration) && duration > 0 ? start + duration : -1);
  // Historical motion events belong to the skipped transport interval. The
  // next update checks only (position, position + delta].
  entry.setLastCheckEventSeconds(now);
  return position;
}
