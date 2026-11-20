import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI = process.env.SASJS_RELEASE_ENTRY || fileURLToPath(new URL('../release.mjs', import.meta.url))
const canonical = `:: Created by npm, please don't edit manually.
@ECHO OFF

SETLOCAL

SET "NODE_EXE=%~dp0\\node.exe"
IF NOT EXIST "%NODE_EXE%" (
  SET "NODE_EXE=node"
)

SET "NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js"
SET "NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js"
FOR /F "delims=" %%F IN ('CALL "%NODE_EXE%" "%NPM_PREFIX_JS%"') DO (
  SET "NPM_PREFIX_NPM_CLI_JS=%%F\\node_modules\\npm\\bin\\npm-cli.js"
)
IF EXIST "%NPM_PREFIX_NPM_CLI_JS%" (
  SET "NPM_CLI_JS=%NPM_PREFIX_NPM_CLI_JS%"
)

"%NODE_EXE%" "%NPM_CLI_JS%" %*
`

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'audit win & percent% '))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const project = join(root, 'project & data')
  mkdirSync(project)
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }))
  const preload = join(root, 'platform.cjs')
  writeFileSync(preload, "Object.defineProperty(process, 'platform', {value:'win32'})\n")
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['path', 'pathext', 'nodefaultcurrentdirectoryinexepath'].includes(key.toLowerCase())))
  env.NODE_OPTIONS = process.platform === 'win32' ? '' : `--require=\"${preload}\"`
  return { root, project, env }
}

function install(root, name, code) {
  const bin = join(root, name)
  const js = join(bin, 'node_modules', 'npm', 'bin')
  mkdirSync(js, { recursive: true })
  writeFileSync(join(bin, 'npm.cmd'), canonical)
  writeFileSync(join(js, 'npm-prefix.js'), 'console.log(process.env.TEST_PREFIX)\n')
  writeFileSync(join(js, 'npm-cli.js'), code)
  copyFileSync(process.execPath, join(bin, 'node.exe'))
  return bin
}

const clean = { auditReportVersion: 2, vulnerabilities: {}, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 }, dependencies: {} } }

test('Windows honours NoDefaultCurrentDirectoryInExePath instead of executing project-local npm', (t) => {
  const { root, project, env } = fixture(t)
  install(root, 'trusted', `console.log(${JSON.stringify(JSON.stringify(clean))})`)
  writeFileSync(join(project, 'npm.cmd'), canonical)
  copyFileSync(process.execPath, join(project, 'node.exe'))
  const js = join(project, 'node_modules', 'npm', 'bin')
  mkdirSync(js, { recursive: true })
  writeFileSync(join(js, 'npm-prefix.js'), `require('fs').writeFileSync(process.env.MARKER, 'executed'); console.log(process.env.TEST_PREFIX)`)
  writeFileSync(join(js, 'npm-cli.js'), 'process.exit(88)')
  Object.assign(env, { PATH: join(root, 'trusted'), NoDefaultCurrentDirectoryInExePath: '1', TEST_PREFIX: join(root, 'absent'), MARKER: join(root, 'marker') })
  const result = spawnSync(process.execPath, [CLI, '--repo-dir', project, '--audit'], { env, encoding: 'utf8' })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.throws(() => readFileSync(env.MARKER), { code: 'ENOENT' })
})

test('Windows fails closed instead of bypassing a PATH node.cmd fallback', (t) => {
  const { root, project, env } = fixture(t)
  const bin = install(root, 'npm-shim', `console.log(${JSON.stringify(JSON.stringify(clean))})`)
  rmSync(join(bin, 'node.exe'))
  const launcher = join(root, 'launcher')
  mkdirSync(launcher)
  writeFileSync(join(launcher, 'node.cmd'), 'not executed')
  const later = join(root, 'later')
  mkdirSync(later)
  copyFileSync(process.execPath, join(later, 'node.exe'))
  Object.assign(env, { PATH: [bin, launcher, later].join(';'), PATHEXT: '.COM;.EXE;.BAT;.CMD', TEST_PREFIX: join(root, 'absent') })
  const result = spawnSync(process.execPath, [CLI, '--repo-dir', project, '--audit'], { env, encoding: 'utf8' })
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stderr, /unsupported.*node\.cmd/i)
})

for (const scenario of [
  { label: 'default', flag: undefined, path: 'bin', expected: 'project' },
  { label: 'disabled nonempty', flag: '0', path: 'bin', expected: 'bin' },
  { label: 'disabled empty', flag: '', path: 'bin', expected: 'bin' },
  { label: 'disabled but explicit dot', flag: '1', path: 'dot-first', expected: 'project' },
  { label: 'disabled with dot later', flag: '1', path: 'dot-last', expected: 'bin' }
]) {
  test(`Windows npm current-directory precedence: ${scenario.label}`, (t) => {
    const { root, project, env } = fixture(t)
    const code = `require('fs').writeFileSync(process.env.MARKER, process.env.IDENTITY); console.log(${JSON.stringify(JSON.stringify(clean))})`
    const bin = install(root, 'bin', code)
    const projectBin = install(root, 'local', code)
    // Move only npm-related files into the project, preserving its package.json.
    mkdirSync(join(project, 'node_modules', 'npm', 'bin'), { recursive: true })
    for (const file of ['npm.cmd', 'node.exe', 'node_modules/npm/bin/npm-prefix.js', 'node_modules/npm/bin/npm-cli.js'])
      copyFileSync(join(projectBin, file), join(project, file))
    // Prefix script distinguishes the selected shim without relying on parent cwd.
    writeFileSync(join(project, 'node_modules/npm/bin/npm-cli.js'), code.replace('process.env.IDENTITY', "'project'"))
    writeFileSync(join(bin, 'node_modules/npm/bin/npm-cli.js'), code.replace('process.env.IDENTITY', "'bin'"))
    Object.assign(env, { PATH: scenario.path === 'dot-first' ? `.;${bin}` : scenario.path === 'dot-last' ? `${bin};.` : bin, TEST_PREFIX: join(root, 'absent'), MARKER: join(root, 'marker') })
    if (scenario.flag !== undefined) env.NoDefaultCurrentDirectoryInExePath = scenario.flag
    const result = spawnSync(process.execPath, [CLI, '--repo-dir', project, '--audit'], { env, encoding: 'utf8' })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.equal(readFileSync(env.MARKER, 'utf8'), scenario.expected)
  })
}

for (const scenario of [
  { label: 'current directory bat', dir: 'cwd', ext: 'bat', pathext: '.EXE;.BAT;.CMD' },
  { label: 'earlier PATH cmd', dir: 'path', ext: 'cmd', pathext: '.EXE;.BAT;.CMD' },
  { label: 'custom PATHEXT', dir: 'path', ext: 'foo', pathext: '.FOO;.EXE;.CMD' },
  { label: 'same-directory PATHEXT before exe', dir: 'same', ext: 'cmd', pathext: '.CMD;.EXE' }
]) {
  test(`Windows node fallback rejects ${scenario.label}`, (t) => {
    const { root, project, env } = fixture(t)
    const bin = install(root, 'npm-bin', `console.log(${JSON.stringify(JSON.stringify(clean))})`)
    rmSync(join(bin, 'node.exe'))
    const first = join(root, 'first')
    const later = join(root, 'later')
    mkdirSync(first); mkdirSync(later)
    copyFileSync(process.execPath, join(later, 'node.exe'))
    writeFileSync(join(scenario.dir === 'cwd' ? project : scenario.dir === 'same' ? later : first, `node.${scenario.ext}`), 'not executed')
    Object.assign(env, { PATH: [bin, first, later].join(';'), PATHEXT: scenario.pathext, TEST_PREFIX: join(root, 'absent') })
    const result = spawnSync(process.execPath, [CLI, '--repo-dir', project, '--audit'], { env, encoding: 'utf8' })
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`)
    assert.match(result.stderr, new RegExp(`unsupported.*node\\.${scenario.ext}`, 'i'))
  })
}

for (const scenario of [
  { label: 'enabled', disabled: false, expected: 'project' },
  { label: 'disabled', disabled: true, expected: 'path' },
  { label: 'explicit dot', disabled: true, dot: true, expected: 'project' }
]) {
  test(`Windows node fallback current-directory search: ${scenario.label}`, (t) => {
    const { root, project, env } = fixture(t)
    const bin = install(root, 'npm-bin', `require('fs').writeFileSync(process.env.MARKER, process.execPath); console.log(${JSON.stringify(JSON.stringify(clean))})`)
    rmSync(join(bin, 'node.exe'))
    const later = join(root, 'later')
    mkdirSync(later)
    copyFileSync(process.execPath, join(later, 'node.exe'))
    copyFileSync(process.execPath, join(project, 'node.exe'))
    Object.assign(env, { PATH: [bin, ...(scenario.dot ? ['.'] : []), later].join(';'), PATHEXT: '.EXE;.CMD', TEST_PREFIX: join(root, 'absent'), MARKER: join(root, 'node-used') })
    if (scenario.disabled) env.NoDefaultCurrentDirectoryInExePath = '1'
    const result = spawnSync(process.execPath, [CLI, '--repo-dir', project, '--audit'], { env, encoding: 'utf8' })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.equal(readFileSync(env.MARKER, 'utf8').toLowerCase(), join(scenario.expected === 'project' ? project : later, 'node.exe').toLowerCase())
  })
}

test('Windows node beside npm wins over earlier PATH and current-directory wrappers', (t) => {
  const { root, project, env } = fixture(t)
  const bin = install(root, 'npm-bin', `console.log(${JSON.stringify(JSON.stringify(clean))})`)
  writeFileSync(join(project, 'node.cmd'), 'not executed')
  Object.assign(env, { PATH: bin, PATHEXT: '.CMD;.EXE', TEST_PREFIX: join(root, 'absent') })
  const result = spawnSync(process.execPath, [CLI, '--repo-dir', project, '--audit'], { env, encoding: 'utf8' })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
})

test('Windows PATHEXT does not silently bypass an earlier custom launcher', (t) => {
  const { root, project, env } = fixture(t)
  const bin = install(root, 'custom', `console.log(${JSON.stringify(JSON.stringify(clean))})`)
  writeFileSync(join(bin, 'npm.foo'), '')
  Object.assign(env, { PATH: bin, PATHEXT: '.FOO;.CMD', TEST_PREFIX: join(root, 'absent') })
  const result = spawnSync(process.execPath, [CLI, '--repo-dir', project, '--audit'], { env, encoding: 'utf8' })
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stderr, /unsupported.*npm\.foo/i)
})

test('Windows missing prefix script fails closed with a diagnostic', (t) => {
  const { root, project, env } = fixture(t)
  const bin = install(root, 'broken-prefix', 'process.exit(0)')
  rmSync(join(bin, 'node_modules', 'npm', 'bin', 'npm-prefix.js'))
  env.PATH = bin
  const result = spawnSync(process.execPath, [CLI, '--repo-dir', project, '--audit'], { env, encoding: 'utf8' })
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stderr, /Windows npm prefix lookup failed/)
})

test('Windows fails closed for a tampered shim instead of interpreting it', (t) => {
  const { root, project, env } = fixture(t)
  const first = install(root, 'bad', `console.log(${JSON.stringify(JSON.stringify(clean))})`)
  writeFileSync(join(first, 'npm.cmd'), `${canonical}\nECHO injected\n`)
  env.PATH = first
  const result = spawnSync(process.execPath, [CLI, '--repo-dir', project, '--audit'], { env, encoding: 'utf8' })
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stderr, /unsupported Windows npm shim/)
})

test('Windows audit preserves workspace selectors as literal arguments', (t) => {
  const { root, project, env } = fixture(t)
  const bin = install(root, 'shim', `require('fs').writeFileSync(process.env.ARGS_FILE, JSON.stringify(process.argv.slice(2))); console.log(${JSON.stringify(JSON.stringify(clean))})`)
  const pattern = 'packages/& whoami ^ %PATH% !'
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', workspaces: [pattern] }))
  Object.assign(env, { PATH: bin, TEST_PREFIX: join(root, 'absent'), ARGS_FILE: join(root, 'argv.json') })
  const result = spawnSync(process.execPath, [CLI, '--repo-dir', project, '--audit'], { env, encoding: 'utf8' })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  const args = JSON.parse(readFileSync(env.ARGS_FILE, 'utf8'))
  assert.equal(args[args.indexOf(pattern) - 1], '--workspace')
})

test('Windows distribution shim uses npm-prefix-selected npm', (t) => {
  const { root, project, env } = fixture(t)
  const bin = install(root, 'distribution', 'process.exit(73)')
  const prefix = join(root, 'prefix & 5%')
  const js = join(prefix, 'node_modules', 'npm', 'bin')
  mkdirSync(js, { recursive: true })
  writeFileSync(join(js, 'npm-cli.js'), `console.log(${JSON.stringify(JSON.stringify(clean))})`)
  Object.assign(env, { PATH: bin, TEST_PREFIX: prefix })
  const result = spawnSync(process.execPath, [CLI, '--repo-dir', project, '--audit'], { env, encoding: 'utf8' })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
})

test('Windows rejects an npm executable before a later npm.cmd', (t) => {
  const { root, project, env } = fixture(t)
  const first = join(root, 'exe-first')
  mkdirSync(first)
  writeFileSync(join(first, 'npm.exe'), '')
  const second = install(root, 'cmd-second', `console.log(${JSON.stringify(JSON.stringify(clean))})`)
  env.PATH = [first, second].join(';')
  const result = spawnSync(process.execPath, [CLI, '--repo-dir', project, '--audit'], { env, encoding: 'utf8' })
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stderr, /unsupported.*npm\.exe/i)
})

test('Windows uses an npm-generated global-install cmd shim', (t) => {
  const { root, project, env } = fixture(t)
  const bin = install(root, 'global', `console.log(${JSON.stringify(JSON.stringify(clean))})`)
  writeFileSync(join(bin, 'npm.cmd'), '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\npm\\bin\\npm-cli.js" %*\r\n')
  Object.assign(env, { PATH: [bin, process.env.PATH].join(';') })
  const result = spawnSync(process.execPath, [CLI, '--repo-dir', project, '--audit'], { env, encoding: 'utf8' })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
})

test('Windows audit uses the first PATH npm without a shell and forwards exact arguments', (t) => {
  const { root, project, env } = fixture(t)
  const first = install(root, 'first & 100%', `require('fs').writeFileSync(process.env.ARGS_FILE, JSON.stringify(process.argv.slice(2))); console.log(${JSON.stringify(JSON.stringify(clean))})`)
  const second = install(root, 'second', 'process.exit(71)')
  Object.assign(env, { PATH: [first, second, process.env.PATH].join(';'), TEST_PREFIX: join(root, 'absent'), ARGS_FILE: join(root, 'argv.json') })
  const result = spawnSync(process.execPath, [CLI, '--repo-dir', project, '--audit', '--audit-omit', 'dev,optional'], { env, encoding: 'utf8' })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${result.error || ''}`)
  assert.deepEqual(JSON.parse(readFileSync(env.ARGS_FILE, 'utf8')), ['audit', '--json', '--include', 'prod', '--include', 'peer', '--omit', 'dev', '--omit', 'optional'])
})
