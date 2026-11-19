import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI = process.env.SASJS_RELEASE_ENTRY || fileURLToPath(new URL('../release.mjs', import.meta.url))
const names = ['scope-prod', 'scope-optional', 'scope-dev', 'scope-peer']

function execute(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options)
    let stdout = '', stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

async function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'audit-real-npm-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  const requests = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      requests.push({ url: req.url, authorization: req.headers.authorization, body })
      const advisories = Object.fromEntries(names.map((name, i) => [name, [{
        id: 10001 + i, name, url: `https://github.com/advisories/GHSA-aaaa-bbbb-ccc${i}`,
        title: `${name} vulnerability`, severity: 'high', vulnerable_versions: '<2.0.0'
      }]]))
      res.writeHead(200, { 'content-type': 'application/json' })
      const name = decodeURIComponent(req.url.slice(1))
      res.end(JSON.stringify(req.url.startsWith('/-/') ? advisories : {
        name, 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { name, version: '1.0.0' } }, time: { modified: '2020-01-01T00:00:00.000Z' }
      }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const port = server.address().port
  const pkg = { name: 'audit-scope-fixture', version: '1.0.0', dependencies: { [names[0]]: '1.0.0' }, optionalDependencies: { [names[1]]: '1.0.0' }, devDependencies: { [names[2]]: '1.0.0' }, peerDependencies: { [names[3]]: '1.0.0' } }
  const lock = { name: pkg.name, version: pkg.version, lockfileVersion: 3, requires: true, packages: {
    '': pkg,
    [`node_modules/${names[0]}`]: { version: '1.0.0' },
    [`node_modules/${names[1]}`]: { version: '1.0.0', optional: true },
    [`node_modules/${names[2]}`]: { version: '1.0.0', dev: true },
    [`node_modules/${names[3]}`]: { version: '1.0.0', peer: true }
  } }
  writeFileSync(join(cwd, 'package.json'), JSON.stringify(pkg))
  writeFileSync(join(cwd, 'package-lock.json'), JSON.stringify(lock))
  writeFileSync(join(cwd, '.npmrc'), `registry=http://127.0.0.1:${port}/\nomit=optional\n`)
  writeFileSync(join(cwd, 'user.npmrc'), `//127.0.0.1:${port}/:_authToken=fixture-secret\n`)
  writeFileSync(join(cwd, 'global.npmrc'), '')
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key)))
  Object.assign(env, { npm_config_userconfig: join(cwd, 'user.npmrc'), npm_config_globalconfig: join(cwd, 'global.npmrc'), npm_config_cache: join(cwd, 'npm-cache'), NODE_ENV: 'production', npm_config_omit: 'optional' })
  return { cwd, env, requests }
}

test('real npm full audit ignores inherited omit and production defaults while retaining registry auth', async (t) => {
  const { cwd, env, requests } = await fixture(t)
  const result = await execute(process.execPath, [CLI, '--repo-dir', cwd, '--audit', '--audit-report', 'actual.json'], { cwd, env })
  assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`)
  let actual
  try { actual = JSON.parse(readFileSync(join(cwd, 'actual.json'), 'utf8')) } catch (error) {
    assert.fail(`audit report unavailable: ${error.message}\n${result.stdout}\n${result.stderr}`)
  }
  assert.deepEqual(Object.keys(actual.vulnerabilities).sort(), [...names].sort(), result.stdout)
  const auditRequest = requests.find((request) => request.url === '/-/npm/v1/security/advisories/bulk')
  assert.ok(auditRequest)
  assert.equal(auditRequest.authorization, 'Bearer fixture-secret')
})

test('real npm explicit omit overrides inherited includes and keeps other types', async (t) => {
  const { cwd, env } = await fixture(t)
  Object.assign(env, { NPM_CONFIG_INCLUDE: 'dev', npm_config_omit: 'optional' })
  writeFileSync(join(cwd, '.npmrc'), `${readFileSync(join(cwd, '.npmrc'), 'utf8')}include=dev\n`)
  const result = await execute(process.execPath, [CLI, '--repo-dir', cwd, '--audit', '--audit-omit', 'dev', '--audit-report', 'actual.json'], { cwd, env })
  assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`)
  const actual = JSON.parse(readFileSync(join(cwd, 'actual.json'), 'utf8'))
  assert.deepEqual(Object.keys(actual.vulnerabilities).sort(), [names[0], names[1], names[3]].sort(), result.stdout)
})

for (const source of ['project', 'user', 'global', 'environment', 'node-env']) {
  test(`real npm full scope ignores ${source} omission`, async (t) => {
    const { cwd, env } = await fixture(t)
    delete env.npm_config_omit
    delete env.NODE_ENV
    writeFileSync(join(cwd, '.npmrc'), readFileSync(join(cwd, '.npmrc'), 'utf8').replace('omit=optional\n', ''))
    const files = { project: '.npmrc', user: 'user.npmrc', global: 'global.npmrc' }
    if (files[source]) {
      const path = join(cwd, files[source])
      writeFileSync(path, `${readFileSync(path, 'utf8')}omit=dev\n`)
    } else if (source === 'environment') env.NPM_CONFIG_OMIT = 'dev'
    else env.NODE_ENV = 'production'
    const result = await execute(process.execPath, [CLI, '--repo-dir', cwd, '--audit', '--audit-report', 'actual.json'], { cwd, env })
    assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`)
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(cwd, 'actual.json'), 'utf8')).vulnerabilities).sort(), [...names].sort())
  })
}

for (const omit of ['optional', 'peer', 'dev,optional', 'dev,optional,peer']) {
  test(`real npm omit:${omit} replaces inherited include and omit`, async (t) => {
    const { cwd, env } = await fixture(t)
    env.npm_config_include = 'dev'
    writeFileSync(join(cwd, 'global.npmrc'), 'include=optional\n')
    writeFileSync(join(cwd, 'user.npmrc'), `${readFileSync(join(cwd, 'user.npmrc'), 'utf8')}include=peer\n`)
    const result = await execute(process.execPath, [CLI, '--repo-dir', cwd, '--audit', '--audit-omit', omit, '--audit-report', 'actual.json'], { cwd, env })
    assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`)
    const expected = names.filter((name, i) => !omit.split(',').includes(['prod', 'optional', 'dev', 'peer'][i]))
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(cwd, 'actual.json'), 'utf8')).vulnerabilities).sort(), expected.sort())
  })
}

test('real npm second production audit cannot hide optional production advisories', async (t) => {
  const { cwd, env } = await fixture(t)
  const scripts = join(cwd, 'scripts')
  mkdirSync(scripts)
  writeFileSync(join(scripts, 'audit-allowlist.json'), JSON.stringify([{
    id: 'GHSA-aaaa-bbbb-ccc1', packages: [names[1]], devOnly: true, recheckBy: '2099-01-31', reason: 'Fixture exemption for production safety test'
  }]))
  const result = await execute(process.execPath, [CLI, '--repo-dir', cwd, '--audit'], { cwd, env })
  assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /scope-optional: in the production tree, though the allowlist calls it devOnly/)
})

for (const source of ['project', 'user', 'global', 'environment']) {
  test(`real npm omit:dev ignores ${source} inclusion`, async (t) => {
    const { cwd, env } = await fixture(t)
    const files = { project: '.npmrc', user: 'user.npmrc', global: 'global.npmrc' }
    if (files[source]) {
      const path = join(cwd, files[source])
      writeFileSync(path, `${readFileSync(path, 'utf8')}include=dev\n`)
    } else env.NPM_CONFIG_INCLUDE = 'dev'
    const result = await execute(process.execPath, [CLI, '--repo-dir', cwd, '--audit', '--audit-omit', 'dev', '--audit-report', 'actual.json'], { cwd, env })
    assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`)
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(cwd, 'actual.json'), 'utf8')).vulnerabilities).sort(), [names[0], names[1], names[3]].sort())
  })
}
