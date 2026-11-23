// Shared completion API for the console, terminal picker, and inline popup.
export * from "./completion/types";
export { getCompletionContext, getStaticFallbackContext } from "./completion/syntax";
export { storedFunctionReceiver, storedReceiverRoot } from "./completion/sourceReceiver";
export { parseRuntimeMemberQuery } from "./completion/runtimeMembers";
export { collectCompletionEntries, collectStaticFallbackEntries } from "./completion/service";
export { rankCompletionEntries, toCompletionPick, toCompletionQuickPickItems, isCompletionPickItem } from "./completion/presentation";
