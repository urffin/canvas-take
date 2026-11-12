// Experimental C ABI, not a public CanvasTake API. Codec code is official libwebp.
#undef malloc
#undef calloc
#undef realloc
#undef free
#include <stdint.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <limits.h>
#include <malloc.h>
#include <emscripten.h>
#include "src/webp/encode.h"
#include "src/webp/mux.h"
#include "tracking.h"

// Only project codec translation units remap allocation calls to these functions.
// The system allocator and this translation unit retain their original libc calls.
typedef union {
  struct { size_t bytes; uint32_t magic; } value;
  max_align_t alignment;
} Allocation;
static size_t live_bytes, peak_bytes, live_allocations, allocation_calls;
static int fail_after = -1, cancelled;
static char error_text[256];
static int allow_allocation(void) {
  ++allocation_calls;
  if (fail_after < 0) return 1;
  if (fail_after == 0) return 0;
  --fail_after; return 1;
}
void* ct_malloc(size_t size) {
  if (size > SIZE_MAX - sizeof(Allocation) || !allow_allocation()) return NULL;
  Allocation* block = (Allocation*)malloc(sizeof(Allocation) + size);
  if (!block) return NULL;
  block->value.bytes = size; block->value.magic = 0xc7a6e123;
  live_bytes += size; ++live_allocations;
  if (live_bytes > peak_bytes) peak_bytes = live_bytes;
  return block + 1;
}
void ct_free(void* pointer) {
  if (!pointer) return;
  Allocation* block = (Allocation*)pointer - 1;
  if (block->value.magic != 0xc7a6e123) abort();
  live_bytes -= block->value.bytes; --live_allocations;
  block->value.magic = 0; free(block);
}
void* ct_calloc(size_t count, size_t size) {
  if (size && count > SIZE_MAX / size) return NULL;
  size_t bytes = count * size;
  void* pointer = ct_malloc(bytes);
  if (pointer) memset(pointer, 0, bytes);
  return pointer;
}
void* ct_realloc(void* pointer, size_t size) {
  if (!pointer) return ct_malloc(size);
  if (!size) { ct_free(pointer); return NULL; }
  Allocation* old = (Allocation*)pointer - 1;
  if (old->value.magic != 0xc7a6e123) abort();
  if (size > SIZE_MAX - sizeof(Allocation) || !allow_allocation()) return NULL;
  size_t previous = old->value.bytes;
  Allocation* block = (Allocation*)realloc(old, sizeof(Allocation) + size);
  if (!block) return NULL;
  block->value.bytes = size; block->value.magic = 0xc7a6e123;
  live_bytes = live_bytes - previous + size;
  if (live_bytes > peak_bytes) peak_bytes = live_bytes;
  return block + 1;
}
size_t ct_live_bytes(void) { return live_bytes; }
size_t ct_live_allocations(void) { return live_allocations; }
size_t ct_peak_bytes(void) { return peak_bytes; }
size_t ct_allocation_calls(void) { return allocation_calls; }
size_t ct_allocator_used(void) { return mallinfo().uordblks; }
void ct_fail_after(int value) { fail_after = value; }
void ct_reset_peak(void) { peak_bytes = live_bytes; }
const char* ct_error(void) { return error_text; }
int ct_version(void) { return WebPGetEncoderVersion(); }
static int fail(const char* message) { snprintf(error_text, sizeof(error_text), "%s", message); return 0; }

EM_JS(int, native_progress, (int percent), {
  return Module['nativeProgress'] ? Number(Module['nativeProgress'](percent) !== false) : 1;
});
static int progress(int percent, const WebPPicture* picture) {
  (void)picture;
  if (!native_progress(percent)) { cancelled = 1; return 0; }
  return 1;
}
typedef struct {
  WebPAnimEncoder* encoder;
  WebPConfig config;
  WebPData output;
  int width, height, timestamp, frames, finished;
  size_t max_output;
} Session;
void ct_close(Session* session) {
  if (!session) return;
  WebPDataClear(&session->output);
  WebPAnimEncoderDelete(session->encoder);
  ct_free(session);
}
Session* ct_open(int width, int height, int plays, int lossless, float quality, int method, size_t max_output) {
  error_text[0] = 0;
  if (width < 1 || height < 1 || width > WEBP_MAX_DIMENSION || height > WEBP_MAX_DIMENSION ||
      plays < 0 || plays > 65535 || (lossless != 0 && lossless != 1) || !(quality >= 0 && quality <= 100) ||
      method < 0 || method > 6 || !max_output) { fail("Invalid native configuration"); return NULL; }
  Session* session = (Session*)ct_calloc(1, sizeof(Session));
  if (!session) { fail("Session allocation failed"); return NULL; }
  WebPDataInit(&session->output);
  WebPAnimEncoderOptions options;
  if (!WebPAnimEncoderOptionsInit(&options) || !WebPConfigInit(&session->config)) {
    fail("libwebp ABI mismatch"); ct_close(session); return NULL;
  }
  options.anim_params.loop_count = plays;
  options.anim_params.bgcolor = 0;
  // Full keyframes simplify alpha/disposal verification; identical inputs may still merge.
  options.kmin = 0; options.kmax = 1;
  options.allow_mixed = 0;
  session->config.lossless = lossless; session->config.quality = quality; session->config.method = method;
  session->config.thread_level = 0;
  if (!WebPValidateConfig(&session->config)) { fail("Invalid codec configuration"); ct_close(session); return NULL; }
  session->encoder = WebPAnimEncoderNew(width, height, &options);
  if (!session->encoder) { fail("Encoder allocation failed"); ct_close(session); return NULL; }
  session->width = width; session->height = height; session->max_output = max_output;
  return session;
}
int ct_add(Session* session, const uint8_t* rgba, size_t length, int duration) {
  if (!session || session->finished || !rgba || length != (size_t)session->width * session->height * 4 ||
      duration < 1 || duration > 16777215 || session->timestamp > INT_MAX - duration) return fail("Invalid native frame");
  WebPPicture picture;
  if (!WebPPictureInit(&picture)) return fail("Picture ABI mismatch");
  picture.use_argb = 1; picture.width = session->width; picture.height = session->height;
  picture.progress_hook = progress;
  cancelled = 0;
  int ok = WebPPictureImportRGBA(&picture, rgba, session->width * 4);
  if (ok) ok = WebPAnimEncoderAdd(session->encoder, &picture, session->timestamp, &session->config);
  if (!ok) fail(cancelled ? "Native encoding aborted" : "Native frame encoding/import failed");
  WebPPictureFree(&picture);
  if (ok) { session->timestamp += duration; ++session->frames; }
  return ok;
}
int ct_finish(Session* session) {
  if (!session || session->finished || !session->frames) return fail("Invalid native finish");
  if (!WebPAnimEncoderAdd(session->encoder, NULL, session->timestamp, NULL)) return fail("Final timestamp failed");
  if (!WebPAnimEncoderAssemble(session->encoder, &session->output)) return fail("Native assembly failed");
  if (session->output.size > session->max_output) {
    WebPDataClear(&session->output); return fail("Output byte limit exceeded");
  }
  session->finished = 1; return 1;
}
const uint8_t* ct_data(Session* session) { return session && session->finished ? session->output.bytes : NULL; }
size_t ct_size(Session* session) { return session && session->finished ? session->output.size : 0; }
