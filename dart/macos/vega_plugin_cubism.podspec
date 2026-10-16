Pod::Spec.new do |s|
  s.name = 'vega_plugin_cubism'
  s.version = '0.1.0'
  s.summary = 'Cubism Core FFI provider.'
  s.description = s.summary
  s.homepage = 'https://github.com/haneoka-gakuen/vega-plugin-cubism'
  s.license = { :file => '../LICENSE' }
  s.author = 'Vega contributors'
  s.source = { :path => '.' }
  s.platform = :osx, '10.15'
  s.dependency 'FlutterMacOS'
  core = File.expand_path('../.local/cubism_core/macos/libLive2DCubismCore.dylib', __dir__)
  s.vendored_libraries = core if File.exist?(core)
end
