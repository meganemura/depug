#!/usr/bin/env node
// The executable. It holds no logic of its own so the CLI stays testable
// without spawning a process.
import { run } from "../src/cli.ts";

const result = run(process.argv.slice(2));
process.stdout.write(result.stdout);
process.exit(result.exitCode);
