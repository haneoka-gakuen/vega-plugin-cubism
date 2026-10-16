import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'dart:typed_data';

import 'package:ffi/ffi.dart';

final class MotionSyncPcmData {
  const MotionSyncPcmData(this.samples, this.sampleRate);
  final Float32List samples;
  final int sampleRate;
  int get frames => samples.length;
  Duration get duration =>
      Duration(microseconds: (frames * 1000000 / sampleRate).round());
}

/// Optional MotionSync provider. The caller supplies the unchanged official Core
/// bytes and authored mappings, while media clocks and model writes remain local.
final class NativeMotionSyncLibrary {
  NativeMotionSyncLibrary._(this._library);
  factory NativeMotionSyncLibrary.open({String? libraryPath}) =>
      NativeMotionSyncLibrary._(
        libraryPath != null
            ? DynamicLibrary.open(libraryPath)
            : Platform.isIOS
            ? DynamicLibrary.process()
            : DynamicLibrary.open(
                Platform.isWindows
                    ? 'cubism_motion_sync.dll'
                    : Platform.isMacOS
                    ? 'libcubism_motion_sync.dylib'
                    : 'libcubism_motion_sync.so',
              ),
      );
  final DynamicLibrary _library;
  late final _create = _library
      .lookupFunction<
        Pointer<Void> Function(Pointer<Uint8>, Size),
        Pointer<Void> Function(Pointer<Uint8>, int)
      >('csm_ms_create');
  late final _destroy = _library
      .lookupFunction<
        Void Function(Pointer<Void>),
        void Function(Pointer<Void>)
      >('csm_ms_destroy');
  late final _version = _library
      .lookupFunction<
        Uint32 Function(Pointer<Void>),
        int Function(Pointer<Void>)
      >('csm_ms_engine_version');
  late final _memory = _library
      .lookupFunction<
        Uint64 Function(Pointer<Void>),
        int Function(Pointer<Void>)
      >('csm_ms_memory_bytes');
  late final _createContext = _library
      .lookupFunction<
        Uint32 Function(Pointer<Void>, Pointer<Uint8>, Size, Uint32),
        int Function(Pointer<Void>, Pointer<Uint8>, int, int)
      >('csm_ms_context_create');
  late final _required = _library
      .lookupFunction<
        Uint32 Function(Pointer<Void>, Uint32),
        int Function(Pointer<Void>, int)
      >('csm_ms_context_require_samples');
  late final _valueCount = _library
      .lookupFunction<
        Uint32 Function(Pointer<Void>, Uint32),
        int Function(Pointer<Void>, int)
      >('csm_ms_context_values_count');
  late final _clear = _library
      .lookupFunction<
        Int32 Function(Pointer<Void>, Uint32, Pointer<Double>, Size),
        int Function(Pointer<Void>, int, Pointer<Double>, int)
      >('csm_ms_context_clear');
  late final _analyze = _library
      .lookupFunction<
        Int32 Function(
          Pointer<Void>,
          Uint32,
          Pointer<Float>,
          Size,
          Pointer<Double>,
          Size,
          Pointer<Uint32>,
        ),
        int Function(
          Pointer<Void>,
          int,
          Pointer<Float>,
          int,
          Pointer<Double>,
          int,
          Pointer<Uint32>,
        )
      >('csm_ms_context_analyze');
  late final _deleteContext = _library
      .lookupFunction<
        Int32 Function(Pointer<Void>, Uint32),
        int Function(Pointer<Void>, int)
      >('csm_ms_context_delete');
  late final _error = _library
      .lookupFunction<Pointer<Utf8> Function(), Pointer<Utf8> Function()>(
        'csm_ms_last_error',
      );
  late final _decode = _library
      .lookupFunction<
        Pointer<Void> Function(Pointer<Uint8>, Size),
        Pointer<Void> Function(Pointer<Uint8>, int)
      >('csm_ms_pcm_decode');
  late final _pcmFrames = _library
      .lookupFunction<
        Uint64 Function(Pointer<Void>),
        int Function(Pointer<Void>)
      >('csm_ms_pcm_frames');
  late final _pcmRate = _library
      .lookupFunction<
        Uint32 Function(Pointer<Void>),
        int Function(Pointer<Void>)
      >('csm_ms_pcm_sample_rate');
  late final _pcmSamples = _library
      .lookupFunction<
        Pointer<Float> Function(Pointer<Void>),
        Pointer<Float> Function(Pointer<Void>)
      >('csm_ms_pcm_samples');
  late final _pcmFree = _library
      .lookupFunction<
        Void Function(Pointer<Void>),
        void Function(Pointer<Void>)
      >('csm_ms_pcm_free');
  Never _fail() => throw StateError(_error().toDartString());
  Pointer<Uint8> _bytes(Uint8List bytes) {
    final pointer = calloc<Uint8>(bytes.length);
    pointer.asTypedList(bytes.length).setAll(0, bytes);
    return pointer;
  }

  NativeMotionSyncEngine createEngine(Uint8List officialCoreBytes) {
    if (officialCoreBytes.isEmpty) {
      throw ArgumentError('motion_sync_core_bytes');
    }
    final input = _bytes(officialCoreBytes);
    try {
      final engine = _create(input, officialCoreBytes.length);
      if (engine == nullptr) {
        _fail();
      }
      return NativeMotionSyncEngine._(this, engine);
    } finally {
      calloc.free(input);
    }
  }

  MotionSyncPcmData decodePcm(Uint8List encodedAudioBytes) {
    if (encodedAudioBytes.isEmpty) {
      throw ArgumentError('motion_sync_audio_bytes');
    }
    final input = _bytes(encodedAudioBytes);
    late final Pointer<Void> decoded;
    try {
      decoded = _decode(input, encodedAudioBytes.length);
    } finally {
      calloc.free(input);
    }
    if (decoded == nullptr) {
      _fail();
    }
    try {
      final frames = _pcmFrames(decoded), rate = _pcmRate(decoded);
      final samples = Float32List.fromList(
        _pcmSamples(decoded).asTypedList(frames),
      );
      return MotionSyncPcmData(samples.asUnmodifiableView(), rate);
    } finally {
      _pcmFree(decoded);
    }
  }
}

final class NativeMotionSyncEngine {
  NativeMotionSyncEngine._(this._library, this._handle);
  final NativeMotionSyncLibrary _library;
  Pointer<Void> _handle;
  final _contexts = <NativeMotionSyncContext>{};
  void _alive() {
    if (_handle == nullptr) {
      throw StateError('motion_sync_engine_disposed');
    }
  }

  int get version {
    _alive();
    return _library._version(_handle);
  }

  int? get allocatedBytes {
    _alive();
    final value = _library._memory(_handle);
    return value == 0 ? null : value;
  }

  NativeMotionSyncContext createContext({
    required Map<String, Object?> setting,
    required int sampleRate,
    List<double>? initialValues,
  }) {
    _alive();
    final encoded = Uint8List.fromList(
      utf8.encode(
        jsonEncode({
          ...setting,
          if (initialValues != null) 'initialValues': initialValues,
        }),
      ),
    );
    final data = _library._bytes(encoded);
    late final int id;
    try {
      id = _library._createContext(_handle, data, encoded.length, sampleRate);
    } finally {
      calloc.free(data);
    }
    if (id == 0) {
      _library._fail();
    }
    final ids = [
      for (final raw in setting['parameters'] as List)
        (raw as Map)['id'] as String,
    ];
    final context = NativeMotionSyncContext._(this, id, List.unmodifiable(ids));
    _contexts.add(context);
    return context;
  }

  void dispose() {
    if (_handle == nullptr) {
      return;
    }
    for (final context in _contexts.toList()) {
      context.dispose();
    }
    _library._destroy(_handle);
    _handle = nullptr;
  }
}

/// Results and output arrays are reused at each analysis call.
final class NativeMotionSyncAnalysis {
  NativeMotionSyncAnalysis._(this.values);
  final Float64List values;
  int processedSampleCount = 0, valueCount = 0;
}

final class NativeMotionSyncContext {
  NativeMotionSyncContext._(this._engine, this._id, this.parameterIds) {
    final count = _library._valueCount(_engine._handle, _id);
    if (count != parameterIds.length) {
      throw const FormatException('motion_sync_parameter_count');
    }
    _output = calloc<Double>(count);
    _initial = calloc<Double>(count);
    _processed = calloc<Uint32>();
    _values = Float64List(count);
    _result = NativeMotionSyncAnalysis._(_values.asUnmodifiableView());
  }
  final NativeMotionSyncEngine _engine;
  final int _id;
  final List<String> parameterIds;
  NativeMotionSyncLibrary get _library => _engine._library;
  late final Pointer<Double> _output, _initial;
  late final Pointer<Uint32> _processed;
  late final NativeMotionSyncAnalysis _result;
  late final Float64List _values;
  Pointer<Float> _input = nullptr;
  int _capacity = 0;
  bool _disposed = false;
  void _alive() {
    _engine._alive();
    if (_disposed) {
      throw StateError('motion_sync_context_disposed');
    }
  }

  int get requireSampleCount {
    _alive();
    return _library._required(_engine._handle, _id);
  }

  void clear({required List<double> initialValues}) {
    _alive();
    if (initialValues.length != parameterIds.length) {
      throw ArgumentError('motion_sync_initial_values');
    }
    _initial.asTypedList(initialValues.length).setAll(0, initialValues);
    if (_library._clear(_engine._handle, _id, _initial, initialValues.length) <
        0) {
      _library._fail();
    }
    _result
      ..processedSampleCount = 0
      ..valueCount = 0;
  }

  NativeMotionSyncAnalysis analyze(Float32List playedSamples) {
    _alive();
    if (playedSamples.length > _capacity || _input == nullptr) {
      if (_input != nullptr) {
        calloc.free(_input);
      }
      _capacity = playedSamples.isEmpty ? 1 : playedSamples.length;
      _input = calloc<Float>(_capacity);
    }
    _input.asTypedList(_capacity).setAll(0, playedSamples);
    final count = _library._analyze(
      _engine._handle,
      _id,
      _input,
      playedSamples.length,
      _output,
      parameterIds.length,
      _processed,
    );
    if (count < 0) {
      _library._fail();
    }
    _values.setAll(0, _output.asTypedList(parameterIds.length));
    _result
      ..processedSampleCount = _processed.value
      ..valueCount = count;
    return _result;
  }

  void dispose() {
    if (_disposed) {
      return;
    }
    _disposed = true;
    final status = _library._deleteContext(_engine._handle, _id);
    _engine._contexts.remove(this);
    if (_input != nullptr) {
      calloc.free(_input);
    }
    calloc.free(_output);
    calloc.free(_initial);
    calloc.free(_processed);
    if (status < 0) {
      _library._fail();
    }
  }
}
