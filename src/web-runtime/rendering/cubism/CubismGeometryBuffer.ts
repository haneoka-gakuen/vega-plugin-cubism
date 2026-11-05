import type { CubismModel } from "../../vendor/cubism/model/cubismmodel";
import { CubismTextureColor } from "../../vendor/cubism/rendering/cubismrenderer";
import { bindUnityCubismMissingNormal } from "./UnityCubismVertexDefaults";

interface MultiDraw {
  multiDrawElementsWEBGL(
    mode: number,
    counts: Int32Array,
    countsOffset: number,
    type: number,
    offsets: Int32Array,
    offsetsOffset: number,
    drawCount: number,
  ): void;
}

/** Immutable topology and one contiguous deformation upload per model frame. */
export class CubismGeometryBuffer {
  private readonly vao: WebGLVertexArrayObject;
  private readonly vertex: WebGLBuffer;
  private readonly uv: WebGLBuffer;
  private readonly indices: WebGLBuffer;
  private readonly positions: Float32Array;
  private readonly vertexOffsets: Uint32Array;
  private readonly indexOffsets: Uint32Array;
  private readonly counts: Uint32Array;
  private readonly revisions: Float64Array;
  private revision: number;
  private bound = false;
  private readonly multiDraw: MultiDraw | null;
  private readonly batchCounts: Int32Array;
  private readonly batchOffsets: Int32Array;
  private batchSize = 0;
  private batchClip: unknown;
  private readonly batchState = new Float64Array(13).fill(NaN);
  private readonly multiplyColor = new CubismTextureColor();
  private readonly screenColor = new CubismTextureColor();

  get batching(): boolean {
    return this.multiDraw !== null;
  }

  constructor(
    private readonly gl: WebGL2RenderingContext,
    model: CubismModel,
  ) {
    const count = model.getDrawableCount();
    this.multiDraw = gl.getExtension("WEBGL_multi_draw");
    this.batchCounts = new Int32Array(count);
    this.batchOffsets = new Int32Array(count);
    this.vertexOffsets = new Uint32Array(count);
    this.indexOffsets = new Uint32Array(count);
    this.counts = new Uint32Array(count);
    this.revisions = new Float64Array(count);
    let vertices = 0,
      indices = 0;
    for (let index = 0; index < count; index++) {
      this.vertexOffsets[index] = vertices;
      this.indexOffsets[index] = indices * Uint32Array.BYTES_PER_ELEMENT;
      this.counts[index] = model.getDrawableVertexIndexCount(index);
      vertices += model.getDrawableVertices(index).length;
      indices += this.counts[index];
    }
    this.positions = new Float32Array(vertices);
    const uvs = new Float32Array(vertices);
    const topology = new Uint32Array(indices);
    for (let index = 0; index < count; index++) {
      const offset = this.vertexOffsets[index];
      this.positions.set(model.getDrawableVertices(index), offset);
      uvs.set(model.getDrawableVertexUvs(index), offset);
      const source = model.getDrawableVertexIndices(index);
      const start = this.indexOffsets[index] / Uint32Array.BYTES_PER_ELEMENT;
      for (let entry = 0; entry < source.length; entry++) topology[start + entry] = source[entry] + offset / 2;
      this.revisions[index] = model.getDrawableGeometryRevision(index);
    }
    const vao = gl.createVertexArray(),
      vertex = gl.createBuffer(),
      uv = gl.createBuffer(),
      indexBuffer = gl.createBuffer();
    if (!vao || !vertex || !uv || !indexBuffer) {
      gl.deleteVertexArray(vao);
      gl.deleteBuffer(vertex);
      gl.deleteBuffer(uv);
      gl.deleteBuffer(indexBuffer);
      throw new Error("Cubism geometry allocation failed");
    }
    this.vao = vao;
    this.vertex = vertex;
    this.uv = uv;
    this.indices = indexBuffer;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vertex);
    gl.bufferData(gl.ARRAY_BUFFER, this.positions, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, uv);
    gl.bufferData(gl.ARRAY_BUFFER, uvs, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);
    bindUnityCubismMissingNormal(gl);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, topology, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this.revision = model.getGeometryRevision();
  }

  update(model: CubismModel): void {
    const revision = model.getGeometryRevision();
    if (revision === this.revision) return;
    let changed = false;
    for (let index = 0; index < this.revisions.length; index++) {
      const current = model.getDrawableGeometryRevision(index);
      if (this.revisions[index] === current) continue;
      this.positions.set(model.getDrawableVertices(index), this.vertexOffsets[index]);
      this.revisions[index] = current;
      changed = true;
    }
    if (changed) {
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.vertex);
      this.gl.bufferSubData(this.gl.ARRAY_BUFFER, 0, this.positions);
    }
    this.revision = revision;
  }

  invalidateBinding(): void {
    this.bound = false;
  }

  bind(): void {
    if (this.bound) return;
    this.gl.bindVertexArray(this.vao);
    this.bound = true;
  }

  canAppend(model: CubismModel, index: number, clip: unknown, culling: boolean): boolean {
    const multiply = model.getMultiplyColorInto(index, this.multiplyColor);
    const screen = model.getScreenColorInto(index, this.screenColor);
    const state = this.batchState;
    const texture = model.getDrawableTextureIndex(index);
    const blend = model.getDrawableBlendMode(index);
    const inverted = Number(model.getDrawableInvertedMaskBit(index));
    const opacity = model.getDrawableOpacity(index);
    const match =
      this.batchSize > 0 &&
      this.batchClip === clip &&
      state[0] === texture &&
      state[1] === blend &&
      state[2] === inverted &&
      state[3] === Number(culling) &&
      state[4] === opacity &&
      state[5] === multiply.r &&
      state[6] === multiply.g &&
      state[7] === multiply.b &&
      state[8] === multiply.a &&
      state[9] === screen.r &&
      state[10] === screen.g &&
      state[11] === screen.b &&
      state[12] === screen.a;
    if (!match) {
      this.batchClip = clip;
      state[0] = texture;
      state[1] = blend;
      state[2] = inverted;
      state[3] = Number(culling);
      state[4] = opacity;
      state[5] = multiply.r;
      state[6] = multiply.g;
      state[7] = multiply.b;
      state[8] = multiply.a;
      state[9] = screen.r;
      state[10] = screen.g;
      state[11] = screen.b;
      state[12] = screen.a;
    }
    return match;
  }

  enqueue(index: number): void {
    this.batchCounts[this.batchSize] = this.counts[index];
    this.batchOffsets[this.batchSize++] = this.indexOffsets[index];
  }

  flush(): void {
    if (this.batchSize > 1) {
      this.multiDraw!.multiDrawElementsWEBGL(
        this.gl.TRIANGLES,
        this.batchCounts,
        0,
        this.gl.UNSIGNED_INT,
        this.batchOffsets,
        0,
        this.batchSize,
      );
    } else if (this.batchSize === 1) {
      this.gl.drawElements(this.gl.TRIANGLES, this.batchCounts[0], this.gl.UNSIGNED_INT, this.batchOffsets[0]);
    }
    this.batchSize = 0;
  }

  draw(index: number): void {
    this.gl.drawElements(this.gl.TRIANGLES, this.counts[index], this.gl.UNSIGNED_INT, this.indexOffsets[index]);
  }

  dispose(deleteGpuResources: boolean): void {
    this.batchSize = 0;
    if (!deleteGpuResources) return;
    this.gl.deleteVertexArray(this.vao);
    this.gl.deleteBuffer(this.vertex);
    this.gl.deleteBuffer(this.uv);
    this.gl.deleteBuffer(this.indices);
  }
}
