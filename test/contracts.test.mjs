/**
 * The output contract: which keys each path reports.
 *
 * A pipeline joins two invocations of this tool through whatever variable
 * protocol its CI has, and asserts that the keys it reads were reported. That
 * makes the set of keys - not just the version arithmetic - part of the public
 * interface: a path that stops emitting `level`, or starts emitting something a
 * caller does not expect, is a breaking change whether or not the version was
 * right.
 *
 * These tests exist because a caller's assertion over a shared output file was
 * wrong twice in one afternoon: it demanded `level` from the "nothing to
 * release" path, which correctly emits `released` alone, and failed a pull
 * request for being correct. Pin the shape here, so a consumer's assertion is a
 * decision rather than a guess.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const CLI =
  process.env.SASJS_RELEASE_ENTRY || fileURLToPath(new URL('../release.mjs', import.meta.url))
const execFileAsync = promisify(execFile)

const envelope = {
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null'
}

const git = (cwd, ...argv) =>
  execFileSync('git', argv, { cwd, encoding: 'utf8', env: { ...process.env, ...envelope } }).trim()

/** A repository whose history is exactly what the caller asked for. */
function repo({ tag = 'v1.2.3', commits = ['feat: initial'] } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'contract-'))
  git(cwd, 'init', '-b', 'main')
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: '@fixture/pkg', version: '0.0.0' }))
  commits.forEach((message, index) => {
    writeFileSync(join(cwd, `f${index}`), String(index))
    git(cwd, 'add', '.')
    git(cwd, 'commit', '-m', message)
    if (index === 0 && tag) git(cwd, 'tag', '-a', tag, '-m', tag)
  })
  return cwd
}

/** Run with --output into a file, and answer the ordered list of keys written. */
async function keys(cwd, ...argv) {
  const out = join(mkdtempSync(join(tmpdir(), 'out-')), 'output')
  writeFileSync(out, '')
  try {
    await execFileAsync('node', [CLI, '--repo-dir', cwd, ...argv, '--output', out], {
      encoding: 'utf8',
      env: { ...process.env, ...envelope, GH_TOKEN: 'token-123' }
    })
  } catch (error) {
    assert.fail(`expected a clean run: ${error.stderr || error.message}`)
  }
  return readFileSync(out, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('=')[0])
    .sort()
}

async function stub(respond) {
  const server = http.createServer((request, response) => {
    request.on('data', () => {})
    request.on('end', () => {
      const { status = 200, json = {} } = respond(request) || {}
      response.writeHead(status, { 'content-type': 'application/json', connection: 'close' })
      response.end(JSON.stringify(json))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    stop: () => {
      server.closeAllConnections()
      server.close()
    }
  }
}

test('a dry run that would release reports released, version, tag, level', async () => {
  const cwd = repo({ commits: ['feat: initial', 'feat: one'] })
  assert.deepEqual(await keys(cwd, '--dry-run'), ['level', 'released', 'tag', 'version'])
  // and it says released=false, because a dry run releases nothing: the four keys
  // describe what would be released, not that something was
  const out = join(mkdtempSync(join(tmpdir(), 'out-')), 'output')
  writeFileSync(out, '')
  await execFileAsync('node', [CLI, '--repo-dir', cwd, '--dry-run', '--output', out], {
    encoding: 'utf8',
    env: { ...process.env, ...envelope }
  })
  assert.match(readFileSync(out, 'utf8'), /^released=false$/m)
})

test('a history with nothing to release reports released alone', async () => {
  // the shape a caller must not assume further keys from - a docs-only pull
  // request reaches this path, and asserting `level` here fails a correct branch
  const cwd = repo({ commits: ['feat: initial', 'docs: clarify the readme'] })
  assert.deepEqual(await keys(cwd, '--dry-run'), ['released'])
})

test('a cut release reports released, version, tag, level', async (t) => {
  const host = await stub((request) =>
    request.url.endsWith('/releases')
      ? { status: 201, json: { id: 1, upload_url: 'http://127.0.0.1:1/upload{?name,label}' } }
      : { json: { ok: true } }
  )
  t.after(() => host.stop())
  const cwd = repo({ commits: ['feat: initial', 'feat: one'] })

  assert.deepEqual(
    await keys(cwd, '--host', 'github', '--release', '--api-url', host.base, '--repo', 'sasjs/app'),
    ['level', 'released', 'tag', 'version']
  )
})

test('the prepare step reports the same five keys whether it publishes or not', async (t) => {
  const registry = await stub(() => ({ status: 404 }))
  t.after(() => registry.stop())
  const cwd = repo({ commits: ['feat: initial'] })

  // a tag at HEAD, nothing on the registry: publish
  const publishing = await keys(cwd, '--prepare-publish', '--registry', registry.base)
  assert.deepEqual(publishing, ['exists', 'publish', 'skip', 'tag', 'version'])

  // a commit after the tag, so nothing resolves: skip. Same five keys, so a caller
  // reads one shape rather than two.
  writeFileSync(join(cwd, 'later'), 'later')
  git(cwd, 'add', '.')
  git(cwd, 'commit', '-m', 'chore: after the tag')
  const skipping = await keys(cwd, '--prepare-publish', '--registry', registry.base)
  assert.deepEqual(skipping, ['exists', 'publish', 'skip', 'tag', 'version'])
})
