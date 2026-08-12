import * as fs from "fs";
import * as path from "path";
import type { RuntimeHost } from "../../../Terminal/rTerminal/runtime";
import { BaseVscodeRSessionIntegration } from "../integration";
import type {
  SessionMemberCompletionItem,
  VscodeRIntegrationOptions,
  WorkspaceData,
} from "../types";
import { SessionWatcher } from "./sessionWatcher";

type LegacyIntegrationOptions = Extract<
  VscodeRIntegrationOptions,
  { kind: "legacy" }
>;

export class LegacyVscodeRIntegration extends BaseVscodeRSessionIntegration {
  private readonly watcher: SessionWatcher;
  private attached = false;

  constructor(
    host: RuntimeHost,
    private readonly options: LegacyIntegrationOptions
  ) {
    super(host);
    this.watcher = new SessionWatcher(options.watcherDir);
    this.watcher.onChange((data) => host.onSessionDataChanged(data));
  }

  override resetForStart(): void {
    this.attached = false;
  }

  override async prepareStart(env: NodeJS.ProcessEnv): Promise<void> {
    const bootstrapPath = path.join(
      this.host.extensionPath,
      "resources",
      "r",
      "VSCR",
      "legacy.R"
    );
    if (!fs.existsSync(bootstrapPath)) {
      throw new Error(`Legacy vscode-R bootstrap script not found at ${bootstrapPath}`);
    }

    fs.mkdirSync(this.options.watcherDir, { recursive: true });
    env.R_CONSOLE_SESSION_BOOTSTRAP = bootstrapPath;
    env.VSCODE_INIT_R = this.options.initPath;
    env.VSCODE_WATCHER_DIR = this.options.watcherDir;
    delete env.SESS_PIPE;
    delete env.SESS_PORT;
    delete env.SESS_TOKEN;
    delete env.SESS_HOST;
  }

  override primeAttach(): void {
    const runtimePid =
      this.host.runtimeBackend?.getPid(this.host.rProcess) ?? this.host.getDisplayPid();
    if (typeof runtimePid === "number" && Number.isFinite(runtimePid) && runtimePid > 0) {
      this.watcher.setExpectedPid(runtimePid);
    }

    this.watcher.onAttach(() => this.onAttached());
    void (async () => {
      await this.watcher.start();
      this.watcher.refresh();
      if (this.watcher.isAttached()) {
        this.onAttached();
      }
    })();
  }

  override handleRuntimePid(pid: number): void {
    this.watcher.setExpectedPid(pid);
  }

  override getDisplayPid(): number | undefined {
    return this.watcher.getAttachedPid();
  }

  override getCachedWorkspaceData(): WorkspaceData | undefined {
    return this.watcher.getWorkspaceData();
  }

  override async requestWorkspaceData(): Promise<WorkspaceData | undefined> {
    return await this.watcher.requestWorkspaceData();
  }

  override refreshWorkspaceData(): void {
    this.watcher.refresh();
  }

  override async requestMemberCompletions(
    expression: string,
    operator: "$" | "@"
  ): Promise<SessionMemberCompletionItem[] | undefined> {
    return await this.watcher.requestMemberCompletions(expression, operator);
  }

  override handleRuntimeExit(): void {
    this.attached = false;
  }

  override disposeUi(): void {
    this.watcher.dispose();
  }

  private onAttached(): void {
    if (this.attached) {
      return;
    }
    this.attached = true;
    this.host.onSessionDataChanged(this.watcher.getWorkspaceData());
    this.host.nameEmitter.fire(this.host.getTerminalName());
    this.host.notifyDisplayPidChanged();
    if (this.host.mode === "starting" && this.host.promptReady) {
      this.host.mode = "ready";
    }
    if (
      this.host.mode === "ready" &&
      this.host.promptReady &&
      !this.host.promptVisible
    ) {
      this.host.pendingPromptToken = true;
      this.host.schedulePrompt();
      if (this.host.activeSubmission === null && this.host.promptKind === "main") {
        this.host.startNextSubmission();
      }
    }
  }
}
