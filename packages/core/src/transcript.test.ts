import { describe, expect, test } from "vitest";
import { parseLine } from "./index.js";

const chain = {
  uuid: "u2",
  parentUuid: "u1",
  timestamp: "2026-01-01T00:00:00.000Z",
  sessionId: "s1",
  isSidechain: false,
};

const usage = {
  input_tokens: 2,
  output_tokens: 5,
  cache_creation_input_tokens: 100,
  cache_read_input_tokens: 900,
  output_tokens_details: { thinking_tokens: 3 },
};

const assistantLine = (content: unknown[], messageUsage: unknown = usage): string =>
  JSON.stringify({
    type: "assistant",
    ...chain,
    requestId: "req_1",
    message: { id: "msg_1", model: "model-a", stop_reason: "tool_use", content, usage: messageUsage },
  });

describe("parseLine", () => {
  test("parses an assistant record with its usage and content blocks", () => {
    const content = [
      { type: "text", text: "listing" },
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
    ];
    expect(parseLine(assistantLine(content))).toEqual({
      type: "assistant",
      ...chain,
      requestId: "req_1",
      message: { id: "msg_1", model: "model-a", stop_reason: "tool_use", content, usage },
    });
  });

  test("resolves the flags the format omits when false", () => {
    const line = JSON.stringify({
      type: "user",
      ...chain,
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "ok" },
          { type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "no" }], is_error: true },
        ],
      },
    });
    expect(parseLine(line)).toMatchObject({
      type: "user",
      isMeta: false,
      message: {
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "ok", is_error: false },
          { type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "no" }], is_error: true },
        ],
      },
    });
  });

  test("a truncated line is malformed and keeps its bytes", () => {
    const truncated = assistantLine([{ type: "text", text: "listing" }]).slice(0, 40);
    expect(parseLine(truncated)).toEqual({
      type: "malformed",
      line: truncated,
      reason: expect.stringContaining("JSON"),
    });
  });

  test("an empty line is malformed", () => {
    expect(parseLine("")).toEqual({ type: "malformed", line: "", reason: expect.stringContaining("JSON") });
  });

  test.each(["42", "[]", "null", '{"uuid":"u1"}', '{"type":7}'])(
    "JSON that is not an object with a string type is malformed: %s",
    (line) => {
      expect(parseLine(line)).toMatchObject({ type: "malformed", line });
    },
  );

  test.each(["compaction-marker", "toString", "constructor"])("an unrecognized record type is unknown with its JSON intact: %s", (type) => {
    const raw = { type, payload: { nested: [1, 2] } };
    expect(parseLine(JSON.stringify(raw))).toEqual({ type: "unknown", raw });
  });

  test("a recognized record type with a field of the wrong shape is malformed, naming the field", () => {
    const line = assistantLine([], { ...usage, input_tokens: "2" });
    expect(parseLine(line)).toEqual({
      type: "malformed",
      line,
      reason: "assistant: message.usage.input_tokens: expected number, got string",
    });
  });

  test("an unrecognized content block type is unknown and its record still parses", () => {
    const block = { type: "image", source: { kind: "base64" } };
    expect(parseLine(assistantLine([{ type: "text", text: "a" }, block]))).toMatchObject({
      type: "assistant",
      message: { content: [{ type: "text", text: "a" }, { type: "unknown", raw: block }] },
    });
  });

  test("a recognized content block with the wrong shape is malformed and its record still parses", () => {
    const block = { type: "tool_use", id: "t1", input: {} };
    expect(parseLine(assistantLine([block]))).toMatchObject({
      type: "assistant",
      message: { content: [{ type: "malformed", raw: block, reason: "tool_use: message.content[0].name: expected string, got nothing" }] },
    });
  });

  test("an unrecognized attachment type is unknown and its record keeps its place in the chain", () => {
    const attachment = { type: "future_reminder", text: "later" };
    expect(parseLine(JSON.stringify({ type: "attachment", ...chain, attachment }))).toEqual({
      type: "attachment",
      ...chain,
      attachment: { type: "unknown", raw: attachment },
    });
  });
});
