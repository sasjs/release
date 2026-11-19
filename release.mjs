#!/usr/bin/env node
/**
 * Decide and cut a release from conventional commits.
 *
 * The version is the git tag. Nothing in this script writes a version into
 * package.json, commits, or pushes to a branch: the tag names the commit that
 * was merged, and the release notes are the commits it covers. That removes the
 * release commit, the branch push and the retry-outs that come with it.
 *
 * Host-neutral by construction: the git side (classify, version, notes, tag)
 * needs nothing but git, and the release side talks to an API over plain
 * https, so GitHub, Gitea, GitLab and anything with the same shape work
 * without a CLI installed. `--host none` does the git work only.
 *
 *     sasjs-release --dry-run
 *     sasjs-release --tag --push-tag --host github --release
 *     sasjs-release --tag --host gitlab --release --asset-link "app.zip=$URL"
 *
 * Exit 0: released, or nothing to release (`released=false` in --output).
 * Exit 2: usage, git or host error; nothing is tagged when this is returned
 * before the tag step, and the tag alone exists when it is returned after.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, statSync, writeFileSync, appendFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import { createHash } from 'node:crypto'

const LEVELS = { major: 3, minor: 2, patch: 1 }

const HELP = `sasjs-release - releases from conventional commits

  --repo-dir <path>      repository to work in (default: cwd)
  --tag-prefix <p>       prefix before the version in the tag (default: v)
  --since <ref>          count commits after this ref (default: newest prefixed tag)
  --paths <a,b>          only commits touching these paths (monorepos)
  --show-context         print the host, API and repository this run would use, and
                         stop - useful when the environment decides them
  --keep-draft           leave the release a draft after attaching, instead of
                         publishing it
  --no-assets            cut the release without attaching anything: the files are
                         built from the tag and attached afterwards with --attach
  --attach <tag>         upload the configured assets to a release that already
                         exists, and nothing else: for artefacts built after the
                         tag, with the version stamped into them
  --verify-assets        with --attach, require GitHub SHA-256 digests before publishing
  --level <l>            force patch|minor|major instead of classifying
  --discover-publish     resolve a publish tag without stamping or registry access
  --prepare-publish      resolve and gate a publish, stamp the version, ask the
                         registry; writes no tag and creates no release
  --sha <sha>            commit to look for a tag at (default: HEAD)
  --branch <ref>         the branch a publishable tag must be on (default: HEAD)
  --registry <url>       registry to ask (default: https://registry.npmjs.org)
  --republish            publish even when the version is already on the registry
  --no-registry-lookup   do not ask the registry whether the version exists; the
                         artifact ships somewhere that is not npm (a marketplace,
                         an app store), so npm cannot answer the question
  --audit                judge the npm audit report: the production tree is never
                         exemptible, and a dev advisory passes only when the
                         allowlist argues for it
  --audit-level <l>      severity floor: info|low|moderate|high|critical (default low)
  --audit-omit <a,b>     judge the npm --omit set instead of the full tree, eg dev
  --audit-config <path>  exemption list (default scripts/audit-allowlist.json; a
                         repository without one has no exemptions)
  --audit-report <path>  write the report this run judged here
  --audit-input <path>   read a recorded full-tree report instead of running npm
  --audit-prod-input <p> read a recorded production report (needed for a replay
                         with any exemption)
  --assert-no-dependencies
                         fail unless the installed @sasjs/release ships no
                         dependencies of its own
  --draft                create the release as a draft, so it is invisible until
                         something publishes it (gh release edit --draft=false)
  --prerelease <id>      cut <version>-<id>.1 (or continue the last one)
  --dry-run              say what it would do; write nothing, send nothing
  --notes-file <path>    write the release notes here
  --output <path>        append key=value lines: released, version, tag, level
  --tag                  create the annotated tag (reused if it is already here)
  --push-tag             push the tag to origin
  --host <h>             none|github|gitea|gitlab (default: none)
  --release              create the host release (github/gitea/gitlab)
  --repo <owner/name>    repository on the host (default: from the remote)
  --api-url <url>        host API base (default: per host)
  --token-env <NAME>     environment variable holding the token
  --token-header <h>     which header carries it (default: per host)
  --asset <path>         file to upload to the release (repeatable)
  --asset-link <n=url>   link to attach to the release (repeatable)
  --config <path>        config naming the assets to attach. Default: the
                         release.assets of sasjs/sasjsconfig.json, then a .releaserc
                         (a migration path). The list is
                         { "assets": [ { "path": "...", "label": "..." } ] }
  --title <text>         release title (default: the tag)
  --help                 this text
`

// Every flag the tool knows. A typo is otherwise silent: `flag()` is a lookup in
// argv, so `--drafts` reads as false and the run quietly does something else -
// which is how a dropped `--draft` would publish a release before its assets
// exist rather than failing.
const known = new Set([
  'api-url', 'asset', 'asset-link', 'attach', 'audit', 'audit-config', 'audit-input',
  'audit-level', 'audit-omit', 'audit-prod-input', 'audit-report', 'assert-no-dependencies',
  'branch', 'config', 'draft', 'dry-run', 'help', 'host',
  'discover-publish', 'level', 'notes-file', 'output', 'paths', 'prepare-publish', 'prerelease',
  'keep-draft', 'no-assets', 'push-tag', 'show-context', 'registry', 'release', 'repo', 'repo-dir', 'republish', 'sha',
  'no-registry-lookup',
  'since', 'tag', 'tag-prefix', 'title', 'token-env', 'token-header', 'verify-assets'
])

function checkFlags() {
  for (const token of process.argv.slice(2)) {
    if (!token.startsWith('--')) continue
    if (!known.has(token.slice(2))) fail(`unknown flag ${token} - run --help for the list`)
  }
}

const flag = (name) => process.argv.includes(`--${name}`)

const arg = (name, fallback = '') => {
  const at = process.argv.indexOf(`--${name}`)
  if (at === -1) return fallback
  const value = process.argv[at + 1]
  if (value === undefined || value.startsWith('--')) fail(`--${name} needs a value`)
  return value
}

const args = (name) =>
  process.argv.reduce((all, token, index) => {
    if (token === `--${name}`) {
      const value = process.argv[index + 1]
      if (value === undefined || value.startsWith('--'))
        fail(`--${name} needs a value`)
      all.push(value)
    }
    return all
  }, [])

function fail(message) {
  console.error(`sasjs-release: ${message}`)
  process.exit(2)
}

// stderr is captured rather than inherited: several probes (a missing `origin`,
// an absent tag) are expected to fail, and their noise is not a finding
const git = (cwd, ...argv) =>
  execFileSync('git', argv, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

const attempt = (fn) => {
  try {
    return fn()
  } catch {
    return ''
  }
}

// Whether a probe exited 0. `attempt` returns its output, and several git probes
// (`merge-base --is-ancestor` above all) say yes by printing nothing at all - so
// testing their output for truthiness answers a different question than the one
// asked, and answers it wrongly exactly when it matters.
const succeeds = (fn) => {
  try {
    fn()
    return true
  } catch {
    return false
  }
}

// SemVer precedence ignores build metadata; ties are rejected rather than choosing
// between distinct tags that name the same precedence arbitrarily.
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/
function parseVersion(version) {
  const match = SEMVER.exec(version)
  if (!match || (match[4] && match[4].split('.').some((part) => /^\d+$/.test(part) && part.length > 1 && part[0] === '0'))) return null
  return { core: match.slice(1, 4), pre: match[4]?.split('.') }
}
function compareVersion(a, b) {
  const numeric = (x, y) => x.length - y.length || (x < y ? -1 : x > y ? 1 : 0)
  for (let i = 0; i < 3; i++) {
    const diff = numeric(a.core[i], b.core[i])
    if (diff) return diff
  }
  if (!a.pre || !b.pre) return a.pre ? -1 : b.pre ? 1 : 0
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    if (a.pre[i] === undefined) return -1
    if (b.pre[i] === undefined) return 1
    const x = a.pre[i], y = b.pre[i]
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y)
    const diff = xn && yn ? numeric(x, y) : xn ? -1 : yn ? 1 : x < y ? -1 : x > y ? 1 : 0
    if (diff) return diff
  }
  return 0
}

/** The commit range to classify: after the newest tag carrying our prefix. */
/**
 * The newest tag reachable from HEAD.
 *
 * `git describe --abbrev=0` answers with the tag it prefers, and when two tags
 * name the same commit it can answer with the older one - measured: v0.3.1 and
 * v0.3.2 both at HEAD, describe said v0.3.1. That is exactly the state a
 * completed release leaves behind, so the next run would compute a version that
 * already exists. List the tags that are merged into HEAD and sort them by
 * version instead: reachability is still respected, and "newest" means newest.
 */
const latestTag = (cwd, prefix) =>
  (
    attempt(() =>
      git(cwd, 'tag', '--merged', 'HEAD', '--list', `${prefix}[0-9]*`, '--sort=-v:refname')
    ) || ''
  )
    .split('\n')
    .filter(Boolean)[0] || ''

/** Subject and body per commit, newest last. NUL and 0x01 separate the fields. */
function commits(cwd, from, paths, to = 'HEAD') {
  const range = from ? `${from}..${to}` : to
  const raw = attempt(() =>
    git(cwd, 'log', range, '--pretty=format:%s%x00%b%x01', '--', ...paths)
  )
  if (!raw) return []
  return raw
    .split('\x01')
    .filter(Boolean)
    .map((entry) => {
      const [subject, body = ''] = entry.split('\x00')
      return { subject: subject.trim(), body: body.trim() }
    })
}

const SUBJECT = /^([a-z]+)(\([^)]*\))?(!)?:\s*(.+)$/i
const TYPES = { feat: 'feat', fix: 'fix', perf: 'perf', refactor: 'refactor' }
const TITLES = {
  breaking: 'BREAKING CHANGES',
  feat: 'Features',
  fix: 'Bug Fixes',
  perf: 'Performance',
  refactor: 'Refactors'
}

function classify({ subject, body }) {
  const match = subject.match(SUBJECT)
  if (!match) return { type: 'other', breaking: false, text: subject }
  const [, type, , bang, text] = match
  return {
    type: type.toLowerCase(),
    breaking: Boolean(bang) || /^BREAKING[ -]CHANGE:/m.test(body),
    text: text.trim()
  }
}

/** The stable part of a tag's version, so a prerelease base still bumps. */
const stable = (version) => version.split('-')[0]

function bump(base, level) {
  const [major, minor, patch] = stable(base).split('.').map(Number)
  if (level === 'major') return `${major + 1}.0.0`
  if (level === 'minor') return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

/**
 * A prerelease continues the last prerelease of the same base version, so
 * re-running before the stable cut moves beta.1 -> beta.2 rather than
 * producing a second beta.1.
 */
function bumpPrerelease(base, id, previous) {
  base = stable(base)
  if (previous) {
    const match = previous.match(/^(\d+)\.(\d+)\.(\d+)-([^.]+)\.(\d+)$/)
    if (match) {
      const [, major, minor, patch, previousId, n] = match
      const at = `${major}.${minor}.${patch}`
      const next = Number(n) + 1
      if (at === base && previousId === id) return `${base}-${id}.${next}`
      return `${base}-${id}.1`
    }
  }
  return `${base}-${id}.1`
}

/** https://host/owner/repo from any remote form, so notes can link to diffs. */
function remoteUrl(cwd) {
  const raw = attempt(() => git(cwd, 'remote', 'get-url', 'origin'))
  if (!raw) return ''
  const match = raw.match(/^(?:[\w-]+:\/\/)?(?:[^@/]+@)?([^:/]+)[:/](.+?)(?:\.git)?$/)
  if (!match) return ''
  const [, host, path] = match
  return `https://${host}/${path.replace(/\.git$/, '')}`
}

function notes(version, parsed, previous, repo, date) {
  const link = repo
    ? previous
      ? `${repo}/compare/${previous}...v${version}`
      : `${repo}/releases/tag/v${version}`
    : ''
  const groups = { breaking: [], feat: [], fix: [], perf: [], refactor: [] }
  for (const commit of parsed) {
    if (commit.breaking) groups.breaking.push(commit)
    if (commit.type in TYPES) groups[commit.type].push(commit)
  }

  const heading = link ? `## [${version}](${link})` : `## ${version}`
  const lines = [`${heading}${date ? ` (${date})` : ''}`, '']
  for (const key of Object.keys(TITLES)) {
    if (!groups[key].length) continue
    lines.push(`### ${TITLES[key]}`, '')
    for (const commit of groups[key]) lines.push(`* ${commit.text}`)
    lines.push('')
  }
  return lines.join('\n')
}

/**
 * Attaches a file to a release, in the shape the host parses.
 *
 * GitHub takes the file AS the request body: `POST .../releases/{id}/assets?name=`
 * reads the raw bytes, and a multipart body sent to it is stored verbatim - so a
 * release cut that way carries a file beginning `------formdata-undici-...`
 * instead of the build, and every download from it is corrupt while the upload
 * itself answered 201. Gitea parses multipart and takes the part it names, so the
 * part name decides which of the two a call gets.
 *
 * Node's own FormData and Blob keep this dependency-free for the multipart case.
 */
async function upload(url, headers, file, field) {
  const bytes = readFileSync(file)

  if (!field)
    return request(url, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/octet-stream' },
      body: bytes
    })

  const body = new FormData()
  body.append(field, new Blob([bytes]), basename(file))
  return request(url, { method: 'POST', headers, body })
}

/**
 * Each forge spells its credential differently, and getting this wrong is a
 * 401 that looks like a permissions problem: GitHub and Gitea take an
 * Authorization scheme, GitLab takes its own header and rejects Bearer. A
 * GitLab job token works too - it needs no personal token at all.
 */
function authHeaders(host, token, header) {
  if (!token) return {}
  if (host === 'gitlab')
    return { [header || (process.env.CI_JOB_TOKEN === token ? 'job-token' : 'private-token')]: token }
  return { authorization: host === 'gitea' ? `token ${token}` : `Bearer ${token}` }
}

class HttpError extends Error {
  constructor(method, url, status, text) {
    super(`${method} ${url} answered ${status}: ${text.slice(0, 500)}`)
    this.status = status
  }
}

async function request(url, { method = 'GET', headers = {}, body, json } = {}) {
  headers = { accept: 'application/json', ...headers }
  if (json !== undefined) headers['content-type'] = 'application/json'

  const response = await fetch(url, {
    method,
    headers,
    body: json !== undefined ? JSON.stringify(json) : body
  })

  const text = await response.text()
  if (!response.ok) throw new HttpError(method, url, response.status, text)
  return text ? JSON.parse(text) : {}
}

/**
 * Find a release by tag, drafts included.
 *
 * GitHub's by-tag endpoint answers 404 for a draft release, so a run that created
 * a draft and died before attaching its assets could never find it again - the
 * create answers 422, the lookup answers 404, and the run fails having left a
 * draft nobody can finish. The list endpoint does return drafts, so it is the
 * fallback that makes a drafted release re-runnable at all.
 */
async function findRelease(base, repo, tag, headers) {
  const byTag = await request(`${base}/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, {
    headers
  }).catch((error) => {
    if (error.status === 404) return null
    throw error
  })
  if (byTag) return byTag

  // a repository with releases disabled answers 404 to the listing as well, and
  // that is still "no release for this tag" rather than a failure to ask
  const releases = await request(`${base}/repos/${repo}/releases?per_page=100`, {
    headers
  }).catch((error) => {
    if (error.status === 404) return []
    throw error
  })
  return (Array.isArray(releases) ? releases : []).find((release) => release.tag_name === tag) || null
}

/**
 * A release that already exists is not a failure: the run that created it may
 * have died on the next step, and the whole point of `--release` being
 * idempotent is that re-running finishes the job. The forges disagree on the
 * status - GitHub says 422, Gitea and GitLab say 409 - and all of them can then
 * be asked for the release they refused to create twice.
 */
async function createOrFind(url, options, find, identity) {
  // Look before creating. A forge will happily create a second release for a tag
  // that already has one - as a draft, invisibly - so recovering from 422 alone
  // is not enough once drafts are in play: a re-run after publishing produced a
  // duplicate draft on a real repository.
  //
  // An existing release is reused only when it names the commit this run is
  // releasing. It usually does not: a draft creates no tag (the tag appears when
  // the draft is published, so a run that dies after the cut burns nothing), and
  // the next run re-classifies the same commits to the same version - so the
  // release it finds was cut for an EARLIER commit. Finishing that one would
  // attach today's build to a tag created at yesterday's commit.
  const reuse = async (existing) => {
    // A sha is compared as a STRING, not resolved through the clone: a release
    // job's checkout may be shallow, and the commit a stale draft names is
    // exactly the object such a checkout does not carry - so resolving it would
    // fail, and reading that failure as "names this commit" finishes the stale
    // draft the comparison exists to catch. Anything that is not a sha - the
    // branch name a release made in the web UI stores, a short sha - cannot be
    // compared without guessing what it pointed at when the release was cut, so
    // it is reused as before.
    const sha = (value) =>
      typeof value === 'string' && /^[0-9a-f]{40,64}$/i.test(value)
        ? value.toLowerCase()
        : undefined
    const named = sha(existing.target_commitish)
    const commit = sha(identity?.commit)

    if (!commit || !named || named === commit) {
      console.log('a release for this tag already exists: finishing it')
      return existing
    }

    if (existing.draft !== true)
      fail(
        `a published release for ${identity.tag} already names ${named}, and this run releases ${identity.commit} - refusing to attach this build to it`
      )

    await identity.discard(existing)
    console.log(
      `discarded a stale draft for ${identity.tag}: it named ${named}, and this run releases ${identity.commit}`
    )
    return null
  }

  // Anything the host will not check for us has to be checked before the create:
  // see the tag check the GitHub path passes as beforeCreate.
  const create = async () => {
    await identity?.beforeCreate?.()
    return request(url, options)
  }

  const existing = await find().catch(() => null)
  // `id` is what makes a response a release: a host that answers 200 with
  // something else (an empty object, an error body) has not found one
  if (existing && existing.id) {
    const reused = await reuse(existing)
    if (reused) return reused
  }

  try {
    return await create()
  } catch (error) {
    if (error.status !== 422 && error.status !== 409) throw error
    // a lookup that fails is not the finding: the refusal to create is, and
    // reporting the 404 from the lookup sends the reader after the wrong call
    const refused = await find().catch(() => null)
    if (!refused || !refused.id) throw error
    const reused = await reuse(refused)
    if (reused) return reused
    // the stale draft is gone, so the same create is now a create rather than a
    // refusal - which is what a second attempt means here
    return await create()
  }
}

/**
 * One `--asset` argument: the file on disk, the name it is published under, and
 * the label a reader sees. A file the caller names does not exist fails here
 * rather than as a read error after the release has been created.
 */
function assetOf(path, label, base, source = '--asset', name) {
  // relative to the repository being released, the same way every other path
  // this tool takes is: a workflow runs from the checkout, but --repo-dir says
  // which directory that is
  const file = isAbsolute(path) ? path : join(base, path)

  if (!existsSync(file)) fail(`${source} names a file that is not there: ${path}`)

  // The name is the download: a release asset is served at
  // `<repo>/releases/latest/download/<name>`, so a build output named after its
  // target can be published under the name a page already links to.
  const published = name || basename(file)

  if (published !== basename(published) || published === '.' || published === '..')
    fail(`${source} publishes ${path} as ${published}: an asset name is a file name`)

  return { name: published, path: file, ...(label ? { label } : {}) }
}

/**
 * The assets a repository's config names.
 *
 * One file, because a release job has one list of things to attach and a second
 * file to hold it is a second place for it to be wrong. The list is `assets` at the
 * root, or `assets` inside a `plugins` entry named `@sasjs/release` - the shape a
 * repository already has if it came from semantic-release, with one string renamed:
 *
 *     { "plugins": [ ["@sasjs/release", { "assets": [ ... ] }] ] }
 *
 * An entry still named `@semantic-release/github` is read as well, and the run says
 * so: that is the migration, and naming it is how the reader learns the one edit
 * left to make.
 */
function assetsFromConfig(file, base, { discovered = false } = {}) {
  const parsed = readJson(file, base, '--config')

  if (Array.isArray(parsed)) return assetsOf(parsed, file, base)
  if (Array.isArray(parsed?.assets)) return assetsOf(parsed.assets, file, base)

  // `sasjsconfig.json`, where a project's release lives: the same list, under the
  // key the schema documents, so a repository has one config file rather than two
  if (Array.isArray(parsed?.release?.assets))
    return assetsOf(parsed.release.assets, file, base)

  const plugins = Array.isArray(parsed?.plugins) ? parsed.plugins : []

  const entry = (pattern) =>
    plugins.find((plugin) => Array.isArray(plugin) && pattern.test(String(plugin[0])))

  const ours = entry(/^@sasjs\/release$/)

  if (Array.isArray(ours?.[1]?.assets)) return assetsOf(ours[1].assets, file, base)

  const theirs = entry(/@semantic-release\/github$/)

  if (Array.isArray(theirs?.[1]?.assets)) {
    console.log(
      `@semantic-release/github is read from ${file}: rename that entry to @sasjs/release and this note goes away`
    )

    return assetsOf(theirs[1].assets, file, base)
  }

  // A file the caller named is a mistake when it says nothing about assets. A file
  // found by convention is not: `.releaserc` is what semantic-release calls its own,
  // so a repository carrying one for its own reasons releases without assets.
  if (discovered) return []

  return fail(
    `--config ${file} names no assets: expected { "assets": [ ... ] }, a bare array, or a plugins entry named @sasjs/release`
  )
}

/** The entries themselves: a path, or `{ path, label }`. */
function assetsOf(listed, file, base) {
  return listed.map((entry) => {
    const path = typeof entry === 'string' ? entry : entry?.path
    if (typeof path !== 'string' || !path)
      fail(`${file} has an asset entry with no path: ${JSON.stringify(entry)}`)

    const label = typeof entry === 'string' ? undefined : entry.label
    const name = typeof entry === 'string' ? undefined : entry.name

    if (name !== undefined && (typeof name !== 'string' || !name))
      fail(`${file} has an asset entry with no name: ${JSON.stringify(entry)}`)

    return assetOf(path, label, base, file, name)
  })
}

/**
 * The assets to attach, from the config the caller named or the one the repository
 * has.
 *
 * `.releaserc` first: it is the name a repository coming from semantic-release
 * already carries, and the migration is a string inside it rather than a new file
 * beside it.
 */
function configAssets(cwd) {
  const named = arg('config')

  if (named) return assetsFromConfig(named, cwd)

  for (const candidate of DEFAULT_CONFIGS) {
    const at = join(cwd, candidate)

    if (!existsSync(at)) continue

    // a sasjsconfig with no `release` block says nothing about assets, so it does
    // not stop the search - the next candidate may be the file it came from
    if (candidate === DEFAULT_PROJECT_CONFIG && !hasReleaseAssets(at)) continue

    return assetsFromConfig(candidate, cwd, { discovered: true })
  }

  return []
}

/** Whether a config names release assets at all, without reporting on one that does not. */
function hasReleaseAssets(file) {
  try {
    return Array.isArray(JSON.parse(readFileSync(file, 'utf8'))?.release?.assets)
  } catch (_) {
    return false
  }
}

/** A JSON file the caller named, read from the repository, with its own reason when it cannot be. */
function readJson(file, base, flag) {
  const at = isAbsolute(file) ? file : join(base, file)

  try {
    return JSON.parse(readFileSync(at, 'utf8'))
  } catch (error) {
    return fail(`${flag} ${file} could not be read: ${error.message}`)
  }
}

/** An asset that is already attached is also not a failure. */
async function uploadOnce(url, headers, file, field) {
  try {
    return await upload(url, headers, file, field)
  } catch (error) {
    if (error.status === 422 || error.status === 409) {
      console.log(`${basename(file)} is already attached`)
      return {}
    }
    throw error
  }
}

/**
 * The project config, where a release's assets belong. SASjs keeps it in the
 * `sasjs` folder of a project, beside the services and macros it describes.
 */
const DEFAULT_PROJECT_CONFIG = join('sasjs', 'sasjsconfig.json')

/** Read in this order when no flag names a config: the project's, then the migration's. */
const DEFAULT_CONFIGS = [DEFAULT_PROJECT_CONFIG, '.releaserc', '.releaserc.json']

/**
 * Where this run is, when the environment already knows.
 *
 * A release in CI has no business asking which forge it is on: GITLAB_CI, or
 * GITHUB_ACTIONS with the server URL it was given, names it - along with the
 * repository and the token that are already in the environment. Asking a workflow to
 * repeat them is how a cut ends up dying on `--release needs --host` while the answer
 * was two variables away.
 */
function detectContext() {
  if (process.env.GITLAB_CI) return { host: 'gitlab', api: process.env.CI_API_V4_URL }

  if (process.env.GITHUB_ACTIONS === 'true') {
    const server = (process.env.GITHUB_SERVER_URL || 'https://github.com').replace(/\/$/, '')

    // gitea runs Actions too, and says so with its own server URL
    return server === 'https://github.com'
      ? { host: 'github', api: 'https://api.github.com' }
      : { host: 'gitea', api: `${server}/api/v1` }
  }

  return { host: 'none' }
}

/**
 * The token for a host: the variable named for it, or the one every Actions run
 * already has. GH_TOKEN is the convention here, but a workflow that forgets it still
 * carries GITHUB_TOKEN, and refusing on that would be pedantry.
 */
function tokenFor(host, name) {
  const env = name || HOSTS[host].token
  return process.env[env] || (host === 'github' ? process.env.GITHUB_TOKEN || '' : '')
}

/** The repository the run is releasing, when CI names it. */
const detectRepo = () => process.env.GITHUB_REPOSITORY || ''

const HOSTS = {
  github: {
    api: 'https://api.github.com',
    token: 'GH_TOKEN'
  },
  gitea: {
    api: '',
    token: 'GITEA_TOKEN'
  },
  gitlab: {
    api: 'https://gitlab.com/api/v4',
    token: 'GITLAB_TOKEN'
  }
}

/**
 * Create (or find) the release and attach what was asked for. Each host is a
 * small function because the shapes genuinely differ: GitHub needs a separate
 * upload endpoint, Gitea posts multipart to its own asset URL, and GitLab has
 * no asset upload at all - a release carries links, which is why --asset-link
 * exists.
 */
/**
 * Attach the configured assets to a release that already exists.
 *
 * The artefacts of a release are sometimes built after the tag - a version
 * stamped into them, so they cannot be passed at the moment the release is cut -
 * and this is the second half of that: the same list, uploaded to the tag that
 * has already been made.
 */
async function strictRequest(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || 'GET',
    headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...options.headers,
      ...(options.json === undefined ? {} : { 'content-type': 'application/json' }) },
    body: options.json === undefined ? options.body : JSON.stringify(options.json),
    redirect: 'error'
  })
  const text = await response.text()
  if (!response.ok) throw new HttpError(options.method || 'GET', url, response.status, text)
  return text ? JSON.parse(text) : {}
}

async function strictPages(url, headers) {
  const all = []
  const pages = new Set()
  for (let page = 1; page <= 10000; page++) {
    const entries = await strictRequest(`${url}?per_page=100&page=${page}`, { headers })
    if (!Array.isArray(entries) || entries.length > 100) throw new Error(`invalid listing from ${url}`)
    // Keep fixed-size digests (at most 10,000), not a second copy of each page.
    // Remember all digests so nonconsecutive pagination cycles also fail closed.
    const fingerprint = createHash('sha256').update(JSON.stringify(entries)).digest('hex')
    if (entries.length && pages.has(fingerprint)) throw new Error(`pagination repeated at ${url}`)
    pages.add(fingerprint)
    all.push(...entries)
    if (entries.length < 100) return all
  }
  throw new Error(`pagination exceeded 10000 pages at ${url}`)
}

async function attachVerified({ api, headers, repo, tag, files }) {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9_.-]+$/.test(repo) || repo.endsWith('/.') || repo.endsWith('/..'))
    fail('--verify-assets requires --repo owner/name')
  const base = api || HOSTS.github.api
  const endpoint = new URL(base)
  const loopback = endpoint.hostname === '127.0.0.1' || endpoint.hostname === '[::1]'
  if ((endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && loopback)) ||
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
    fail('--verify-assets requires HTTPS without URL credentials or query')
  const path = `${base.replace(/\/+$/, '')}/repos/${repo}/releases`
  const releases = await strictPages(path, headers)
  const matches = releases.filter((release) => release.tag_name === tag)
  if (matches.length !== 1) fail(`expected one release for ${tag}, found ${matches.length}`)
  const release = matches[0]
  if (!Number.isSafeInteger(release.id) || release.id <= 0 || typeof release.draft !== 'boolean')
    fail(`cannot verify release status for ${tag}`)
  if (new Set(files.map((file) => file.name)).size !== files.length)
    fail('duplicate asset names cannot be verified')
  const snapshotDir = mkdtempSync(join(tmpdir(), 'sasjs-release-assets-'))
  try {
    const desired = files.map((file, index) => {
      const bytes = readFileSync(file.path)
      const snapshot = join(snapshotDir, String(index))
      writeFileSync(snapshot, bytes, { mode: 0o600, flag: 'wx' })
      return { ...file, snapshot, size: bytes.length, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` }
    })
    const assetsPath = `${path}/${release.id}/assets`
    let assets = await strictPages(assetsPath, headers)
    const verify = (file, held) => {
      if (held.length !== 1 || held[0].state !== 'uploaded' || held[0].size !== file.size || held[0].digest !== file.digest)
        throw new Error(`cannot verify digest for ${file.name}`)
    }
    for (const file of desired) {
      const held = assets.filter((asset) => asset.name === file.name)
      if (held.length) verify(file, held)
    }
    const confirmIdentity = async () => {
      const current = await strictRequest(`${path}/${release.id}`, { headers })
      if (current.id !== release.id || current.tag_name !== tag || current.draft !== release.draft)
        throw new Error(`release identity or draft status changed for ${tag}`)
    }
    if (desired.some((file) => !assets.some((asset) => asset.name === file.name)))
      await confirmIdentity()
    for (const file of desired) {
      if (!assets.some((asset) => asset.name === file.name)) {
        if (typeof release.upload_url !== 'string' || !release.upload_url) throw new Error(`missing upload URL for ${tag}`)
        const upload = new URL(release.upload_url.replace(/\{.*$/, ''))
        const apiUrl = new URL(base)
        const trusted = upload.origin === apiUrl.origin ||
          (apiUrl.origin === 'https://api.github.com' && upload.origin === 'https://uploads.github.com')
        const expectedPath = new URL(assetsPath).pathname
        if (!trusted || upload.username || upload.password || upload.search || upload.hash || upload.pathname !== expectedPath)
          throw new Error('untrusted upload URL')
        const bytes = readFileSync(file.snapshot)
        if (bytes.length !== file.size || `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== file.digest)
          throw new Error(`snapshot changed for ${file.name}`)
        upload.searchParams.set('name', file.name)
        if (file.label) upload.searchParams.set('label', file.label)
        await strictRequest(upload.href, { method: 'POST', headers: { ...headers, 'content-type': 'application/octet-stream' }, body: bytes })
      }
    }
    assets = await strictPages(assetsPath, headers)
    for (const file of desired) verify(file, assets.filter((asset) => asset.name === file.name))
    await confirmIdentity()
    if (release.draft && !flag('keep-draft')) {
      const result = await strictRequest(`${path}/${release.id}`, { method: 'PATCH', headers, json: { draft: false } })
      if (result.id !== release.id || result.tag_name !== tag || result.draft !== false)
        throw new Error(`cannot confirm publication of ${tag}`)
    }
  } finally {
    rmSync(snapshotDir, { recursive: true, force: true })
  }
}

async function attachAssets({ host, api, token, header, repo, tag, files }) {
  const headers = authHeaders(host, token, header)

  if (flag('verify-assets')) {
    return attachVerified({ api, headers, repo, tag, files })
  }

  if (host === 'github') {
    const base = api || HOSTS.github.api
    const release = await findRelease(base, repo, tag, headers)
    if (!release) fail(`no release for ${tag} in ${repo}`)
    const url = String(release.upload_url).replace(/\{.*$/, '')
    for (const file of files) {
      const named = `?name=${encodeURIComponent(file.name)}${
        file.label ? `&label=${encodeURIComponent(file.label)}` : ''
      }`
      // no part name: GitHub reads the file itself as the body
      await uploadOnce(`${url}${named}`, headers, file.path)
    }
    // Verified before it is published: a release that is visible because an upload
    // returned 200, but does not hold the files it names, is the failure this checks
    // for - so the check comes first and the draft stays invisible if it fails.
    await confirmAssets(
      `${base}/repos/${repo}/releases/${release.id}`,
      { headers },
      files,
      (body) => new Map((body.assets || []).map((asset) => [asset.name, asset.size]))
    )
    return publishDraft(base, repo, release, headers)
  }

  if (host === 'gitea') {
    if (!api) fail('--host gitea needs --api-url (https://your-host/api/v1)')
    const release = await request(
      `${api}/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`,
      { headers }
    ).catch((error) => {
      if (error.status === 404) fail(`no release for ${tag} in ${repo}`)
      throw error
    })
    for (const file of files) {
      await uploadOnce(
        `${api}/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(file.name)}`,
        headers,
        file.path,
        'attachment'
      )
    }
    await confirmAssets(
      `${api}/repos/${repo}/releases/${release.id}/assets`,
      { headers },
      files,
      (list) =>
        new Map(
          (Array.isArray(list) ? list : []).map((asset) => [asset.name, asset.size])
        )
    )
    return publishDraft(`${api}/repos/${repo}/releases`, '', release, headers)
  }

  return fail(
    '--host gitlab has no asset upload: attach the build with --asset-link name=url instead'
  )
}

/**
 * Read the release back and check it carries what the config names.
 *
 * An upload that returned success is not the same as a release that has the file:
 * the name is a query parameter, the response is not inspected, and a release was
 * published with nothing attached because the process looking for the files was
 * pointed at a folder they were not in. The forge holds the answer, so ask it.
 *
 * A name is not the file either. A host that stored something OTHER than what was
 * sent - the multipart envelope around it, say - lists the asset under the right
 * name at the wrong size, which is why the size is compared as well: every
 * artefact of a release is uploaded whole, so a difference means the download is
 * not the build.
 *
 * The local size is measured once per file, before the comparison: measuring it
 * again inside the failure message would let a file removed mid-run throw ENOENT
 * out of the error path instead of the sentence that path exists to write.
 *
 * A host that lists an asset without a size can only be checked by name, and that
 * is said out loud rather than passed over: the size check is the guard against a
 * body stored as the file, and a guard that decides to do nothing has to be
 * visible or it is not a guard.
 */
async function confirmAssets(url, options, files, heldOf) {
  const held = heldOf(await request(url, options))
  const missing = files.filter((file) => !held.has(file.name)).map((file) => file.name)

  if (missing.length)
    fail(
      `the release holds ${held.size} file(s) and is missing: ${missing.join(', ')} - ` +
        `it names ${files.map((file) => file.name).join(', ')}`
    )

  const measured = files.map((file) => ({
    file,
    local: statSync(file.path).size,
    reported: held.get(file.name)
  }))

  const unreported = measured.filter(({ reported }) => typeof reported !== 'number')

  if (unreported.length)
    console.log(
      `the release states no size for: ${unreported.map(({ file }) => file.name).join(', ')} - ` +
        `checked by name only, so a stored body would pass`
    )

  const mislaid = measured.filter(
    ({ reported, local }) => typeof reported === 'number' && reported !== local
  )

  if (mislaid.length)
    fail(
      mislaid
        .map(
          ({ file, reported, local }) =>
            `the release holds "${file.name}" at ${reported} bytes, where the file is ${local} bytes - the upload stored something other than the build`
        )
        .join('; ')
    )

  console.log(`${files.length} file(s) on the release: ${files.map((f) => f.name).join(', ')}`)
}

/**
 * Make a drafted release visible once everything it names is on it.
 *
 * A release cut with `--draft` is invisible until something publishes it, which is
 * what keeps `releases/latest/download/<file>` from answering 404 for as long as the
 * attach takes - or forever, if the attach fails. Attaching is what completes that
 * shape, so attaching publishes, unless the caller says to leave it drafted.
 */
async function publishDraft(base, repo, release, headers) {
  if (!release?.draft || flag('keep-draft')) return release

  const url = repo ? `${base}/repos/${repo}/releases/${release.id}` : `${base}/${release.id}`
  console.log(`publishing ${release.tag_name}: every file it names is attached`)
  return request(url, { method: 'PATCH', headers, json: { draft: false } })
}

async function publish({
  host,
  api,
  token,
  header,
  repo,
  tag,
  body,
  title,
  files,
  links,
  commit,
  isPrerelease,
  draft
}) {
  const headers = authHeaders(host, token, header)
  const encoded = repo.replace('/', '%2F')

  if (host === 'github') {
    const base = api || HOSTS.github.api
    // target_commitish is what binds the release to a commit, so the job needs no
    // git credentials and never pushes to the repository. A DRAFT creates no tag:
    // the tag appears when the draft is published, which is what makes cutting
    // first safe - a run that dies after the cut burns no version, and the next
    // run re-classifies the same commits to the same one.
    const release = await createOrFind(
      `${base}/repos/${repo}/releases`,
      {
        method: 'POST',
        headers,
        json: {
          tag_name: tag,
          target_commitish: commit,
          name: title,
          body,
          prerelease: isPrerelease,
          // a draft keeps the release out of sight until the thing it names is
          // actually installable, and keeps its tag unpublished until then
          draft: Boolean(draft)
        }
      },
      () => findRelease(base, repo, tag, headers),
      {
        tag,
        commit,
        // Re-read before deleting: the lookup that found this release is seconds
        // old, and a draft can be published in between - by a human, by
        // `gh release edit --draft=false`, by another run. Deleting it then
        // destroys a live release and its assets, so the state that justifies the
        // delete is read again here and the run refuses rather than mutates.
        discard: async (release) => {
          const current = await request(
            `${base}/repos/${repo}/releases/${release.id}`,
            { headers }
          )
          if (current?.draft !== true)
            fail(
              `the release for ${tag} was published while this run was looking at it, so it is not a stale draft to discard - refusing to delete a live release`
            )
          await request(`${base}/repos/${repo}/releases/${release.id}`, {
            method: 'DELETE',
            headers
          })
        },
        // GitHub ignores target_commitish when the tag already exists, so a
        // release created for a tag that is already on another commit would point
        // at that commit while this run says it released this one. Ask the host
        // for the tag before creating anything.
        //
        // The ref endpoint, because it is the one with an unambiguous "absent":
        // a missing ref is 404 there, while `/commits/<ref>` answers 422 for the
        // same thing - the state every release starts in, since the create is what
        // makes the tag. An annotated tag names a tag object rather than a commit,
        // so that is peeled before the comparison.
        beforeCreate: async () => {
          const ref = await request(
            `${base}/repos/${repo}/git/ref/tags/${encodeURIComponent(tag)}`,
            { headers }
          ).catch((error) => {
            if (error.status === 404) return null
            throw error
          })

          if (!ref) return

          const named =
            ref.object?.type === 'tag'
              ? (await request(`${base}/repos/${repo}/git/tags/${ref.object.sha}`, { headers }))
                  .object?.sha
              : ref.object?.sha

          if (named && named !== commit)
            fail(
              `tag ${tag} already names ${named}, and this run releases ${commit} - refusing to create a release that would point at the older commit`
            )
        }
      }
    )
    for (const file of files) {
      const url = String(release.upload_url).replace(/\{.*$/, '')
      const named = `?name=${encodeURIComponent(file.name)}${
        file.label ? `&label=${encodeURIComponent(file.label)}` : ''
      }`
      // no part name: GitHub reads the file itself as the body
      await uploadOnce(`${url}${named}`, headers, file.path)
    }
    // the same read-back the attach path does, before the release is visible: this
    // is the path that published assets holding the request body instead of the
    // build, and it answered every upload with 201
    if (files.length)
      await confirmAssets(
        `${base}/repos/${repo}/releases/${release.id}`,
        { headers },
        files,
        (body) => new Map((body.assets || []).map((asset) => [asset.name, asset.size]))
      )
    return release
  }

  if (host === 'gitea') {
    if (!api) fail('--host gitea needs --api-url (https://your-host/api/v1)')
    const release = await createOrFind(
      `${api}/repos/${repo}/releases`,
      {
        method: 'POST',
        headers,
        json: {
          tag_name: tag,
          target_commitish: commit,
          name: title,
          body,
          draft: Boolean(draft),
          prerelease: isPrerelease
        }
      },
      () => request(`${api}/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, { headers })
    )
    for (const file of files) {
      await uploadOnce(
        `${api}/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(file.name)}`,
        headers,
        file.path,
        'attachment'
      )
    }
    // the same read-back GitHub's cut does, for the same reason: an upload that
    // answered 200 is not a release that holds the file, and a cut is the path that
    // publishes without anyone looking
    if (files.length)
      await confirmAssets(
        `${api}/repos/${repo}/releases/${release.id}/assets`,
        { headers },
        files,
        (list) =>
          new Map(
            (Array.isArray(list) ? list : []).map((asset) => [asset.name, asset.size])
          )
      )
    if (body !== release.body) {
      await request(`${api}/repos/${repo}/releases/${release.id}`, {
        method: 'PATCH',
        headers,
        json: { body }
      })
    }
    return release
  }

  if (host === 'gitlab') {
    // GitLab releases carry links, not uploaded files; accepting assets here and
    // attaching none would be a release that looks complete and is not.
    if (files.length)
      fail('--host gitlab has no asset upload: attach the build with --asset-link name=url instead')

    const base = api || HOSTS.gitlab.api
    // GitLab is the same shape: `ref` is what creates the tag when tag_name is
    // new, and without it the call fails on a tag that does not exist yet.
    const release = await createOrFind(
      `${base}/projects/${encoded}/releases`,
      {
        method: 'POST',
        headers,
        json: { name: title, tag_name: tag, ref: commit, description: body }
      },
      () =>
        request(`${base}/projects/${encoded}/releases/${encodeURIComponent(tag)}`, { headers })
    )
    for (const link of links) {
      await request(`${base}/projects/${encoded}/releases/${encodeURIComponent(tag)}/assets/links`, {
        method: 'POST',
        headers,
        json: { name: link.name, url: link.url }
      })
    }
    return release
  }

  fail(`unknown --host ${host}`)
}

/**
 * The half of a publishing pipeline that is the same in every repository: work
 * out which version this run is for, refuse to publish one that was not cut from
 * the branch, stamp it where npm will read it, and ask the registry whether it is
 * already there.
 *
 * It writes no tag and creates no release - release.yml does that - and it never
 * publishes a package. What it replaces is the block of shell that had to be
 * copied into each repository's publish workflow, where the same three edge cases
 * (a shallow clone, a tag off the branch, a version already published) were
 * handled slightly differently in each copy.
 */
async function preparePublish() {
  const cwd = arg('repo-dir', process.cwd())
  const prefix = arg('tag-prefix', 'v')
  const dry = flag('dry-run')
  const branch = arg('branch', 'HEAD')
  // Unqualified branch names must not be resolved by Git's ambiguous refname
  // search (which prefers tags). Explicit refs, HEAD and revision expressions
  // retain their meaning; a short branch name can also use origin's tracking ref.
  const refParts = /^([^~^]+)(.*)$/.exec(branch)
  const base = refParts?.[1] || branch
  const suffix = refParts?.[2] || ''
  const branchRefs = base === 'HEAD' || base.startsWith('refs/') || /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(base)
    ? [branch]
    : base.startsWith('origin/')
      ? [`refs/remotes/${base}${suffix}`]
      : [`refs/heads/${base}${suffix}`, `refs/remotes/${base}${suffix}`, `refs/remotes/origin/${base}${suffix}`]
  const resolveBranches = () => branchRefs.map((ref) => ({ ref, commit: attempt(() =>
    git(cwd, 'rev-parse', '-q', '--verify', '--end-of-options', `${ref}^{commit}`)
  ) })).filter(({ commit }) => commit)
  let candidates
  if (flag('discover-publish')) {
    candidates = resolveBranches()
    if (!candidates.length) fail(`cannot resolve ${branch} in this repository`)
  }
  if (flag('discover-publish') && git(cwd, 'rev-parse', '--is-shallow-repository') === 'true')
    fail('this checkout is shallow; fetch a full history and tags (fetch-depth: 0)')

  const packagePath = join(cwd, 'package.json')
  let pkg
  if (!flag('discover-publish')) {
    try {
      pkg = JSON.parse(readFileSync(packagePath, 'utf8'))
    } catch (error) {
      fail(`cannot read ${packagePath}: ${error.message}`)
    }
  }

  // --- which tag is this run for?
  let tag = arg('tag')
  const tagRef = (value) => flag('discover-publish') ? `refs/tags/${value}` : value
  if (flag('discover-publish') && flag('tag') && !tag) fail('--tag needs a non-empty tag')
  if (flag('discover-publish') && flag('tag') && flag('sha')) fail('--tag and --sha cannot be combined')
  if (tag) {
    const ref = tagRef(tag)
    if (!succeeds(() => git(cwd, 'rev-parse', '-q', '--verify', '--end-of-options', `${ref}^{commit}`)))
      fail(`--tag ${tag} is not in this repository`)
  } else {
    const sha = flag('discover-publish') ? arg('sha', 'HEAD') : (arg('sha') || git(cwd, 'rev-parse', 'HEAD'))
    if (flag('discover-publish') &&
        ((flag('sha') && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(sha)) ||
         !succeeds(() => git(cwd, 'rev-parse', '--verify', '--end-of-options', `${sha}^{commit}`))))
      fail(`--sha ${sha || '(empty)'} is not a valid commit SHA in this repository`)
    const found = (
      attempt(() =>
        git(cwd, 'tag', '--points-at', sha, '--list', flag('discover-publish') ? '*' : `${prefix}[0-9]*`, '--sort=-v:refname')
      ) || ''
    ).split('\n').filter(Boolean)
    if (flag('discover-publish')) {
      const versionShaped = found.filter((value) => value.startsWith(prefix) && /^\d/.test(value.slice(prefix.length)))
      // A prefixed nonnumeric tag is ambiguous (it may be unrelated). Do not
      // reject it beside version-shaped tags, but refuse a false-green skip if
      // it is the only possible release tag. An empty prefix matches everything,
      // so nonnumeric tags remain unrelated in that configuration.
      if (!versionShaped.length && prefix) {
        const ambiguous = found.find((value) => value.startsWith(prefix))
        if (ambiguous) fail(`${ambiguous} does not carry a version after the ${prefix} prefix`)
      }
      const parsed = versionShaped.map((value) => ({ tag: value, version: parseVersion(value.slice(prefix.length)) }))
      const invalid = parsed.find((entry) => entry.tag.startsWith(prefix) && !entry.version)
      if (invalid) fail(`${invalid.tag} does not carry a version after the ${prefix} prefix`)
      const valid = parsed.filter((entry) => entry.tag.startsWith(prefix) && entry.version)
        .sort((a, b) => compareVersion(b.version, a.version))
      if (valid.length > 1 && compareVersion(valid[0].version, valid[1].version) === 0)
        fail(`multiple tags have equal version precedence: ${valid[0].tag}, ${valid[1].tag}`)
      tag = valid[0]?.tag
    } else tag = found[0]

    if (!tag) {
      // A shallow clone has no tags, so it cannot tell "this release cut no tag"
      // from "I cannot see the tags" - and reporting the first when it means the
      // second is a green job that published nothing.
      if (git(cwd, 'rev-parse', '--is-shallow-repository') === 'true')
        fail(
          `this checkout is shallow, so no tag can be seen at ${sha.slice(0, 7)} - ` +
            'fetch the tags (fetch-depth: 0) rather than reporting that there was nothing to publish'
        )
      console.log(`no ${prefix}* tag at ${sha.slice(0, 7)} - that release cut nothing`)
      output(flag('discover-publish')
        ? { skip: true, tag: '', version: '' }
        : { skip: true, tag: '', version: '', publish: false, exists: false })
      return
    }
  }

  const version = tag.slice(prefix.length)
  if (flag('discover-publish')
    ? !tag.startsWith(prefix) || !parseVersion(version)
    : !/^\d+\.\d+\.\d+/.test(version))
    fail(`${tag} does not carry a version after the ${prefix} prefix`)

  // --- a tag cut from a branch nobody merged is not a release of this branch.
  // The forge's ref is authoritative, so a local branch that is merely behind
  // does not block a publish - it is the operator's checkout that is stale, and
  // saying so is more use than refusing on a technicality.
  candidates ||= resolveBranches()
  if (!candidates.length) fail(`cannot resolve ${branch} in this repository`)

  const holding = candidates.find(({ commit }) =>
    succeeds(() => git(cwd, 'merge-base', '--is-ancestor', `${tagRef(tag)}^{commit}`, commit))
  )
  if (!holding) fail(`${tag} is not on ${branch} - refusing to publish it`)
  if (holding !== candidates[0])
    console.log(
      `note: the local ${branch} does not contain ${tag}, ${holding.ref.replace(/^refs\/remotes\//, '')} does - ` +
        'this checkout is behind, so fetch before trusting anything built from it'
    )

  if (flag('discover-publish')) {
    output({ skip: false, tag, version })
    return
  }


  // --- stamp the version npm will read, and so make drift impossible
  const before = pkg.version
  if (before === version) {
    console.log(`package.json already states ${version}`)
  } else if (dry) {
    console.log(`--dry-run: would stamp package.json ${before} -> ${version}`)
  } else {
    pkg.version = version
    writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`)
    console.log(`stamped package.json ${before} -> ${version}`)
  }

  // --- is this version already published?
  //
  // Only npm can answer that. A package that ships through a marketplace is not
  // on npm at all - asking anyway reports 'not on registry' as though the version
  // were new, which reads as a green light when it is really an unasked question.
  const registry = arg('registry', 'https://registry.npmjs.org').replace(/\/+$/, '')
  const tokenName = arg('token-env', 'NODE_AUTH_TOKEN')
  const lookup = !flag('no-registry-lookup')
  const exists = lookup ? await versionPublished(registry, pkg.name, version, process.env[tokenName]) : false
  const publish = !exists || flag('republish')

  if (lookup) {
    console.log(
      `${pkg.name}@${version} is ${exists ? 'already on' : 'not on'} ${registry}` +
        `${exists && !publish ? ' - nothing to publish' : ''}`
    )
  } else {
    console.log(
      `--no-registry-lookup: not asking ${registry} whether ${pkg.name}@${version} exists. ` +
        `The caller decides, since the artifact does not ship there.`
    )
  }
  output({ skip: false, tag, version, publish, exists })
}

/**
 * The host creates the tag over the API, so it exists in the forge and not in this
 * clone. Anything that runs later in the same job - stamping the version, checking
 * the tag out for the build - reads the clone, so the tag is created here too. It
 * is lightweight on purpose: an annotated tag needs a committer identity, which a
 * CI checkout does not always have, and this tag is a local marker, not a claim
 * that gets pushed anywhere.
 */
function tagLocally(cwd, tag, commit) {
  if (succeeds(() => git(cwd, 'rev-parse', '-q', '--verify', `refs/tags/${tag}`))) return false
  return succeeds(() => git(cwd, 'tag', tag, commit))
}

/** Does the registry already serve this version? 200 yes, 404 no, anything else stops. */
async function versionPublished(registry, name, version, token) {
  const url = `${registry}/${name.replace('/', '%2F')}/${version}`
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    }
  })

  if (response.status === 200) return true
  if (response.status === 404) return false

  if (response.status === 401 || response.status === 403)
    fail(
      `${url} answered ${response.status} - the registry needs a token, ` +
        'in NODE_AUTH_TOKEN or the variable named by --token-env'
    )
  fail(`${url} answered ${response.status}`)
}

/**
 * Severity order, so a floor is a comparison rather than a list of names. The
 * words are the ones `npm audit --audit-level` takes.
 */
const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical']

/** Where a repository's exemptions live when no flag names a file. */
const DEFAULT_AUDIT_CONFIG = join('scripts', 'audit-allowlist.json')

/** The keys an exemption may carry. Anything else is a typo that would be inert. */
const EXEMPTION_KEYS = ['id', 'packages', 'devOnly', 'recheckBy', 'reason']

/**
 * A gate failure: the tree has a problem, or the report cannot be read.
 *
 * Exit 1, against `fail`'s 2, because the two are different answers: exit 2 is
 * this tool being asked something it cannot do, exit 1 is a verdict. A mistyped
 * allowlist must not read as a vulnerability, and a vulnerability must not read
 * as a broken pipeline.
 */
function gateFailure(message) {
  console.error(`sasjs-release: ${message}`)
  process.exit(1)
}

/**
 * The advisory a `via` entry names, if it names one.
 *
 * npm reports two kinds: an advisory it has an id for, whose `url` points at a
 * GHSA page, and one of its own, which carries a numeric `source` and no url.
 * Only the first can be exempted - an exemption is a claim about a specific
 * advisory - and the second is reported as a failure rather than dropped, because
 * "I cannot name this" is not "there is nothing to fix".
 */
function advisoryOf(via) {
  const url = typeof via?.url === 'string' ? via.url : ''
  const found = /GHSA(?:-[0-9a-z]{4}){3}/i.exec(url)
  return found ? found[0] : ''
}

/** Advisory ids are reported in one case and written in another; compare them as one. */
const sameId = (a, b) => a.toUpperCase() === b.toUpperCase()

/** Every advisory in a report, one row per package it is reported against. */
function auditFindings(report) {
  const seen = new Map()

  // npm's indirect nodes can form cycles. Mark nodes reachable backwards from
  // advisory-bearing nodes rather than rejecting cycles that also reach a cause.
  const reachable = new Set()
  const dependents = new Map()
  for (const [name, vuln] of Object.entries(report.vulnerabilities)) {
    if (!name || !vuln || typeof vuln !== 'object' || Array.isArray(vuln) ||
        vuln.name !== name || !Array.isArray(vuln.via) || !vuln.via.length)
      gateFailure(`invalid audit vulnerability ${name}: expected a matching name and nonempty via array`)
    if (!SEVERITIES.includes(vuln.severity) && vuln.via.some((via) => via && typeof via === 'object' && SEVERITIES.includes(via.severity)))
      gateFailure(`audit severity for ${name} is unknown and cannot be reconciled`)
    if (SEVERITIES.includes(vuln.severity) && vuln.via.every((via) => via && typeof via === 'object' && !Array.isArray(via) && SEVERITIES.includes(via.severity)) &&
        Math.max(...vuln.via.map((via) => SEVERITIES.indexOf(via.severity))) !== SEVERITIES.indexOf(vuln.severity))
      gateFailure(`audit severity inconsistent for ${name}`)
    for (const via of vuln.via) {
      if (typeof via === 'string') {
        if (!Object.hasOwn(report.vulnerabilities, via))
          gateFailure(`unresolved audit via reference ${via} from ${name}`)
        if (!dependents.has(via)) dependents.set(via, [])
        dependents.get(via).push(name)
      } else if (via && typeof via === 'object' && !Array.isArray(via)) reachable.add(name)
      else gateFailure(`invalid audit via entry for ${name}`)
    }
  }
  const queue = [...reachable]
  for (let i = 0; i < queue.length; i++) {
    for (const name of dependents.get(queue[i]) || []) {
      if (!reachable.has(name)) {
        reachable.add(name)
        queue.push(name)
      }
    }
  }
  for (const name of Object.keys(report.vulnerabilities))
    if (!reachable.has(name)) gateFailure(`audit vulnerability ${name} has no reachable advisory`)

  for (const [name, vuln] of Object.entries(report.vulnerabilities || {})) {
    for (const via of Array.isArray(vuln?.via) ? vuln.via : []) {
      // a string is a pointer at another package's entry, which is reported under
      // its own name - counting it here would report one advisory twice
      if (!via || typeof via !== 'object') continue

      const id = advisoryOf(via)
      const key = `${id.toUpperCase()}|${name}`
      const finding = {
        id,
        package: name,
        // an unrecognised severity is treated as the highest rather than the
        // lowest: a report this tool cannot read must not become a pass
        severity: SEVERITIES.includes(via.severity) ? via.severity : 'critical',
        title: typeof via.title === 'string' ? via.title : ''
      }
      const previous = seen.get(key)
      if (!previous || SEVERITIES.indexOf(finding.severity) > SEVERITIES.indexOf(previous.severity))
        seen.set(key, finding)
    }
  }

  return [...seen.values()]
}

/**
 * The report to judge: `npm audit --json`, or a recorded one.
 *
 * A report this tool cannot read is a failure, never an empty tree. `npm audit
 * --json` writes its own errors to stdout and exits non-zero, so a missing
 * lockfile or an unreachable registry parses as JSON with no `vulnerabilities` -
 * which once read as "nothing to fix" and would again the moment the exemption
 * list emptied out.
 */
function auditReport({ cwd, omit, input }) {
  let text = ''
  let npmStatus = null

  if (input) {
    try {
      text = readFileSync(isAbsolute(input) ? input : join(cwd, input), 'utf8')
    } catch (error) {
      gateFailure(`the recorded report could not be read (${input}): ${error.message}`)
    }
  } else {
    const argv = ['audit', '--json', ...(omit ? ['--omit', omit] : [])]
    const run = spawnSync('npm', argv, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    npmStatus = run.status
    text = run.stdout || ''

    if (!text.trim()) {
      const stderr = String(run.stderr || '').trim()
      gateFailure(
        `npm ${argv.join(' ')} printed no report` +
          (run.error ? `: ${run.error.message}` : '') +
          (stderr ? `:\n${stderr}` : '')
      )
    }
    // npm uses 1 for an audit with findings; other exits and interrupted or
    // truncated executions cannot be treated as a complete report.
    if (run.error || run.signal || (run.status !== 0 && run.status !== 1))
      gateFailure(`npm ${argv.join(' ')} failed: ${run.error?.message || (run.signal ? `signal ${run.signal}` : `exit ${run.status}`)}`)
  }

  let report

  try {
    report = JSON.parse(text)
  } catch (error) {
    gateFailure(`this is not an npm audit report: ${error.message}`)
  }

  if (
    !report ||
    typeof report !== 'object' ||
    !report.vulnerabilities ||
    typeof report.vulnerabilities !== 'object' ||
    Array.isArray(report.vulnerabilities) ||
    report.auditReportVersion === undefined
  )
    gateFailure('this is not an npm audit report: no vulnerabilities or auditReportVersion')

  if (report.error) gateFailure(`npm audit report contains an error: ${JSON.stringify(report.error)}`)

  if (report.auditReportVersion !== 2)
    gateFailure(
      `npm audit report version ${report.auditReportVersion} is not supported - ` +
        'this gate was written against 2, so pin the npm the pipeline runs'
    )

  const counts = report.metadata?.vulnerabilities
  if (!counts || typeof counts !== 'object' || Array.isArray(counts) ||
      !Number.isSafeInteger(counts.total) || counts.total !== Object.keys(report.vulnerabilities).length)
    gateFailure('npm audit metadata vulnerabilities total is missing or inconsistent with affected packages')

  if (npmStatus === 1 && counts.total === 0)
    gateFailure('npm audit exited 1 but the report is empty')

  // Counts describe vulnerable packages, not the number of advisory objects.
  // Preserve conservative handling of unknown package severities by requiring
  // internally coherent counts without pretending to know their category.
  const values = Object.values(report.vulnerabilities)
  if (SEVERITIES.some((severity) => !Number.isSafeInteger(counts[severity]) || counts[severity] < 0) ||
      SEVERITIES.reduce((sum, severity) => sum + counts[severity], 0) !== counts.total ||
      (values.every((vuln) => SEVERITIES.includes(vuln?.severity)) &&
        SEVERITIES.some((severity) => counts[severity] !== values.filter((vuln) => vuln.severity === severity).length)))
    gateFailure('npm audit metadata severity counts are inconsistent with affected packages')

  return report
}

/**
 * The exemption list, validated.
 *
 * A waiver is an argument, so the fields that carry the argument are required and
 * the ones that would be a second copy of the report are not accepted: `severity`
 * and `title` come from the advisory itself, and an entry that stored them could
 * disagree with the finding it describes.
 */
function auditExemptions(cwd, omit) {
  const named = arg('audit-config')
  const file = isAbsolute(named || DEFAULT_AUDIT_CONFIG) ? named || DEFAULT_AUDIT_CONFIG : join(cwd, named || DEFAULT_AUDIT_CONFIG)

  // A file found by convention that is not there is a repository with no
  // exemptions, which is most of them. A file the caller named is a mistake.
  if (!named && !existsSync(file)) return []

  const listed = readJson(file, cwd, '--audit-config')

  if (!Array.isArray(listed)) fail(`${file} must be a JSON array of exemptions`)

  const today = new Date().toISOString().slice(0, 10)

  const exemptions = listed.map((entry) => {
    const at = `${file}: ${JSON.stringify(entry)}`

    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      fail(`${file} has an exemption that is not an object: ${JSON.stringify(entry)}`)

    const unknown = Object.keys(entry).filter((key) => !EXEMPTION_KEYS.includes(key))
    if (unknown.length)
      fail(
        `${file} has an exemption with unknown key(s) ${unknown.join(', ')}: ${JSON.stringify(entry.id || entry)} - ` +
          `the fields are ${EXEMPTION_KEYS.join(', ')}`
      )

    if (typeof entry.id !== 'string' || !/^GHSA(?:-[0-9a-z]{4}){3}$/i.test(entry.id))
      fail(`${at} needs an id of the form GHSA-xxxx-xxxx-xxxx`)

    if (typeof entry.reason !== 'string' || !entry.reason.trim())
      fail(`${at} needs a reason: the argument a reader can check`)

    if (typeof entry.recheckBy !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.recheckBy))
      fail(`${at} needs recheckBy as YYYY-MM-DD: a waiver without a review date outlives its reason`)

    const date = new Date(`${entry.recheckBy}T00:00:00Z`)
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== entry.recheckBy)
      fail(`${at} needs a valid calendar date for recheckBy`)

    // A date has passed when the calendar says so, not the clock: comparing the
    // strings is exact for YYYY-MM-DD and needs no timezone
    if (entry.recheckBy < today)
      gateFailure(
        `the exemption for ${entry.id} was due for review on ${entry.recheckBy} - ` +
          're-check it, then move the date or remove the entry'
      )

    if (
      entry.packages !== undefined &&
      (!Array.isArray(entry.packages) || entry.packages.some((name) => typeof name !== 'string' || !name))
    )
      fail(`${at} has packages that are not a list of package names`)

    if (entry.devOnly !== undefined && typeof entry.devOnly !== 'boolean')
      fail(`${at} has a devOnly that is not true or false`)

    return {
      id: entry.id,
      packages: entry.packages || [],
      devOnly: entry.devOnly === true,
      recheckBy: entry.recheckBy,
      reason: entry.reason
    }
  })

  // An exemption on a production-only gate is a waiver that can never apply: the
  // gate refuses to exempt anything that ships, so the list would be inert and
  // every entry would report as stale.
  if (omit && exemptions.length)
    fail(
      `--audit-omit ${omit} judges only what ships, where nothing is exemptible, ` +
        `but ${file} carries ${exemptions.length} exemption(s): drop the flag to judge the full tree`
    )

  return exemptions
}

/**
 * The audit gate.
 *
 * Reads the report and the exemption list, writes nothing but the report the
 * caller asked for, and answers with an exit code - so a workflow step is one
 * line and a laptop can ask the same question with no token.
 */
async function auditGate() {
  const cwd = arg('repo-dir', process.cwd())
  const level = arg('audit-level', 'low')

  if (!SEVERITIES.includes(level)) fail(`--audit-level must be one of ${SEVERITIES.join(', ')}`)

  const omit = arg('audit-omit')
  const exemptions = auditExemptions(cwd, omit)

  const floor = SEVERITIES.indexOf(level)
  const atFloor = (finding) => SEVERITIES.indexOf(finding.severity) >= floor
  const matches = (finding) =>
    exemptions.findIndex(
      (entry) =>
        sameId(entry.id, finding.id) &&
        (!entry.packages.length || entry.packages.includes(finding.package))
    )

  // A recorded replay runs no npm at all: if the production report is needed, it has
  // to arrive as a file too. Without this the gate would ask npm in a run whose whole
  // point was not to, and blame the caller's JSON for the answer.
  const needsProd = exemptions.length > 0

  if (needsProd && arg('audit-input') && !arg('audit-prod-input'))
    fail('--audit-input with an exemption needs --audit-prod-input: a recorded replay runs no npm')

  const judged = auditReport({ cwd, omit, input: arg('audit-input') })
  const reportPath = arg('audit-report')

  if (reportPath) {
    if (flag('dry-run')) console.log(`would write the audit report to ${reportPath}`)
    else
      writeFileSync(
        isAbsolute(reportPath) ? reportPath : join(cwd, reportPath),
        `${JSON.stringify(judged, null, 2)}\n`
      )
  }

  const findings = auditFindings(judged)
  const above = findings.filter(atFloor)

  // The production tree is a second report: --omit=dev is the only question that
  // answers "does this ship" for a transitive dependency. Any exemption could
  // hide a production finding, regardless of its devOnly field. With no entries
  // there is nothing an exemption could hide. When the run itself is the
  // production set, every finding in it is one.
  const shipped = omit
    ? above
    : needsProd
      ? auditFindings(auditReport({ cwd, omit: 'dev', input: arg('audit-prod-input') })).filter(atFloor)
      : []

  const rows = new Map()
  const key = (finding) => `${finding.id}|${finding.package}`
  const used = new Set()

  for (const finding of above) {
    const at = matches(finding)

    if (!finding.id) rows.set(key(finding), { finding, why: 'no GHSA id, so it cannot be exempted' })
    else if (at === -1) rows.set(key(finding), { finding, why: 'not in the allowlist' })
    else used.add(at)
  }

  // Whatever the allowlist says, an advisory in the production tree blocks: the
  // tree that ships is a version to change, not a risk to accept. The devOnly
  // reason outranks the one above, because it says why the allowlist cannot help.
  for (const finding of shipped) {
    const at = matches(finding)
    rows.set(key(finding), {
      finding,
      why:
        at !== -1 && exemptions[at].devOnly
          ? `in the production tree, though the allowlist calls it devOnly (review by ${exemptions[at].recheckBy})`
          : 'in the production tree, where nothing is exemptible'
    })
  }

  // An entry that stops appearing fails: a stale waiver is invisible in a passing
  // build, which is how it outlives the problem it describes. Judged against every
  // advisory the report carries, so raising the floor does not make an entry look
  // stale when the advisory is still there.
  const stale = exemptions.filter((entry) => !findings.some((finding) => sameId(finding.id, entry.id)))

  output({
    audited: rows.size === 0 && stale.length === 0,
    advisories: above.length,
    exempted: used.size,
    stale: stale.length,
    level,
    scope: omit ? `omit:${omit}` : 'full'
  })

  for (const { finding, why } of rows.values())
    console.log(
      `${finding.severity} ${finding.id || '(no advisory id)'} ${finding.package}: ${why}` +
        (finding.title ? ` - ${finding.title}` : '')
    )

  for (const entry of stale)
    console.log(`${entry.id} is in the allowlist but the report no longer carries it: remove the entry`)

  if (rows.size)
    gateFailure(`${rows.size} advisory/advisories at or above ${level} that the allowlist does not clear`)

  if (stale.length)
    gateFailure(
      `${stale.length} allowlist entr${stale.length === 1 ? 'y' : 'ies'} no longer match anything in the report`
    )

  console.log(`no advisory at or above ${level} outside the allowlist`)
}

/**
 * This package's own auditability.
 *
 * The release job runs with `contents: write`, so the tree that carries this tool
 * has to be auditable - and the property that makes it so is that it ships
 * nothing of its own. Three workflows assert that with an inline `node -e` block;
 * this is the same assertion, made where the promise has to be kept.
 */
function assertNoDependencies(cwd) {
  const at = join(cwd, 'node_modules', '@sasjs', 'release', 'package.json')

  if (!existsSync(at))
    fail(`--assert-no-dependencies: @sasjs/release is not installed at ${at} - run npm ci first`)

  let pkg

  try {
    pkg = JSON.parse(readFileSync(at, 'utf8'))
  } catch (error) {
    fail(`--assert-no-dependencies: ${at} could not be read: ${error.message}`)
  }

  const shipped = Object.keys({
    ...pkg.dependencies,
    ...pkg.peerDependencies,
    ...pkg.optionalDependencies,
    ...(Array.isArray(pkg.bundledDependencies)
      ? Object.fromEntries(pkg.bundledDependencies.map((name) => [name, 1]))
      : pkg.bundledDependencies),
    ...(Array.isArray(pkg.bundleDependencies)
      ? Object.fromEntries(pkg.bundleDependencies.map((name) => [name, 1]))
      : pkg.bundleDependencies)
  })

  if (shipped.length)
    gateFailure(
      `@sasjs/release ${pkg.version} ships dependencies (${shipped.join(', ')}), ` +
        'so auditing a release tree no longer audits the tool that runs with it'
    )

  console.log(`@sasjs/release ${pkg.version} ships no dependencies`)
}

async function main() {
  if (flag('help')) {
    console.log(HELP)
    return
  }

  checkFlags()
  if (flag('verify-assets')) {
    if (!flag('attach') || flag('release') || flag('prepare-publish') || flag('discover-publish'))
      fail('--verify-assets requires --attach and cannot be combined with release or publish modes')
    // Preserve --show-context's existing read-only behavior for attach options.
    if (!flag('show-context')) {
      if (flag('dry-run')) fail('--verify-assets cannot be combined with --dry-run')
      if (!arg('attach')) fail('--attach needs a non-empty tag with --verify-assets')
      const host = arg('host', detectContext().host)
      if (host !== 'none' && !(host in HOSTS)) fail('--host must be none, github, gitea or gitlab')
      if (host !== 'github') fail('--verify-assets supports github only')
    }
  }

  // The audit gate runs before anything decides or writes: a tree that carries an
  // advisory nobody has argued for should not get a version stamped onto it or a
  // tag created for it. It composes with the modes below, and stands alone when
  // nothing else was asked for.
  const otherMode = (self) =>
    [
      'assert-no-dependencies',
      'audit',
      'prepare-publish',
      'discover-publish',
      'attach',
      'tag',
      'push-tag',
      'release',
      'show-context'
    ].some((mode) => mode !== self && flag(mode))

  // A flag that only means something with --audit is otherwise silent: `--audit-level
  // high` on its own would run an ordinary release, which is not what anyone typing
  // it expects.
  const auditOnly = ['audit-level', 'audit-omit', 'audit-config', 'audit-report', 'audit-input', 'audit-prod-input']
  if (!flag('audit') && auditOnly.some(flag)) fail(`--${auditOnly.find(flag)} needs --audit`)

  if (flag('assert-no-dependencies')) {
    assertNoDependencies(arg('repo-dir', process.cwd()))
    if (!otherMode('assert-no-dependencies')) return
  }

  if (flag('audit')) {
    await auditGate()
    if (!otherMode('audit')) return
  }

  if (flag('discover-publish') || flag('prepare-publish')) {
    if (flag('discover-publish') && flag('prepare-publish'))
      fail('--discover-publish and --prepare-publish are mutually exclusive')
    await preparePublish()
    return
  }

  const cwd = arg('repo-dir', process.cwd())
  const prefix = arg('tag-prefix', 'v')
  const dry = flag('dry-run')
  const context = detectContext()
  const api = arg('api-url', context.api || '')
  const inferredHost = Boolean(arg('host')) === false && context.host !== 'none'
  const host = arg('host', context.host)
  const prerelease = arg('prerelease')
  const forcedLevel = arg('level')
  const paths = arg('paths') ? arg('paths').split(',').filter(Boolean) : []

  if (forcedLevel && !(forcedLevel in LEVELS)) fail('--level must be patch, minor or major')
  if (host !== 'none' && !(host in HOSTS)) fail('--host must be none, github, gitea or gitlab')
  if (inferredHost) console.log(`host: ${host}, from the environment`)
  if (flag('show-context')) {
    console.log(
      `host=${host} api=${arg('api-url', context.api || '')} repo=${arg('repo', detectRepo()) || '(from the remote)'}`
    )
    return
  }

  // Attaching says nothing about commits: the tag exists, the files exist, and the
  // run has no business classifying or cutting anything.
  const attachTag = arg('attach')

  if (attachTag) {
    if (host === 'none') fail('--attach needs --host')
    const token = tokenFor(host, arg('token-env'))
    if (!token) fail(`no token: set ${arg('token-env', HOSTS[host].token)}`)

    const remote = remoteUrl(cwd)
    const repo = arg('repo') || detectRepo() || (remote.match(/https:\/\/[^/]+\/(.+)$/) || [])[1] || ''
    const files = [
      ...args('asset').map((path) => assetOf(path, undefined, cwd)),
      ...configAssets(cwd)
    ]

    if (!files.length)
      fail('--attach names no assets: give --asset, or a release block in the config')

    if (dry) {
      for (const file of files) console.log(`would attach ${file.name} to ${attachTag}`)
      output({ released: false, tag: attachTag })
      return
    }

    await attachAssets({
      host,
      api,
      token,
      header: arg('token-header'),
      repo,
      tag: attachTag,
      files
    })
    output({ released: true, tag: attachTag, version: stable(attachTag.replace(new RegExp(`^${arg('tag-prefix', 'v')}`), '')) })
    return
  }

  const since = arg('since')
  // an unresolvable --since used to read as "nothing to release", which is the
  // worst possible answer: a shallow clone or a typo would silently ship no
  // release. Name the ref instead.
  if (since && !attempt(() => git(cwd, 'rev-parse', '-q', '--verify', `${since}^{commit}`)))
    fail(`--since ${since} is not a commit in this repository (a shallow clone needs a full fetch)`)

  const previous = since || latestTag(cwd, prefix)
  const head = git(cwd, 'rev-parse', 'HEAD')
  const atHead = (ref) =>
    Boolean(ref) && attempt(() => git(cwd, 'rev-parse', '-q', '--verify', `${ref}^{commit}`)) === head

  const parsed = commits(cwd, arg('since') ? arg('since') : previous, paths).map(classify)
  const releasable = parsed.filter((c) => c.breaking || c.type in TYPES)

  /**
   * A run can end after the tag is cut - the push rejected, the release API
   * down, the runner killed - and the tag then names the commit while nothing
   * else exists. `--tag`, `--push-tag` and `--release` are all idempotent, so
   * that state is finished rather than reported as "nothing to release", which
   * is what makes a failure re-runnable instead of a hand repair.
   */
  const finishing =
    !releasable.length &&
    !forcedLevel &&
    (flag('tag') || flag('push-tag') || flag('release')) &&
    atHead(previous)

  if (!releasable.length && !forcedLevel && !finishing) {
    console.log(`nothing to release since ${previous || 'the first commit'}`)
    output({ released: false })
    return
  }

  const base = previous.replace(new RegExp(`^${prefix}`), '') || '0.0.0'
  // A breaking change is a major, except before 1.0.0 where it is the minor -
  // the convention every pre-1.0 tool in this space follows.
  const level =
    forcedLevel ||
    (releasable.some((c) => c.breaking)
      ? Number(base.split('.')[0]) === 0
        ? 'minor'
        : 'major'
      : releasable.some((c) => c.type === 'feat')
        ? 'minor'
        : 'patch')

  // A tag that is already a prerelease names a version that has not shipped,
  // so the target does not move again: beta.2 plus a fix is beta.3, not
  // 1.8.1-beta.1.
  const inPrerelease = /^\d+\.\d+\.\d+-[^.]+\.\d+$/.test(base)
  const target = inPrerelease ? stable(base) : bump(base, level)
  const version = finishing
    ? base
    : prerelease
      ? bumpPrerelease(target, prerelease, base)
      : target
  const tag = finishing ? previous : `${prefix}${version}`
  const remote = remoteUrl(cwd)
  const repo = arg('repo') || (remote.match(/https:\/\/[^/]+\/(.+)$/) || [])[1] || ''
  // the notes for a finished tag are the commits it covers, not the (empty)
  // ones after it
  const covered = finishing
    ? {
        from: attempt(() => git(cwd, 'describe', '--tags', '--abbrev=0', '--match', `${prefix}[0-9]*`, `${previous}^`)),
        commits: commits(cwd, attempt(() => git(cwd, 'describe', '--tags', '--abbrev=0', '--match', `${prefix}[0-9]*`, `${previous}^`)), [], previous).map(classify)
      }
    : { from: previous, commits: parsed }

  const body = notes(
    version,
    covered.commits,
    covered.from,
    remote,
    new Date().toISOString().slice(0, 10)
  )

  if (finishing)
    console.log(`${tag} already names HEAD: finishing that release`)
  else
    console.log(`${level} release: ${previous || 'none'} -> ${tag} (${releasable.length} commits)`)
  console.log(body)

  // Resolved here, before a tag exists: a config naming a file that is not there - or
  // naming nothing when the caller asked for it by name - is a mistake in the
  // repository, and refusing after the tag has been pushed leaves a release that has
  // to be explained. It needs no token and no network, so a dry run checks it too.
  // The config's list says what a release publishes, not necessarily what exists
  // now: an artefact built from the tag cannot be uploaded at the moment the tag is
  // made, and `--attach` is the run that uploads it. `--no-assets` is the caller
  // saying which kind of release this is, so an absent file is expected rather than
  // a mistake.
  const files = flag('release')
    ? [
        ...args('asset').map((path) => assetOf(path, undefined, cwd)),
        ...(flag('no-assets') ? [] : configAssets(cwd))
      ]
    : []

  // A release that names files and is published before they exist is one whose
  // download links answer 404 until - or unless - an attach finishes. That is only
  // survivable as a draft, which is invisible until the attach publishes it.
  if (flag('no-assets') && flag('release') && !flag('draft'))
    fail(
      '--no-assets needs --draft: a release published before its files exist is one ' +
        'whose download links answer 404 until an attach finishes'
    )

  if (dry) {
    console.log('--dry-run: nothing tagged, nothing sent')
    output({ released: false, version, tag, level })
    return
  }

  const notesFile = arg('notes-file')
  if (notesFile) writeFileSync(notesFile, `${body}\n`)

  // Checked before anything claims a release happened: `released=true` in the output
  // file is what the calling workflow believes, and a run that then dies on a missing
  // `--host` has told it the opposite of the truth.
  if (flag('release')) {
    if (host === 'none') fail('--release needs --host')
    const tokenEnv = arg('token-env', HOSTS[host].token)
    if (!tokenFor(host, tokenEnv)) fail(`no token: set ${tokenEnv}`)
  }

  output({ released: true, version, tag, level })

  if (flag('tag')) {
    // Reuse a tag that already points at HEAD: a run that failed after the tag
    // was cut can be finished by re-running, which a release tool that refuses
    // an existing tag cannot do.
    const existing = attempt(() => git(cwd, 'rev-parse', '-q', '--verify', `${tag}^{commit}`))
    if (existing && existing === head) console.log(`tag ${tag} already names HEAD`)
    else if (existing) fail(`tag ${tag} exists and names ${existing}, not HEAD`)
    else
      git(
        cwd,
        '-c', 'user.name=sasjs',
        '-c', 'user.email=sasjs@4gl.io',
        'tag', '-a', tag, '-m', tag
      )
  }

  if (flag('push-tag')) git(cwd, 'push', 'origin', tag)

  if (flag('release')) {
    // host and token were checked before the output claimed a release, so this only
    // needs the value
    const token = tokenFor(host, arg('token-env'))
    const links = args('asset-link').map((pair) => {
      const at = pair.indexOf('=')
      if (at === -1) fail('--asset-link needs name=url')
      return { name: pair.slice(0, at), url: pair.slice(at + 1) }
    })
    await publish({
      host,
      api,
      token,
      header: arg('token-header'),
      repo,
      tag,
      body,
      title: arg('title', tag),
      files,
      links,
      commit: head,
      isPrerelease: Boolean(prerelease),
      draft: flag('draft')
    })
    if (tagLocally(cwd, tag, head))
      console.log(`tagged ${tag} locally as well - the tag came from the ${host} API`)
    console.log(`released ${tag} on ${host}`)
  }
}

/**
 * The result, on stdout and - when asked - as key=value lines a workflow can
 * feed to whatever protocol it has (GITHUB_OUTPUT, GITHUB_ENV, a dotenv
 * artifact, or nothing at all).
 */
function output(values) {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`)
  for (const line of lines) console.log(line)
  const path = arg('output')
  if (path) appendFileSync(path, `${lines.join('\n')}\n`)
}

try {
  await main()
} catch (error) {
  fail(error.stderr ? String(error.stderr).trim() : error.message)
}
