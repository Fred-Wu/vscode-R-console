export type GlobalEnvItem = {
  class: string[];
  type: string;
  length: number;
  str: string;
  size?: number;
  dim?: number[];
  names?: string[];
  slots?: string[];
};

export type WorkspaceData = {
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
