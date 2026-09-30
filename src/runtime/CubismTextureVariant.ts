/** Explicit alternatives to a model manifest's positional PNG texture slots. */
export interface CubismTextureVariant {
  readonly textureIndex: number;
  readonly source: string;
  readonly format: "astc6x6" | "bc7" | "etc2";
  readonly container: "ktx2";
  /** Canonical texture identity, when supplied by a catalog producer. */
  readonly texture?: string;
}

export function normalizeCubismTextureVariants(value: unknown): readonly CubismTextureVariant[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): CubismTextureVariant[] => {
    if (!entry || typeof entry !== "object") return [];
    const { textureIndex, source, format, container, texture } = entry;
    if (
      !Number.isSafeInteger(textureIndex) ||
      textureIndex < 0 ||
      typeof source !== "string" ||
      !source.trim() ||
      container !== "ktx2" ||
      !["astc6x6", "bc7", "etc2"].includes(format)
    )
      return [];
    return [
      {
        textureIndex,
        source: source.trim(),
        format,
        container,
        ...(typeof texture === "string" && texture.trim() ? { texture: texture.trim() } : {}),
      },
    ];
  });
}
