#if defined(_WIN32) && !defined(_WIN64)
#define CSM_MOTIONSYNC_ENGINE_WIN32_DLL 1
#endif
#include "Live2DCubismMotionSyncEngine.h"
#define JSMN_STRICT
#define JSMN_STATIC
#include "../vendor/jsmn.h"
#include <cmath>
#include <cstdint>
#include <cstring>
#include <limits>
#include <locale>
#include <memory>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

#if defined(_WIN32)
#define API extern "C" __declspec(dllexport)
#else
#define API extern "C" __attribute__((visibility("default")))
#endif

namespace {
thread_local std::string last_error;
std::mutex core_mutex;
size_t engine_owners = 0;

// These two layouts are the official CRI configuration ABI.
struct ContextConfig { int32_t sample_rate; int32_t bit_depth; };
struct AnalysisConfig { float blend_ratio; int32_t smoothing; float emphasis; };
static_assert(sizeof(ContextConfig) == 8 && sizeof(AnalysisConfig) == 12);
static_assert(sizeof(csmMotionSync_MappingInfo) == (sizeof(void*) == 8 ? 40 : 24));
static_assert(sizeof(csmMotionSync_AnalysisResult) == (sizeof(void*) == 8 ? 16 : 12));

class Json {
 public:
  Json(const unsigned char* bytes, size_t length) : source_((const char*)bytes, length) {
    if (!length || length > 1024 * 1024) throw std::runtime_error("motion_sync_config_size");
    tokens_.resize(256);
    int count;
    do {
      jsmn_parser parser;
      jsmn_init(&parser);
      count = jsmn_parse(&parser, source_.data(), source_.size(), tokens_.data(), (unsigned)tokens_.size());
      if (count == JSMN_ERROR_NOMEM) {
        if (tokens_.size() >= 65536) throw std::runtime_error("motion_sync_config_size");
        tokens_.resize(tokens_.size() * 2);
      }
    } while (count == JSMN_ERROR_NOMEM);
    if (count < 1) throw std::runtime_error("motion_sync_config_json");
    tokens_.resize((size_t)count);
    if (tokens_[0].type != JSMN_OBJECT || next(0) != tokens_.size()) throw std::runtime_error("motion_sync_config_json");
  }
  size_t next(size_t i) const {
    const int end = tokens_.at(i).end;
    for (++i; i < tokens_.size() && tokens_[i].start < end; ++i) {}
    return i;
  }
  size_t field(size_t object, const char* name, bool optional = false) const {
    if (tokens_.at(object).type != JSMN_OBJECT) throw std::runtime_error("motion_sync_config_object");
    for (size_t i = object + 1; i < next(object);) {
      const size_t value = i + 1;
      if (string(i) == name) return value;
      i = next(value);
    }
    if (optional) return tokens_.size();
    throw std::runtime_error(std::string("motion_sync_config_field:") + name);
  }
  std::vector<size_t> array(size_t index) const {
    if (tokens_.at(index).type != JSMN_ARRAY) throw std::runtime_error("motion_sync_config_array");
    std::vector<size_t> result;
    for (size_t i = index + 1; i < next(index); i = next(i)) result.push_back(i);
    return result;
  }
  bool missing(size_t index) const { return index == tokens_.size(); }
  bool disabled(size_t index) const { return !missing(index) && raw(index) == "false"; }
  double number(size_t index) const {
    if (tokens_.at(index).type != JSMN_PRIMITIVE) throw std::runtime_error("motion_sync_config_number");
    std::istringstream stream(raw(index));
    stream.imbue(std::locale::classic());
    double value;
    if (!(stream >> value) || stream.peek() != std::char_traits<char>::eof() || !std::isfinite(value)) throw std::runtime_error("motion_sync_config_number");
    return value;
  }
  std::string string(size_t index) const {
    if (tokens_.at(index).type != JSMN_STRING) throw std::runtime_error("motion_sync_config_string");
    const std::string input = raw(index);
    std::string result;
    for (size_t i = 0; i < input.size(); ++i) {
      if (input[i] != '\\') { result += input[i]; continue; }
      if (++i >= input.size()) throw std::runtime_error("motion_sync_config_escape");
      switch (input[i]) {
        case '"': case '\\': case '/': result += input[i]; break;
        case 'b': result += '\b'; break;
        case 'f': result += '\f'; break;
        case 'n': result += '\n'; break;
        case 'r': result += '\r'; break;
        case 't': result += '\t'; break;
        case 'u': {
          uint32_t code = hex(input, i);
          if (code >= 0xd800 && code <= 0xdbff) {
            if (i + 2 >= input.size() || input[++i] != '\\' || input[++i] != 'u') throw std::runtime_error("motion_sync_config_unicode");
            const uint32_t low = hex(input, i);
            if (low < 0xdc00 || low > 0xdfff) throw std::runtime_error("motion_sync_config_unicode");
            code = 0x10000 + ((code - 0xd800) << 10) + low - 0xdc00;
          } else if (code >= 0xdc00 && code <= 0xdfff) throw std::runtime_error("motion_sync_config_unicode");
          if (code == 0) throw std::runtime_error("motion_sync_config_id");
          if (code < 0x80) result += (char)code;
          else if (code < 0x800) { result += (char)(0xc0 | (code >> 6)); result += (char)(0x80 | (code & 63)); }
          else if (code < 0x10000) { result += (char)(0xe0 | (code >> 12)); result += (char)(0x80 | ((code >> 6) & 63)); result += (char)(0x80 | (code & 63)); }
          else { result += (char)(0xf0 | (code >> 18)); result += (char)(0x80 | ((code >> 12) & 63)); result += (char)(0x80 | ((code >> 6) & 63)); result += (char)(0x80 | (code & 63)); }
          break;
        }
        default: throw std::runtime_error("motion_sync_config_escape");
      }
    }
    return result;
  }
 private:
  static uint32_t hex(const std::string& value, size_t& i) {
    uint32_t result = 0;
    for (int n = 0; n < 4; ++n) {
      if (++i >= value.size()) throw std::runtime_error("motion_sync_config_unicode");
      const char c = value[i];
      const int digit = c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1;
      if (digit < 0) throw std::runtime_error("motion_sync_config_unicode");
      result = (result << 4) | (uint32_t)digit;
    }
    return result;
  }
  std::string raw(size_t index) const {
    const auto& token = tokens_.at(index);
    return source_.substr((size_t)token.start, (size_t)(token.end - token.start));
  }
  std::string source_;
  std::vector<jsmntok_t> tokens_;
};

struct Mapping {
  std::string audio_id;
  std::vector<float> values;
  float scale;
  unsigned enabled;
};
struct Context {
  csmMotionSync_Context core = nullptr;
  std::vector<std::string> ids;
  std::vector<const char*> id_pointers;
  std::vector<Mapping> mappings;
  std::vector<csmMotionSync_MappingInfo> core_mappings;
  std::vector<float> raw;
  std::vector<double> smooth, damper, last, damped, output;
  AnalysisConfig analysis{};
  unsigned required = 0;
  ~Context() { if (core) csmMotionSync_DeleteContext(core); }
};
struct Engine {
  uint32_t next = 1;
  std::unordered_map<uint32_t, std::unique_ptr<Context>> contexts;
};
Context& context(Engine* engine, uint32_t id) {
  if (!engine) throw std::runtime_error("motion_sync_engine");
  const auto found = engine->contexts.find(id);
  if (found == engine->contexts.end()) throw std::runtime_error("motion_sync_context_missing");
  return *found->second;
}
void clear(Context& state, const double* initial, size_t count) {
  if (!initial || count != state.ids.size()) throw std::runtime_error("motion_sync_initial_values");
  csmMotionSync_ClearContext(state.core);
  state.last.assign(initial, initial + count);
  state.damped = state.last;
  state.output.clear();
}
}

API const char* csm_ms_last_error() { return last_error.c_str(); }
// The existing FFI protocol passes Web Core bytes. Native code is supplied by
// the separately provisioned, pinned official DSP; this backend never runs JS.
API Engine* csm_ms_create(const unsigned char*, size_t) {
  std::lock_guard<std::mutex> lock(core_mutex);
  try {
    if (csmMotionSync_GetEngineVersion() != 0x05000004) throw std::runtime_error("motion_sync_native_version");
    auto engine = std::make_unique<Engine>();
    if (!engine_owners && csmMotionSync_InitializeEngine(nullptr) != csmMotionSyncTrue) throw std::runtime_error("motion_sync_initialize");
    ++engine_owners;
    return engine.release();
  } catch (const std::exception& error) { last_error = error.what(); return nullptr; }
}
API uint32_t csm_ms_engine_version(const Engine* engine) { return engine ? csmMotionSync_GetEngineVersion() : 0; }
API uint64_t csm_ms_memory_bytes(const Engine*) { return 0; }
API uint32_t csm_ms_context_create(Engine* engine, const unsigned char* bytes, size_t length, uint32_t rate) {
  std::lock_guard<std::mutex> lock(core_mutex);
  try {
    if (!engine || !bytes || !rate || rate > INT32_MAX) throw std::runtime_error("motion_sync_config");
    Json json(bytes, length);
    auto state = std::make_unique<Context>();
    const auto parameters = json.array(json.field(0, "parameters"));
    const auto audios = json.array(json.field(0, "audioParameters"));
    const auto mappings = json.array(json.field(0, "mappings"));
    if (parameters.empty() || parameters.size() > 4096 || audios.empty() || audios.size() > 4096) throw std::runtime_error("motion_sync_mapping");
    for (const auto parameter : parameters) {
      state->ids.push_back(json.string(json.field(parameter, "id")));
      state->smooth.push_back(json.number(json.field(parameter, "smooth")));
      state->damper.push_back(json.number(json.field(parameter, "damper")));
    }
    for (const auto& id : state->ids) state->id_pointers.push_back(id.c_str());
    state->mappings.reserve(audios.size());
    for (const auto audio : audios) {
      Mapping mapping;
      mapping.audio_id = json.string(json.field(audio, "id"));
      mapping.scale = (float)json.number(json.field(audio, "scale"));
      mapping.enabled = json.disabled(json.field(audio, "enabled", true)) ? 0 : 1;
      mapping.values.assign(parameters.size(), 0);
      for (const auto candidate : mappings) {
        if (json.string(json.field(candidate, "audioParameterId")) != mapping.audio_id) continue;
        const auto targets = json.array(json.field(candidate, "targets"));
        for (size_t i = 0; i < state->ids.size(); ++i) {
          for (const auto target : targets) {
            if (json.string(json.field(target, "id")) == state->ids[i]) {
              mapping.values[i] = (float)json.number(json.field(target, "value"));
              break;
            }
          }
        }
        break;
      }
      state->mappings.push_back(std::move(mapping));
    }
    for (const auto& mapping : state->mappings) state->core_mappings.push_back({mapping.audio_id.c_str(), state->id_pointers.data(), const_cast<float*>(mapping.values.data()), (unsigned)state->ids.size(), mapping.scale, mapping.enabled});
    const auto post = json.field(0, "postProcessing");
    const double smoothing = json.number(json.field(post, "smoothing"));
    if (smoothing < INT32_MIN || smoothing > INT32_MAX || smoothing != std::trunc(smoothing)) throw std::runtime_error("motion_sync_smoothing");
    state->analysis = {(float)json.number(json.field(post, "blendRatio")), (int32_t)smoothing, (float)json.number(json.field(0, "emphasisLevel"))};
    const ContextConfig config{(int32_t)rate, 32};
    state->core = csmMotionSync_CreateContext(&config, state->core_mappings.data(), (int)state->core_mappings.size());
    if (!state->core) throw std::runtime_error("motion_sync_context");
    state->required = csmMotionSync_GetRequireSampleCount(state->core);
    if (!state->required) throw std::runtime_error("motion_sync_context");
    state->raw.resize(parameters.size());
    std::vector<double> initial(parameters.size(), 0);
    const auto initial_index = json.field(0, "initialValues", true);
    if (!json.missing(initial_index)) {
      const auto values = json.array(initial_index);
      if (values.size() != initial.size()) throw std::runtime_error("motion_sync_initial_values");
      for (size_t i = 0; i < values.size(); ++i) initial[i] = json.number(values[i]);
    }
    clear(*state, initial.data(), initial.size());
    if (!engine->next) throw std::runtime_error("motion_sync_context_limit");
    const uint32_t id = engine->next++;
    engine->contexts.emplace(id, std::move(state));
    return id;
  } catch (const std::exception& error) { last_error = error.what(); return 0; }
}
API uint32_t csm_ms_context_require_samples(Engine* engine, uint32_t id) {
  std::lock_guard<std::mutex> lock(core_mutex);
  try { return context(engine, id).required; } catch (const std::exception& error) { last_error = error.what(); return 0; }
}
API uint32_t csm_ms_context_values_count(Engine* engine, uint32_t id) {
  std::lock_guard<std::mutex> lock(core_mutex);
  try { return (uint32_t)context(engine, id).ids.size(); } catch (const std::exception& error) { last_error = error.what(); return 0; }
}
API int32_t csm_ms_context_clear(Engine* engine, uint32_t id, const double* initial, size_t count) {
  std::lock_guard<std::mutex> lock(core_mutex);
  try { clear(context(engine, id), initial, count); return 0; } catch (const std::exception& error) { last_error = error.what(); return -1; }
}
API int32_t csm_ms_context_analyze(Engine* engine, uint32_t id, const float* samples, size_t count, double* output, size_t capacity, uint32_t* processed) {
  std::lock_guard<std::mutex> lock(core_mutex);
  try {
    auto& state = context(engine, id);
    if (!samples || !output || !processed || capacity < state.ids.size() || count > UINT32_MAX) throw std::runtime_error("motion_sync_output_capacity");
    uint32_t total = 0;
    while (count - total >= state.required) {
      csmMotionSync_AnalysisResult result{state.raw.data(), (int)state.raw.size(), 0};
      if (csmMotionSync_Analyze(state.core, samples + total, (unsigned)(count - total), &result, &state.analysis) != csmMotionSyncTrue) break;
      if (!result.ProcessedSampleCount || result.ProcessedSampleCount > count - total) throw std::runtime_error("motion_sync_processed_count");
      total += result.ProcessedSampleCount;
      state.output.resize(state.raw.size());
      for (size_t i = 0; i < state.output.size(); ++i) {
        double value = ((100 - state.smooth[i]) * state.raw[i] + state.last[i] * state.smooth[i]) / 100;
        state.last[i] = value;
        if (std::abs(value - state.damped[i]) < state.damper[i]) value = state.damped[i];
        state.damped[i] = value;
        state.output[i] = value;
      }
    }
    *processed = total;
    for (size_t i = 0; i < state.output.size(); ++i) output[i] = state.output[i];
    return (int32_t)state.output.size();
  } catch (const std::exception& error) { last_error = error.what(); return -1; }
}
API int32_t csm_ms_context_delete(Engine* engine, uint32_t id) {
  std::lock_guard<std::mutex> lock(core_mutex);
  if (!engine || !engine->contexts.erase(id)) { last_error = "motion_sync_context_missing"; return -1; }
  return 0;
}
API void csm_ms_destroy(Engine* engine) {
  if (!engine) return;
  std::lock_guard<std::mutex> lock(core_mutex);
  delete engine;
  if (!--engine_owners) csmMotionSync_DisposeEngine();
}

extern "C" {
struct MotionSyncPcm { float* samples; uint64_t frames; uint32_t sample_rate; };
MotionSyncPcm* motion_sync_pcm_decode_impl(const unsigned char*, size_t);
void motion_sync_pcm_free_impl(MotionSyncPcm*);
}
API MotionSyncPcm* csm_ms_pcm_decode(const unsigned char* bytes, size_t length) {
  auto* pcm = motion_sync_pcm_decode_impl(bytes, length);
  if (!pcm) last_error = "motion_sync_audio_decode";
  return pcm;
}
API uint64_t csm_ms_pcm_frames(const MotionSyncPcm* pcm) { return pcm ? pcm->frames : 0; }
API uint32_t csm_ms_pcm_sample_rate(const MotionSyncPcm* pcm) { return pcm ? pcm->sample_rate : 0; }
API const float* csm_ms_pcm_samples(const MotionSyncPcm* pcm) { return pcm ? pcm->samples : nullptr; }
API void csm_ms_pcm_free(MotionSyncPcm* pcm) { motion_sync_pcm_free_impl(pcm); }
