import 'dart:math' as math;
import 'dart:typed_data';

final _float = Float32List(1);
double _f32(double value) {
  _float[0] = value;
  return _float[0];
}

/// A bound parameter curve. The source adapter supplies its curve evaluator.
final class CubismParameterLoopCurve {
  const CubismParameterLoopCurve({
    required this.index,
    required this.defaultValue,
    required this.sample,
  });
  final int index;
  final double defaultValue;
  final double Function(double phase) sample;
}

final class CubismParameterLoopClip {
  CubismParameterLoopClip({
    required this.name,
    required this.duration,
    required Iterable<CubismParameterLoopCurve> curves,
    required this.parameterCurveCount,
  }) : curves = List.unmodifiable(curves);
  final String name;
  final double duration;
  // Includes authored curves whose parameter was absent from the bound model.
  final int parameterCurveCount;
  final List<CubismParameterLoopCurve> curves;
  bool get isValid =>
      name.isNotEmpty &&
      duration.isFinite &&
      duration > 0 &&
      parameterCurveCount > 0;
}

/// Portable channel state. Clip resources and parameter storage stay with the host.
final class CubismParameterLoopSnapshot {
  const CubismParameterLoopSnapshot({
    required this.name,
    required this.phase,
    required this.weight,
    required this.fadeStart,
    required this.fadeTarget,
    required this.fadeElapsed,
    required this.fadeDuration,
    required this.stopping,
  });
  factory CubismParameterLoopSnapshot.fromData(Map data) {
    if (data['version'] != 1) {
      throw const FormatException('cubism_parameter_loop_snapshot_version');
    }
    double number(String key) {
      final value = (data[key] as num).toDouble();
      if (!value.isFinite) {
        throw FormatException('cubism_parameter_loop_snapshot:$key');
      }
      return value;
    }

    return CubismParameterLoopSnapshot(
      name: data['name'] as String,
      phase: number('phase'),
      weight: number('weight'),
      fadeStart: number('fadeStart'),
      fadeTarget: number('fadeTarget'),
      fadeElapsed: number('fadeElapsed'),
      fadeDuration: number('fadeDuration'),
      stopping: data['stopping'] as bool,
    );
  }
  final String name;
  final double phase, weight, fadeStart, fadeTarget, fadeElapsed, fadeDuration;
  final bool stopping;
  Map<String, Object?> toData() => {
    'version': 1,
    'name': name,
    'phase': phase,
    'weight': weight,
    'fadeStart': fadeStart,
    'fadeTarget': fadeTarget,
    'fadeElapsed': fadeElapsed,
    'fadeDuration': fadeDuration,
    'stopping': stopping,
  };
}

/// Independent looping parameter channel; it never owns the main motion queue.
/// The caller supplies accepted animation deltas and the parameter-store port.
final class CubismParameterLoop {
  CubismParameterLoop({
    required this.restoreParameters,
    required this.saveParameters,
    required this.overwrite,
  });
  final void Function() restoreParameters, saveParameters;
  final void Function(int index, double value) overwrite;
  CubismParameterLoopClip? _clip;
  double _phase = 0, _weight = 0, _fadeStart = 0, _fadeTarget = 0;
  double _fadeElapsed = 0, _fadeDuration = 0;
  bool _stopping = false;
  CubismParameterLoopClip? get activeClip => _clip;

  bool play(CubismParameterLoopClip clip, {double fadeSeconds = 0}) {
    if (!clip.isValid) return false;
    if (!fadeSeconds.isFinite) {
      throw ArgumentError('cubism_parameter_loop_fade');
    }
    _restoreDefaults();
    _clip = clip;
    _phase = 0;
    _stopping = false;
    _startFade(1, fadeSeconds);
    return true;
  }

  void _startFade(double target, double duration) {
    _fadeStart = _weight;
    _fadeTarget = target;
    _fadeElapsed = 0;
    _fadeDuration = _f32(math.max(duration, 0));
    if (_fadeDuration <= 0) _weight = target;
  }

  void stop({double fadeSeconds = 0}) {
    if (!fadeSeconds.isFinite) {
      throw ArgumentError('cubism_parameter_loop_fade');
    }
    if (_clip == null) return;
    if (fadeSeconds <= 0) {
      stopImmediately();
    } else {
      _stopping = true;
      _startFade(0, fadeSeconds);
    }
  }

  void _restoreDefaults() {
    final clip = _clip;
    if (clip == null) return;
    restoreParameters();
    for (final curve in clip.curves) {
      overwrite(curve.index, curve.defaultValue);
    }
    saveParameters();
  }

  void stopImmediately() {
    if (_clip == null) return;
    _restoreDefaults();
    _clip = null;
    _phase = _weight = 0;
    _stopping = false;
  }

  /// Advance before the host restores/evaluates its main motion parameters.
  void advance(double deltaSeconds) {
    final clip = _clip;
    if (clip == null) return;
    if (!deltaSeconds.isFinite || deltaSeconds < 0) {
      throw ArgumentError('cubism_parameter_loop_delta');
    }
    final time = _f32(_phase + deltaSeconds), duration = clip.duration;
    _phase = _f32(time - _f32(_f32(time / duration).floorToDouble() * duration))
        .clamp(0.0, duration);
    if (_fadeElapsed < _fadeDuration) {
      _fadeElapsed = _f32(_fadeElapsed + deltaSeconds);
      final fraction = _f32(_fadeElapsed / _fadeDuration).clamp(0.0, 1.0);
      final easing = _f32(.5 - .5 * math.cos(_f32(fraction * _f32(math.pi))));
      _weight = _f32(
        _fadeStart + _f32(_f32(_fadeTarget - _fadeStart) * easing),
      );
    } else {
      _weight = _fadeTarget;
    }
    if (_stopping && _weight <= 0) stopImmediately();
  }

  /// Apply after expressions and before blink, mouth, harmonic motion and physics.
  void apply() {
    final clip = _clip;
    if (clip == null || _weight <= 0) return;
    final weight = _weight.clamp(0.0, 1.0);
    for (final curve in clip.curves) {
      final difference = _f32(curve.sample(_phase) - curve.defaultValue);
      overwrite(
        curve.index,
        _f32(curve.defaultValue + _f32(difference * weight)),
      );
    }
  }

  CubismParameterLoopSnapshot? snapshot() => _clip == null
      ? null
      : CubismParameterLoopSnapshot(
          name: _clip!.name,
          phase: _phase,
          weight: _weight,
          fadeStart: _fadeStart,
          fadeTarget: _fadeTarget,
          fadeElapsed: _fadeElapsed,
          fadeDuration: _fadeDuration,
          stopping: _stopping,
        );

  /// Rebind resources without reapplying parameters already restored by the host.
  void restore(
    CubismParameterLoopSnapshot? state,
    CubismParameterLoopClip? clip,
  ) {
    if (state == null) {
      _clip = null;
      _phase = _weight = 0;
      _stopping = false;
      return;
    }
    if (clip == null ||
        !clip.isValid ||
        state.name != clip.name ||
        state.phase < 0 ||
        state.phase > clip.duration ||
        state.fadeElapsed < 0 ||
        state.fadeDuration < 0) {
      throw const FormatException('cubism_parameter_loop_snapshot_clip');
    }
    _clip = clip;
    _phase = state.phase;
    _weight = state.weight;
    _fadeStart = state.fadeStart;
    _fadeTarget = state.fadeTarget;
    _fadeElapsed = state.fadeElapsed;
    _fadeDuration = state.fadeDuration;
    _stopping = state.stopping;
  }
}
