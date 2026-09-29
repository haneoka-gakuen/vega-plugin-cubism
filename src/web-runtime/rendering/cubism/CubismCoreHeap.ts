/** Core 5.1 keeps model views on the heap that existed at construction time. */
interface CoreModelViews {
  readonly _ptr: number;
  parameters: { readonly values: Float32Array };
  parts: unknown;
  drawables: unknown;
}

interface CoreViewConstructors {
  Parameters: new (pointer: number) => CoreModelViews["parameters"];
  Parts: new (pointer: number) => unknown;
  Drawables: new (pointer: number) => unknown;
}

interface HeapModel {
  readonly model: CoreModelViews;
  readonly refreshAliases: () => void;
}

// The viewer and player can have separate ESM identities but share one Core
// heap. Registration follows model ownership and is removed before Core free.
const registryKey = Symbol.for("vega.cubism.core-heap-models");
const globals = globalThis as typeof globalThis & { [registryKey]?: Set<HeapModel> };
const models = (globals[registryKey] ??= new Set<HeapModel>());

export function retainCubismCoreViews(model: CoreModelViews, refreshAliases: () => void): () => void {
  const entry = { model, refreshAliases };
  models.add(entry);
  try {
    refreshCubismCoreViews();
  } catch (error) {
    models.delete(entry);
    throw error;
  }
  return () => models.delete(entry);
}

/** Call synchronously after a Core allocation, before yielding to animation. */
export function refreshCubismCoreViews(): void {
  const first = models.values().next().value;
  if (!first) return;
  const core = (globalThis as typeof globalThis & { Live2DCubismCore: CoreViewConstructors }).Live2DCubismCore;
  // Parameters only reads Core pointers; it neither allocates native memory
  // nor changes parameter values. A fresh view exposes the current heap even
  // in the asm.js Core build, whose replaced buffer remains non-detached.
  const parameters = new core.Parameters(first.model._ptr);
  const buffer = parameters.values.buffer;
  for (const entry of models) {
    const model = entry.model;
    if (model.parameters.values.buffer === buffer) continue;
    model.parameters = entry === first ? parameters : new core.Parameters(model._ptr);
    model.parts = new core.Parts(model._ptr);
    model.drawables = new core.Drawables(model._ptr);
    entry.refreshAliases();
  }
}
