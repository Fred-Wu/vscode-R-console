export type KeyAction =
  | { type: "arrow"; dir: "up" | "down" | "left" | "right" }
  | { type: "enter" }
  | { type: "backspace" }
  | { type: "delete" }
  | { type: "home" }
  | { type: "end" }
  | { type: "word-left" }
  | { type: "word-right" }
  | { type: "tab" }
  | { type: "backtab" }
  | { type: "escape" }
  | { type: "ctrl_c" }
  | { type: "ctrl_d" }
  | { type: "ctrl_l" }
  | { type: "ctrl_a" }
  | { type: "ctrl_e" }
  | { type: "ctrl_n" }
  | { type: "ctrl_p" }
  | { type: "ctrl_r" }
  | { type: "ctrl_space" }
  | { type: "paste-start" }
  | { type: "paste-end" }
  | { type: "text"; text: string };

const CSI_6: Map<string, KeyAction> = new Map([
  ["\x1b[200~", { type: "paste-start" }],
  ["\x1b[201~", { type: "paste-end" }],
  ["\x1b[1;5C", { type: "word-right" }],
  ["\x1b[1;5D", { type: "word-left" }],
]);

const CSI_4: Map<string, KeyAction> = new Map([
  ["\x1b[3~", { type: "delete" }],
  ["\x1b[1~", { type: "home" }],
  ["\x1b[4~", { type: "end" }],
  ["\x1b[7~", { type: "home" }],
  ["\x1b[8~", { type: "end" }],
  ["\x1b[5C", { type: "word-right" }],
  ["\x1b[5D", { type: "word-left" }],
]);

const CSI_3: Map<string, KeyAction> = new Map([
  ["\x1b[A", { type: "arrow", dir: "up" }],
  ["\x1b[B", { type: "arrow", dir: "down" }],
  ["\x1b[C", { type: "arrow", dir: "right" }],
  ["\x1b[D", { type: "arrow", dir: "left" }],
  ["\x1b[H", { type: "home" }],
  ["\x1b[F", { type: "end" }],
  ["\x1b[Z", { type: "backtab" }],
]);

const SS3_3: Map<string, KeyAction> = new Map([
  ["\x1bOA", { type: "arrow", dir: "up" }],
  ["\x1bOB", { type: "arrow", dir: "down" }],
  ["\x1bOC", { type: "arrow", dir: "right" }],
  ["\x1bOD", { type: "arrow", dir: "left" }],
  ["\x1bOH", { type: "home" }],
  ["\x1bOF", { type: "end" }],
  ["\x1bOc", { type: "word-right" }],
  ["\x1bOd", { type: "word-left" }],
]);

const ALT_2: Map<string, KeyAction> = new Map([
  ["\x1bb", { type: "word-left" }],
  ["\x1bf", { type: "word-right" }],
  ["\x1b\t", { type: "backtab" }],
]);

const CTRL_CODES: Map<number, KeyAction> = new Map([
  [0, { type: "ctrl_space" }],
  [1, { type: "ctrl_a" }],
  [3, { type: "ctrl_c" }],
  [4, { type: "ctrl_d" }],
  [5, { type: "ctrl_e" }],
  [12, { type: "ctrl_l" }],
  [14, { type: "ctrl_n" }],
  [16, { type: "ctrl_p" }],
  [18, { type: "ctrl_r" }],
]);

function isCsiFinalByte(code: number): boolean {
  return code >= 0x40 && code <= 0x7e;
}

function readCsiSequence(
  chunk: string,
  start: number
): { sequence?: string; complete: boolean } {
  for (let i = start + 2; i < chunk.length; i += 1) {
    if (isCsiFinalByte(chunk.charCodeAt(i))) {
      return {
        sequence: chunk.slice(start, i + 1),
        complete: true,
      };
    }
  }
  return { complete: false };
}

function getCsiAction(sequence: string): KeyAction | undefined {
  if (sequence.length === 6) {
    return CSI_6.get(sequence);
  }
  if (sequence.length === 4) {
    return CSI_4.get(sequence);
  }
  if (sequence.length === 3) {
    return CSI_3.get(sequence);
  }
  return undefined;
}

export class KeyProcessor {
  private escapeBuffer = "";
  private inPaste = false;

  parseInputChunk(chunk: string): KeyAction[] {
    const actions: KeyAction[] = [];
    let i = 0;
    
    if (this.escapeBuffer) {
      chunk = this.escapeBuffer + chunk;
      this.escapeBuffer = "";
    }

    while (i < chunk.length) {
      const ch = chunk[i];
      const code = ch.charCodeAt(0);

      if (code === 27) {
        const remaining = chunk.length - i;
        
        if (remaining === 1) {
          actions.push({ type: "escape" });
          i += 1;
          continue;
        }

        const two = chunk.slice(i, i + 2);
        
        if (two === "\x1b[") {
          const parsed = readCsiSequence(chunk, i);
          if (!parsed.complete) {
            this.escapeBuffer = chunk.slice(i);
            break;
          }

          const sequence = parsed.sequence!;
          const action = getCsiAction(sequence);
          if (action) {
            if (action.type === "paste-start") this.inPaste = true;
            if (action.type === "paste-end") this.inPaste = false;
            actions.push(action);
            i += sequence.length;
            continue;
          }

          // Ignore unsupported CSI reports such as focus and mouse tracking.
          i += sequence.length;
          continue;
        }

        if (two === "\x1bO") {
          if (remaining < 3) {
            this.escapeBuffer = chunk.slice(i);
            break;
          }
          
          const action = SS3_3.get(chunk.slice(i, i + 3));
          if (action) {
            actions.push(action);
            i += 3;
            continue;
          }
          
          i += 3;
          continue;
        }

        const altAction = ALT_2.get(two);
        if (altAction) {
          actions.push(altAction);
          i += 2;
          continue;
        }
        
        if (chunk.charCodeAt(i + 1) >= 32) {
          actions.push({ type: "escape" });
          i += 1;
          continue;
        }
        
        i += 1;
        continue;
      }

      if (this.inPaste) {
        actions.push({ type: "text", text: ch });
        i += 1;
        continue;
      }

      if (ch === "\r") {
        actions.push({ type: "enter" });
        if (i + 1 < chunk.length && chunk[i + 1] === "\n") {
          i += 2;
        } else {
          i += 1;
        }
        continue;
      }
      if (ch === "\n") {
        actions.push({ type: "enter" });
        i += 1;
        continue;
      }

      if (code === 127 || code === 8) {
        actions.push({ type: "backspace" });
        i += 1;
        continue;
      }

      if (ch === "\t") {
        actions.push({ type: "tab" });
        i += 1;
        continue;
      }

      const ctrlAction = CTRL_CODES.get(code);
      if (ctrlAction) {
        actions.push(ctrlAction);
        i += 1;
        continue;
      }

      if (code < 32) {
        i += 1;
        continue;
      }

      actions.push({ type: "text", text: ch });
      i += 1;
    }

    return actions;
  }
}
