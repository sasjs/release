import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// scripts/mutate.mjs runs this suite against a deliberately broken copy, so the
// entry point is overridable; everything else runs the real one.
const CLI =
  process.env.SASJS_RELEASE_ENTRY || fileURLToPath(new URL('../release.mjs', import.meta.url))

/**
 * An advisory as `npm audit --json` reports it: an id in the url, or - npm's own
 * advisories - a numeric source and no url at all.
 */
const advisory = (id, { severity = 'high', title = 'a fixture advisory', package: name = 'fixture' } = {}) => ({
  source: 1247710,
  name,
  dependency: name,
  title,
  url: id ? `https://github.com/advisories/${id}` : '',
  severity,
  range: '<=4.0.7'
})

/** A report that holds the given advisories, keyed by the package they arrived under. */
const report = (entries = []) => ({
  auditReportVersion: 2,
  vulnerabilities: Object.fromEntries(
    entries.map(({ package: name, via, severity = 'high' }) => [
      name,
      {
        name,
        severity,
        isDirect: false,
        via: via.map((entry) => ('id' in entry ? advisory(entry.id, { ...entry, package: name }) : entry)),
        effects: [],
        range: '<=4.0.7',
        nodes: [`node_modules/${name}`],
        fixAvailable: false
      }
    ])
  ),
  metadata: { vulnerabilities: {}, dependencies: {} }
})

const PICOMATCH = 'GHSA-fc5q-39xc-vjpf'

/** A repository with a package.json; `scripts/` and the allowlist are optional. */
function repo({ exemptions, report: reportText, prodReport, label = '' } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'audit-'))
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: '@fixture/pkg', version: '0.0.0' }, null, 2))
  mkdirSync(join(cwd, 'scripts'), { recursive: true })
  const at = (name) => join(cwd, name)
  writeFileSync(at('full.json'), typeof reportText === 'string' ? reportText : JSON.stringify(reportText || report()))
  if (prodReport !== undefined)
    writeFileSync(
      at('prod.json'),
      typeof prodReport === 'string' ? prodReport : JSON.stringify(prodReport)
    )
  if (exemptions) writeFileSync(at('scripts/audit-allowlist.json'), JSON.stringify(exemptions, null, 2))
  writeFileSync(at('label.txt'), label)
  return cwd
}

const exemption = (over = {}) => ({
  id: PICOMATCH,
  packages: ['picomatch'],
  devOnly: true,
  recheckBy: '2099-01-31',
  reason: 'fixture: nothing in the production tree resolves it, and the input is a pattern this repository writes',
  ...over
})

const ALLOWLIST = 'scripts/audit-allowlist.json'

/** Run the gate, and answer with the exit code and everything it printed. */
const run = (cwd, ...argv) => {
  const result = spawnSync('node', [CLI, '--repo-dir', cwd, '--audit', ...argv], {
    encoding: 'utf8',
    env: { ...process.env }
  })
  return {
    code: result.status,
    out: `${result.stdout || ''}${result.stderr || ''}`,
    stdout: result.stdout || ''
  }
}

/** A `npm` on PATH that records its argv and prints whatever the test tells it to. */
function stubNpm(cwd, { full, prod } = {}) {
  const bin = join(cwd, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(
    join(bin, 'npm'),
    '#!/bin/sh\n' +
      'echo "$@" >> "$NPM_ARGV"\n' +
      'case "$*" in\n' +
      '  *--omit*) cat "$NPM_PROD" ;;\n' +
      '  *) cat "$NPM_REPORT" ;;\n' +
      'esac\n'
  )
  chmodSync(join(bin, 'npm'), 0o755)
  writeFileSync(join(cwd, 'argv.log'), '')
  writeFileSync(join(cwd, 'stub.json'), JSON.stringify(full || report()))
  writeFileSync(join(cwd, 'stub-prod.json'), JSON.stringify(prod || report()))
  return {
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      NPM_ARGV: join(cwd, 'argv.log'),
      NPM_REPORT: join(cwd, 'stub.json'),
      NPM_PROD: join(cwd, 'stub-prod.json')
    }
  }
}

test('a clean tree passes, and says so as output', () => {
  const cwd = repo()
  const { code, stdout } = run(cwd, '--audit-input', 'full.json')
  assert.equal(code, 0)
  assert.match(stdout, /^audited=true$/m)
  assert.match(stdout, /^advisories=0$/m)
  assert.match(stdout, /no advisory at or above low outside the allowlist/)
})

test('a dev advisory passes only when the allowlist argues for it and the production report agrees', () => {
  const cwd = repo({
    report: report([{ package: 'picomatch', via: [{ id: PICOMATCH }] }]),
    prodReport: report(),
    exemptions: [exemption()]
  })
  const { code, stdout } = run(cwd, '--audit-input', 'full.json', '--audit-prod-input', 'prod.json')
  assert.equal(code, 0, stdout)
  assert.match(stdout, /^advisories=1$/m)
  assert.match(stdout, /^exempted=1$/m)
})

test('a dev advisory nobody has argued for fails, naming the id and the package', () => {
  const cwd = repo({ report: report([{ package: 'picomatch', via: [{ id: PICOMATCH }] }]) })
  const { code, out } = run(cwd, '--audit-input', 'full.json')
  assert.equal(code, 1)
  assert.match(out, new RegExp(`${PICOMATCH} picomatch: not in the allowlist`))
  assert.match(out, /1 advisory\/advisories at or above low/)
})

test('an allowed advisory beside a new one reports the new one and not the allowed one', () => {
  const cwd = repo({
    report: report([
      { package: 'picomatch', via: [{ id: PICOMATCH }] },
      { package: 'leftpad', via: [{ id: 'GHSA-aaaa-bbbb-cccc' }] }
    ]),
    prodReport: report(),
    exemptions: [exemption()]
  })
  const { code, out } = run(cwd, '--audit-input', 'full.json', '--audit-prod-input', 'prod.json')
  assert.equal(code, 1)
  assert.match(out, /GHSA-aaaa-bbbb-cccc leftpad: not in the allowlist/)
  assert.doesNotMatch(out, new RegExp(`${PICOMATCH} picomatch: not in the allowlist`))
})

test('an advisory in the production tree fails even though the allowlist calls it devOnly', () => {
  const cwd = repo({
    report: report([{ package: 'picomatch', via: [{ id: PICOMATCH }] }]),
    prodReport: report([{ package: 'picomatch', via: [{ id: PICOMATCH }] }]),
    exemptions: [exemption()]
  })
  const { code, out } = run(cwd, '--audit-input', 'full.json', '--audit-prod-input', 'prod.json')
  assert.equal(code, 1)
  assert.match(out, /in the production tree, though the allowlist calls it devOnly \(review by 2099-01-31\)/)
})

test('an advisory in the omitted production report fails with no allowlist at all', () => {
  const cwd = repo({ report: report([{ package: 'picomatch', via: [{ id: PICOMATCH }] }]) })
  const { code, out } = run(cwd, '--audit-input', 'full.json', '--audit-omit', 'dev')
  assert.equal(code, 1)
  assert.match(out, /in the production tree, where nothing is exemptible/)
})

test('an exemption that no longer appears fails, because a stale waiver is invisible in a pass', () => {
  const cwd = repo({ exemptions: [exemption()], prodReport: report() })
  const { code, out } = run(cwd, '--audit-input', 'full.json', '--audit-prod-input', 'prod.json')
  assert.equal(code, 1)
  assert.match(out, /is in the allowlist but the report no longer carries it/)
  assert.match(out, /1 allowlist entry no longer match/)
})

test('raising the floor does not make an entry for a lower advisory look stale', () => {
  const cwd = repo({
    report: report([{ package: 'picomatch', via: [{ id: PICOMATCH, severity: 'moderate' }], severity: 'moderate' }]),
    prodReport: report(),
    exemptions: [exemption()]
  })
  const { code, stdout } = run(cwd, '--audit-input', 'full.json', '--audit-prod-input', 'prod.json', '--audit-level', 'high')
  assert.equal(code, 0, stdout)
  assert.match(stdout, /^advisories=0$/m)
})

test('a report with no vulnerabilities key is not a clean tree', () => {
  const cwd = repo({ report: { error: { code: 'ENOLOCK', summary: 'no lockfile' } } })
  const { code, out } = run(cwd, '--audit-input', 'full.json')
  assert.equal(code, 1)
  assert.match(out, /not an npm audit report: no vulnerabilities or auditReportVersion/)
})

test('non-JSON is a failure, not an empty report', () => {
  const cwd = repo({ report: 'npm ERR! something went wrong\n' })
  const { code, out } = run(cwd, '--audit-input', 'full.json')
  assert.equal(code, 1)
  assert.match(out, /this is not an npm audit report/)
})

test('an advisory this tool cannot name fails rather than being dropped', () => {
  const cwd = repo({ report: report([{ package: 'leftpad', via: [{ id: '', title: 'npm advisory 1234' }] }]) })
  const { code, out } = run(cwd, '--audit-input', 'full.json')
  assert.equal(code, 1)
  assert.match(out, /no GHSA id, so it cannot be exempted/)
})

test('an audit report version this tool does not know fails by name', () => {
  const cwd = repo({ report: { ...report(), auditReportVersion: 3 } })
  const { code, out } = run(cwd, '--audit-input', 'full.json')
  assert.equal(code, 1)
  assert.match(out, /report version 3 is not supported/)
})

test('a severity the report invents is treated as the highest, not the lowest', () => {
  const cwd = repo({
    report: report([{ package: 'leftpad', via: [{ id: 'GHSA-aaaa-bbbb-cccc', severity: 'interesting' }], severity: 'interesting' }])
  })
  const { code, out } = run(cwd, '--audit-input', 'full.json')
  assert.equal(code, 1)
  assert.match(out, /critical GHSA-aaaa-bbbb-cccc leftpad/)
})

test('an exemption for one package says nothing about the same id under another', () => {
  const cwd = repo({
    report: report([{ package: 'micromatch', via: [{ id: PICOMATCH }] }]),
    prodReport: report(),
    exemptions: [exemption()]
  })
  const { code, out } = run(cwd, '--audit-input', 'full.json', '--audit-prod-input', 'prod.json')
  assert.equal(code, 1)
  assert.match(out, /not in the allowlist/)
})

test('an exemption without a review date is a usage error, not a pass', () => {
  const cwd = repo({ exemptions: [{ ...exemption(), recheckBy: undefined }] })
  const { code, out } = run(cwd, '--audit-input', 'full.json')
  assert.equal(code, 2)
  assert.match(out, /needs recheckBy as YYYY-MM-DD/)
})

test('an exemption past its review date fails the gate', () => {
  const cwd = repo({ exemptions: [exemption({ recheckBy: '2000-01-01' })] })
  const { code, out } = run(cwd, '--audit-input', 'full.json')
  assert.equal(code, 1)
  assert.match(out, /was due for review on 2000-01-01/)
})

test('an exemption key this tool does not know is a usage error, not an inert field', () => {
  const cwd = repo({ exemptions: [{ ...exemption(), source: 1247710 }] })
  const { code, out } = run(cwd, '--audit-input', 'full.json')
  assert.equal(code, 2)
  assert.match(out, /unknown key\(s\) source/)
})

test('an exemption that is not a GHSA id is a usage error', () => {
  const cwd = repo({ exemptions: [exemption({ id: 'CVE-2026-1234' })] })
  const { code, out } = run(cwd, '--audit-input', 'full.json')
  assert.equal(code, 2)
  assert.match(out, /needs an id of the form GHSA-xxxx-xxxx-xxxx/)
})

test('a production-only gate refuses to carry exemptions that could never apply', () => {
  const cwd = repo({ exemptions: [exemption()] })
  const { code, out } = run(cwd, '--audit-input', 'full.json', '--audit-omit', 'dev')
  assert.equal(code, 2)
  assert.match(out, /judges only what ships, where nothing is exemptible/)
})

test('the gate asks npm for the full report, and for the production one only when a devOnly entry needs it', () => {
  const cwd = repo({ exemptions: [exemption()] })
  const { env } = stubNpm(cwd, {
    full: report([{ package: 'picomatch', via: [{ id: PICOMATCH }] }]),
    prod: report()
  })
  const result = spawnSync('node', [CLI, '--repo-dir', cwd, '--audit'], {
    encoding: 'utf8',
    env: { ...process.env, ...env }
  })
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
  const argv = readFileSync(join(cwd, 'argv.log'), 'utf8').trim().split('\n')
  assert.deepEqual(argv, ['audit --json', 'audit --json --omit dev'])
})

test('a tree with no exemptions is answered by one npm call', () => {
  const cwd = repo()
  const { env } = stubNpm(cwd)
  const result = spawnSync('node', [CLI, '--repo-dir', cwd, '--audit'], {
    encoding: 'utf8',
    env: { ...process.env, ...env }
  })
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
  assert.deepEqual(readFileSync(join(cwd, 'argv.log'), 'utf8').trim().split('\n'), ['audit --json'])
})

test('npm printing nothing is a failure that quotes what npm said', () => {
  const cwd = repo()
  const { env } = stubNpm(cwd)
  writeFileSync(join(cwd, 'stub.json'), '')
  const result = spawnSync('node', [CLI, '--repo-dir', cwd, '--audit'], {
    encoding: 'utf8',
    env: { ...process.env, ...env }
  })
  assert.equal(result.status, 1)
  assert.match(`${result.stdout}${result.stderr}`, /printed no report/)
})

test('the report this run judged can be written, and --dry-run says so instead', () => {
  const cwd = repo()
  const first = run(cwd, '--audit-input', 'full.json', '--audit-report', 'judged.json')
  assert.equal(first.code, 0)
  assert.deepEqual(JSON.parse(readFileSync(join(cwd, 'judged.json'), 'utf8')), report())

  const dry = run(cwd, '--audit-input', 'full.json', '--audit-report', 'dry.json', '--dry-run')
  assert.equal(dry.code, 0)
  assert.match(dry.out, /would write the audit report to dry.json/)
  assert.equal(existsSync(join(cwd, 'dry.json')), false)
})

test('a level this tool does not know is a usage error', () => {
  const cwd = repo()
  const { code, out } = run(cwd, '--audit-input', 'full.json', '--audit-level', 'shouty')
  assert.equal(code, 2)
  assert.match(out, /--audit-level must be one of info, low, moderate, high, critical/)
})

test('a recorded report that is not there is named, not read as clean', () => {
  const cwd = repo()
  const { code, out } = run(cwd, '--audit-input', 'absent.json')
  assert.equal(code, 1)
  assert.match(out, /the recorded report could not be read \(absent\.json\)/)
})

test('an allowlist the caller named that holds no array is a usage error', () => {
  const cwd = repo({ exemptions: { id: PICOMATCH } })
  const { code, out } = run(cwd, '--audit-input', 'full.json')
  assert.equal(code, 2)
  assert.match(out, /must be a JSON array of exemptions/)
})

test('--audit runs before a publish is prepared, so a failing tree is never stamped', () => {
  const cwd = repo({ report: report([{ package: 'picomatch', via: [{ id: PICOMATCH }] }]) })
  execFileSync('git', ['init', '-b', 'main'], { cwd })
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', 'add', '.'], { cwd })
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-m', 'feat: fixture'], { cwd })
  execFileSync('git', ['tag', '-a', 'v1.2.3', '-m', 'v1.2.3'], { cwd })

  const result = spawnSync(
    'node',
    [CLI, '--repo-dir', cwd, '--audit', '--audit-input', 'full.json', '--prepare-publish', '--no-registry-lookup'],
    { encoding: 'utf8' }
  )
  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`)
  assert.equal(JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')).version, '0.0.0')
})

test('the gate composes with a publish preparation that then succeeds', () => {
  const cwd = repo()
  execFileSync('git', ['init', '-b', 'main'], { cwd })
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', 'add', '.'], { cwd })
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-m', 'feat: fixture'], { cwd })
  execFileSync('git', ['tag', '-a', 'v1.2.3', '-m', 'v1.2.3'], { cwd })

  const result = spawnSync(
    'node',
    [CLI, '--repo-dir', cwd, '--audit', '--audit-input', 'full.json', '--prepare-publish', '--no-registry-lookup'],
    { encoding: 'utf8' }
  )
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
  assert.equal(JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')).version, '1.2.3')
  assert.match(result.stdout, /audited=true/)
  assert.match(result.stdout, /version=1\.2\.3/)
})

test('--assert-no-dependencies passes on a package that ships none, and names what it checked', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'assert-'))
  mkdirSync(join(cwd, 'node_modules/@sasjs/release'), { recursive: true })
  writeFileSync(
    join(cwd, 'node_modules/@sasjs/release/package.json'),
    JSON.stringify({ name: '@sasjs/release', version: '9.9.9', dependencies: {} })
  )
  const result = spawnSync('node', [CLI, '--repo-dir', cwd, '--assert-no-dependencies'], { encoding: 'utf8' })
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
  assert.match(result.stdout, /@sasjs\/release 9\.9\.9 ships no dependencies/)
})

test('--assert-no-dependencies fails naming every dependency that ships', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'assert-'))
  mkdirSync(join(cwd, 'node_modules/@sasjs/release'), { recursive: true })
  writeFileSync(
    join(cwd, 'node_modules/@sasjs/release/package.json'),
    JSON.stringify({ name: '@sasjs/release', version: '9.9.9', dependencies: { glob: '^10', undici: '^7' } })
  )
  const result = spawnSync('node', [CLI, '--repo-dir', cwd, '--assert-no-dependencies'], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(`${result.stdout}${result.stderr}`, /ships dependencies \(glob, undici\)/)
})

test('--assert-no-dependencies on a tree that has not installed it is a usage error', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'assert-'))
  const result = spawnSync('node', [CLI, '--repo-dir', cwd, '--assert-no-dependencies'], { encoding: 'utf8' })
  assert.equal(result.status, 2)
  assert.match(`${result.stdout}${result.stderr}`, /is not installed at/)
})

test('--audit alone writes nothing but its verdict', () => {
  const cwd = repo()
  const before = readFileSync(join(cwd, 'package.json'), 'utf8')
  const { code } = run(cwd, '--audit-input', 'full.json')
  assert.equal(code, 0)
  assert.equal(readFileSync(join(cwd, 'package.json'), 'utf8'), before)
  assert.equal(existsSync(join(cwd, 'judged.json')), false)
})

test('an audit flag without --audit is a usage error, not an ordinary release', () => {
  const cwd = repo()
  const result = spawnSync('node', [CLI, '--repo-dir', cwd, '--audit-level', 'high'], { encoding: 'utf8' })
  assert.equal(result.status, 2)
  assert.match(`${result.stdout}${result.stderr}`, /--audit-level needs --audit/)
})
