import { expect, test } from "vitest";
import { groupRequests, parseLine, type Request } from "./index.js";
import { fixtures } from "./testing/fixtures.js";

// Expected totals per fixture, keyed by the transcript's sha256 so no path or session id
// is committed. Each entry was computed without core, by this jq program over the raw file:
//
//   jq -s '[.[] | select(.type=="assistant" and .requestId != null and .message.model != "<synthetic>")]
//     | group_by(.requestId) | map(last) | map(.message.usage)
//     | { requests: length, input: (map(.input_tokens)|add), output: (map(.output_tokens)|add),
//         cache_creation: (map(.cache_creation_input_tokens)|add),
//         cache_read: (map(.cache_read_input_tokens)|add),
//         thinking: (map(.output_tokens_details.thinking_tokens)|add) }'
//
// jq's add skips nulls, so thinking sums only the requests that report it.
const expected = new Map([
  [
    "c166e6addf766bc255f091d4878c90b95e1a4789072b97df33e40ee1c34d7ff0",
    { requests: 31, input: 812, output: 52890, cache_creation: 252457, cache_read: 5969945, thinking: 26687 },
  ],
]);

const total = (requests: readonly Request[], count: (request: Request) => number): number =>
  requests.reduce((sum, request) => sum + count(request), 0);

test.each(fixtures)("$name groups into the requests and totals jq computed", ({ sha256, lines }) => {
  const requests = groupRequests(lines.map((line) => parseLine(line)));
  expect(expected.has(sha256), `no jq totals recorded for fixture sha256 ${sha256}`).toBe(true);
  expect({
    requests: requests.length,
    input: total(requests, (r) => r.usage.input_tokens),
    output: total(requests, (r) => r.usage.output_tokens),
    cache_creation: total(requests, (r) => r.usage.cache_creation_input_tokens),
    cache_read: total(requests, (r) => r.usage.cache_read_input_tokens),
    thinking: total(requests, (r) => r.thinking_tokens ?? 0),
  }).toEqual(expected.get(sha256));
});
