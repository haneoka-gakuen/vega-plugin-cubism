import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:archive/archive.dart';
import 'package:crypto/crypto.dart';
import 'package:hooks/hooks.dart';

Future<bool> _matches(File file, Map entry) async =>
    await file.exists() &&
    await file.length() == entry['bytes'] &&
    (await sha256.bind(file.openRead()).first).toString() == entry['sha256'];

Future<Uint8List> _archive(Map sdk, File cache) async {
  if (await cache.exists()) {
    final bytes = await cache.readAsBytes();
    if (sha256.convert(bytes).toString() == sdk['archiveSha256']) return bytes;
  }
  Object? failure;
  for (var attempt = 0; attempt < 3; ++attempt) {
    final client = HttpClient()
      ..connectionTimeout = const Duration(seconds: 30)
      ..findProxy = HttpClient.findProxyFromEnvironment;
    try {
      final request = await client.getUrl(Uri.parse(sdk['url'] as String));
      final response = await request.close().timeout(
        const Duration(seconds: 60),
      );
      if (response.statusCode != HttpStatus.ok) {
        throw HttpException('motion_sync_sdk_http:${response.statusCode}');
      }
      final bytes = BytesBuilder(copy: false);
      await for (final chunk in response.timeout(const Duration(seconds: 30))) {
        bytes.add(chunk);
        if (bytes.length > 32 * 1024 * 1024) {
          throw const FormatException('motion_sync_sdk_archive_size');
        }
      }
      final result = bytes.takeBytes();
      if (sha256.convert(result).toString() != sdk['archiveSha256']) {
        throw const FormatException('motion_sync_sdk_archive_identity');
      }
      final temporary = File('${cache.path}.part-$pid');
      await temporary.writeAsBytes(result, flush: true);
      await temporary.rename(cache.path);
      return result;
    } on FormatException {
      rethrow;
    } on IOException catch (error) {
      failure = error;
    } on TimeoutException catch (error) {
      failure = error;
    } finally {
      client.close(force: true);
    }
    if (attempt < 2) await Future<void>.delayed(Duration(seconds: attempt + 1));
  }
  throw StateError('motion_sync_sdk_download:$failure');
}

/// Pure Dart, immutable SDK provisioning. The shared hook output is outside the
/// package checkout; one file lock covers concurrent target hooks for this SDK.
Future<Directory> motionSyncSdk(
  BuildInput input,
  Map specification,
  List<Map> selected,
  String target,
) async {
  final manual = Directory.fromUri(
    input.packageRoot.resolve('.local/motion_sync/$target/'),
  );
  if (await manual.exists()) {
    for (final entry in selected) {
      if (!await _matches(File('${manual.path}/${entry['name']}'), entry)) {
        throw StateError(
          'motion_sync_sdk_identity:${entry['target']}/${entry['name']}',
        );
      }
    }
    return manual;
  }
  final legacy = selected.first['sdk'] == 'legacy';
  final sdk = legacy ? specification['legacySdk'] as Map : specification;
  final version = legacy ? '5-r.1' : '5-r.2';
  final root = Directory.fromUri(
    input.outputDirectoryShared.resolve('motion_sync_sdk/$version/'),
  );
  await root.create(recursive: true);
  final lock = await File('${root.path}/provision.lock')
      .open(mode: FileMode.append);
  await lock.lock(FileLock.blockingExclusive);
  try {
    final directory = Directory('${root.path}/$target');
    var valid = true;
    for (final entry in selected) {
      if (!await _matches(File('${directory.path}/${entry['name']}'), entry)) {
        valid = false;
        break;
      }
    }
    if (valid) return directory;
    final bytes = await _archive(sdk, File('${root.path}/official.zip'));
    final archive = ZipDecoder().decodeBytes(bytes);
    final verified = <(Map, Uint8List)>[];
    for (final entry in selected) {
      final source =
          'CubismSdkMotionSyncPluginForNative-$version/${entry['source']}';
      final file = archive.find(source);
      if (file == null || !file.isFile || file.isSymbolicLink) {
        throw StateError('motion_sync_sdk_entry:$source');
      }
      final content = file.readBytes();
      if (content == null ||
          content.length != entry['bytes'] ||
          sha256.convert(content).toString() != entry['sha256']) {
        throw StateError('motion_sync_sdk_entry_identity:$source');
      }
      verified.add((entry, content));
    }
    await directory.create(recursive: true);
    for (final (entry, content) in verified) {
      final output = File('${directory.path}/${entry['name']}');
      final temporary = File('${output.path}.part-$pid');
      await temporary.writeAsBytes(content, flush: true);
      await temporary.rename(output.path);
    }
    return directory;
  } finally {
    try {
      await lock.unlock();
    } finally {
      await lock.close();
    }
  }
}
