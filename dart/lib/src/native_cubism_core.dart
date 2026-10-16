import 'dart:ffi';
import 'dart:typed_data';

import 'package:ffi/ffi.dart';

import 'model_frame.dart';
import 'core_library.dart';

typedef _CountNative = Int32 Function(Pointer<Void>);
typedef _Count = int Function(Pointer<Void>);
typedef _FloatPointerNative = Pointer<Float> Function(Pointer<Void>);
typedef _FloatPointer = Pointer<Float> Function(Pointer<Void>);
typedef _IntPointerNative = Pointer<Int32> Function(Pointer<Void>);
typedef _IntPointer = Pointer<Int32> Function(Pointer<Void>);
typedef _IdsNative = Pointer<Pointer<Utf8>> Function(Pointer<Void>);
typedef _Ids = Pointer<Pointer<Utf8>> Function(Pointer<Void>);

final class _CsmVector2 extends Struct {
  @Float()
  external double x;
  @Float()
  external double y;
}

/// Native Cubism Core ABI adapter. The separately licensed official native
/// library must be supplied locally; this adapter never loads the Web Core.
final class NativeCubismCore {
  NativeCubismCore(String libraryPath)
    : library = DynamicLibrary.open(libraryPath);
  NativeCubismCore.fromLibrary(this.library);

  factory NativeCubismCore.open({String? libraryPath}) =>
      NativeCubismCore.fromLibrary(
        CubismCoreLibrary.open(libraryPath: libraryPath),
      );

  final DynamicLibrary library;
  static const requiredSymbols = [
    'csmGetVersion',
    'csmGetLatestMocVersion',
    'csmGetMocVersion',
    'csmHasMocConsistency',
    'csmReviveMocInPlace',
    'csmGetSizeofModel',
    'csmInitializeModelInPlace',
    'csmUpdateModel',
    'csmResetDrawableDynamicFlags',
    'csmGetParameterCount',
    'csmGetParameterIds',
    'csmGetParameterValues',
    'csmGetParameterMinimumValues',
    'csmGetParameterMaximumValues',
    'csmGetParameterDefaultValues',
    'csmReadCanvasInfo',
    'csmGetPartCount',
    'csmGetPartIds',
    'csmGetPartOpacities',
    'csmGetDrawableCount',
    'csmGetDrawableIds',
    'csmGetDrawableTextureIndices',
    'csmGetRenderOrders',
    'csmGetOffscreenCount',
    'csmGetDrawableBlendModes',
    'csmGetDrawableOpacities',
    'csmGetDrawableVertexCounts',
    'csmGetDrawableIndexCounts',
    'csmGetDrawableMaskCounts',
    'csmGetDrawableVertexPositions',
    'csmGetDrawableVertexUvs',
    'csmGetDrawableIndices',
    'csmGetDrawableMasks',
    'csmGetDrawableConstantFlags',
    'csmGetDrawableDynamicFlags',
    'csmGetDrawableMultiplyColors',
    'csmGetDrawableScreenColors',
  ];
  Map<String, Object?> capabilityRecord() {
    final missing = [
      for (final symbol in requiredSymbols)
        if (!library.providesSymbol(symbol)) symbol,
    ];
    final version = missing.contains('csmGetVersion')
        ? null
        : library.lookupFunction<Uint32 Function(), int Function()>(
            'csmGetVersion',
          )();
    return {
      'abi': Abi.current().toString(),
      'coreVersion': version,
      'supportedAbi': missing.isEmpty,
      'missingSymbols': missing,
      'sourceAbi': 'officialNativeCore-5-r5',
      'renderOrderContract': 'object-index-to-rank',
    };
  }

  late final latestMocVersion = library
      .lookupFunction<Uint32 Function(), int Function()>(
        'csmGetLatestMocVersion',
      );
  late final mocVersion = library
      .lookupFunction<
        Uint32 Function(Pointer<Void>, Uint32),
        int Function(Pointer<Void>, int)
      >('csmGetMocVersion');
  late final revive = library
      .lookupFunction<
        Pointer<Void> Function(Pointer<Void>, Uint32),
        Pointer<Void> Function(Pointer<Void>, int)
      >('csmReviveMocInPlace');
  late final sizeOfModel = library
      .lookupFunction<
        Uint32 Function(Pointer<Void>),
        int Function(Pointer<Void>)
      >('csmGetSizeofModel');
  late final initialize = library
      .lookupFunction<
        Pointer<Void> Function(Pointer<Void>, Pointer<Void>, Uint32),
        Pointer<Void> Function(Pointer<Void>, Pointer<Void>, int)
      >('csmInitializeModelInPlace');
  late final consistency = library
      .lookupFunction<
        Int32 Function(Pointer<Void>, Uint32),
        int Function(Pointer<Void>, int)
      >('csmHasMocConsistency');
  late final update = library
      .lookupFunction<
        Void Function(Pointer<Void>),
        void Function(Pointer<Void>)
      >('csmUpdateModel');
  late final resetFlags = library
      .lookupFunction<
        Void Function(Pointer<Void>),
        void Function(Pointer<Void>)
      >('csmResetDrawableDynamicFlags');
  late final parameterCount = library.lookupFunction<_CountNative, _Count>(
    'csmGetParameterCount',
  );
  late final parameterIds = library.lookupFunction<_IdsNative, _Ids>(
    'csmGetParameterIds',
  );
  late final parameterValues = library
      .lookupFunction<_FloatPointerNative, _FloatPointer>(
        'csmGetParameterValues',
      );
  late final parameterMinimum = library
      .lookupFunction<_FloatPointerNative, _FloatPointer>(
        'csmGetParameterMinimumValues',
      );
  late final parameterMaximum = library
      .lookupFunction<_FloatPointerNative, _FloatPointer>(
        'csmGetParameterMaximumValues',
      );
  late final parameterDefaults = library
      .lookupFunction<_FloatPointerNative, _FloatPointer>(
        'csmGetParameterDefaultValues',
      );
  late final drawableCount = library.lookupFunction<_CountNative, _Count>(
    'csmGetDrawableCount',
  );
  late final drawableIds = library.lookupFunction<_IdsNative, _Ids>(
    'csmGetDrawableIds',
  );
  late final textureIndices = library
      .lookupFunction<_IntPointerNative, _IntPointer>(
        'csmGetDrawableTextureIndices',
      );
  late final renderOrders = library
      .lookupFunction<_IntPointerNative, _IntPointer>('csmGetRenderOrders');
  late final offscreenCount = library.lookupFunction<_CountNative, _Count>(
    'csmGetOffscreenCount',
  );
  late final blendModes = library
      .lookupFunction<_IntPointerNative, _IntPointer>(
        'csmGetDrawableBlendModes',
      );
  late final opacities = library
      .lookupFunction<_FloatPointerNative, _FloatPointer>(
        'csmGetDrawableOpacities',
      );
  late final vertexCounts = library
      .lookupFunction<_IntPointerNative, _IntPointer>(
        'csmGetDrawableVertexCounts',
      );
  late final indexCounts = library
      .lookupFunction<_IntPointerNative, _IntPointer>(
        'csmGetDrawableIndexCounts',
      );
  late final maskCounts = library
      .lookupFunction<_IntPointerNative, _IntPointer>(
        'csmGetDrawableMaskCounts',
      );
  late final positions = library
      .lookupFunction<
        Pointer<Pointer<Float>> Function(Pointer<Void>),
        Pointer<Pointer<Float>> Function(Pointer<Void>)
      >('csmGetDrawableVertexPositions');
  late final uvs = library
      .lookupFunction<
        Pointer<Pointer<Float>> Function(Pointer<Void>),
        Pointer<Pointer<Float>> Function(Pointer<Void>)
      >('csmGetDrawableVertexUvs');
  late final indices = library
      .lookupFunction<
        Pointer<Pointer<Uint16>> Function(Pointer<Void>),
        Pointer<Pointer<Uint16>> Function(Pointer<Void>)
      >('csmGetDrawableIndices');
  late final masks = library
      .lookupFunction<
        Pointer<Pointer<Int32>> Function(Pointer<Void>),
        Pointer<Pointer<Int32>> Function(Pointer<Void>)
      >('csmGetDrawableMasks');
  late final constantFlags = library
      .lookupFunction<
        Pointer<Uint8> Function(Pointer<Void>),
        Pointer<Uint8> Function(Pointer<Void>)
      >('csmGetDrawableConstantFlags');
  late final dynamicFlags = library
      .lookupFunction<
        Pointer<Uint8> Function(Pointer<Void>),
        Pointer<Uint8> Function(Pointer<Void>)
      >('csmGetDrawableDynamicFlags');
  late final multiplyColors = library
      .lookupFunction<_FloatPointerNative, _FloatPointer>(
        'csmGetDrawableMultiplyColors',
      );
  late final screenColors = library
      .lookupFunction<_FloatPointerNative, _FloatPointer>(
        'csmGetDrawableScreenColors',
      );
  late final partCount = library.lookupFunction<_CountNative, _Count>(
    'csmGetPartCount',
  );
  late final partIds = library.lookupFunction<_IdsNative, _Ids>(
    'csmGetPartIds',
  );
  late final partOpacities = library
      .lookupFunction<_FloatPointerNative, _FloatPointer>(
        'csmGetPartOpacities',
      );
  late final canvasInfo = library
      .lookupFunction<
        Void Function(
          Pointer<Void>,
          Pointer<_CsmVector2>,
          Pointer<_CsmVector2>,
          Pointer<Float>,
        ),
        void Function(
          Pointer<Void>,
          Pointer<_CsmVector2>,
          Pointer<_CsmVector2>,
          Pointer<Float>,
        )
      >('csmReadCanvasInfo');

  NativeCubismModel createModel(Uint8List actualMocBytes) {
    if (actualMocBytes.isEmpty || actualMocBytes.length > 0xffffffff) {
      throw const FormatException('native_cubism_moc_size');
    }
    final capability = capabilityRecord();
    if (capability['supportedAbi'] != true) {
      throw UnsupportedError(
        'native_cubism_core_abi:${capability['missingSymbols']}',
      );
    }
    final mocStorage = _AlignedStorage(actualMocBytes.length, 64);
    _AlignedStorage? modelStorage;
    try {
      mocStorage.pointer
          .cast<Uint8>()
          .asTypedList(actualMocBytes.length)
          .setAll(0, actualMocBytes);
      final version = mocVersion(mocStorage.pointer, actualMocBytes.length);
      if (version == 0 || version > latestMocVersion()) {
        throw UnsupportedError('native_cubism_moc_version:$version');
      }
      if (consistency(mocStorage.pointer, actualMocBytes.length) == 0) {
        throw const FormatException('native_cubism_moc_inconsistent');
      }
      final moc = revive(mocStorage.pointer, actualMocBytes.length);
      if (moc == nullptr) {
        throw const FormatException('native_cubism_moc_revive');
      }
      final size = sizeOfModel(moc);
      if (size <= 0) throw const FormatException('native_cubism_model_size');
      modelStorage = _AlignedStorage(size, 16);
      final model = initialize(moc, modelStorage.pointer, size);
      if (model == nullptr) {
        throw const FormatException('native_cubism_initialize');
      }
      final drawableCount = this.drawableCount(model);
      final offscreenCount = this.offscreenCount(model);
      if (drawableCount < 0 || offscreenCount < 0) {
        throw const FormatException('native_cubism_object_counts');
      }
      if (offscreenCount != 0) {
        throw UnsupportedError('native_cubism_offscreen:$offscreenCount');
      }
      _validateClassicRenderState(model, drawableCount);
      return NativeCubismModel._(this, model, mocStorage, modelStorage, {
        ...capability,
        'mocVersion': version,
        'mocBytes': actualMocBytes.length,
        'modelBytes': size,
        'drawableCount': drawableCount,
        'offscreenCount': offscreenCount,
        'renderCapability': 'classic-drawables',
      });
    } catch (_) {
      modelStorage?.dispose();
      mocStorage.dispose();
      rethrow;
    }
  }

  void _validateClassicRenderState(Pointer<Void> model, int count) {
    final ranks = renderOrders(model), blends = blendModes(model);
    if (count > 0 && (ranks == nullptr || blends == nullptr)) {
      throw const FormatException('native_cubism_render_state');
    }
    final seen = <int>{};
    for (var index = 0; index < count; index++) {
      final rank = ranks[index];
      if (rank < 0 || rank >= count || !seen.add(rank)) {
        throw FormatException('native_cubism_render_rank:$index:$rank');
      }
      final blend = blends[index], color = blend & 0xff;
      final alpha = (blend >> 8) & 0xff;
      // R5's classic modes retain the existing drawable flag material contract.
      if (!((color == 0 && alpha == 0) || color == 1 || color == 2)) {
        throw UnsupportedError('native_cubism_blend:$index:$blend');
      }
    }
  }
}

final class _AlignedStorage {
  _AlignedStorage(int bytes, int alignment)
    : allocation = calloc<Uint8>(bytes + alignment - 1) {
    pointer = Pointer<Void>.fromAddress(
      (allocation.address + alignment - 1) & ~(alignment - 1),
    );
  }
  final Pointer<Uint8> allocation;
  late final Pointer<Void> pointer;
  void dispose() => calloc.free(allocation);
}

final class NativeCubismModel {
  NativeCubismModel._(
    this.core,
    this.pointer,
    this._moc,
    this._model,
    this.capability,
  ) {
    final count = core.parameterCount(pointer),
        ids = core.parameterIds(pointer);
    parameters = {
      for (var index = 0; index < count; index++)
        ids[index].toDartString(): index,
    };
    final partCount = core.partCount(pointer), partIds = core.partIds(pointer);
    parts = {
      for (var index = 0; index < partCount; index++)
        partIds[index].toDartString(): index,
    };
    final size = calloc<_CsmVector2>(),
        origin = calloc<_CsmVector2>(),
        unit = calloc<Float>();
    try {
      core.canvasInfo(pointer, size, origin, unit);
      canvas = NativeCubismCanvas(
        size.ref.x,
        size.ref.y,
        origin.ref.x,
        origin.ref.y,
        unit.value,
      );
    } finally {
      calloc.free(size);
      calloc.free(origin);
      calloc.free(unit);
    }
  }
  final NativeCubismCore core;
  final Pointer<Void> pointer;
  final _AlignedStorage _moc, _model;
  final Map<String, Object?> capability;
  late final Map<String, int> parameters;
  late final Map<String, int> parts;
  late final NativeCubismCanvas canvas;
  List<_DrawableTopology> _topology = const [];
  List<Float32List> _positions = const [];
  void setPartOpacity(String id, double value) {
    if (_disposed) throw StateError('native_cubism_disposed');
    final index = parts[id];
    if (index == null) throw StateError('native_cubism_part:$id');
    if (!value.isFinite) throw ArgumentError('native_cubism_part_opacity');
    core.partOpacities(pointer)[index] = value.clamp(0.0, 1.0);
  }

  bool _disposed = false;
  void setParameter(String id, double value) {
    if (_disposed) throw StateError('native_cubism_disposed');
    final index = parameters[id];
    if (index == null) throw StateError('native_cubism_parameter:$id');
    if (!value.isFinite) throw ArgumentError('native_cubism_parameter_value');
    core.parameterValues(pointer)[index] = value.clamp(
      core.parameterMinimum(pointer)[index],
      core.parameterMaximum(pointer)[index],
    );
  }

  void resetParameters() {
    if (_disposed) throw StateError('native_cubism_disposed');
    final count = core.parameterCount(pointer);
    core
        .parameterValues(pointer)
        .asTypedList(count)
        .setAll(0, core.parameterDefaults(pointer).asTypedList(count));
  }

  List<NativeCubismDrawable> evaluate() {
    if (_disposed) throw StateError('native_cubism_disposed');
    core.resetFlags(pointer);
    core.update(pointer);
    final count = core.drawableCount(pointer);
    core._validateClassicRenderState(pointer, count);
    final names = core.drawableIds(pointer),
        tex = core.textureIndices(pointer),
        orders = core.renderOrders(pointer),
        alpha = core.opacities(pointer),
        vcounts = core.vertexCounts(pointer),
        icounts = core.indexCounts(pointer),
        mcounts = core.maskCounts(pointer),
        positions = core.positions(pointer),
        uv = core.uvs(pointer),
        triangles = core.indices(pointer),
        masks = core.masks(pointer),
        flags = core.constantFlags(pointer),
        dynamic = core.dynamicFlags(pointer),
        multiply = core.multiplyColors(pointer),
        screen = core.screenColors(pointer);
    if (_topology.isEmpty && count > 0) {
      _topology = [
        for (var index = 0; index < count; index++)
          _DrawableTopology(
            id: names[index].toDartString(),
            textureIndex: tex[index],
            flags: flags[index],
            uvs:
                (vcounts[index] == 0
                        ? Float32List(0)
                        : Float32List.fromList(
                            uv[index].asTypedList(vcounts[index] * 2),
                          ))
                    .asUnmodifiableView(),
            indices:
                (icounts[index] == 0
                        ? Uint16List(0)
                        : Uint16List.fromList(
                            triangles[index].asTypedList(icounts[index]),
                          ))
                    .asUnmodifiableView(),
            masks:
                (mcounts[index] == 0
                        ? Int32List(0)
                        : Int32List.fromList(
                            masks[index].asTypedList(mcounts[index]),
                          ))
                    .asUnmodifiableView(),
          ),
      ];
      _positions = List.generate(count, (_) => Float32List(0));
    }
    if (_topology.length != count)
      throw const FormatException('cubism_drawable_topology');
    final multiplyValues = multiply.asTypedList(count * 4);
    final screenValues = screen.asTypedList(count * 4);
    return [
      for (var index = 0; index < count; index++)
        NativeCubismDrawable(
          id: _topology[index].id,
          sourceIndex: index,
          textureIndex: _topology[index].textureIndex,
          renderOrder: orders[index],
          opacity: alpha[index],
          flags: _topology[index].flags,
          visible: (dynamic[index] & 1) != 0,
          dynamicFlags: dynamic[index],
          positions: vcounts[index] == 0
              ? _positions[index]
              : _positions[index].length != vcounts[index] * 2 ||
                    (dynamic[index] & 32) != 0
              ? (_positions[index] = Float32List.fromList(
                  positions[index].asTypedList(vcounts[index] * 2),
                ).asUnmodifiableView())
              : _positions[index],
          uvs: _topology[index].uvs,
          indices: _topology[index].indices,
          masks: _topology[index].masks,
          multiplyColor: Float32List.fromList(
            multiplyValues.sublist(index * 4, index * 4 + 4),
          ),
          screenColor: Float32List.fromList(
            screenValues.sublist(index * 4, index * 4 + 4),
          ),
        ),
    ];
  }

  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _model.dispose();
    _moc.dispose();
  }
}

final class _DrawableTopology {
  const _DrawableTopology({
    required this.id,
    required this.textureIndex,
    required this.flags,
    required this.uvs,
    required this.indices,
    required this.masks,
  });
  final String id;
  final int textureIndex, flags;
  final Float32List uvs;
  final Uint16List indices;
  final Int32List masks;
}

final class NativeCubismCanvas {
  const NativeCubismCanvas(
    this.widthPixels,
    this.heightPixels,
    this.originX,
    this.originY,
    this.pixelsPerUnit,
  );
  final double widthPixels, heightPixels, originX, originY, pixelsPerUnit;
}
