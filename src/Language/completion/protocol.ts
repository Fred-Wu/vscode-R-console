import { getCompletionContext, getStaticFallbackContext } from "./syntax";
import { storedCompletionReceiver } from "./sourceReceiver";
import { parseRuntimeMemberQuery } from "./runtimeMembers";
import type { NativeSourceBinding } from "./nativeStaticProvider";
import type * as vscode from "vscode";
import type { LanguageClient } from "vscode-languageclient/node";
import type { VirtualRDocument } from "../virtualRDocument";
import { getCompletionSyntax, getCompletionParseInsertion, getCompletionParseSuffix } from "./contextParser";

// Supplemental syntax belongs to the console adapter. Standard completion
// position and document contents remain available to the native LSP handler.
export function createCompletionParams(
  client: LanguageClient, projection: ReturnType<VirtualRDocument["project"]>,
  serverPosition: vscode.Position, contextPosition: vscode.Position, context: vscode.CompletionContext,
  staticAnalysis = false, sourceBinding?: NativeSourceBinding
) {
  const text = projection.document.getText();
  const hasContext = !!sourceBinding || text.includes("(") || text.includes("[") || text.includes("|>") || text.includes("%>%");
  const contextOffset = hasContext ? projection.document.offsetAt(projection.toServerPosition(contextPosition)) : 0;
  const syntax = getCompletionSyntax(text, contextOffset);
  const call = syntax.call;
  const pipe = syntax.pipe;
  const bracket = syntax.bracket;
  // Static parsing and incomplete-input recovery belong to languageserver.
  // The legacy repair is used only to match inert runtime signature metadata.
  const parseSuffix = staticAnalysis ? undefined : getCompletionParseSuffix(text);
  const parseInsertion = parseSuffix !== undefined && pipe
    ? getCompletionParseInsertion(text, contextOffset) : undefined;
  // Projected package qualifications decide whether a live binding still
  // shadows this callable. All supplemental parameters use the same document.
  let opaquePosition: vscode.Position | undefined;
  if (staticAnalysis && sourceBinding && sourceBinding.body === undefined) {
    const before = text.slice(0, contextOffset), line = before.split("\n").at(-1)!;
    const visible = getCompletionContext(line, line.length, before, text.slice(contextOffset), syntax);
    const receiverContext = getStaticFallbackContext(line, line.length, before, text.slice(contextOffset), visible, syntax) ?? visible;
    const receiver = receiverContext && storedCompletionReceiver(receiverContext, text, contextOffset, syntax);
    const root = visible?.objectName && parseRuntimeMemberQuery(visible.objectName)?.root;
    if (sourceBinding.opaqueReceiver && root === sourceBinding.name) {
      opaquePosition = projection.toServerPosition(contextPosition);
    }
    if (receiver?.name === sourceBinding.name && (sourceBinding.opaqueReceiver || receiver.target !== "binding")) {
      opaquePosition = projection.document.positionAt(receiver.start);
    }
  }
  // Fuzzy requests move within a prefix. Preserve the original cursor
  // context for argument matching, literal values and unfinished-input repair.
  return {
    ...client.code2ProtocolConverter.asCompletionParams(projection.document, serverPosition, context),
    ...(staticAnalysis ? { rConsoleStaticAnalysis: true } : {}),
    ...(opaquePosition ? { rConsoleOpaqueFunction: sourceBinding!.name,
      rConsoleOpaqueFunctionPosition: opaquePosition } : {}),
    ...(parseSuffix !== undefined ? { rConsoleParseSuffix: parseSuffix } : {}),
    ...(bracket ? {
      rConsoleDataObject: bracket.objectName,
      rConsoleSubscriptOperator: bracket.operator,
      rConsoleSubscriptTags: bracket.argumentTags,
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
