// Spawns a fixture's own vitest run as a separate process, the way a real
// user's `npm test` would invoke vitest. depug's own test suite runs
// inside a vitest worker already; a subprocess is what makes the fixture
// run a fresh, independent vitest CLI invocation instead of nesting one
// vitest inside another.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const VITEST_BIN = fileURLToPath(new URL("../../node_modules/.bin/vitest", import.meta.url));

export interface FixtureRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export function runFixtureVitest(
  configPath: string,
  cwd: string,
  extraEnv: Record<string, string> = {},
): FixtureRunResult {
  // Strip the VITEST_*/TINYPOOL_* variables the outer worker runs under so
  // the spawned CLI starts as a fresh top-level run, not something that
  // thinks it's already inside a pool worker.
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("VITEST") || key.startsWith("TINYPOOL")) continue;
    env[key] = value;
  }
  Object.assign(env, extraEnv);

  const result = spawnSync(VITEST_BIN, ["run", "--config", configPath], {
    cwd,
    env: env as NodeJS.ProcessEnv,
    encoding: "utf8",
    timeout: 30_000,
  });

  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}
