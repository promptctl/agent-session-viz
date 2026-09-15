import { describe, expect, test } from "vitest";
import { groupRequests, parseLine } from "./index.js";

const at = (second: number): string => `2026-01-01T00:00:${String(second).padStart(2, "0")}.000Z`;

type Counts = { input: number; output: number; cacheCreation: number; cacheRead: number; thinking?: number | null };

const usage = ({ input, output, cacheCreation, cacheRead, thinking }: Counts) => ({
  input_tokens: input,
  output_tokens: output,
  cache_creation_input_tokens: cacheCreation,
  cache_read_input_tokens: cacheRead,
  ...(thinking === undefined ? {} : { output_tokens_details: thinking === null ? null : { thinking_tokens: thinking } }),
});

const assistant = (block: {
  uuid: string;
  second: number;
  requestId?: string;
  model?: string;
  stop: string | null;
  counts: Counts;
}): string =>
  JSON.stringify({
    type: "assistant",
    uuid: block.uuid,
    parentUuid: null,
    timestamp: at(block.second),
    sessionId: "s1",
    isSidechain: false,
    ...(block.requestId === undefined ? {} : { requestId: block.requestId }),
    message: {
      id: `msg_${block.requestId ?? block.uuid}`,
      model: block.model ?? "model-a",
      stop_reason: block.stop,
      content: [{ type: "text", text: "x" }],
      usage: usage(block.counts),
    },
  });

const prompt = (uuid: string, second: number): string =>
  JSON.stringify({
    type: "user",
    uuid,
    parentUuid: null,
    timestamp: at(second),
    sessionId: "s1",
    isSidechain: false,
    message: { role: "user", content: "go" },
  });

const group = (...lines: string[]) => groupRequests(lines.map((line) => parseLine(line)));

describe("groupRequests", () => {
  test("groups a response's blocks into one request, numbered in session order", () => {
    const requests = group(
      prompt("p1", 0),
      assistant({ uuid: "a1", second: 1, requestId: "req_a", stop: null, counts: { input: 3, output: 2, cacheCreation: 50, cacheRead: 0, thinking: 1 } }),
      assistant({ uuid: "a2", second: 2, requestId: "req_a", stop: "tool_use", counts: { input: 3, output: 40, cacheCreation: 50, cacheRead: 0, thinking: 9 } }),
      prompt("p2", 3),
      assistant({ uuid: "b1", second: 4, requestId: "req_b", stop: "end_turn", counts: { input: 1, output: 7, cacheCreation: 5, cacheRead: 50, thinking: 0 } }),
    );
    expect(requests).toEqual([
      {
        requestId: "req_a",
        seq: 0,
        model: "model-a",
        usage: { input_tokens: 3, output_tokens: 40, cache_creation_input_tokens: 50, cache_read_input_tokens: 0 },
        thinking_tokens: 9,
        firstTimestamp: at(1),
        lastTimestamp: at(2),
      },
      {
        requestId: "req_b",
        seq: 1,
        model: "model-a",
        usage: { input_tokens: 1, output_tokens: 7, cache_creation_input_tokens: 5, cache_read_input_tokens: 50 },
        thinking_tokens: 0,
        firstTimestamp: at(4),
        lastTimestamp: at(4),
      },
    ]);
  });

  test("takes usage from the last block, since earlier blocks carry mid-stream counts", () => {
    const [request] = group(
      assistant({ uuid: "a1", second: 1, requestId: "req_a", stop: null, counts: { input: 2, output: 2, cacheCreation: 10, cacheRead: 0 } }),
      assistant({ uuid: "a2", second: 2, requestId: "req_a", stop: null, counts: { input: 2, output: 2, cacheCreation: 10, cacheRead: 0, thinking: null } }),
      assistant({ uuid: "a3", second: 3, requestId: "req_a", stop: "end_turn", counts: { input: 4, output: 300, cacheCreation: 12, cacheRead: 10, thinking: 120 } }),
    );
    expect(request).toMatchObject({
      usage: { input_tokens: 4, output_tokens: 300, cache_creation_input_tokens: 12, cache_read_input_tokens: 10 },
      thinking_tokens: 120,
    });
  });

  test("a request whose version reports no thinking count has null, not zero", () => {
    const [request] = group(
      assistant({ uuid: "a1", second: 1, requestId: "req_a", stop: "end_turn", counts: { input: 1, output: 1, cacheCreation: 0, cacheRead: 0 } }),
    );
    expect(request?.thinking_tokens).toBeNull();
  });

  test("leaves out harness-written messages, including one that shares a real request's id", () => {
    const requests = group(
      assistant({ uuid: "a1", second: 1, requestId: "req_a", stop: "refusal", counts: { input: 2, output: 278, cacheCreation: 90, cacheRead: 10, thinking: 5 } }),
      assistant({ uuid: "s1", second: 1, requestId: "req_a", model: "<synthetic>", stop: "refusal", counts: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 } }),
      assistant({ uuid: "s2", second: 2, model: "<synthetic>", stop: "stop_sequence", counts: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 } }),
    );
    expect(requests).toEqual([
      expect.objectContaining({
        requestId: "req_a",
        model: "model-a",
        usage: { input_tokens: 2, output_tokens: 278, cache_creation_input_tokens: 90, cache_read_input_tokens: 10 },
        lastTimestamp: at(1),
      }),
    ]);
  });

  test("records core cannot read change no request", () => {
    const block = { uuid: "a1", second: 1, requestId: "req_a", stop: "end_turn", counts: { input: 1, output: 1, cacheCreation: 0, cacheRead: 0 } };
    expect(group(assistant(block), "{truncated", '{"type":"future-record"}')).toEqual(group(assistant(block)));
  });

  test("no records make no requests", () => {
    expect(groupRequests([])).toEqual([]);
  });
});
