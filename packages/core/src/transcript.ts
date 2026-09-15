// The Claude Code transcript format: one JSONL line parsed into one Record.
//
// Arms type the fields that say what a record put into context, where it sits in the
// parent chain, and what it cost. Other fields stay in the raw line, which ingest keeps.
// A field is optional exactly when some Claude Code version omits it.

import {
  absentAs,
  array,
  boolean,
  either,
  type Infer,
  json,
  type MalformedArm,
  nullable,
  number,
  object,
  optional,
  parseJson,
  string,
  tagged,
  type UnknownArm,
  variant,
} from "./decode.js";

const strings = array(string);

// A tool result is plain text or the API's array of content parts. The parts stay JSON
// until something needs to read inside them.
const contentBlock = tagged(
  variant("text", { text: string }),
  variant("thinking", { thinking: string, signature: string }),
  variant("tool_use", { id: string, name: string, input: json }),
  variant("tool_result", {
    tool_use_id: string,
    content: either(string, array(json)),
    is_error: absentAs(boolean, false),
  }),
);
export type ContentBlock = Infer<typeof contentBlock>;

const hook = { hookName: string, hookEvent: string, toolUseID: string };

const attachment = tagged(
  variant("hook_success", {
    ...hook,
    command: string,
    content: string,
    stdout: string,
    stderr: string,
    exitCode: number,
    durationMs: number,
  }),
  variant("hook_additional_context", { ...hook, content: strings }),
  variant("hook_system_message", { ...hook, content: string }),
  variant("hook_blocking_error", { ...hook, blockingError: json }),
  variant("bash_output_audience_note", { toolUseID: string }),
  variant("batching_reminder_sent", { model: string, text: string }),
  variant("total_tokens_reminder", { text: string }),
  variant("silent_turn_reminder", { text: string }),
  variant("model", { text: string, identity: json }),
  variant("date", { date: string }),
  variant("edited_text_file", { filename: string, snippet: string }),
  variant("skill_listing", { content: string, names: optional(strings), skillCount: number, isInitial: boolean }),
  variant("prompt_snapshot", {
    systemPrompt: strings,
    tools: optional(array(object({ name: string, description: string, schema: optional(json) }))),
    cliPrefix: optional(string),
  }),
  variant("command_permissions", { allowedTools: strings }),
  variant("deferred_tools_delta", { addedNames: strings, addedLines: strings, removedNames: strings }),
  variant("deferred_tools_record", { entries: array(json) }),
  variant("agent_listing_delta", { addedTypes: strings, addedLines: strings, removedTypes: strings }),
  variant("mcp_instructions_delta", { addedNames: strings, addedBlocks: strings, removedNames: strings }),
  variant("instructions", { files: array(json) }),
  variant("environment", { snapshot: json }),
  variant("session_context", { context: json }),
  variant("auto_mode", { bashFirstSteer: optional(string) }),
  variant("remote_session_change", { url: nullable(string), pr: string, commit: string }),
);
export type Attachment = Infer<typeof attachment>;

// A record's place in the parent chain. The chain from a record back to the root is the
// context the model saw at that point.
const link = object({ uuid: string, parentUuid: nullable(string) });
export type ChainLink = Infer<typeof link>;

const chain = { ...link.shape, timestamp: string, sessionId: string, isSidechain: boolean };

// One API response is written as one assistant record per content block, each repeating
// the full usage, so usage belongs to the requestId and never sums over records.
const usage = object({
  input_tokens: number,
  output_tokens: number,
  cache_creation_input_tokens: number,
  cache_read_input_tokens: number,
  // Versions omit it or write null; both mean the thinking count was not reported.
  output_tokens_details: absentAs(nullable(object({ thinking_tokens: number })), null),
});

const record = tagged(
  variant("user", {
    ...chain,
    isMeta: absentAs(boolean, false),
    message: object({ content: either(string, array(contentBlock)) }),
  }),
  variant("assistant", {
    ...chain,
    // Absent on messages the harness writes itself (model "<synthetic>"), which are no API request.
    requestId: optional(string),
    message: object({
      id: string,
      model: string,
      stop_reason: nullable(string),
      content: array(contentBlock),
      usage,
    }),
  }),
  variant("attachment", { ...chain, attachment }),
  variant("system", { ...chain, subtype: string, content: optional(string) }),
  // Session-state records sit outside the chain.
  variant("mode", { mode: string }),
  variant("permission-mode", { permissionMode: string }),
  variant("last-prompt", { leafUuid: optional(string), lastPrompt: optional(string) }),
  variant("ai-title", { aiTitle: string }),
  variant("cost-state", { totalCostUSD: number, modelUsage: json }),
  variant("file-history-snapshot", { messageId: string, isSnapshotUpdate: boolean, snapshot: json }),
  variant("file-history-delta", { messageId: string, snapshotMessageId: string, trackingPath: string, backup: json }),
  variant("bridge-session", { bridgeSessionId: string, lastSequenceNum: number }),
  variant("atis-latch", { atis: string }),
);

// A record core cannot read still keeps its chain link whenever the line has one, so it
// never cuts its descendants off from the root. At this level a broken line keeps its
// bytes, not a JSON value: the line may not be JSON at all.
export type UnknownRecord = UnknownArm & { readonly chain: ChainLink | null };
export type MalformedLine = {
  readonly type: "malformed";
  readonly line: string;
  readonly reason: string;
  readonly chain: ChainLink | null;
};
export type Record = Exclude<Infer<typeof record>, UnknownArm | MalformedArm> | UnknownRecord | MalformedLine;

// Never throws and never drops: every line, including an empty or truncated one, is
// exactly one Record.
export function parseLine(line: string): Record {
  const parsed = parseJson(line);
  if (!parsed.ok) return { type: "malformed", line, reason: parsed.reason, chain: null };
  const linked = link(parsed.value, "");
  const chainLink = linked.ok ? linked.value : null;
  const decoded = record(parsed.value, "");
  if (!decoded.ok) return { type: "malformed", line, reason: decoded.reason, chain: chainLink };
  const value = decoded.value;
  switch (value.type) {
    case "malformed":
      return { type: "malformed", line, reason: value.reason, chain: chainLink };
    case "unknown":
      return { ...value, chain: chainLink };
    default:
      return value;
  }
}
