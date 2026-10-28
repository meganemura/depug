import { defineStep, z } from "nukadoko";
import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { DEPUG_ROOT } from "./depug-cli.ts";

const CART = `export function subtotal(prices: number[]): number {
  let sum = 0;
  for (let i = 1; i < prices.length; i++) sum += prices[i]!;
  return sum;
}

export function checkout(prices: number[]): string {
  const amount = subtotal(prices);
  return \`total \${amount}\`;
}
`;

const NODE_MODULES = dirname(dirname(createRequire(import.meta.url).resolve("vitest/package.json")));

const TEST = `import { expect, it } from "vitest";
import { checkout } from "./src/cart.ts";

it("charges every item", () => {
  expect(checkout([5, 10, 20])).toBe("total 35");
});
`;

// The reporter is imported from this checkout's source, and node_modules is a
// link to the directory this checkout resolves packages from, not a path
// under it: `nuka run --base` runs the steps from a tree with no
// node_modules of its own. So the scenario runs the code under review
// without a build or an install. A git repository gives the evidence a code
// state to record.
export default defineStep({
  description:
    "Writes a scratch vitest project whose config adds depug's reporter beside the default one. `checkout` calls `subtotal`, which skips the first price, so the test's assertion fails after `subtotal` has returned.",
  pattern: "a vitest project with depug's reporter and a test that fails on a value a helper already returned",
  args: z.object({}),
  returns: z.object({
    root: z.string().describe("the scratch project's root"),
    testName: z.string().describe("the name of the failing test"),
    caller: z.string().describe("the function the test calls"),
    helper: z.string().describe("the function that produced the wrong value and returned before the assertion"),
    wrongTotal: z.string().describe("the value the helper returns, as depug prints it"),
    loopStart: z.string().describe("the first value of the helper's loop counter `i`, as depug prints it: the second price's index"),
    helperCall: z.string().describe("the call counter at the end of the helper call's function id: checkout calls subtotal once, so `#1`"),
  }),
  mutates: true,
  run({ scratch }) {
    const root = scratch.dir("depug-scenario-project");
    mkdirSync(join(root, "src"));
    symlinkSync(NODE_MODULES, join(root, "node_modules"), "dir");
    writeFileSync(
      join(root, "vitest.config.ts"),
      `import { defineConfig } from "vitest/config";
import DepugReporter from ${JSON.stringify(join(DEPUG_ROOT, "src/reporter.ts"))};

export default defineConfig({ test: { include: ["*.test.ts"], reporters: ["default", new DepugReporter()] } });
`,
    );
    writeFileSync(join(root, "src/cart.ts"), CART);
    writeFileSync(join(root, "cart.test.ts"), TEST);
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    return { root, testName: "charges every item", caller: "checkout", helper: "subtotal", wrongTotal: "30", loopStart: "1", helperCall: "#1" };
  },
});
