import 'dart:ffi';
import 'dart:io';

final class CubismCoreUnavailable implements Exception {
  const CubismCoreUnavailable(this.platform, this.locations);
  final String platform;
  final List<String> locations;
  @override
  String toString() => 'Cubism Core missing: $platform';
}

abstract final class CubismCoreLibrary {
  static DynamicLibrary open({String? libraryPath}) {
    final configured =
        libraryPath ?? Platform.environment['CUBISM_CORE_LIBRARY'];
    if (configured != null && configured.isNotEmpty) {
      return DynamicLibrary.open(configured);
    }
    if (Platform.isIOS) return DynamicLibrary.process();
    final filename = Platform.isWindows
        ? 'Live2DCubismCore.dll'
        : Platform.isMacOS
        ? 'libLive2DCubismCore.dylib'
        : 'libLive2DCubismCore.so';
    final directory = File(Platform.resolvedExecutable).parent;
    final locations = [
      '${directory.path}/lib/$filename',
      '${directory.path}/$filename',
      if (Platform.isMacOS) '${directory.parent.path}/Frameworks/$filename',
      filename,
    ];
    for (final location in locations) {
      try {
        return DynamicLibrary.open(location);
      } on ArgumentError {
        continue;
      }
    }
    throw CubismCoreUnavailable(
      Platform.operatingSystem,
      List.unmodifiable(locations),
    );
  }
}
