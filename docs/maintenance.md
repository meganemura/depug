# Maintenance

What someone working on depug needs that is not in the README.

## Running the suite

```sh
npm test
```

122 tests. Two of them skip unless a corpus is available.

## The corpus tests

Two tests run the rewrites over a real codebase rather than over
hand-written fixtures, because fixtures cover the shapes their author
thought of. That is not a slogan: running the transform over a real
codebase is how the empty-body offset collision came out, with every
fixture passing while six real files produced unparseable output.

The corpus is honojs/hono at commit
`e2740d5a1bd0b4254e517e3af8b60789284bc7bd`. It lives outside this
repository and is not fetched automatically, so both tests skip when it is
absent:

```sh
git clone https://github.com/honojs/hono.git /tmp/hono
DEPUG_CORPUS_DIR=/tmp/hono npm test
```

They assert 188 files, 0 changed line counts, and 0 new syntax errors.
`test/support/corpus.ts` extracts the tree once with `git archive` and
shares it between both tests; reading each file with its own `git show`
was one subprocess per file and pushed the suite past its timeout.

## Property-based tests

The suite uses [hegel](https://www.npmjs.com/package/@hegeldev/hegel) for
properties, alongside the example tests. Both live in the same files: a
property is a test like any other and belongs with the code it checks.

The properties worth knowing about, because they hold the design up:

- **The line count never changes**, over generated TypeScript rather than
  only over fixtures and the corpus. Positions are embedded as literals
  instead of recovered from a source map, so a rewrite that moved a line
  would put every recorded coordinate one off with nothing to signal it.
- **A `-t` pattern selects the test it names and no other.** This one
  shipped broken: a pattern that is not escaped, or not anchored, selects
  the wrong tests or none, and a fixture with plain ASCII names could not
  show it.
- **A function id survives being written and read back**, compared against
  the value that went in rather than against the text that came out.
  `format(parse(format(x))) === format(x)` holds even for a format that
  drops a field, because it drops it both times.
- **Counts cover every call while samples are capped.** Sampling the
  counts would let a later null hide behind the cap and support a claim it
  never happened.

Writing them found a real defect: a probe passed its renderer a limits
object with the wrong keys, so no sample was ever truncated and a
5000-character argument went into the evidence file whole. Nothing in the
suite type-checks the source, which is what would have caught it.

## Coverage

```sh
npm run coverage
```

Around 91% of lines. What is left is mostly two shapes that a run in this
process cannot reach:

- The four `setupFiles` modules write their worker file from an `afterAll`
  that only does anything when a verb has set its environment variable.
  The functions they call are covered directly.
- `src/node-test-hook.ts` registers Node's module hook and node:test's
  hooks at the bottom of the file, which happens only inside the child a
  verb starts. Its decisions -- which mode to run and which files to touch
  -- are exported and covered.

Both are exercised end to end by tests that spawn a real runner. Coverage
in this process cannot attribute that, and raising the number by deleting
the distinction would be worse than the number.

## The four rewrites, and the one rule they share

Each verb that needs different instrumentation has its own rewrite, so the
always-on path never carries a cost that only one verb wants.

| Module | Instruments | For |
|---|---|---|
| `src/transform.ts` | every function's entry, exit, and `await` | `frames`, `preflight` |
| `src/probe-transform.ts` | one function's arguments and return value | `probe` |
| `src/flt-transform.ts` | one function, after every statement | `flt` |
| `src/exec-transform.ts` | one line of one function | `exec` |

They must agree about one thing: **how a function is named and where it
sits.** `src/function-identity.ts` holds that rule and all four use it. It
lives in one place because the three copies that existed before had
already drifted: the probe rewrite anchored an anonymous arrow at the
arrow while the index anchored it at the variable holding it, so one
function had two ids and a probe aimed with an index's id found nothing.

Every rewrite obeys the same splice rules. Offsets come from the AST. No
inserted string contains a newline, so the line count cannot change. The
recorded line and column are the TypeScript source's, written as literals.
The corpus tests are what hold the first two; the position tests in
`test/wrapper-config.test.ts` hold the third, by running a real vitest
process and reading positions back out.

## The two runner paths

A verb reads the command it is handed and sets itself up accordingly
(`src/runner.ts`).

- **vitest**: the verb generates a config that imports the project's own
  and merges the plugin into it (`src/wrapper-config.ts`). The generated
  file goes under the project's `node_modules/.depug`, not a system temp
  directory: a config imports `vitest/config` by name, and Node resolves a
  bare name by walking up from the importing file, which from a temp
  directory finds nothing.
- **node:test**: the verb sets `NODE_OPTIONS` to preload
  `src/node-test-hook.ts`, which registers a `module.registerHooks` load
  hook. A plain `--import` on the command line does not reach the child
  process node:test starts for each test file.

A repository split into vitest projects needs more than a merge, because
vitest does not apply a root config's plugins to a project's own config.
`writeGeneratedConfig` handles both shapes it has been measured against:
projects that resolve to a config per package, and projects written inline
in the root config.

## Adding a dependency

Two development dependencies today, `vitest` and `typescript`, both pinned
exactly. `typescript` is also the peer dependency, from 5.5.4 up to but
not including 7.

A third needs the owner's approval, an exact pin, and a version at least
seven days old with no later security fix. `typescript` must not gain a
second parser beside it.

## Before publishing

Nothing is published. `package.json` carries `"private": true` and version
`0.0.0`, and this repository holds no release workflow, so a release is
whatever the owner does by hand. Publishing, changing the repository's
visibility, and pushing a tag are each the owner's decision at that
moment.

What to check first:

- `npm test` passes with `DEPUG_CORPUS_DIR` set, not only without it.
- Nothing in the tracked tree names a path on one machine, a secret, or a
  working note. `git grep` over the tracked files and over the commit
  messages, and confirm that everything the ignore file excludes is still
  excluded.
- `package.json` still exports what the README tells a reader to import.
  One fixture imports depug by package name rather than by path, so the
  suite fails if that entry point stops resolving; a relative import would
  keep passing while the public one broke.
- The measurements quoted in `README.md`, `CHANGELOG.md`, and
  `docs/design-decisions.md` still describe the code. Each one names the
  machine and the sample it came from, and a number that has quietly
  stopped being true is worse than no number.

## Where the reasoning lives

`docs/design-decisions.md` holds each decision beside the measurement that
supports it and what was not measured. `docs/evidence-schema.md` is the
contract for the files, written before the code that writes them.
`skills/depug/SKILL.md` is what an agent reads to use any of it.
