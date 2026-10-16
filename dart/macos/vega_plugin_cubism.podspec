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
  core = '.local/cubism_core/libLive2DCubismCore.dylib'
  s.vendored_libraries = core if File.exist?(File.expand_path(core, __dir__))
end
