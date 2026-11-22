import type { WorkspaceStrings } from "./workspaceMetadata";

export type GlobalEnvItem = {
  class: WorkspaceStrings;
  type: string;
  length: number;
  str: string;
  size?: number;
  dim?: number[];
  names?: WorkspaceStrings;
  slots?: WorkspaceStrings;
};

export type WorkspaceData = {
  revision?: number;
  search: string[];
  loaded_namespaces: string[];
  globalenv: Record<string, GlobalEnvItem>;
};

export type SessionMemberCompletionItem = {
  name: string;
  type?: string;
  str?: string;
};

export type VscodeRIntegrationOptions =
  | { kind: "disabled" }
  | { kind: "sess" }
  | {
      kind: "legacy";
      watcherDir: string;
      initPath: string;
    };
