// Requests: the API round trips a session made, recovered from its assistant records.

import type { Record } from "./transcript.js";

type AssistantRecord = Extract<Record, { readonly type: "assistant" }>;
type ApiBlock = AssistantRecord & { readonly requestId: string };

export type Request = {
  readonly requestId: string;
  // Position in the session's request order, counting from 0.
  readonly seq: number;
  readonly model: string;
  readonly usage: {
    readonly input_tokens: number;
    readonly output_tokens: number;
    readonly cache_creation_input_tokens: number;
    readonly cache_read_input_tokens: number;
  };
  // null when the transcript's Claude Code version did not report it.
  readonly thinking_tokens: number | null;
  readonly firstTimestamp: string;
  readonly lastTimestamp: string;
};

// Assistant messages the harness writes itself, such as a refusal notice. One can share a
// real response's requestId, with zero usage, but it is no part of what the API returned.
const SYNTHETIC_MODEL = "<synthetic>";

// [LAW:single-enforcer] the one definition of which assistant records are API output.
const isApiBlock = (record: Record): record is ApiBlock =>
  record.type === "assistant" && record.requestId !== undefined && record.message.model !== SYNTHETIC_MODEL;

export function groupRequests(records: readonly Record[]): readonly Request[] {
  // Map.groupBy keeps groups in order of first appearance, which is session order.
  const groups = Map.groupBy(records.filter(isApiBlock), (block) => block.requestId);
  return [...groups].map(([requestId, blocks], seq) => {
    // [LAW:types-are-the-program] exception: Map.groupBy never yields an empty group, but
    // its type does not say so.
    const first = blocks[0]!;
    const last = blocks.at(-1)!;
    // Blocks are written as the response streams, each carrying usage as of that moment,
    // and the counts only grow, so the last block's usage is the request's.
    const { output_tokens_details, ...counts } = last.message.usage;
    return {
      requestId,
      seq,
      model: last.message.model,
      usage: {
        input_tokens: counts.input_tokens,
        output_tokens: counts.output_tokens,
        cache_creation_input_tokens: counts.cache_creation_input_tokens,
        cache_read_input_tokens: counts.cache_read_input_tokens,
      },
      thinking_tokens: output_tokens_details?.thinking_tokens ?? null,
      firstTimestamp: first.timestamp,
      lastTimestamp: last.timestamp,
    };
  });
}
