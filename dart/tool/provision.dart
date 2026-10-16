import 'dart:convert';
import 'dart:io';

Future<void> main(List<String> arguments) async {
  if (arguments.contains('--help')) {
    stdout.writeln(
      'dart run tool/provision.dart --sdk <Cubism SDK directory> --platform <linux|windows|android|macos|ios|all>',
    );
    return;
  }
  String? sdk;
  var platform = Platform.operatingSystem;
  for (var index = 0; index < arguments.length; index++) {
    switch (arguments[index]) {
      case '--sdk':
        sdk = arguments[++index];
      case '--platform':
        platform = arguments[++index];
      default:
        throw ArgumentError('cubism_provision_argument:${arguments[index]}');
    }
  }
  sdk ??= Platform.environment['CUBISM_SDK_ROOT'];
  if (sdk == null || sdk.isEmpty) {
    throw ArgumentError('cubism_provision_sdk');
  }
  final package = File.fromUri(Platform.script).parent.parent;
  final root = Directory(sdk);
  final targets = <String, Map<String, String>>{
    'linux': {
      'x64/libLive2DCubismCore.so':
          'Core/dll/linux/x86_64/libLive2DCubismCore.so',
      'arm64/libLive2DCubismCore.so':
          'Core/dll/experimental/linux/arm64/libLive2DCubismCore.so',
    },
    'windows': {
      'x64/Live2DCubismCore.dll':
          'Core/dll/windows/x86_64/Live2DCubismCore.dll',
      'x86/Live2DCubismCore.dll': 'Core/dll/windows/x86/Live2DCubismCore.dll',
    },
    'macos': {
      'libLive2DCubismCore.dylib': 'Core/dll/macos/libLive2DCubismCore.dylib',
    },
    'android': {
      for (final abi in ['arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64'])
        '$abi/libLive2DCubismCore.so':
            'Core/dll/android/$abi/libLive2DCubismCore.so',
    },
    'ios': {
      'device/libLive2DCubismCore.a':
          'Core/lib/ios/Release-iphoneos/libLive2DCubismCore.a',
      'simulator-arm64/libLive2DCubismCore.a':
          'Core/lib/ios/Release-iphonesimulator-arm64/libLive2DCubismCore.a',
      'simulator-x64/libLive2DCubismCore.a':
          'Core/lib/ios/Release-iphonesimulator-x86_64/libLive2DCubismCore.a',
    },
  };
  final selected = platform == 'all'
      ? targets
      : {
          platform:
              targets[platform] ??
              (throw ArgumentError('cubism_provision_platform:$platform')),
        };
  final copied = <Map<String, Object?>>[];
  for (final target in selected.entries) {
    final local = target.key == 'ios' || target.key == 'macos'
        ? '${target.key}/.local/cubism_core'
        : '.local/cubism_core/${target.key}';
    for (final asset in target.value.entries) {
      final source = File('${root.path}/${asset.value}');
      if (!await source.exists()) continue;
      final output = File('${package.path}/$local/${asset.key}');
      await output.parent.create(recursive: true);
      await source.copy(output.path);
      copied.add({
        'platform': target.key,
        'path': output.path,
        'bytes': await output.length(),
      });
    }
  }
  if (copied.isEmpty) throw StateError('cubism_provision_no_library');
  if (selected.containsKey('ios') && Platform.isMacOS) {
    final ios = Directory('${package.path}/ios/.local/cubism_core');
    final simulator = '${ios.path}/libLive2DCubismCore-simulator.a';
    final lipo = await Process.run('xcrun', [
      'lipo',
      '-create',
      '${ios.path}/simulator-arm64/libLive2DCubismCore.a',
      '${ios.path}/simulator-x64/libLive2DCubismCore.a',
      '-output',
      simulator,
    ]);
    if (lipo.exitCode != 0)
      throw StateError('cubism_provision_lipo:${lipo.stderr}');
    final framework = Directory('${ios.path}/Live2DCubismCore.xcframework');
    if (await framework.exists()) await framework.delete(recursive: true);
    final build = await Process.run('xcodebuild', [
      '-create-xcframework',
      '-library',
      '${ios.path}/device/libLive2DCubismCore.a',
      '-library',
      simulator,
      '-output',
      framework.path,
    ]);
    if (build.exitCode != 0)
      throw StateError('cubism_provision_xcframework:${build.stderr}');
  }
  final manifest = File('${package.path}/.local/cubism_core/provision.json');
  await manifest.parent.create(recursive: true);
  await manifest.writeAsString(
    const JsonEncoder.withIndent('  ')
        .convert({'sdk': root.path, 'libraries': copied}),
  );
  stdout.writeln(
    jsonEncode({'copied': copied.length, 'manifest': manifest.path}),
  );
}
