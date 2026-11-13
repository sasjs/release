# @sasjs/release

Releases from conventional commits, for any host. Zero dependencies, one file.

The version is the git tag. Nothing writes a version into `package.json`, nothing commits, nothing pushes to a branch: the tag names the commit that was merged, and the release notes are the commits it covers. GitHub, Gitea, GitLab and a laptop all run the same command.

```bash
npx @sasjs/release --dry-run          # what it would tag, and the notes
npx @sasjs/release --tag --push-tag   # cut it
npx @sasjs/release --tag --host gitlab --release
```

## Why not a release toolchain

`semantic-release` and `release-please` arrive with a few hundred packages, a plugin per job, and advisories that no one can fix (their copies of `npm`, `glob` and `undici` are bundled inside the tool). This is ~450 lines and installs nothing, so there is nothing to audit and nothing to upgrade. It also does not need a `gh` CLI, `curl`, `jq` or `tea`: the host calls are plain `fetch`.

Two things it does that the toolchain cannot:

- **A failed release is re-runnable.** If a run dies after the tag is cut - the push rejected, the API down, the runner killed - re-running with the same flags finishes it. The tag is reused instead of refused, and the notes are rebuilt from the commits the tag covers.
- **Nothing lands on your default branch.** No release commit, no `package.json` bump, no second push for the tag, so no protected-branch or app-token dance.

## Options

| Option | Meaning |
| --- | --- |
| `--repo-dir <path>` | repository to work in (default: cwd) |
| `--tag-prefix <p>` | prefix before the version in the tag (default `v`) |
| `--since <ref>` | count commits after this ref (default: newest prefixed tag) |
| `--paths <a,b>` | only commits touching these paths - monorepos |
| `--level <l>` | force `patch`, `minor` or `major` instead of classifying |
| `--prerelease <id>` | cut `<version>-<id>.1`, or continue the last one (`beta.2` -> `beta.3`) |
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
| `--asset-link <n=url>` | link to attach (repeatable; the only asset shape GitLab has) |

Exit codes: `0` released or nothing to release, `2` usage, git or host error.

The result is printed as `key=value` lines, so a pipeline can feed it to whatever variable protocol it has - `$GITHUB_OUTPUT`, `$GITHUB_ENV`, a dotenv artifact, nothing at all - with `--output`.

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
    - npx --yes @sasjs/release --tag --push-tag --host gitlab
        --release --api-url "$CI_API_V4_URL" --repo "$CI_PROJECT_PATH"
        --output release.env
        --asset-link "app.zip=$CI_PROJECT_URL/-/jobs/artifacts/$CI_COMMIT_SHA/download?job=build"
  artifacts:
    reports:
      dotenv: release.env
  variables:
    GIT_DEPTH: '0' # GitLab clones 20 commits deep by default
```

GitLab releases carry links rather than uploaded files, which is what `--asset-link` is for; the usual link is the job artifact of the build that just ran.

## Adapters

`publish()` has one small function per host, because the shapes genuinely differ:

- **GitHub** - `POST /repos/{repo}/releases`, then each asset to the `upload_url` in the response (with the `{?name,label}` template stripped).
- **Gitea** - `POST {api}/repos/{repo}/releases`, multipart to `.../releases/{id}/assets`, and a `PATCH` for the body, because Gitea stores what it is given.
- **GitLab** - `POST {api}/projects/{path}/releases`, then `.../releases/{tag}/assets/links` per link.

A new host is one function plus an entry in `HOSTS`.

## Development

```bash
npm test   # node --test: 21 tests, fixture repositories and a stub host
```

The fixtures are real git repositories built per test, so the bump rules, the tag prefix, the path filter, prereleases and the re-run path are exercised against git rather than a mock. The host adapters are exercised against a stub HTTP server that records the requests.
