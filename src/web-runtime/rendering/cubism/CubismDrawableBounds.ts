/* Copyright 2026 Haneoka Gakuen contributors. MPL-2.0 licensed. */
import type { CubismModel } from "../../vendor/cubism/model/cubismmodel";

export interface DrawableBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  revision: number;
}

/** Shared by mask layout and viewport rejection, once per deformed drawable. */
export class CubismDrawableBounds {
  private readonly bounds: DrawableBounds[];

  constructor(private readonly model: CubismModel) {
    this.bounds = Array.from({ length: model.getDrawableCount() }, () => ({
      minX: Number.MAX_VALUE,
      minY: Number.MAX_VALUE,
      maxX: -Number.MAX_VALUE,
      maxY: -Number.MAX_VALUE,
      revision: -1,
    }));
  }

  get(index: number): Readonly<DrawableBounds> {
    const bounds = this.bounds[index];
    const revision = this.model.getDrawableGeometryRevision(index);
    if (bounds.revision === revision) return bounds;
    const vertices = this.model.getDrawableVertices(index);
    let minX = Number.MAX_VALUE,
      minY = Number.MAX_VALUE;
    let maxX = -Number.MAX_VALUE,
      maxY = -Number.MAX_VALUE;
    for (let offset = 0; offset < vertices.length; offset += 2) {
      const x = vertices[offset],
        y = vertices[offset + 1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    bounds.minX = minX;
    bounds.minY = minY;
    bounds.maxX = maxX;
    bounds.maxY = maxY;
    bounds.revision = revision;
    return bounds;
  }
}

/** Homogeneous clip planes retain geometry crossing the camera or viewport. */
export class CubismDrawableVisibility {
  private readonly visible: Uint8Array;
  private readonly planes = new Float64Array(24);
  private readonly matrix = new Float32Array(16).fill(NaN);
  private revision = -1;
  private width = 0;
  private height = 0;

  constructor(count: number) {
    this.visible = new Uint8Array(count);
  }

  update(model: CubismModel, matrix: Float32Array, width: number, height: number): void {
    const revision = model.getGeometryRevision();
    let same = revision === this.revision && width === this.width && height === this.height;
    for (let index = 0; same && index < 16; index++) same = matrix[index] === this.matrix[index];
    if (same) return;
    this.revision = revision;
    this.width = width;
    this.height = height;
    this.matrix.set(matrix);
    const planes = this.planes;
    // Two physical pixels absorb CPU/GPU projection rounding at clip edges.
    const horizontal = 1 + 4 / Math.max(1, width),
      vertical = 1 + 4 / Math.max(1, height);
    for (let plane = 0; plane < 4; plane++) {
      const axis = plane < 2 ? 0 : 1,
        sign = plane % 2 === 0 ? 1 : -1;
      const guard = plane < 2 ? horizontal : vertical,
        offset = plane * 6;
      planes[offset] = sign * matrix[axis] + guard * matrix[3];
      planes[offset + 1] = sign * matrix[axis + 4] + guard * matrix[7];
      planes[offset + 2] = sign * matrix[axis + 12] + guard * matrix[15];
      for (let component = 0; component < 3; component++) {
        const column = component === 2 ? 12 : component * 4;
        planes[offset + 3 + component] =
          0.000001 * (Math.abs(matrix[axis + column]) + guard * Math.abs(matrix[3 + column]));
      }
    }
    for (let index = 0; index < this.visible.length; index++) {
      this.visible[index] = 0;
      if (!model.getDrawableDynamicFlagIsVisible(index)) continue;
      const bounds = model.getDrawableBounds(index);
      const maxX = Math.max(Math.abs(bounds.minX), Math.abs(bounds.maxX));
      const maxY = Math.max(Math.abs(bounds.minY), Math.abs(bounds.maxY));
      let visible = true;
      for (let plane = 0; plane < 24; plane += 6) {
        const x = planes[plane],
          y = planes[plane + 1];
        const rounding = planes[plane + 3] * maxX + planes[plane + 4] * maxY + planes[plane + 5];
        if (
          x * (x >= 0 ? bounds.maxX : bounds.minX) + y * (y >= 0 ? bounds.maxY : bounds.minY) + planes[plane + 2] <
          -rounding
        ) {
          visible = false;
          break;
        }
      }
      this.visible[index] = Number(visible);
    }
  }

  has(index: number): boolean {
    return this.visible[index] !== 0;
  }
}
