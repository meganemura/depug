# Releasing

`@meganemura/depug` is already on npm. Versions `0.1.0` through `0.1.3`
were published by hand, and an unauthenticated `npm view` reads them.
A later release is the npm package, a git tag whose name is `v` plus
the `package.json` version, and a GitHub release for that tag. A push
to `main` that changes `package.json` runs
[`.github/workflows/publish.yml`](../.github/workflows/publish.yml).
Nobody pushes a `v*` tag by hand.

That workflow is the steady-state path. Its `check` job reads the
`package.json` version and looks for the tag `v<version>`. When that
tag already exists, the run releases nothing, so a dependency bump or
any other edit to `package.json` publishes nothing. Otherwise the
publish job installs the pushed commit, builds `dist/`, runs
`npm test`, refuses the run if any tracked file changed, and runs
`npm publish`. After that publish succeeds, the release job creates the
tag on the published commit and the GitHub release for it. The publish
job keeps `contents: read` and is the only job that holds the npm OIDC token. The release job asks
for `contents: write` and nothing else, so the token that can publish
the package cannot also write repository contents. npm authenticates
with GitHub Actions OIDC. Provenance is attached automatically because
the repository and the package are public. The publish job sets
`environment: publish`. That Environment is the human gate: the job
waits there until a required reviewer approves it.

Registering the Trusted Publisher does not create a pending approval.
The approval appears only when a run started by a version bump on
`main` enters the Environment `publish`.

The Environment's deployment branch and tag rules must allow
deployments from `main`. A rule that allows only `v*` tags blocks every
run, because the workflow now starts from a push to `main` and the tag
does not exist until the release job creates it. Setting that rule is
the owner's step in the repository settings.

The Trusted Publisher and the Environment `publish` are already
configured, as of 2026-09-23. Recreate one only if it is missing. The
next section records the values to put back.

The package ships compiled JavaScript in `dist/`. `dist/` is gitignored.
The workflow builds it from the pushed commit, and that build is what the
tarball contains. `package.json` `files` also packs `src/`, `bin/`,
`skills/`, `docs/`, `AGENTS.md`, `CHANGELOG.md`, and `LICENSE`. npm always
packs `README.md` and `package.json` as well.

`publishConfig.access` is `public`, and the registry copy is already
public, so `npm publish` needs no `--access` flag. A scoped name is
private only on its first publish, and that publish already happened.

`package.json` declares `prepublishOnly` as `npm run build`. This
repository has no `.npmrc` that sets `ignore-scripts`, so that hook runs
again during `npm publish`. The workflow still builds before the tests
and the dirty-tree check, so a build that rewrites a tracked file fails
the run before the upload.

The workflow stores no `NPM_TOKEN`. The repository secrets do not keep
one either. There is no token bootstrap: the package already exists, so
the Trusted Publisher is attached directly.

## Trusted Publisher and Environment

These are human steps. Nothing in this repository creates the Environment
or registers the trusted publisher. Both are already in place. The
values below are what to enter if one of them is missing.

The package page is the scoped URL
`https://www.npmjs.com/package/@meganemura/depug`. The Trusted Publisher
on that page is one GitHub Actions publisher, and its Repository field
is the GitHub repository name `depug`. The fields are case-sensitive:

- Organization or user: `meganemura`
- Repository: `depug`
- Workflow filename: `publish.yml` (the filename, including `.yml`)
- Environment name: `publish`
- Allowed action: `npm publish`

A trusted publisher created after 3 September 2026 starts with
`npm stage publish` allowed. Select `npm publish` as well.
`publish.yml` runs `npm publish`.

`package.json` `repository.url` is already
`git+https://github.com/meganemura/depug.git`. npm checks that URL
against the workflow repository.

On the GitHub repository `meganemura/depug`, the Environment is named
`publish` and requires reviewers. The workflow job sets
`environment: publish`, so a run waits until a reviewer approves it.
If that Environment has been removed, create it again, with required
reviewers, before the next version bump lands on `main`. Otherwise GitHub creates it on that
run with no required reviewers, and that run publishes as soon as the
checks pass.

Saving the publisher still does not open a review. The approval shows
up on the Actions run for the version bump, when that run enters
`publish`.

After an OIDC publish from `publish.yml` has succeeded, the package
settings can be tightened. This is optional, and it waits until that
exchange has worked. Under Publishing access, select "Require
two-factor authentication and disallow tokens". That blocks granular
access tokens. The Trusted Publisher keeps working, because it
authenticates with the OIDC exchange.

## Pinned actions

`publish.yml` names each action by a full 40-character commit SHA and
leaves the release tag in a comment:

- `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1`
- `actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0`

The release job checks out with that same `actions/checkout` SHA, and
it checks out `github.sha`, the commit the publish job built. It does
not run `actions/setup-node`: creating the release does not install
the package.

The repository's Actions permissions have `sha_pinning_required`
enabled, so every action must be pinned to a full-length commit SHA. An
action named by a tag or a branch fails that policy before any step
runs. A later bump replaces the SHA and the version comment together.

## Each version

What to check before the version bump is in
[`docs/maintenance.md`](maintenance.md). The workflow's `npm test`
leaves `DEPUG_CORPUS_DIR` unset, so the two corpus tests skip there.
Run them before the version bump.

1. In one commit, turn the `## Unreleased` section of `CHANGELOG.md`
   into a heading in the shape already used,
   `## <version> - YYYY-MM-DD`, and set the same version in
   `package.json` and `package-lock.json`. The release job's awk matches
   `## <version> ` followed by a space, so keep the ` - YYYY-MM-DD`
   after the version. The workflow names the tag `v` plus the
   `package.json` version, and the release job fails when the changelog
   has no section for it.

2. Run `npm test` with `DEPUG_CORPUS_DIR` set, and the packed-tarball
   check in `docs/maintenance.md`. `npm test` type-checks and then runs
   vitest. `prepublishOnly` does not run under `ignore-scripts`, so build
   by hand before `npm pack`.

3. Land the version bump commit on `main` through the `queue` branch.
   Do not push a tag. The push to `main` that changes `package.json`
   starts the workflow. This publish is `publish.yml` only. Do not run
   `npm publish` from a checkout.

4. Approve the `publish` environment on that Actions run. The review is
   requested when the job enters the environment, which is this run.
   The workflow uses Node 24 on `ubuntu-latest` with the npm registry
   URL set. It requires npm 11.5.1 or newer, the release that can
   exchange a GitHub OIDC token for a publish. It runs `npm ci`,
   `npm run build`, and `npm test`, then refuses the run if any tracked
   file changed. `dist/` is gitignored, so the new build output is
   expected and is what gets packed. Then it runs `npm publish`, which
   runs `prepublishOnly` and builds again. The package `engines` field
   stays `>=22.18.0`. Node 24 is the publish job, not a new requirement
   for people running depug.

5. After `npm publish` succeeds, the workflow's `release` job creates
   the tag and the GitHub release. It checks out the same commit the
   publish job built, extracts only that version's section from
   `CHANGELOG.md` (`--notes-file CHANGELOG.md` would carry every
   version), and runs `gh release create --target` with that commit,
   which creates the tag `v<version>` there. A release that already
   exists is left in place, so re-running the job is safe. If that job
   fails, re-run it from the Actions run.
