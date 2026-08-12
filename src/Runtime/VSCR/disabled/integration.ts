import { BaseVscodeRSessionIntegration } from "../integration";

export class DisabledVscodeRIntegration extends BaseVscodeRSessionIntegration {
  override async prepareStart(env: NodeJS.ProcessEnv): Promise<void> {
    delete env.R_CONSOLE_SESSION_BOOTSTRAP;
    delete env.VSCODE_INIT_R;
    delete env.VSCODE_WATCHER_DIR;
    delete env.SESS_PIPE;
    delete env.SESS_PORT;
    delete env.SESS_TOKEN;
    delete env.SESS_HOST;
  }
}
