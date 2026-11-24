/* Real callback-bearing R objects for the embedded inspector safety tests.
   This DLL is compiled in a temporary directory and never shipped. */
#include <R.h>
#include <Rinternals.h>
#include <R_ext/Altrep.h>
#include <R_ext/ObjectTable.h>
#include <R_ext/Rdynload.h>
#include <string.h>
#include "member_guard.c"

/* This public embedding function is exported by R on all supported systems,
   but its declaring header, Rinterface.h, is not shipped by Windows R. */
extern void Rf_jump_to_toplevel(void);

static RmgSexp guarded_test_error(const char *unused) {
    (void)unused;
    Rf_error("native guard test error");
    return R_NilValue;
}

/* Exercise the shipped C boundary with an actual R error, including cleanup
   of a preserved object and a successful request immediately afterward. */
static SEXP member_safety_error_guard(void) {
    uintptr_t funcs[RMG_COUNT] = {0};
    uint64_t result = 0;
    funcs[RMG_INSTALL] = (uintptr_t)guarded_test_error;
    funcs[RMG_PROTECT] = (uintptr_t)R_PreserveObject;
    funcs[RMG_UNPROTECT] = (uintptr_t)R_ReleaseObject;
    SEXP value = PROTECT(Rf_ScalarInteger(42));
    rmg_begin((uintptr_t)R_ToplevelExec, funcs, RMG_COUNT,
              (uintptr_t)Rf_protect, (uintptr_t)Rf_unprotect,
              (uintptr_t)R_withCallingErrorHandler, (uintptr_t)Rf_jump_to_toplevel, R_NilValue);
    int retained = rmg_call(RMG_PROTECT, (uintptr_t)value, 0, 0, &result) &&
        rmg_guard.preserved_count == 1;
    int caught = !rmg_call(RMG_INSTALL, (uintptr_t)"test", 0, 0, &result);
    int failed = rmg_end();
    int released = rmg_guard.preserved_count == 0;
    funcs[RMG_INSTALL] = (uintptr_t)Rf_install;
    rmg_begin((uintptr_t)R_ToplevelExec, funcs, RMG_COUNT,
              (uintptr_t)Rf_protect, (uintptr_t)Rf_unprotect,
              (uintptr_t)R_withCallingErrorHandler, (uintptr_t)Rf_jump_to_toplevel, R_NilValue);
    int recovered = rmg_call(RMG_INSTALL, (uintptr_t)"guard_recovered", 0, 0, &result);
    int recovery_failed = rmg_end();
    UNPROTECT(1);
    return Rf_ScalarLogical(retained && caught && failed && released &&
                           recovered && !recovery_failed);
}

static R_altrep_class_t string_class, integer_class, list_class;
static int length_calls, element_calls, exists_calls, get_calls, objects_calls;
static R_ObjectTable database;

static R_xlen_t counted_length(SEXP value) {
    (void)value;
    ++length_calls;
    return 1;
}

static SEXP counted_string(SEXP value, R_xlen_t index) {
    (void)value; (void)index;
    ++element_calls;
    return Rf_mkChar("inner");
}

/* General R deparsing can request a data pointer, bypassing Elt. Keep that
   callback observable as well, so source-inspection safety has a live control. */
static void *counted_string_data(SEXP value, Rboolean writable) {
    (void)writable;
    ++element_calls;
    if (R_altrep_data1(value) == R_NilValue) {
        SEXP data = PROTECT(Rf_mkString("inner"));
        R_set_altrep_data1(value, data);
        UNPROTECT(1);
    }
    return (void *)DATAPTR_RO(R_altrep_data1(value));
}

static int counted_integer(SEXP value, R_xlen_t index) {
    (void)value; (void)index;
    ++element_calls;
    return 1;
}

static SEXP counted_list(SEXP value, R_xlen_t index) {
    (void)value; (void)index;
    ++element_calls;
    return Rf_ScalarInteger(1);
}

static Rboolean counted_exists(const char *const name, Rboolean *cache, R_ObjectTable *table) {
    (void)table;
    ++exists_calls;
    if (cache) *cache = FALSE;
    return strcmp(name, "inner") == 0;
}

static SEXP counted_get(const char *const name, Rboolean *cache, R_ObjectTable *table) {
    (void)table;
    ++get_calls;
    if (cache) *cache = FALSE;
    return strcmp(name, "inner") == 0 ? Rf_ScalarInteger(1) : R_UnboundValue;
}

static SEXP counted_objects(R_ObjectTable *table) {
    (void)table;
    ++objects_calls;
    return Rf_mkString("inner");
}

static Rboolean no_cache(const char *const name, R_ObjectTable *table) {
    (void)name; (void)table;
    return FALSE;
}

static SEXP member_safety_objects(void) {
    SEXP result = PROTECT(Rf_allocVector(VECSXP, 5));
    SEXP names = PROTECT(Rf_allocVector(STRSXP, 5));
    const char *labels[] = {"names", "class", "index", "list", "database"};
    for (int i = 0; i < 5; ++i) SET_STRING_ELT(names, i, Rf_mkChar(labels[i]));
    Rf_setAttrib(result, R_NamesSymbol, names);

    for (int i = 0; i < 2; ++i) {
        SEXP value = PROTECT(Rf_allocVector(VECSXP, 1));
        SEXP attribute = PROTECT(R_new_altrep(string_class, R_NilValue, R_NilValue));
        Rf_setAttrib(value, i == 0 ? R_NamesSymbol : R_ClassSymbol, attribute);
        SET_VECTOR_ELT(result, i, value);
        UNPROTECT(2);
    }
    SET_VECTOR_ELT(result, 2, R_new_altrep(integer_class, R_NilValue, R_NilValue));
    SEXP list = PROTECT(R_new_altrep(list_class, R_NilValue, R_NilValue));
    SEXP list_names = PROTECT(Rf_mkString("inner"));
    Rf_setAttrib(list, R_NamesSymbol, list_names);
    SET_VECTOR_ELT(result, 3, list);

    memset(&database, 0, sizeof(database));
    database.active = TRUE;
    database.exists = counted_exists;
    database.get = counted_get;
    database.objects = counted_objects;
    database.canCache = no_cache;
    SEXP pointer = PROTECT(R_MakeExternalPtr(&database, R_NilValue, R_NilValue));
    SEXP class_name = PROTECT(Rf_mkString("UserDefinedDatabase"));
    Rf_setAttrib(pointer, R_ClassSymbol, class_name);
    SET_VECTOR_ELT(result, 4, pointer);
    UNPROTECT(6);
    return result;
}

static SEXP member_safety_reset(void) {
    length_calls = element_calls = exists_calls = get_calls = objects_calls = 0;
    return R_NilValue;
}

static SEXP member_safety_counts(void) {
    SEXP result = PROTECT(Rf_allocVector(INTSXP, 5));
    INTEGER(result)[0] = length_calls;
    INTEGER(result)[1] = element_calls;
    INTEGER(result)[2] = exists_calls;
    INTEGER(result)[3] = get_calls;
    INTEGER(result)[4] = objects_calls;
    UNPROTECT(1);
    return result;
}

void R_init_member_safety(DllInfo *dll) {
    string_class = R_make_altstring_class("counted_string", "member_safety", dll);
    integer_class = R_make_altinteger_class("counted_integer", "member_safety", dll);
    list_class = R_make_altlist_class("counted_list", "member_safety", dll);
    R_set_altrep_Length_method(string_class, counted_length);
    R_set_altvec_Dataptr_method(string_class, counted_string_data);
    R_set_altrep_Length_method(integer_class, counted_length);
    R_set_altrep_Length_method(list_class, counted_length);
    R_set_altstring_Elt_method(string_class, counted_string);
    R_set_altinteger_Elt_method(integer_class, counted_integer);
    R_set_altlist_Elt_method(list_class, counted_list);
    static const R_CallMethodDef methods[] = {
        {"member_safety_objects", (DL_FUNC)&member_safety_objects, 0},
        {"member_safety_reset", (DL_FUNC)&member_safety_reset, 0},
        {"member_safety_counts", (DL_FUNC)&member_safety_counts, 0},
        {"member_safety_error_guard", (DL_FUNC)&member_safety_error_guard, 0},
        {NULL, NULL, 0}
    };
    R_registerRoutines(dll, NULL, methods, NULL, NULL);
    R_useDynamicSymbols(dll, FALSE);
}
