// R JSON serializers may unbox single strings and encode NA entries as null.
// Normalize metadata at its consumers without changing the shared snapshot.
export type WorkspaceStrings = string | (string | null)[] | null;

export function workspaceStrings(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item.length > 0);
  }
  return typeof value === "string" && value.length > 0 ? [value] : [];
}
