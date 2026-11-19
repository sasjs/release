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
        via: via.map((entry) => (entry && typeof entry === 'object' && 'id' in entry ? advisory(entry.id, { ...entry, package: name }) : entry)),
        effects: [],
        range: '<=4.0.7',
        nodes: [`node_modules/${name}`],
        fixAvailable: false
      }
    ])
  ),
  metadata: {
    vulnerabilities: Object.fromEntries([
      ...['info', 'low', 'moderate', 'high', 'critical'].map((severity) => [severity, entries.filter((entry) => {
        const value = entry.severity || 'high'
        return (['info', 'low', 'moderate', 'high', 'critical'].includes(value) ? value : 'critical') === severity
      }).length]),
      ['total', entries.length]
    ]),
    dependencies: {}
  }
})

const PICOMATCH = 'GHSA-fc5q-39xc-vjpf'

// A runner has no git identity, and an annotated tag needs one; the fixture sets
// its own rather than depending on the machine it runs on.
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

test('a real npm v2 report accepts indirect chains and counts packages rather than advisories', () => {
  // Captured with npm audit --json --package-lock-only in sasjs-cli, npm 12.2.3.
  const fixture = fileURLToPath(new URL('./fixtures/npm-audit-sasjs-cli.json', import.meta.url))
  const sample = JSON.parse(readFileSync(fixture, 'utf8'))
  assert.ok(sample.metadata.vulnerabilities.total > 0)
  assert.ok(Object.values(sample.vulnerabilities).some((vuln) => vuln.via.some((via) => typeof via === 'string')))
  const cwd = repo({ report: sample })
  const low = run(cwd, '--audit-input', 'full.json')
  assert.equal(low.code, 1, low.out)
  assert.match(low.out, /not in the allowlist/)
  const high = run(cwd, '--audit-input', 'full.json', '--audit-level', 'high')
  assert.equal(high.code, 0, high.out)
})

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

test('an exemption without devOnly cannot waive an advisory in production', () => {
  const vuln = report([{ package: 'picomatch', via: [{ id: PICOMATCH }] }])
  const cwd = repo({ report: vuln, prodReport: vuln, exemptions: [exemption({ devOnly: undefined })] })
  const { code, out } = run(cwd, '--audit-input', 'full.json', '--audit-prod-input', 'prod.json')
  assert.equal(code, 1, out)
  assert.match(out, /in the production tree, where nothing is exemptible/)
  assert.doesNotMatch(out, /calls it devOnly/)
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

test('an array of vulnerabilities is malformed, not a clean report', () => {
  const cwd = repo({ report: { ...report(), vulnerabilities: [] } })
  const { code, out } = run(cwd, '--audit-input', 'full.json')
  assert.equal(code, 1, out)
  assert.match(out, /not an npm audit report/)
})

test('metadata claiming affected packages in an empty report cannot pass', () => {
  const sample = report()
  sample.metadata.vulnerabilities = { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 }
  const { code, out } = run(repo({ report: sample }), '--audit-input', 'full.json')
  assert.equal(code, 1, out)
  assert.match(out, /metadata.*inconsistent/i)
})

test('missing affected-package metadata cannot be interpreted as a clean audit', () => {
  const sample = report()
  delete sample.metadata.vulnerabilities
  const { code, out } = run(repo({ report: sample }), '--audit-input', 'full.json')
  assert.equal(code, 1, out)
  assert.match(out, /metadata.*missing/i)
})

test('metadata total cannot count packages absent from the report', () => {
  const sample = report()
  sample.metadata.vulnerabilities.total = 1
  const { code, out } = run(repo({ report: sample }), '--audit-input', 'full.json')
  assert.equal(code, 1, out)
  assert.match(out, /metadata.*inconsistent/i)
})

test('metadata severity counts must agree with the affected package entries', () => {
  const sample = report([{ package: 'a', via: [{ id: PICOMATCH }] }])
  sample.metadata.vulnerabilities.high = 0
  sample.metadata.vulnerabilities.low = 1
  const { code, out } = run(repo({ report: sample }), '--audit-input', 'full.json', '--audit-level', 'critical')
  assert.equal(code, 1, out)
  assert.match(out, /metadata.*inconsistent/i)
})

test('an npm error accompanying an otherwise clean report fails closed', () => {
  const sample = { ...report(), error: { code: 'EFAIL', summary: 'audit incomplete' } }
  const { code, out } = run(repo({ report: sample }), '--audit-input', 'full.json')
  assert.equal(code, 1, out)
  assert.match(out, /audit.*error/i)
})

test('non-JSON is a failure, not an empty report', () => {
  const cwd = repo({ report: 'npm ERR! something went wrong\n' })
  const { code, out } = run(cwd, '--audit-input', 'full.json')
  assert.equal(code, 1)
  assert.match(out, /this is not an npm audit report/)
})

test('an unresolved indirect vulnerability cannot disappear from the verdict', () => {
  const cwd = repo({ report: report([{ package: 'wrapper', via: ['missing'] }]) })
  const { code, out } = run(cwd, '--audit-input', 'full.json')
  assert.equal(code, 1, out)
  assert.match(out, /unresolved.*missing/i)
})

test('a cycle with no reachable advisory fails closed', () => {
  const cwd = repo({ report: report([{ package: 'a', via: ['b'] }, { package: 'b', via: ['a'] }]) })
  const { code, out } = run(cwd, '--audit-input', 'full.json')
  assert.equal(code, 1, out)
  assert.match(out, /no reachable advisory/i)
})

test('an indirect cycle with a reachable advisory remains a valid report', () => {
  const sample = report([{ package: 'a', via: ['b', { id: PICOMATCH }] }, { package: 'b', via: ['a'] }])
  const { code, out } = run(repo({ report: sample }), '--audit-input', 'full.json')
  assert.equal(code, 1, out)
  assert.match(out, /GHSA-fc5q-39xc-vjpf a: not in the allowlist/)
  assert.doesNotMatch(out, /no reachable advisory/)
})

test('a vulnerability whose name differs from its key is not exempted under the wrong package', () => {
  const sample = report([{ package: 'picomatch', via: [{ id: PICOMATCH }] }])
  sample.vulnerabilities.picomatch.name = 'different-package'
  const cwd = repo({ report: sample, prodReport: report(), exemptions: [exemption()] })
  const { code, out } = run(cwd, '--audit-input', 'full.json', '--audit-prod-input', 'prod.json')
  assert.equal(code, 1, out)
  assert.match(out, /invalid.*vulnerability.*picomatch/i)
})

test('a malformed via alongside a valid advisory cannot be ignored', () => {
  const cwd = repo({ report: report([{ package: 'a', via: [null, { id: PICOMATCH }] }]), exemptions: [exemption({ packages: ['a'] })], prodReport: report() })
  const { code, out } = run(cwd, '--audit-input', 'full.json', '--audit-prod-input', 'prod.json')
  assert.equal(code, 1, out)
  assert.match(out, /invalid.*via/i)
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

test('an unknown package severity cannot suppress a known lower advisory severity', () => {
  const sample = report([{ package: 'a', severity: 'unknown', via: [{ id: PICOMATCH, severity: 'low' }] }])
  const { code, out } = run(repo({ report: sample }), '--audit-input', 'full.json', '--audit-level', 'high')
  assert.equal(code, 1, out)
  assert.match(out, /severity/i)
})

test('a report cannot lower a direct advisory severity below the package severity', () => {
  const sample = report([{ package: 'a', severity: 'high', via: [{ id: PICOMATCH, severity: 'low' }] }])
  const { code, out } = run(repo({ report: sample }), '--audit-input', 'full.json', '--audit-level', 'high')
  assert.equal(code, 1, out)
  assert.match(out, /severity.*inconsistent/i)
})

test('duplicate advisory ids retain the highest severity regardless of order', () => {
  const cwd = repo({ report: report([{ package: 'a', via: [{ id: PICOMATCH, severity: 'low' }, { id: PICOMATCH, severity: 'high' }] }]) })
  const { code, out } = run(cwd, '--audit-input', 'full.json', '--audit-level', 'high')
  assert.equal(code, 1, out)
  assert.match(out, /high GHSA-fc5q-39xc-vjpf a/)
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

test('an impossible review date cannot turn into an indefinite exemption', () => {
  const cwd = repo({ exemptions: [exemption({ recheckBy: '2099-99-99' })] })
  const { code, out } = run(cwd, '--audit-input', 'full.json')
  assert.equal(code, 2, out)
  assert.match(out, /valid.*date/i)
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
  assert.deepEqual(argv, [
    'audit --json --include prod --include dev --include optional --include peer',
    'audit --json --include prod --include optional --include peer --omit dev'
  ])
})

test('npm is asked for production even when devOnly is false', () => {
  const vuln = report([{ package: 'picomatch', via: [{ id: PICOMATCH }] }])
  const cwd = repo({ exemptions: [exemption({ devOnly: false })] })
  const { env } = stubNpm(cwd, { full: vuln, prod: vuln })
  const result = spawnSync('node', [CLI, '--repo-dir', cwd, '--audit'], { encoding: 'utf8', env: { ...process.env, ...env } })
  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`)
  assert.match(result.stdout, /in the production tree, where nothing is exemptible/)
  assert.deepEqual(readFileSync(join(cwd, 'argv.log'), 'utf8').trim().split('\n'), [
    'audit --json --include prod --include dev --include optional --include peer',
    'audit --json --include prod --include optional --include peer --omit dev'
  ])
})

test('a comma-separated omit set is passed to npm as repeated omit options', () => {
  const cwd = repo()
  const { env } = stubNpm(cwd)
  writeFileSync(join(cwd, 'bin/npm'),
    '#!/usr/bin/env node\n' +
    "require('fs').writeFileSync(process.env.NPM_ARGV, JSON.stringify(process.argv.slice(2)))\n" +
    "process.stdout.write(require('fs').readFileSync(process.env.NPM_REPORT))\n"
  )
  const result = spawnSync('node', [CLI, '--repo-dir', cwd, '--audit', '--audit-omit', 'dev,optional'], {
    encoding: 'utf8', env: { ...process.env, ...env }
  })
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
  assert.deepEqual(JSON.parse(readFileSync(join(cwd, 'argv.log'), 'utf8')),
    ['audit', '--json', '--include', 'prod', '--include', 'peer', '--omit', 'dev', '--omit', 'optional'])
})

test('all supported npm omit values are accepted', () => {
  for (const omit of ['dev', 'optional', 'peer', 'dev,optional,peer']) {
    const cwd = repo()
    const { code, out } = run(cwd, '--audit-input', 'full.json', '--audit-omit', omit)
    assert.equal(code, 0, `omit=${omit}: ${out}`)
    assert.match(out, new RegExp(`^scope=omit:${omit}$`, 'm'))
  }
})

test('unsupported omit values are usage errors even with a recorded report', () => {
  for (const omit of ['invalid', 'dev,invalid', 'dev,', ',dev', '', ' dev']) {
    const cwd = repo()
    const { code, out } = run(cwd, '--audit-input', 'full.json', '--audit-omit', omit)
    assert.equal(code, 2, `omit=${JSON.stringify(omit)}: ${out}`)
    assert.match(out, /--audit-omit must be a comma-separated list of dev, optional, peer/)
  }
})

test('an optional-only omission reports its scope without calling it the production tree', () => {
  const cwd = repo({ report: report([{ package: 'picomatch', via: [{ id: PICOMATCH }] }]) })
  const { code, out } = run(cwd, '--audit-input', 'full.json', '--audit-omit', 'optional')
  assert.equal(code, 1)
  assert.match(out, /^scope=omit:optional$/m)
  assert.match(out, /in the omitted tree, where nothing is exemptible/)
  assert.doesNotMatch(out, /production tree|only what ships/)
})

test('an optional-only omission does not claim exemptions are in a production-only gate', () => {
  const cwd = repo({ exemptions: [exemption()] })
  const { code, out } = run(cwd, '--audit-input', 'full.json', '--audit-omit', 'optional')
  assert.equal(code, 2)
  assert.match(out, /judges an omitted tree, where nothing is exemptible/)
  assert.doesNotMatch(out, /production tree|only what ships/)
})

test('a tree with no exemptions is answered by one npm call', () => {
  const cwd = repo()
  const { env } = stubNpm(cwd)
  const result = spawnSync('node', [CLI, '--repo-dir', cwd, '--audit'], {
    encoding: 'utf8',
    env: { ...process.env, ...env }
  })
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
  assert.deepEqual(readFileSync(join(cwd, 'argv.log'), 'utf8').trim().split('\n'), ['audit --json --include prod --include dev --include optional --include peer'])
})

test('npm exit 1 with an empty report is not treated as a clean audit', () => {
  const cwd = repo()
  const { env } = stubNpm(cwd)
  writeFileSync(join(cwd, 'bin/npm'), '#!/bin/sh\ncat "$NPM_REPORT"\nexit 1\n')
  const result = spawnSync('node', [CLI, '--repo-dir', cwd, '--audit'], { encoding: 'utf8', env: { ...process.env, ...env } })
  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`)
  assert.match(`${result.stdout}${result.stderr}`, /npm.*exit.*1.*empty/i)
})

test('npm failing to run cannot supply a valid-looking clean report', () => {
  const cwd = repo()
  const { env } = stubNpm(cwd)
  writeFileSync(join(cwd, 'bin/npm'), '#!/bin/sh\ncat "$NPM_REPORT"\nexit 2\n')
  const result = spawnSync('node', [CLI, '--repo-dir', cwd, '--audit'], { encoding: 'utf8', env: { ...process.env, ...env } })
  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`)
  assert.match(`${result.stdout}${result.stderr}`, /npm.*exit.*2/i)
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
  git(cwd, 'init', '-b', 'main')
  git(cwd, 'add', '.')
  git(cwd, 'commit', '-m', 'feat: fixture')
  git(cwd, 'tag', '-a', 'v1.2.3', '-m', 'v1.2.3')

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
  git(cwd, 'init', '-b', 'main')
  git(cwd, 'add', '.')
  git(cwd, 'commit', '-m', 'feat: fixture')
  git(cwd, 'tag', '-a', 'v1.2.3', '-m', 'v1.2.3')

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

function runDependencyAssertion(fields) {
  const cwd = mkdtempSync(join(tmpdir(), 'assert-'))
  mkdirSync(join(cwd, 'node_modules/@sasjs/release'), { recursive: true })
  writeFileSync(join(cwd, 'node_modules/@sasjs/release/package.json'), JSON.stringify({ version: '9.9.9', ...fields }))
  return spawnSync('node', [CLI, '--repo-dir', cwd, '--assert-no-dependencies'], { encoding: 'utf8' })
}

test('--assert-no-dependencies rejects peer dependencies by name', () => {
  const result = runDependencyAssertion({ peerDependencies: { 'peer-fixture': '^1' } })
  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`)
  assert.match(`${result.stdout}${result.stderr}`, /peer-fixture/)
})

test('--assert-no-dependencies rejects optional dependencies by name', () => {
  const result = runDependencyAssertion({ optionalDependencies: { 'optional-fixture': '^1' } })
  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`)
  assert.match(`${result.stdout}${result.stderr}`, /optional-fixture/)
})

test('--assert-no-dependencies rejects bundledDependencies arrays by package name', () => {
  const result = runDependencyAssertion({ bundledDependencies: ['@scope/bundled', 'other-bundled'] })
  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`)
  assert.match(`${result.stdout}${result.stderr}`, /@scope\/bundled, other-bundled/)
})

test('--assert-no-dependencies rejects bundleDependencies arrays by package name', () => {
  const result = runDependencyAssertion({ bundleDependencies: ['alias-fixture'] })
  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`)
  assert.match(`${result.stdout}${result.stderr}`, /alias-fixture/)
})

test('--assert-no-dependencies rejects bundledDependencies object keys by name', () => {
  const result = runDependencyAssertion({ bundledDependencies: { 'object-fixture': '^1' } })
  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`)
  assert.match(`${result.stdout}${result.stderr}`, /object-fixture/)
})

test('--assert-no-dependencies rejects bundleDependencies object keys by name', () => {
  const result = runDependencyAssertion({ bundleDependencies: { 'alias-object-fixture': '^1' } })
  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`)
  assert.match(`${result.stdout}${result.stderr}`, /alias-object-fixture/)
})

test('--assert-no-dependencies permits dev dependencies and empty or boolean bundle declarations', () => {
  for (const fields of [
    { devDependencies: { 'dev-fixture': '^1' } },
    { dependencies: {}, peerDependencies: {}, optionalDependencies: {}, bundledDependencies: [], bundleDependencies: [] },
    { bundledDependencies: false, bundleDependencies: true },
    { bundledDependencies: {}, bundleDependencies: {} }
  ]) {
    const result = runDependencyAssertion(fields)
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
    assert.match(result.stdout, /@sasjs\/release 9\.9\.9 ships no dependencies/)
  }
})

test('--assert-no-dependencies reports distinct names across all runtime sections', () => {
  const result = runDependencyAssertion({
    dependencies: { direct: '1', shared: '1' },
    peerDependencies: { peer: '1', shared: '1' },
    optionalDependencies: { optional: '1' },
    bundledDependencies: ['bundled', 'shared'],
    bundleDependencies: ['alias']
  })
  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`)
  assert.match(`${result.stdout}${result.stderr}`, /ships dependencies \(direct, shared, peer, optional, bundled, alias\)/)
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

test('recorded replays with a false devOnly exemption require a production input and never call npm', () => {
  const cwd = repo({ exemptions: [exemption({ devOnly: false })] })
  const { env } = stubNpm(cwd)
  const result = spawnSync('node', [CLI, '--repo-dir', cwd, '--audit', '--audit-input', 'full.json'], {
    encoding: 'utf8', env: { ...process.env, ...env }
  })
  assert.equal(result.status, 2, `${result.stdout}${result.stderr}`)
  assert.match(`${result.stdout}${result.stderr}`, /needs --audit-prod-input/)
  assert.equal(readFileSync(join(cwd, 'argv.log'), 'utf8'), '')
})

test('a recorded replay never asks npm, so a devOnly entry needs both inputs', () => {
  const cwd = repo({ exemptions: [exemption()], prodReport: report() })
  const result = spawnSync('node', [CLI, '--repo-dir', cwd, '--audit', '--audit-input', 'full.json'], {
    encoding: 'utf8'
  })
  assert.equal(result.status, 2, `${result.stdout}${result.stderr}`)
  assert.match(`${result.stdout}${result.stderr}`, /needs --audit-prod-input/)
  // nothing was run: no npm, and no verdict about the tree
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /not an npm audit report/)
})
