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
| `--attach <tag>` | upload the configured assets to a release that already exists, and cut nothing |
| `--asset-link <n=url>` | link to attach (repeatable; the only asset shape GitLab has) |
| `--prepare-publish` | gate a publish instead of cutting a release - see below |
| `--sha <sha>` | commit to look for a tag at, with `--prepare-publish` (default: `HEAD`) |
| `--branch <ref>` | the branch a publishable tag must be on (default: `HEAD`) |
| `--registry <url>` | registry to ask whether the version exists (default: the public npm registry) |
| `--republish` | publish even when the registry already serves that version |
| `--draft` | create the release as a draft: the tag exists, the release does not, until something publishes it (`gh release edit <tag> --draft=false`) |

Exit codes: `0` released or nothing to release, `2` usage, git or host error.

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

It does not run `npm publish` - that stays in the publishing workflow, which is the identity npm trusts for provenance - and it does not create the tag or the release; that is what the rest of this tool is for. A publish workflow therefore reads:

```yaml
- uses: actions/checkout@<sha>
  with: { ref: main, fetch-depth: 0, persist-credentials: false }
- run: npm run release -- --prepare-publish --sha "${{ github.event.workflow_run.head_sha }}" --branch main --output "$GITHUB_OUTPUT"
  id: prepare
  env: { NODE_AUTH_TOKEN: '${{ secrets.NPM_TOKEN }}' }
- run: git checkout -q "refs/tags/${{ steps.prepare.outputs.tag }}"
  if: steps.prepare.outputs.skip != 'true'
- run: npm publish --provenance
  if: steps.prepare.outputs.publish == 'true'
```

`--dry-run` prints the same decisions and writes nothing, which is how a failing publish job is debugged without publishing.

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
