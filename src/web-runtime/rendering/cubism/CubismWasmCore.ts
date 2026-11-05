/* Copyright 2026 Haneoka Gakuen contributors. MPL-2.0 licensed. */

type NativeCall = (...values: number[]) => number;

/** Adapt the official native Core ABI to the Web Framework's heap-view API. */
export async function loadCubismWasmCore(url: string): Promise<object> {
  let native: WebAssembly.Exports;
  let logFunction: ((message: string) => void) | null = null;
  const decoder = new TextDecoder();
  const output = new Map<number, string>();
  const memory = () => native.memory as WebAssembly.Memory;
  const bytes = () => new Uint8Array(memory().buffer);
  const view = () => new DataView(memory().buffer);
  const text = (pointer: number) => {
    const heap = bytes();
    let end = pointer;
    while (heap[end]) end++;
    return decoder.decode(heap.subarray(pointer, end));
  };
  const imports = {
    env: { coreLog: (pointer: number) => logFunction?.(text(pointer)) },
    wasi_snapshot_preview1: {
      clock_time_get: (clock: number, _precision: bigint, pointer: number) => {
        view().setBigUint64(pointer, BigInt(Math.floor((clock === 0 ? Date.now() : performance.now()) * 1e6)), true);
        return 0;
      },
      fd_close: () => 0,
      fd_seek: () => 70,
      fd_fdstat_get: (fd: number, pointer: number) => {
        if (fd !== 1 && fd !== 2) return 8;
        bytes().fill(0, pointer, pointer + 24);
        view().setUint8(pointer, 2);
        view().setBigUint64(pointer + 8, 64n, true);
        return 0;
      },
      fd_write: (fd: number, vectors: number, length: number, written: number) => {
        let line = output.get(fd) ?? "";
        let total = 0;
        for (let index = 0; index < length; index++) {
          const start = view().getUint32(vectors + index * 8, true);
          const size = view().getUint32(vectors + index * 8 + 4, true);
          line += decoder.decode(bytes().subarray(start, start + size));
          total += size;
        }
        const lines = line.split("\n");
        output.set(fd, lines.pop() ?? "");
        for (const message of lines)
          if (message) {
            if (fd === 1) console.info(message);
            else console.warn(message);
          }
        view().setUint32(written, total, true);
        return 0;
      },
    },
  };
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Cubism Core request failed: ${response.status}`);
  const { instance } = await WebAssembly.instantiate(await response.arrayBuffer(), imports);
  native = instance.exports;
  const call = (name: string, ...values: number[]) => (native[name] as NativeCall)(...values);
  call("__wasm_call_ctors");
  const updateModel = native.csmUpdateModel as NativeCall;
  const resetFlags = native.csmResetDrawableDynamicFlags as NativeCall;
  const release = native.free as NativeCall;
  const allocate = (size: number, alignment = 16) => {
    const pointer = call("aligned_alloc", alignment, Math.ceil(size / alignment) * alignment);
    if (!pointer) throw new Error("Cubism Core allocation failed");
    return pointer;
  };
  const floats = (name: string, pointer: number, count: number) =>
    new Float32Array(memory().buffer, call(name, pointer), count);
  const ints = (name: string, pointer: number, count: number) =>
    new Int32Array(memory().buffer, call(name, pointer), count);
  const strings = (name: string, pointer: number, count: number) => Array.from(ints(name, pointer, count), text);
  const arrays = <T>(
    name: string,
    pointer: number,
    counts: Int32Array,
    make: (buffer: ArrayBuffer, offset: number, count: number) => T,
    stride = 1,
  ) =>
    Array.from(ints(name, pointer, counts.length), (offset, index) =>
      make(memory().buffer, offset, counts[index] * stride),
    );

  class Parameters {
    readonly count: number;
    readonly ids: string[];
    readonly minimumValues: Float32Array;
    readonly maximumValues: Float32Array;
    readonly defaultValues: Float32Array;
    readonly values: Float32Array;
    readonly types: Int32Array;
    readonly repeats: Int32Array;
    readonly keyCounts: Int32Array;
    readonly keyValues: Float32Array[];
    constructor(pointer: number) {
      this.count = call("csmGetParameterCount", pointer);
      this.ids = strings("csmGetParameterIds", pointer, this.count);
      this.minimumValues = floats("csmGetParameterMinimumValues", pointer, this.count);
      this.maximumValues = floats("csmGetParameterMaximumValues", pointer, this.count);
      this.defaultValues = floats("csmGetParameterDefaultValues", pointer, this.count);
      this.values = floats("csmGetParameterValues", pointer, this.count);
      this.types = ints("csmGetParameterTypes", pointer, this.count);
      this.repeats = ints("csmGetParameterRepeats", pointer, this.count);
      this.keyCounts = ints("csmGetParameterKeyCounts", pointer, this.count);
      this.keyValues = arrays(
        "csmGetParameterKeyValues",
        pointer,
        this.keyCounts,
        (buffer, offset, count) => new Float32Array(buffer, offset, count),
      );
    }
  }
  class Parts {
    readonly count: number;
    readonly ids: string[];
    readonly opacities: Float32Array;
    readonly parentIndices: Int32Array;
    constructor(pointer: number) {
      this.count = call("csmGetPartCount", pointer);
      this.ids = strings("csmGetPartIds", pointer, this.count);
      this.opacities = floats("csmGetPartOpacities", pointer, this.count);
      this.parentIndices = ints("csmGetPartParentPartIndices", pointer, this.count);
    }
  }
  class Drawables {
    readonly count: number;
    readonly ids: string[];
    readonly constantFlags: Uint8Array;
    readonly dynamicFlags: Uint8Array;
    readonly textureIndices: Int32Array;
    readonly drawOrders: Int32Array;
    readonly renderOrders: Int32Array;
    readonly opacities: Float32Array;
    readonly maskCounts: Int32Array;
    readonly masks: Int32Array[];
    readonly vertexCounts: Int32Array;
    readonly vertexPositions: Float32Array[];
    readonly vertexUvs: Float32Array[];
    readonly indexCounts: Int32Array;
    readonly indices: Uint16Array[];
    readonly multiplyColors: Float32Array;
    readonly screenColors: Float32Array;
    readonly parentPartIndices: Int32Array;
    constructor(private readonly pointer: number) {
      this.count = call("csmGetDrawableCount", pointer);
      this.ids = strings("csmGetDrawableIds", pointer, this.count);
      this.constantFlags = new Uint8Array(memory().buffer, call("csmGetDrawableConstantFlags", pointer), this.count);
      this.dynamicFlags = new Uint8Array(memory().buffer, call("csmGetDrawableDynamicFlags", pointer), this.count);
      this.textureIndices = ints("csmGetDrawableTextureIndices", pointer, this.count);
      this.drawOrders = ints("csmGetDrawableDrawOrders", pointer, this.count);
      this.renderOrders = ints("csmGetDrawableRenderOrders", pointer, this.count);
      this.opacities = floats("csmGetDrawableOpacities", pointer, this.count);
      this.maskCounts = ints("csmGetDrawableMaskCounts", pointer, this.count);
      this.masks = arrays(
        "csmGetDrawableMasks",
        pointer,
        this.maskCounts,
        (buffer, offset, count) => new Int32Array(buffer, offset, count),
      );
      this.vertexCounts = ints("csmGetDrawableVertexCounts", pointer, this.count);
      this.vertexPositions = arrays(
        "csmGetDrawableVertexPositions",
        pointer,
        this.vertexCounts,
        (buffer, offset, count) => new Float32Array(buffer, offset, count),
        2,
      );
      this.vertexUvs = arrays(
        "csmGetDrawableVertexUvs",
        pointer,
        this.vertexCounts,
        (buffer, offset, count) => new Float32Array(buffer, offset, count),
        2,
      );
      this.indexCounts = ints("csmGetDrawableIndexCounts", pointer, this.count);
      this.indices = arrays(
        "csmGetDrawableIndices",
        pointer,
        this.indexCounts,
        (buffer, offset, count) => new Uint16Array(buffer, offset, count),
      );
      this.multiplyColors = floats("csmGetDrawableMultiplyColors", pointer, this.count * 4);
      this.screenColors = floats("csmGetDrawableScreenColors", pointer, this.count * 4);
      this.parentPartIndices = ints("csmGetDrawableParentPartIndices", pointer, this.count);
    }
    resetDynamicFlags() {
      resetFlags(this.pointer);
    }
  }
  class CanvasInfo {
    readonly CanvasWidth: number;
    readonly CanvasHeight: number;
    readonly CanvasOriginX: number;
    readonly CanvasOriginY: number;
    readonly PixelsPerUnit: number;
    constructor(pointer: number) {
      const scratch = allocate(20);
      try {
        call("csmReadCanvasInfo", pointer, scratch, scratch + 8, scratch + 16);
        const values = new Float32Array(memory().buffer, scratch, 5);
        [this.CanvasWidth, this.CanvasHeight, this.CanvasOriginX, this.CanvasOriginY, this.PixelsPerUnit] = values;
      } finally {
        release(scratch);
      }
    }
  }
  class Moc {
    private constructor(readonly _ptr: number) {}
    static fromArrayBuffer(buffer: ArrayBuffer) {
      const pointer = allocate(buffer.byteLength, 64);
      bytes().set(new Uint8Array(buffer), pointer);
      if (!call("csmReviveMocInPlace", pointer, buffer.byteLength)) {
        release(pointer);
        return null;
      }
      return new Moc(pointer);
    }
    hasMocConsistency(buffer: ArrayBuffer) {
      const pointer = allocate(buffer.byteLength, 64);
      try {
        bytes().set(new Uint8Array(buffer), pointer);
        return call("csmHasMocConsistency", pointer, buffer.byteLength);
      } finally {
        release(pointer);
      }
    }
    _release() {
      release(this._ptr);
    }
  }
  class Model {
    parameters: Parameters;
    parts: Parts;
    drawables: Drawables;
    readonly canvasinfo: CanvasInfo;
    private constructor(readonly _ptr: number) {
      this.canvasinfo = new CanvasInfo(_ptr);
      this.parameters = new Parameters(_ptr);
      this.parts = new Parts(_ptr);
      this.drawables = new Drawables(_ptr);
    }
    static fromMoc(moc: Moc) {
      const size = call("csmGetSizeofModel", moc._ptr);
      const pointer = allocate(size);
      if (!call("csmInitializeModelInPlace", moc._ptr, pointer, size)) {
        release(pointer);
        return null;
      }
      return new Model(pointer);
    }
    update() {
      updateModel(this._ptr);
    }
    release() {
      release(this._ptr);
    }
  }
  const bit = (mask: number) => (value: number) => (value & mask) !== 0;
  return {
    executionBackend: "wasm" as const,
    AlignofMoc: 64,
    AlignofModel: 16,
    MocVersion_Unknown: 0,
    MocVersion_30: 1,
    MocVersion_33: 2,
    MocVersion_40: 3,
    MocVersion_42: 4,
    MocVersion_50: 5,
    ParameterType_Normal: 0,
    ParameterType_BlendShape: 1,
    Parameters,
    Parts,
    Drawables,
    CanvasInfo,
    Moc,
    Model,
    Version: {
      csmGetVersion: () => call("csmGetVersion"),
      csmGetLatestMocVersion: () => call("csmGetLatestMocVersion"),
      csmGetMocVersion: (_moc: Moc, buffer: ArrayBuffer) => {
        const pointer = allocate(buffer.byteLength, 64);
        try {
          bytes().set(new Uint8Array(buffer), pointer);
          return call("csmGetMocVersion", pointer, buffer.byteLength);
        } finally {
          release(pointer);
        }
      },
    },
    Logging: {
      csmSetLogFunction: (handler: ((message: string) => void) | null) => {
        logFunction = handler;
        call("haneokaSetLogEnabled", Number(Boolean(handler)));
      },
      csmGetLogFunction: () => logFunction,
    },
    Memory: {
      initializeAmountOfMemory: (amount: number) => {
        const pages = Math.ceil(amount / 65536) - memory().buffer.byteLength / 65536;
        if (pages > 0) memory().grow(pages);
      },
    },
    Utils: {
      hasBlendAdditiveBit: bit(1),
      hasBlendMultiplicativeBit: bit(2),
      hasIsDoubleSidedBit: bit(4),
      hasIsInvertedMaskBit: bit(8),
      hasIsVisibleBit: bit(1),
      hasVisibilityDidChangeBit: bit(2),
      hasOpacityDidChangeBit: bit(4),
      hasDrawOrderDidChangeBit: bit(8),
      hasRenderOrderDidChangeBit: bit(16),
      hasVertexPositionsDidChangeBit: bit(32),
      hasBlendColorDidChangeBit: bit(64),
    },
  };
}
