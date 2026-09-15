/// <reference types="node" />
// The local transcript fixtures, for tests only.
//
// Real transcripts are personal data. They sit in the gitignored fixtures/ directory, are
// found by scanning, and are identified in committed code only by their sha256. On a
// fresh clone the directory is missing, and every test file importing this fails at
// collection. That is the intent: never a skip.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(import.meta.dirname, "../../../../fixtures/projects");

export type Fixture = { readonly name: string; readonly sha256: string; readonly lines: readonly string[] };

export const fixtures: readonly Fixture[] = readdirSync(root, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
  .map((entry) => {
    const path = join(entry.parentPath, entry.name);
    const name = relative(root, path);
    const bytes = readFileSync(path);
    const text = bytes.toString("utf8");
    // A finished transcript ends in a newline; anything after the last one is a partial line.
    if (!text.endsWith("\n")) throw new Error(`${name} does not end in a newline, so its last line is partial`);
    return { name, sha256: createHash("sha256").update(bytes).digest("hex"), lines: text.slice(0, -1).split("\n") };
  });
