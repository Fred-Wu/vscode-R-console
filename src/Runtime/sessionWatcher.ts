type GlobalEnvItem = {
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

export class SessionWatcher {
  constructor(_watcherDir: string) {}

  setExpectedPid(_pid: number): void {}

  reset(): void {}

  async start(): Promise<void> {}

  getRuntimeEnv(): NodeJS.ProcessEnv {
    return {};
  }

  dispose(): void {}

  getWorkspaceData(): WorkspaceData | undefined {
    return undefined;
  }

  isAttached(): boolean {
    return false;
  }

  getAttachedPid(): number | undefined {
    return undefined;
  }

  async requestMemberCompletions(
    _expression: string,
    _operator: "$" | "@"
  ): Promise<SessionMemberCompletionItem[] | undefined> {
    return undefined;
  }

  refresh(): void {}

  onAttach(_callback: () => void): void {}

  onChange(_callback: (data: WorkspaceData | undefined) => void): void {}
}
