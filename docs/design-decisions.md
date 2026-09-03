# Design decisions

Each decision below names the measurement that supports it.

Unless an entry says otherwise, every measurement ran on 2026-09-02 on one
machine: a MacBook Air (Apple M4), macOS 26.5.2, Node v26.7.0 (arm64),
vitest 4.1.11, typescript 6.0.3. The corpus is honojs/hono at commit
`e2740d5a1bd0b4254e517e3af8b60789284bc7bd`: 188 TypeScript files under
`src/`, excluding tests, holding 1159 functions with a body. No number here
was taken on a second machine.

## Where the ideas come from

Four concepts come from published work on agent debugging interfaces
(arXiv:2604.24212): running a failing test again and collecting
statement-level detail for one selected frame during that run; the frame
lifetime trace, which prints entry arguments and then per-statement state
changes; the fold that keeps a loop's first and last iterations; and
statement injection for what-if analysis.

Six decisions come from bulldogger, the Ruby sibling this project shares an
owner with: stateless verbs that operate over evidence files, files as the
primary interface, the code-state marker on every artifact, naming a frame
by its call index inside one test window, restricting the re-execution
verbs to the application's own code, and the rule that heavy collection
starts only through an explicit verb.

The decisions below are the ones this project made for TypeScript, where
the mechanism differs from Ruby's.

## Instrument in the transform pipeline, not the inspector (2026-09-02)

TypeScript becomes JavaScript before it runs, and the test runner owns that
step. depug rewrites the target functions at that step and lets the rest
of the run proceed unchanged.

The alternative was the V8 inspector. A measurement of that path found
93 µs for each caught exception to pause, read one frame's scope, and
resume, against 1.37 µs for the same exception with no inspector attached.
The cost applies to every exception the application catches and handles,
not only to the one that fails a test.

The transform path costs 46.37 ns for each recorded event (n=7, median,
2,000,000 calls per trial), plus a fixed cost for each worker process.

Instrumenting the corpus produced 0 files with a changed line count and 0
files with a new syntax error, across all 188.

The inspector also binds the tool to one runtime and reports positions in
the transformed coordinate system. The transform path runs wherever the
test runner runs.

Not measured: the transform path under runtimes other than Node, and the
inspector path's cost for reading every frame rather than one.

## Report the cost as a proportionality, not a ratio (2026-09-02)

Two workloads, built to hold event count and per-call body cost against
each other, measured these whole-suite wall times (n=5 per configuration,
median, one warm-up run discarded):

| workload | events per run | plain | instrumented | ratio |
|---|---:|---:|---:|---:|
| 20 calls, heavy bodies | 40 | 809.6 ms | 910.2 ms | 1.124 |
| 2,000,000 calls, trivial bodies | 4,000,000 | 253.9 ms | 517.0 ms | 2.036 |

Neither ratio describes depug. The measured overhead decomposes into a
fixed cost for each worker process, near 67 ms and dominated by loading the
`typescript` package (66.72 ms, n=5, median), plus 46.37 ns for each
recorded event.

That formula predicted the second workload's overhead at about 252 ms
against 263.1 ms measured, inside the spread the instrumented trials showed
on their own (503.3 ms to 588.7 ms).

A reader can apply the formula to a call graph. A ratio only describes the
workload it was taken on.

Not measured: whether the `typescript` load is paid once for each worker
process and shared across many test files, or once for each file. Both
benchmark fixtures held one test file, so the two cases look the same
there.

## Splice text at AST offsets, and never print the tree (2026-09-02)

The transform reads offsets from the TypeScript AST and inserts strings
into the original source at those offsets. It does not build a new tree and
print it.

A printer re-emits the whole tree and chooses its own line breaks and
indentation. Every position depug embeds would then describe the printed
text rather than the file the author wrote.

Every inserted string is free of newlines, so an insertion can only make an
existing line longer. Across the 188-file corpus the line count matched for
every file.

## Positions are literals (2026-09-02)

The transform writes the TypeScript line and column into the rewritten code
as number literals. A later transform, esbuild or vite, moves that code but
leaves a literal alone, so the recorded position still names the
TypeScript source.

The check runs a real vitest process over a fixture whose functions are
declared on lines 1, 5, and 14, through the plugin, and reads the positions
back out of the recorded events. All three matched. This removes the source
map layer from the evidence path.

## Wrap the whole body, rather than each return (2026-09-02)

The exit record fires from a `finally` clause wrapped around the function's
original body.

Inserting a record at each `return` and `throw` statement covers only the
exits the function writes itself. When a function this one calls throws,
control leaves through no statement of its own, and the entry record would
stand with no exit beside it. A `finally` clause runs exactly once for
every way out: return, throw, or falling off the end.

Tests execute a return, a throw, and a function holding its own
`try`/`finally`, and check that each produces one entry and one exit.

## Merge the two insertions when a body is empty (2026-09-02)

For a body with nothing between its braces, the entry offset and the exit
offset are the same character. Two insertions at one offset make the result
depend on the order the splice loop happens to apply them, and the order it
applied produced text like `() => {}catch(e){...}`.

Six of the 188 corpus files hold such a body and produced unparseable
output. Every hand-written fixture passed, because no fixture had an empty
body in it.

The fix places one merged string at that single offset, so no order remains
to get wrong. After it, the corpus reported 0 files with a new syntax
error.

This is the entry that argues for the corpus check itself: the fixtures
covered the shapes their author thought of.

## Instrument every function that has a body (2026-09-02)

An arrow written `() => x` has no block to splice into. An earlier version
skipped it, along with constructors and accessors, and covered 792 of the
corpus's 1191 function-like nodes: 69.5%. The 316 expression-body arrows
alone are more than a quarter of that codebase's functions, and a call
index that silently omits them sends a reader looking for a call that ran.

The transform now rewrites such an arrow into a block: `(p) => expr`
becomes `(p) => {<entry>return expr<exit>}`. Both inserted strings are free
of newlines and the expression itself does not move, so a body spread over
several lines keeps its own line breaks and the file keeps its line count.
Constructors and accessors already had block bodies and only needed adding
to the set.

Coverage after the change: 1159 of 1191, or 97.3%. The remaining 32 are
declarations with no body at all -- 9 abstract methods and 23 overload
signatures -- so every function that runs is instrumented.

Verified by running, not only by parsing: hono's own suite under full
instrumentation passed 4961 tests with 44 skipped, across 147 files, the
same counts the suite reports without depug. Wall time was 14.31 s against
a 14 s baseline on the same machine, one run each.

A constructor reports as `constructor` and an accessor under its property
name, because a reader scanning an index gets nothing from a fourth
`<anonymous>`.

## Two traps around `await` that a parser cannot see (2026-09-02)

The transform wraps each `await` so the run records where a function
suspended and where it resumed.

The wrapper starts with an identifier, not an opening parenthesis. A line
that starts with `(` can join the previous line when that line ends without
a semicolon, turning `f()` followed by `await g()` into a call on `f()`'s
result. That reading is valid syntax, so counting parser diagnostics cannot
find it.

Insertions can also land on one offset, between a function's entry text and
an `await` wrapper that touches it, or between two directly nested
`await`s. Placing them in the wrong order moves a `const` declaration after
code that reads it, which throws at runtime and parses clean. Each
insertion now carries which boundary it belongs to and the order it was
made, and ties resolve by those.

Both shapes are checked by executing the instrumented code, because a
diagnostic count cannot distinguish either one from correct output. Neither
shape occurred in the corpus; both were written by hand.

## Walk the tree iteratively (2026-09-03)

Every rewrite walked the AST by recursion, which costs one JavaScript
frame per level. A binary expression is one level per term, so a long
enough chain exhausts the stack and takes the whole run down with it. On
this machine the limit sat between 2000 and 4000 terms.

Running the rewrites over four codebases found it: TypeScript's own
repository keeps a regression test built from a single enormous
expression, and the rewrite crashed on it. The shape is rare in code a
person writes and ordinary in code a program wrote, and the always-on
rewrite meets every file in a project, so a crash there takes out a verb
rather than one file.

The walk now runs over an explicit stack, in one module the five rewrites
share. Sharing it is the same decision as sharing the naming rule: five
copies of a traversal are five places for one to stop matching the others,
and this project has already spent that mistake twice.

Sweeping the four codebases after the change, with all four rewrites over
every file:

| codebase | files | functions | violations |
|---|---:|---:|---:|
| hono | 359 | 8,892 | 0 |
| excalidraw | 623 | 9,549 | 0 |
| angular | 5,410 | 66,916 | 0 |
| TypeScript | 11,984 | 39,323 | 15 |

A violation is a changed line count or a new syntax error. The fifteen are
all one shape: conformance fixtures such as `async (await) => {}`, which
TypeScript's parser accepts so that a later pass can report the grammar
error, and which Node rejects outright. The input could not run before the
rewrite touched it.

Not measured: whether any codebase holds a chain deep enough to exhaust
the stack the iterative walk uses for its own queue, which is heap rather
than stack and so bounded by memory instead.

## A function id carries its declaration position (2026-09-02)

A function id reads `path:name@line:column#k`, where `k` counts entries of
that function inside one test window.

bulldogger names a frame by path, method, and call index, which suits Ruby,
where a method has a name. JavaScript hands out far fewer names. Measured
on the corpus, 407 of 1159 functions were anonymous, and under a name-only
scheme 513 of them (44.3%) would have shared an id with at least one other
function, with 28 functions on the worst single id. Functions sharing an id
share the call counter, so `#k` reaches a different call after a rerun, and
`flt` and `exec` would trace something other than what the caller named.

The same measurement with the position in the id: 0 of 1159 functions
shared an id. The transform already reads the position for the event
payload, so the id costs nothing more to build.

The position is stable for one code state, which every artifact already
records, and `flt` and `exec` already refuse an index whose code state does
not match their own run.

## The call index survives interleaving (2026-09-02)

An `await` lets another call to the same function run before the first one
finishes. The call index has to name the same call on a second run anyway,
or every re-execution verb addresses the wrong thing.

A fixture runs two calls to one function inside `Promise.all`, with
different numbers of `await` points, so which one resumes first is decided
by scheduling rather than by call order. The recorded stream shows the
second call exiting before the first. Two separate processes produced
identical id sequences across 7 comparisons.

On the corpus, 80 tests sampled at an even stride across 4002 tests, in 53
files, each ran twice in separate processes with a fixed seed:

| metric | matched |
|---|---|
| entry events only | 80 / 80 |
| entry, suspend, resume, and exit | 80 / 80 |

Two of the 80 recorded no events at all, so 78 comparisons had content. 31
exercised at least one real `await` path through application code. Entry
counts for one test ranged from 0 to 12,868.

Not measured: more than two concurrent calls, and interleaving driven by
timers rather than by microtasks.

## A rejected await leaves its suspend unpaired (2026-09-02)

When an awaited value rejects, evaluation throws before the resume record
runs, so the stream holds a suspend with no resume after it. The function's
own exit record still fires, so entries and exits stay paired.

This is a property of the recording, not a defect in it: a reader must
treat an unpaired suspend as "still pending, or rejected", and the schema
names it that way. `for await (const x of it)` is a different syntax node
and is not recorded at all.

## Keep the observer out of the compiler's process (2026-09-02)

Reading a declared type needs the TypeScript compiler. Reading a runtime
value must not.

Starting the compiler on the corpus cost 158.57 ms for `createProgram` plus
64.51 ms for `getTypeChecker` (n=5, medians), about 223.5 ms including one
cold `getTypeAtLocation`. Across the whole `tsconfig` rather than one file,
the same sequence cost about 578.9 ms.

depug pays that once for each re-execution, which is why the projection
happens at transform time and the observation happens in a module that
imports nothing from the compiler.

Warm `getTypeAtLocation` calls had a median of 0.026 ms to 0.028 ms, and
individual calls in the same sample ranged from 0.003 ms to 8 ms. The
spread follows how complex the type at that node is, not how warm the
process is, so the median alone would mislead.

Not measured: disk cache state and competing processes were left
uncontrolled.

## Show the observed shape beside the declared type (2026-09-02)

`probe` and `flt` print what a value was next to what it was declared to
be:

```
observed: {id: string, email: undefined (3 / 5 calls) | string (2 / 5 calls)}
declared: {email: string, id: number}
```

The projection is shallow: property names, primitive kinds, whether a
property is optional, and whether the type admits null. It does not
recurse into a nested object, and it is not a validator.

Four boundaries let a value of the wrong shape reach code that is correctly
typed: `JSON.parse`, an `as` cast, `process.env`, and an `any` parameter.
A fixture exercises three of them and the tests execute those paths, then
compare what actually arrived against the declaration. A control case
checks that values matching the declaration report nothing, so the
comparison is not simply always complaining.

Where the declared type is `any` or `unknown`, the comparison stays silent,
because those accept every runtime kind. This is the shape the tool is most
useful around: the annotation stopped making a claim, and only the run can
say what came through.

## Support TypeScript 5.5.4 through 6.x, and not 7 (2026-09-02)

TypeScript 7.0.2 holds the `latest` tag on npm and is the native
reimplementation. Its package points its main export at a version file, and
moves the parser and the checker behind `typescript/unstable/ast` and
`typescript/unstable/sync`. Reading the 409 names `unstable/ast` exports
found node predicates, a scanner, a factory, and position helpers, and
found no entry point that turns source text into a tree. depug parses one
file for each re-execution, so that entry point is the one piece it cannot
work without.

Three versions ran against the whole corpus. Each found the same 792
functions and projected the same declared types: 5.5.4, 5.9.3, and 6.0.3.
Three projects measured the same day sat inside that range: hono and
vueuse on 6.0.3, zod on 5.5.4.

Not measured: whether `unstable/sync`, which connects to a separate
process, can return a parsed tree, and what starting that process would
cost for each re-execution. Versions below 5.5.4 were not tried.

The range in the heading described what a host had to have. On 2026-09-03
depug began carrying one of those versions itself, and the entry "Ship the
parser, do not ask the host for it" records why. What that entry did not
change is everything above: TypeScript 7 still offers no entry point that
turns source text into a tree, which is why the version depug carries is
6.0.3.

## Record failure text, and reach for values on demand (2026-09-02)

The always-on layer writes the test name, the error, the stack in
TypeScript coordinates, the rerun command, and the code state. It does not
capture local variables.

Failures from hono's own history decide this. Candidate commits touching
both a test file and a non-test file were replayed by checking out the
parent commit, laying the commit's test files over it, and running them:
155 failures from 43 commits.

| shape | count | share |
|---|---:|---:|
| the failing value's producer had already returned | 146 | 94.2% |
| an application frame remained on the stack | 9 | 5.8% |

Locals help only the second shape, and those 9 failures came from 3
distinct bugs; 6 of them were sibling tests hitting one error. For that
shape, `frames` and `flt` reach the same values by rerunning the test.

Capturing locals in JavaScript means the inspector, and the cost above.
Leaving them out keeps the always-on layer to one mechanism that runs
wherever the test runner runs.

The sample leans on commits whose fix arrived with a test, and covers
2026-08-04 to 2026-08-28 of a history reaching back to 2021-12-15. It
describes one project.

A locals mode can arrive later. The evidence schema carries a capture mode
field so that adding one does not change the contract.

## Attribute events to a test with the runner's own hooks (2026-09-02)

depug learns which test is running from `beforeEach` and `afterEach`, which
vitest exposes publicly, rather than rewriting each `it(name, fn)` call.

Under `test.concurrent` this misattributes. Both `beforeEach` callbacks run
before either test body reaches its first `await`, so one test's name is
recorded for both, and the first `afterEach` clears the name while the
other test is still running. A test asserts this by finding a call whose
entry and exit carry different test names, which correct attribution could
never produce.

The limit is recorded rather than worked around, because sequential tests
are the common case and the public hook API costs nothing to use.

## The published name carries a scope (2026-09-03)

The name sits one letter from `debug`, and that is what the registry
rejects. `npm publish` answered 403, "Package name too similar to existing
packages depd, debug, pug, defu". Those four draw 707,321,997,
150,039,831, 39,199,373, and 3,867,039 downloads a week. The check runs on
the upload and not on a name lookup, so the registry answering 404 for a
name says only that nobody holds it. The name was read that way on
2026-09-02 and recorded as free.

The package is `@meganemura/depug`. A scope was the one route the registry
itself offered, and it keeps the name the design rests on. The command
stays `depug`, because an executable's name is independent of the package
that carries it, and so does the `tool.name` in every evidence file.

What was not measured: whether an organization named `depug` could hold
the package instead. npmjs.com answers 403 to an unauthenticated request
for any organization page, so the name could not be read without creating
one.

## Ship the parser, do not ask the host for it (2026-09-03)

`typescript` was a peer dependency at `>=5.5.4 <7.0.0`. Every project
that tried to install depug had `typescript@7.0.2`, and npm refused the
tree rather than installing anything:

```
npm error ERESOLVE unable to resolve dependency tree
npm error Found: typescript@7.0.2
npm error peer typescript@">=5.5.4 <7.0.0" from @meganemura/depug@0.1.0
```

Installing past that with `--legacy-peer-deps` produces half a tool. The
reporter imports no parser, so it still writes evidence and still prints
a rerun command; every verb that command names then fails to parse. A
tool whose printed next step does not work is worse than one that refused
to install.

`typescript` is now a dependency, pinned to exactly 6.0.3, and no longer
a development dependency. depug reads its own copy and never the host's,
so the host's version stops being a question.

The cost is one more copy of the parser on a host that is not already on
6.0.3: 24,346,827 bytes over 140 files by the registry's own count, and
24 MB on disk in a tree that measured 89 MB in total. A host already on
6.0.3 shares one copy; `npm ls typescript` reported `deduped` and the
tree held one directory named `typescript`.

What was measured, on a host with `typescript@7.0.2` at its root and a
`tsconfig.json` that TypeScript 7 wrote itself:

- The install succeeds. `npm ls typescript` shows 7.0.2 at the root and
  6.0.3 under depug.
- The copy that runs is the nested one. Node answered 7.0.2 from the
  host's root and 6.0.3 from inside depug's own directory.
- Both reporters and all five re-execution verbs ran.
- The declared-type column still reads the host's own types. Probing a
  function returning an interface with an optional property and a
  nullable one reported `nickname` as optional and `team` as accepting
  null.

That last one holds for a reason worth writing down: depug never reads
the host's `tsconfig.json`. It builds its program with fixed options
(`src/verbs/probe.ts`), so a configuration written for a compiler depug
does not carry cannot reach the checker that depug does carry.

A host on 5.x carries the second copy too, measured after the release on
a host pinned to 5.5.4: two directories named `typescript`, 5.5.4 at the
root and 6.0.3 under depug, 24 MB of the tree's 80 MB. An exact pin
shares a copy only with a host on that same version, so 6.0.3 is the one
case that dedupes. depug ran there as it does on 7: the reporter printed
its two lines, `frames` found the call, and the declared-type column read
the host's interface, optional property included.

TypeScript 7 as depug's own parser is unchanged and still blocked, for
the reason in the entry above.

## Declare the boundary in package.json, and count what it holds (2026-09-04)

`frames` and `preflight` need a line between the application and
everything else, because the index they build is of application calls.
0.1.1 drew that line at `src/`, moved only by `--include`, once per
command. Three projects installed it on the same day and two of them
crossed that line within the hour.

One keeps its code in `cli/` and `viewer/lib/`, so every verb needed
`--include cli` and still could not reach the second directory. The other
put the function it wanted to watch inside the test file, and `frames`
answered `calls: 0` -- correctly, because a test file is never
instrumented, and unhelpfully, because nothing said so.

Two changes. The boundary can be declared once, in `package.json` under
`depug.include`, as one path or a list; `--include` can be repeated and
still wins. And an empty index now says how many files each directory
holds that depug would instrument, where the boundary came from, and
whether the test's own file sits outside it.

`package.json` rather than a config file, because it is the one file
every project already has and a second file is one more thing to find.
Rather than detection, because `cli/` and `viewer/lib/` are not something
a heuristic finds without also finding `scripts/` and `test/`. The count
is of candidates on disk, not of files the run loaded: it separates "the
path holds nothing" from "the path holds code this test never imported",
which is the distinction a reader of zero needs, and it costs one
directory walk only on the path that already produced nothing.

A test file stays outside the boundary whichever set it falls in. The
index exists to name the application's calls, and a test's own helpers
would put the test's scaffolding in it under the same ids as the code.
The note says that rather than pointing at `--include tests/`, which
would not work.

Measured: the fixture with its test at the root and code under `src/`,
given `--include src --include nowhere`, records the same calls as with
`src` alone, and an implementation keeping only the last occurrence
records none. What was not measured: a project whose `package.json` field
and vitest `projects` disagree about which package holds the code; the
first prefix is the one that names the project.

## An exact pin does not move on its own (2026-09-04)

Not a decision about depug so much as one recorded because two of the
three projects using it pin exactly, which the dependency rules here ask
for, and the obvious upgrade command is silent about doing nothing.

With `"@meganemura/depug": "0.1.1"` in `package.json` and 0.1.2 on the
registry, `npm install --save-dev --save-exact @meganemura/depug` leaves
the pin at 0.1.1 and exits 0. `npm update @meganemura/depug` also leaves
it. Both read as success. `npm install ...@latest` moves it, and `npm
outdated` is the command that reports the gap:

```
Package            Current  Wanted  Latest
@meganemura/depug    0.1.1   0.1.1   0.1.2
```

Measured on 2026-09-04 in a fresh project, after a real upgrade in
another project stopped on the same thing. The README's install section
names `@latest`.
