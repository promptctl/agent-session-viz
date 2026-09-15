/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, test } from "vitest";
import { type Attachment, type ContentBlock, parseLine, type Record } from "./index.js";

// Real transcripts are personal data. They sit in the gitignored fixtures/ directory and
// are found by scanning, never named here. On a fresh clone the directory is missing and
// this file fails at collection, which is the intent: never a skip.
const fixtures = join(import.meta.dirname, "../../../fixtures/projects");
const transcripts = readdirSync(fixtures, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
  .map((entry) => join(entry.parentPath, entry.name));

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
  expect(transcripts).not.toHaveLength(0);
});

test.each(transcripts.map((path) => [relative(fixtures, path), path]))(
  "%s parses with no unknown or malformed value",
  (_name, path) => {
    const text = readFileSync(path, "utf8");
    // A finished transcript ends in a newline; anything after the last one is a partial line.
    expect(text.endsWith("\n")).toBe(true);
    const records = text.slice(0, -1).split("\n").map((line) => parseLine(line));
    expect(records.flatMap(fallbacks)).toEqual([]);
  },
);
