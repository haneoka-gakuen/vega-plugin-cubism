#define MA_NO_DEVICE_IO
#define MA_NO_ENGINE
#define MA_NO_RESOURCE_MANAGER
#define MA_NO_THREADING
#define MINIAUDIO_IMPLEMENTATION
#include "miniaudio.h"
#include <stdlib.h>
#include <stdint.h>

struct MotionSyncPcm { float* samples; uint64_t frames; uint32_t sample_rate; };
struct MotionSyncPcm* motion_sync_pcm_decode_impl(const unsigned char* bytes, size_t length) {
    if (!bytes || !length) return NULL;
    ma_decoder decoder;
    ma_decoder_config config = ma_decoder_config_init(ma_format_f32, 1, 48000);
    if (ma_decoder_init_memory(bytes, length, &config, &decoder) != MA_SUCCESS) return NULL;
    uint64_t capacity = 32768, used = 0;
    float* samples = (float*)malloc((size_t)capacity * sizeof(float));
    if (!samples) { ma_decoder_uninit(&decoder); return NULL; }
    while (1) {
        if (capacity - used < 16384) {
            if (capacity > SIZE_MAX / (2 * sizeof(float))) { free(samples); ma_decoder_uninit(&decoder); return NULL; }
            capacity *= 2;
            float* next = (float*)realloc(samples, (size_t)capacity * sizeof(float));
            if (!next) { free(samples); ma_decoder_uninit(&decoder); return NULL; }
            samples = next;
        }
        ma_uint64 frames = 0;
        ma_result status = ma_decoder_read_pcm_frames(&decoder, samples + used, 16384, &frames);
        used += frames;
        if (status == MA_AT_END || !frames) break;
        if (status != MA_SUCCESS) { free(samples); ma_decoder_uninit(&decoder); return NULL; }
    }
    ma_decoder_uninit(&decoder);
    if (!used) { free(samples); return NULL; }
    struct MotionSyncPcm* result = (struct MotionSyncPcm*)malloc(sizeof(struct MotionSyncPcm));
    if (!result) { free(samples); return NULL; }
    float* shrunk = (float*)realloc(samples, (size_t)used * sizeof(float));
    result->samples = shrunk ? shrunk : samples; result->frames = used; result->sample_rate = 48000;
    return result;
}
void motion_sync_pcm_free_impl(struct MotionSyncPcm* pcm) {
    if (!pcm) return;
    free(pcm->samples); free(pcm);
}
