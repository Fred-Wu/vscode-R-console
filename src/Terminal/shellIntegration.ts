const OSC = "\x1b]";
const ST = "\x1b\\";

function vscodeSequence(command: string, ...args: string[]): string {
  const suffix = args.length > 0 ? `;${args.join(";")}` : "";
  return `${OSC}633;${command}${suffix}${ST}`;
}

function serializeMessage(message: string): string {
  return message.replace(/[\\;\x00-\x20]/g, (character) => {
    if (character === "\\") {
      return "\\\\";
    }
    return `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`;
  });
}

/**
 * Emits VS Code's OSC 633 command-detection protocol for the custom terminal.
 * The native terminal suggest widget consumes the resulting prompt input model.
 */
export class TerminalShellIntegration {
  private enabled = false;
  private promptStarted = false;
  private promptActive = false;
  private commandActive = false;

  constructor(private readonly write: (data: string) => void) {}

  get hasActivePrompt(): boolean {
    return this.enabled && this.promptActive;
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) {
      return;
    }
    if (!enabled) {
      this.closeOpenLifecycle();
    }
    this.enabled = enabled;
  }

  startPrompt(): void {
    if (!this.enabled) {
      return;
    }

    this.closeOpenLifecycle();
    this.write(vscodeSequence("A"));
    this.promptStarted = true;
  }

  finishPrompt(): void {
    if (!this.enabled || !this.promptStarted || this.promptActive || this.commandActive) {
      return;
    }
    this.write(vscodeSequence("B"));
    this.promptStarted = false;
    this.promptActive = true;
  }

  startCommand(commandLine: string): void {
    if (!this.enabled || !this.promptActive) {
      return;
    }

    this.write(vscodeSequence("E", serializeMessage(commandLine)));
    this.write(vscodeSequence("C"));
    this.promptStarted = false;
    this.promptActive = false;
    this.commandActive = true;
  }

  finishCommand(exitCode?: number): void {
    if (!this.enabled || !this.commandActive) {
      return;
    }
    this.write(vscodeSequence("D", ...(exitCode === undefined ? [] : [String(exitCode)])));
    this.commandActive = false;
  }

  private closeOpenLifecycle(): void {
    this.promptStarted = false;
    if (this.commandActive) {
      this.write(vscodeSequence("D"));
      this.commandActive = false;
    }
    if (this.promptActive) {
      this.write(vscodeSequence("E", ""));
      this.write(vscodeSequence("C"));
      this.write(vscodeSequence("D", "0"));
      this.promptActive = false;
    }
  }
}
