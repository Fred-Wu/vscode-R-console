completion_package_identities <- list()

console_namespace_fields <- c("objects", "functs", "nonfuncts", "exports",
    "exported_functs", "exported_nonfuncts", "lazydata")

ConsoleCachedNamespace <- R6::R6Class("ConsoleCachedNamespace",
    inherit = languageserver:::PackageNamespace,
    public = list(initialize = function(pkgname, snapshot = NULL) {
        if (is.null(snapshot)) return(super$initialize(pkgname))
        self$package_name <- pkgname
        private$namespace <- asNamespace(pkgname)
        for (field in console_namespace_fields) private[[field]] <- snapshot[[field]]
        flags <- 1L + as.integer(private$objects %in% private$functs) +
            2L * as.integer(private$objects %in% private$exports)
        private$membership <- list2env(stats::setNames(as.list(flags), private$objects),
            parent = emptyenv())
        private$function_metadata <- collections::dict()
        private$function_stubs <- collections::dict()
        private$documentation <- languageserver:::ByteLruCache$new(2 * 1024^2, 128L)
        for (name in names(snapshot$functions)) {
            info <- snapshot$functions[[name]]
            info$fn <- get0(name, private$namespace, inherits = FALSE)
            if (is.function(info$fn)) private$function_metadata$set(name, info)
        }
    }))

console_package_cache_header <- function() {
    list(schema = 1L, R = R.version.string, platform = R.version$platform,
        languageserver = as.character(utils::packageVersion("languageserver")),
        server_identity = completion_package_identities[["languageserver"]])
}

console_package_cache_export <- function(self, file) {
    dependencies <- new.env(parent = emptyenv())
    package_dependencies <- function(package) {
        if (exists(package, dependencies, inherits = FALSE)) return(dependencies[[package]])
        root <- find.package(package, quiet = TRUE)
        if (!length(root)) stop(paste("Package is no longer installed:", package))
        description <- readRDS(file.path(root, "Meta", "package.rds"))$DESCRIPTION
        fields <- description[c("Depends", "Imports", "LinkingTo")]
        fields <- fields[!is.na(fields)]
        imports <- trimws(sub("\\s*\\(.*$", "", unlist(strsplit(fields, ","))))
        if (package %in% loadedNamespaces()) imports <- union(imports, names(getNamespaceImports(package)))
        dependencies[[package]] <- setdiff(imports[nzchar(imports)], "R")
        dependencies[[package]]
    }
    workspaces <- list()
    saved <- character()
    skipped <- character()
    for (uri in self$workspaces$keys()) {
        workspace <- self$workspaces$get(uri)
        packages <- unique(c(workspace$namespaces$keys(), workspace$member_metadata$keys(),
            workspace$s3_metadata$keys()))
        entries <- list()
        for (package in packages) {
            entry <- tryCatch({
                namespace <- NULL
                if (workspace$namespaces$has(package)) {
                    private <- workspace$namespaces$get(package)$.__enclos_env__$private
                    namespace <- mget(console_namespace_fields, private, inherits = FALSE)
                    namespace$functions <- lapply(private$function_metadata$keys(), function(name) {
                        info <- private$function_metadata$get(name)
                        info$fn <- NULL
                        info
                    })
                    names(namespace$functions) <- private$function_metadata$keys()
                }
                members <- workspace$member_metadata$get(package)
                if (!is.null(members)) {
                    members <- as.list(members)
                    members$cache <- NULL
                }
                s3 <- workspace$s3_metadata$get(package)
                if (!is.null(s3$error)) s3 <- NULL
                pending <- unique(c(package, normalize_character(s3$dependencies),
                    names(members$s4_dependencies), names(members$s7_dependencies)))
                required <- character()
                while (length(pending)) {
                    current <- pending[[1L]]
                    pending <- pending[-1L]
                    if (current %in% required) next
                    required <- c(required, current)
                    pending <- union(pending, setdiff(package_dependencies(current), required))
                }
                if (!all(required %in% names(completion_package_identities))) {
                    stop("Package inventory is incomplete")
                }
                list(identities = completion_package_identities[required], namespace = namespace,
                    members = members, s3 = s3)
            }, error = function(error) NULL)
            if (is.null(entry)) skipped <- union(skipped, package)
            else {
                entries[[package]] <- entry
                saved <- union(saved, package)
            }
        }
        workspaces[[uri]] <- entries
    }
    snapshot <- list(header = console_package_cache_header(), workspaces = workspaces)
    temporary <- paste0(file, ".tmp")
    on.exit(unlink(temporary))
    saveRDS(snapshot, temporary, compress = FALSE)
    unlink(file)
    if (!file.rename(temporary, file)) stop("Could not save package metadata snapshot")
    list(saved = as.list(saved), skipped = as.list(skipped))
}

console_package_cache_restore <- function(self, file) {
    snapshot <- readRDS(file)
    if (!identical(snapshot$header, console_package_cache_header())) {
        stop("Package metadata snapshot has an incompatible R or language-server version")
    }
    restored <- character()
    skipped <- character()
    for (uri in names(snapshot$workspaces)) {
        if (!self$workspaces$has(uri)) next
        workspace <- self$workspaces$get(uri)
        for (package in names(snapshot$workspaces[[uri]])) {
            entry <- snapshot$workspaces[[uri]][[package]]
            valid <- length(entry$identities) && all(vapply(names(entry$identities), function(name) {
                identical(entry$identities[[name]], completion_package_identities[[name]])
            }, logical(1L)))
            if (!valid) {
                skipped <- union(skipped, package)
                next
            }
            ok <- tryCatch({
                if (!is.null(entry$namespace)) {
                    workspace$namespaces$set(package, ConsoleCachedNamespace$new(package, entry$namespace))
                }
                if (!is.null(entry$members)) workspace$member_metadata$set(package, entry$members)
                if (!is.null(entry$s3)) workspace$s3_metadata$set(package, entry$s3)
                TRUE
            }, error = function(error) FALSE)
            if (ok) restored <- union(restored, package)
            else skipped <- union(skipped, package)
        }
    }
    list(restored = as.list(restored), skipped = as.list(skipped))
}

server$request_handlers[["rConsole/exportPackageMetadata"]] <- function(self, id, params) {
    result <- tryCatch(console_package_cache_export(self, params$file),
        error = function(error) list(error = conditionMessage(error)))
    self$deliver(languageserver:::Response$new(id, result = result))
}
server$request_handlers[["rConsole/restorePackageMetadata"]] <- function(self, id, params) {
    result <- tryCatch(console_package_cache_restore(self, params$file),
        error = function(error) list(error = conditionMessage(error)))
    self$deliver(languageserver:::Response$new(id, result = result))
}
