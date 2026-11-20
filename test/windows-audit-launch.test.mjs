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
  const env = { ...process.env, NODE_OPTIONS: process.platform === 'win32' ? '' : `--require=\"${preload}\"` }
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
