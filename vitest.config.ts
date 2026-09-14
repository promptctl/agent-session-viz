import { readdirSync } from "node:fs";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // [LAW:one-source-of-truth] tests resolve workspace packages through their `source`
  // export to src, never to a dist that may be stale or not yet built. Vitest resolves
  // node-side imports through the ssr environment, so the condition goes there.
  environments: { ssr: { resolve: { conditions: ["source"] } } },
  test: {
    // extends: true is what carries the condition into each package's project;
    // a bare "packages/*" glob does not inherit root config.
    projects: readdirSync("packages").map((name) => ({
      extends: true,
      test: { name: `@asv/${name}`, root: `packages/${name}` },
    })),
  },
});
