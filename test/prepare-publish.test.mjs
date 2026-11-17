import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, writeFileSync, readFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

// scripts/mutate.mjs runs this suite against a deliberately broken copy, so the
// entry point is overridable; everything else runs the real one.
const CLI =
  process.env.SASJS_RELEASE_ENTRY || fileURLToPath(new URL('../release.mjs', import.meta.url))

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

test('prepare-publish still rejects an unreadable package even when there is no tag', async () => {
  const cwd = repo({ tag: null })
  writeFileSync(join(cwd, 'package.json'), '{ broken')
  const result = await run(cwd)
  assert.equal(result.ok, false)
  assert.match(result.out, /cannot read .*package\.json/)
})

test('tagged source prepares before npm synchronizes the checked-out lockfile', async (t) => {
  const reg = await registry(404)
  t.after(() => reg.stop())
  const cwd = repo({ tag: null })
  writeFileSync(join(cwd, 'release.mjs'), readFileSync(CLI))
  writeFileSync(join(cwd, 'package-lock.json'), JSON.stringify({ name: '@fixture/pkg', version: '0.0.0', lockfileVersion: 3, packages: { '': { name: '@fixture/pkg', version: '0.0.0' } } }, null, 2))
  git(cwd, 'add', '.')
  git(cwd, 'commit', '-m', 'feat: tagged CLI')
  git(cwd, 'tag', 'v1.2.3')
  writeFileSync(join(cwd, 'release.mjs'), 'throw new Error("main must not run")')
  git(cwd, 'add', '.')
  git(cwd, 'commit', '-m', 'chore: newer main')
  git(cwd, 'checkout', '-q', 'refs/tags/v1.2.3')
  const env = { ...process.env, ...envelope }
  delete env.NODE_V8_COVERAGE // fixture and npm are not part of this package's coverage
  const result = await execFileAsync('node', ['release.mjs', '--prepare-publish', '--tag', 'v1.2.3', '--branch', 'HEAD', '--registry', reg.url], { cwd, encoding: 'utf8', env })
  assert.match(result.stdout, /publish=true/)
  await execFileAsync('npm', ['version', '1.2.3', '--no-git-tag-version', '--allow-same-version'], { cwd, env })
  const lock = JSON.parse(readFileSync(join(cwd, 'package-lock.json'), 'utf8'))
  assert.equal(lock.version, '1.2.3')
  assert.equal(lock.packages[''].version, '1.2.3')
})

test('workflow discovery fails closed on invalid run SHA and dispatch input', async () => {
  const yaml = readFileSync(fileURLToPath(new URL('../.github/workflows/publish.yml', import.meta.url)), 'utf8')
  const block = yaml.split('      - name: Resolve the tag\n')[1].split('      - name: Check out the tag\n')[0]
  const script = block.split('        run: |\n')[1].split('\n').map((line) => line.startsWith('          ') ? line.slice(10) : line).join('\n')
  const cwd = repo({ tag: null })
  const output = join(cwd, 'output')
  const call = (event, sha, requested) => execFileAsync('bash', ['-c', script], { cwd, env: { ...process.env, ...envelope, EVENT: event, SHA: sha, REQUESTED: requested, GITHUB_OUTPUT: output } })
  await assert.rejects(call('workflow_run', '', ''), /invalid or missing workflow run SHA/)
  await assert.rejects(call('workflow_dispatch', '', ''), /no tag/)
  await assert.rejects(call('workflow_dispatch', '', 'main'), /invalid release tag/)
  const sha = git(cwd, 'rev-parse', 'HEAD')
  await call('workflow_run', sha, '')
  assert.match(readFileSync(output, 'utf8'), /skip=true/)
  git(cwd, 'tag', 'v1.2.3')
  await call('workflow_dispatch', '', 'v1.2.3')
  assert.match(readFileSync(output, 'utf8'), /tag=v1\.2\.3/)
})

test('publish workflow runs the checked-out tag CLI to prepare, then updates the lockfile', () => {
  const workflow = readFileSync(fileURLToPath(new URL('../.github/workflows/publish.yml', import.meta.url)), 'utf8')
  const checkout = workflow.indexOf('- name: Check out the tag')
  const suite = workflow.indexOf('- name: The suite passes at this tag')
  const prepare = workflow.indexOf('--prepare-publish')
  const stamp = workflow.indexOf('npm version', prepare)
  const publish = workflow.indexOf('- name: Publish', prepare)
  assert.ok(checkout >= 0 && checkout < suite && suite < prepare && prepare < stamp && stamp < publish)
  assert.match(workflow.slice(prepare, publish), /node release\.mjs/)
  assert.doesNotMatch(workflow, /--discover-publish/)
})

test('discovery uses the explicit tag ref for ancestry of manual and SHA-selected tags', async () => {
  const cwd = repo()
  git(cwd, 'branch', 'v1.2.3')
  const sha = git(cwd, 'rev-parse', 'HEAD')
  const bin = mkdtempSync(join(tmpdir(), 'discovery-git-'))
  const trace = join(bin, 'args')
  const wrapper = join(bin, 'git')
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
  writeFileSync(wrapper, '#!/bin/sh\nif [ "$1" = merge-base ]; then printf "%s\\n" "$@" > "$GIT_TRACE_ARGS"; fi\nexec "$REAL_GIT" "$@"\n')
  chmodSync(wrapper, 0o755)
  const env = { ...process.env, ...envelope, PATH: `${bin}:${process.env.PATH}`, REAL_GIT: realGit, GIT_TRACE_ARGS: trace }
  for (const selector of [['--tag', 'v1.2.3'], ['--sha', sha]]) {
    const result = await execFileAsync('node', [CLI, '--repo-dir', cwd, '--discover-publish', ...selector], { encoding: 'utf8', env })
    assert.match(result.stdout, /tag=v1\.2\.3/)
    assert.deepEqual(readFileSync(trace, 'utf8').trim().split('\n'), ['merge-base', '--is-ancestor', 'refs/tags/v1.2.3^{commit}', 'HEAD'])
  }
})

test('prepare-publish keeps accepting a legacy branch as its tag argument', async () => {
  const cwd = repo({ tag: null })
  git(cwd, 'branch', 'v1.2.3')
  const result = await run(cwd, '--tag', 'v1.2.3', '--no-registry-lookup')
  assert.equal(result.ok, true, result.out)
  assert.match(result.out, /publish=true/)
})

test('discovery validates the actual tag even when a branch has the same name', async () => {
  const cwd = repo()
  git(cwd, 'checkout', '-q', '-b', 'side')
  writeFileSync(join(cwd, 'side'), 'side')
  git(cwd, 'add', '.')
  git(cwd, 'commit', '-m', 'feat: side')
  git(cwd, 'tag', 'v2.0.0')
  git(cwd, 'checkout', '-q', 'main')
  git(cwd, 'branch', 'v2.0.0')
  await assert.rejects(execFileAsync('node', [CLI, '--repo-dir', cwd, '--discover-publish', '--tag', 'v2.0.0'], { env: { ...process.env, ...envelope } }), /not on HEAD/)
})

test('discovery returns no-tag skip for a valid commit and selects manual tags only on the branch', async () => {
  const cwd = repo({ tag: null })
  const sha = git(cwd, 'rev-parse', 'HEAD')
  let result = await execFileAsync('node', [CLI, '--repo-dir', cwd, '--discover-publish', '--sha', sha], { encoding: 'utf8', env: { ...process.env, ...envelope } })
  assert.match(result.stdout, /skip=true/)
  git(cwd, 'tag', 'v1.2.3')
  result = await execFileAsync('node', [CLI, '--repo-dir', cwd, '--discover-publish', '--tag', 'v1.2.3'], { encoding: 'utf8', env: { ...process.env, ...envelope } })
  assert.match(result.stdout, /tag=v1\.2\.3/)
  git(cwd, 'checkout', '-q', '-b', 'side')
  writeFileSync(join(cwd, 'side'), 'side')
  git(cwd, 'add', '.')
  git(cwd, 'commit', '-m', 'feat: side')
  git(cwd, 'tag', 'v9.0.0')
  git(cwd, 'checkout', '-q', 'main')
  await assert.rejects(execFileAsync('node', [CLI, '--repo-dir', cwd, '--discover-publish', '--tag', 'v9.0.0'], { env: { ...process.env, ...envelope } }), /not on HEAD/)
})

test('discovery rejects an explicitly empty tag rather than falling back to HEAD', async () => {
  const cwd = repo()
  await assert.rejects(execFileAsync('node', [CLI, '--repo-dir', cwd, '--discover-publish', '--tag', ''], { env: { ...process.env, ...envelope } }), { code: 2 })
})

test('discovery refuses even a shallow checkout with a visible tag', async () => {
  const source = repo()
  const cwd = mkdtempSync(join(tmpdir(), 'discovery-shallow-'))
  git(cwd, 'clone', '-q', '--depth', '1', `file://${source}`, '.')
  await assert.rejects(execFileAsync('node', [CLI, '--repo-dir', cwd, '--discover-publish'], { env: { ...process.env, ...envelope } }), /shallow/)
})

test('discovery refuses manual non-tags and malformed tags', async () => {
  const cwd = repo({ tag: 'v1.2.3' })
  git(cwd, 'tag', 'x1.2.3')
  git(cwd, 'tag', 'v1.2.3-malicious!')
  for (const tag of ['main', 'x1.2.3', 'v1.2.3-malicious!', 'v1.2.3^{commit}']) {
    await assert.rejects(execFileAsync('node', [CLI, '--repo-dir', cwd, '--discover-publish', '--tag', tag], { env: { ...process.env, ...envelope } }), { code: 2 })
  }
})

test('discovery rejects an invalid or missing explicit SHA instead of silently skipping', async () => {
  const cwd = repo({ tag: null })
  for (const sha of ['does-not-exist', '--bad', 'HEAD~999', '']) {
    try {
      await execFileAsync('node', [CLI, '--repo-dir', cwd, '--discover-publish', '--sha', sha], { env: { ...process.env, ...envelope } })
      assert.fail(`accepted ${JSON.stringify(sha)}`)
    } catch (error) {
      assert.equal(error.code, 2, String(error))
    }
  }
})

test('discovery resolves the newest tag without reading the package or registry', async (t) => {
  const reg = await registry(500)
  t.after(() => reg.stop())
  const cwd = repo({ tag: 'v1.2.3' })
  git(cwd, 'tag', 'v1.10.0')
  writeFileSync(join(cwd, 'package.json'), '{ broken')
  const output = join(cwd, 'outputs')
  const { stdout } = await execFileAsync('node', [CLI, '--repo-dir', cwd, '--discover-publish', '--registry', reg.url, '--output', output], {
    encoding: 'utf8', env: { ...process.env, ...envelope }
  })
  assert.match(stdout, /tag=v1\.10\.0/)
  assert.match(readFileSync(output, 'utf8'), /skip=false\ntag=v1\.10\.0\nversion=1\.10\.0/)
  assert.equal(readFileSync(join(cwd, 'package.json'), 'utf8'), '{ broken')
  assert.deepEqual(reg.seen, [])
})

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

test('an unreadable package.json stops the run by name', async (t) => {
  const reg = await registry(404)
  t.after(() => reg.stop())
  const cwd = repo({ tag: 'v1.2.3' })
  writeFileSync(join(cwd, 'package.json'), '{ not json')

  const { ok, out } = await run(cwd, '--registry', reg.url)
  assert.equal(ok, false, out)
  assert.match(out, /cannot read .*package\.json/)
})

test('says so when package.json already states the version, and writes nothing', async (t) => {
  const reg = await registry(404)
  t.after(() => reg.stop())
  const cwd = repo({ version: '1.2.3', tag: 'v1.2.3' })
  const before = readFileSync(join(cwd, 'package.json'), 'utf8')

  const { ok, out } = await run(cwd, '--registry', reg.url)
  assert.equal(ok, true, out)
  assert.match(out, /already states 1\.2\.3/)
  assert.equal(readFileSync(join(cwd, 'package.json'), 'utf8'), before)
})

test('a registry answering something unexpected stops the run with the status', async (t) => {
  const reg = await registry(500)
  t.after(() => reg.stop())
  const cwd = repo({ tag: 'v1.2.3' })

  const { ok, out } = await run(cwd, '--registry', reg.url)
  assert.equal(ok, false, out)
  assert.match(out, /answered 500/)
})

test('--no-registry-lookup never asks the registry, and says it did not', async (t) => {
  // A 500 stops every other path in this file, so reaching the assertions proves
  // the question was not asked rather than merely not caring about the answer.
  const reg = await registry(500)
  t.after(() => reg.stop())
  const cwd = repo({ tag: 'v1.2.3' })

  const { ok, out } = await run(cwd, '--registry', reg.url, '--no-registry-lookup')
  assert.equal(ok, true, out)
  assert.deepEqual(reg.seen, [], 'the registry was contacted')
  assert.match(out, /--no-registry-lookup: not asking/)
  assert.match(out, /publish=true/)
  assert.match(out, /exists=false/)
  assert.equal(JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')).version, '1.2.3')
})

test('--no-registry-lookup still refuses a tag that is not in this clone', async (t) => {
  // The flag skips one question, not the checks that protect the release.
  const reg = await registry(500)
  t.after(() => reg.stop())
  const cwd = repo({ tag: 'v1.2.3' })

  const { ok, out } = await run(cwd, '--registry', reg.url, '--no-registry-lookup', '--tag', 'v9.9.9')
  assert.equal(ok, false, out)
  assert.match(out, /v9\.9\.9 is not in this repository/)
})
