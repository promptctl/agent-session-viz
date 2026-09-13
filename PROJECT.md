# agent-session-viz

**A dissection table for one agent session.** You put a Claude Code session on the
table, and the tool answers: *what the fuck used all my tokens?* Then it keeps
answering harder questions about the same session, and eventually about all of them.

## The problem

A Claude Code session is a JSONL transcript that grows as you work. It records
everything: your prompts, the model's replies, every tool call and its result, and a
thick layer of harness plumbing (hook outputs, reminders, attachments, snapshots)
that you never see in the terminal but that the model reads on every turn. Token
spend is a function of all of it, and today none of it is visible. You find out the
context is full when it is full. You find out a session was expensive when the bill
arrives. You cannot point at the thing that cost you.

The transcripts are the only complete record of what happened. They are also large
(a working corpus of several gigabytes across thousands of sessions), append-only,
and still being written while you would like to be reading them.

## What this is

A local web app. A Node backend reads transcripts and keeps a SQLite index of them.
A React front end renders one session as an object you can inspect from several
angles. The backend tails the transcript as the session continues, and the front end
updates as new turns land. Nothing leaves the machine.

The first session on the table is a real session from the author's own corpus, kept on disk in the gitignored `fixtures/` directory and never committed.

## The atom

The unit of cost is the **API request**: one round trip from the harness to the
model. Every request re-sends the whole context and pays for it (as fresh input,
cache write, or cache read) plus the output it generates. A session is a sequence of
requests; a "turn" is the requests between two human prompts. Everything the tool
says about tokens is a sum over requests, sliced by *what was in the context* and
*why it was there*.

That second question is the heart of the tool. Every byte in the context has a
provenance: a user prompt, a tool result, a skill body, a hook's injected text, a
system reminder, the model's own prior thinking. Attributing cost to provenance is
what turns "you used 400k tokens" into "the skill listing costs you 60k on every
request and a single bash result cost 40k that you carried for the rest of the
session."

## Milestone 1: one session, dissected

Done looks like: open the app, pick the session above, and answer without reading
the JSONL by hand:

- How much did this session cost, in tokens, split by input / cache write / cache
  read / output, and how did that grow over the session's life?
- What is in the context right now, by category and by individual item, and what
  did each item cost across every request it was carried through?
- Which single events were the expensive ones? Which tool calls returned the largest
  results? Which harness injections recur on every turn and what do they add up to?
- What did each turn actually do? A readable timeline of prompts, tool calls,
  results, and replies, with the plumbing visible but distinguishable from the
  conversation.
- Where are the cache boundaries? When did a cache miss happen and what changed to
  cause it?

And it keeps being true while the session is still running.

## Milestone 2: across sessions

The same index over the whole corpus. Which sessions were the expensive ones? Which
tools, skills, hooks, and projects dominate spend over a week? Do the same injected
texts show up in every session, and what is the total tax? This milestone is
deliberately unspecified beyond that; milestone 1 will teach us which questions are
worth asking at scale.

## Shape of the system

Three parts, one direction of flow:

1. **Ingest** reads transcript files and writes the index. This is the only place the
   filesystem is touched and the only place the transcript format is understood. It
   is a cursor over an append-only file: first load and live tailing are the same
   operation started at different offsets.
2. **Index** is the SQLite database. It is derived, disposable, and rebuildable from
   the transcripts at any time. The transcripts are the truth; the index is a fast
   way to ask them questions.
3. **Views** are the React front end reading from the index through the backend and
   receiving live updates as the index changes. All analysis is a query over the
   index; the views never see a transcript.

## What we already know about the territory

Small findings from a first look at the target transcript. They shape the design
enough to record now, and each one gets properly investigated later.

- One API response is written as several JSONL records (one per content block), and
  each carries the same usage object. Summing usage per record overcounts several
  times over. Cost belongs to the request, not the record.
- Most records in a transcript are not conversation. Harness attachments (hook
  outputs, reminders, snapshots, listings) outnumber user and assistant messages
  combined, and some individual attachments are the largest records in the file.
- Tool results are the other heavyweight. A few results account for most of the
  bytes; large ones are also spilled to a sidecar directory next to the transcript.
- Line lengths span four orders of magnitude, so parsing must stream by line, never
  load a file whole.

## Principles that will guide the technical work

- **The transcript is the one source of truth.** Every number the UI shows must be
  reproducible from the JSONL by a second implementation. If the index and the file
  disagree, the file wins and the index is rebuilt.
- **Cost is attributed, never merely totaled.** A number without a provenance is a
  number nobody can act on.
- **The plumbing is data, not noise.** Hook output, reminders, and attachments are
  first-class items with their own cost, because they are what the user cannot see
  anywhere else.
- **Live is not a mode.** Reading a finished transcript and reading a growing one
  are the same path. There is no separate "watch" code.
- **Loud on the unknown.** A record type or content shape the ingester does not
  recognize is surfaced as such, counted, and visible in the UI. It is never
  dropped.

## Stack

Node backend, SQLite index, React front end with a component library, Tailwind, and
zustand for client state. Library choices within that stack are a technical decision
for later.

## Out of scope

Editing transcripts. Sending anything anywhere. Replaying sessions against the API.
Any analysis that requires data not present in the transcripts.
