import 'dart:math' as math;
import 'dart:typed_data';

import 'model_frame.dart';

final class CubismMaskContext {
  CubismMaskContext({
    required this.key,
    required this.sources,
    required this.consumers,
    required this.atlas,
    required this.channel,
    required this.column,
    required this.row,
    required this.tileSize,
    required this.centerX,
    required this.centerY,
    required this.scale,
  });
  final String key;
  final List<int> sources, consumers;
  final int atlas, channel, column, row;
  final double tileSize, centerX, centerY, scale;
  late final channelColor = Float32List.fromList([
    for (var i = 0; i < 4; i++) i == channel ? 1.0 : 0.0,
  ]);
  late final tileBounds = Float32List.fromList([
    column * tileSize,
    1 - (row + 1) * tileSize,
    (column + 1) * tileSize,
    1 - row * tileSize,
  ]);

  double clipX(double x) {
    final u = (column + .5 + (x - centerX) * scale) * tileSize;
    return 2 * u - 1;
  }

  double clipY(double y) {
    final v = (row + .5 + (y - centerY) * scale) * tileSize;
    return 2 * v - 1;
  }

  void writeMaskClip(Float32List output, int offset, double x, double y) {
    output[offset] = clipX(x);
    output[offset + 1] = clipY(y);
    output[offset + 2] = 0;
    output[offset + 3] = 1;
  }

  /// Homogeneous clip coordinates to top-left atlas UV, followed by W.
  Float32List samplingRows(Float32List inverseClipFromModel) {
    final sx = scale * tileSize;
    final ux = (column + .5) * tileSize - centerX * sx;
    final vy = 1 - (row + .5) * tileSize + centerY * sx;
    return Float32List.fromList([
      for (var c = 0; c < 4; c++)
        sx * inverseClipFromModel[c * 4] + ux * inverseClipFromModel[c * 4 + 3],
      for (var c = 0; c < 4; c++)
        -sx * inverseClipFromModel[c * 4 + 1] +
            vy * inverseClipFromModel[c * 4 + 3],
      for (var c = 0; c < 4; c++) inverseClipFromModel[c * 4 + 3],
    ]);
  }
}

final class CubismMaskAtlas {
  CubismMaskAtlas(this.contexts, this.consumerContexts);
  final List<CubismMaskContext> contexts;
  final Map<int, CubismMaskContext> consumerContexts;
}

/// Stable source-index grouping. Inactive consumers keep their tile assignment
/// but require no atlas draw or allocation.
CubismMaskAtlas buildCubismMaskAtlas(List<NativeCubismDrawable> drawables) {
  final ordered = [...drawables]
    ..sort((a, b) => a.sourceIndex.compareTo(b.sourceIndex));
  final byIndex = {for (final d in ordered) d.sourceIndex: d};
  final groups = <String, (List<int>, List<int>)>{};
  for (final d in ordered) {
    if (d.masks.isEmpty) continue;
    final masks = d.masks.where((i) => i >= 0).toList()..sort();
    if (masks.isEmpty) continue;
    final key = masks.join(',');
    final group = groups.putIfAbsent(key, () => (masks, <int>[]));
    if (d.visible && d.opacity > 0 && d.indices.isNotEmpty) {
      group.$2.add(d.sourceIndex);
    }
  }
  final contexts = <CubismMaskContext>[],
      consumers = <int, CubismMaskContext>{};
  final entries = groups.entries.toList();
  for (var base = 0; base < entries.length; base += 36) {
    final count = math.min(36, entries.length - base), div = count ~/ 4;
    final remainder = count % 4;
    var cursor = base;
    for (var channel = 0; channel < 4; channel++) {
      final tiles = div + (channel < remainder ? 1 : 0);
      final grid = tiles <= 1
          ? 1
          : tiles <= 4
          ? 2
          : 3;
      final tileSize = Float32List.fromList([1 / grid]).single;
      for (var tile = 0; tile < tiles; tile++, cursor++) {
        final entry = entries[cursor], sourceIndices = entry.value.$1;
        final consumerIndices = entry.value.$2;
        if (consumerIndices.isEmpty) continue;
        var lx = double.infinity, ly = double.infinity;
        var hx = double.negativeInfinity, hy = double.negativeInfinity;
        for (final index in sourceIndices) {
          final source = byIndex[index];
          if (source == null) throw ArgumentError('cubism_mask_source:$index');
          for (var i = 0; i < source.positions.length; i += 2) {
            final x = source.positions[i], y = source.positions[i + 1];
            lx = math.min(lx, x);
            ly = math.min(ly, y);
            hx = math.max(hx, x);
            hy = math.max(hy, y);
          }
        }
        final side = math.max(hx - lx, hy - ly);
        final center = Float32List.fromList([
          side.isFinite ? (lx + hx) * .5 : 0,
          side.isFinite ? (ly + hy) * .5 : 0,
          side > 0 && side.isFinite ? 1 / side : 0,
        ]);
        final context = CubismMaskContext(
          key: entry.key,
          sources: List.unmodifiable(sourceIndices),
          consumers: List.unmodifiable(consumerIndices),
          atlas: base ~/ 36,
          channel: channel,
          column: tile ~/ grid,
          row: tile % grid,
          tileSize: tileSize,
          centerX: center[0],
          centerY: center[1],
          scale: center[2],
        );
        contexts.add(context);
        for (final consumer in consumerIndices) consumers[consumer] = context;
      }
    }
  }
  return CubismMaskAtlas(
    List.unmodifiable(contexts),
    Map.unmodifiable(consumers),
  );
}

/// Column-major inverse for affine or perspective Cubism host projections.
Float32List inverseCubismProjection(Float32List matrix) {
  final rows = [
    for (var r = 0; r < 4; r++)
      [
        for (var c = 0; c < 4; c++) matrix[c * 4 + r],
        for (var c = 0; c < 4; c++) r == c ? 1.0 : 0.0,
      ],
  ];
  for (var c = 0; c < 4; c++) {
    var pivot = c;
    for (var r = c + 1; r < 4; r++) {
      if (rows[r][c].abs() > rows[pivot][c].abs()) pivot = r;
    }
    final swap = rows[c];
    rows[c] = rows[pivot];
    rows[pivot] = swap;
    final divisor = rows[c][c];
    if (divisor.abs() < 1e-20)
      throw ArgumentError('cubism_projection_singular');
    for (var j = 0; j < 8; j++) rows[c][j] /= divisor;
    for (var r = 0; r < 4; r++) {
      if (r == c) continue;
      final factor = rows[r][c];
      for (var j = 0; j < 8; j++) rows[r][j] -= factor * rows[c][j];
    }
  }
  return Float32List.fromList([
    for (var c = 0; c < 4; c++)
      for (var r = 0; r < 4; r++) rows[r][c + 4],
  ]);
}
