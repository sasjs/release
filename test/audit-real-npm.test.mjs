import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI = process.env.SASJS_RELEASE_ENTRY || fileURLToPath(new URL('../release.mjs', import.meta.url))
const names = ['scope-prod', 'scope-optional', 'scope-dev', 'scope-peer']

test('real npm selected on PATH passes a clean audit against loopback', async (t) => {
  if (process.env.SASJS_WINDOWS_EXPECTED_NPM_DIR) {
    const selected = (Object.entries(process.env).find(([key]) => key.toLowerCase() === 'path')?.[1] || '').split(';')[0]
    assert.equal(selected.toLowerCase(), process.env.SASJS_WINDOWS_EXPECTED_NPM_DIR.toLowerCase(), 'the expected npm directory must be first on PATH')
  }
  const { cwd, env, requests } = await fixture(t, { clean: true })
  const result = await execute(process.execPath, [CLI, '--repo-dir', cwd, '--audit', '--audit-report', 'actual.json'], { cwd, env })
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /^audited=true$/m)
  assert.ok(requests.some((request) => request.url === '/-/npm/v1/security/advisories/bulk'), `${result.stdout}\n${result.stderr}`)
  assert.ok(existsSync(join(cwd, 'actual.json')), `${result.stdout}\n${result.stderr}`)
})

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

async function fixture(t, { duplicateSource = false, clean = false } = {}) {
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
      if (duplicateSource) advisories['scope-dev'].push({ ...advisories['scope-dev'][0], id: 10099, title: 'second advisory' })
      res.writeHead(200, { 'content-type': 'application/json' })
      const name = decodeURIComponent(req.url.slice(1))
      res.end(JSON.stringify(req.url.startsWith('/-/') ? (clean ? {} : advisories) : {
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

async function workspaceFixture(t) {
  const data = await fixture(t)
  const { cwd } = data
  const root = { name: 'audit-scope-fixture', version: '1.0.0', private: true, workspaces: ['packages/*'], dependencies: { [names[0]]: '1.0.0' } }
  const a = { name: 'ws-a', version: '1.0.0', dependencies: { [names[1]]: '1.0.0' } }
  const b = { name: 'ws-b', version: '1.0.0', dependencies: { [names[2]]: '1.0.0' } }
  const lock = { name: root.name, version: root.version, lockfileVersion: 3, requires: true, packages: {
    '': root, 'packages/a': a, 'packages/b': b,
    'node_modules/ws-a': { resolved: 'packages/a', link: true },
    'node_modules/ws-b': { resolved: 'packages/b', link: true },
    ...Object.fromEntries(names.slice(0, 3).map((name) => [`node_modules/${name}`, { version: '1.0.0' }]))
  } }
  for (const [path, pkg] of [['', root], ['packages/a', a], ['packages/b', b]]) {
    mkdirSync(join(cwd, path), { recursive: true })
    writeFileSync(join(cwd, path, 'package.json'), JSON.stringify(pkg))
  }
  writeFileSync(join(cwd, 'package-lock.json'), JSON.stringify(lock))
  return data
}

test('real npm preserves separate numeric sources sharing a GHSA', async (t) => {
  const { cwd, env } = await fixture(t, { duplicateSource: true })
  const pkg = { name: 'audit-source-fixture', version: '1.0.0', devDependencies: { 'scope-dev': '1.0.0' } }
  writeFileSync(join(cwd, 'package.json'), JSON.stringify(pkg))
  writeFileSync(join(cwd, 'package-lock.json'), JSON.stringify({ name: pkg.name, version: pkg.version, lockfileVersion: 3,
    packages: { '': pkg, 'node_modules/scope-dev': { version: '1.0.0', dev: true } } }))
  const entry = { id: 'GHSA-aaaa-bbbb-ccc2', packages: ['scope-dev'], source: 10003, severity: 'high',
    devOnly: true, recheckBy: '2099-01-31', reason: 'Fixture' }
  const config = join(cwd, 'allowlist.json')
  writeFileSync(config, JSON.stringify([entry]))
  const args = [CLI, '--repo-dir', cwd, '--audit', '--audit-config', config, '--audit-require-source', '--audit-require-severity', '--audit-report', 'actual.json']
  const first = await execute(process.execPath, args, { cwd, env })
  assert.equal(first.code, 1, `${first.stdout}\n${first.stderr}`)
  assert.match(first.stdout, /source differs/)
  const actual = JSON.parse(readFileSync(join(cwd, 'actual.json'), 'utf8'))
  assert.deepEqual(actual.vulnerabilities['scope-dev'].via.map((v) => v.source).sort(), [10003, 10099])
  writeFileSync(config, JSON.stringify([entry, { ...entry, source: 10099 }]))
  const second = await execute(process.execPath, args, { cwd, env })
  assert.equal(second.code, 0, `${second.stdout}\n${second.stderr}`)
})

for (const source of ['environment', 'project', 'user', 'global', 'disabled']) {
  for (const omit of ['', 'dev']) {
    test(`real npm ${omit || 'full'} workspace audit ignores ${source} selection`, async (t) => {
      const { cwd, env, requests } = await workspaceFixture(t)
      const files = { project: '.npmrc', user: 'user.npmrc', global: 'global.npmrc' }
      if (files[source]) {
        const path = join(cwd, files[source])
        writeFileSync(path, `${readFileSync(path, 'utf8')}workspace=ws-a\n`)
      } else if (source === 'disabled') writeFileSync(join(cwd, '.npmrc'), `${readFileSync(join(cwd, '.npmrc'), 'utf8')}workspaces=false\n`)
      else env.npm_config_workspace = 'ws-a'
      const args = [CLI, '--repo-dir', cwd, '--audit', '--audit-report', 'actual.json']
      if (omit) args.push('--audit-omit', omit)
      const result = await execute(process.execPath, args, { cwd, env })
      assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`)
      const actual = JSON.parse(readFileSync(join(cwd, 'actual.json'), 'utf8'))
      assert.deepEqual(Object.keys(actual.vulnerabilities).sort(), names.slice(0, 3).sort(), result.stdout)
      assert.equal(requests.find((request) => request.url === '/-/npm/v1/security/advisories/bulk')?.authorization, 'Bearer fixture-secret')
    })
  }
}

test('real npm second production audit sees production advisories in an unselected workspace', async (t) => {
  const { cwd, env } = await workspaceFixture(t)
  env.npm_config_workspace = 'ws-a'
  mkdirSync(join(cwd, 'scripts'))
  writeFileSync(join(cwd, 'scripts', 'audit-allowlist.json'), JSON.stringify(names.slice(0, 3).map((name, i) => ({
    id: `GHSA-aaaa-bbbb-ccc${i}`, packages: [name], devOnly: true, recheckBy: '2099-01-31', reason: 'Fixture exemption for production safety test'
  }))))
  const result = await execute(process.execPath, [CLI, '--repo-dir', cwd, '--audit'], { cwd, env })
  assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /scope-dev: in the production tree, though the allowlist calls it devOnly/)
})

test('real npm audit from a workspace directory covers the root and sibling workspace', async (t) => {
  const { cwd, env } = await workspaceFixture(t)
  env.npm_config_workspace = 'ws-a'
  const nested = join(cwd, 'packages/a')
  const result = await execute(process.execPath, [CLI, '--repo-dir', nested, '--audit', '--audit-report', 'actual.json'], { cwd: nested, env })
  assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`)
  const actual = JSON.parse(readFileSync(join(nested, 'actual.json'), 'utf8'))
  assert.deepEqual(Object.keys(actual.vulnerabilities).sort(), names.slice(0, 3).sort(), result.stdout)
})

for (const location of ['root', 'nested']) {
  test(`real npm ${location} audit finds root and sibling through an intermediate package manifest`, async (t) => {
    const { cwd, env, requests } = await workspaceFixture(t)
    writeFileSync(join(cwd, 'packages/package.json'), JSON.stringify({ name: 'intermediate', version: '1.0.0' }))
    writeFileSync(join(cwd, '.npmrc'), `${readFileSync(join(cwd, '.npmrc'), 'utf8')}workspace=ws-a\n`)
    env.npm_config_workspace = 'ws-a'
    const target = location === 'root' ? cwd : join(cwd, 'packages/a')
    const result = await execute(process.execPath, [CLI, '--repo-dir', target, '--audit', '--audit-report', 'actual.json'], { cwd: target, env })
    assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`)
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(target, 'actual.json'), 'utf8')).vulnerabilities).sort(), names.slice(0, 3).sort(), `${result.stdout}\n${result.stderr}`)
    assert.equal(requests.find((request) => request.url === '/-/npm/v1/security/advisories/bulk')?.authorization, 'Bearer fixture-secret')
  })
}

test('real npm production audit finds root and sibling through an intermediate package manifest', async (t) => {
  const { cwd, env } = await workspaceFixture(t)
  writeFileSync(join(cwd, 'packages/package.json'), JSON.stringify({ name: 'intermediate', version: '1.0.0' }))
  writeFileSync(join(cwd, '.npmrc'), `${readFileSync(join(cwd, '.npmrc'), 'utf8')}workspace=ws-a\n`)
  env.npm_config_workspace = 'ws-a'
  const a = JSON.parse(readFileSync(join(cwd, 'packages/a/package.json'), 'utf8'))
  a.devDependencies = a.dependencies
  delete a.dependencies
  writeFileSync(join(cwd, 'packages/a/package.json'), JSON.stringify(a))
  const lock = JSON.parse(readFileSync(join(cwd, 'package-lock.json'), 'utf8'))
  lock.packages['packages/a'] = a
  lock.packages['node_modules/scope-optional'].dev = true
  writeFileSync(join(cwd, 'package-lock.json'), JSON.stringify(lock))
  const config = join(cwd, 'allowlist.json')
  writeFileSync(config, JSON.stringify([{ id: 'GHSA-aaaa-bbbb-ccc1', packages: ['scope-optional'], devOnly: true, recheckBy: '2099-01-31', reason: 'Fixture exemption' }]))
  for (const target of [cwd, join(cwd, 'packages/a')]) {
    const result = await execute(process.execPath, [CLI, '--repo-dir', target, '--audit', '--audit-config', config], { cwd: target, env })
    assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`)
    assert.match(result.stdout, /scope-prod: in the production tree/)
    assert.match(result.stdout, /scope-dev: in the production tree/)
  }
})

test('real npm audits an independent project nested inside a workspace repository', async (t) => {
  const { cwd, env } = await workspaceFixture(t)
  const nested = join(cwd, 'packages/a/standalone')
  mkdirSync(nested, { recursive: true })
  const pkg = { name: 'standalone', version: '1.0.0', dependencies: { [names[3]]: '1.0.0' } }
  writeFileSync(join(nested, 'package.json'), JSON.stringify(pkg))
  writeFileSync(join(nested, 'package-lock.json'), JSON.stringify({ name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: { '': pkg, [`node_modules/${names[3]}`]: { version: '1.0.0' } } }))
  writeFileSync(join(nested, '.npmrc'), readFileSync(join(cwd, '.npmrc'), 'utf8'))
  const result = await execute(process.execPath, [CLI, '--repo-dir', nested, '--audit', '--audit-report', 'actual.json'], { cwd: nested, env })
  assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`)
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(nested, 'actual.json'), 'utf8')).vulnerabilities), [names[3]], result.stdout)
})

test('real npm audit includes workspaces explicitly located under hidden directories', async (t) => {
  const { cwd, env } = await workspaceFixture(t)
  const root = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'))
  root.workspaces.push('.hidden/.deep/*')
  const hidden = { name: 'ws-hidden', version: '1.0.0', dependencies: { [names[3]]: '1.0.0' } }
  mkdirSync(join(cwd, '.hidden/.deep/c'), { recursive: true })
  writeFileSync(join(cwd, '.hidden/.deep/c/package.json'), JSON.stringify(hidden))
  writeFileSync(join(cwd, 'package.json'), JSON.stringify(root))
  const lock = JSON.parse(readFileSync(join(cwd, 'package-lock.json'), 'utf8'))
  lock.packages[''] = root
  lock.packages['.hidden/.deep/c'] = hidden
  lock.packages['node_modules/ws-hidden'] = { resolved: '.hidden/.deep/c', link: true }
  lock.packages[`node_modules/${names[3]}`] = { version: '1.0.0' }
  writeFileSync(join(cwd, 'package-lock.json'), JSON.stringify(lock))
  env.npm_config_workspace = 'ws-a'
  const result = await execute(process.execPath, [CLI, '--repo-dir', cwd, '--audit', '--audit-report', 'actual.json'], { cwd, env })
  assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`)
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(cwd, 'actual.json'), 'utf8')).vulnerabilities).sort(), [...names].sort(), result.stdout)
})

test('real npm fails closed for workspace projects with no matching workspaces', async (t) => {
  const { cwd, env } = await fixture(t)
  const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'))
  pkg.workspaces = ['packages/*']
  writeFileSync(join(cwd, 'package.json'), JSON.stringify(pkg))
  const result = await execute(process.execPath, [CLI, '--repo-dir', cwd, '--audit', '--audit-report', 'actual.json'], { cwd, env })
  assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`)
  assert.ok(!existsSync(join(cwd, 'actual.json')), `${result.stdout}\n${result.stderr}`)
  assert.match(result.stderr, /not an npm audit report/)
})

test('real npm non-workspace audit ignores an environment workspace selection', async (t) => {
  const { cwd, env } = await fixture(t)
  env.NPM_CONFIG_WORKSPACE = 'ws-a'
  const result = await execute(process.execPath, [CLI, '--repo-dir', cwd, '--audit', '--audit-report', 'actual.json'], { cwd, env })
  assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`)
  assert.ok(existsSync(join(cwd, 'actual.json')), `${result.stdout}\n${result.stderr}`)
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(cwd, 'actual.json'), 'utf8')).vulnerabilities).sort(), [...names].sort())
})

test('real npm non-workspace audit fails closed with an inherited workspace selection', async (t) => {
  const { cwd, env } = await fixture(t)
  writeFileSync(join(cwd, '.npmrc'), `${readFileSync(join(cwd, '.npmrc'), 'utf8')}workspace=ws-a\n`)
  env.npm_config_workspace = 'ws-a'
  const result = await execute(process.execPath, [CLI, '--repo-dir', cwd, '--audit', '--audit-report', 'actual.json'], { cwd, env })
  assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`)
  assert.ok(!existsSync(join(cwd, 'actual.json')), `${result.stdout}\n${result.stderr}`)
  assert.match(result.stderr, /not an npm audit report/)
})

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
