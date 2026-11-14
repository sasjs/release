import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('../release.mjs', import.meta.url))

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

const write = (cwd, name, version) =>
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name, version }, null, 2))

/** A repository with a package.json, one commit, and optionally a tag on it. */
function repo({ name = '@fixture/pkg', version = '0.0.0', tag = 'v1.2.3' } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'prepare-'))
  git(cwd, 'init', '-b', 'main')
  write(cwd, name, version)
  git(cwd, 'add', '.')
  git(cwd, 'commit', '-m', 'feat: fixture')
  if (tag) git(cwd, 'tag', '-a', tag, '-m', tag)
  return cwd
}

// execFile, not execFileSync: the child asks the stub registry a question, and a
// synchronous call would block this process's event loop - so the stub could never
// answer, and both sides would wait forever.
const execFileAsync = promisify(execFile)
const run = async (cwd, ...argv) => {
  const env = argv.at(-1) && typeof argv.at(-1) === 'object' ? argv.pop() : {}
  try {
    const { stdout } = await execFileAsync(
      'node',
      [CLI, '--repo-dir', cwd, '--prepare-publish', ...argv],
      { encoding: 'utf8', env: { ...process.env, ...envelope, ...env } }
    )
    return { ok: true, out: stdout }
  } catch (error) {
    return { ok: false, out: String(error.stderr || error.stdout || error.message) }
  }
}

/** A registry that answers as told, and records what was asked for. */
async function registry(status = 404) {
  const seen = []
  const server = http.createServer((request, response) => {
    seen.push(request.url)
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(status === 200 ? { version: 'x' } : { error: 'not found' }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    seen,
    url: `http://127.0.0.1:${server.address().port}`,
    stop: () => {
      server.closeAllConnections()
      server.close()
    }
  }
}

test('stamps the tag version and reports that it should publish', async (t) => {
  const reg = await registry(404)
  t.after(() => reg.stop())
  const cwd = repo({ version: '0.0.0', tag: 'v1.2.3' })

  const { ok, out } = await run(cwd, '--registry', reg.url)
  assert.equal(ok, true, out)
  assert.match(out, /stamped package\.json 0\.0\.0 -> 1\.2\.3/)
  assert.match(out, /version=1\.2\.3/)
  assert.match(out, /publish=true/)
  assert.equal(JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')).version, '1.2.3')
})

test('asks the registry about the scoped name, encoded', async (t) => {
  const reg = await registry(404)
  t.after(() => reg.stop())
  const cwd = repo({ name: '@fixture/pkg' })

  const { ok } = await run(cwd, '--registry', reg.url)
  assert.equal(ok, true)
  assert.deepEqual(reg.seen, ['/@fixture%2Fpkg/1.2.3'])
})

test('skips when the commit carries no tag and the clone has tags', async (t) => {
  const reg = await registry(404)
  t.after(() => reg.stop())
  const cwd = repo({ tag: 'v1.2.3' })
  writeFileSync(join(cwd, 'x'), 'x')
  git(cwd, 'add', '.')
  git(cwd, 'commit', '-m', 'chore: after the tag')

  const { ok, out } = await run(cwd, '--registry', reg.url)
  assert.equal(ok, true, out)
  assert.match(out, /that release cut nothing/)
  assert.match(out, /skip=true/)
  assert.match(out, /publish=false/)
})

test('fails rather than skipping when the checkout is shallow', async (t) => {
  const reg = await registry(404)
  t.after(() => reg.stop())
  const source = repo({ tag: 'v1.2.3' })
  const shallow = mkdtempSync(join(tmpdir(), 'shallow-'))
  git(shallow, 'clone', '--depth', '1', '--no-tags', `file://${source}`, '.')

  const { ok, out } = await run(shallow, '--registry', reg.url)
  assert.equal(ok, false, out)
  assert.match(out, /checkout is shallow/)
  assert.match(out, /fetch-depth: 0/)
})

test('refuses a tag that is not on the branch being published', async (t) => {
  const reg = await registry(404)
  t.after(() => reg.stop())
  const cwd = repo({ tag: null })
  // a tag on a side branch: reachable from nowhere in main's history
  git(cwd, 'checkout', '-q', '-b', 'side')
  writeFileSync(join(cwd, 'y'), 'y')
  git(cwd, 'add', '.')
  git(cwd, 'commit', '-m', 'feat: side work')
  git(cwd, 'tag', '-a', 'v9.9.9', '-m', 'v9.9.9')
  git(cwd, 'checkout', '-q', 'main')
  writeFileSync(join(cwd, 'z'), 'z')
  git(cwd, 'add', '.')
  git(cwd, 'commit', '-m', 'fix: on main')

  const { ok, out } = await run(cwd, '--tag', 'v9.9.9', '--registry', reg.url)
  assert.equal(ok, false, out)
  assert.match(out, /is not on HEAD - refusing to publish it/)
})

test('does not publish a version the registry already serves', async (t) => {
  const reg = await registry(200)
  t.after(() => reg.stop())
  const cwd = repo({ tag: 'v1.2.3' })

  const { ok, out } = await run(cwd, '--registry', reg.url)
  assert.equal(ok, true, out)
  assert.match(out, /already on/)
  assert.match(out, /publish=false/)
  assert.match(out, /exists=true/)
})

test('--republish publishes over an existing version anyway', async (t) => {
  const reg = await registry(200)
  t.after(() => reg.stop())
  const cwd = repo({ tag: 'v1.2.3' })

  const { ok, out } = await run(cwd, '--registry', reg.url, '--republish')
  assert.equal(ok, true, out)
  assert.match(out, /publish=true/)
})

test('--dry-run decides without writing the version', async (t) => {
  const reg = await registry(404)
  t.after(() => reg.stop())
  const cwd = repo({ version: '0.0.0', tag: 'v1.2.3' })

  const { ok, out } = await run(cwd, '--registry', reg.url, '--dry-run')
  assert.equal(ok, true, out)
  assert.match(out, /would stamp package\.json 0\.0\.0 -> 1\.2\.3/)
  assert.equal(JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')).version, '0.0.0')
})

test('a registry that refuses the request stops the run and says which variable', async (t) => {
  const reg = await registry(401)
  t.after(() => reg.stop())
  const cwd = repo({ tag: 'v1.2.3' })

  const { ok, out } = await run(cwd, '--registry', reg.url)
  assert.equal(ok, false, out)
  assert.match(out, /answered 401/)
  assert.match(out, /NODE_AUTH_TOKEN/)
})

test('publishes from a clone whose local branch is behind origin', async (t) => {
  const reg = await registry(404)
  t.after(() => reg.stop())

  const origin = mkdtempSync(join(tmpdir(), 'origin-'))
  git(origin, 'init', '--bare', '-b', 'main', '.')

  const ahead = mkdtempSync(join(tmpdir(), 'ahead-'))
  git(ahead, 'clone', '-q', `file://${origin}`, '.')
  write(ahead, '@fixture/pkg', '0.0.0')
  git(ahead, 'add', '.')
  git(ahead, 'commit', '-m', 'feat: one')
  git(ahead, 'push', '-q', 'origin', 'main')

  // cloned before the tag exists, and never fast-forwarded afterwards
  const behind = mkdtempSync(join(tmpdir(), 'behind-'))
  git(behind, 'clone', '-q', `file://${origin}`, '.')

  writeFileSync(join(ahead, 'later'), 'later')
  git(ahead, 'add', '.')
  git(ahead, 'commit', '-m', 'feat: the release')
  git(ahead, 'tag', '-a', 'v1.2.3', '-m', 'v1.2.3')
  git(ahead, 'push', '-q', 'origin', 'main', '--tags')

  // the clone learns about the tag and origin/main, but its own main stays put
  git(behind, 'fetch', '-q', 'origin', '--tags')
  assert.notEqual(git(behind, 'rev-parse', 'main'), git(behind, 'rev-parse', 'origin/main'))

  const { ok, out } = await run(behind, '--tag', 'v1.2.3', '--branch', 'main', '--registry', reg.url)
  assert.equal(ok, true, out)
  assert.match(out, /the local main does not contain v1\.2\.3, origin\/main does/)
  assert.match(out, /publish=true/)
})
