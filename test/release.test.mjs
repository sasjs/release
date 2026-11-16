import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
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

/** A project config, where SASjs keeps it: `sasjs/sasjsconfig.json`. */
function writeProjectConfig(cwd, config) {
  mkdirSync(join(cwd, 'sasjs'), { recursive: true })
  writeFileSync(join(cwd, 'sasjs', 'sasjsconfig.json'), JSON.stringify(config))
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

test('sasjsconfig.json\'s release block names the assets, with no flag at all', async (t) => {
  let base = ''
  const replacement = await stub((request) =>
    request.url.startsWith('/repos/')
      ? { json: { upload_url: `${base}/upload{?name,label}` } }
      : { json: { ok: true } }
  )
  t.after(() => replacement.stop())
  base = replacement.base

  const cwd = repo({ commits: ['feat: initial', 'feat: one'] })
  writeFileSync(join(cwd, 'server.json.zip'), 'zip')
  writeProjectConfig(cwd, {
    defaultTarget: 'server',
    targets: [],
    release: {
      assets: [{ path: 'server.json.zip', label: 'SASjs Streamed App' }]
    }
  })
  process.env.GH_TOKEN = 'token-123'

  await runInParallel(cwd, '--tag', '--host', 'github', '--release', '--api-url',
    replacement.base, '--repo', 'sasjs/app')

  // one config file for the project: the release list lives beside the build
  const upload = replacement.seen.find((r) => r.url.startsWith('/upload?name=server.json.zip'))

  assert.ok(upload)
  assert.match(upload.url, /label=SASjs%20Streamed%20App/)
})

test('a sasjsconfig with no release block falls through to the .releaserc beside it', async (t) => {
  let base = ''
  const replacement = await stub((request) =>
    request.url.startsWith('/repos/')
      ? { json: { upload_url: `${base}/upload{?name,label}` } }
      : { json: { ok: true } }
  )
  t.after(() => replacement.stop())
  base = replacement.base

  const cwd = repo({ commits: ['feat: initial', 'feat: one'] })
  writeFileSync(join(cwd, 'server.json.zip'), 'zip')
  writeProjectConfig(cwd, { targets: [] })
  writeFileSync(
    join(cwd, '.releaserc'),
    JSON.stringify({ plugins: [['@sasjs/release', { assets: ['server.json.zip'] }]] })
  )
  process.env.GH_TOKEN = 'token-123'

  await runInParallel(cwd, '--tag', '--host', 'github', '--release', '--api-url',
    replacement.base, '--repo', 'sasjs/app')

  // a project config that says nothing about assets is not an answer, and does not
  // stop the file the list came from being read
  assert.ok(
    replacement.seen.find((r) => r.url.startsWith('/upload?name=server.json.zip'))
  )
})

test('--config wins over both', async (t) => {
  let base = ''
  const replacement = await stub((request) =>
    request.url.startsWith('/repos/')
      ? { json: { upload_url: `${base}/upload{?name,label}` } }
      : { json: { ok: true } }
  )
  t.after(() => replacement.stop())
  base = replacement.base

  const cwd = repo({ commits: ['feat: initial', 'feat: one'] })
  writeFileSync(join(cwd, 'in-config.json'), 'in')
  writeFileSync(join(cwd, 'in-file.json'), 'in')
  writeProjectConfig(cwd, { release: { assets: ['in-config.json'] } })
  writeFileSync(join(cwd, 'other.json'), JSON.stringify(['in-file.json']))
  process.env.GH_TOKEN = 'token-123'

  await runInParallel(cwd, '--tag', '--host', 'github', '--release', '--api-url',
    replacement.base, '--repo', 'sasjs/app', '--config', 'other.json')

  assert.ok(replacement.seen.find((r) => r.url.startsWith('/upload?name=in-file.json')))
  assert.equal(
    replacement.seen.filter((r) => r.url.startsWith('/upload?name=in-config.json')).length,
    0
  )
})

test('the repository\'s .releaserc names the assets, with their labels', async (t) => {
  let base = ''
  const replacement = await stub((request) =>
    request.url.startsWith('/repos/')
      ? { json: { upload_url: `${base}/upload{?name,label}` } }
      : { json: { ok: true } }
  )
  t.after(() => replacement.stop())
  base = replacement.base

  const cwd = repo({ commits: ['feat: initial', 'feat: one'] })
  writeFileSync(join(cwd, 'server.json.zip'), 'zip')
  writeFileSync(join(cwd, 'sas9.sas'), 'sas')
  writeFileSync(
    join(cwd, '.releaserc'),
    JSON.stringify({
      plugins: [
        '@semantic-release/commit-analyzer',
        [
          '@sasjs/release',
          {
            assets: [
              { path: 'server.json.zip', label: 'SASjs Streamed App' },
              { path: 'sas9.sas', label: 'SAS 9 EBI Deployment Program' }
            ]
          }
        ]
      ]
    })
  )
  process.env.GH_TOKEN = 'token-123'

  // no flag: the file the repository already has is the config
  await runInParallel(cwd, '--tag', '--host', 'github', '--release', '--api-url',
    replacement.base, '--repo', 'sasjs/app')

  const app = replacement.seen.find((r) => r.url.startsWith('/upload?name=server.json.zip'))
  const sas9 = replacement.seen.find((r) => r.url.startsWith('/upload?name=sas9.sas'))

  assert.ok(app, 'server.json.zip is attached')
  assert.match(app.url, /label=SASjs%20Streamed%20App/)
  assert.ok(sas9, 'sas9.sas is attached')
  assert.match(sas9.url, /label=SAS%209%20EBI%20Deployment%20Program/)
})

test('an entry still named for semantic-release is read, and the run says to rename it', async (t) => {
  let base = ''
  const replacement = await stub((request) =>
    request.url.startsWith('/repos/')
      ? { json: { upload_url: `${base}/upload{?name,label}` } }
      : { json: { ok: true } }
  )
  t.after(() => replacement.stop())
  base = replacement.base

  const cwd = repo({ commits: ['feat: initial', 'feat: one'] })
  writeFileSync(join(cwd, 'server.json.zip'), 'zip')
  writeFileSync(
    join(cwd, '.releaserc'),
    JSON.stringify({
      plugins: [['@semantic-release/github', { assets: ['server.json.zip'] }]]
    })
  )
  process.env.GH_TOKEN = 'token-123'

  const stdout = await runInParallel(cwd, '--tag', '--host', 'github', '--release',
    '--api-url', replacement.base, '--repo', 'sasjs/app')

  const upload = replacement.seen.find((r) => r.url.startsWith('/upload?name=server.json.zip'))

  // reading the old name is the migration: the asset is attached, and the one
  // edit left to make is named in the output
  assert.ok(upload)
  assert.match(stdout, /rename that entry to @sasjs\/release/)
})

test('--config names the file, which may be a bare array of paths', async (t) => {
  let base = ''
  const replacement = await stub((request) =>
    request.url.startsWith('/repos/')
      ? { json: { upload_url: `${base}/upload{?name,label}` } }
      : { json: { ok: true } }
  )
  t.after(() => replacement.stop())
  base = replacement.base

  const cwd = repo({ commits: ['feat: initial', 'feat: one'] })
  writeFileSync(join(cwd, 'app.zip'), 'zip')
  writeFileSync(join(cwd, 'assets.json'), JSON.stringify(['app.zip']))
  process.env.GH_TOKEN = 'token-123'

  await runInParallel(cwd, '--tag', '--host', 'github', '--release', '--api-url',
    replacement.base, '--repo', 'sasjs/app', '--config', 'assets.json')

  const upload = replacement.seen.find((r) => r.url.startsWith('/upload?name=app.zip'))

  assert.ok(upload)
  assert.doesNotMatch(upload.url, /label=/)
})

test('a config entry publishes under the name it gives, not the file name', async (t) => {
  let base = ''
  const replacement = await stub((request) =>
    request.url.startsWith('/repos/')
      ? { json: { upload_url: `${base}/upload{?name,label}` } }
      : { json: { ok: true } }
  )
  t.after(() => replacement.stop())
  base = replacement.base

  const cwd = repo({ commits: ['feat: initial', 'feat: one'] })
  mkdirSync(join(cwd, 'sasjsbuild'), { recursive: true })
  writeFileSync(join(cwd, 'sasjsbuild', 'server.json.zip'), 'zip')
  writeProjectConfig(cwd, {
    release: {
      assets: [
        {
          path: 'sasjsbuild/server.json.zip',
          name: 'macro-dash-server.json.zip',
          label: 'SASjs Server App'
        }
      ]
    }
  })
  process.env.GH_TOKEN = 'token-123'

  await runInParallel(cwd, '--tag', '--host', 'github', '--release', '--api-url',
    replacement.base, '--repo', 'sasjs/app')

  // the download URL is the asset name, so a build output named after its target
  // is published under the name a page already links to
  const upload = replacement.seen.find((r) => r.url.startsWith('/upload?name='))

  assert.ok(upload)
  assert.match(upload.url, /name=macro-dash-server\.json\.zip/)
  assert.match(upload.url, /label=SASjs%20Server%20App/)
})

test('an asset name that is a path is refused', () => {
  const cwd = repo({ commits: ['feat: initial', 'feat: one'] })
  writeFileSync(join(cwd, 'server.json.zip'), 'zip')
  writeProjectConfig(cwd, {
    release: { assets: [{ path: 'server.json.zip', name: 'sub/server.zip' }] }
  })

  const message = failure(cwd, '--host', 'github', '--release')

  assert.match(message, /an asset name is a file name/)
})

test('--attach uploads the configured assets to a release that already exists', async (t) => {
  let base = ''
  const replacement = await stub((request) => {
    if (request.url.startsWith('/repos/') && request.url.includes('/releases/tags/'))
      return { json: { upload_url: `${base}/upload{?name,label}`, tag_name: 'v1.8.0' } }
    return { json: { ok: true } }
  })
  t.after(() => replacement.stop())
  base = replacement.base

  const cwd = repo({ commits: ['feat: initial', 'feat: one'] })
  mkdirSync(join(cwd, 'artefacts'), { recursive: true })
  writeFileSync(join(cwd, 'artefacts', 'server.json.zip'), 'zip')
  writeProjectConfig(cwd, {
    release: {
      assets: [
        {
          path: 'artefacts/server.json.zip',
          name: 'macro-dash-server.json.zip',
          label: 'SASjs Server App'
        }
      ]
    }
  })
  process.env.GH_TOKEN = 'token-123'

  await runInParallel(
    cwd, '--attach', 'v1.8.0', '--host', 'github', '--api-url', replacement.base,
    '--repo', 'sasjs/app'
  )

  // the artefacts of a release are built after the tag, with the version stamped
  // into them, so attaching is a run of its own
  const upload = replacement.seen.find((r) => r.url.startsWith('/upload?name='))

  assert.ok(upload)
  assert.match(upload.url, /name=macro-dash-server\.json\.zip/)
  // and it cuts nothing: no tag is made or asked for
  assert.equal(git(cwd, 'tag').trim(), 'v1.7.1')
})

test('--attach with no release for the tag is refused, naming it', async (t) => {
  const replacement = await stub(() => ({ status: 404, json: { message: 'Not Found' } }))
  t.after(() => replacement.stop())

  const cwd = repo({ commits: ['feat: initial', 'feat: one'] })
  writeFileSync(join(cwd, 'server.json.zip'), 'zip')
  process.env.GH_TOKEN = 'token-123'

  const message = await failureInParallel(
    cwd, '--attach', 'v9.9.9', '--host', 'github', '--api-url', replacement.base,
    '--repo', 'sasjs/app', '--asset', 'server.json.zip'
  )

  assert.match(message, /no release for v9\.9\.9 in sasjs\/app/)
})

test('gitea: --attach posts the asset to the release for the tag', async (t) => {
  const replacement = await stub(() => ({ json: { id: 42 } }))
  t.after(() => replacement.stop())

  const cwd = repo({ commits: ['feat: initial', 'feat: one'] })
  writeFileSync(join(cwd, 'frontend.zip'), 'zip')
  process.env.GITEA_TOKEN = 'gitea-token'

  await runInParallel(cwd, '--attach', 'v1.8.0', '--host', 'gitea', '--api-url',
    replacement.base, '--repo', 'dc/dc', '--asset', 'frontend.zip')

  const looked = replacement.seen.find((r) => r.url === '/repos/dc/dc/releases/tags/v1.8.0')
  assert.equal(looked.method, 'GET')
  const posted = replacement.seen.find((r) => r.url.startsWith('/repos/dc/dc/releases/42/assets'))
  assert.match(posted.url, /name=frontend\.zip/)
  assert.equal(posted.auth, 'token gitea-token')
})

test('gitea: --attach says so when the tag has no release', async (t) => {
  const replacement = await stub(() => ({ status: 404, json: { message: 'Not Found' } }))
  t.after(() => replacement.stop())

  const cwd = repo({ commits: ['feat: initial', 'feat: one'] })
  writeFileSync(join(cwd, 'frontend.zip'), 'zip')
  process.env.GITEA_TOKEN = 'gitea-token'

  const message = await failureInParallel(
    cwd, '--attach', 'v9.9.9', '--host', 'gitea', '--api-url', replacement.base,
    '--repo', 'dc/dc', '--asset', 'frontend.zip'
  )

  assert.match(message, /no release for v9\.9\.9 in dc\/dc/)
})

test('gitlab: --attach is refused, since it has no upload to attach with', async (t) => {
  const replacement = await stub(() => ({ json: {} }))
  t.after(() => replacement.stop())

  const cwd = repo({ commits: ['feat: initial', 'feat: one'] })
  writeFileSync(join(cwd, 'frontend.zip'), 'zip')
  process.env.GITLAB_TOKEN = 'gitlab-token'

  const message = await failureInParallel(
    cwd, '--attach', 'v1.8.0', '--host', 'gitlab', '--api-url', replacement.base,
    '--repo', 'grp/app', '--asset', 'frontend.zip'
  )

  assert.match(message, /gitlab has no asset upload/)
})

test('--attach does not read a failed lookup as "no such release"', async (t) => {
  // a token without access answers 404 as readily as a missing tag, and treating a
  // server error as an answer would report a tag that has a release as having none
  const replacement = await stub((request) =>
    request.url.includes('/releases/tags/')
      ? { status: 404, json: { message: 'Not Found' } }
      : { status: 500, json: { message: 'boom' } }
  )
  t.after(() => replacement.stop())

  const cwd = repo({ commits: ['feat: initial', 'feat: one'] })
  writeFileSync(join(cwd, 'server.json.zip'), 'zip')
  process.env.GH_TOKEN = 'token-123'

  const message = await failureInParallel(
    cwd, '--attach', 'v1.8.0', '--host', 'github', '--api-url', replacement.base,
    '--repo', 'sasjs/app', '--asset', 'server.json.zip'
  )

  assert.match(message, /500/)
  assert.doesNotMatch(message, /no release for/)
})

test('--attach reports a failed tag lookup too, without dressing it as absence', async (t) => {
  const replacement = await stub(() => ({ status: 500, json: { message: 'boom' } }))
  t.after(() => replacement.stop())

  const cwd = repo({ commits: ['feat: initial', 'feat: one'] })
  writeFileSync(join(cwd, 'server.json.zip'), 'zip')
  process.env.GH_TOKEN = 'token-123'

  const message = await failureInParallel(
    cwd, '--attach', 'v1.8.0', '--host', 'github', '--api-url', replacement.base,
    '--repo', 'sasjs/app', '--asset', 'server.json.zip'
  )

  assert.match(message, /500/)
  assert.doesNotMatch(message, /no release for/)
})

test('gitea: --attach reports a failed lookup rather than a missing release', async (t) => {
  const replacement = await stub(() => ({ status: 500, json: { message: 'boom' } }))
  t.after(() => replacement.stop())

  const cwd = repo({ commits: ['feat: initial', 'feat: one'] })
  writeFileSync(join(cwd, 'frontend.zip'), 'zip')
  process.env.GITEA_TOKEN = 'gitea-token'

  const message = await failureInParallel(
    cwd, '--attach', 'v1.8.0', '--host', 'gitea', '--api-url', replacement.base,
    '--repo', 'dc/dc', '--asset', 'frontend.zip'
  )

  assert.match(message, /500/)
  assert.doesNotMatch(message, /no release for/)
})

test('--attach publishes a draft once every file is on it', async (t) => {
  let base = ''
  const replacement = await stub((request) => {
    if (request.url.includes('/releases/tags/'))
      return { json: { id: 9, draft: true, tag_name: 'v1.8.0', upload_url: `${base}/upload{?name,label}` } }
    return { json: { ok: true } }
  })
  t.after(() => replacement.stop())
  base = replacement.base

  const cwd = repo({ commits: ['feat: initial', 'feat: one'] })
  writeFileSync(join(cwd, 'server.json.zip'), 'zip')
  process.env.GH_TOKEN = 'token-123'

  await runInParallel(cwd, '--attach', 'v1.8.0', '--host', 'github', '--api-url',
    replacement.base, '--repo', 'sasjs/app', '--asset', 'server.json.zip')

  // a drafted release is invisible, which is what keeps releases/latest/download
  // from answering 404 while the artefacts are built - so attaching publishes it
  const patched = replacement.seen.find((r) => r.method === 'PATCH' && r.url === '/repos/sasjs/app/releases/9')

  assert.ok(patched)
  assert.equal(JSON.parse(patched.body).draft, false)
})

test('--keep-draft leaves a drafted release alone', async (t) => {
  let base = ''
  const replacement = await stub((request) => {
    if (request.url.includes('/releases/tags/'))
      return { json: { id: 9, draft: true, tag_name: 'v1.8.0', upload_url: `${base}/upload{?name,label}` } }
    return { json: { ok: true } }
  })
  t.after(() => replacement.stop())
  base = replacement.base

  const cwd = repo({ commits: ['feat: initial', 'feat: one'] })
  writeFileSync(join(cwd, 'server.json.zip'), 'zip')
  process.env.GH_TOKEN = 'token-123'

  await runInParallel(cwd, '--attach', 'v1.8.0', '--host', 'github', '--api-url',
    replacement.base, '--repo', 'sasjs/app', '--asset', 'server.json.zip', '--keep-draft')

  assert.equal(replacement.seen.filter((r) => r.method === 'PATCH').length, 0)
})

test('--attach with nothing to attach is refused', () => {
  const cwd = repo({ commits: ['feat: initial', 'feat: one'] })
  process.env.GH_TOKEN = 'token-123'

  const message = failure(cwd, '--attach', 'v1.8.0', '--host', 'github', '--repo', 'sasjs/app')

  assert.match(message, /--attach names no assets/)
})

test('--attach --dry-run names the files and sends nothing', async (t) => {
  const replacement = await stub(() => ({ json: { ok: true } }))
  t.after(() => replacement.stop())

  const cwd = repo({ commits: ['feat: initial', 'feat: one'] })
  writeFileSync(join(cwd, 'server.json.zip'), 'zip')
  process.env.GH_TOKEN = 'token-123'

  const out = run(
    cwd, '--attach', 'v1.8.0', '--host', 'github', '--api-url', replacement.base,
    '--repo', 'sasjs/app', '--asset', 'server.json.zip', '--dry-run'
  )

  assert.match(out, /would attach server\.json\.zip to v1\.8\.0/)
  assert.equal(replacement.seen.filter((r) => r.url.startsWith('/upload')).length, 0)
})

test('a sasjsconfig that will not parse is a file with no release block', async (t) => {
  let base = ''
  const replacement = await stub((request) =>
    request.url.startsWith('/repos/')
      ? { json: { upload_url: `${base}/upload{?name,label}` } }
      : { json: { ok: true } }
  )
  t.after(() => replacement.stop())
  base = replacement.base

  const cwd = repo({ commits: ['feat: initial', 'feat: one'] })
  mkdirSync(join(cwd, 'sasjs'), { recursive: true })
  writeFileSync(join(cwd, 'sasjs', 'sasjsconfig.json'), '{ not json')
  process.env.GH_TOKEN = 'token-123'

  await runInParallel(cwd, '--tag', '--host', 'github', '--release', '--api-url',
    replacement.base, '--repo', 'sasjs/app')

  // discovery asks whether it names assets; a file it cannot read is not a reason
  // to fail a release that asked for none
  assert.equal(replacement.seen.filter((r) => r.url.startsWith('/upload')).length, 0)
})

test('a config the caller named that will not parse is refused, quoting it', () => {
  const cwd = repo({ commits: ['feat: initial', 'feat: one'] })
  writeFileSync(join(cwd, 'broken.json'), '{ not json')

  const message = failure(cwd, '--host', 'github', '--release', '--config', 'broken.json')

  assert.match(message, /broken\.json could not be read/)
})

test('an upload that fails for another reason is not swallowed', async (t) => {
  const replacement = await stub((request) =>
    request.url.startsWith('/repos/')
      ? { json: { upload_url: `${request.headers.host ? `http://${request.headers.host}` : ''}/upload{?name,label}` } }
      : { status: 500, json: { message: 'boom' } }
  )
  t.after(() => replacement.stop())

  const cwd = repo({ commits: ['feat: initial', 'feat: one'] })
  writeFileSync(join(cwd, 'server.json.zip'), 'zip')
  process.env.GH_TOKEN = 'token-123'

  const message = await failureInParallel(
    cwd, '--tag', '--host', 'github', '--release', '--api-url', replacement.base,
    '--repo', 'sasjs/app', '--asset', 'server.json.zip'
  )

  // a 422 means the asset is attached already; a 500 means the release is not what
  // the run believes it is, and saying "already attached" would hide that
  assert.match(message, /500/)
  assert.doesNotMatch(message, /already attached/)
})

test('a prerelease continues the one before it', () => {
  const cwd = repo({ tag: 'v1.8.0-beta.1', commits: ['feat: initial', 'fix: one'] })

  const out = run(cwd, '--prerelease', 'beta', '--dry-run')

  // beta.2, not a second beta.1 and not 1.8.1-beta.1: the tag names a version that
  // has not shipped, so it moves along rather than being replaced
  assert.match(out, /v1\.8\.0-beta\.2/)
})

test('a prerelease that starts a new base names its first one', () => {
  const cwd = repo({ tag: 'v1.7.1', commits: ['feat: initial', 'feat: one'] })

  const out = run(cwd, '--prerelease', 'beta', '--dry-run')

  // the base moves because a feature landed, so this is the first prerelease of it
  assert.match(out, /v1\.8\.0-beta\.1/)
})

test('a create that is refused, with the lookup after it failing, reports the refusal', async (t) => {
  let calls = 0
  const replacement = await stub((request) => {
    if (request.method === 'POST' && request.url === '/repos/sasjs/app/releases')
      return { status: 422, json: { message: 'already_exists' } }
    calls += 1
    // both lookups fail: the first is tolerated, the second must not turn the
    // refusal to create into a 404 from a lookup
    return { status: 500, json: { message: 'boom' } }
  })
  t.after(() => replacement.stop())

  const cwd = repo({ commits: ['feat: initial', 'feat: one'] })
  process.env.GH_TOKEN = 'token-123'

  const message = await failureInParallel(
    cwd, '--tag', '--host', 'github', '--release', '--api-url', replacement.base,
    '--repo', 'sasjs/app'
  )

  assert.match(message, /already_exists|422/)
  assert.ok(calls >= 1)
})

test('a config that names no assets is refused, with the shapes it accepts', () => {
  const cwd = repo({ commits: ['feat: initial', 'feat: one'] })
  writeFileSync(join(cwd, 'empty.json'), JSON.stringify({ plugins: [] }))

  const message = failure(cwd, '--host', 'github', '--release', '--config', 'empty.json')

  assert.match(message, /names no assets/)
  assert.match(message, /@sasjs\/release/)
})

test('--no-assets cuts the release with files that do not exist yet', async (t) => {
  let base = ''
  const replacement = await stub((request) =>
    request.url.startsWith('/repos/') && request.method === 'POST'
      ? { json: { id: 7, upload_url: `${base}/upload{?name,label}`, tag_name: 'v1.8.0' } }
      : { status: 404, json: { message: 'Not Found' } }
  )
  t.after(() => replacement.stop())
  base = replacement.base

  const cwd = repo({ commits: ['feat: initial', 'fix: one'] })
  // the artefacts are built from the tag, so at cut time they are not on disk
  writeProjectConfig(cwd, { release: { assets: ['sasjsrelease/viya/viya.sas'] } })
  process.env.GH_TOKEN = 'token-123'

  const out = await runInParallel(
    cwd, '--tag', '--host', 'github', '--release', '--no-assets', '--api-url',
    replacement.base, '--repo', 'sasjs/app'
  )

  // the release exists and nothing was attached: --attach is the run that uploads
  assert.match(out, /--no-assets: publishing the release with no files/)
  assert.equal(replacement.seen.filter((r) => r.url.startsWith('/upload')).length, 0)
})

test('without --no-assets the same config still refuses before the tag', () => {
  const cwd = repo({ commits: ['feat: initial', 'feat: one'] })
  writeProjectConfig(cwd, { release: { assets: ['sasjsrelease/viya/viya.sas'] } })

  const message = failure(cwd, '--tag', '--host', 'github', '--release')

  assert.match(message, /names a file that is not there/)
  assert.equal(git(cwd, 'tag').trim(), 'v1.7.1')
})

test('a config naming a file that is not there tags nothing', () => {
  const cwd = repo({ commits: ['feat: initial', 'feat: one'] })
  writeProjectConfig(cwd, { release: { assets: ['missing.zip'] } })

  const message = failure(
    cwd, '--tag', '--push-tag', '--host', 'github', '--release'
  )

  // named where it came from: the config, not a flag the caller never passed
  assert.match(message, /sasjs\/sasjsconfig\.json names a file that is not there: missing\.zip/)
  // and refused before the tag exists, so there is nothing to explain afterwards
  assert.equal(git(cwd, 'tag').trim(), 'v1.7.1')
})

test('a dry run reports the same mistake without tagging', () => {
  const cwd = repo({ commits: ['feat: initial', 'feat: one'] })
  writeProjectConfig(cwd, { release: { assets: ['missing.zip'] } })

  const message = failure(cwd, '--host', 'github', '--release', '--dry-run')

  assert.match(message, /names a file that is not there/)
  assert.equal(git(cwd, 'tag').trim(), 'v1.7.1')
})

test('a discovered .releaserc naming no assets releases without them', async (t) => {
  let base = ''
  const replacement = await stub((request) =>
    request.url.startsWith('/repos/')
      ? { json: { upload_url: `${base}/upload{?name,label}` } }
      : { json: { ok: true } }
  )
  t.after(() => replacement.stop())
  base = replacement.base

  const cwd = repo({ commits: ['feat: initial', 'feat: one'] })
  // semantic-release's own file, for its own plugins, with no assets entry
  writeFileSync(
    join(cwd, '.releaserc'),
    JSON.stringify({ plugins: ['@semantic-release/commit-analyzer', '@semantic-release/npm'] })
  )
  process.env.GH_TOKEN = 'token-123'

  await runInParallel(cwd, '--tag', '--host', 'github', '--release', '--api-url',
    replacement.base, '--repo', 'sasjs/app')

  // found by convention is not the same as named: it says nothing about assets, so
  // the release goes ahead with nothing attached rather than failing a flag nobody
  // passed
  assert.equal(replacement.seen.filter((r) => r.url.startsWith('/upload')).length, 0)
})

test('a config with no assets is not invented from a file that has none', async (t) => {
  let base = ''
  const replacement = await stub((request) =>
    request.url.startsWith('/repos/')
      ? { json: { upload_url: `${base}/upload{?name,label}` } }
      : { json: { ok: true } }
  )
  t.after(() => replacement.stop())
  base = replacement.base

  const cwd = repo({ commits: ['feat: initial', 'feat: one'] })
  writeFileSync(join(cwd, 'app.zip'), 'zip')
  process.env.GH_TOKEN = 'token-123'

  // no config anywhere: the release is made with nothing attached, which is what
  // a repository that only uses --asset has always had
  await runInParallel(cwd, '--tag', '--host', 'github', '--release', '--api-url',
    replacement.base, '--repo', 'sasjs/app')

  assert.equal(replacement.seen.filter((r) => r.url.startsWith('/upload')).length, 0)
})

test('a file that is not there is refused before the release is created', () => {
  const cwd = repo({ commits: ['feat: initial', 'feat: one'] })
  writeFileSync(join(cwd, 'assets.json'), JSON.stringify(['missing.zip']))

  const message = failure(cwd, '--host', 'github', '--release', '--config', 'assets.json')

  assert.match(message, /not there: missing\.zip/)
})

test('gitlab refuses assets rather than releasing without them', () => {
  const cwd = repo({ commits: ['feat: initial', 'feat: one'] })
  writeFileSync(join(cwd, 'app.zip'), 'zip')
  process.env.GITLAB_TOKEN = 'token-123'

  const message = failure(cwd, '--host', 'gitlab', '--release', '--asset', 'app.zip')

  assert.match(message, /gitlab has no asset upload/)
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
