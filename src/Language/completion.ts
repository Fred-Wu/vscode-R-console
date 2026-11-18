// Shared completion API for the console, terminal picker, and inline popup.
export * from "./completion/types";
export { getCompletionContext } from "./completion/syntax";
export { collectCompletionEntries } from "./completion/service";
export { rankCompletionEntries, toCompletionPick, toCompletionQuickPickItems, isCompletionPickItem } from "./completion/presentation";
export { getCompletionIdentityKey } from "./completion/candidates";
