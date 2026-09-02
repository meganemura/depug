// Installs the injection collector before any test file runs, and writes
// what it recorded when the run ends.
//
// The runtime reads the launcher's token here. An injected expression
// still runs its guard in an ordinary test run; the guard asks, and an
// unarmed runtime says no. Deciding it in one place means the gate cannot
// be bypassed by a rewrite that forgot to check.
import { afterAll } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installGlobalExecRuntime, renderExecValue } from "./exec-runtime.ts";

const runtime = installGlobalExecRuntime({
  fidPrefix: process.env.DEPUG_EXEC_FID_PREFIX ?? "",
  targetCall: Number(process.env.DEPUG_EXEC_CALL ?? "1"),
  targetLine: Number(process.env.DEPUG_EXEC_LINE ?? "0"),
  targetVisit: Number(process.env.DEPUG_EXEC_VISIT ?? "1"),
});

// The rewrite calls this by name, so it has to exist as a global too.
(globalThis as { __depugExecRender?: typeof renderExecValue }).__depugExecRender = renderExecValue;

afterAll(() => {
  const dir = process.env.DEPUG_EXEC_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  const lines = runtime.dump().map((record) => JSON.stringify(record));
  writeFileSync(join(dir, `exec-${process.pid}.jsonl`), lines.length ? `${lines.join("\n")}\n` : "");
});
