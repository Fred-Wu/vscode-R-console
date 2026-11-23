// R uses non-local jumps for errors and interrupts. All potentially
// erroring R API calls used by the Rust member inspector execute entirely in
// a C callback inside R_ToplevelExec. A calling error handler exits before
// global R error hooks can run. No jump can cross a Rust stack frame.
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <setjmp.h>

enum {
  RMG_INSTALL, RMG_FIND, RMG_EXISTS, RMG_ACTIVE, RMG_TYPEOF, RMG_ALTREP,
  RMG_ATTRIB, RMG_GET_ATTRIB, RMG_TAG, RMG_CAR, RMG_CDR, RMG_PRINTNAME,
  RMG_VECTOR_ELT, RMG_XLENGTH, RMG_STRING_ELT, RMG_UTF8, RMG_IS_S4,
  RMG_IS_OBJECT, RMG_PROTECT, RMG_UNPROTECT, RMG_LS3, RMG_LS2,
  RMG_INTEGER_ELT, RMG_REAL_ELT, RMG_ENVLENGTH, RMG_VMAXGET, RMG_VMAXSET,
  RMG_CHAR_CE, RMG_ENCLOS, RMG_PRVALUE, RMG_PREXPR, RMG_PRENV, RMG_FORMALS, RMG_BODY, RMG_LOGICAL_ELT, RMG_IS_NA, RMG_CLOSURE_ENV, RMG_COUNT
};

typedef void *RmgSexp;
typedef int (*RmgToplevel)(void (*)(void *), void *);
typedef RmgSexp (*RmgWithErrorHandler)(RmgSexp (*)(void *), void *,
                                     RmgSexp (*)(RmgSexp, void *), void *);
// Preserved values survive separate R_ToplevelExec calls. Each call to
// R_ToplevelExec uses its own PROTECT stack entries; ordinary PROTECT must
// never remain outstanding when that call returns.
enum { RMG_MAX_PRESERVED = 32 };
typedef struct {
  RmgToplevel toplevel;
  uintptr_t funcs[RMG_COUNT];
  uintptr_t raw_protect, raw_unprotect;
  RmgWithErrorHandler with_error_handler;
  void (*jump_to_toplevel)(void);
  RmgSexp nil;
  RmgSexp preserved[RMG_MAX_PRESERVED];
  int preserved_count;
  int failed;
  int initialized;
} RmgGuard;
#if defined(_MSC_VER)
#define RMG_THREAD_LOCAL __declspec(thread)
#else
#define RMG_THREAD_LOCAL _Thread_local
#endif
static RMG_THREAD_LOCAL RmgGuard rmg_guard;

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
    case RMG_ATTRIB: case RMG_TAG: case RMG_CAR: case RMG_CDR: case RMG_PRINTNAME: case RMG_ENCLOS: case RMG_PRVALUE: case RMG_PREXPR: case RMG_PRENV: case RMG_FORMALS: case RMG_BODY: case RMG_CLOSURE_ENV:
      call->result = (uintptr_t)((RmgSexp (*)(RmgSexp))ptr)((RmgSexp)call->a); break;
    case RMG_VECTOR_ELT: case RMG_STRING_ELT:
      call->result = (uintptr_t)((RmgSexp (*)(RmgSexp, ptrdiff_t))ptr)((RmgSexp)call->a, (ptrdiff_t)call->b); break;
    case RMG_XLENGTH:
      call->result = (uint64_t)((ptrdiff_t (*)(RmgSexp))ptr)((RmgSexp)call->a); break;
    case RMG_UTF8: {
      // CE_BYTES strings cannot be translated. Reject them before R reports
      // an error, rather than executing any of the user's condition hooks.
      if (((int (*)(RmgSexp))rmg_guard.funcs[RMG_CHAR_CE])((RmgSexp)call->a) == 3)
        break;
      // translateCharUTF8 may use R_alloc. Return only a copy in caller-owned
      // storage: no transient R pointer or allocation escapes this C callback.
      void *(*get_mark)(void) = (void *(*)(void))rmg_guard.funcs[RMG_VMAXGET];
      void (*restore_mark)(const void *) = (void (*)(const void *))rmg_guard.funcs[RMG_VMAXSET];
      if (!get_mark || !restore_mark || !call->b || !call->c) break;
      void *mark = get_mark();
      const char *utf8 = ((const char *(*)(RmgSexp))ptr)((RmgSexp)call->a);
      if (utf8) {
        size_t capacity = (size_t)call->c;
        size_t length = 0;
        while (length < capacity && utf8[length] != '\0') ++length;
        if (length < capacity) {
          memcpy((void *)call->b, utf8, length);
          call->result = (uint64_t)(length + 1);
        }
      }
      restore_mark(mark);
      break;
    }
    case RMG_PROTECT:
      // R_PreserveObject retains a reachable root/member across C callbacks.
      ((void (*)(RmgSexp))ptr)((RmgSexp)call->a);
      rmg_guard.preserved[rmg_guard.preserved_count++] = (RmgSexp)call->a;
      call->result = call->a;
      break;
    case RMG_UNPROTECT:
      for (int n = (int)call->a; n > 0; --n) {
        RmgSexp item = rmg_guard.preserved[rmg_guard.preserved_count - 1];
        ((void (*)(RmgSexp))ptr)(item);
        --rmg_guard.preserved_count;
      }
      break;
    case RMG_LS3: case RMG_LS2: {
      // R_lsInternal allocates a *new* character vector. PROTECT it before
      // R_PreserveObject can allocate, and UNPROTECT in this same C callback.
      // Keeping a PROTECT entry across R_ToplevelExec would unbalance R's stack.
      RmgSexp names = call->method == RMG_LS3
          ? ((RmgSexp (*)(RmgSexp, int, int))ptr)((RmgSexp)call->a, (int)call->b, (int)call->c)
          : ((RmgSexp (*)(RmgSexp, int))ptr)((RmgSexp)call->a, (int)call->b);
      if (names) {
        ((RmgSexp (*)(RmgSexp))rmg_guard.raw_protect)(names);
        ((void (*)(RmgSexp))rmg_guard.funcs[RMG_PROTECT])(names);
        rmg_guard.preserved[rmg_guard.preserved_count++] = names;
        ((void (*)(int))rmg_guard.raw_unprotect)(1);
      }
      call->result = (uintptr_t)names;
      break;
    }
    case RMG_IS_NA: {
      double value;
      uint64_t bits = (uint64_t)call->a;
      memcpy(&value, &bits, sizeof(value));
      call->result = (uint64_t)((int (*)(double))ptr)(value);
      break;
    }
    case RMG_LOGICAL_ELT: case RMG_INTEGER_ELT:
      call->result = (uint64_t)(uint32_t)((int (*)(RmgSexp, ptrdiff_t))ptr)((RmgSexp)call->a, (ptrdiff_t)call->b); break;
    case RMG_REAL_ELT: {
      double number = ((double (*)(RmgSexp, ptrdiff_t))ptr)((RmgSexp)call->a, (ptrdiff_t)call->b);
      memcpy(&call->result, &number, sizeof(number));
      break;
    }
    default: break;
  }
}

typedef struct {
  void (*body)(void *);
  void *data;
} RmgInvocation;

static RmgSexp rmg_body(void *opaque) {
  RmgInvocation *invocation = (RmgInvocation *)opaque;
  invocation->body(invocation->data);
  return rmg_guard.nil;
}

static RmgSexp rmg_error(RmgSexp condition, void *unused) {
  (void)condition; (void)unused;
  rmg_guard.failed = 1;
  // Unlike an unhandled error, this public R API skips options(error).
  // R restores its handler/protection stacks at the enclosing C-only boundary.
  rmg_guard.jump_to_toplevel();
  return rmg_guard.nil; // The production jump never returns.
}

static void rmg_with_error_handler(void *opaque) {
  rmg_guard.with_error_handler(rmg_body, opaque, rmg_error, NULL);
}

static int rmg_execute(void (*body)(void *), void *data) {
  RmgInvocation invocation = {body, data};
  return rmg_guard.toplevel(rmg_with_error_handler, &invocation);
}

void rmg_begin(uintptr_t toplevel, const uintptr_t *funcs, size_t count,
               uintptr_t raw_protect, uintptr_t raw_unprotect,
               uintptr_t with_error_handler, uintptr_t jump_to_toplevel, RmgSexp nil) {
  memset(&rmg_guard, 0, sizeof(rmg_guard));
  if (!toplevel || !funcs || count != RMG_COUNT || !with_error_handler || !jump_to_toplevel) {
    rmg_guard.failed = 1;
    return;
  }
  rmg_guard.toplevel = (RmgToplevel)toplevel;
  memcpy(rmg_guard.funcs, funcs, sizeof(rmg_guard.funcs));
  rmg_guard.raw_protect = raw_protect;
  rmg_guard.raw_unprotect = raw_unprotect;
  rmg_guard.with_error_handler = (RmgWithErrorHandler)with_error_handler;
  rmg_guard.jump_to_toplevel = (void (*)(void))jump_to_toplevel;
  rmg_guard.nil = nil;
  rmg_guard.initialized = 1;
}

int rmg_call(int method, uintptr_t a, uintptr_t b, uintptr_t c, uint64_t *out) {
  if (out) *out = 0;
  if (!out || method < 0 || method >= RMG_COUNT || !rmg_guard.initialized ||
      !rmg_guard.funcs[method] || (rmg_guard.failed && method != RMG_UNPROTECT) ||
      (method == RMG_PROTECT && rmg_guard.preserved_count >= RMG_MAX_PRESERVED) ||
      (method == RMG_UTF8 && (!rmg_guard.funcs[RMG_VMAXGET] || !rmg_guard.funcs[RMG_VMAXSET] ||
                             !rmg_guard.funcs[RMG_CHAR_CE])) ||
      ((method == RMG_LS2 || method == RMG_LS3) &&
        (!rmg_guard.raw_protect || !rmg_guard.raw_unprotect ||
         !rmg_guard.funcs[RMG_PROTECT] || !rmg_guard.funcs[RMG_UNPROTECT] ||
         rmg_guard.preserved_count >= RMG_MAX_PRESERVED))) {
    rmg_guard.failed = 1;
    return 0;
  }
  // A failed preserve is not added to the guard. Cleanup after a native R
  // error can release only values successfully recorded in this request.
  if (method == RMG_UNPROTECT) {
    int n = (int)a;
    if (n < 0) { rmg_guard.failed = 1; return 0; }
    if (n > rmg_guard.preserved_count) n = rmg_guard.preserved_count;
    if (n == 0) return 1;
    a = (uintptr_t)n;
  }
  RmgCall call = {method, a, b, c, 0};
  if (!rmg_execute(rmg_invoke, &call)) {
    rmg_guard.failed = 1;
    return 0;
  }
  *out = call.result;
  return 1;
}

// Even when a guarded R API reports an error, release all preserved values
// before resetting this request's state. Rust never owns R protection entries.
static void rmg_release_remaining(void *opaque) {
  (void)opaque;
  while (rmg_guard.preserved_count > 0) {
    RmgSexp item = rmg_guard.preserved[rmg_guard.preserved_count - 1];
    ((void (*)(RmgSexp))rmg_guard.funcs[RMG_UNPROTECT])(item);
    --rmg_guard.preserved_count;
  }
}

int rmg_end(void) {
  int failed = rmg_guard.failed;
  if (rmg_guard.preserved_count > 0 &&
      (!rmg_guard.toplevel || !rmg_guard.funcs[RMG_UNPROTECT] ||
       !rmg_execute(rmg_release_remaining, NULL))) {
    failed = 1;
  }
  memset(&rmg_guard, 0, sizeof(rmg_guard));
  return failed;
}

// A test-only local longjmp simulates an R error/interrupt inside a C frame.
// Also verify the guard works on the next request after an error.
// Rust runs tests in parallel: fake jump targets and all fixture state must
// remain private to each thread, just like the production guard.
static RMG_THREAD_LOCAL jmp_buf rmg_test_jmp;
static RMG_THREAD_LOCAL int rmg_test_inside_callback;
static int rmg_test_toplevel(void (*fn)(void *), void *data) {
  if (setjmp(rmg_test_jmp)) { rmg_test_inside_callback = 0; return 0; }
  rmg_test_inside_callback = 1;
  fn(data);
  rmg_test_inside_callback = 0;
  return 1;
}
static RmgSexp rmg_test_with_error_handler(RmgSexp (*body)(void *), void *data,
                                         RmgSexp (*handler)(RmgSexp, void *), void *hdata) {
  (void)handler; (void)hdata;
  return body(data);
}
static void rmg_test_jump(void) { longjmp(rmg_test_jmp, 1); }
static int rmg_test_char_ce(RmgSexp value) { (void)value; return 0; }
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
  rmg_begin((uintptr_t)rmg_test_toplevel, funcs, RMG_COUNT, 0, 0,
            (uintptr_t)rmg_test_with_error_handler, (uintptr_t)rmg_test_jump, NULL);
  if (rmg_call(RMG_INSTALL, (uintptr_t)"test", 0, 0, &out) || !rmg_end()) return 0;
  funcs[RMG_INSTALL] = (uintptr_t)rmg_test_good;
  rmg_begin((uintptr_t)rmg_test_toplevel, funcs, RMG_COUNT, 0, 0,
            (uintptr_t)rmg_test_with_error_handler, (uintptr_t)rmg_test_jump, NULL);
  if (!rmg_call(RMG_INSTALL, (uintptr_t)"test", 0, 0, &out) || rmg_end()) return 0;
  return out == 0x1234;
}

/* Test-only native functions check that PROTECT/UNPROTECT are balanced inside
   one C callback, that the returned vector remains preserved across calls,
   and that rmg_end releases any outstanding values after an error. */
static RMG_THREAD_LOCAL int rmg_test_temp_protects, rmg_test_temp_unprotects;
static RMG_THREAD_LOCAL int rmg_test_preserves, rmg_test_releases, rmg_test_order_error;
static RmgSexp rmg_test_ls2(RmgSexp env, int all) {
  (void)env; (void)all;
  return (RmgSexp)(uintptr_t)0x5678;
}
static RmgSexp rmg_test_ls3(RmgSexp env, int all, int sorted) {
  (void)env; (void)all; (void)sorted;
  return (RmgSexp)(uintptr_t)0x5678;
}
static RmgSexp rmg_test_temp_protect(RmgSexp value) {
  if (!rmg_test_inside_callback || value != (RmgSexp)(uintptr_t)0x5678)
    rmg_test_order_error = 1;
  ++rmg_test_temp_protects;
  return value;
}
static void rmg_test_temp_unprotect(int n) {
  if (!rmg_test_inside_callback || n != 1 || rmg_test_preserves <= rmg_test_temp_unprotects)
    rmg_test_order_error = 1;
  rmg_test_temp_unprotects += n;
}
static void rmg_test_preserve(RmgSexp value) {
  if (!rmg_test_inside_callback || value != (RmgSexp)(uintptr_t)0x5678 ||
      rmg_test_temp_protects <= rmg_test_preserves)
    rmg_test_order_error = 1;
  ++rmg_test_preserves;
}
static void rmg_test_release(RmgSexp value) {
  if (!rmg_test_inside_callback || value != (RmgSexp)(uintptr_t)0x5678)
    rmg_test_order_error = 1;
  ++rmg_test_releases;
}
int rmg_test_enumeration_protection(void) {
  uintptr_t funcs[RMG_COUNT] = {0};
  uint64_t out = 0;
  rmg_test_temp_protects = rmg_test_temp_unprotects = 0;
  rmg_test_preserves = rmg_test_releases = rmg_test_order_error = 0;
  funcs[RMG_LS2] = (uintptr_t)rmg_test_ls2;
  funcs[RMG_LS3] = (uintptr_t)rmg_test_ls3;
  funcs[RMG_PROTECT] = (uintptr_t)rmg_test_preserve;
  funcs[RMG_UNPROTECT] = (uintptr_t)rmg_test_release;
  rmg_begin((uintptr_t)rmg_test_toplevel, funcs, RMG_COUNT,
            (uintptr_t)rmg_test_temp_protect, (uintptr_t)rmg_test_temp_unprotect,
            (uintptr_t)rmg_test_with_error_handler, (uintptr_t)rmg_test_jump, NULL);
  int ok = rmg_call(RMG_LS2, 0, 1, 0, &out) &&
      out == 0x5678 && rmg_guard.preserved_count == 1 &&
      rmg_test_temp_protects == 1 && rmg_test_temp_unprotects == 1 &&
      rmg_call(RMG_UNPROTECT, 1, 0, 0, &out) &&
      rmg_guard.preserved_count == 0 && rmg_test_releases == 1 &&
      rmg_call(RMG_LS3, 0, 1, 1, &out) &&
      out == 0x5678 && rmg_guard.preserved_count == 1;
  // Leave one object preserved on the successful path: end releases it.
  int failed = rmg_end();
  int balanced = ok && !failed && !rmg_test_order_error &&
      rmg_test_temp_protects == 2 && rmg_test_temp_unprotects == 2 &&
      rmg_test_preserves == 2 && rmg_test_releases == 2;

  // A later R error must also release any previously preserved object.
  funcs[RMG_INSTALL] = (uintptr_t)rmg_test_fail;
  rmg_begin((uintptr_t)rmg_test_toplevel, funcs, RMG_COUNT,
            (uintptr_t)rmg_test_temp_protect, (uintptr_t)rmg_test_temp_unprotect,
            (uintptr_t)rmg_test_with_error_handler, (uintptr_t)rmg_test_jump, NULL);
  int recovered = rmg_call(RMG_LS2, 0, 1, 0, &out) &&
      rmg_guard.preserved_count == 1 &&
      !rmg_call(RMG_INSTALL, (uintptr_t)"test", 0, 0, &out);
  int failed_as_expected = rmg_end();
  return balanced && recovered && failed_as_expected && !rmg_test_order_error &&
      rmg_test_temp_protects == 3 && rmg_test_temp_unprotects == 3 &&
      rmg_test_preserves == 3 && rmg_test_releases == 3;
}

// Exercise transient R_alloc cleanup without requiring a linked R runtime.
// A fake translator invalidates its scratch buffer when vmaxset restores it:
// the returned bytes must already be copied into caller-owned storage.
static RMG_THREAD_LOCAL int rmg_test_vmax_gets, rmg_test_vmax_sets;
static RMG_THREAD_LOCAL char rmg_test_utf8_scratch[32];
static void *rmg_test_vmaxget(void) {
  ++rmg_test_vmax_gets;
  return rmg_test_utf8_scratch;
}
static void rmg_test_vmaxset(const void *mark) {
  if (mark != rmg_test_utf8_scratch) rmg_test_order_error = 1;
  ++rmg_test_vmax_sets;
  memset(rmg_test_utf8_scratch, 0, sizeof(rmg_test_utf8_scratch));
}
static const char *rmg_test_translate(RmgSexp unused) {
  (void)unused;
  memcpy(rmg_test_utf8_scratch, "caf\303\251", 6);
  return rmg_test_utf8_scratch;
}
int rmg_test_utf8_copy_and_transient_cleanup(void) {
  uintptr_t funcs[RMG_COUNT] = {0};
  uint64_t result = 0;
  char copied[16] = {0};
  rmg_test_vmax_gets = rmg_test_vmax_sets = rmg_test_order_error = 0;
  funcs[RMG_UTF8] = (uintptr_t)rmg_test_translate;
  funcs[RMG_CHAR_CE] = (uintptr_t)rmg_test_char_ce;
  funcs[RMG_VMAXGET] = (uintptr_t)rmg_test_vmaxget;
  funcs[RMG_VMAXSET] = (uintptr_t)rmg_test_vmaxset;
  rmg_begin((uintptr_t)rmg_test_toplevel, funcs, RMG_COUNT, 0, 0,
            (uintptr_t)rmg_test_with_error_handler, (uintptr_t)rmg_test_jump, NULL);
  for (int i = 0; i < 128; ++i) {
    memset(copied, 0, sizeof(copied));
    if (!rmg_call(RMG_UTF8, 0, (uintptr_t)copied, sizeof(copied), &result) ||
        result != 6 || memcmp(copied, "caf\303\251", 5) != 0)
      return 0;
  }
  // A short destination must be rejected while still resetting R_alloc.
  if (!rmg_call(RMG_UTF8, 0, (uintptr_t)copied, 3, &result) || result != 0)
    return 0;
  return !rmg_end() && !rmg_test_order_error &&
    rmg_test_vmax_gets == 129 && rmg_test_vmax_sets == 129;
}
