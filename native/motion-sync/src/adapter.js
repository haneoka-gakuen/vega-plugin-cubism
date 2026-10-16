var console = {log: function(){}, warn: function(){}};
var MotionSyncProvider = (function () {
  var core, states = new Map(), next = 1;
  function start() {
    core = Live2DCubismMotionSyncCore;
    if (core.CubismMotionSyncEngine.csmMotionSyncInitializeEngine(0) !== core.csmMotionSyncTrue) throw Error('motion_sync_initialize');
    return core.CubismMotionSyncEngine.csmMotionSyncGetEngineVersion();
  }
  function create(json, rate) {
    var setting = JSON.parse(json), ids = setting.parameters.map(function(p){return p.id;});
    if (!ids.length || !setting.audioParameters.length) throw Error('motion_sync_mapping');
    var ptr = core.ToPointer, state = {ids: ids, setting: setting, owned: [], samples: 0, capacity: 0, output: [], last: [], damped: []};
    function alloc(n) {var p = ptr.Malloc(n); if (!p) throw Error('motion_sync_malloc'); state.owned.push(p); return p;}
    var config = alloc(8); ptr.ConvertContextConfigCriToInt32Array(new Int32Array(2), config, rate, 32);
    var list = alloc(24 * setting.audioParameters.length);
    setting.audioParameters.forEach(function(audio, index) {
      var mapping = setting.mappings.find(function(m){return m.audioParameterId === audio.id;});
      var values = ids.map(function(id){var target = mapping && mapping.targets.find(function(t){return t.id === id;}); return target ? target.value : 0;});
      var p = alloc(24), native = ptr.ConvertMappingInfoCriToFloat32Array(new Float32Array(6), p, audio.id, ids, values, ids.length, audio.scale, audio.enabled === false ? 0 : 1);
      state.owned.push(native[0], native[1], native[2]);
      for (var field = 0; field < 6; field++) {
        if (field === 4) ptr.AddValuePtrFloat(list + index * 24, field * 4, native[field]);
        else ptr.AddValuePtrInt32(list + index * 24, field * 4, native[field]);
      }
    });
    state.context = new core.Context(); state.context.csmMotionSyncCreate(config, list, setting.audioParameters.length);
    state.required = state.context.csmMotionSyncGetRequireSampleCount();
    if (state.required < 1) throw Error('motion_sync_context');
    state.analysis = alloc(12); var post = setting.postProcessing;
    ptr.AddValuePtrFloat(state.analysis, 0, post.blendRatio); ptr.AddValuePtrInt32(state.analysis, 4, post.smoothing);
    ptr.AddValuePtrFloat(state.analysis, 8, setting.emphasisLevel);
    state.result = alloc(12); state.resultInfo = ptr.ConvertAnalysisResultToInt32Array(new Int32Array(3), state.result, ids.length);
    state.owned.push(state.resultInfo[0]);
    state.heap = new Float32Array(state.resultInfo.buffer);
    var id = next++; states.set(id, state); clear(id, setting.initialValues || ids.map(function(){return 0;})); return id;
  }
  function get(id) {var state = states.get(id); if (!state) throw Error('motion_sync_context_missing'); return state;}
  function clear(id, initial) {
    var state = get(id); if (initial.length !== state.ids.length) throw Error('motion_sync_initial_values');
    state.context.csmMotionSyncClear(); state.last = Array.from(initial); state.damped = Array.from(initial); state.output = [];
  }
  function analyze(id, samples) {
    var state = get(id), ptr = core.ToPointer, total = 0;
    if (samples.length > state.capacity) {
      if (state.samples) ptr.Free(state.samples);
      state.capacity = Math.max(samples.length, state.required); state.samples = ptr.Malloc(state.capacity * 4);
      if (!state.samples) throw Error('motion_sync_sample_malloc');
    }
    while (samples.length - total >= state.required) {
      var count = samples.length - total;
      state.heap.set(samples.subarray(total), state.samples >>> 2);
      if (state.context.csmMotionSyncAnalyze(state.samples, count, state.result, state.analysis) !== core.csmMotionSyncTrue) break;
      var consumed = ptr.GetProcessedSampleCountFromAnalysisResult(state.result + 8);
      if (consumed <= 0 || consumed > count) throw Error('motion_sync_processed_count'); total += consumed;
      var raw = Array.from(state.heap.subarray(state.resultInfo[0] >>> 2, (state.resultInfo[0] >>> 2) + state.ids.length));
      state.output = raw.map(function(value, index) {
        var parameter = state.setting.parameters[index], smooth = parameter.smooth;
        value = ((100 - smooth) * value + state.last[index] * smooth) / 100; state.last[index] = value;
        if (Math.abs(value - state.damped[index]) < parameter.damper) value = state.damped[index];
        state.damped[index] = value; return value;
      });
    }
    return [total].concat(state.output);
  }
  function destroy(id) {
    var state = get(id); state.context.csmMotionSyncDelete();
    if (state.samples) core.ToPointer.Free(state.samples);
    state.owned.forEach(function(p){core.ToPointer.Free(p);}); states.delete(id);
  }
  function release() {Array.from(states.keys()).forEach(destroy); core.CubismMotionSyncEngine.csmMotionSyncDisposeEngine();}
  return {start: start, create: create, clear: clear, analyze: analyze, destroy: destroy, release: release,
    required: function(id){return get(id).required;}, values: function(id){return get(id).ids.length;}};
})();
