import type * as vscode from "vscode";
import type { LanguageClient } from "vscode-languageclient/node";
import type { VirtualRDocument } from "../virtualRDocument";
import { getCompletionParseInsertion, getCompletionParseSuffix, getEnclosingCall, getPipeCompletionContext } from "./contextParser";

// Supplemental syntax belongs to the console adapter. Standard completion
// position and document contents remain available to the native LSP handler.
export function createCompletionParams(
  client: LanguageClient, projection: ReturnType<VirtualRDocument["project"]>,
  serverPosition: vscode.Position, contextPosition: vscode.Position, context: vscode.CompletionContext
) {
  const text = projection.document.getText();
  const hasContext = text.includes("(") || text.includes("|>") || text.includes("%>%");
  const contextOffset = hasContext ? projection.document.offsetAt(projection.toServerPosition(contextPosition)) : 0;
  const call = text.includes("(")
    ? getEnclosingCall(text, contextOffset) : undefined;
  const pipe = hasContext ? getPipeCompletionContext(text.slice(0, contextOffset)) : undefined;
  const parseSuffix = getCompletionParseSuffix(text);
  const parseInsertion = parseSuffix !== undefined && pipe
    ? getCompletionParseInsertion(text, contextOffset) : undefined;
  // Fuzzy requests move within a prefix. Preserve the original cursor
  // context for argument matching, literal values and unfinished-input repair.
  return {
    ...client.code2ProtocolConverter.asCompletionParams(projection.document, serverPosition, context),
    ...(parseSuffix !== undefined ? { rConsoleParseSuffix: parseSuffix } : {}),
    ...(parseInsertion ? { rConsoleParseInsertion: {
      position: projection.document.positionAt(parseInsertion.offset), text: parseInsertion.text,
    } } : {}),
    ...((call?.argumentTags || call?.argumentValue)
      ? { rConsoleCall: call.name } : {}),
    ...(call?.argumentTags
      ? { rConsoleArgumentTags: call.argumentTags } : {}),
    ...(call?.argumentValue ? {
      rConsoleArgument: call.argumentValue.name,
      rConsoleValueTags: call.argumentValue.argumentTags,
      rConsolePrefix: call.argumentValue.prefix.slice(0,
        Math.max(0, projection.document.offsetAt(serverPosition) - call.argumentValue.replaceStart)),
    } : {}),
    ...(pipe ? { rConsolePipe: true, rConsolePrefix: pipe.prefix.slice(0,
      Math.max(0, projection.document.offsetAt(serverPosition) - pipe.replaceStart)) } : {}),
  };
}
