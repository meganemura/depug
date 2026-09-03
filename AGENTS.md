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

This repository is public, and the package is published to npm.
Write every file that way: README, docs, comments, commit messages, and the skill, all in English.
Do not write any reference to internal working documents into committed files.
When you want to reference one, write its substance in place.
Each further release is the owner's decision at that moment; see `docs/maintenance.md` for what to check before one.

## Settled design

The owner settled these points on 2026-09-02.
Change them only with the owner.
Three of them carry a measurement the owner delegated on the same day; the
next section records those and what each one measured.

- **Instrumentation runs in the transform pipeline.** TypeScript becomes JavaScript before it runs, and the test runner owns that step. depug rewrites the source of the target functions at that step and runs the rest unchanged. It does not use the V8 inspector for re-execution verbs.
- **Positions are literals.** The transform embeds the TypeScript line and column as literals in the rewritten code. Later transforms (esbuild, vite) keep literals unchanged, so the evidence carries TypeScript coordinates without source maps.
- **The always-on layer records failure text only in v0.1.** The evidence file holds the test name, the error, the stack in TypeScript coordinates, the rerun command, and the code state. It does not hold locals. A locals capture mode can come later without a change to the schema contract.
- **Declared types are a column from v0.1.** `probe` and `flt` show the observed shape of values next to the declared type. The declared type comes from the TypeScript compiler API at transform time as a shallow projection: property names, primitive kinds, optional, and null. depug does not run a full validator.
- **The verbs are the same as bulldogger.** `snap` (always on), `frames`, `preflight`, `flt`, `exec`, `probe`. A function id is `path:name@line:column#k`, where the position is the function's declaration in the TypeScript source and `k` counts entries of that function inside one test window.
- **vitest first, then node:test.** Both are supported in v0.1: vitest through a vite plugin, node:test through `module.registerHooks()` reached by `NODE_OPTIONS`. The transforms are shared. **jest stays out of v0.1** (the owner decided this on 2026-09-03): it would be the third development dependency, and the three real projects measured against depug all use vitest, so nothing measured asks for it yet. Its route in is unchanged when it is wanted, through jest's own transform setting.
- **The parser is `typescript`, versions 5.5.4 through 6.x.** It is the language vendor's parser. Speed matters less because the transform targets one file or one function per rerun. TypeScript 7 is a separate decision, recorded below.
- **Distribution is one npm package plus one bundled skill.** Files (JSON, JSONL) are the primary API. The schema is the public contract.
- **The package ships compiled JavaScript, built from the TypeScript sources.** Development runs the sources directly, with no build in the loop; publishing cannot. Node refuses to strip types from any file under `node_modules`, so a package of `.ts` is unusable on every path: its command line, a plain import, and a vitest config all fail with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`. Measured by installing the packed tarball into a fresh project on 2026-09-03.

## Decisions from the stage A measurements

The owner delegated these three on 2026-09-02, after the stage A numbers came in.

- **The function id carries the declaration position: `path:name@line:column#k`.**
  A name alone does not tell two JavaScript functions apart. Instrumenting hono at
  one pinned commit found 725 functions, 175 of them anonymous; under a name-only
  id, 250 of them (34.5%) shared an id with at least one other function, the worst
  case being 17 functions on one id. A shared id means a shared call counter, so
  `#k` addresses a different call on a rerun. Adding the position brought the same
  measurement to 0 of 792 functions sharing an id. The transform already measures
  the position for the event payload, so the id costs nothing extra.

- **`typescript` is a peer dependency at `>=5.5.4 <7.0.0`. depug does not support
  TypeScript 7 in v0.1.** TypeScript 7.0.2 is the `latest` tag on npm and is the
  native reimplementation. Its package exports `.` to a version file; the parser
  and the checker moved behind `typescript/unstable/ast` and
  `typescript/unstable/sync`. Reading the 409 names `unstable/ast` exports found
  node predicates, a scanner, a factory, and position helpers, and found no entry
  point that parses source text into a tree. depug parses one file per rerun, so
  that entry point is the one thing it cannot do without. The three versions in
  the supported range were each run against the whole hono corpus: 5.5.4, 5.9.3,
  and 6.0.3 all found the same 792 functions and projected the same declared
  types. Real projects measured on the same day sat inside this range: hono 6.0.3,
  vueuse 6.0.3, zod 5.5.4.

- **`snap` records failure text only, with no locals.** Classifying 155 real
  failures from hono's own history put 94.2% in the shape where the function that
  produced the wrong value had already returned before the assertion threw, so its
  locals were gone from the stack. The remaining 5.8% came from three distinct
  bugs. Capturing locals in JavaScript means the V8 inspector, which binds depug
  to one runtime, adds a coordinate translation, and costs 93 µs for every caught
  exception, thrown or not. `frames` and `flt` reach the same values on demand for
  the 5.8%. A locals capture mode can arrive later without changing the schema.

## Mechanism facts

Measurements from 2026-09-02 on Node v26.7.0 (arm64, macOS) with vitest 4.1.11.

- `NODE_OPTIONS="--import <collector.mjs>"` reaches vitest workers in both the `forks` pool and the `threads` pool. The default pool is `forks`.
- A vitest reporter gets the failed test name and its absolute module path from `onTestCaseResult`. `onInit(ctx)` gives the `Vitest` instance, and `ctx.getSeed()` returns the value of `--sequence.seed`. This is enough to print `vitest run "<file>" -t "<name>" --sequence.seed=<seed>`.
- vitest runs test files through the vite module runner. In the V8 inspector, `callFrame.url` is empty for those scripts. The `Debugger.scriptParsed` event still carries the url by `scriptId`.
- An in-process `node:inspector` session can pause on a caught exception and read locals. The cost was 93 µs per exception for one scope read, and 1.007x on a loop with no exception. The pause handler must use callback style and must not await. depug does not use this path in v0.1, and this fact documents why locals are possible later.
- `node --random-seed=42` makes `Math.random` return the same sequence on two runs.

Measurements from 2026-09-03 on the same machine, for node:test.

- `NODE_OPTIONS="--import <hook>"` reaches the child process node:test starts for each test file. A plain `--import` on the command line does not: it applies to the parent.
- A `module.registerHooks()` load hook receives the original TypeScript, types intact (`format: "module-typescript"`), so a rewrite there sees what the author wrote.
- A `beforeEach` registered from a preloaded module fires for tests declared later and receives the test's name.
- Node's type stripping preserves positions, so a stack from a stripped `.ts` file already carries the author's line and column. An assertion on line 7 reported line 7.
- A `test:fail` event fires for an enclosing `describe` too, carrying `failureType: "subtestsFailed"`; the test's own event carries `testCodeFailure`, and the thrown error is in `details.error.cause`.
- `--test-name-pattern` matches a test's own name, not its full path. Repeating the flag widens the selection rather than narrowing it, so one nested test cannot be named exactly.

## Conventions

- Add a dependency only with the owner's approval. Pin the exact version. The version must be at least 7 days old with no later security fix.
- `typescript` is a peer dependency. Do not add a second parser.
- Do not publish to npm, do not create a remote, and do not change visibility without the owner's explicit approval at that moment.
- Write design decisions in `docs/design-decisions.md` with the measurement that supports each one.
- Write the evidence schema in `docs/evidence-schema.md` before the code that writes it.
- Tests prove behavior by running the code path. A test that checks a string in the source does not count.
- Keep each commit to one semantic unit. Write comments about why, not what.
- Write for the reader who has no access to this session. Give numbers, the measured range, and what was not measured.
