import type * as vscode from "vscode";
import type { LanguageClient } from "vscode-languageclient/node";
import type { VirtualRDocument } from "../virtualRDocument";
import { getBracketCompletionContext, getCompletionParseInsertion, getCompletionParseSuffix, getEnclosingCall, getPipeCompletionContext } from "./contextParser";

// Supplemental syntax belongs to the console adapter. Standard completion
// position and document contents remain available to the native LSP handler.
export function createCompletionParams(
  client: LanguageClient, projection: ReturnType<VirtualRDocument["project"]>,
  serverPosition: vscode.Position, contextPosition: vscode.Position, context: vscode.CompletionContext,
  staticAnalysis = false
) {
  const text = projection.document.getText();
  const hasContext = text.includes("(") || text.includes("[") || text.includes("|>") || text.includes("%>%");
  const contextOffset = hasContext ? projection.document.offsetAt(projection.toServerPosition(contextPosition)) : 0;
  const call = text.includes("(")
    ? getEnclosingCall(text, contextOffset) : undefined;
  const pipe = hasContext ? getPipeCompletionContext(text.slice(0, contextOffset)) : undefined;
  const bracket = text.includes("[") ? getBracketCompletionContext(text, contextOffset) : undefined;
  // Method snapshots must respect source bindings even without a function
  // literal, such as an unfinished block that assigns a factory result.
  const parseSuffix = getCompletionParseSuffix(text,
    staticAnalysis && (call?.operator === "$" || call?.operator === "@"));
  const parseInsertion = parseSuffix !== undefined && pipe
    ? getCompletionParseInsertion(text, contextOffset) : undefined;
  // Fuzzy requests move within a prefix. Preserve the original cursor
  // context for argument matching, literal values and unfinished-input repair.
  return {
    ...client.code2ProtocolConverter.asCompletionParams(projection.document, serverPosition, context),
    ...(staticAnalysis ? { rConsoleStaticAnalysis: true } : {}),
    ...(parseSuffix !== undefined ? { rConsoleParseSuffix: parseSuffix } : {}),
    ...(bracket ? {
      rConsoleDataObject: bracket.objectName,
      rConsoleSubscriptOperator: bracket.operator,
      rConsoleSubscriptTags: bracket.argumentTags,
      rConsoleSubscriptPrefix: bracket.prefix,
      ...(bracket.argumentName ? { rConsoleSubscriptArgument: bracket.argumentName } : {}),
    } : {}),
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
