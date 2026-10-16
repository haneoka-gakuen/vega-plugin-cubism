import type { CubismModel } from "../../vendor/cubism/model/cubismmodel";
import { CubismMath } from "../../vendor/cubism/math/cubismmath";
import { evaluateCurve, type CubismMotion } from "../../vendor/cubism/motion/cubismmotion";
import { CubismMotionCurveTarget } from "../../vendor/cubism/motion/cubismmotioninternal";

export interface CubismParameterLoopSnapshot {
  readonly name: string;
  readonly phase: number;
  readonly weight: number;
  readonly fadeStart: number;
  readonly fadeTarget: number;
  readonly fadeElapsed: number;
  readonly fadeDuration: number;
  readonly stopping: boolean;
}

export interface CubismParameterLoopTimeline {
  readonly events: readonly (
    | { readonly kind: "loop"; readonly name: string; readonly fadeSeconds: number; readonly atSeconds: number }
    | { readonly kind: "pause"; readonly paused: boolean; readonly atSeconds: number }
    | { readonly kind: "speed"; readonly rate: number; readonly atSeconds: number }
    | { readonly kind: "show"; readonly atSeconds: number }
  )[];
  readonly atSeconds: number;
}

/** Independent parameter channel evaluated at Source execution order 350. */
export class AdvCubismParameterLoop {
  private motion: CubismMotion | null = null;
  private targets: Array<{ curve: number; parameter: number; defaultValue: number }> = [];
  private state = {
    name: "",
    phase: 0,
    weight: 0,
    fadeStart: 0,
    fadeTarget: 0,
    fadeElapsed: 0,
    fadeDuration: 0,
    stopping: false,
  };

  private bind(model: CubismModel, motion: CubismMotion): typeof this.targets | null {
    if (!(motion._motionData.duration > 0)) return null;
    const targets: typeof this.targets = [];
    let parameterCurves = 0;
    for (let curve = 0; curve < motion._motionData.curveCount; curve++) {
      const value = motion._motionData.curves.at(curve);
      if (value.type !== CubismMotionCurveTarget.CubismMotionCurveTarget_Parameter) continue;
      parameterCurves++;
      const parameter = model.getParameterIndex(value.id);
      if (parameter < 0 || parameter >= model.getParameterCount()) continue;
      targets.push({ curve, parameter, defaultValue: model.getParameterDefaultValue(parameter) });
    }
    return parameterCurves > 0 ? targets : null;
  }

  play(model: CubismModel, name: string, motion: CubismMotion, fadeSeconds = 0): boolean {
    const targets = this.bind(model, motion);
    if (!targets) return false;
    this.restoreDefaults(model);
    this.motion = motion;
    this.targets = targets;
    const duration = Math.max(0, fadeSeconds);
    this.state = {
      name,
      phase: 0,
      weight: duration > 0 ? this.state.weight : 1,
      fadeStart: this.state.weight,
      fadeTarget: 1,
      fadeElapsed: 0,
      fadeDuration: duration,
      stopping: false,
    };
    return true;
  }

  stop(model: CubismModel, fadeSeconds = 0): void {
    if (!this.motion) return;
    if (!(fadeSeconds > 0)) {
      this.stopImmediately(model);
      return;
    }
    this.state = {
      ...this.state,
      fadeStart: this.state.weight,
      fadeTarget: 0,
      fadeElapsed: 0,
      fadeDuration: fadeSeconds,
      stopping: true,
    };
  }

  stopImmediately(model: CubismModel): void {
    this.restoreDefaults(model);
    this.motion = null;
    this.targets = [];
    this.state = { ...this.state, name: "", phase: 0, weight: 0, stopping: false };
  }

  private restoreDefaults(model: CubismModel): void {
    if (this.targets.length === 0) return;
    model.loadParameters();
    for (const target of this.targets) model.setParameterValueByIndex(target.parameter, target.defaultValue);
    model.saveParameters();
  }

  /** Advance before the motion/parameter-store phase, including stop retirement. */
  advance(model: CubismModel, delta: number): void {
    if (!this.motion) return;
    let elapsed = this.state.fadeElapsed;
    let weight = this.state.fadeTarget;
    if (elapsed < this.state.fadeDuration) {
      elapsed += delta;
      const progress = CubismMath.getEasingSine(elapsed / this.state.fadeDuration);
      weight = this.state.fadeStart + (this.state.fadeTarget - this.state.fadeStart) * progress;
    }
    this.state.phase = (this.state.phase + delta) % this.motion._motionData.duration;
    this.state.fadeElapsed = elapsed;
    this.state.weight = weight;
    if (this.state.stopping && this.state.weight <= 0) this.stopImmediately(model);
  }

  /** Expression precedes this channel; eye blink, mouth and physics follow it. */
  apply(model: CubismModel): void {
    if (!this.motion || this.state.weight <= 0) return;
    const weight = Math.max(0, Math.min(1, this.state.weight));
    for (const target of this.targets) {
      const value = evaluateCurve(
        this.motion._motionData,
        target.curve,
        this.state.phase,
        false,
        this.motion._motionData.duration,
      );
      model.setParameterValueByIndex(target.parameter, target.defaultValue + (value - target.defaultValue) * weight);
    }
  }

  capture(): CubismParameterLoopSnapshot | null {
    return this.motion ? { ...this.state } : null;
  }

  restore(model: CubismModel, motion: CubismMotion, state: CubismParameterLoopSnapshot): void {
    const targets = this.bind(model, motion);
    if (!targets) throw new Error(`cubism_parameter_loop_curves:${state.name}`);
    this.motion = motion;
    this.targets = targets;
    this.state = { ...state };
    this.apply(model);
  }
}
