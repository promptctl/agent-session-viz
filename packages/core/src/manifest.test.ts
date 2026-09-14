import { expect, test } from "vitest";
import manifest from "../package.json" with { type: "json" };

// [LAW:effects-at-boundaries] core is the pure layer; a runtime dependency is the first way I/O gets in.
test("core declares no runtime dependencies", () => {
  expect(manifest).not.toHaveProperty("dependencies");
  expect(manifest).not.toHaveProperty("peerDependencies");
  expect(manifest).not.toHaveProperty("optionalDependencies");
});
