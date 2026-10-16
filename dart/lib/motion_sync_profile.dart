/// Parameter order and Silence targets from one authored MotionSync setting.
/// Initial smoothing history comes separately from the current model values.
final class MotionSyncProfile {
  MotionSyncProfile._(this.setting, this.parameterIds, this.neutral);

  factory MotionSyncProfile.fromSetting(Map<String, Object?> setting) {
    final ids = [
      for (final parameter in setting['parameters'] as List)
        (parameter as Map)['id'] as String,
    ];
    final silence = (setting['mappings'] as List)
        .cast<Map>()
        .where(
          (mapping) =>
              (mapping['audioParameterId'] as String).toLowerCase() ==
              'silence',
        )
        .firstOrNull;
    return MotionSyncProfile._(
      Map.unmodifiable(setting),
      List.unmodifiable(ids),
      Map.unmodifiable({
        for (final target
            in (silence?['targets'] as List? ?? const []).cast<Map>())
          target['id'] as String: (target['value'] as num).toDouble(),
      }),
    );
  }

  final Map<String, Object?> setting;
  final List<String> parameterIds;
  final Map<String, double> neutral;
}
