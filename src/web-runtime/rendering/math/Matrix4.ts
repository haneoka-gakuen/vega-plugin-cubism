/** Structural matrix accepted from renderer integrations such as Three.js. */
export interface Matrix4Like {
  readonly elements: ArrayLike<number>;
}

/**
 * Small column-major 4x4 matrix used at the Cubism runtime boundary.
 *
 * Cubism only needs set/copy/multiply and raw elements. Keeping this tiny
 * structural implementation avoids embedding a second Three.js module inside
 * the separately provisioned runtime while remaining directly compatible with
 * a host Three.js Matrix4.
 */
export class Matrix4 implements Matrix4Like {
  readonly elements = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

  set(
    n11: number,
    n12: number,
    n13: number,
    n14: number,
    n21: number,
    n22: number,
    n23: number,
    n24: number,
    n31: number,
    n32: number,
    n33: number,
    n34: number,
    n41: number,
    n42: number,
    n43: number,
    n44: number,
  ): this {
    const elements = this.elements;
    elements[0] = n11;
    elements[4] = n12;
    elements[8] = n13;
    elements[12] = n14;
    elements[1] = n21;
    elements[5] = n22;
    elements[9] = n23;
    elements[13] = n24;
    elements[2] = n31;
    elements[6] = n32;
    elements[10] = n33;
    elements[14] = n34;
    elements[3] = n41;
    elements[7] = n42;
    elements[11] = n43;
    elements[15] = n44;
    return this;
  }

  identity(): this {
    return this.set(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
  }

  copy(matrix: Matrix4Like): this {
    const source = matrix.elements;
    const target = this.elements;
    for (let index = 0; index < 16; index += 1) {
      target[index] = Number(source[index]) || 0;
    }
    return this;
  }

  multiply(matrix: Matrix4Like): this {
    return this.multiplyMatrices(this, matrix);
  }

  multiplyMatrices(left: Matrix4Like, right: Matrix4Like): this {
    const ae = left.elements;
    const be = right.elements;
    const a11 = Number(ae[0]);
    const a12 = Number(ae[4]);
    const a13 = Number(ae[8]);
    const a14 = Number(ae[12]);
    const a21 = Number(ae[1]);
    const a22 = Number(ae[5]);
    const a23 = Number(ae[9]);
    const a24 = Number(ae[13]);
    const a31 = Number(ae[2]);
    const a32 = Number(ae[6]);
    const a33 = Number(ae[10]);
    const a34 = Number(ae[14]);
    const a41 = Number(ae[3]);
    const a42 = Number(ae[7]);
    const a43 = Number(ae[11]);
    const a44 = Number(ae[15]);
    const b11 = Number(be[0]);
    const b12 = Number(be[4]);
    const b13 = Number(be[8]);
    const b14 = Number(be[12]);
    const b21 = Number(be[1]);
    const b22 = Number(be[5]);
    const b23 = Number(be[9]);
    const b24 = Number(be[13]);
    const b31 = Number(be[2]);
    const b32 = Number(be[6]);
    const b33 = Number(be[10]);
    const b34 = Number(be[14]);
    const b41 = Number(be[3]);
    const b42 = Number(be[7]);
    const b43 = Number(be[11]);
    const b44 = Number(be[15]);

    return this.set(
      a11 * b11 + a12 * b21 + a13 * b31 + a14 * b41,
      a11 * b12 + a12 * b22 + a13 * b32 + a14 * b42,
      a11 * b13 + a12 * b23 + a13 * b33 + a14 * b43,
      a11 * b14 + a12 * b24 + a13 * b34 + a14 * b44,
      a21 * b11 + a22 * b21 + a23 * b31 + a24 * b41,
      a21 * b12 + a22 * b22 + a23 * b32 + a24 * b42,
      a21 * b13 + a22 * b23 + a23 * b33 + a24 * b43,
      a21 * b14 + a22 * b24 + a23 * b34 + a24 * b44,
      a31 * b11 + a32 * b21 + a33 * b31 + a34 * b41,
      a31 * b12 + a32 * b22 + a33 * b32 + a34 * b42,
      a31 * b13 + a32 * b23 + a33 * b33 + a34 * b43,
      a31 * b14 + a32 * b24 + a33 * b34 + a34 * b44,
      a41 * b11 + a42 * b21 + a43 * b31 + a44 * b41,
      a41 * b12 + a42 * b22 + a43 * b32 + a44 * b42,
      a41 * b13 + a42 * b23 + a43 * b33 + a44 * b43,
      a41 * b14 + a42 * b24 + a43 * b34 + a44 * b44,
    );
  }
}
