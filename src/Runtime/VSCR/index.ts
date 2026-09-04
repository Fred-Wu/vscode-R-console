import type { RuntimeHost } from "../../Terminal/rTerminal/runtime";
import { DisabledVscodeRIntegration } from "./disabled/integration";
import type { VscodeRSessionIntegration } from "./integration";
import { LegacyVscodeRIntegration } from "./legacy/integration";
import {
  disposeSessProxyForRuntimeSession,
  SessVscodeRIntegration,
} from "./sess/integration";

export {
  resolveVscodeRIntegrationOptions,
  sanitizeVscodeRIntegrationEnv,
} from "./config";

const integrations = new WeakMap<RuntimeHost, VscodeRSessionIntegration>();

export function getVscodeRIntegration(host: RuntimeHost): VscodeRSessionIntegration {
  const existing = integrations.get(host);
  if (existing) {
    return existing;
  }

  const options = host.options.vscodeR;
  let integration: VscodeRSessionIntegration;
  switch (options.kind) {
    case "legacy":
      integration = new LegacyVscodeRIntegration(host, options);
      break;
    case "sess":
      integration = new SessVscodeRIntegration(host);
      break;
    case "disabled":
      integration = new DisabledVscodeRIntegration(host);
      break;
  }
  integrations.set(host, integration);
  return integration;
}

export function disposeVscodeRIntegrationForRuntimeSession(sessionId: string): void {
  disposeSessProxyForRuntimeSession(sessionId);
}

export type { VscodeRSessionIntegration } from "./integration";
export type {
  SessionMemberCompletionItem,
  VscodeRIntegrationOptions,
  WorkspaceData,
} from "./types";
