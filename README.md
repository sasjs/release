# @sasjs/release

Simple and safe release management. Releases from conventional commits, for any host. Zero dependencies, one file.

The version is the git tag. Nothing writes a version into `package.json`, nothing commits, nothing pushes to a branch: the tag names the commit that was merged, and the release notes are the commits it covers. GitHub, Gitea, GitLab and a laptop all run the same command.

```bash
npx @sasjs/release --dry-run          # what it would tag, and the notes
npx @sasjs/release --tag --push-tag   # cut it
npx @sasjs/release --tag --host gitlab --release
```

## Why not a release toolchain

`semantic-release` and `release-please` arrive with a few hundred packages, a plugin per job, and advisories that no one can fix (their copies of `npm`, `glob` and `undici` are bundled inside the tool). This is ~450 lines and installs nothing, so there is nothing to audit and nothing to upgrade. It also does not need a `gh` CLI, `curl`, `jq` or `tea`: the host calls are plain `fetch`.

### What it deliberately does not do

There is no release commit, so **no changelog file is written and `package.json` is not bumped in git**. Both of those mean a runner pushing to the default branch, which means a token with bypass on a protected branch, which is the permission that is hardest to justify and easiest to get wrong.

- **The changelog is the release page.** It is generated from the commits the tag covers, on every run, from git alone.
- If a file is wanted anyway, it does not have to be in git: attach the notes as an asset (`--notes-file NOTES.md --asset NOTES.md`), or generate the file at docs-build time from `git log <prev>..<tag>` - the same data, no write.
- **`package.json` is stamped in the publishing job, not in the repository**: `npm version "${TAG#v}" --no-git-tag-version` before `npm publish`. The tarball carries the right version and nothing is committed.
- The committed `package.json` therefore says `0.0.0` - meaning unset, not stale. A version there would be a claim the repository cannot keep true, since updating it is the commit this design refuses. `prepublishOnly` refuses to publish while the version is still `0.0.0`, so a hand-run publish fails loudly instead of putting `0.0.0` on the registry.
- Consequence: installing **from git** (`npm i github:sasjs/release`) or packing outside CI gives `0.0.0`. Install from the registry, or use the action at a pinned commit, which is what a consumer wants anyway.

Two things it does that the toolchain cannot:

- **A failed release is re-runnable.** If a run dies after the tag is cut - the push rejected, the API down, the runner killed - re-running with the same flags finishes it. The tag is reused instead of refused, the notes are rebuilt from the commits the tag covers, an existing release is found rather than re-created (GitHub answers 422, Gitea and GitLab 409), and an asset that is already attached is reported, not treated as a failure.
- **Nothing lands on your default branch.** No release commit, no `package.json` bump, no second push for the tag, so no protected-branch or app-token dance.

## Options

| Option | Meaning |
| --- | --- |
| `--repo-dir <path>` | repository to work in (default: cwd) |
| `--tag-prefix <p>` | prefix before the version in the tag (default `v`) |
| `--since <ref>` | count commits after this ref (default: newest prefixed tag) |
| `--paths <a,b>` | only commits touching these paths - monorepos |
| `--level <l>` | force `patch`, `minor` or `major` instead of classifying |
| `--prerelease <id>` | cut `<version>-<id>.1`, or continue the last one (`beta.2` -> `beta.3`); the release is marked as a prerelease |
| `--dry-run` | say what it would do; write nothing, send nothing |
| `--notes-file <path>` | write the release notes here |
| `--output <path>` | append `released`, `version`, `tag`, `level` as `key=value` |
| `--tag` | create the annotated tag (reused when it already names HEAD) |
| `--push-tag` | push the tag to `origin` |
| `--host <h>` | `none` (default), `github`, `gitea`, `gitlab` |
| `--release` | create the release on the host |
| `--repo <owner/name>` | repository on the host (default: from the git remote) |
| `--api-url <url>` | host API base, for a self-hosted instance |
| `--token-env <NAME>` | environment variable holding the token |
| `--asset <path>` | file to attach (repeatable; GitHub and Gitea upload it) |
| `--config <path>` | config naming the assets to attach; the `release.assets` of `sasjs/sasjsconfig.json` is read by default, then a `.releaserc` |
| `--audit` | judge the npm audit report: the production tree is never exemptible, a dev advisory passes only when the allowlist argues for it |
| `--audit-level <l>` | severity floor, `info` to `critical` (default `low`) |
| `--audit-require-source` | require an exact numeric npm source on every exemption; requires `--audit` (opt-in) |
| `--audit-require-severity` | require an exact severity on every exemption; requires `--audit` (opt-in) |
| `--audit-omit <a,b>` | judge an npm omit set instead of the full tree: comma-separated `dev`, `optional`, `peer` (eg `dev,optional`) |
| `--audit-config <path>` | exemption list (default `scripts/audit-allowlist.json`; a repository without one has none) |
| `--audit-report <path>` | write the report this run judged |
| `--audit-input <path>` | read a recorded full-tree report instead of running npm; any exemption requires `--audit-prod-input` as well |
| `--audit-prod-input <path>` | read a recorded production report, required for a replay with any exemption |
| `--assert-no-dependencies` | fail unless the installed `@sasjs/release` ships no dependencies |
| `--no-assets` | cut the release with no files attached; the artefacts are built from the tag and attached later |
| `--keep-draft` | leaving the release a draft after attaching, rather than publishing it |
| `--attach <tag>` | upload the configured assets to a release that already exists, and cut nothing |
| `--verify-assets` | with `--attach`, require GitHub SHA-256 digests for every named file before publishing; unsupported hosts and `--dry-run` fail (except the read-only `--show-context` mode) |
| `--asset-link <n=url>` | link to attach (repeatable; the only asset shape GitLab has) |
| `--discover-publish` | resolve and validate a publish tag without reading the package or registry |
| `--prepare-publish` | gate a publish instead of cutting a release - see below |
| `--sha <sha>` | commit to look for a tag at, with `--prepare-publish` (default: `HEAD`) |
| `--branch <ref>` | the branch a publishable tag must be on (default: `HEAD`) |
| `--registry <url>` | registry to ask whether the version exists (default: the public npm registry) |
| `--republish` | publish even when the registry already serves that version |
| `--draft` | create the release as a draft: the release is invisible. On GitHub the tag is created when the draft is published, not now; Gitea and GitLab create it with the release |

Exit codes: `0` released or nothing to release, `1` a failed check (`--audit` or `--assert-no-dependencies`), `2` usage, git or host error.

The result is printed as `key=value` lines, so a pipeline can feed it to whatever variable protocol it has - `$GITHUB_OUTPUT`, `$GITHUB_ENV`, a dotenv artifact, nothing at all - with `--output`.

## The publishing half

Before a publish workflow builds anything it has to answer three questions: which version is this run for, may it be published at all, and is it already on the registry? Those answers are the same in every repository, and the shell that produced them was copied into each one - where a shallow clone, a tag cut from an unmerged branch, and a version that had already been published were each handled slightly differently.

`--prepare-publish` answers them from git and the registry, writes nothing but the version, and creates no tag:

```bash
npx @sasjs/release --prepare-publish --sha "$SHA" --branch main --output "$GITHUB_OUTPUT"
```

| Question | Answer |
| --- | --- |
| which version? | the newest `v*` tag at `--sha`; when there is none, `skip=true` - unless the clone is shallow, which is a failure, because a clone without tags cannot tell "this release cut no tag" from "I cannot see the tags" |
| may it be published? | the tag has to be an ancestor of `--branch` or `origin/<branch>` - a tag cut from a branch nobody merged is refused, while a local branch that is merely behind is reported and does not block |
| what version will npm read? | the tag's, written into `package.json` - so the tarball and the release cannot disagree |
| is it already there? | the registry is asked; an existing version gives `publish=false`, unless `--republish` |

It prints, and emits with `--output`: `skip`, `tag`, `version`, `publish`, `exists`.

For a pipeline that must check out the tag **before** changing the package, `--discover-publish` does just the Git decision. It emits `skip`, `tag`, and `version`, does not read or stamp `package.json`, and never contacts a registry. Supply either `--tag` (an actual prefixed SemVer tag) or `--sha` (a full 40- or 64-character commit object ID); otherwise it uses HEAD. Discovery selects by SemVer precedence and rejects equal-precedence ties rather than choosing arbitrarily. Numeric-prefixed malformed versions fail even beside valid versions. If there is no numeric-prefixed tag, a nonnumeric tag with the configured nonempty prefix (for example `vbad` or `vdocs`) also fails rather than silently skipping: such names cannot be distinguished from malformed release tags. Nonmatching tags are ignored, as are nonnumeric prefixed tags when a numeric-prefixed tag is present; with an empty prefix nonnumeric tags are ignored. This is a deliberate fail-closed change for repositories using prefixed non-version tags alone. A shallow checkout fails even when it has a tag, because the checkout may omit another tag at the same commit.

The branch must resolve, and the tag must be reachable from `--branch` or its `origin` tracking branch. A short branch name resolves `refs/heads/<name>`, `refs/remotes/<name>`, and `refs/remotes/origin/<name>`, never a same-named tag. `origin/<name>` selects that tracking branch; other remote shorthand names are also supported. Fully qualified refs, HEAD, full object IDs and revision suffixes are supported. Explicit refs select only that ref, so `refs/heads/main` does not fall back to `origin/main`. Do not treat discovery as permission to publish: run `--prepare-publish` on the checked-out tag, validate its complete output, then use its `publish` output. The repository's own workflow runs discovery from trusted main and preparation from the tag; an old tagged CLI that cannot prepare must fail rather than silently skip publication. Its npm workflow rejects build metadata because `npm version` strips it.

It does not run `npm publish` - that stays in the publishing workflow, which is the identity npm trusts for provenance - and it does not create the tag or the release. See [the publish workflow](.github/workflows/publish.yml) for the complete sequence, including validation of the tagged CLI's outputs before using them.

If the project has a lockfile, synchronize it after preparation and before publishing (for example, `npm version "$VERSION" --no-git-tag-version --allow-same-version`). `--prepare-publish` updates `package.json` only.

`--dry-run` prints the same decisions and writes nothing, which is how a failing publish job is debugged without publishing.

## The audit gate

`npm audit --audit-level=low` is the right bar and the wrong answer to one case: an advisory with no fixed version upstream, which turns every pull request red for a reason no branch can act on. The response in each repository was a script - six of them, in six repositories, with three different exemption schemas - and the same rule, learned slightly differently in each.

`--audit` is that rule once:

```yaml
- name: Check npm audit
  run: npm run release -- --audit
```

What it enforces:

- **Production is never exemptible.** The `--omit dev` report is judged on its own and any advisory there fails, whatever the allowlist says. The tree that ships is a version to change, not a risk to accept.
- **A dev advisory fails unless an entry names it**, and the entry carries the argument: where the package sits, what input reaches the affected code, when it clears.
- **An entry that stops appearing fails**, so an exemption cannot outlive its reason.
- **An advisory with no GHSA id fails**, because an exemption is a claim about a specific advisory - and "I cannot name this" is not "there is nothing to fix". A waiver matches only a complete GitHub advisory URL (`https://github.com/advisories/GHSA-xxxx-xxxx-xxxx`, with an optional trailing slash); other URLs, queries, and fragments cannot supply an identity.
- **A report that cannot be read fails.** `npm audit --json` writes its own errors to stdout and exits non-zero, so a missing lockfile or an unreachable registry parses as JSON with no `vulnerabilities`. That is not a clean tree, and it must not become one once the exemption list empties out.
- **Production is measured for every exemption.** Any entry, whether `devOnly` is true, false, or omitted, triggers a production report; an advisory in that report is never exemptible. With no entries the second call is skipped, because there is nothing an exemption could be hiding.

An `--audit-omit` run judges only the requested partial tree and refuses a nonempty exemption list. `dev` alone selects the production report; omitting `optional` or `peer`, with or without `dev`, is a different scope and may exclude dependencies that ship. Use the full-tree gate when validating exemptions. Live npm audits explicitly set both include and omit types, overriding inherited npm config and `NODE_ENV` for scope while retaining registry and authentication settings. For npm workspaces, audits include the root and every workspace, not an inherited workspace selection; this also applies to the separate production audit. An audit invoked inside a workspace uses its root lockfile, while a nested independent project uses its own. A workspace declaration with no matching workspaces, or a workspace selector in a non-workspace project's npmrc, fails closed rather than returning a potentially partial result; remove that selector or the empty declaration. Recorded reports are judged as supplied; their scope cannot be verified from the report.

The exemptions are `scripts/audit-allowlist.json` - or `--audit-config`. A repository without the file has no exemptions:

```json
[
  {
    "id": "GHSA-fc5q-39xc-vjpf",
    "packages": ["picomatch"],
    "devOnly": true,
    "recheckBy": "2027-01-31",
    "reason": "Vulnerable range is <=4.0.7 and 4.0.7 is the newest published version, so no upgrade and no override clears it. It reaches this tree only through the build and test tooling; no production dependency resolves it. The input the advisory needs is a glob pattern this repository writes itself. Clears when a release above 4.0.7 is published."
  }
]
```

`packages` is optional and names the packages the argument covers - an id exempted for `picomatch` says nothing about the same id arriving under `micromatch`. A scoped entry is stale if **any** named package no longer carries that id in the full report, even if another package still does; remove the missing package or, if none remain, the entry. A missing or empty `packages` list is unscoped and becomes stale only when the id disappears entirely. Staleness is checked below as well as above the severity floor; `stale` counts entries, not missing packages. `recheckBy` is required, because a waiver without a review date is the failure mode the date exists for. `devOnly` is optional; even when false or omitted, the entry applies only to findings absent from the production report. The id is the key and `packages` narrows an entry, never widens it.

`severity` is an optional, exact advisory rating (`info`, `low`, `moderate`, `high`, or `critical`). Use `--audit --audit-require-severity` to require it on every exemption, including entries below the audit floor; a missing or invalid rating is a usage error (exit 2), while an empty or absent list is valid. This flag defaults off for compatibility. Set it to the reviewed rating to refuse both escalation and downgrade at or above the audit floor until the waiver is reviewed. For a waiver without a source bound, if a GHSA/package appears more than once, every reported rating must match the bound, even when a lower duplicate is below the floor; the highest rating still determines whether the finding is at the floor. An unrecognized advisory rating cannot satisfy a severity-bound waiver. If overlapping entries apply, every specified severity must match, regardless of entry order; an unbounded entry cannot override a bound one. Findings below the floor do not block on severity, but still count for staleness. Without the flag, omitting `severity` preserves the existing severity-agnostic waiver, which will **not** detect escalation: migrating an exact-severity policy requires adding it to every waiver and enabling the flag. The old macro-dash gate matched npm numeric `source` and exact severity; this gate also requires GHSA identity, a review date, rejects stale entries, and never exempts production, so conversion is not a schema-only drop-in. Version 0.14.1 rejects `severity` as an unknown key, so upgrade the package before adding it.

`source` is optional: a positive safe integer matching npm's numeric advisory `source` exactly, for example `"source": 1247710`. With `--audit --audit-require-source`, every exemption must include it, including those below the floor; missing or invalid values are usage errors (exit 2). Empty or absent exemption lists remain valid. Each distinct source at or above the floor needs its own matching waiver for that GHSA and package. If any applicable source-bound entries exist, an unbounded overlapping entry cannot clear an extra, missing or nonnumeric source; order does not matter. Source bounds apply before deduplication, and stale checks use the exact GHSA/source pair for every named package, even below the floor. Different sources can have different reviewed severities; duplicate ratings for the same source must all match when that source reaches the floor. An unscoped severity-bound entry still constrains all sources for its GHSA/package. The `advisories` count remains deduplicated by GHSA/package; `exempted` counts entries selected to clear findings. Production remains unexemptible. Without the flag and without `source`, the original GHSA-based policy is unchanged. To preserve an old numeric-and-severity policy, populate both fields and enable both `--audit-require-source` and `--audit-require-severity`. Numeric npm advisory IDs may change when an advisory is updated: a changed source fails the gate and requires review rather than silently broadening the waiver. A GHSA alone can cover multiple numeric sources; do not migrate by GHSA alone when exact numeric matching matters.

Exit codes tell the two kinds of failure apart: `1` is a verdict (a finding, a stale entry, an expiry, an unreadable report) and `2` is this tool being asked something it cannot do (an unknown flag, a malformed exemption). A mistyped allowlist must not read as a vulnerability, and a vulnerability must not read as a broken pipeline.

`--audit` composes with `--prepare-publish` and with the tag and release modes, and runs first: a tree that carries an advisory nobody has argued for is not one to stamp a version onto or cut a tag from. `--audit-input` takes a recorded report instead of running npm, and `--audit-prod-input` supplies the production report required when any exemption exists. Together they run no npm at all, so a failing build is replayed offline.

The weekly watcher in a repository that files an issue on failure keeps only the part that renders the report and appends to the issue: `--audit --audit-report` is the verdict, and writing to an issue tracker is a second write surface this tool deliberately does not have.

### `--assert-no-dependencies`

A release job runs with `contents: write`, so the tree carrying the release tool has to be auditable - and the property that makes it so is that this package ships nothing of its own. Three workflows asserted that with an inline `node -e` block; the flag is the same assertion, next to the code that has to keep the promise:

`dependencies`, `peerDependencies`, `optionalDependencies`, and both `bundledDependencies` / `bundleDependencies` count, including names in bundle arrays or object keys. Boolean bundle flags alone do not name dependencies; `true` bundles the declared dependencies, which are checked separately. Development dependencies are allowed. Failure exits 1 and lists the distinct package names; a missing or unreadable installed manifest exits 2.

```yaml
- run: npm run release -- --assert-no-dependencies
```

## Permissions

The whole release is one credential: a token that may write contents on the repository. No branch is written, nothing is committed, and no workflow-file change is involved.

| What | Permission | Why it is needed |
| --- | --- | --- |
| Create the release | `contents: write` (GitHub, Gitea), Developer or the job token (GitLab) | creating a release is a write on the repository |
| Create the tag | the same grant | the forge creates the tag from `target_commitish` (GitHub, Gitea) or `ref` (GitLab), so the job needs no git credentials and does not run `git push` |
| Upload assets | the same grant | attached to the release |
| `npm publish` with OIDC | `id-token: write` | stays in the calling workflow, so provenance names the package's own repository |

A release therefore needs **one** call and no checkout credentials at all:

```bash
# the host creates the tag at this commit and the release in one call
npx @sasjs/release --host github --release
```

`--tag --push-tag` exists for the case where the tag must exist before the release does - building artefacts from it in a later job, for instance - and it costs a git credential. The minimal path does not use it.

A `permissions` block that grants `contents: write` to the release job is the same grant the release toolchain already asks for; what is lost is the app token that exists only to push a release commit.

## The version rule

`feat` is a minor, `fix`/`perf`/`refactor` a patch, `!` or a `BREAKING CHANGE:` footer a major - except before 1.0.0, where a breaking change is the minor. Anything else (`docs:`, `chore:`, `ci:`) is not a release, and if nothing classifies the tool says so and exits 0. `--level` covers a repository whose history is not conventionally formatted.

## GitHub

The repository ships a composite action, so a workflow is a step rather than a script:

```yaml
permissions:
  contents: write # the tag and the release
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<sha>
        with:
          fetch-depth: 0 # the range is classified from tags; a shallow clone sees one commit
      - uses: sasjs/release@<sha>
        with:
          args: --tag --push-tag --host github --release
        env:
          GH_TOKEN: ${{ github.token }}
```

`fetch-depth: 0` is not optional: with a shallow clone there are no tags, every commit looks unreleased, and the version is invented.

## Gitea

Gitea Actions runs the same action, but the token and API base come from Gitea:

```yaml
- uses: sasjs/release@<sha>
  with:
    args: --tag --push-tag --host gitea --release --api-url ${{ gitea.server_url }}/api/v1
  env:
    GITEA_TOKEN: ${{ secrets.GITEA_TOKEN }}
```

A tag created by the Actions user does not fire `on: push: tags` on Gitea, so any workflow that should react to a release (docs, a demo site) has to be dispatched from the same job.

## GitLab

No action syntax, so call the package directly. On a self-hosted instance, point `--api-url` at it:

```yaml
release:
  image: node:22
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
  script:
    - npx --yes @sasjs/release --host gitlab --release
        --api-url "$CI_API_V4_URL" --repo "$CI_PROJECT_PATH"
        --token-env CI_JOB_TOKEN --output release.env
        --asset-link "app.zip=$CI_PROJECT_URL/-/jobs/artifacts/$CI_COMMIT_SHA/download?job=build"
  artifacts:
    reports:
      dotenv: release.env
  variables:
    GIT_DEPTH: '0' # GitLab clones 20 commits deep by default
```

### Assets

`release.assets` in the project's `sasjs/sasjsconfig.json` names the files a release
attaches:

```json
{
  "release": {
    "assets": [
      {
        "path": "sasjsbuild/server.json.zip",
        "name": "macro-dash-server.json.zip",
        "label": "SASjs Server App"
      }
    ]
  }
}
```

`path` is relative to the repository root and `label` is what a reader sees on the
release page. `name` is what the file is published as, which matters because an
asset is served from `<repo>/releases/latest/download/<name>`: a build output named
after its target (`sasjs cb -t sas9` writes `sasjsbuild/<deployScriptFilename>`) is
published under the name a page already links to, with no copy to rename it first.
Without `name` the file keeps its own.

The files are attached in the order given.

`--config <path>` reads the same list from another file, which may also be a bare
array of paths.

### Where a run is publishing

A release in CI does not have to be told which forge it is on. `GITLAB_CI`, or
`GITHUB_ACTIONS` together with `GITHUB_SERVER_URL`, names it - and `GITHUB_REPOSITORY`
names the repository, so `--host` and `--repo` are only for a run outside CI, or for
overriding what the environment says.

    $ GITHUB_ACTIONS=true GITHUB_REPOSITORY=sasjs/macro-dash sasjs-release --show-context
    host=github api=https://api.github.com repo=sasjs/macro-dash

A `GITHUB_SERVER_URL` that is not github.com means gitea, at `<server>/api/v1`. The
token is the variable named for the host (`GH_TOKEN` for github), falling back to
`GITHUB_TOKEN`, which every Actions run already has.

### Attaching after the release

An artefact sometimes cannot exist when the release is cut - macro-dash stamps the
version into the streamed page, so its files are built from the tag that was just
made. `--attach` is the other half for that shape: no commits are read, nothing is
tagged, and the same `release.assets` list goes to the release that exists.

```yaml
- run: npx sasjs-release --attach "$TAG" --host github
  env:
    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

`--dry-run` names the files without sending them, and a tag with no release is
refused by name rather than reported as an empty upload.

### What a draft names, and what is reused

On GitHub, a draft release creates **no tag**: the tag is created from
`target_commitish` when the draft is published. That is what makes "cut first,
build second" safe there - a run that dies after the cut burns no version, and
the next run re-classifies the same commits to the same one. (Gitea and GitLab
create the tag with the release, so a draft there already names one.)

On GitHub, a release that already exists for a tag is reused only when it names
the commit being released - compared as a sha, so a shallow checkout is enough
to tell. A `target_commitish` that is not a sha (the branch name a release made
in the web UI stores) cannot be compared with what the release held, so it is
reused as before. Gitea and GitLab reuse an existing release as they always
have: the identity check is GitHub-only, where these draft semantics were
measured.

- **same commit** - it is the previous run's draft, and this run finishes it
  (`a release for this tag already exists: finishing it`);
- **another commit, still a draft** - it is abandoned work: its notes describe a
  range nobody published, and finishing it would attach this build to a tag
  created at the other commit. The release is re-read immediately before the
  delete and the run refuses if it has been published in the meantime, so a live
  release is never removed; otherwise the draft is deleted and the release cut
  again at this commit, and the run says so (`discarded a stale draft for vX: it
  named <the old commit>, and this run releases <this one>`);
- **another commit and published** - the tag is taken. The run refuses
  (`a published release for vX already names <sha>, and this run releases <sha> -
  refusing to attach this build to it`) rather than attaching today's files to
  yesterday's release.

On GitHub, and only there, the tag itself is checked before anything is created:
GitHub ignores `target_commitish` once the tag exists, so a release created for a
tag that already names another commit would point at that commit while the run
said it released this one. The run asks for the tag ref (peeling an annotated
tag to the commit it holds) and refuses by name when that names a different
commit. The ref endpoint is the one asked because a missing ref is a plain 404
there, while `/commits/<ref>` answers 422 for the same thing - the state every
release starts in, since the create is what makes the tag.

Gitea and GitLab are not checked: neither passes an identity, and their `ref` is
documented as used only when the tag does not exist, so the tag-already-exists
case - and the silent attachment to an older commit it allows - is still open on
those hosts.

The cut is told which kind of release it is: `--no-assets` cuts one whose files are not
on disk yet, so a config naming them is expected rather than a mistake. Without it,
the same config refuses before anything is tagged. `--no-assets` requires `--draft`,
because a release published before its files exist is one whose download links answer
404 until an attach finishes.

`--attach` uploads the list, reads the release back to check it holds what the config
names, and then publishes the draft - so a release that fails to attach stays
invisible instead of advertising downloads that answer 404. `--keep-draft` leaves it
drafted for a later step to publish.

For strict GitHub verification, add `--verify-assets`: every configured asset must have state `uploaded`, its size must match, and its GitHub `sha256:` digest must equal the snapshot bytes. Before uploading anything, strict mode snapshots all local files sequentially into a private temporary directory and checks every already-present named asset. Files are read at different times, not as an atomic filesystem snapshot; avoid changing build outputs during the run. It hashes and uploads the same in-memory bytes for each missing asset, and checks the snapshot against its original hash first. One file is buffered at a time, but very large files can exceed memory, and disk space is needed for all snapshots. Temporary files are removed on normal success or failure; abrupt termination can leave them behind.

A missing or unsupported digest fails closed, including older assets for which GitHub does not provide one. No remote asset is deleted or overwritten; resolve mismatches manually. An upload or later check can fail after earlier uploads succeeded, leaving those assets in place. Only configured assets are checked; other existing assets can also become public when a draft is published. The release and asset lists are paginated, redirects are rejected, and the upload endpoint must match the selected repository and release ID. Strict mode re-reads the release by ID before the first upload and after final asset verification, checking its tag and draft status; on the draft path this last read is immediately before publishing. This is not atomic: GitHub provides no conditional operation tying those reads and the asset checks to uploads or the publication PATCH. A concurrent writer can change the release or its assets between checks and writes; coordinate or exclude concurrent writers. A failed post-PATCH confirmation cannot undo publication.

Strict requests explicitly send `X-GitHub-Api-Version: 2022-11-28`, including to custom GitHub-compatible endpoints; an endpoint that does not support this version may reject them. The version header does not guarantee a digest exists, and older assets or unsupported hosts still fail verification.

To recover a draft after an interrupted npm publish, rebuild the identical assets from the tag and run `--attach "$TAG" --verify-assets --keep-draft` before npm publish. Then run `--attach "$TAG" --verify-assets` after npm publish succeeds **or was already published**: it verifies again and publishes the draft. Gate this last step on tag discovery and successful preparation, not on `publish=true`, so an npm-already-published retry still finalizes. A rebuilt file that differs must not replace the original automatically. Strict verification is opt-in and does not change the default attach behavior or other hosts.

### Coming from `semantic-release`

A `.releaserc` is still read - after `sasjsconfig.json`, never instead of it - so a
repository can migrate one release at a time. The list is the same `{ path, label }`
pairs, under a `plugins` entry:

```json
{ "plugins": [ ["@sasjs/release", { "assets": [ ... ] }] ] }
```

An entry still named `@semantic-release/github` is read too, and the run says to
rename it. Moving the list into `sasjsconfig.json` is the end of the migration:
after that the `.releaserc` is gone, and `semantic-release` plus its plugins can
come out of `devDependencies`.

What this will not do is write `CHANGELOG.md`: the release page is the changelog,
generated from the commits the tag covers, so a repository that wants the file keeps
generating it from the release notes.

GitLab releases carry links rather than uploaded files, which is what `--asset-link` is for; the usual link is the job artifact of the build that just ran. GitLab does not accept `Authorization: Bearer`, so the token goes in `PRIVATE-TOKEN`, or in `JOB-TOKEN` when it is `$CI_JOB_TOKEN` - which needs no personal token at all. `--token-header` overrides the choice.

## Adapters

`publish()` has one small function per host, because the shapes genuinely differ:

- **GitHub** - `POST /repos/{repo}/releases`, then each asset to the `upload_url` in the response (with the `{?name,label}` template stripped).
- **Gitea** - `POST {api}/repos/{repo}/releases`, multipart to `.../releases/{id}/assets`, and a `PATCH` for the body, because Gitea stores what it is given.
- **GitLab** - `POST {api}/projects/{path}/releases` with `ref` (the tag is created from it when missing), then `.../releases/{tag}/assets/links` per link.

A new host is one function plus an entry in `HOSTS`.

## Development

```bash
npm test              # fixtures: real git repositories, and a stub host
npm run test:coverage # the same suite with a floor: 97% lines, 69% branches
npm run test:mutate   # breaks each guard and requires the suite to notice
npm run test:live -- --repo <sandbox>   # the forge itself, creating and deleting
```

The fixtures are real git repositories built per test, so the bump rules, the tag prefix, the path filter, prereleases and the re-run path are exercised against git rather than a mock. The host adapters are exercised against a stub HTTP server that records the requests.

Three kinds of test, because they fail differently:

- **Fixtures** prove the logic. They run on every push, on Node 20, 22 and 24 - the versions callers use.
- **Mutation** proves the fixtures bite. Each entry in `scripts/mutate.mjs` breaks one guard in a copy of `release.mjs` - the shallow-clone refusal, the branch gate, the 404 branch, the draft flag, an unknown flag, the local tag, the breaking-change rule, the stamp, the version check, the find-before-create - and the suite has to fail. A mutant that survives is a property nothing checks.
- **The live contract** proves the *stubs* are right. It creates a draft release, uploads an asset, publishes it, re-runs to check the re-runnable path, and deletes everything again, against a sandbox repository. It is the only test that notices the forge changing, so it runs weekly rather than per pull request.

  The schedule lives in the sandbox repository (`sasjs/sandpit`), not here: that repository's own token can write to itself, so the check needs no secret, and a release tool that needed a long-lived token to test itself would be arguing against what it exists for. `.github/workflows/live-contract.yml` there checks this repository out and runs `node tool/scripts/live-contract.mjs --repo ${{ github.repository }}`.

The live contract has earned its keep three times over: GitHub's by-tag endpoint does not return **draft** releases (so a drafted release could never be found again), a **draft** does not create its tag until it is published, and `git describe` answers with the wrong tag when two name the same commit - which is exactly the state a finished release leaves.
