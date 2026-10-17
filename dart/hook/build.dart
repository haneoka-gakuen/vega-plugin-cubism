import 'dart:convert';
import 'dart:io';

import 'package:code_assets/code_assets.dart';
import 'package:hooks/hooks.dart';
import 'package:native_toolchain_c/native_toolchain_c.dart';

import 'motion_sync_sdk.dart';

const _asset = 'src/native_motion_sync_bindings.dart';
const _dsp = 'Live2DCubismMotionSyncEngine_CRI';

void main(List<String> arguments) async {
  await build(arguments, (input, output) async {
    if (!input.config.buildCodeAssets) return;
    final code = input.config.code;
    final os = code.targetOS;
    final arch = code.targetArchitecture;
    final unsupported =
        os == OS.linux || (os == OS.windows && arch == Architecture.arm64);
    if (unsupported) {
      // Linux keeps its existing JSC library. The official native SDK has no
      // Windows ARM64 DSP; callers observe unavailable capability there.
      output.assets.code.add(
        CodeAsset(
          package: input.packageName,
          name: _asset,
          linkMode: DynamicLoadingSystem(
            Uri.file(
              os == OS.windows
                  ? 'cubism_motion_sync.dll'
                  : 'libcubism_motion_sync.so',
            ),
          ),
        ),
      );
      return;
    }
    final target = switch (os) {
      OS.android =>
        'android/${switch (arch) {
          Architecture.arm64 => 'arm64-v8a',
          Architecture.arm => 'armeabi-v7a',
          Architecture.x64 => 'x86_64',
          Architecture.ia32 => 'x86',
          _ => throw UnsupportedError('motion_sync_android_arch:$arch'),
        }}',
      OS.windows => 'windows/${arch == Architecture.x64 ? 'x64' : 'x86'}',
      OS.macOS => 'macos',
      OS.iOS =>
        'ios/${code.iOS.targetSdk == IOSSdk.iPhoneOS ? 'device' : 'simulator'}',
      _ => throw UnsupportedError('motion_sync_platform:$os'),
    };
    final sdkFile = input.packageRoot.resolve(
      '../native/motion-sync/native/sdk.json',
    );
    final sdk = jsonDecode(await File.fromUri(sdkFile).readAsString()) as Map;
    final libraries = (sdk['libraries'] as List).cast<Map>();
    final selected = libraries
        .where((entry) => entry['target'] == target)
        .toList();
    if (selected.isEmpty) throw StateError('motion_sync_sdk_target:$target');
    final sdkDirectory = await motionSyncSdk(input, sdk, selected, target);
    final directory = sdkDirectory.uri;
    final dependencies = <Uri>[
      sdkFile,
      for (final entry in selected) directory.resolve(entry['name'] as String),
    ];
    // The decoder is C; keep its original source and C linkage unchanged.
    await CBuilder.library(
      name: 'cubism_motion_sync_pcm',
      linkModePreference: LinkModePreference.static,
      sources: const ['../native/motion-sync/src/decoder.c'],
      includes: const ['../native/motion-sync/vendor'],
    ).run(input: input, output: output);
    await CBuilder.library(
      name: 'cubism_motion_sync_native',
      assetName: _asset,
      language: Language.cpp,
      std: 'c++17',
      sources: const ['../native/motion-sync/native/provider.cpp'],
      includes: const [
        '../native/motion-sync/native',
        '../native/motion-sync/vendor',
      ],
      flags: [if (os == OS.windows) '/fp:strict' else '-ffp-contract=off'],
      cppLinkStdLib: os == OS.android ? 'c++_static' : null,
      libraries: ['cubism_motion_sync_pcm', _dsp],
      libraryDirectories: ['.', directory.toFilePath()],
    ).run(input: input, output: output);
    if (os != OS.iOS) {
      final name = os == OS.windows
          ? '$_dsp.dll'
          : os == OS.macOS
          ? 'lib$_dsp.dylib'
          : 'lib$_dsp.so';
      var bundled = directory.resolve(name);
      if (os == OS.macOS) {
        final architecture = switch (arch) {
          Architecture.x64 => 'x86_64',
          Architecture.arm64 => 'arm64',
          _ => throw UnsupportedError('motion_sync_macos_arch:$arch'),
        };
        final thin = input.outputDirectory.resolve(name);
        final result = await Process.run('xcrun', [
          'lipo',
          bundled.toFilePath(),
          '-thin',
          architecture,
          '-output',
          thin.toFilePath(),
        ]);
        if (result.exitCode != 0) {
          throw StateError('motion_sync_macos_thin:${result.stderr}');
        }
        bundled = thin;
      }
      output.assets.code.add(
        CodeAsset(
          package: input.packageName,
          name: 'motion_sync/$target/$name',
          linkMode: DynamicLoadingBundled(),
          file: bundled,
        ),
      );
    }
    output.dependencies.addAll(dependencies);
  });
}
