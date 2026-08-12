import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import type {
  SessionMemberCompletionItem,
  WorkspaceData,
} from "../types";

type SessionRequest = {
  command?: string;
  tempdir?: string;
  pid?: number;
  server?: {
    host?: string;
    port?: number;
    token?: string;
  } | null;
};

type SessionServerInfo = {
  host: string;
  port: number;
  token: string;
};

export class SessionWatcher {
  private workspaceData: WorkspaceData | undefined;
  private sessionDir: string | undefined;
  private requestWatcher: fs.FSWatcher | undefined;
  private workspaceWatcher: fs.FSWatcher | undefined;
  private sessionDirWatcher: fs.FSWatcher | undefined;
  private startedAt = Date.now();
  private onAttachCallback: (() => void) | undefined;
  private onChangeCallback: ((data: WorkspaceData | undefined) => void) | undefined;
  private expectedPid: number | undefined;
  private expectedPidAutoPinned = false;
  private attachedPid: number | undefined;
  private server: SessionServerInfo | undefined;

  constructor(private watcherDir: string) {}

  /**
   * Set the expected PID. Only attach requests from this PID will be processed.
   * This enables per-terminal session isolation when multiple R sessions are running.
   */
  setExpectedPid(pid: number): void {
    this.expectedPid = pid;
    this.expectedPidAutoPinned = false;
  }

  start(): void {
    if (this.expectedPidAutoPinned) {
      this.expectedPid = undefined;
      this.expectedPidAutoPinned = false;
    }
    this.attachedPid = undefined;
    this.server = undefined;
    this.workspaceData = undefined;
    this.sessionDir = undefined;
    this.requestWatcher?.close();
    this.requestWatcher = undefined;
    this.workspaceWatcher?.close();
    this.workspaceWatcher = undefined;
    this.sessionDirWatcher?.close();
    this.sessionDirWatcher = undefined;
    this.startedAt = Date.now();

    fs.mkdirSync(this.watcherDir, { recursive: true });
    const lockFile = path.join(this.watcherDir, "request.lock");
    if (!fs.existsSync(lockFile)) {
      fs.writeFileSync(lockFile, "");
    }
    try {
      this.requestWatcher = fs.watch(lockFile, () => {
        this.updateFromRequest();
      });
    } catch {
      this.requestWatcher = undefined;
    }
    this.updateFromRequest();
  }

  dispose(): void {
    this.requestWatcher?.close();
    this.requestWatcher = undefined;
    this.workspaceWatcher?.close();
    this.workspaceWatcher = undefined;
    this.sessionDirWatcher?.close();
    this.sessionDirWatcher = undefined;
  }

  getWorkspaceData(): WorkspaceData | undefined {
    return this.workspaceData;
  }

  isAttached(): boolean {
    return !!this.sessionDir;
  }

  getAttachedPid(): number | undefined {
    return this.attachedPid;
  }

  async requestWorkspaceData(): Promise<WorkspaceData | undefined> {
    this.updateFromRequest();
    await this.updateWorkspace();
    return this.workspaceData;
  }

  async requestMemberCompletions(
    expression: string,
    operator: "$" | "@"
  ): Promise<SessionMemberCompletionItem[] | undefined> {
    const expr = expression.trim();
    if (!expr) {
      return undefined;
    }

    const response = await this.postToSessionServer({
      type: "complete",
      expr,
      trigger: operator,
    });
    if (!Array.isArray(response)) {
      return undefined;
    }

    const items: SessionMemberCompletionItem[] = [];
    for (const value of response) {
      if (!value || typeof value !== "object") {
        continue;
      }
      const item = value as Record<string, unknown>;
      if (typeof item.name !== "string" || !item.name) {
        continue;
      }
      items.push({
        name: item.name,
        type: typeof item.type === "string" ? item.type : undefined,
        str: typeof item.str === "string" ? item.str : undefined,
      });
    }
    return items;
  }

  refresh(): void {
    this.updateFromRequest();
    void this.updateWorkspace();
  }

  /**
   * Register a callback invoked immediately when a new R session attaches
   * (i.e. when request.log is processed with command="attach" and a new
   * session directory is established). Fires before workspace data is loaded
   * so session-scoped state can update without waiting for the 100ms poll timer.
   */
  onAttach(callback: () => void): void {
    this.onAttachCallback = callback;
  }

  onChange(callback: (data: WorkspaceData | undefined) => void): void {
    this.onChangeCallback = callback;
  }

  private updateFromRequest(): void {
    const requestFile = path.join(this.watcherDir, "request.log");
    if (!fs.existsSync(requestFile)) {
      return;
    }
    const stats = fs.statSync(requestFile);
    if (this.expectedPid === undefined && stats.mtimeMs < this.startedAt) {
      return;
    }
    try {
      const content = fs.readFileSync(requestFile, "utf-8");
      const request = JSON.parse(content) as SessionRequest;

      if (
        this.expectedPid === undefined &&
        request.command === "attach" &&
        typeof request.pid === "number"
      ) {
        this.expectedPid = request.pid;
        this.expectedPidAutoPinned = true;
      }
      
      if (this.expectedPid !== undefined && request.pid !== this.expectedPid) {
        return;
      }
      
      if (request.command === "detach") {
        this.workspaceData = undefined;
        this.sessionDir = undefined;
        this.attachedPid = undefined;
        this.server = undefined;
        this.workspaceWatcher?.close();
        this.workspaceWatcher = undefined;
        this.sessionDirWatcher?.close();
        this.sessionDirWatcher = undefined;
        this.onChangeCallback?.(undefined);
        return;
      }
      if (request.command !== "attach" || !request.tempdir) {
        return;
      }
      this.attachedPid = request.pid;
      this.server = this.parseServerInfo(request.server);
      const nextSessionDir = path.join(request.tempdir, "vscode-R");
      if (nextSessionDir === this.sessionDir) {
        return;
      }
      this.sessionDir = nextSessionDir;
      this.workspaceData = undefined;
      this.onAttachCallback?.();
      this.startWorkspaceWatcher();
    } catch {
    }
  }

  private startWorkspaceWatcher(): void {
    this.workspaceWatcher?.close();
    this.sessionDirWatcher?.close();
    if (!this.sessionDir) {
      return;
    }
    const lockFile = path.join(this.sessionDir, "workspace.lock");
    if (!fs.existsSync(lockFile)) {
      try {
        this.sessionDirWatcher = fs.watch(this.sessionDir, (_event, filename) => {
          if (filename === "workspace.lock" && fs.existsSync(lockFile)) {
            this.startWorkspaceWatcher();
          }
        });
      } catch {
        this.sessionDirWatcher = undefined;
      }
      return;
    }
    this.sessionDirWatcher?.close();
    try {
      this.workspaceWatcher = fs.watch(lockFile, () => {
        void this.updateWorkspace();
      });
    } catch {
      this.workspaceWatcher = undefined;
    }
    void this.updateWorkspace();
  }

  private async updateWorkspace(): Promise<void> {
    const response = await this.postToSessionServer({ type: "workspace" });
    if (!this.isWorkspaceData(response)) {
      return;
    }
    this.workspaceData = response;
    this.onChangeCallback?.(this.workspaceData);
  }

  private isWorkspaceData(value: unknown): value is WorkspaceData {
    if (!value || typeof value !== "object") {
      return false;
    }
    const data = value as Partial<WorkspaceData>;
    return (
      Array.isArray(data.search) &&
      Array.isArray(data.loaded_namespaces) &&
      !!data.globalenv &&
      typeof data.globalenv === "object"
    );
  }

  private parseServerInfo(
    server: SessionRequest["server"]
  ): SessionServerInfo | undefined {
    if (!server || typeof server !== "object") {
      return undefined;
    }
    const { host, port, token } = server;
    if (
      typeof host !== "string" ||
      !host ||
      typeof port !== "number" ||
      !Number.isFinite(port) ||
      port <= 0 ||
      typeof token !== "string" ||
      !token
    ) {
      return undefined;
    }
    return { host, port, token };
  }

  private async postToSessionServer(payload: unknown): Promise<unknown | undefined> {
    const server = this.server;
    if (!server) {
      return undefined;
    }

    const body = JSON.stringify(payload);
    return new Promise((resolve) => {
      let settled = false;
      const done = (value: unknown | undefined): void => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(value);
      };

      const req = http.request(
        {
          host: server.host,
          port: server.port,
          path: "/",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body, "utf8"),
            Authorization: server.token,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer | string) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          res.on("end", () => {
            if (res.statusCode !== 200) {
              done(undefined);
              return;
            }
            try {
              const text = Buffer.concat(chunks).toString("utf8");
              done(text ? JSON.parse(text) : undefined);
            } catch {
              done(undefined);
            }
          });
        }
      );

      req.on("error", () => done(undefined));
      req.setTimeout(1200, () => {
        req.destroy();
        done(undefined);
      });
      req.write(body);
      req.end();
    });
  }
}
