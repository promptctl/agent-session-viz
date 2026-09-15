# Architecture

The concrete system that implements [PROJECT.md](PROJECT.md). This document is the
level below the founding doc: what the parts are, what flows between them, what the
index stores, and the decisions already made. It is not a schema dump or an API
reference; those live in code once they exist.

## The one cut that matters

The system is split first by **pure versus effectful**, and only then by feature.

```
 transcripts on disk ──▶ ingest ──▶ SQLite index ──▶ server ──▶ web
                          (I/O)      (derived)       (HTTP/SSE)  (React)
                            │                           │
                            ▼                           ▼
                        core: parse                core: analyze
                       (pure, no I/O)             (pure, no I/O)
```

`core` knows the transcript format and the cost model and touches nothing outside
its arguments. `ingest` is the one place the filesystem is read. `index` is the one
place SQLite is written. `server` is the one place HTTP happens. `web` renders.
Dependencies point one way: `web → server → core`, `ingest → core`, and nothing
points back.

## Packages

A pnpm workspace, TypeScript throughout.

| Package | Purpose in one sentence | Depends on |
|---|---|---|
| `core` | Parse a transcript line into a typed record, and compute cost and attribution from typed records. | nothing |
| `server` | Ingest transcript files into SQLite, serve queries over HTTP, push change notifications over SSE. | `core` |
| `web` | Render one session from the server's queries and stay current via SSE. | `core` (types only) |

`core` has no runtime dependencies. Its tests need no mocks because it does no I/O.

## Core: the transcript as types

A transcript line parses into a `Record`, a discriminated union on the JSONL `type`
field. The variants the target transcript exhibits: `user`, `assistant`, `attachment`,
`system`, plus the session-state records (`mode`, `permission-mode`, `last-prompt`,
`ai-title`, `cost-state`, `file-history-*`, `bridge-session`, `atis-latch`). Two
variants exist that the file format does not name:

- `unknown` holds any record whose `type` the parser does not recognize, with the
  raw JSON intact.
- `malformed` holds any line core cannot read as a record: not valid JSON, not an
  object with a string `type`, or a recognized type whose fields do not fit. It keeps
  the raw bytes and the reason.

Both keep the record's link in the parent chain (`uuid` and `parentUuid`) whenever the
line has one, so a record core cannot read never cuts its descendants off from the root.

Both are stored, counted, and shown. The parser never drops a line.

Message content parses the same way: a `ContentBlock` union of `text`, `thinking`,
`tool_use`, `tool_result`, and `unknown`. Attachments parse into an `Attachment`
union keyed on `attachment.type`, with the same `unknown` arm. Both nested unions also
have a `malformed` arm for a recognized type whose fields do not fit, so a bad block or
attachment is surfaced without losing its record's place in the parent chain.

Records link by `parentUuid`. The chain from any record back to the root is the
context the model saw at that point. Attachments are in the chain, so hook output and
reminders are attributable exactly like messages.

## Core: the cost model

Three derived concepts sit on top of records.

**Request.** One API round trip, keyed by `requestId`. The harness writes one
`assistant` record per content block, and every block repeats the whole `usage`
object. A request is the group of those records; its usage is taken once. Its
`seq` is its position in the session's request order.

**Item.** Anything that occupies context: a user prompt, an assistant text or
thinking block, a tool call, a tool result, an attachment, the system prompt, the
tool definitions. Every item has a `kind`, a `provenance` (which tool, which hook,
which skill, which attachment type), a byte length, and an estimated token count.

**Membership.** For each request, the set of items in its ancestor chain. Because
the chain only grows between compactions, membership is stored as a range: an item
enters context at request `seq_from` and stays through `seq_to`, where `seq_to` is
open for the live head and closed by a compaction or a rewind. Cost carried by an
item is the sum, over the requests it was a member of, of its share of that
request's input.

**Cache boundary.** Request N's `cache_read` compared with request N-1's
`cache_read + cache_creation` tells whether the prefix survived. A drop is a cache
miss; the items that entered between the two requests are the suspects, and the
tool shows them.

**Token estimation is estimation.** Transcripts record usage per request, not per
item. Per-item tokens come from a byte-based estimator calibrated against the
request deltas actually observed: the `cache_creation` of request N is the ground
truth for the items that entered since N-1, and the estimator is scaled to fit it.
Every attributed number in the UI is labeled as estimated; every request-level
number is exact.

## Ingest: one cursor, no modes

`ingest(file, offset)` reads complete lines from `offset` to end of file, parses each
through `core`, and writes the resulting records, requests, items, and membership
ranges to the index in one transaction that also advances the stored offset for that
file. A partial trailing line is not consumed; the offset stops before it.

First load is `ingest(file, 0)`. Live tailing is a filesystem watcher that calls
`ingest(file, storedOffset)` when the file changes. There is no watch mode, no
backfill mode, no separate code path. If the file shrinks below the stored offset,
the file was rewritten and the session is reingested from zero.

Sessions are discovered by scanning the projects directory. A session is the
transcript `<id>.jsonl`, its `tool-results/` sidecar directory, and any
`subagents/agent-*.jsonl` files beside it. Subagent transcripts ingest as sessions of
their own with a `parent_session` link, so their cost rolls up to the parent and is
also inspectable alone.

The corpus is a few gigabytes across a few thousand files, none over 50 MB. Ingest
streams by line and never holds a file in memory. The index is disposable: deleting
it and restarting rebuilds everything from the transcripts, and that rebuild is the
documented recovery for every inconsistency.

## Index: what SQLite holds

SQLite in WAL mode via `better-sqlite3`, synchronous, one writer (ingest) and many
readers (server queries). Tables, by purpose:

- `files`: path, session, byte offset ingested so far, size and mtime last seen.
- `sessions`: id, project, parent session, first and last timestamp, current title.
- `records`: one row per JSONL line. Session, line number, uuid, parent uuid, type,
  timestamp, byte length, and the raw JSON for records that need it (attachments,
  unknown, malformed). This is the audit trail back to the file.
- `requests`: one row per `requestId`. Session, seq, model, the four usage numbers,
  thinking tokens, timestamp of first and last block.
- `items`: one row per context item. Session, kind, provenance, byte length,
  estimated tokens, the record that produced it, and for tool results the tool call
  they answer.
- `membership`: item, `seq_from`, `seq_to`.

Everything the UI shows is a query over these six tables. Aggregations (cost by
provenance, cost over time, largest items, cache misses) are SQL, computed on read,
not stored. If a query proves slow on a large session it gets an index, not a cache
table.

## Server: queries and one event stream

A small HTTP server (Hono) exposing:

- Session list and session summary.
- Per-session queries: requests over time, context composition at request N, items
  ranked by carried cost, cost by provenance, the timeline of records, cache
  boundaries.
- One SSE endpoint per session that emits `advanced` with the new request seq and
  record count whenever ingest commits for that session.

The SSE event carries no data beyond "something changed and here is how far". The
client refetches the queries it is showing. Payloads stay small, the server stays
stateless beyond the index, and a reconnect needs no catch-up protocol because a
refetch is the catch-up.

## Web: one session, several lenses

Vite, React, Tailwind, shadcn/ui components. Server state (query results) lives in
TanStack Query so refetch-on-SSE is one line per view. Client state (which session,
which request is selected, which lens is open, filters) lives in zustand.

Milestone 1 lenses, each one a component reading one or two queries:

- **Spend**: totals by token class, and the curve of context size and cumulative
  cost across requests, with cache misses marked.
- **Context**: what is in the context at the selected request, grouped by kind and
  provenance, each item with its size and its cost carried so far.
- **Heavy hitters**: items ranked by carried cost, tool results ranked by size,
  recurring attachments with their per-turn and total cost.
- **Timeline**: the records in order, conversation and plumbing visually distinct,
  click to select a request and drive the other lenses.

Selecting a request in any lens selects it everywhere. That selection is the only
piece of cross-lens state.

## Decisions already made

- **Byte-based token estimation, calibrated per request.** There is no offline
  tokenizer for these models. Estimation labeled as such beats a false exact number.
- **Membership as ranges, not per-request rows.** A thousand-request session with
  ten thousand items would otherwise be ten million rows for a mostly-linear chain.
- **SSE, not WebSocket.** Traffic is one-directional and low-volume.
- **Invalidation, not deltas, over SSE.** The queries are the contract; pushing
  deltas would be a second contract that must agree with them.
- **Synchronous SQLite.** Ingest transactions and reads are short; the simplicity is
  worth more than an async driver.
- **No configuration flags at launch.** The projects directory is the one input,
  defaulting to `~/.claude/projects`.

## Open questions, to be settled by building

- How rewinds and compaction appear in the transcript, and therefore how a
  membership range closes. The target session has branching in its parent chain
  that needs explanation before the range model is final.
- Whether `tool-results/` sidecar files were in the model's context in full or
  truncated, which decides their item size.
- Whether the calibrated estimator is accurate enough per item to rank items
  honestly, or whether ranking should stay at the provenance level.
- Which of the session-state record types carry anything worth surfacing.

## Verification

Done for the ingest and cost model means: the target session parses with zero
`unknown` and zero `malformed` records, the request count and per-class token totals
match an independent computation over the raw file, and the sum of item estimates
entering between two requests fits the observed `cache_creation` within a stated
tolerance. Those checks are tests in `core` and `server`, run against a local copy
of the target transcript under `fixtures/`, and they are the bar for milestone 1's
numbers. Real transcripts are personal data and are never committed: `fixtures/` is
gitignored, so a fresh clone has no fixture until one is copied in by hand.
