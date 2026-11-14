import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
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

/** A failing run that must not block this process: a stub server answers it. */
const failureInParallel = (cwd, ...argv) =>
  runAsync('node', [CLI, '--repo-dir', cwd, ...argv], {
    encoding: 'utf8',
    env: { ...process.env, ...envelope }
  }).then(
    () => assert.fail('expected the run to fail'),
    (error) => String(error.stderr || error.message)
  )

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
  // the find-before-create step asks first: a stub that answers every request
  // with a release makes the tool believe one already exists
  const replacement = await stub((request) =>
    request.method === 'GET' && request.url.includes('/releases/tags/')
      ? { status: 404, json: { message: 'Not Found' } }
      : { json: { id: 42, body: 'x' } }
  )
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

test('a release that already exists is finished rather than refused', async (t) => {
  // GitHub answers 422 when the tag already has a release; a run that died
  // after that point has to be re-runnable, so the release is looked up and the
  // assets are attached to it
  let base = ''
  let created = 0
  const replacement = await stub((request) => {
    if (request.method === 'POST' && request.url === '/repos/sasjs/app/releases') {
      created += 1
      return { status: 422, json: { message: 'Validation Failed', errors: [{ code: 'already_exists' }] } }
    }
    if (request.url === '/repos/sasjs/app/releases/tags/v1.8.0')
      return { json: { id: 7, upload_url: `${base}/upload{?name,label}` } }
    return { json: { ok: true } }
  })
  t.after(() => replacement.stop())
  base = replacement.base

  const cwd = repo({ commits: ['feat: initial', 'feat: one'] })
  const asset = join(cwd, 'app.zip')
  writeFileSync(asset, 'zip')
  process.env.GH_TOKEN = 'token-123'

  const out = await runInParallel(cwd, '--host', 'github', '--release', '--api-url',
    replacement.base, '--repo', 'sasjs/app', '--asset', asset)

  assert.equal(created, 0, 'the release is found before a create is attempted')
  assert.match(out, /a release for this tag already exists: finishing it/)
  assert.ok(
    replacement.seen.some((r) => r.url.startsWith('/upload?name=app.zip')),
    'the asset is still attached to the release that was found'
  )
})

test('an asset already attached is not a failure either', async (t) => {
  let base = ''
  const replacement = await stub((request) => {
    if (request.url === '/repos/sasjs/app/releases')
      return { json: { id: 7, upload_url: `${base}/upload{?name,label}` } }
    if (request.url.startsWith('/upload'))
      return { status: 422, json: { message: 'already_exists' } }
    return { json: {} }
  })
  t.after(() => replacement.stop())
  base = replacement.base

  const cwd = repo({ commits: ['feat: initial', 'fix: one'] })
  const asset = join(cwd, 'app.zip')
  writeFileSync(asset, 'zip')

  const out = await runInParallel(cwd, '--host', 'github', '--release', '--api-url',
    replacement.base, '--repo', 'sasjs/app', '--asset', asset)

  assert.match(out, /app.zip is already attached/)
  assert.match(out, /released v1\.7\.2 on github/)
})

test('a prerelease is created as one, so it does not look like a final release', async (t) => {
  const replacement = await stub((request) =>
    request.url.includes('/releases/tags/')
      ? { status: 404, json: { message: 'Not Found' } }
      : { json: { id: 7, upload_url: 'x{?name,label}' } }
  )
  t.after(() => replacement.stop())
  const cwd = repo({ commits: ['feat: initial', 'feat: one'] })

  await runInParallel(cwd, '--host', 'github', '--release', '--prerelease', 'beta',
    '--api-url', replacement.base, '--repo', 'sasjs/app')

  const created = replacement.seen.find((r) => r.url === '/repos/sasjs/app/releases')
  const payload = JSON.parse(created.body)
  assert.equal(payload.tag_name, 'v1.8.0-beta.1')
  assert.equal(payload.prerelease, true)

  const stable = await stub((request) =>
    request.url.includes('/releases/tags/')
      ? { status: 404, json: { message: 'Not Found' } }
      : { json: { id: 7, upload_url: 'x{?name,label}' } }
  )
  t.after(() => stable.stop())
  await runInParallel(cwd, '--host', 'github', '--release', '--api-url',
    stable.base, '--repo', 'sasjs/app')
  const finals = stable.seen.find((r) => r.url === '/repos/sasjs/app/releases')
  assert.equal(JSON.parse(finals.body).prerelease, false)
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

test('the tag the host creates exists locally afterwards', async (t) => {
  // the API creates the tag, so the clone has none; anything running later in the
  // same job - stamping, checking the tag out for the build - reads the clone
  const stubServer = await stub((request) => {
    if (request.method === 'POST' && request.url === '/repos/sasjs/app/releases')
      return { status: 201, json: { id: 1, upload_url: 'http://x/upload{?name,label}' } }
    return { json: { ok: true } }
  })
  t.after(() => stubServer.stop())

  const cwd = repo({ commits: ['feat: initial', 'feat: one'] })
  process.env.GH_TOKEN = 'token-123'
  assert.deepEqual(git(cwd, 'tag', '--list').split('\n').filter(Boolean), ['v1.7.1'])

  await runInParallel(cwd, '--host', 'github', '--release', '--api-url', stubServer.base, '--repo', 'sasjs/app')

  const tags = git(cwd, 'tag', '--list').split('\n').filter(Boolean)
  assert.deepEqual(tags.sort(), ['v1.7.1', 'v1.8.0'])
})

test('--draft keeps the release out of sight until it is published', async (t) => {
  const draftStub = await stub((request) => {
    if (request.method === 'POST' && request.url === '/repos/sasjs/app/releases')
      return { status: 201, json: { id: 1, upload_url: 'http://x/upload{?name,label}' } }
    return { json: { ok: true } }
  })
  t.after(() => draftStub.stop())

  const cwd = repo({ commits: ['feat: initial', 'feat: one'] })
  process.env.GH_TOKEN = 'token-123'
  await runInParallel(cwd, '--host', 'github', '--release', '--draft',
    '--api-url', draftStub.base, '--repo', 'sasjs/app')

  const sent = draftStub.seen.find((r) => r.method === 'POST' && r.url === '/repos/sasjs/app/releases')
  assert.match(sent.body, /"draft":true/)
})

test('an unknown flag is refused rather than ignored', () => {
  // flag() is a lookup in argv, so a typo reads as false and the run quietly does
  // something else - `--draft` dropped to `--drafts` would publish a release
  // before its assets exist
  const cwd = repo({ commits: ['feat: initial', 'feat: one'] })
  const out = failure(cwd, '--host', 'github', '--drafts', '--dry-run')
  assert.match(out, /unknown flag --drafts/)
})

test('422 with nothing to find is a failure, not a finished release', async (t) => {
  // the re-runnability branch looks the release up; when the lookup finds nothing
  // the original refusal has to surface, or a run reports success having created
  // nothing
  const replacement = await stub((request) =>
    request.url.endsWith('/releases')
      ? { status: 422, json: { message: 'Validation Failed' } }
      : { status: 404, json: { message: 'Not Found' } }
  )
  t.after(() => replacement.stop())
  const cwd = repo({ commits: ['feat: initial', 'feat: one'] })
  process.env.GH_TOKEN = 'token-123'

  const out = await failureInParallel(cwd, '--host', 'github', '--release',
    '--api-url', replacement.base, '--repo', 'sasjs/app')
  assert.match(out, /422/)
})

test('--help lists the flags, including the mode that is easy to forget', () => {
  const cwd = repo()
  const out = run(cwd, '--help')
  assert.match(out, /sasjs-release/)
  for (const flagName of ['--release', '--prepare-publish', '--draft', '--output'])
    assert.match(out, new RegExp(flagName))
})

test('a draft release is found by listing, because the by-tag endpoint hides it', async (t) => {
  // measured against the real API: GET /releases/tags/<tag> answers 404 for a
  // draft. A run that created a draft and died could then never finish it - 422 on
  // create, 404 on the lookup, and a draft nobody can attach to.
  let base = ''
  const replacement = await stub((request) => {
    if (request.method === 'POST' && request.url === '/repos/sasjs/app/releases')
      return { status: 422, json: { message: 'Validation Failed' } }
    if (request.url.startsWith('/repos/sasjs/app/releases/tags/'))
      return { status: 404, json: { message: 'Not Found' } }
    if (request.url.startsWith('/repos/sasjs/app/releases?per_page='))
      return {
        json: [
          { id: 9, tag_name: 'v1.7.2', draft: true, upload_url: `${base}/upload{?name,label}` }
        ]
      }
    return { json: { ok: true } }
  })
  t.after(() => replacement.stop())
  base = replacement.base

  const cwd = repo({ commits: ['feat: initial', 'fix: one'] })
  const asset = join(cwd, 'app.zip')
  writeFileSync(asset, 'zip')
  process.env.GH_TOKEN = 'token-123'

  const out = await runInParallel(cwd, '--host', 'github', '--release', '--draft',
    '--api-url', replacement.base, '--repo', 'sasjs/app', '--asset', asset)

  assert.match(out, /a release for this tag already exists: finishing it/)
  assert.ok(
    replacement.seen.some((r) => r.url.startsWith('/repos/sasjs/app/releases?per_page=')),
    'the list endpoint is what finds a draft'
  )
  assert.ok(
    replacement.seen.some((r) => r.url.startsWith('/upload?name=app.zip')),
    'and the asset still reaches the draft that was found'
  )
})

test('the newest tag wins when two name the same commit', () => {
  // the state a completed release leaves: the tag just cut sits on the same commit
  // as the one before it. `git describe` answers with the annotated one and the
  // next run recomputes a version that already exists - measured against a real
  // repository in the live check.
  const cwd = repo({ commits: ['feat: initial'] })
  git(cwd, 'tag', 'v1.8.0') // lightweight, the shape the forge creates
  writeFileSync(join(cwd, 'next'), 'x')
  git(cwd, 'add', '.')
  git(cwd, 'commit', '-m', 'feat: after both tags')
  assert.equal(versionOf(run(cwd, '--dry-run')), '1.9.0')
})

test('a tag on an unmerged branch is not the base', () => {
  const cwd = repo({ commits: ['feat: initial'] })
  git(cwd, 'checkout', '-q', '-b', 'side')
  writeFileSync(join(cwd, 'side'), 'x')
  git(cwd, 'add', '.')
  git(cwd, 'commit', '-m', 'feat: side work')
  git(cwd, 'tag', '-a', 'v9.0.0', '-m', 'v9.0.0')
  git(cwd, 'checkout', '-q', 'main')
  writeFileSync(join(cwd, 'main'), 'x')
  git(cwd, 'add', '.')
  git(cwd, 'commit', '-m', 'feat: on main')
  // v9.0.0 exists but is unreachable from main, so v1.7.1 is the base
  assert.equal(versionOf(run(cwd, '--dry-run')), '1.8.0')
})
