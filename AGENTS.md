# AGENTS.md

Context for agents that work in this repository.

## What this is

depug turns TypeScript test runs into structured evidence for coding agents.
A failed test prints the absolute path of an evidence file and the command that reruns that one test.
Re-execution verbs run one test again with instrumentation and write what happened as files.

depug is the TypeScript sibling of bulldogger, a Ruby gem by the same owner.
The name follows the same rule: bulldogger sits one letter group away from `debugger`, and depug sits one letter away from `debug`, the npm package with the largest download count in this area.

The proposition is the same as bulldogger.
Agents guess runtime values from source.
depug replaces that guess with a measurement.
A test is a rerun device with the same inputs, so depug keeps no continuous record and reruns the test when an agent asks a question.

## Visibility

This repository is public.
Write all files in English: README, docs, comments, commit messages, and the skill.
Do not write any reference to internal working documents into committed files.
When you want to reference one, write its substance in place.

## Settled design

The owner settled these points on 2026-09-02.
Change them only with the owner.

- **Instrumentation runs in the transform pipeline.** TypeScript becomes JavaScript before it runs, and the test runner owns that step. depug rewrites the source of the target functions at that step and runs the rest unchanged. It does not use the V8 inspector for re-execution verbs.
- **Positions are literals.** The transform embeds the TypeScript line and column as literals in the rewritten code. Later transforms (esbuild, vite) keep literals unchanged, so the evidence carries TypeScript coordinates without source maps.
- **The always-on layer records failure text only in v0.1.** The evidence file holds the test name, the error, the stack in TypeScript coordinates, the rerun command, and the code state. It does not hold locals. A locals capture mode can come later without a change to the schema contract.
- **Declared types are a column from v0.1.** `probe` and `flt` show the observed shape of values next to the declared type. The declared type comes from the TypeScript compiler API at transform time as a shallow projection: property names, primitive kinds, optional, and null. depug does not run a full validator.
- **The verbs are the same as bulldogger.** `snap` (always on), `frames`, `preflight`, `flt`, `exec`, `probe`. A function id is `path:function#k`, where `k` counts entries of that function inside one test window.
- **vitest first.** node:test comes next through `module.registerHooks()`. jest comes after that through its transform setting.
- **The parser is `typescript`.** It is the language vendor's parser. Speed matters less because the transform targets one file or one function per rerun.
- **Distribution is one npm package plus one bundled skill.** Files (JSON, JSONL) are the primary API. The schema is the public contract.

## Mechanism facts

Measurements from 2026-09-02 on Node v26.7.0 (arm64, macOS) with vitest 4.1.11.

- `NODE_OPTIONS="--import <collector.mjs>"` reaches vitest workers in both the `forks` pool and the `threads` pool. The default pool is `forks`.
- A vitest reporter gets the failed test name and its absolute module path from `onTestCaseResult`. `onInit(ctx)` gives the `Vitest` instance, and `ctx.getSeed()` returns the value of `--sequence.seed`. This is enough to print `vitest run "<file>" -t "<name>" --sequence.seed=<seed>`.
- vitest runs test files through the vite module runner. In the V8 inspector, `callFrame.url` is empty for those scripts. The `Debugger.scriptParsed` event still carries the url by `scriptId`.
- An in-process `node:inspector` session can pause on a caught exception and read locals. The cost was 93 µs per exception for one scope read, and 1.007x on a loop with no exception. The pause handler must use callback style and must not await. depug does not use this path in v0.1, and this fact documents why locals are possible later.
- `node --random-seed=42` makes `Math.random` return the same sequence on two runs.

## Conventions

- Add a dependency only with the owner's approval. Pin the exact version. The version must be at least 7 days old with no later security fix.
- `typescript` is a peer dependency. Do not add a second parser.
- Do not publish to npm, do not create a remote, and do not change visibility without the owner's explicit approval at that moment.
- Write design decisions in `docs/design-decisions.md` with the measurement that supports each one.
- Write the evidence schema in `docs/evidence-schema.md` before the code that writes it.
- Tests prove behavior by running the code path. A test that checks a string in the source does not count.
- Keep each commit to one semantic unit. Write comments about why, not what.
- Write for the reader who has no access to this session. Give numbers, the measured range, and what was not measured.
