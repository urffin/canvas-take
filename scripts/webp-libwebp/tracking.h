#ifndef CANVASTAKE_WEBP_TRACKING_H
#define CANVASTAKE_WEBP_TRACKING_H
#include <stddef.h>
void* ct_malloc(size_t size);
void* ct_calloc(size_t count, size_t size);
void* ct_realloc(void* pointer, size_t size);
void ct_free(void* pointer);
#endif
