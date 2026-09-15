import { expect, test } from "vitest";
import { type Attachment, type ContentBlock, parseLine, type Record } from "./index.js";
import { fixtures } from "./testing/fixtures.js";

function fallback(level: string, value: ContentBlock | Attachment): string[] {
  if (value.type === "unknown") return [`${level} of unknown type ${JSON.stringify(value.raw["type"])}`];
  if (value.type === "malformed") return [`${level} ${value.reason}`];
  return [];
}

// Every unknown or malformed value at any depth of a record, described.
function fallbacks(record: Record): string[] {
  switch (record.type) {
    case "unknown":
      return [`record of unknown type ${JSON.stringify(record.raw["type"])}`];
    case "malformed":
      return [`record ${record.reason}`];
    case "assistant":
      return record.message.content.flatMap((block) => fallback("block", block));
    case "user":
      return typeof record.message.content === "string"
        ? []
        : record.message.content.flatMap((block) => fallback("block", block));
    case "attachment":
      return fallback("attachment", record.attachment);
    default:
      return [];
  }
}

test("fixtures/projects holds at least one transcript", () => {
  expect(fixtures).not.toHaveLength(0);
});

test.each(fixtures)("$name parses with no unknown or malformed value", ({ lines }) => {
  expect(lines.map((line) => parseLine(line)).flatMap(fallbacks)).toEqual([]);
});
