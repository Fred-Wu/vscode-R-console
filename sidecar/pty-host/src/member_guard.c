// R uses non-local jumps for errors and interrupts. All potentially
// erroring R API calls used by the Rust member inspector execute entirely in
// a C callback inside R_ToplevelExec. No jump can cross a Rust stack frame.
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <setjmp.h>

enum {
  RMG_INSTALL, RMG_FIND, RMG_EXISTS, RMG_ACTIVE, RMG_TYPEOF, RMG_ALTREP,
  RMG_ATTRIB, RMG_GET_ATTRIB, RMG_TAG, RMG_CAR, RMG_CDR, RMG_PRINTNAME,
  RMG_VECTOR_ELT, RMG_XLENGTH, RMG_STRING_ELT, RMG_UTF8, RMG_IS_S4,
  RMG_IS_OBJECT, RMG_PROTECT, RMG_UNPROTECT, RMG_LS3, RMG_LS2,
  RMG_INTEGER_ELT, RMG_REAL_ELT, RMG_ENVLENGTH, RMG_COUNT
};

typedef void *RmgSexp;
typedef int (*RmgToplevel)(void (*)(void *), void *);
typedef struct {
  RmgToplevel toplevel;
  uintptr_t funcs[RMG_COUNT];
  int failed;
  int initialized;
  int protected_count;
} RmgGuard;
#if defined(_MSC_VER)
static __declspec(thread) RmgGuard rmg_guard;
#else
static _Thread_local RmgGuard rmg_guard;
#endif

typedef struct {
  int method;
  uintptr_t a, b, c;
  uint64_t result;
} RmgCall;

// R_ToplevelExec catches a non-local R error or interrupt inside this
// C-only frame. The caller receives an unavailable result after a failure.
static void rmg_invoke(void *opaque) {
  RmgCall *call = (RmgCall *)opaque;
  uintptr_t ptr = rmg_guard.funcs[call->method];
  switch (call->method) {
    case RMG_INSTALL:
      call->result = (uintptr_t)((RmgSexp (*)(const char *))ptr)((const char *)call->a); break;
    case RMG_FIND: case RMG_GET_ATTRIB:
      call->result = (uintptr_t)((RmgSexp (*)(RmgSexp, RmgSexp))ptr)((RmgSexp)call->a, (RmgSexp)call->b); break;
    case RMG_EXISTS: case RMG_ACTIVE:
      call->result = (uint64_t)(uint32_t)((int (*)(RmgSexp, RmgSexp))ptr)((RmgSexp)call->a, (RmgSexp)call->b); break;
    case RMG_TYPEOF: case RMG_ALTREP: case RMG_IS_S4: case RMG_IS_OBJECT: case RMG_ENVLENGTH:
      call->result = (uint64_t)(uint32_t)((int (*)(RmgSexp))ptr)((RmgSexp)call->a); break;
    case RMG_ATTRIB: case RMG_TAG: case RMG_CAR: case RMG_CDR: case RMG_PRINTNAME: case RMG_PROTECT:
      call->result = (uintptr_t)((RmgSexp (*)(RmgSexp))ptr)((RmgSexp)call->a); break;
    case RMG_VECTOR_ELT: case RMG_STRING_ELT:
      call->result = (uintptr_t)((RmgSexp (*)(RmgSexp, ptrdiff_t))ptr)((RmgSexp)call->a, (ptrdiff_t)call->b); break;
    case RMG_XLENGTH:
      call->result = (uint64_t)((ptrdiff_t (*)(RmgSexp))ptr)((RmgSexp)call->a); break;
    case RMG_UTF8:
      call->result = (uintptr_t)((const char *(*)(RmgSexp))ptr)((RmgSexp)call->a); break;
    case RMG_UNPROTECT:
      ((void (*)(int))ptr)((int)call->a); break;
    case RMG_LS3:
      call->result = (uintptr_t)((RmgSexp (*)(RmgSexp, int, int))ptr)((RmgSexp)call->a, (int)call->b, (int)call->c); break;
    case RMG_LS2:
      call->result = (uintptr_t)((RmgSexp (*)(RmgSexp, int))ptr)((RmgSexp)call->a, (int)call->b); break;
    case RMG_INTEGER_ELT:
      call->result = (uint64_t)(uint32_t)((int (*)(RmgSexp, ptrdiff_t))ptr)((RmgSexp)call->a, (ptrdiff_t)call->b); break;
    case RMG_REAL_ELT: {
      double number = ((double (*)(RmgSexp, ptrdiff_t))ptr)((RmgSexp)call->a, (ptrdiff_t)call->b);
      memcpy(&call->result, &number, sizeof(number));
      break;
    }
    default: break;
  }
}

void rmg_begin(uintptr_t toplevel, const uintptr_t *funcs, size_t count) {
  memset(&rmg_guard, 0, sizeof(rmg_guard));
  if (!toplevel || !funcs || count != RMG_COUNT) {
    rmg_guard.failed = 1;
    return;
  }
  rmg_guard.toplevel = (RmgToplevel)toplevel;
  memcpy(rmg_guard.funcs, funcs, sizeof(rmg_guard.funcs));
  rmg_guard.initialized = 1;
}

int rmg_call(int method, uintptr_t a, uintptr_t b, uintptr_t c, uint64_t *out) {
  if (out) *out = 0;
  if (!out || method < 0 || method >= RMG_COUNT || !rmg_guard.initialized ||
      !rmg_guard.funcs[method] || (rmg_guard.failed && method != RMG_UNPROTECT)) {
    rmg_guard.failed = 1;
    return 0;
  }
  // A failed protect is not added to Rust's effective protect count. Cleanup
  // may still run after an error; never unprotect more than actually protected.
  if (method == RMG_UNPROTECT) {
    int n = (int)a;
    if (n < 0) { rmg_guard.failed = 1; return 0; }
    if (n > rmg_guard.protected_count) n = rmg_guard.protected_count;
    if (n == 0) return 1;
    a = (uintptr_t)n;
  }
  RmgCall call = {method, a, b, c, 0};
  if (!rmg_guard.toplevel(rmg_invoke, &call)) {
    rmg_guard.failed = 1;
    return 0;
  }
  if (method == RMG_PROTECT) ++rmg_guard.protected_count;
  if (method == RMG_UNPROTECT) rmg_guard.protected_count -= (int)a;
  *out = call.result;
  return 1;
}

int rmg_end(void) {
  int failed = rmg_guard.failed;
  memset(&rmg_guard, 0, sizeof(rmg_guard));
  return failed;
}

// A test-only local longjmp simulates an R error/interrupt inside a C frame.
// Also verify the guard works on the next request after an error.
static jmp_buf rmg_test_jmp;
static int rmg_test_toplevel(void (*fn)(void *), void *data) {
  if (setjmp(rmg_test_jmp)) return 0;
  fn(data);
  return 1;
}
static RmgSexp rmg_test_fail(const char *name) {
  (void)name;
  longjmp(rmg_test_jmp, 1);
}
static RmgSexp rmg_test_good(const char *name) {
  (void)name;
  return (RmgSexp)(uintptr_t)0x1234;
}
int rmg_test_error_and_recovery(void) {
  uintptr_t funcs[RMG_COUNT] = {0};
  uint64_t out = 0;
  funcs[RMG_INSTALL] = (uintptr_t)rmg_test_fail;
  rmg_begin((uintptr_t)rmg_test_toplevel, funcs, RMG_COUNT);
  if (rmg_call(RMG_INSTALL, (uintptr_t)"test", 0, 0, &out) || !rmg_end()) return 0;
  funcs[RMG_INSTALL] = (uintptr_t)rmg_test_good;
  rmg_begin((uintptr_t)rmg_test_toplevel, funcs, RMG_COUNT);
  if (!rmg_call(RMG_INSTALL, (uintptr_t)"test", 0, 0, &out) || rmg_end()) return 0;
  return out == 0x1234;
}
