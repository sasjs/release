import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

// scripts/mutate.mjs runs this suite against a deliberately broken copy, so the
// entry point is overridable; everything else runs the real one.
const CLI =
  process.env.SASJS_RELEASE_ENTRY || fileURLToPath(new URL('../release.mjs', import.meta.url))

// a CI runner sets these, and the tool reads them to decide where it is: cleared so a
// case can opt in rather than inherit the build's own forge
const CI_VARS = ['GITHUB_ACTIONS', 'GITHUB_SERVER_URL', 'GITHUB_REPOSITORY', 'GITLAB_CI', 'CI_API_V4_URL']

const envelope = {
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  // empty rather than deleted: execFile casts every value to a string, so an
  // undefined would arrive as the word "undefined" and read as set
  ...Object.fromEntries(CI_VARS.map((name) => [name, '']))
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
  // what a real host holds after an upload: an asset under the name in the query,
  // as long as the bytes it was sent. A raw-body upload IS the file, so its length
  // is the asset's size - which is what the read-back compares.
  const held = new Map()

  const server = http.createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const body = Buffer.concat(chunks)

      seen.push({
        method: request.method,
        url: request.url,
        auth: request.headers.authorization,
        privateToken: request.headers['private-token'],
        jobToken: request.headers['job-token'],
        apiVersion: request.headers['x-github-api-version'],
        type: request.headers['content-type'],
        body: body.toString()
      })

      if (
        request.method === 'POST' &&
        /^\/upload\?name=/.test(request.url) &&
        request.headers['content-type'] === 'application/octet-stream'
      )
        held.set(decodeURIComponent(request.url.slice('/upload?name='.length).split('&')[0]), body.length)

      // a release read answers with what this host was sent, the way a real one
      // does - unless the test says what it holds, which is how a host that
      // stored something other than the file is simulated
      const releaseRead =
        request.method === 'GET' &&
        /\/releases\/(?!tags\/)[^/]+$/.test(request.url) &&
        !/\/assets$/.test(request.url)

      const answered = respond(request) || {}

      const holdsNothing = !('assets' in (answered.json || {}))

      const { status = 200, json = {}, headers = {} } =
        releaseRead && held.size && holdsNothing
          ? {
              json: {
                id: 1,
                assets: [...held].map(([name, size]) => ({ name, size }))
              }
            }
          : answered

      // no keep-alive: the suite has to end when the last test does, and a
      // socket left open by a client makes node:test wait for it
      response.writeHead(status, {
        'content-type': 'application/json',
        connection: 'close',
        ...headers
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
  // GitHub reads the asset itself as the request body. A multipart body is stored
  // verbatim, which is how a release came to carry files beginning
  // `------formdata-undici-...` instead of the builds they were named for.
  assert.match(upload.type, /^application\/octet-stream/)
  assert.equal(upload.body, 'zip')
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
      return { json: { id: 9, upload_url: `${base}/upload{?name,label}`, tag_name: 'v1.8.0' } }
    if (request.method === 'GET' && request.url === '/repos/sasjs/app/releases/9')
      return { json: { id: 9, assets: [{ name: 'macro-dash-server.json.zip' }] } }
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
  assert.equal(upload.apiVersion, undefined)
  assert.match(upload.url, /name=macro-dash-server\.json\.zip/)
  // and it cuts nothing: no tag is made or asked for
  assert.equal(git(cwd, 'tag').trim(), 'v1.7.1')
})

test('--attach refuses a release that holds the right name at the wrong size', async (t) => {
  // what a host stores when it was sent the envelope rather than the file: the
  // asset is listed under the build's name, at the envelope's length - so the
  // name check passes and every download of the build is corrupt
  let base = ''
  const replacement = await stub((request) => {
    if (request.url.startsWith('/repos/') && request.url.includes('/releases/tags/'))
      return { json: { id: 9, upload_url: `${base}/upload{?name,label}`, tag_name: 'v1.8.0' } }
    if (request.method === 'GET' && request.url === '/repos/sasjs/app/releases/9')
      return { json: { id: 9, assets: [{ name: 'server.json.zip', size: 63_850 }] } }
    return { json: { ok: true } }
  })
  t.after(() => replacement.stop())
  base = replacement.base

  const cwd = repo({ commits: ['feat: initial', 'feat: one'] })
  writeFileSync(join(cwd, 'server.json.zip'), 'zip')
  process.env.GH_TOKEN = 'token-123'

  const message = await failureInParallel(
    cwd, '--attach', 'v1.8.0', '--host', 'github', '--api-url', replacement.base,
    '--repo', 'sasjs/app', '--asset', 'server.json.zip'
  )

  assert.match(message, /holds "server\.json\.zip" at 63850 bytes, where the file is 3 bytes/)
  assert.match(message, /stored something other than the build/)
})

test('a cut refuses a release that stored something other than the build', async (t) => {
  // the cut is the path that published such releases: every upload answered 201,
  // and nothing read the release back afterwards
  let base = ''
  const replacement = await stub((request) => {
    if (request.method === 'POST' && request.url === '/repos/sasjs/app/releases')
      return { json: { id: 7, upload_url: `${base}/upload{?name,label}` } }
    if (request.method === 'GET' && request.url === '/repos/sasjs/app/releases/7')
      return { json: { id: 7, assets: [{ name: 'app.zip', size: 412 }] } }
    return { json: { ok: true } }
  })
  t.after(() => replacement.stop())
  base = replacement.base

  const cwd = repo({ commits: ['feat: initial', 'feat: one'] })
  const asset = join(cwd, 'app.zip')
  writeFileSync(asset, 'zip')
  process.env.GH_TOKEN = 'token-123'

  const message = await failureInParallel(
    cwd, '--tag', '--host', 'github', '--release', '--api-url', replacement.base,
    '--repo', 'sasjs/app', '--asset', asset
  )

  assert.match(message, /holds "app\.zip" at 412 bytes, where the file is 3 bytes/)
})

test('verified attach refuses to upload when release identity changed after listing', async (t) => {
  let base = ''
  const replacement = await stub((request) => {
    if (request.url === '/repos/sasjs/app/releases?per_page=100&page=1')
      return { json: [{ id: 9, draft: true, tag_name: 'v1.8.0', upload_url: `${base}/repos/sasjs/app/releases/9/assets{?name,label}` }] }
    if (request.url === '/repos/sasjs/app/releases/9') return { json: { id: 9, draft: true, tag_name: 'v2.0.0' } }
    if (request.url.startsWith('/repos/sasjs/app/releases/9/assets?')) return { json: [] }
    return { status: 500, json: {} }
  })
  t.after(() => replacement.stop())
  base = replacement.base
  const cwd = repo()
  writeFileSync(join(cwd, 'app.zip'), 'new')
  await assert.rejects(runInParallel(cwd, '--attach', 'v1.8.0', '--verify-assets', '--host', 'github',
    '--api-url', base, '--repo', 'sasjs/app', '--asset', 'app.zip'), /identity|status/)
  assert.deepEqual(replacement.seen.filter((r) => r.method !== 'GET').map((r) => r.method), [])
})

test('verified attach reports a changed identity even for an already published release', async (t) => {
  const digest = `sha256:${createHash('sha256').update('new').digest('hex')}`
  const replacement = await stub((request) => {
    if (request.url === '/repos/sasjs/app/releases?per_page=100&page=1')
      return { json: [{ id: 9, draft: false, tag_name: 'v1.8.0' }] }
    if (request.url === '/repos/sasjs/app/releases/9/assets?per_page=100&page=1')
      return { json: [{ name: 'app.zip', size: 3, state: 'uploaded', digest }] }
    if (request.url === '/repos/sasjs/app/releases/9') return { json: { id: 9, draft: false, tag_name: 'v2.0.0' } }
    return { status: 500, json: {} }
  })
  t.after(() => replacement.stop())
  const cwd = repo()
  writeFileSync(join(cwd, 'app.zip'), 'new')
  await assert.rejects(runInParallel(cwd, '--attach', 'v1.8.0', '--verify-assets', '--host', 'github',
    '--api-url', replacement.base, '--repo', 'sasjs/app', '--asset', 'app.zip'), /identity/)
  assert.deepEqual(replacement.seen.filter((r) => r.method !== 'GET').map((r) => r.method), [])
})

test('verified attach does not publish a release retagged after asset validation', async (t) => {
  let assetReads = 0
  const digest = `sha256:${createHash('sha256').update('new').digest('hex')}`
  const replacement = await stub((request) => {
    if (request.url === '/repos/sasjs/app/releases?per_page=100&page=1')
      return { json: [{ id: 9, draft: true, tag_name: 'v1.8.0' }] }
    if (request.url === '/repos/sasjs/app/releases/9/assets?per_page=100&page=1') {
      assetReads++
      return { json: [{ name: 'app.zip', size: 3, state: 'uploaded', digest }] }
    }
    if (request.url === '/repos/sasjs/app/releases/9')
      return { json: { id: 9, draft: request.method !== 'PATCH', tag_name: assetReads >= 2 ? 'v2.0.0' : 'v1.8.0' } }
    return { status: 500, json: {} }
  })
  t.after(() => replacement.stop())
  const cwd = repo()
  writeFileSync(join(cwd, 'app.zip'), 'new')
  await assert.rejects(runInParallel(cwd, '--attach', 'v1.8.0', '--verify-assets', '--host', 'github',
    '--api-url', replacement.base, '--repo', 'sasjs/app', '--asset', 'app.zip'))
  assert.deepEqual(replacement.seen.filter((r) => r.method !== 'GET').map((r) => r.method), [])
})

test('verified attach refuses an existing asset with different bytes of the same size', async (t) => {
  let base = ''
  const replacement = await stub((request) => {
    if (request.url === '/repos/sasjs/app/releases?per_page=100&page=1')
      return { json: [{ id: 9, draft: true, tag_name: 'v1.8.0', upload_url: `${base}/upload{?name,label}` }] }
    if (request.url.startsWith('/upload')) return { status: 422, json: { message: 'already_exists' } }
    if (request.url === '/repos/sasjs/app/releases/9/assets?per_page=100&page=1')
      return { json: [{ name: 'app.zip', size: 3, state: 'uploaded', digest: `sha256:${createHash('sha256').update('old').digest('hex')}` }] }
    if (request.url === '/repos/sasjs/app/releases/9')
      return { json: { id: 9, assets: [{ name: 'app.zip', size: 3 }] } }
    return { json: { ok: true } }
  })
  t.after(() => replacement.stop())
  base = replacement.base
  const cwd = repo()
  writeFileSync(join(cwd, 'app.zip'), 'new')
  process.env.GH_TOKEN = 'token-123'
  await assert.rejects(runInParallel(cwd, '--attach', 'v1.8.0', '--host', 'github',
    '--api-url', base, '--repo', 'sasjs/app', '--asset', 'app.zip', '--verify-assets'),
  /cannot verify|digest|different/i)
  assert.equal(replacement.seen.some((r) => r.method === 'PATCH'), false)
})

test('verified attach finds paginated drafts and assets and finalizes an identical existing asset', async (t) => {
  let base = ''
  const filler = Array.from({ length: 100 }, (_, i) => ({ id: i + 100, tag_name: `v0.0.${i}` }))
  const fillerAssets = Array.from({ length: 100 }, (_, i) => ({ name: `other-${i}` }))
  const replacement = await stub((request) => {
    if (request.url.includes('/releases/tags/')) return { status: 404, json: {} }
    if (request.url === '/repos/sasjs/app/releases?per_page=100&page=1') return { json: filler }
    if (request.url === '/repos/sasjs/app/releases?per_page=100&page=2')
      return { json: [{ id: 9, draft: true, tag_name: 'v1.8.0', upload_url: `${base}/upload{?name,label}` }] }
    if (request.url === '/repos/sasjs/app/releases/9/assets?per_page=100&page=1') return { json: fillerAssets }
    if (request.url === '/repos/sasjs/app/releases/9/assets?per_page=100&page=2')
      return { json: [{ name: 'app.zip', size: 3, state: 'uploaded', digest: `sha256:${createHash('sha256').update('new').digest('hex')}` }] }
    if (request.method === 'GET' && request.url === '/repos/sasjs/app/releases/9')
      return { json: { id: 9, draft: true, tag_name: 'v1.8.0' } }
    if (request.method === 'PATCH' && request.url === '/repos/sasjs/app/releases/9')
      return { json: { id: 9, draft: false, tag_name: 'v1.8.0' } }
    return { status: 500, json: { message: 'unexpected request' } }
  })
  t.after(() => replacement.stop())
  base = replacement.base
  const cwd = repo()
  writeFileSync(join(cwd, 'app.zip'), 'new')
  process.env.GH_TOKEN = 'token-123'
  await runInParallel(cwd, '--attach', 'v1.8.0', '--host', 'github', '--api-url', base,
    '--repo', 'sasjs/app', '--asset', 'app.zip', '--verify-assets', '--keep-draft')
  assert.equal(replacement.seen.some((r) => r.method === 'POST' || r.method === 'PATCH'), false)
  // The finalization is independent of npm's publish decision: rerun after npm
  // already contains the version and publish the verified draft without an upload.
  await runInParallel(cwd, '--attach', 'v1.8.0', '--host', 'github', '--api-url', base,
    '--repo', 'sasjs/app', '--asset', 'app.zip', '--verify-assets')
  assert.equal(replacement.seen.filter((r) => r.method === 'POST').length, 0)
  assert.equal(replacement.seen.filter((r) => r.method === 'PATCH').length, 1)
})

test('verified attach snapshots all files before uploading and uses the snapshotted bytes', async (t) => {
  let base = ''
  const cwd = repo()
  writeFileSync(join(cwd, 'a.zip'), 'aaa')
  writeFileSync(join(cwd, 'b.zip'), 'old')
  const assets = []
  const replacement = await stub((request) => {
    if (request.url === '/repos/sasjs/app/releases?per_page=100&page=1')
      return { json: [{ id: 9, draft: true, tag_name: 'v1.8.0', upload_url: `${base}/repos/sasjs/app/releases/9/assets{?name,label}` }] }
    if (request.method === 'GET' && request.url === '/repos/sasjs/app/releases/9/assets?per_page=100&page=1') return { json: assets }
    if (request.url === '/repos/sasjs/app/releases/9') return { json: { id: 9, draft: true, tag_name: 'v1.8.0' } }
    if (request.method === 'POST') {
      const name = new URL(request.url, base).searchParams.get('name')
      const body = replacement.seen.at(-1).body
      assets.push({ name, state: 'uploaded', size: Buffer.byteLength(body), digest: `sha256:${createHash('sha256').update(body).digest('hex')}` })
      if (name === 'a.zip') writeFileSync(join(cwd, 'b.zip'), 'new')
      return { json: {} }
    }
    return { status: 500, json: {} }
  })
  t.after(() => replacement.stop())
  base = replacement.base
  await runInParallel(cwd, '--attach', 'v1.8.0', '--verify-assets', '--keep-draft', '--host', 'github',
    '--api-url', base, '--repo', 'sasjs/app', '--asset', 'a.zip', '--asset', 'b.zip')
  assert.equal(replacement.seen.filter((r) => r.method === 'POST')[1].body, 'old')
})

test('verified attach reads all inputs before the first upload', async (t) => {
  let base = ''
  const replacement = await stub((request) => {
    if (request.url === '/repos/sasjs/app/releases?per_page=100&page=1')
      return { json: [{ id: 9, draft: true, tag_name: 'v1.8.0', upload_url: `${base}/repos/sasjs/app/releases/9/assets{?name,label}` }] }
    return { json: [] }
  })
  t.after(() => replacement.stop())
  base = replacement.base
  const cwd = repo()
  writeFileSync(join(cwd, 'a.zip'), 'aaa')
  mkdirSync(join(cwd, 'b.zip'))
  await assert.rejects(runInParallel(cwd, '--attach', 'v1.8.0', '--verify-assets', '--host', 'github',
    '--api-url', base, '--repo', 'sasjs/app', '--asset', 'a.zip', '--asset', 'b.zip'), /EISDIR/)
  assert.deepEqual(replacement.seen.filter((r) => r.method !== 'GET').map((r) => r.method), [])
})

test('verified attach checks every existing asset before uploading any missing asset', async (t) => {
  let base = ''
  const replacement = await stub((request) => {
    if (request.url === '/repos/sasjs/app/releases?per_page=100&page=1')
      return { json: [{ id: 9, draft: true, tag_name: 'v1.8.0', upload_url: `${base}/repos/sasjs/app/releases/9/assets{?name,label}` }] }
    if (request.url === '/repos/sasjs/app/releases/9/assets?per_page=100&page=1')
      return { json: [{ name: 'b.zip', size: 3, state: 'uploaded', digest: `sha256:${createHash('sha256').update('old').digest('hex')}` }] }
    return { json: {} }
  })
  t.after(() => replacement.stop())
  base = replacement.base
  const cwd = repo()
  writeFileSync(join(cwd, 'a.zip'), 'new')
  writeFileSync(join(cwd, 'b.zip'), 'new')
  await assert.rejects(runInParallel(cwd, '--attach', 'v1.8.0', '--verify-assets', '--host', 'github',
    '--api-url', base, '--repo', 'sasjs/app', '--asset', 'a.zip', '--asset', 'b.zip'), /cannot verify digest/)
  assert.deepEqual(replacement.seen.filter((r) => r.method !== 'GET').map((r) => r.method), [])
})

test('verified attach rejects upload URLs for a different repository or release', async (t) => {
  let base = ''
  let uploadPath = '/repos/sasjs/other/releases/9/assets'
  const replacement = await stub((request) => {
    if (request.url === '/repos/sasjs/app/releases?per_page=100&page=1')
      return { json: [{ id: 9, draft: true, tag_name: 'v1.8.0', upload_url: `${base}${uploadPath}{?name,label}` }] }
    if (request.url === '/repos/sasjs/app/releases/9/assets?per_page=100&page=1') return { json: [] }
    return { status: 500, json: {} }
  })
  t.after(() => replacement.stop())
  base = replacement.base
  const cwd = repo()
  writeFileSync(join(cwd, 'app.zip'), 'new')
  for (uploadPath of ['/repos/sasjs/other/releases/9/assets', '/repos/sasjs/app/releases/10/assets']) {
    await assert.rejects(runInParallel(cwd, '--attach', 'v1.8.0', '--verify-assets', '--host', 'github',
      '--api-url', base, '--repo', 'sasjs/app', '--asset', 'app.zip'))
  }
  assert.deepEqual(replacement.seen.filter((r) => r.method !== 'GET').map((r) => r.method), [])
})

test('verified attach uploads missing assets and publishes only after digest verification', async (t) => {
  let base = ''
  let uploaded = false
  const digest = `sha256:${createHash('sha256').update('new').digest('hex')}`
  const replacement = await stub((request) => {
    if (request.url === '/repos/sasjs/app/releases?per_page=100&page=1')
      return { json: [{ id: 9, draft: true, tag_name: 'v1.8.0', upload_url: `${base}/repos/sasjs/app/releases/9/assets{?name,label}` }] }
    if (request.url === '/repos/sasjs/app/releases/9/assets?per_page=100&page=1')
      return { json: uploaded ? [{ name: 'app.zip', size: 3, state: 'uploaded', digest }] : [] }
    if (request.method === 'POST' && request.url.startsWith('/repos/sasjs/app/releases/9/assets?')) { uploaded = true; return { json: {} } }
    if (request.method === 'GET' && request.url === '/repos/sasjs/app/releases/9')
      return { json: { id: 9, tag_name: 'v1.8.0', draft: true } }
    if (request.method === 'PATCH' && request.url === '/repos/sasjs/app/releases/9')
      return { json: { id: 9, tag_name: 'v1.8.0', draft: false } }
    return { status: 500, json: {} }
  })
  t.after(() => replacement.stop())
  base = replacement.base
  const cwd = repo()
  writeFileSync(join(cwd, 'app.zip'), 'new')
  process.env.GH_TOKEN = 'token-123'
  await runInParallel(cwd, '--attach', 'v1.8.0', '--verify-assets', '--host', 'github',
    '--api-url', base, '--repo', 'sasjs/app', '--asset', 'app.zip')
  assert.deepEqual(replacement.seen.filter((r) => r.method !== 'GET').map((r) => r.method), ['POST', 'PATCH'])
  assert.equal(replacement.seen.find((r) => r.method === 'POST').body, 'new')
  assert.ok(replacement.seen.length > 0)
  assert.ok(replacement.seen.every((r) => r.apiVersion === '2022-11-28'))
})

test('verified attach refuses dry-run rather than claiming unperformed verification', () => {
  const cwd = repo()
  writeFileSync(join(cwd, 'app.zip'), 'new')
  assert.match(failure(cwd, '--verify-assets', '--dry-run', '--attach', 'v1.8.0', '--host', 'github',
    '--repo', 'sasjs/app', '--asset', 'app.zip', '--api-url', 'http://example.com'), /--verify-assets cannot be combined with --dry-run/)
  assert.match(run(cwd, '--verify-assets', '--dry-run', '--attach', 'v1.8.0', '--show-context', '--host', 'github',
    '--repo', 'sasjs/app', '--asset', 'app.zip'), /host=github/)
})

test('verified attach refuses unsupported hosts and misplaced flags', () => {
  const cwd = repo()
  writeFileSync(join(cwd, 'app.zip'), 'new')
  assert.match(failure(cwd, '--verify-assets', '--release', '--host', 'github'), /requires --attach/)
  for (const mode of ['--release', '--prepare-publish', '--discover-publish'])
    assert.match(failure(cwd, '--verify-assets', '--attach', 'v1.8.0', mode, '--host', 'github'), /requires --attach and cannot be combined/)
  assert.match(failure(cwd, '--verify-assets', '--attach', '', '--host', 'github', '--asset', 'app.zip'), /non-empty/)
  assert.match(failure(cwd, '--verify-assets', '--attach', 'v1.8.0', '--host', 'gitlab', '--asset', 'app.zip'), /github only/)
  assert.match(failure(cwd, '--verify-assets', '--attach', 'v1.8.0', '--host', 'none', '--asset', 'app.zip'), /github only/)
  assert.match(failure(cwd, '--verify-assets', '--attach', 'v1.8.0', '--host', 'bogus', '--asset', 'app.zip'), /--host must be none, github, gitea or gitlab/)
  assert.match(run(cwd, '--verify-assets', '--attach', '', '--host', 'github', '--show-context'), /host=github/)
  assert.match(run(cwd, '--verify-assets', '--attach', 'v1.8.0', '--host', 'gitlab', '--show-context'), /host=gitlab/)
})

test('verified attach refuses missing digest, starter state, and unknown draft status', async (t) => {
  let asset = { name: 'app.zip', size: 3, state: 'uploaded', digest: null }
  let draft = true
  const replacement = await stub((request) => {
    if (request.url === '/repos/sasjs/app/releases?per_page=100&page=1')
      return { json: [{ id: 9, draft, tag_name: 'v1.8.0' }] }
    if (request.url === '/repos/sasjs/app/releases/9/assets?per_page=100&page=1') return { json: [asset] }
    return { status: 500, json: {} }
  })
  t.after(() => replacement.stop())
  const cwd = repo()
  writeFileSync(join(cwd, 'app.zip'), 'new')
  process.env.GH_TOKEN = 'token-123'
  const runIt = () => runInParallel(cwd, '--attach', 'v1.8.0', '--verify-assets', '--host', 'github',
    '--api-url', replacement.base, '--repo', 'sasjs/app', '--asset', 'app.zip')
  await assert.rejects(runIt(), /cannot verify digest/)
  asset = { ...asset, state: 'starter', digest: `sha256:${createHash('sha256').update('new').digest('hex')}` }
  await assert.rejects(runIt(), /cannot verify digest/)
  draft = null
  await assert.rejects(runIt(), /cannot verify release status/)
  assert.equal(replacement.seen.some((r) => r.method === 'PATCH' || r.method === 'DELETE'), false)
})

test('verified attach never follows a credential-bearing redirect', async (t) => {
  const receiver = await stub(() => ({ json: [] }))
  t.after(() => receiver.stop())
  const replacement = await stub(() => ({ status: 302, headers: { location: `${receiver.base}/stolen` } }))
  t.after(() => replacement.stop())
  const cwd = repo()
  writeFileSync(join(cwd, 'app.zip'), 'new')
  process.env.GH_TOKEN = 'token-123'
  await assert.rejects(runInParallel(cwd, '--attach', 'v1.8.0', '--verify-assets', '--host', 'github',
    '--api-url', replacement.base, '--repo', 'sasjs/app', '--asset', 'app.zip'))
  assert.equal(receiver.seen.length, 0)
})

test('verified attach rejects ambiguous repository paths before making any API call', async (t) => {
  const replacement = await stub(() => ({ json: [] }))
  t.after(() => replacement.stop())
  const cwd = repo()
  writeFileSync(join(cwd, 'app.zip'), 'new')
  process.env.GH_TOKEN = 'token-123'
  await assert.rejects(runInParallel(cwd, '--attach', 'v1.8.0', '--verify-assets', '--host', 'github',
    '--api-url', replacement.base, '--repo', 'sasjs/app/../../other', '--asset', 'app.zip'), /owner\/name/)
  assert.equal(replacement.seen.length, 0)
})

test('verified attach refuses insecure API endpoints outside loopback', async () => {
  const cwd = repo()
  writeFileSync(join(cwd, 'app.zip'), 'new')
  process.env.GH_TOKEN = 'token-123'
  await assert.rejects(runInParallel(cwd, '--attach', 'v1.8.0', '--verify-assets', '--host', 'github',
    '--api-url', 'http://example.com', '--repo', 'sasjs/app', '--asset', 'app.zip'), /HTTPS/)
})

test('verified attach does not retain full-page JSON fingerprints', async (t) => {
  const filler = Array.from({ length: 100 }, (_, i) => ({ id: i + 100, tag_name: `v0.0.${i}`, body: 'large-marker-'.repeat(100) }))
  const digest = `sha256:${createHash('sha256').update('new').digest('hex')}`
  const replacement = await stub((request) => {
    if (request.url === '/repos/sasjs/app/releases?per_page=100&page=1') return { json: filler }
    if (request.url === '/repos/sasjs/app/releases?per_page=100&page=2')
      return { json: [{ id: 9, draft: false, tag_name: 'v1.8.0' }] }
    if (request.url === '/repos/sasjs/app/releases/9/assets?per_page=100&page=1')
      return { json: [{ name: 'app.zip', size: 3, state: 'uploaded', digest }] }
    if (request.url === '/repos/sasjs/app/releases/9') return { json: { id: 9, draft: false, tag_name: 'v1.8.0' } }
    return { status: 500, json: {} }
  })
  t.after(() => replacement.stop())
  const cwd = repo()
  writeFileSync(join(cwd, 'app.zip'), 'new')
  const probe = join(cwd, 'probe.cjs')
  writeFileSync(probe, `const add = Set.prototype.add; Set.prototype.add = function (value) {
    if (typeof value === 'string' && value.includes('large-marker-') && value.length > 1000)
      throw new Error('retained full-page JSON fingerprint');
    return add.call(this, value);
  }`)
  await runInParallel(cwd, '--attach', 'v1.8.0', '--verify-assets', '--host', 'github',
    '--api-url', replacement.base, '--repo', 'sasjs/app', '--asset', 'app.zip',
    { GH_TOKEN: 'token-123', NODE_OPTIONS: `--require=${probe}` })
  assert.ok(replacement.seen.some((r) => r.url.endsWith('page=2')))
  assert.deepEqual(replacement.seen.filter((r) => r.method !== 'GET'), [])
})

test('verified attach rejects a nonconsecutive pagination cycle before writing', async (t) => {
  const pages = [0, 1].map((n) => Array.from({ length: 100 }, (_, i) => ({ id: n * 100 + i, tag_name: `v0.${n}.${i}` })))
  const replacement = await stub((request) => {
    const page = Number(new URL(request.url, 'http://localhost').searchParams.get('page'))
    return { json: pages[(page - 1) % 2] }
  })
  t.after(() => replacement.stop())
  const cwd = repo()
  writeFileSync(join(cwd, 'app.zip'), 'new')
  await assert.rejects(runInParallel(cwd, '--attach', 'v1.8.0', '--verify-assets', '--host', 'github',
    '--api-url', replacement.base, '--repo', 'sasjs/app', '--asset', 'app.zip', { GH_TOKEN: 'token-123' }), /pagination.*repeat/i)
  assert.equal(replacement.seen.length, 3)
  assert.deepEqual(replacement.seen.filter((r) => r.method !== 'GET'), [])
})

test('verified attach fails closed when a server repeats a full page', async (t) => {
  const page = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, tag_name: `v0.0.${i}` }))
  const replacement = await stub(() => ({ json: page }))
  t.after(() => replacement.stop())
  const cwd = repo()
  writeFileSync(join(cwd, 'app.zip'), 'new')
  process.env.GH_TOKEN = 'token-123'
  await assert.rejects(runInParallel(cwd, '--attach', 'v1.8.0', '--verify-assets', '--host', 'github',
    '--api-url', replacement.base, '--repo', 'sasjs/app', '--asset', 'app.zip'), /pagination.*repeat/i)
  assert.equal(replacement.seen.length, 2)
})

test('--attach says so when the host reports no size, rather than trusting the name', async (t) => {
  // a host that lists an asset without a size can only be checked by name, and a
  // silent pass would be a guard that does nothing
  let base = ''
  const replacement = await stub((request) => {
    if (request.url.startsWith('/repos/') && request.url.includes('/releases/tags/'))
      return { json: { id: 9, upload_url: `${base}/upload{?name,label}`, tag_name: 'v1.8.0' } }
    if (request.method === 'GET' && request.url === '/repos/sasjs/app/releases/9')
      return { json: { id: 9, assets: [{ name: 'server.json.zip' }] } }
    return { json: { ok: true } }
  })
  t.after(() => replacement.stop())
  base = replacement.base

  const cwd = repo({ commits: ['feat: initial', 'feat: one'] })
  writeFileSync(join(cwd, 'server.json.zip'), 'zip')
  process.env.GH_TOKEN = 'token-123'

  const output = await runInParallel(
    cwd, '--attach', 'v1.8.0', '--host', 'github', '--api-url', replacement.base,
    '--repo', 'sasjs/app', '--asset', 'server.json.zip'
  )

  assert.match(output, /the release states no size for: server\.json\.zip/)
  assert.match(output, /1 file\(s\) on the release/)
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
  const replacement = await stub((request) =>
    request.method === 'GET' && request.url === '/repos/dc/dc/releases/42/assets'
      ? { json: [{ name: 'frontend.zip' }] }
      : { json: { id: 42 } }
  )
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
    if (request.method === 'GET' && request.url === '/repos/sasjs/app/releases/9')
      return { json: { id: 9, assets: [{ name: 'server.json.zip' }] } }
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
    if (request.method === 'GET' && request.url === '/repos/sasjs/app/releases/9')
      return { json: { id: 9, assets: [{ name: 'server.json.zip' }] } }
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

test('--attach fails when the release does not hold what the config names', async (t) => {
  let base = ''
  const replacement = await stub((request) => {
    if (request.url.includes('/releases/tags/'))
      return { json: { id: 9, tag_name: 'v1.8.0', upload_url: `${base}/upload{?name,label}` } }
    if (request.method === 'GET' && request.url === '/repos/sasjs/app/releases/9')
      // the upload answered success, and the release still holds nothing: this is
      // the shape a release published with no files arrives in
      return { json: { id: 9, assets: [] } }
    return { json: { ok: true } }
  })
  t.after(() => replacement.stop())
  base = replacement.base

  const cwd = repo({ commits: ['feat: initial', 'feat: one'] })
  writeFileSync(join(cwd, 'server.json.zip'), 'zip')
  process.env.GH_TOKEN = 'token-123'

  const message = await failureInParallel(
    cwd, '--attach', 'v1.8.0', '--host', 'github', '--api-url', replacement.base,
    '--repo', 'sasjs/app', '--asset', 'server.json.zip'
  )

  assert.match(message, /holds 0 file\(s\) and is missing: server\.json\.zip/)
})

test('an explicit --host wins over what the environment says', () => {
  const cwd = repo({ commits: ['feat: initial', 'feat: one'] })

  const out = execFileSync(
    'node',
    [CLI, '--repo-dir', cwd, '--show-context', '--host', 'gitea', '--api-url', 'https://elsewhere/api/v1'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        ...envelope,
        GITHUB_ACTIONS: 'true',
        GITHUB_SERVER_URL: 'https://github.com',
        GITHUB_REPOSITORY: 'sasjs/macro-dash'
      }
    }
  )

  assert.match(out, /host=gitea api=https:\/\/elsewhere\/api\/v1/)
})

test('GITHUB_ACTIONS on github.com means github, with its own API', () => {
  const cwd = repo({ commits: ['feat: initial', 'feat: one'] })

  const out = execFileSync('node', [CLI, '--repo-dir', cwd, '--show-context'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ...envelope,
      GITHUB_ACTIONS: 'true',
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_REPOSITORY: 'sasjs/macro-dash'
    }
  })

  assert.match(out, /host=github api=https:\/\/api\.github\.com repo=sasjs\/macro-dash/)
})

test('GITHUB_ACTIONS elsewhere means gitea, at that server', () => {
  const cwd = repo({ commits: ['feat: initial', 'feat: one'] })

  const out = execFileSync('node', [CLI, '--repo-dir', cwd, '--show-context'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ...envelope,
      GITHUB_ACTIONS: 'true',
      GITHUB_SERVER_URL: 'https://gitea.4gl.io',
      GITHUB_REPOSITORY: '4gl/infra'
    }
  })

  assert.match(out, /host=gitea api=https:\/\/gitea\.4gl\.io\/api\/v1 repo=4gl\/infra/)
})

test('GITLAB_CI means gitlab', () => {
  const cwd = repo({ commits: ['feat: initial', 'feat: one'] })

  const out = execFileSync('node', [CLI, '--repo-dir', cwd, '--show-context'], {
    encoding: 'utf8',
    env: { ...process.env, ...envelope, GITLAB_CI: 'true', CI_API_V4_URL: 'https://gitlab.example/api/v4' }
  })

  assert.match(out, /host=gitlab api=https:\/\/gitlab\.example\/api\/v4/)
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
    // the tag check before the create: no tag at this name, which is the normal
    // case and not what this case is about. A missing ref is 404 on this endpoint.
    if (request.method === 'GET' && /\/git\/ref\/tags\//.test(request.url))
      return { status: 404, json: { message: 'Not Found' } }
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

test('a run that cannot publish writes no output claiming it did', () => {
  const cwd = repo({ commits: ['feat: initial', 'fix: one'] })
  const out = `/tmp/sasjs-release-out-${process.pid}.txt`
  writeFileSync(out, '')

  const message = failure(cwd, '--release', '--output', out)

  // `released=true` is what a calling workflow reads as "the release happened", so it
  // is written only once the run knows it can publish at all
  assert.match(message, /--release needs --host/)
  assert.doesNotMatch(readFileSync(out, 'utf8'), /released=true/)
})

test('a config that names no assets is refused, with the shapes it accepts', () => {
  const cwd = repo({ commits: ['feat: initial', 'feat: one'] })
  writeFileSync(join(cwd, 'empty.json'), JSON.stringify({ plugins: [] }))

  const message = failure(cwd, '--host', 'github', '--release', '--config', 'empty.json')

  assert.match(message, /names no assets/)
  assert.match(message, /@sasjs\/release/)
})

test('--no-assets without --draft is refused, since the release would be public and empty', () => {
  const cwd = repo({ commits: ['feat: initial', 'fix: one'] })
  writeProjectConfig(cwd, { release: { assets: ['sasjsbuild/viya/viya.sas'] } })
  process.env.GH_TOKEN = 'token-123'

  const message = failure(cwd, '--tag', '--host', 'github', '--release', '--no-assets')

  assert.match(message, /--no-assets needs --draft/)
  // and nothing was tagged on the way to finding out
  assert.equal(git(cwd, 'tag').trim(), 'v1.7.1')
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
    cwd, '--tag', '--host', 'github', '--release', '--no-assets', '--draft', '--api-url',
    replacement.base, '--repo', 'sasjs/app'
  )

  // the release exists as a draft and nothing was attached: --attach uploads the
  // files and then publishes it
  assert.match(out, /released=true/)
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
  const replacement = await stub((request) => {
    if (request.method === 'GET' && request.url.includes('/releases/tags/'))
      return { status: 404, json: { message: 'Not Found' } }
    // what the host holds after the upload: the cut reads it back before it is
    // published, so the stub has to be a host rather than an echo
    if (request.method === 'GET' && request.url === '/repos/dc/dc/releases/42/assets')
      return { json: [{ name: 'frontend.zip', size: 3 }] }
    return { json: { id: 42, body: 'x' } }
  })
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

test('a gitea cut refuses a release that stored something other than the build', async (t) => {
  // the gitea cut verified nothing either, and the reason confirmAssets exists is
  // host-neutral: a release published with nothing attached
  const replacement = await stub((request) => {
    if (request.method === 'GET' && request.url.includes('/releases/tags/'))
      return { status: 404, json: { message: 'Not Found' } }
    if (request.method === 'GET' && request.url === '/repos/dc/dc/releases/42/assets')
      return { json: [{ name: 'frontend.zip', size: 900 }] }
    return { json: { id: 42, body: 'x' } }
  })
  t.after(() => replacement.stop())
  const cwd = repo({ commits: ['feat: initial', 'fix: one'] })
  writeFileSync(join(cwd, 'frontend.zip'), 'zip')
  process.env.GITEA_TOKEN = 'gitea-token'

  const message = await failureInParallel(
    cwd, '--host', 'gitea', '--release', '--api-url', replacement.base,
    '--repo', 'dc/dc', '--asset', 'frontend.zip'
  )

  assert.match(message, /holds "frontend\.zip" at 900 bytes, where the file is 3 bytes/)
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

/**
 * A release that exists for the tag but names ANOTHER commit is the shape a run
 * leaves when it dies after the cut: a draft creates no tag, so the next run
 * re-classifies the same commits to the same version and finds this draft
 * waiting. Finishing it would attach today's build to a tag created at
 * yesterday's commit, so the draft is discarded and the release cut again.
 */
test('a draft that names another commit is discarded, and the release cut at this one', async (t) => {
  const cwd = repo({ commits: ['feat: initial', 'feat: one'] })
  const head = git(cwd, 'rev-parse', 'HEAD')
  const earlier = git(cwd, 'rev-parse', 'HEAD~1')
  let base = ''

  const replacement = await stub((request) => {
    if (request.method === 'GET' && /\/releases\/tags\//.test(request.url))
      return { status: 404, json: {} }
    if (request.method === 'GET' && /\/releases\?/.test(request.url))
      return { json: [{ id: 7, tag_name: 'v1.8.0', draft: true, target_commitish: earlier }] }
    // the discard re-reads the release immediately before deleting it
    if (request.method === 'GET' && /\/releases\/7$/.test(request.url))
      return { json: { id: 7, tag_name: 'v1.8.0', draft: true, assets: [] } }
    if (request.method === 'POST' && request.url === '/repos/sasjs/app/releases')
      return {
        json: {
          id: 8,
          tag_name: 'v1.8.0',
          draft: true,
          target_commitish: head,
          upload_url: `${base}/upload{?name,label}`
        }
      }
    return { json: { ok: true } }
  })
  t.after(() => replacement.stop())
  base = replacement.base
  process.env.GH_TOKEN = 'token-123'

  const out = await runInParallel(
    cwd, '--tag', '--host', 'github', '--release', '--draft',
    '--api-url', replacement.base, '--repo', 'sasjs/app'
  )

  assert.match(out, /discarded a stale draft for v1\.8\.0/)
  const deleted = replacement.seen.find((r) => r.method === 'DELETE')
  assert.equal(deleted.url, '/repos/sasjs/app/releases/7')

  const created = replacement.seen.find(
    (r) => r.method === 'POST' && r.url === '/repos/sasjs/app/releases'
  )
  const payload = JSON.parse(created.body)
  assert.equal(payload.target_commitish, head, 'the new draft names this commit')
  assert.equal(payload.draft, true)
  // the discard happens before the create, or the create answers 422 for a tag
  // that is still held by the draft it just deleted
  assert.ok(
    replacement.seen.indexOf(deleted) < replacement.seen.indexOf(created),
    'the stale draft is deleted before the release is created again'
  )
})

test('a draft that names this commit is finished, not discarded', async (t) => {
  const cwd = repo({ commits: ['feat: initial', 'feat: one'] })
  const head = git(cwd, 'rev-parse', 'HEAD')
  let base = ''

  const replacement = await stub((request) => {
    if (request.method === 'GET' && /\/releases\/tags\//.test(request.url))
      return { status: 404, json: {} }
    if (request.method === 'GET' && /\/releases\?/.test(request.url))
      return { json: [{ id: 9, tag_name: 'v1.8.0', draft: true, target_commitish: head }] }
    if (request.method === 'GET' && /\/releases\/9$/.test(request.url))
      return { json: { id: 9, tag_name: 'v1.8.0', draft: true, assets: [] } }
    if (request.method === 'POST' && request.url === '/repos/sasjs/app/releases')
      return { json: { id: 10, upload_url: `${base}/upload{?name,label}` } }
    return { json: { ok: true } }
  })
  t.after(() => replacement.stop())
  base = replacement.base
  process.env.GH_TOKEN = 'token-123'

  const out = await runInParallel(
    cwd, '--tag', '--host', 'github', '--release', '--draft',
    '--api-url', replacement.base, '--repo', 'sasjs/app'
  )

  assert.match(out, /a release for this tag already exists: finishing it/)
  assert.equal(replacement.seen.some((r) => r.method === 'DELETE'), false)
  assert.equal(
    replacement.seen.some((r) => r.method === 'POST' && r.url === '/repos/sasjs/app/releases'),
    false,
    'the existing draft is reused rather than created again'
  )
})

test('a published release naming another commit is refused rather than attached to', async (t) => {
  const cwd = repo({ commits: ['feat: initial', 'feat: one'] })
  const earlier = git(cwd, 'rev-parse', 'HEAD~1')
  const asset = join(cwd, 'app.zip')
  writeFileSync(asset, 'zip')
  let base = ''

  const replacement = await stub((request) => {
    if (request.method === 'GET' && /\/releases\/tags\//.test(request.url))
      return {
        json: { id: 11, tag_name: 'v1.8.0', draft: false, target_commitish: earlier, assets: [] }
      }
    if (request.method === 'POST' && request.url === '/repos/sasjs/app/releases')
      return { json: { id: 12, upload_url: `${base}/upload{?name,label}` } }
    return { json: { ok: true } }
  })
  t.after(() => replacement.stop())
  base = replacement.base
  process.env.GH_TOKEN = 'token-123'

  const message = await failureInParallel(
    cwd, '--tag', '--host', 'github', '--release',
    '--api-url', replacement.base, '--repo', 'sasjs/app', '--asset', asset
  )

  assert.match(message, /a published release for v1\.8\.0 already names/)
  assert.match(message, /refusing to attach this build to it/)
  assert.equal(replacement.seen.some((r) => r.method === 'DELETE'), false)
  assert.equal(
    replacement.seen.some((r) => String(r.url).startsWith('/upload')),
    false,
    'no asset is uploaded to a release that names another commit'
  )
})

test('a stale draft naming a commit the checkout does not carry is still discarded', async (t) => {
  // A release job's checkout can be shallow, and the commit a stale draft names
  // is exactly the object it will not have - so the sha is compared as a string
  // rather than resolved through git, or this case would reuse the draft.
  const cwd = repo({ commits: ['feat: initial', 'feat: one'] })
  const head = git(cwd, 'rev-parse', 'HEAD')
  const absent = 'a'.repeat(40)
  let base = ''

  const replacement = await stub((request) => {
    if (request.method === 'GET' && /\/releases\/tags\//.test(request.url))
      return { status: 404, json: {} }
    if (request.method === 'GET' && /\/releases\?/.test(request.url))
      return { json: [{ id: 21, tag_name: 'v1.8.0', draft: true, target_commitish: absent }] }
    if (request.method === 'GET' && /\/releases\/21$/.test(request.url))
      return { json: { id: 21, tag_name: 'v1.8.0', draft: true, assets: [] } }
    if (request.method === 'POST' && request.url === '/repos/sasjs/app/releases')
      return {
        json: {
          id: 22,
          tag_name: 'v1.8.0',
          draft: true,
          target_commitish: head,
          upload_url: `${base}/upload{?name,label}`
        }
      }
    return { json: { ok: true } }
  })
  t.after(() => replacement.stop())
  base = replacement.base
  process.env.GH_TOKEN = 'token-123'

  const out = await runInParallel(
    cwd, '--tag', '--host', 'github', '--release', '--draft',
    '--api-url', replacement.base, '--repo', 'sasjs/app'
  )

  assert.match(out, /discarded a stale draft for v1\.8\.0/)
  assert.equal(replacement.seen.find((r) => r.method === 'DELETE').url, '/repos/sasjs/app/releases/21')
  const created = replacement.seen.find(
    (r) => r.method === 'POST' && r.url === '/repos/sasjs/app/releases'
  )
  assert.equal(JSON.parse(created.body).target_commitish, head)
})

test('a release naming a branch is reused, because a branch cannot be compared', async (t) => {
  // A release made in the web UI stores the default branch name, and resolving
  // that would name the branch's tip today - not the commit the release holds.
  // Unverifiable is reused as before, and the run must not claim it "already
  // names" a commit it never said.
  const cwd = repo({ commits: ['feat: initial', 'feat: one'] })
  let base = ''

  const replacement = await stub((request) => {
    if (request.method === 'GET' && /\/releases\/tags\//.test(request.url))
      return { json: { id: 31, tag_name: 'v1.8.0', draft: false, target_commitish: 'main', assets: [] } }
    if (request.method === 'POST' && request.url === '/repos/sasjs/app/releases')
      return { json: { id: 32, upload_url: `${base}/upload{?name,label}` } }
    return { json: { ok: true } }
  })
  t.after(() => replacement.stop())
  base = replacement.base
  process.env.GH_TOKEN = 'token-123'

  const out = await runInParallel(
    cwd, '--tag', '--host', 'github', '--release',
    '--api-url', replacement.base, '--repo', 'sasjs/app'
  )

  assert.match(out, /a release for this tag already exists: finishing it/)
  assert.doesNotMatch(out, /already names/)
  assert.equal(replacement.seen.some((r) => r.method === 'DELETE'), false)
})

test('a draft published while the run was looking at it is not deleted', async (t) => {
  // The lookup that finds the draft is seconds old. If it has been published in
  // between, deleting it destroys a live release and its assets - so the state is
  // re-read immediately before the delete and the run refuses, as the published
  // branch does.
  const cwd = repo({ commits: ['feat: initial', 'feat: one'] })
  const earlier = git(cwd, 'rev-parse', 'HEAD~1')

  const replacement = await stub((request) => {
    if (request.method === 'GET' && /\/releases\/tags\//.test(request.url))
      return { status: 404, json: {} }
    if (request.method === 'GET' && /\/releases\?/.test(request.url))
      return { json: [{ id: 7, tag_name: 'v1.8.0', draft: true, target_commitish: earlier }] }
    // published by the time the delete would happen
    if (request.method === 'GET' && /\/releases\/7$/.test(request.url))
      return { json: { id: 7, tag_name: 'v1.8.0', draft: false, assets: [] } }
    return { json: { ok: true } }
  })
  t.after(() => replacement.stop())
  process.env.GH_TOKEN = 'token-123'

  const message = await failureInParallel(
    cwd, '--tag', '--host', 'github', '--release', '--draft',
    '--api-url', replacement.base, '--repo', 'sasjs/app'
  )

  assert.match(message, /was published while this run was looking at it/)
  assert.equal(replacement.seen.some((r) => r.method === 'DELETE'), false)
})

test('a tag already on another commit refuses the create', async (t) => {
  // GitHub ignores target_commitish once the tag exists, so a release created
  // here would point at that other commit while the run reports this one.
  const cwd = repo({ commits: ['feat: initial', 'feat: one'] })
  const elsewhere = 'b'.repeat(40)

  const replacement = await stub((request) => {
    if (request.method === 'GET' && /\/releases\/tags\//.test(request.url))
      return { status: 404, json: {} }
    if (request.method === 'GET' && /\/releases\?/.test(request.url)) return { json: [] }
    if (request.method === 'GET' && /\/git\/ref\/tags\/v1\.8\.0$/.test(request.url))
      return { json: { ref: 'refs/tags/v1.8.0', object: { type: 'commit', sha: elsewhere } } }
    return { json: { ok: true } }
  })
  t.after(() => replacement.stop())
  process.env.GH_TOKEN = 'token-123'

  const message = await failureInParallel(
    cwd, '--tag', '--host', 'github', '--release', '--draft',
    '--api-url', replacement.base, '--repo', 'sasjs/app'
  )

  assert.match(message, new RegExp(`tag v1\\.8\\.0 already names ${elsewhere}`))
  assert.match(message, /refusing to create a release that would point at the older commit/)
  assert.equal(
    replacement.seen.some((r) => r.method === 'POST' && r.url === '/repos/sasjs/app/releases'),
    false,
    'nothing is created for a tag that names another commit'
  )
})

test('an annotated tag naming another commit is peeled before the comparison', async (t) => {
  // Our own tags are annotated, so the ref names a tag object rather than a
  // commit: comparing the tag object's sha with the commit would always differ,
  // and refusing on that would block every release of an existing tag.
  const cwd = repo({ commits: ['feat: initial', 'feat: one'] })
  const elsewhere = 'd'.repeat(40)
  const tagObject = 'e'.repeat(40)

  const replacement = await stub((request) => {
    if (request.method === 'GET' && /\/releases\/tags\//.test(request.url))
      return { status: 404, json: {} }
    if (request.method === 'GET' && /\/releases\?/.test(request.url)) return { json: [] }
    if (request.method === 'GET' && /\/git\/ref\/tags\/v1\.8\.0$/.test(request.url))
      return { json: { ref: 'refs/tags/v1.8.0', object: { type: 'tag', sha: tagObject } } }
    if (request.method === 'GET' && new RegExp(`/git/tags/${tagObject}$`).test(request.url))
      return { json: { tag: 'v1.8.0', object: { type: 'commit', sha: elsewhere } } }
    return { json: { ok: true } }
  })
  t.after(() => replacement.stop())
  process.env.GH_TOKEN = 'token-123'

  const message = await failureInParallel(
    cwd, '--tag', '--host', 'github', '--release', '--draft',
    '--api-url', replacement.base, '--repo', 'sasjs/app'
  )

  // refused on the commit the tag holds, not on the tag object
  assert.match(message, new RegExp(`tag v1\\.8\\.0 already names ${elsewhere}`))
  assert.equal(message.includes(tagObject), false)
})

test('an annotated tag naming this commit does not stop the create', async (t) => {
  const cwd = repo({ commits: ['feat: initial', 'feat: one'] })
  const head = git(cwd, 'rev-parse', 'HEAD')
  const tagObject = 'f'.repeat(40)
  let created = 0

  const replacement = await stub((request) => {
    if (request.method === 'GET' && /\/releases\/tags\//.test(request.url))
      return { status: 404, json: {} }
    if (request.method === 'GET' && /\/releases\?/.test(request.url)) return { json: [] }
    if (request.method === 'GET' && /\/git\/ref\/tags\/v1\.8\.0$/.test(request.url))
      return { json: { ref: 'refs/tags/v1.8.0', object: { type: 'tag', sha: tagObject } } }
    if (request.method === 'GET' && new RegExp(`/git/tags/${tagObject}$`).test(request.url))
      return { json: { tag: 'v1.8.0', object: { type: 'commit', sha: head } } }
    if (request.method === 'POST' && request.url === '/repos/sasjs/app/releases') {
      created += 1
      return { json: { id: 9, tag_name: 'v1.8.0', draft: true, upload_url: '' } }
    }
    return { json: { ok: true } }
  })
  t.after(() => replacement.stop())
  process.env.GH_TOKEN = 'token-123'

  await runInParallel(
    cwd, '--tag', '--host', 'github', '--release', '--draft',
    '--api-url', replacement.base, '--repo', 'sasjs/app'
  )

  assert.equal(created, 1)
})

test('no tag yet is the normal path, and the create proceeds', async (t) => {
  // The state every release starts in, since the create is what makes the tag.
  // A missing ref answers 404 on this endpoint; a 422 from a `/commits/<ref>`
  // lookup for the same thing is why the ref endpoint is the one asked.
  const cwd = repo({ commits: ['feat: initial', 'feat: one'] })
  let created = 0

  const replacement = await stub((request) => {
    if (request.method === 'GET' && /\/releases\/tags\//.test(request.url))
      return { status: 404, json: {} }
    if (request.method === 'GET' && /\/releases\?/.test(request.url)) return { json: [] }
    if (request.method === 'GET' && /\/git\/ref\/tags\//.test(request.url))
      return { status: 404, json: { message: 'Not Found', documentation_url: '...' } }
    if (request.method === 'POST' && request.url === '/repos/sasjs/app/releases') {
      created += 1
      return { json: { id: 11, tag_name: 'v1.8.0', draft: true, upload_url: '' } }
    }
    return { json: { ok: true } }
  })
  t.after(() => replacement.stop())
  process.env.GH_TOKEN = 'token-123'

  await runInParallel(
    cwd, '--tag', '--host', 'github', '--release', '--draft',
    '--api-url', replacement.base, '--repo', 'sasjs/app'
  )

  assert.equal(created, 1)
})
