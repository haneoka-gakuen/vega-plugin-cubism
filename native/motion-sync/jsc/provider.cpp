#include <JavaScriptCore/JavaScript.h>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>
#include "adapter.inc"
#define API extern "C" __attribute__((visibility("default")))

static thread_local std::string last_error;
struct Engine { JSGlobalContextRef context; JSObjectRef provider; uint32_t version; };
static std::string text(JSContextRef ctx, JSValueRef value) {
    JSStringRef string = JSValueToStringCopy(ctx, value, nullptr);
    if (!string) return "motion_sync_js_error";
    std::vector<char> bytes(JSStringGetMaximumUTF8CStringSize(string));
    JSStringGetUTF8CString(string, bytes.data(), bytes.size()); JSStringRelease(string);
    return std::string(bytes.data());
}
static JSValueRef evaluate(Engine* engine, const char* bytes, size_t length) {
    std::string source(bytes, length); JSStringRef script = JSStringCreateWithUTF8CString(source.c_str());
    JSValueRef exception = nullptr, result = JSEvaluateScript(engine->context, script, nullptr, nullptr, 1, &exception);
    JSStringRelease(script); if (exception) {last_error = text(engine->context, exception); return nullptr;} return result;
}
static JSValueRef call(Engine* engine, const char* name, size_t count = 0, const JSValueRef* args = nullptr) {
    JSStringRef key = JSStringCreateWithUTF8CString(name); JSValueRef exception = nullptr;
    JSValueRef property = JSObjectGetProperty(engine->context, engine->provider, key, &exception); JSStringRelease(key);
    if (exception) {last_error = text(engine->context, exception); return nullptr;}
    JSObjectRef fn = JSValueToObject(engine->context, property, &exception);
    if (exception) {last_error = text(engine->context, exception); return nullptr;}
    JSValueRef result = JSObjectCallAsFunction(engine->context, fn, engine->provider, count, args, &exception);
    if (exception) {last_error = text(engine->context, exception); return nullptr;} return result;
}
API const char* csm_ms_last_error() {return last_error.c_str();}
API Engine* csm_ms_create(const unsigned char* source, size_t length) {
    if (!source || !length) {last_error = "motion_sync_source";return nullptr;}
    Engine* engine = new Engine{JSGlobalContextCreate(nullptr), nullptr, 0};
    const char* console = "var console={log:function(){},warn:function(){}};";
    if (!evaluate(engine, console, strlen(console)) || !evaluate(engine, (const char*)source, length) || !evaluate(engine, kAdapter, strlen(kAdapter))) {
        JSGlobalContextRelease(engine->context);delete engine;return nullptr;
    }
    JSStringRef key = JSStringCreateWithUTF8CString("MotionSyncProvider"); JSValueRef exception = nullptr;
    engine->provider = JSValueToObject(engine->context, JSObjectGetProperty(engine->context, JSContextGetGlobalObject(engine->context),key,&exception),&exception);
    JSStringRelease(key); if (exception) {last_error = text(engine->context,exception);JSGlobalContextRelease(engine->context);delete engine;return nullptr;}
    JSValueProtect(engine->context, engine->provider); JSValueRef version = call(engine,"start");
    if (!version) {JSValueUnprotect(engine->context,engine->provider);JSGlobalContextRelease(engine->context);delete engine;return nullptr;}
    engine->version = (uint32_t)JSValueToNumber(engine->context,version,nullptr);return engine;
}
API uint32_t csm_ms_engine_version(const Engine* engine) {return engine ? engine->version : 0;}
API uint64_t csm_ms_memory_bytes(const Engine*) {return 0;} // JSC public C API does not expose allocator usage.
API uint32_t csm_ms_context_create(Engine* engine, const unsigned char* json, size_t length, uint32_t rate) {
    if (!engine || !json || !rate) {last_error="motion_sync_config";return 0;}
    std::string source((const char*)json,length);JSStringRef string=JSStringCreateWithUTF8CString(source.c_str());
    JSValueRef args[]={JSValueMakeString(engine->context,string),JSValueMakeNumber(engine->context,rate)};JSStringRelease(string);
    JSValueRef result=call(engine,"create",2,args);return result ? (uint32_t)JSValueToNumber(engine->context,result,nullptr) : 0;
}
static uint32_t number(Engine* engine, const char* name, uint32_t id) {
    if (!engine) return 0;JSValueRef arg=JSValueMakeNumber(engine->context,id),result=call(engine,name,1,&arg);
    return result ? (uint32_t)JSValueToNumber(engine->context,result,nullptr) : 0;
}
API uint32_t csm_ms_context_require_samples(Engine* engine, uint32_t id) {return number(engine,"required",id);}
API uint32_t csm_ms_context_values_count(Engine* engine, uint32_t id) {return number(engine,"values",id);}
API int32_t csm_ms_context_clear(Engine* engine,uint32_t id,const double* initial,size_t count) {
    if (!engine || !initial) return -1;JSValueRef exception=nullptr;
    JSObjectRef values=JSObjectMakeTypedArray(engine->context,kJSTypedArrayTypeFloat64Array,count,&exception);
    if (exception) {last_error=text(engine->context,exception);return -1;}
    void* data=JSObjectGetTypedArrayBytesPtr(engine->context,values,&exception);
    if (exception) {last_error=text(engine->context,exception);return -1;}memcpy(data,initial,count*sizeof(double));
    JSValueRef args[]={JSValueMakeNumber(engine->context,id),values};return call(engine,"clear",2,args) ? 0 : -1;
}
API int32_t csm_ms_context_analyze(Engine* engine,uint32_t id,const float* samples,size_t count,double* output,size_t capacity,uint32_t* processed) {
    if (!engine || !samples || !output || !processed) return -1;JSValueRef exception=nullptr;
    JSObjectRef input=JSObjectMakeTypedArray(engine->context,kJSTypedArrayTypeFloat32Array,count,&exception);
    if (exception) {last_error=text(engine->context,exception);return -1;}
    void* bytes=JSObjectGetTypedArrayBytesPtr(engine->context,input,&exception);
    if (exception) {last_error=text(engine->context,exception);return -1;}memcpy(bytes,samples,count*sizeof(float));
    JSValueRef args[]={JSValueMakeNumber(engine->context,id),input};JSValueRef value=call(engine,"analyze",2,args);
    if (!value) return -1;JSObjectRef result=JSValueToObject(engine->context,value,&exception);
    JSStringRef key=JSStringCreateWithUTF8CString("length");
    size_t length=(size_t)JSValueToNumber(engine->context,JSObjectGetProperty(engine->context,result,key,&exception),&exception);JSStringRelease(key);
    if (exception || !length || length-1>capacity) {last_error="motion_sync_output_capacity";return -1;}
    *processed=(uint32_t)JSValueToNumber(engine->context,JSObjectGetPropertyAtIndex(engine->context,result,0,&exception),&exception);
    for (size_t i=1;i<length;i++) output[i-1]=JSValueToNumber(engine->context,JSObjectGetPropertyAtIndex(engine->context,result,(unsigned)i,&exception),&exception);
    if (exception) {last_error=text(engine->context,exception);return -1;}return (int32_t)(length-1);
}
API int32_t csm_ms_context_delete(Engine* engine,uint32_t id) {
    if (!engine) return -1;JSValueRef arg=JSValueMakeNumber(engine->context,id);return call(engine,"destroy",1,&arg) ? 0 : -1;
}
API void csm_ms_destroy(Engine* engine) {
    if (!engine) return;call(engine,"release");JSValueUnprotect(engine->context,engine->provider);JSGlobalContextRelease(engine->context);delete engine;
}
extern "C" {
struct MotionSyncPcm {float* samples; uint64_t frames; uint32_t sample_rate;};
MotionSyncPcm* motion_sync_pcm_decode_impl(const unsigned char*,size_t);
void motion_sync_pcm_free_impl(MotionSyncPcm*);
}
API MotionSyncPcm* csm_ms_pcm_decode(const unsigned char* bytes,size_t length) {
    auto* pcm=motion_sync_pcm_decode_impl(bytes,length);if(!pcm) last_error="motion_sync_audio_decode";return pcm;
}
API uint64_t csm_ms_pcm_frames(const MotionSyncPcm* pcm) {return pcm ? pcm->frames : 0;}
API uint32_t csm_ms_pcm_sample_rate(const MotionSyncPcm* pcm) {return pcm ? pcm->sample_rate : 0;}
API const float* csm_ms_pcm_samples(const MotionSyncPcm* pcm) {return pcm ? pcm->samples : nullptr;}
API void csm_ms_pcm_free(MotionSyncPcm* pcm) {motion_sync_pcm_free_impl(pcm);}
