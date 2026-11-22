/* Real callback-bearing R objects for the embedded inspector safety tests.
   This DLL is compiled in a temporary directory and never shipped. */
#include <R.h>
#include <Rinternals.h>
#include <R_ext/Altrep.h>
#include <R_ext/ObjectTable.h>
#include <R_ext/Rdynload.h>
#include <string.h>

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
    R_set_altrep_Length_method(integer_class, counted_length);
    R_set_altrep_Length_method(list_class, counted_length);
    R_set_altstring_Elt_method(string_class, counted_string);
    R_set_altinteger_Elt_method(integer_class, counted_integer);
    R_set_altlist_Elt_method(list_class, counted_list);
    static const R_CallMethodDef methods[] = {
        {"member_safety_objects", (DL_FUNC)&member_safety_objects, 0},
        {"member_safety_reset", (DL_FUNC)&member_safety_reset, 0},
        {"member_safety_counts", (DL_FUNC)&member_safety_counts, 0},
        {NULL, NULL, 0}
    };
    R_registerRoutines(dll, NULL, methods, NULL, NULL);
    R_useDynamicSymbols(dll, FALSE);
}
