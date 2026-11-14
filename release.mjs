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
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const LEVELS = { major: 3, minor: 2, patch: 1 }

const HELP = `sasjs-release - releases from conventional commits

  --repo-dir <path>      repository to work in (default: cwd)
  --tag-prefix <p>       prefix before the version in the tag (default: v)
  --since <ref>          count commits after this ref (default: newest prefixed tag)
  --paths <a,b>          only commits touching these paths (monorepos)
  --level <l>            force patch|minor|major instead of classifying
  --prepare-publish      resolve and gate a publish, stamp the version, ask the
                         registry; writes no tag and creates no release
  --sha <sha>            commit to look for a tag at (default: HEAD)
  --branch <ref>         the branch a publishable tag must be on (default: HEAD)
  --registry <url>       registry to ask (default: https://registry.npmjs.org)
  --republish            publish even when the version is already on the registry
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
  --title <text>         release title (default: the tag)
  --help                 this text
`

// Every flag the tool knows. A typo is otherwise silent: `flag()` is a lookup in
// argv, so `--drafts` reads as false and the run quietly does something else -
// which is how a dropped `--draft` would publish a release before its assets
// exist rather than failing.
const known = new Set([
  'api-url', 'asset', 'asset-link', 'branch', 'draft', 'dry-run', 'help', 'host',
  'level', 'notes-file', 'output', 'paths', 'prepare-publish', 'prerelease',
  'push-tag', 'registry', 'release', 'repo', 'repo-dir', 'republish', 'sha',
  'since', 'tag', 'tag-prefix', 'title', 'token-env', 'token-header'
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
 * Multipart without dependencies: node's own FormData and Blob, so an asset
 * upload needs no curl on the runner and no library in the tree.
 */
async function upload(url, headers, file, field) {
  const body = new FormData()
  const bytes = readFileSync(file)
  body.append(field, new Blob([bytes]), basename(file))
  const response = await request(url, { method: 'POST', headers, body })
  return response
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

  const releases = await request(`${base}/repos/${repo}/releases?per_page=100`, { headers })
  return (Array.isArray(releases) ? releases : []).find((release) => release.tag_name === tag) || null
}

/**
 * A release that already exists is not a failure: the run that created it may
 * have died on the next step, and the whole point of `--release` being
 * idempotent is that re-running finishes the job. The forges disagree on the
 * status - GitHub says 422, Gitea and GitLab say 409 - and all of them can then
 * be asked for the release they refused to create twice.
 */
async function createOrFind(url, options, find) {
  // Look before creating. A forge will happily create a second release for a tag
  // that already has one - as a draft, invisibly - so recovering from 422 alone
  // is not enough once drafts are in play: a re-run after publishing produced a
  // duplicate draft on a real repository.
  const existing = await find().catch(() => null)
  // `id` is what makes a response a release: a host that answers 200 with
  // something else (an empty object, an error body) has not found one
  if (existing && existing.id) {
    console.log('a release for this tag already exists: finishing it')
    return existing
  }

  try {
    return await request(url, options)
  } catch (error) {
    if (error.status !== 422 && error.status !== 409) throw error
    // a lookup that fails is not the finding: the refusal to create is, and
    // reporting the 404 from the lookup sends the reader after the wrong call
    const existing = await find().catch(() => null)
    if (!existing || !existing.id) throw error
    console.log(`a release for this tag already exists: finishing it`)
    return existing
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
    // target_commitish is what makes the tag exist at all: the API creates it
    // when tag_name is new, so the job needs no git credentials and never
    // pushes to the repository. Unused when the tag is already there.
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
          // actually installable: the tag is created either way, but a release
          // advertising a version that failed to publish is worse than no release
          draft: Boolean(draft)
        }
      },
      () => findRelease(base, repo, tag, headers)
    )
    for (const file of files) {
      const url = String(release.upload_url).replace(/\{.*$/, '')
      await uploadOnce(`${url}?name=${encodeURIComponent(basename(file))}`, headers, file, 'file')
    }
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
        `${api}/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(basename(file))}`,
        headers,
        file,
        'attachment'
      )
    }
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

  const packagePath = join(cwd, 'package.json')
  let pkg
  try {
    pkg = JSON.parse(readFileSync(packagePath, 'utf8'))
  } catch (error) {
    fail(`cannot read ${packagePath}: ${error.message}`)
  }

  // --- which tag is this run for?
  let tag = arg('tag')
  if (tag) {
    if (!succeeds(() => git(cwd, 'rev-parse', '-q', '--verify', `${tag}^{commit}`)))
      fail(`--tag ${tag} is not in this repository`)
  } else {
    const sha = arg('sha') || git(cwd, 'rev-parse', 'HEAD')
    tag = (
      attempt(() =>
        git(cwd, 'tag', '--points-at', sha, '--list', `${prefix}[0-9]*`, '--sort=-v:refname')
      ) || ''
    )
      .split('\n')
      .filter(Boolean)[0]

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
      output({ skip: true, tag: '', version: '', publish: false, exists: false })
      return
    }
  }

  const version = tag.slice(prefix.length)
  if (!/^\d+\.\d+\.\d+/.test(version))
    fail(`${tag} does not carry a version after the ${prefix} prefix`)

  // --- a tag cut from a branch nobody merged is not a release of this branch.
  // The forge's ref is authoritative, so a local branch that is merely behind
  // does not block a publish - it is the operator's checkout that is stale, and
  // saying so is more use than refusing on a technicality.
  const candidates = [branch, `origin/${branch}`].filter((candidate) =>
    succeeds(() => git(cwd, 'rev-parse', '-q', '--verify', `${candidate}^{commit}`))
  )
  if (!candidates.length) fail(`cannot resolve ${branch} in this repository`)

  const holding = candidates.find((candidate) =>
    succeeds(() => git(cwd, 'merge-base', '--is-ancestor', `${tag}^{commit}`, candidate))
  )
  if (!holding) fail(`${tag} is not on ${branch} - refusing to publish it`)
  if (holding !== branch)
    console.log(
      `note: the local ${branch} does not contain ${tag}, ${holding} does - ` +
        'this checkout is behind, so fetch before trusting anything built from it'
    )

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
  const registry = arg('registry', 'https://registry.npmjs.org').replace(/\/+$/, '')
  const tokenName = arg('token-env', 'NODE_AUTH_TOKEN')
  const exists = await versionPublished(registry, pkg.name, version, process.env[tokenName])
  const publish = !exists || flag('republish')

  console.log(
    `${pkg.name}@${version} is ${exists ? 'already on' : 'not on'} ${registry}` +
      `${exists && !publish ? ' - nothing to publish' : ''}`
  )
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

async function main() {
  if (flag('help')) {
    console.log(HELP)
    return
  }

  checkFlags()

  if (flag('prepare-publish')) {
    await preparePublish()
    return
  }

  const cwd = arg('repo-dir', process.cwd())
  const prefix = arg('tag-prefix', 'v')
  const dry = flag('dry-run')
  const host = arg('host', 'none')
  const prerelease = arg('prerelease')
  const forcedLevel = arg('level')
  const paths = arg('paths') ? arg('paths').split(',').filter(Boolean) : []

  if (forcedLevel && !(forcedLevel in LEVELS)) fail('--level must be patch, minor or major')
  if (host !== 'none' && !(host in HOSTS)) fail('--host must be none, github, gitea or gitlab')

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

  if (dry) {
    console.log('--dry-run: nothing tagged, nothing sent')
    output({ released: false, version, tag, level })
    return
  }

  const notesFile = arg('notes-file')
  if (notesFile) writeFileSync(notesFile, `${body}\n`)
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
    if (host === 'none') fail('--release needs --host')
    const token = process.env[arg('token-env', HOSTS[host].token)]
    if (!token) fail(`no token: set ${arg('token-env', HOSTS[host].token)}`)
    const links = args('asset-link').map((pair) => {
      const at = pair.indexOf('=')
      if (at === -1) fail('--asset-link needs name=url')
      return { name: pair.slice(0, at), url: pair.slice(at + 1) }
    })
    await publish({
      host,
      api: arg('api-url'),
      token,
      header: arg('token-header'),
      repo,
      tag,
      body,
      title: arg('title', tag),
      files: args('asset'),
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
