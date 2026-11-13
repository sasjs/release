import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
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

function git(cwd, ...argv) {
  return execFileSync('git', argv, { cwd, encoding: 'utf8', env: { ...process.env, ...envelope } }).trim()
}

/**
 * A repository whose history is the fixture: the first commit is what the
 * version was cut at, and the ones after it are the unreleased work.
 */
function repo({ tag = 'v1.7.1', commits = ['feat: initial'] } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'sasjs-release-'))
  git(cwd, 'init', '-b', 'main')
  const [first, ...pending] = commits
  commit(cwd, first)
  if (tag) git(cwd, 'tag', '-a', tag, '-m', tag)
  for (const message of pending) commit(cwd, message)
  return cwd
}

function commit(cwd, message) {
  writeFileSync(join(cwd, 'file.txt'), message)
  git(cwd, 'add', '.')
  git(cwd, 'commit', '-m', message)
}

function run(cwd, ...argv) {
  return execFileSync('node', [CLI, '--repo-dir', cwd, ...argv], {
    encoding: 'utf8',
    env: { ...process.env, ...envelope }
  })
}

/**
 * The same run, without blocking this process: a stub server lives in this
 * process, so a synchronous spawn would deadlock the request it has to answer.
 */
const runAsync = promisify(execFile)
const runInParallel = (cwd, ...argv) => {
  const env = argv.at(-1) && typeof argv.at(-1) === 'object' ? argv.pop() : {}
  return runAsync('node', [CLI, '--repo-dir', cwd, ...argv], {
    env: { ...process.env, ...envelope, ...env }
  }).then(({ stdout }) => stdout)
}

/** The message a failing run prints, which is on stderr, not the exception. */
function failure(cwd, ...argv) {
  try {
    run(cwd, ...argv)
  } catch (error) {
    return String(error.stderr || error.message)
  }
  assert.fail('expected the run to fail')
}

const levelOf = (output) => output.match(/^level=(.+)$/m)?.[1]
const versionOf = (output) => output.match(/^version=(.+)$/m)?.[1]
const releasedOf = (output) => output.match(/^released=(.+)$/m)?.[1]

test('a fix is a patch release', () => {
  const cwd = repo({ commits: ['feat: initial', 'fix: stop losing the last row'] })
  const out = run(cwd, '--dry-run')
  assert.equal(levelOf(out), 'patch')
  assert.equal(versionOf(out), '1.7.2')
})

test('a feat is a minor release', () => {
  const cwd = repo({ commits: ['feat: initial', 'feat: filter by column'] })
  const out = run(cwd, '--dry-run')
  assert.equal(levelOf(out), 'minor')
  assert.equal(versionOf(out), '1.8.0')
})

test('a bang is a major release', () => {
  const cwd = repo({ commits: ['feat: initial', 'feat!: drop the old endpoint'] })
  assert.equal(versionOf(run(cwd, '--dry-run')), '2.0.0')
})

test('a BREAKING CHANGE footer is a major release', () => {
  const cwd = repo({
    commits: ['feat: initial', 'fix: tidy\n\nBREAKING CHANGE: the shape of the envelope moved']
  })
  assert.equal(versionOf(run(cwd, '--dry-run')), '2.0.0')
})

test('breaking before 1.0.0 is a minor, not a major', () => {
  const cwd = repo({ tag: 'v0.4.0', commits: ['feat: initial', 'feat!: new shape'] })
  assert.equal(versionOf(run(cwd, '--dry-run')), '0.5.0')
})

test('nothing conventional means nothing to release', () => {
  const cwd = repo({ commits: ['feat: initial', 'docs: tidy the readme'] })
  const out = run(cwd, '--dry-run')
  assert.equal(releasedOf(out), 'false')
  assert.match(out, /nothing to release since v1\.7\.1/)
})

test('--level releases when the log does not classify', () => {
  const cwd = repo({ commits: ['feat: initial', 'wip'] })
  assert.equal(versionOf(run(cwd, '--dry-run', '--level', 'patch')), '1.7.2')
})

test('the tag prefix scopes a monorepo component', () => {
  const cwd = repo({ tag: 'web-v3.2.0', commits: ['feat: initial', 'fix: button'] })
  // a sas- tag is a different component's history, so it is not this one's base
  git(cwd, 'tag', '-a', 'sas-v9.9.9', '-m', 'sas')
  const out = run(cwd, '--dry-run', '--tag-prefix', 'web-v')
  assert.equal(versionOf(out), '3.2.1')
  assert.equal(out.match(/^tag=(.+)$/m)?.[1], 'web-v3.2.1')
})

test('--paths ignores commits that touch nothing in the package', () => {
  const cwd = repo({ commits: ['feat: initial'] })
  writeFileSync(join(cwd, 'client.txt'), 'a')
  git(cwd, 'add', '.')
  git(cwd, 'commit', '-m', 'feat: other component')
  const out = run(cwd, '--dry-run', '--paths', 'nothing-here')
  assert.equal(releasedOf(out), 'false')
})

test('a prerelease continues the last one of the same base', () => {
  const cwd = repo({ tag: 'v1.8.0-beta.2', commits: ['feat: initial', 'fix: beta fix'] })
  const out = run(cwd, '--dry-run', '--prerelease', 'beta')
  assert.equal(versionOf(out), '1.8.0-beta.3')
})

test('a prerelease starts at .1 when the last tag is stable', () => {
  const cwd = repo({ commits: ['feat: initial', 'feat: next thing'] })
  assert.equal(versionOf(run(cwd, '--dry-run', '--prerelease', 'rc')), '1.8.0-rc.1')
})

test('--tag creates the annotated tag and names the commit', () => {
  const cwd = repo({ commits: ['feat: initial', 'feat: filter by column'] })
  run(cwd, '--tag')
  assert.equal(git(cwd, 'rev-parse', 'v1.8.0^{commit}'), git(cwd, 'rev-parse', 'HEAD'))
  assert.equal(git(cwd, 'cat-file', '-t', 'v1.8.0'), 'tag')
})

test('an unresolvable --since is an error, not an empty release', () => {
  const cwd = repo({ commits: ['feat: initial', 'feat: one'] })
  assert.match(failure(cwd, '--dry-run', '--since', 'v9.9.9'), /--since v9\.9\.9 is not a commit/)
})

test('a cut whose tag exists at HEAD is finished, not reported as nothing', () => {
  // the state a run leaves when it dies after the tag: the tag names HEAD and
  // no release exists. Re-running has to push and publish it.
  const cwd = repo({ commits: ['feat: initial', 'feat: filter by column'] })
  run(cwd, '--tag')
  const noteFile = join(cwd, 'notes.md')
  const out = run(cwd, '--tag', '--notes-file', noteFile)
  assert.match(out, /v1\.8\.0 already names HEAD: finishing that release/)
  assert.equal(versionOf(out), '1.8.0')
  // the notes are the commits the tag covers, not the empty range after it
  assert.match(readFileSync(noteFile, 'utf8'), /\* filter by column/)
})

test('an existing tag on another commit is refused, not moved', () => {
  const cwd = repo({ commits: ['feat: initial', 'fix: one'] })
  // a v1.7.2 exists, on the released commit rather than on HEAD
  const first = git(cwd, 'rev-parse', 'HEAD~1')
  git(cwd, 'tag', '-a', 'v1.7.2', '-m', 'v1.7.2', first)
  const error = failure(cwd, '--tag', '--since', 'v1.7.1')
  assert.match(error, /v1\.7\.2 exists and names/)
})

test('--notes-file holds the notes without the heading line', () => {
  const cwd = repo({ commits: ['feat: initial', 'feat: filter by column'] })
  const file = join(cwd, 'notes.md')
  run(cwd, '--notes-file', file)
  const notes = readFileSync(file, 'utf8')
  assert.match(notes, /### Features/)
  assert.match(notes, /\* filter by column/)
  // the heading is printed to the log, the file carries the body
  assert.match(notes, /^## /)
})

test('--dry-run writes no tag and no file', () => {
  const cwd = repo({ commits: ['feat: initial', 'feat: one'] })
  run(cwd, '--dry-run', '--tag', '--notes-file', join(cwd, 'notes.md'))
  assert.equal(existsSync(join(cwd, 'notes.md')), false)
  assert.equal(git(cwd, 'tag', '--list'), 'v1.7.1')
})

/** A server that records what was sent, so the adapter shape is asserted. */
async function stub(respond) {
  const seen = []
  const server = http.createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      seen.push({
        method: request.method,
        url: request.url,
        auth: request.headers.authorization,
        privateToken: request.headers['private-token'],
        jobToken: request.headers['job-token'],
        type: request.headers['content-type'],
        body: Buffer.concat(chunks).toString()
      })
      const { status = 200, json = {} } = respond(request) || {}
      // no keep-alive: the suite has to end when the last test does, and a
      // socket left open by a client makes node:test wait for it
      response.writeHead(status, {
        'content-type': 'application/json',
        connection: 'close'
      })
      response.end(JSON.stringify(json))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    seen,
    base: `http://127.0.0.1:${server.address().port}`,
    // fetch keeps sockets alive, so closing the listener alone leaves the test
    // file's event loop pending and node:test reports it as a timeout
    stop: () => {
      server.closeAllConnections()
      server.close()
    }
  }
}

test('github: creates the release and uploads each asset to its upload_url', async (t) => {
  // the upload_url is absolute in real life; the stub learns its own port only
  // after listen, so the responder reads it at request time
  let base = ''
  const replacement = await stub((request) =>
    request.url.startsWith('/repos/')
      ? { json: { upload_url: `${base}/upload{?name,label}` } }
      : { json: { ok: true } }
  )
  t.after(() => replacement.stop())
  base = replacement.base

  const cwd = repo({ commits: ['feat: initial', 'feat: one'] })
  const asset = join(cwd, 'app.zip')
  writeFileSync(asset, 'zip')
  process.env.GH_TOKEN = 'token-123'

  await runInParallel(cwd, '--tag', '--host', 'github', '--release', '--api-url',
    replacement.base, '--repo', 'sasjs/app', '--asset', asset)

  const created = replacement.seen.find((r) => r.url === '/repos/sasjs/app/releases')
  assert.equal(created.method, 'POST')
  assert.equal(created.auth, 'Bearer token-123')
  const payload = JSON.parse(created.body)
  assert.equal(payload.tag_name, 'v1.8.0')
  // the host creates the tag where we say: no git credentials, no push
  assert.equal(payload.target_commitish, git(cwd, 'rev-parse', 'HEAD'))

  // the {?name,label} template must be stripped before it is used
  const upload = replacement.seen.find((r) => r.url.startsWith('/upload?name=app.zip'))
  assert.match(upload.type, /^multipart\/form-data/)
})

test('gitea: creates the release over the REST API and posts the asset', async (t) => {
  const replacement = await stub(() => ({ json: { id: 42, body: 'x' } }))
  t.after(() => replacement.stop())
  const cwd = repo({ commits: ['feat: initial', 'fix: one'] })
  const asset = join(cwd, 'frontend.zip')
  writeFileSync(asset, 'zip')
  process.env.GITEA_TOKEN = 'gitea-token'

  await runInParallel(cwd, '--host', 'gitea', '--release', '--api-url',
    replacement.base, '--repo', 'dc/dc', '--asset', asset)

  const created = replacement.seen.find((r) => r.url === '/repos/dc/dc/releases')
  assert.equal(created.auth, 'token gitea-token')
  assert.equal(JSON.parse(created.body).tag_name, 'v1.7.2')
  assert.equal(JSON.parse(created.body).target_commitish, git(cwd, 'rev-parse', 'HEAD'))
  const posted = replacement.seen.find((r) => r.url.startsWith('/repos/dc/dc/releases/42/assets'))
  assert.match(posted.type, /^multipart\/form-data/)
  // the body is patched after creation, because gitea returns the body it stored
  assert.ok(replacement.seen.some((r) => r.method === 'PATCH'))
})

test('gitlab: creates the release and attaches links, which is all it has', async (t) => {
  const replacement = await stub(() => ({ json: { tag_name: 'v1.7.2' } }))
  t.after(() => replacement.stop())
  const cwd = repo({ commits: ['feat: initial', 'fix: one'] })
  process.env.GITLAB_TOKEN = 'gl-token'

  await runInParallel(cwd, '--host', 'gitlab', '--release', '--api-url',
    replacement.base, '--repo', 'client/app',
    '--asset-link', 'app.zip=https://example.com/app.zip')

  const created = replacement.seen.find((r) => r.url === '/projects/client%2Fapp/releases')
  assert.equal(created.privateToken, 'gl-token')
  assert.equal(JSON.parse(created.body).tag_name, 'v1.7.2')
  // without ref, gitlab fails on a tag that does not exist yet
  assert.equal(JSON.parse(created.body).ref, git(cwd, 'rev-parse', 'HEAD'))
  const link = replacement.seen.find((r) => r.url === '/projects/client%2Fapp/releases/v1.7.2/assets/links')
  assert.deepEqual(JSON.parse(link.body), { name: 'app.zip', url: 'https://example.com/app.zip' })
})

test('a gitlab job token goes in its own header, so no personal token is needed', async (t) => {
  const replacement = await stub(() => ({ json: { tag_name: 'v1.7.2' } }))
  t.after(() => replacement.stop())
  const cwd = repo({ commits: ['feat: initial', 'fix: one'] })

  await runInParallel(cwd, '--host', 'gitlab', '--release', '--api-url',
    replacement.base, '--repo', 'client/app', '--token-env', 'CI_JOB_TOKEN', {
      ...process.env,
      CI_JOB_TOKEN: 'job-token-1'
    })

  const created = replacement.seen.find((r) => r.url === '/projects/client%2Fapp/releases')
  assert.equal(created.jobToken, 'job-token-1')
  assert.equal(created.privateToken, undefined)
})

test('no token is a failure that says which variable to set', () => {
  const cwd = repo({ commits: ['feat: initial', 'fix: one'] })
  delete process.env.GH_TOKEN
  assert.match(
    failure(cwd, '--host', 'github', '--release', '--repo', 'sasjs/app'),
    /no token: set GH_TOKEN/
  )
})
