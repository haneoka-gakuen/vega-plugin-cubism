/* Copyright 2026 Haneoka Gakuen contributors. MPL-2.0 licensed. */
#include <stdarg.h>
#include <stdio.h>

extern void csmSetLogFunction(void (*handler)(const char *));
__attribute__((import_module("env"), import_name("coreLog"))) void coreLog(const char *message);

int fiprintf(FILE *stream, const char *format, ...) {
  va_list args;
  va_start(args, format);
  int result = vfprintf(stream, format, args);
  va_end(args);
  return result;
}

void haneokaSetLogEnabled(int enabled) {
  csmSetLogFunction(enabled ? coreLog : 0);
}
