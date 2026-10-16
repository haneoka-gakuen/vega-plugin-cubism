Pod::Spec.new do |s|
  s.name = 'vega_plugin_cubism'
  s.version = '0.1.0'
  s.summary = 'Cubism Core FFI provider.'
  s.description = s.summary
  s.homepage = 'https://github.com/haneoka-gakuen/vega-plugin-cubism'
  s.license = { :file => '../LICENSE' }
  s.author = 'Vega contributors'
  s.source = { :path => '.' }
  s.platform = :ios, '13.0'
  s.dependency 'Flutter'
  s.static_framework = true
  core = '.local/cubism_core/Live2DCubismCore.xcframework'
  if File.directory?(File.expand_path(core, __dir__))
    s.vendored_frameworks = core
    s.user_target_xcconfig = { 'OTHER_LDFLAGS' => '$(inherited) -Wl,-u,_csmGetVersion -Wl,-u,_csmGetLatestMocVersion -Wl,-u,_csmGetMocVersion -Wl,-u,_csmHasMocConsistency -Wl,-u,_csmReviveMocInPlace -Wl,-u,_csmGetSizeofModel -Wl,-u,_csmInitializeModelInPlace -Wl,-u,_csmUpdateModel -Wl,-u,_csmResetDrawableDynamicFlags -Wl,-u,_csmGetParameterCount -Wl,-u,_csmGetParameterIds -Wl,-u,_csmGetParameterValues -Wl,-u,_csmGetParameterMinimumValues -Wl,-u,_csmGetParameterMaximumValues -Wl,-u,_csmGetParameterDefaultValues -Wl,-u,_csmReadCanvasInfo -Wl,-u,_csmGetPartCount -Wl,-u,_csmGetPartIds -Wl,-u,_csmGetPartOpacities -Wl,-u,_csmGetDrawableCount -Wl,-u,_csmGetDrawableIds -Wl,-u,_csmGetDrawableTextureIndices -Wl,-u,_csmGetRenderOrders -Wl,-u,_csmGetOffscreenCount -Wl,-u,_csmGetDrawableBlendModes -Wl,-u,_csmGetDrawableOpacities -Wl,-u,_csmGetDrawableVertexCounts -Wl,-u,_csmGetDrawableIndexCounts -Wl,-u,_csmGetDrawableMaskCounts -Wl,-u,_csmGetDrawableVertexPositions -Wl,-u,_csmGetDrawableVertexUvs -Wl,-u,_csmGetDrawableIndices -Wl,-u,_csmGetDrawableMasks -Wl,-u,_csmGetDrawableConstantFlags -Wl,-u,_csmGetDrawableDynamicFlags -Wl,-u,_csmGetDrawableMultiplyColors -Wl,-u,_csmGetDrawableScreenColors' }
  end
end
