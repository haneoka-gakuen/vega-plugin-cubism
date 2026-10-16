import 'dart:typed_data';

final class NativeCubismDrawable {
  NativeCubismDrawable({
    required this.id,
    required this.sourceIndex,
    required this.textureIndex,
    required this.renderOrder,
    required this.opacity,
    required this.flags,
    required this.visible,
    this.dynamicFlags = 0,
    required this.positions,
    required this.uvs,
    required this.indices,
    required this.masks,
    required this.multiplyColor,
    required this.screenColor,
  });
  final String id;
  final int sourceIndex, textureIndex, renderOrder, flags, dynamicFlags;
  final double opacity;
  final bool visible;
  final Float32List positions, uvs, multiplyColor, screenColor;
  final Uint16List indices;
  final Int32List masks;
}
