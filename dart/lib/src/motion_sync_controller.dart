import 'dart:async';
import 'dart:collection';
import 'dart:convert';
import 'dart:isolate';
import 'dart:math' as math;
import 'dart:typed_data';

import 'native_motion_sync.dart';

/// A prepared, mono 48 kHz voice. [generation] identifies this preparation,
/// including when the same audio is played again.
final class MotionSyncVoice {
  MotionSyncVoice._(this.generation, Map<Object?, Object?> data)
    : parameterIds = List<String>.unmodifiable(data['parameterIds'] as List),
      frames = data['frames'] as int,
      sampleRate = data['sampleRate'] as int,
      requireSampleCount = data['requireSampleCount'] as int,
      cachedPcmBytes = data['cachedPcmBytes'] as int,
      cachedClips = data['cachedClips'] as int;

  final int generation, frames, sampleRate, requireSampleCount;
  final int cachedPcmBytes, cachedClips;
  final List<String> parameterIds;
}

/// An owned output snapshot. [analyzedFrames] can trail [positionFrames] by the
/// Core's minimum input window; the next update retains that PCM tail.
final class MotionSyncFrame {
  MotionSyncFrame._(this.generation, Map<Object?, Object?> data)
    : parameterIds = List<String>.unmodifiable(data['parameterIds'] as List),
      values = (data['values'] as Float64List).asUnmodifiableView(),
      positionFrames = data['positionFrames'] as int,
      analyzedFrames = data['analyzedFrames'] as int;

  final int generation, positionFrames, analyzedFrames;
  final List<String> parameterIds;
  final Float64List values;
}

/// One persistent Core on a dedicated isolate, shared by independent channels.
///
/// The host supplies actual playback positions in mono 48 kHz frames. No timer,
/// playback speed, audio device or model parameter writes live in this provider.
final class MotionSyncController {
  MotionSyncController._({MotionSyncController? owner, int channel = 0})
    : _owner = owner,
      _channel = channel;

  static Future<MotionSyncController> open({
    required Uint8List coreBytes,
    String? libraryPath,
    int maxCachedPcmBytes = 32 * 1024 * 1024,
    int maxCachedClips = 8,
  }) async {
    if (coreBytes.isEmpty || maxCachedPcmBytes < 1 || maxCachedClips < 1) {
      throw ArgumentError('motion_sync_worker_config');
    }
    final controller = MotionSyncController._();
    controller._subscription = controller._responses.listen(
      controller._receive,
    );
    try {
      controller._isolate = await Isolate.spawn(
        _motionSyncWorker,
        _WorkerInit(
          controller._responses.sendPort,
          TransferableTypedData.fromList([coreBytes]),
          libraryPath,
          maxCachedPcmBytes,
          maxCachedClips,
        ),
        onError: controller._responses.sendPort,
        onExit: controller._responses.sendPort,
        debugName: 'cubism-motion-sync',
      );
      await controller._ready.future;
      return controller;
    } catch (_) {
      controller._isolate?.kill(priority: Isolate.immediate);
      await controller._subscription.cancel();
      controller._responses.close();
      rethrow;
    }
  }

  final MotionSyncController? _owner;
  final int _channel;
  final _channels = <MotionSyncController>{};
  int _nextChannel = 0;
  late final _responses = ReceivePort();
  final _ready = Completer<void>();
  final _exited = Completer<void>();
  final _requests = <int, Completer<Object?>>{};
  late final StreamSubscription<Object?> _subscription;
  Isolate? _isolate;
  SendPort? _commands;
  int _requestId = 0, _generation = 0, _updateSequence = 0;
  int _engineVersion = 0;
  bool _disposed = false, _updating = false;
  _PendingUpdate? _pendingUpdate;
  MotionSyncVoice? _voice;
  Future<void>? _disposeFuture;

  int get engineVersion => _owner?.engineVersion ?? _engineVersion;
  MotionSyncVoice? get voice => _voice;

  /// Each channel owns its active voice/context while sharing the root Core,
  /// decoder isolate and bounded PCM cache. Dispose channels before the owner.
  MotionSyncController createChannel() {
    _alive();
    final owner = _owner ?? this;
    final channel = MotionSyncController._(
      owner: owner,
      channel: ++owner._nextChannel,
    );
    owner._channels.add(channel);
    return channel;
  }

  /// [cacheKey] is the host's immutable audio-content identity. The bounded LRU
  /// retains decoded PCM, never encoded audio. An over-limit clip is rejected.
  /// [initialValues] uses the authored setting's parameter order.
  Future<MotionSyncVoice?> prepare({
    required String cacheKey,
    required Uint8List encodedAudio,
    required Map<String, Object?> setting,
    required List<double> initialValues,
  }) async {
    _alive();
    final generation = _invalidate();
    final Object? data;
    try {
      data = await _request('prepare', {
        'cacheKey': cacheKey,
        'audio': TransferableTypedData.fromList([encodedAudio]),
        'setting': jsonEncode(setting),
        'initialValues': Float64List.fromList(initialValues),
      });
    } catch (_) {
      if (_disposed || generation != _generation) {
        return null;
      }
      rethrow;
    }
    if (_disposed || generation != _generation) {
      return null;
    }
    return _voice = MotionSyncVoice._(generation, data as Map);
  }

  /// Returns null for a superseded tick or voice. Concurrent ticks coalesce to
  /// the latest position, keeping replay/decoder work off the caller's isolate.
  /// Paused ticks retain the current output and never consume PCM.
  Future<MotionSyncFrame?> update({
    required int generation,
    required int positionFrames,
    required bool playing,
  }) => _enqueueUpdate(generation, positionFrames, playing, false);

  /// Clears Core state and replays PCM to an explicit seek, including while the
  /// media is paused. Regular backward [update] calls also clear and replay.
  Future<MotionSyncFrame?> seek({
    required int generation,
    required int positionFrames,
  }) => _enqueueUpdate(generation, positionFrames, false, true);

  Future<MotionSyncFrame?> _enqueueUpdate(
    int generation,
    int positionFrames,
    bool playing,
    bool reset,
  ) {
    if (_disposed || generation != _generation || _voice == null) {
      return Future.value(null);
    }
    final previous = _pendingUpdate;
    final pending = _PendingUpdate(
      generation,
      ++_updateSequence,
      positionFrames,
      playing,
      reset || (previous?.reset ?? false),
    );
    previous?.completer.complete(null);
    _pendingUpdate = pending;
    if (!_updating) {
      unawaited(_drainUpdates());
    }
    return pending.completer.future;
  }

  Future<void> _drainUpdates() async {
    _updating = true;
    try {
      while (_pendingUpdate != null) {
        final pending = _pendingUpdate!;
        _pendingUpdate = null;
        try {
          final data = await _request('update', {
            'positionFrames': pending.positionFrames,
            'playing': pending.playing,
            'reset': pending.reset,
          });
          pending.completer.complete(
            !_disposed &&
                    pending.generation == _generation &&
                    pending.sequence == _updateSequence
                ? MotionSyncFrame._(pending.generation, data as Map)
                : null,
          );
        } catch (error, stack) {
          if (_disposed ||
              pending.generation != _generation ||
              pending.sequence != _updateSequence) {
            pending.completer.complete(null);
          } else {
            pending.completer.completeError(error, stack);
          }
        }
      }
    } finally {
      _updating = false;
    }
  }

  /// Releases the active context and returns its host-supplied initial values.
  /// The engine and PCM cache remain available for the next voice.
  Future<MotionSyncFrame?> reset() async {
    _alive();
    final generation = _invalidate();
    final Object? data;
    try {
      data = await _request('reset', null);
    } catch (_) {
      if (_disposed || generation != _generation) {
        return null;
      }
      rethrow;
    }
    return _disposed || generation != _generation || data == null
        ? null
        : MotionSyncFrame._(generation, data as Map);
  }

  int _invalidate() {
    _voice = null;
    _pendingUpdate?.completer.complete(null);
    _pendingUpdate = null;
    ++_updateSequence;
    return ++_generation;
  }

  void _alive() {
    if (_disposed || _exited.isCompleted || _owner?._disposed == true) {
      throw StateError('motion_sync_worker_disposed');
    }
  }

  Future<Object?> _request(String method, Object? data) {
    return (_owner ?? this)._channelRequest(_channel, method, data);
  }

  Future<Object?> _channelRequest(int channel, String method, Object? data) {
    final completer = Completer<Object?>(), id = ++_requestId;
    if (_exited.isCompleted) {
      return Future.error(StateError('motion_sync_worker_exited'));
    }
    _requests[id] = completer;
    _commands!.send([
      id,
      method,
      {'channel': channel, if (data is Map) ...data},
    ]);
    return completer.future;
  }

  void _receive(Object? message) {
    if (message == null || (message is List && message.length == 2)) {
      final error = message is List
          ? RemoteError('${message[0]}', '${message[1]}')
          : StateError('motion_sync_worker_exited');
      if (!_ready.isCompleted) {
        _ready.completeError(error);
      }
      for (final completer in _requests.values) {
        completer.completeError(error);
      }
      _requests.clear();
      if (message == null && !_exited.isCompleted) {
        _exited.complete();
      }
      return;
    }
    final response = message as List;
    if (response[0] == 0) {
      _commands = response[1] as SendPort;
      _engineVersion = response[2] as int;
      _ready.complete();
    } else {
      final completer = _requests.remove(response[0]);
      if (response[1] == true) {
        completer?.complete(response[2]);
      } else {
        completer?.completeError(
          RemoteError('${response[2]}', '${response[3]}'),
        );
      }
    }
  }

  Future<void> dispose() => _disposeFuture ??= _dispose();

  Future<void> _dispose() async {
    _disposed = true;
    _invalidate();
    final owner = _owner;
    if (owner != null) {
      if (!owner._disposed) await _request('release', null);
      owner._channels.remove(this);
      return;
    }
    for (final channel in _channels) {
      channel._disposed = true;
      channel._invalidate();
    }
    _channels.clear();
    try {
      if (!_exited.isCompleted) {
        await _request('dispose', null);
        await _exited.future;
      }
    } finally {
      await _subscription.cancel();
      _responses.close();
    }
  }
}

final class _PendingUpdate {
  _PendingUpdate(
    this.generation,
    this.sequence,
    this.positionFrames,
    this.playing,
    this.reset,
  );
  final int generation, sequence, positionFrames;
  final bool playing, reset;
  final completer = Completer<MotionSyncFrame?>();
}

final class _WorkerInit {
  const _WorkerInit(
    this.reply,
    this.core,
    this.libraryPath,
    this.maxCachedPcmBytes,
    this.maxCachedClips,
  );
  final SendPort reply;
  final TransferableTypedData core;
  final String? libraryPath;
  final int maxCachedPcmBytes, maxCachedClips;
}

Future<void> _motionSyncWorker(_WorkerInit init) async {
  final commands = ReceivePort();
  final library = NativeMotionSyncLibrary.open(libraryPath: init.libraryPath);
  final engine = library.createEngine(init.core.materialize().asUint8List());
  final cache = _MotionSyncPcmCache(library, init);
  final channels = <int, _MotionSyncWorkerState>{};
  int? disposeRequestId;
  try {
    init.reply.send([0, commands.sendPort, engine.version]);
    await for (final message in commands) {
      final request = message as List, method = request[1] as String;
      try {
        final data = request[2] as Map, channel = data['channel'] as int;
        final result = switch (method) {
          'prepare' =>
            channels
                .putIfAbsent(
                  channel,
                  () => _MotionSyncWorkerState(engine, cache),
                )
                .prepare(data),
          'update' => channels[channel]!.update(data),
          'reset' => channels[channel]?.reset(),
          'release' => channels.remove(channel)?.dispose(),
          'dispose' => null,
          _ => throw StateError('motion_sync_worker_method:$method'),
        };
        if (method == 'dispose') {
          disposeRequestId = request[0] as int;
          break;
        }
        init.reply.send([request[0], true, result]);
      } catch (error, stack) {
        init.reply.send([request[0], false, '$error', '$stack']);
      }
    }
  } finally {
    try {
      try {
        for (final state in channels.values) {
          state.dispose();
        }
      } finally {
        cache.clear();
        engine.dispose();
      }
      if (disposeRequestId != null) {
        init.reply.send([disposeRequestId, true, null]);
      }
    } finally {
      commands.close();
    }
  }
}

final class _MotionSyncWorkerState {
  _MotionSyncWorkerState(this.engine, this.cache);
  final NativeMotionSyncEngine engine;
  final _MotionSyncPcmCache cache;
  int _position = 0, _consumed = 0;
  MotionSyncPcmData? _pcm;
  NativeMotionSyncContext? _context;
  List<String> _ids = const [];
  List<double> _initial = const [];
  Float64List _values = Float64List(0);

  Object prepare(Map data) {
    _releaseContext();
    final key = data['cacheKey'] as String;
    final audio = (data['audio'] as TransferableTypedData).materialize();
    final pcm = cache.read(key, audio.asUint8List());
    final initial = List<double>.from(data['initialValues'] as List);
    final setting = (jsonDecode(data['setting'] as String) as Map)
        .cast<String, Object?>();
    final ids = [
      for (final parameter in setting['parameters'] as List)
        (parameter as Map)['id'] as String,
    ];
    if (initial.length != ids.length) {
      throw ArgumentError('motion_sync_initial_values');
    }
    _context = engine.createContext(
      setting: setting,
      sampleRate: pcm.sampleRate,
      initialValues: initial,
    );
    _pcm = pcm;
    _ids = _context!.parameterIds;
    _initial = initial;
    _values = Float64List.fromList(initial);
    return {
      'parameterIds': _ids,
      'frames': pcm.frames,
      'sampleRate': pcm.sampleRate,
      'requireSampleCount': _context!.requireSampleCount,
      'cachedPcmBytes': cache.bytes,
      'cachedClips': cache.length,
    };
  }

  Object update(Map data) {
    final context = _context, pcm = _pcm;
    if (context == null || pcm == null) {
      throw StateError('motion_sync_voice_missing');
    }
    final explicitSeek = data['reset'] as bool;
    if (!(data['playing'] as bool) && !explicitSeek) {
      return _frame();
    }
    final target = (data['positionFrames'] as int).clamp(0, pcm.frames);
    if (explicitSeek || target < _position) {
      context.clear(initialValues: _initial);
      _values.setAll(0, _initial);
      _consumed = 0;
    }
    _position = target;
    final required = context.requireSampleCount;
    final chunk = math.max(required, 8192);
    while (target - _consumed >= required) {
      final end = math.min(target, _consumed + chunk);
      final result = context.analyze(
        Float32List.sublistView(pcm.samples, _consumed, end),
      );
      final consumed = result.processedSampleCount;
      if (consumed == 0) {
        break;
      }
      if (consumed > end - _consumed) {
        throw StateError('motion_sync_processed_count');
      }
      _consumed += consumed;
      if (result.valueCount == _ids.length) {
        _values.setAll(0, result.values);
      }
    }
    return _frame();
  }

  Map<String, Object?> _frame() => {
    'parameterIds': _ids,
    'values': Float64List.fromList(_values),
    'positionFrames': _position,
    'analyzedFrames': _consumed,
  };

  Object? reset() {
    if (_context == null) {
      return null;
    }
    _values.setAll(0, _initial);
    _releaseContext();
    return _frame();
  }

  void _releaseContext() {
    final context = _context;
    _context = null;
    _pcm = null;
    _position = _consumed = 0;
    context?.dispose();
  }

  void dispose() => _releaseContext();
}

final class _MotionSyncPcmCache {
  _MotionSyncPcmCache(this.library, this.config);
  final NativeMotionSyncLibrary library;
  final _WorkerInit config;
  final _cache = LinkedHashMap<String, MotionSyncPcmData>();
  int bytes = 0;
  int get length => _cache.length;

  MotionSyncPcmData read(String key, Uint8List encoded) {
    var pcm = _cache.remove(key);
    if (pcm == null) {
      pcm = library.decodePcm(encoded);
      if (pcm.sampleRate != 48000) {
        throw const FormatException('motion_sync_pcm_rate');
      }
      if (pcm.samples.lengthInBytes > config.maxCachedPcmBytes) {
        throw StateError('motion_sync_pcm_limit');
      }
      bytes += pcm.samples.lengthInBytes;
    }
    _cache[key] = pcm;
    while (bytes > config.maxCachedPcmBytes ||
        _cache.length > config.maxCachedClips) {
      bytes -= _cache.remove(_cache.keys.first)!.samples.lengthInBytes;
    }
    return pcm;
  }

  void clear() {
    _cache.clear();
    bytes = 0;
  }
}
