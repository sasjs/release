#!/usr/bin/env node
/**
 * Live contract: does the forge still behave the way the stubs believe?
 *
 * Every fixture in this repository answers with a stub, so the suite proves the
 * tool against our *belief* about the GitHub API - 422 when a tag already has a
 * release, upload_url with its `{?name,label}` template, a tag created from
 * target_commitish. If GitHub changes any of that, nothing here notices until a
 * real release fails in a repository that is publishing something.
 *
 * This script exercises the tool against a real repository and deletes what it
 * created. It is meant to run on a schedule, pointed at a sandbox:
 *
 *   GH_TOKEN=<token with contents:write on the sandbox> \
 *     node scripts/live-contract.mjs --repo sasjs/sandpit
 *
 * The tag it uses is unique per run, and both the release and the tag are removed
 * in a finally - including when a check above fails, so a bad night does not
 * leave the sandbox unreadable for the next one.
 *
 * It works in a clone of the target repository on purpose. The tool passes the
 * checked-out HEAD as `target_commitish`, so the commit has to exist in the
 * repository it releases - a scratch history pointed at another repository earns
 * a 422 on `target_commitish`, which is how this file learned that.
 */
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '..', 'release.mjs')

const argv = process.argv.slice(2)
const value = (name, fallback = '') => {
  const at = argv.indexOf(`--${name}`)
  return at === -1 ? fallback : argv[at + 1]
}

const repo = value('repo')
const api = value('api-url', 'https://api.github.com')
const token = process.env.GH_TOKEN || ''

if (!repo) {
  console.error('usage: node scripts/live-contract.mjs --repo <owner/name> [--api-url <url>]')
  process.exit(2)
}
if (!token) {
  console.error(
    'GH_TOKEN is empty: this check needs a token with contents: write on ' +
      `${repo}. Point it at a sandbox - it creates and deletes a release there.`
  )
  process.exit(2)
}

const headers = {
  accept: 'application/vnd.github+json',
  authorization: `Bearer ${token}`,
  'x-github-api-version': '2022-11-28'
}

const call = async (path, method = 'GET', body) => {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  })
  const text = await response.text()
  return { status: response.status, json: text ? JSON.parse(text) : {} }
}

const envelope = {
  GIT_AUTHOR_NAME: 'sasjs-release',
  GIT_AUTHOR_EMAIL: 'release@sasjs.io',
  GIT_COMMITTER_NAME: 'sasjs-release',
  GIT_COMMITTER_EMAIL: 'release@sasjs.io',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null'
}
const git = (cwd, ...args) =>
  exec('git', args, { cwd, env: { ...process.env, ...envelope } }).then((r) => r.stdout.trim())

/** Run the tool and answer its exit code and both streams, without throwing. */
const tool = async (args) => {
  try {
    const { stdout, stderr } = await exec('node', [cli, ...args], {
      env: { ...process.env, GH_TOKEN: token }
    })
    return { code: 0, out: `${stdout}${stderr}` }
  } catch (error) {
    return { code: error.code ?? 1, out: `${error.stdout || ''}${error.stderr || ''}` }
  }
}

const failures = []
const check = (condition, description, detail = '') => {
  if (condition) console.log(`  ok    ${description}`)
  else {
    console.log(`  FAIL  ${description}${detail ? ` - ${detail}` : ''}`)
    failures.push(description)
  }
}

const runId = `contract-${Date.now()}`
const scratch = mkdtempSync(join(tmpdir(), 'live-'))
let tag = ''
let releaseId = ''

try {
  // a clone of the target, because target_commitish is this checkout's HEAD: a
  // sha that does not exist upstream is a 422, not a release
  const url = `https://x-access-token:${token}@github.com/${repo}.git`
  await exec('git', ['clone', '--quiet', '--depth', '1', url, scratch], {
    env: { ...process.env, ...envelope }
  })
  writeFileSync(join(scratch, 'asset.txt'), runId)
  console.log(`  cloned ${repo} at ${await git(scratch, 'rev-parse', '--short', 'HEAD')}`)

  console.log(`creating a draft release in ${repo}`)
  const out = join(scratch, 'output')
  const first = await tool([
    '--repo-dir', scratch, '--host', 'github', '--release', '--draft', '--level', 'patch',
    '--api-url', api, '--repo', repo, '--asset', join(scratch, 'asset.txt'), '--output', out
  ])

  const reported = readFileSync(out, 'utf8').trim()
  console.log(reported.split('\n').map((line) => `  | ${line}`).join('\n'))
  check(first.code === 0, 'the tool exits cleanly', first.out.trim().split('\n').slice(-2).join(' | '))

  const fields = Object.fromEntries(
    reported
      .split('\n')
      .filter(Boolean)
      .map((line) => [line.split('=')[0], line.slice(line.indexOf('=') + 1)])
  )
  check(fields.released === 'true', 'it reports a release', JSON.stringify(fields))
  tag = fields.tag || ''

  if (tag) {
    // drafts are invisible to the by-tag endpoint, which is why the tool lists
    // releases when it is looking for one it may have created before
    const byTag = await call(`/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`)
    check(byTag.status === 404, 'the by-tag endpoint still hides drafts', `status ${byTag.status}`)

    const all = await call(`/repos/${repo}/releases?per_page=100`)
    const release = (Array.isArray(all.json) ? all.json : []).find((r) => r.tag_name === tag) || {}
    releaseId = release.id ? String(release.id) : ''
    check(Boolean(releaseId), 'the release is visible when releases are listed', `tag ${tag}`)
    check(release.draft === true, 'it was created as a draft, so nothing advertises it yet')

    const assets = (release.assets || []).map((asset) => asset.name)
    check(assets.includes('asset.txt'), 'the asset upload accepted upload_url', assets.join(', '))

    // a draft does NOT create the tag: the tag appears when the release is
    // published. Anything that resolves "the tag this release cut" before then
    // finds nothing, which is why the tool marks the tag locally too.
    const beforePublish = await call(`/repos/${repo}/git/ref/tags/${encodeURIComponent(tag)}`)
    check(beforePublish.status === 404, 'a draft release has not created its tag yet', `status ${beforePublish.status}`)

    const published = await call(`/repos/${repo}/releases/${releaseId}`, 'PATCH', { draft: false })
    check(published.status === 200, 'the draft can be published', `status ${published.status}`)

    const afterPublish = await call(`/repos/${repo}/git/ref/tags/${encodeURIComponent(tag)}`)
    check(afterPublish.status === 200, 'publishing the release is what creates the tag', `status ${afterPublish.status}`)

    // the re-runnable path: a second run has to find what the first made and
    // finish it rather than fail on the 422 the forge answers
    // no --level this time: the tag the first run cut now names HEAD, and that is
    // the "finish what a dead run started" path, which is where the forge's 422
    // has to be turned into a lookup rather than a failure
    const again = await tool([
      '--repo-dir', scratch, '--host', 'github', '--release', '--draft',
      '--api-url', api, '--repo', repo
    ])
    check(
      again.out.includes('already exists: finishing it'),
      'a second run finishes the existing release rather than failing on 422',
      again.out.trim().split('\n').slice(-2).join(' | ')
    )
    check(again.code === 0, 'and the second run is not an error', String(again.code))
    if (again.code !== 0) console.log(`        ${again.out.trim().split('\n').slice(-3).join(' | ')}`)
  }
} catch (error) {
  console.log(`  FAIL  the run threw - ${error.message}`)
  failures.push('the run threw')
} finally {
  if (releaseId) {
    const removed = await call(`/repos/${repo}/releases/${releaseId}`, 'DELETE')
    check([204, 404].includes(removed.status), 'the release was deleted again', `status ${removed.status}`)
  }
  if (tag) {
    const ref = await call(`/repos/${repo}/git/refs/tags/${encodeURIComponent(tag)}`, 'DELETE')
    check([204, 422].includes(ref.status), 'the tag was deleted again', `status ${ref.status}`)
  }
  rmSync(scratch, { recursive: true, force: true })
}

if (failures.length) {
  console.error(`\n${failures.length} live contract check(s) failed`)
  process.exit(1)
}
console.log('\nthe forge still behaves the way the stubs believe')
