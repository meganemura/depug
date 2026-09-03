# Changelog

## Unreleased

Nothing has been published. The version in `package.json` is `0.0.0` and
the package is marked private, so what follows describes the work that
will become `0.1.0`.

### A failed test now names the evidence and the command that reaches it

An agent debugging a failed test infers what a value was from the code
around it. depug reruns the test with instrumentation and reports what the
value actually was. The whole entry point is two lines a failure prints:
an absolute path to an evidence file, and the command that runs that one
test again.

The parenthetical between them says whether that file can answer.
Classifying 155 real failures from one project's history put 94.2% in the
shape where the function that produced the wrong value had already
returned before the error was built, leaving nothing in the stack for any
capture to find. That is the case the rest of the tool exists for, and the
snapshot says so rather than presenting frames that cannot help.

- **`snap`, the always-on layer.** A reporter writes one evidence file for
  each failed test and prints the two lines. It records failure text and no
  local variables: capturing locals in JavaScript means the V8 inspector,
  which binds the tool to one runtime and costs 93 µs for every caught
  exception whether or not a test fails, and `frames` and `flt` reach the
  same values on demand for the 5.8% where they would have helped.
- **`frames`** indexes every application call one test makes. `--at
  <file>:<line>` converts a line into the calls whose function holds it,
  innermost first.
- **`preflight`** runs the same test twice in separate processes and
  compares the calls, because every other verb addresses a call by its
  index inside the test. Measured on 80 tests across 53 files of one
  project, 80 matched their own second run.
- **`probe`** records what one function received and returned, beside what
  it was declared to receive and return, with the values that crossed.
- **`flt`** follows one call statement by statement, carrying only what
  changed since the previous record, folding a loop's middle into a marker
  that says how many iterations went unobserved.
- **`exec`** evaluates an expression inside one call, at one line, on one
  visit, in that line's own scope. It is the only verb that changes what
  the program computes, and only the launcher arms it.

### Instrumentation happens in the transform, not in a debugger

TypeScript becomes JavaScript before it runs and the test runner owns that
step, so depug rewrites the target functions there. The rewrite splices
text at offsets read from the AST and never prints the tree back out: a
printer chooses its own line breaks, and every position depug records
would then describe the printed text rather than the file the author
wrote. No inserted string carries a newline, so the line count cannot
change, and the recorded line and column go in as literals that a later
esbuild or vite pass moves but does not rewrite.

The consequence worth stating is that this is not tied to a runner.
vitest owns the transform step through a vite plugin and Node owns it
through `module.registerHooks`, and both are supported with the same
transforms, the same ids, and the same files on the other side.

### What the files say when they do not know

- An unpaired `suspend`: the awaited value rejected before the resume
  record ran.
- `parameters_not_observed` in a probe: a destructured parameter has no
  single binding to read, so the value is unknown rather than `undefined`.
- `skipped_iterations` in a trace: a loop's folded middle went unobserved.
- A trace with no statement records: the call's body is a single
  expression, and the work is in a function it hands back.
- Events under `test.concurrent`: two concurrent tests in one worker share
  one current-test pointer, so `test` on a record can name the wrong one.
  The call ids stay correct.

### Cost

The always-on layer writes a file when a test fails and does nothing
otherwise. A verb's instrumentation is about 67 ms for each worker
process, dominated by loading `typescript`, plus about 46 ns for each
recorded event. That is a formula rather than a multiplier because a ratio
only describes the workload it was taken on: the same instrumentation
measured 1.12x on heavy function bodies and 2.04x on four million trivial
calls. Instrumenting one project's whole suite ran 4961 tests to the same
result as without it, 14.31 s against a 14 s baseline.

### How it is checked

The suite type-checks the source, then runs example tests and
property-based tests together. The properties are the ones the design
rests on: that a rewrite never changes a file's line count, over generated
TypeScript rather than only over fixtures; that a rerun command selects
the test it names and no other; that a function id survives being written
and read back; and that counts cover every call while only the rendered
samples are capped.

Two rewrites are also run over a real codebase at a pinned commit, because
fixtures only cover the shapes their author thought of. That check is what
found the one rewrite bug that reached a real project.

### Scope

vitest and node:test, on Node, with `typescript` as a peer dependency from
5.5.4 up to but not including 7. TypeScript 7 moved its parser behind an
unstable entry point that offers no way to turn source text into a tree,
and depug parses one file for each re-execution. jest is left for later;
its route in is the same one the other two took, through the transform
step it owns.
