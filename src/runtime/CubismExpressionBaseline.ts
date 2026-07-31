/* Copyright 2026 Haneoka Gakuen contributors. MPL-2.0 licensed. */
export interface CubismExpressionBaselineModel {
  loadParameters(): void;
  getParameterDefaultValue(index: number): number;
  setParameterValueByIndex(index: number, value: number): void;
  saveParameters(): void;
  update(): void;
}

/**
 * Restore the motion-owned parameter baseline before clearing expression
 * parameters. The rendered model also contains late additive inputs such as
 * breath, blink and physics; saving that composited frame would bake those
 * values into every subsequent frame when a cached character is shown again.
 */
export function resetCubismExpressionBaseline(
  model: CubismExpressionBaselineModel,
  resetIndices: Iterable<number>,
): void {
  model.loadParameters();
  for (const index of resetIndices) {
    model.setParameterValueByIndex(index, model.getParameterDefaultValue(index));
  }
  model.saveParameters();
  model.update();
}
