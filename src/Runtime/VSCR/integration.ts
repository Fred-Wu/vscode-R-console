import type { RuntimeHost } from "../../Terminal/rTerminal/runtime";
import type {
  SessionMemberCompletionItem,
  WorkspaceData,
} from "./types";

export interface VscodeRSessionIntegration {
  resetForStart(): void;
  prepareStart(env: NodeJS.ProcessEnv): Promise<void>;
  afterRuntimeStarted(): void;
  primeAttach(): void;
  attachRuntime(): void;
  handleHostConnected(): void;
  handleMainPrompt(): void;
  handleRuntimePid(pid: number): void;
  handleRuntimeExit(): void;
  setActive(active: boolean): void;

  getDisplayPid(): number | undefined;
  getCachedWorkspaceData(): WorkspaceData | undefined;
  requestWorkspaceData(): Promise<WorkspaceData | undefined>;
  refreshWorkspaceData(): void;
  requestMemberCompletions(
    expression: string,
    operator: "$" | "@"
  ): Promise<SessionMemberCompletionItem[] | undefined>;

  filterRuntimeOutput(text: string): string;
  disposeUi(): void;
}

export abstract class BaseVscodeRSessionIntegration
  implements VscodeRSessionIntegration
{
  constructor(protected readonly host: RuntimeHost) {}

  resetForStart(): void {}
  async prepareStart(_env: NodeJS.ProcessEnv): Promise<void> {}
  afterRuntimeStarted(): void {}
  primeAttach(): void {}
  attachRuntime(): void {}
  handleHostConnected(): void {}
  handleMainPrompt(): void {}
  handleRuntimePid(_pid: number): void {}
  handleRuntimeExit(): void {}
  setActive(_active: boolean): void {}

  getDisplayPid(): number | undefined {
    return undefined;
  }

  getCachedWorkspaceData(): WorkspaceData | undefined {
    return undefined;
  }

  async requestWorkspaceData(): Promise<WorkspaceData | undefined> {
    return undefined;
  }

  refreshWorkspaceData(): void {}

  async requestMemberCompletions(
    _expression: string,
    _operator: "$" | "@"
  ): Promise<SessionMemberCompletionItem[] | undefined> {
    return undefined;
  }

  filterRuntimeOutput(text: string): string {
    return text;
  }

  disposeUi(): void {}
}
