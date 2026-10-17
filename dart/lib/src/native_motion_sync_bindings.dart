import 'dart:ffi';

import 'package:ffi/ffi.dart';

const _asset =
    'package:vega_plugin_cubism/src/native_motion_sync_bindings.dart';

@Native<Pointer<Void> Function(Pointer<Uint8>, Size)>(
  symbol: 'csm_ms_create',
  assetId: _asset,
)
external Pointer<Void> create(Pointer<Uint8> source, int length);

@Native<Void Function(Pointer<Void>)>(symbol: 'csm_ms_destroy', assetId: _asset)
external void destroy(Pointer<Void> engine);

@Native<Uint32 Function(Pointer<Void>)>(
  symbol: 'csm_ms_engine_version',
  assetId: _asset,
)
external int version(Pointer<Void> engine);

@Native<Uint64 Function(Pointer<Void>)>(
  symbol: 'csm_ms_memory_bytes',
  assetId: _asset,
)
external int memory(Pointer<Void> engine);

@Native<Uint32 Function(Pointer<Void>, Pointer<Uint8>, Size, Uint32)>(
  symbol: 'csm_ms_context_create',
  assetId: _asset,
)
external int createContext(
  Pointer<Void> engine,
  Pointer<Uint8> json,
  int length,
  int rate,
);

@Native<Uint32 Function(Pointer<Void>, Uint32)>(
  symbol: 'csm_ms_context_require_samples',
  assetId: _asset,
)
external int requiredSamples(Pointer<Void> engine, int id);

@Native<Uint32 Function(Pointer<Void>, Uint32)>(
  symbol: 'csm_ms_context_values_count',
  assetId: _asset,
)
external int valueCount(Pointer<Void> engine, int id);

@Native<Int32 Function(Pointer<Void>, Uint32, Pointer<Double>, Size)>(
  symbol: 'csm_ms_context_clear',
  assetId: _asset,
)
external int clearContext(
  Pointer<Void> engine,
  int id,
  Pointer<Double> initial,
  int count,
);

@Native<
  Int32 Function(
    Pointer<Void>,
    Uint32,
    Pointer<Float>,
    Size,
    Pointer<Double>,
    Size,
    Pointer<Uint32>,
  )
>(symbol: 'csm_ms_context_analyze', assetId: _asset)
external int analyze(
  Pointer<Void> engine,
  int id,
  Pointer<Float> samples,
  int count,
  Pointer<Double> output,
  int capacity,
  Pointer<Uint32> processed,
);

@Native<Int32 Function(Pointer<Void>, Uint32)>(
  symbol: 'csm_ms_context_delete',
  assetId: _asset,
)
external int deleteContext(Pointer<Void> engine, int id);

@Native<Pointer<Utf8> Function()>(symbol: 'csm_ms_last_error', assetId: _asset)
external Pointer<Utf8> lastError();

@Native<Pointer<Void> Function(Pointer<Uint8>, Size)>(
  symbol: 'csm_ms_pcm_decode',
  assetId: _asset,
)
external Pointer<Void> pcmDecode(Pointer<Uint8> bytes, int length);

@Native<Uint64 Function(Pointer<Void>)>(
  symbol: 'csm_ms_pcm_frames',
  assetId: _asset,
)
external int pcmFrames(Pointer<Void> pcm);

@Native<Uint32 Function(Pointer<Void>)>(
  symbol: 'csm_ms_pcm_sample_rate',
  assetId: _asset,
)
external int pcmRate(Pointer<Void> pcm);

@Native<Pointer<Float> Function(Pointer<Void>)>(
  symbol: 'csm_ms_pcm_samples',
  assetId: _asset,
)
external Pointer<Float> pcmSamples(Pointer<Void> pcm);

@Native<Void Function(Pointer<Void>)>(
  symbol: 'csm_ms_pcm_free',
  assetId: _asset,
)
external void pcmFree(Pointer<Void> pcm);
