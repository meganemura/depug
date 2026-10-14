// Runs depug from source against a scratch project, the way an agent
// pastes a verb in front of the rerun line the reporter printed. The line
// goes through a shell because it is shell text: the test name is quoted.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const DEPUG_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const BIN = fileURLToPath(new URL("../../bin/depug.ts", import.meta.url));

export interface VerbResult {
  exitCode: number;
  stdout: string;
}

export function runVerb(verb: string[], rerunLine: string, root: string): VerbResult {
  const quoted = [process.execPath, BIN, ...verb].map((word) => `'${word.replaceAll("'", "'\\''")}'`).join(" ");
  const result = spawnSync("sh", ["-c", `${quoted} -- ${rerunLine}`], { cwd: root, encoding: "utf8" });
  if (result.error) throw result.error;
  return { exitCode: result.status ?? 1, stdout: result.stdout };
}

/** The file path a verb prints on its `depug <verb>: <path>` line. */
export function outputFile(stdout: string, verb: string): string {
  const path = new RegExp(`^depug ${verb}: (.+)$`, "m").exec(stdout)?.[1];
  if (path === undefined) throw new Error(`depug ${verb} printed no output file:\n${stdout}`);
  return path;
}

export function readJsonLines(path: string): Record<string, unknown>[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
