const FRAME_HEADER_LEN = 12;

const FrameKind = {
  BackendReady: 1,
  HostConnected: 2,
  ChildSpawned: 3,
  Prompt: 4,
  Busy: 5,
  InputRequest: 6,
  InputEnd: 7,
  Output: 8,
  OutputFlush: 9,
  ParseStatusRequest: 10,
  ParseStatusResult: 11,
  Submit: 12,
  ReplyInput: 13,
  Interrupt: 14,
  SetWidth: 15,
  DialogRequest: 16,
  Shutdown: 17,
  DialogResult: 18,
  HostError: 19,
} as const;

export type BackendCapability =
  | "control-channel"
  | "shutdown"
  | "session-control"
  | "top-level-submit"
  | "nested-input"
  | "parse-status"
  | "set-width";

export type BackendDialogRequest =
  | {
      kind: "choose-file";
      newFile: boolean;
    }
  | {
      kind: "edit-expression";
      path: string;
    }
  | {
      kind: "edit-files";
      paths: string[];
    };

export type BackendDialogResult =
  | {
      kind: "choose-file";
      path?: string;
    }
  | {
      kind: "edit-expression";
      completed: boolean;
    }
  | {
      kind: "edit-files";
      completed: boolean;
    };

export type BackendControlEvent =
  | {
      type: "backend-ready";
      protocolVersion: number;
      backend: string;
      capabilities: BackendCapability[];
    }
  | {
      type: "host-connected";
      host: string;
      capabilities: BackendCapability[];
    }
  | {
      type: "child-spawned";
      pid?: number;
    }
  | {
      type: "prompt";
      kind: "main" | "cont";
    }
  | {
      type: "busy";
      value: boolean;
    }
  | {
      type: "input-request";
      prompt: string;
    }
  | {
      type: "input-end";
    }
  | {
      type: "dialog-request";
      dialog: BackendDialogRequest;
    }
  | {
      type: "output-flush";
    }
  | {
      type: "parse-status-result";
      requestId: number;
      status: number;
    }
  | {
      type: "host-error";
      message: string;
    };

type BackendFrameParseResult = {
  events: BackendControlEvent[];
  output: Array<{
    stream: "stdout" | "stderr";
    data: Buffer;
  }>;
  carry: Buffer;
  error?: string;
};

type StringListPayload = {
  label: string;
  capabilities: BackendCapability[];
  offset: number;
};

function isBackendCapability(value: string): value is BackendCapability {
  return (
    value === "control-channel" ||
    value === "shutdown" ||
    value === "session-control" ||
    value === "top-level-submit" ||
    value === "nested-input" ||
    value === "parse-status" ||
    value === "set-width"
  );
}

function parseI32(payload: Buffer, offset: number): number {
  if (offset + 4 > payload.length) {
    throw new Error("truncated i32");
  }
  return payload.readInt32LE(offset);
}

function parseU32(payload: Buffer, offset: number): number {
  if (offset + 4 > payload.length) {
    throw new Error("truncated u32");
  }
  return payload.readUInt32LE(offset);
}

function parseString(
  payload: Buffer,
  offset: number
): { value: string; offset: number } {
  const length = parseU32(payload, offset);
  const start = offset + 4;
  const end = start + length;
  if (end > payload.length) {
    throw new Error("truncated string");
  }
  return {
    value: payload.toString("utf8", start, end),
    offset: end,
  };
}

function parseStringListPayload(payload: Buffer): StringListPayload {
  const labelResult = parseString(payload, 0);
  let offset = labelResult.offset;
  const capabilityCount = parseU32(payload, offset);
  offset += 4;
  const capabilities: BackendCapability[] = [];
  for (let index = 0; index < capabilityCount; index += 1) {
    const result = parseString(payload, offset);
    offset = result.offset;
    if (isBackendCapability(result.value)) {
      capabilities.push(result.value);
    }
  }
  return {
    label: labelResult.value,
    capabilities,
    offset,
  };
}

function parseStringArray(
  payload: Buffer,
  offset: number = 0
): { values: string[]; offset: number } {
  const count = parseU32(payload, offset);
  offset += 4;
  const values: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const result = parseString(payload, offset);
    values.push(result.value);
    offset = result.offset;
  }
  return { values, offset };
}

function parseDialogRequest(payload: Buffer): BackendDialogRequest {
  if (payload.length === 0) {
    throw new Error("missing dialog-request kind");
  }

  switch (payload[0]) {
    case 0:
      return { kind: "choose-file", newFile: false };
    case 1:
      return { kind: "choose-file", newFile: true };
    case 2:
      return {
        kind: "edit-expression",
        path: parseString(payload, 1).value,
      };
    case 3:
      return {
        kind: "edit-files",
        paths: parseStringArray(payload, 1).values,
      };
    default:
      throw new Error(`unknown dialog-request kind ${payload[0]}`);
  }
}

function parseControlFrame(
  kind: number,
  requestId: number,
  payload: Buffer
): BackendControlEvent | undefined {
  switch (kind) {
    case FrameKind.BackendReady: {
      const protocolVersion = parseU32(payload, 0);
      const info = parseStringListPayload(payload.subarray(4));
      return {
        type: "backend-ready",
        protocolVersion,
        backend: info.label,
        capabilities: info.capabilities,
      };
    }
    case FrameKind.HostConnected: {
      const info = parseStringListPayload(payload);
      return {
        type: "host-connected",
        host: info.label,
        capabilities: info.capabilities,
      };
    }
    case FrameKind.ChildSpawned:
      if (payload.length === 0) {
        return { type: "child-spawned" };
      }
      if (payload.length !== 4) {
        throw new Error("invalid child-spawned payload");
      }
      return {
        type: "child-spawned",
        pid: payload.readUInt32LE(0),
      };
    case FrameKind.Prompt:
      if (payload.length !== 1) {
        throw new Error("invalid prompt payload");
      }
      return {
        type: "prompt",
        kind: payload[0] === 1 ? "cont" : "main",
      };
    case FrameKind.Busy:
      if (payload.length !== 1) {
        throw new Error("invalid busy payload");
      }
      return {
        type: "busy",
        value: payload[0] !== 0,
      };
    case FrameKind.InputRequest:
      return {
        type: "input-request",
        prompt: payload.toString("utf8"),
      };
    case FrameKind.InputEnd:
      return { type: "input-end" };
    case FrameKind.DialogRequest:
      return {
        type: "dialog-request",
        dialog: parseDialogRequest(payload),
      };
    case FrameKind.OutputFlush:
      return { type: "output-flush" };
    case FrameKind.ParseStatusResult:
      return {
        type: "parse-status-result",
        requestId,
        status: parseI32(payload, 0),
      };
    case FrameKind.HostError:
      return {
        type: "host-error",
        message: payload.toString("utf8"),
      };
    default:
      return undefined;
  }
}

function parseOutputPayload(payload: Buffer): {
  stream: "stdout" | "stderr";
  data: Buffer;
} {
  if (payload.length === 0) {
    return {
      stream: "stdout",
      data: Buffer.alloc(0),
    };
  }

  if (payload[0] === 0 || payload[0] === 1) {
    return {
      stream: payload[0] === 1 ? "stderr" : "stdout",
      data: Buffer.from(payload.subarray(1)),
    };
  }

  return {
    stream: "stdout",
    data: Buffer.from(payload),
  };
}

function createFrame(kind: number, requestId: number, payload: Buffer): Buffer {
  const frame = Buffer.allocUnsafe(FRAME_HEADER_LEN + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  frame.writeUInt16LE(kind, 4);
  frame.writeUInt16LE(0, 6);
  frame.writeUInt32LE(requestId, 8);
  payload.copy(frame, FRAME_HEADER_LEN);
  return frame;
}

export function parseBackendFrames(
  chunk: Buffer,
  carry: Buffer = Buffer.alloc(0)
): BackendFrameParseResult {
  const combined =
    carry.length === 0 ? chunk : Buffer.concat([carry, chunk], carry.length + chunk.length);
  const events: BackendControlEvent[] = [];
  const output: Array<{
    stream: "stdout" | "stderr";
    data: Buffer;
  }> = [];
  let cursor = 0;

  while (cursor + FRAME_HEADER_LEN <= combined.length) {
    const payloadLength = combined.readUInt32LE(cursor);
    const kind = combined.readUInt16LE(cursor + 4);
    const frameLength = FRAME_HEADER_LEN + payloadLength;
    if (cursor + frameLength > combined.length) {
      break;
    }

    const requestId = combined.readUInt32LE(cursor + 8);
    const payload = combined.subarray(cursor + FRAME_HEADER_LEN, cursor + frameLength);

    try {
      if (kind === FrameKind.Output) {
        output.push(parseOutputPayload(payload));
      } else {
        const event = parseControlFrame(kind, requestId, payload);
        if (event) {
          events.push(event);
        } else {
          return {
            events,
            output,
            carry: Buffer.alloc(0),
            error: `Unknown backend frame kind ${kind}`,
          };
        }
      }
    } catch (error) {
      return {
        events,
        output,
        carry: Buffer.alloc(0),
        error:
          error instanceof Error
            ? `Invalid backend frame ${kind}: ${error.message}`
            : `Invalid backend frame ${kind}`,
      };
    }

    cursor += frameLength;
  }

  return {
    events,
    output,
    carry: Buffer.from(combined.subarray(cursor)),
  };
}

export function encodeSubmitFrame(code: string): Buffer {
  return createFrame(FrameKind.Submit, 0, Buffer.from(code, "utf8"));
}

export function encodeReplyInputFrame(text: string): Buffer {
  return createFrame(FrameKind.ReplyInput, 0, Buffer.from(text, "utf8"));
}

export function encodeInterruptFrame(): Buffer {
  return createFrame(FrameKind.Interrupt, 0, Buffer.alloc(0));
}

export function encodeSetWidthFrame(columns: number): Buffer {
  const payload = Buffer.allocUnsafe(4);
  payload.writeUInt32LE(Math.max(1, Math.floor(columns)), 0);
  return createFrame(FrameKind.SetWidth, 0, payload);
}

export function encodeDialogResultFrame(result: BackendDialogResult): Buffer {
  switch (result.kind) {
    case "choose-file": {
      if (!result.path) {
        return createFrame(FrameKind.DialogResult, 0, Buffer.from([0, 0]));
      }
      const pathPayload = Buffer.from(result.path, "utf8");
      const payload = Buffer.allocUnsafe(2 + 4 + pathPayload.length);
      payload[0] = 0;
      payload[1] = 1;
      payload.writeUInt32LE(pathPayload.length, 2);
      pathPayload.copy(payload, 6);
      return createFrame(FrameKind.DialogResult, 0, payload);
    }
    case "edit-expression":
      return createFrame(
        FrameKind.DialogResult,
        0,
        Buffer.from([1, result.completed ? 1 : 0])
      );
    case "edit-files":
      return createFrame(
        FrameKind.DialogResult,
        0,
        Buffer.from([2, result.completed ? 1 : 0])
      );
  }
}

export function encodeParseStatusRequestFrame(
  requestId: number,
  code: string
): Buffer {
  return createFrame(FrameKind.ParseStatusRequest, requestId, Buffer.from(code, "utf8"));
}

export function encodeShutdownFrame(): Buffer {
  return createFrame(FrameKind.Shutdown, 0, Buffer.alloc(0));
}
