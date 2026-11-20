import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// scripts/mutate.mjs runs this suite against a deliberately broken copy, so the
// entry point is overridable; everything else runs the real one.
const CLI =
  process.env.SASJS_RELEASE_ENTRY || fileURLToPath(new URL('../release.mjs', import.meta.url))

const exec = promisify(execFile)

/**
 * A jest json-summary report from four percentages, in the order the tool compares
 * them. Written the way jest writes it, including the per-file keys the tool ignores.
 */
const summary = ([statements, branches, functions, lines]) => ({
  total: {
    lines: { total: 100, covered: 90, skipped: 0, pct: lines },
    statements: { total: 100, covered: 90, skipped: 0, pct: statements },
    functions: { total: 10, covered: 9, skipped: 0, pct: functions },
    branches: { total: 10, covered: 9, skipped: 0, pct: branches }
  },
  'src/index.js': { lines: { total: 1, covered: 1, skipped: 0, pct: 100 } }
})

/** A report is written as given, or built from four percentages. */
const body = (value) =>
  typeof value === 'string'
    ? value
    : Array.isArray(value)
      ? JSON.stringify(summary(value))
      : JSON.stringify(value)

/** A repository with the head and base summaries where the defaults look for them. */
function repo({ head, base, headPath, basePath } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'ratchet-'))

  if (head !== null) {
    const at = join(cwd, headPath || join('coverage', 'coverage-summary.json'))
    mkdirSync(join(at, '..'), { recursive: true })
    writeFileSync(at, body(head ?? [90, 80, 70, 90]))
  }

  if (base !== null) {
    const at = join(cwd, basePath || join('coverage-base', 'coverage-summary.json'))
    mkdirSync(join(at, '..'), { recursive: true })
    writeFileSync(at, body(base ?? [90, 80, 70, 90]))
  }

  return cwd
}

const run = async (cwd, ...argv) => {
  try {
    const { stdout } = await exec('node', [CLI, '--repo-dir', cwd, ...argv], {
      encoding: 'utf8'
    })
    return { code: 0, out: stdout }
  } catch (error) {
    return {
      code: error.code,
      out: String(error.stdout || '') + String(error.stderr || '')
    }
  }
}

const comment = (cwd) => readFileSync(join(cwd, 'coverage-comment.md'), 'utf8')

test('a pull request that loses coverage fails, and names the metric', async () => {
  const cwd = repo({ head: [90, 79, 70, 90], base: [90, 80, 70, 90] })
  const { code, out } = await run(cwd, '--coverage-ratchet', '--coverage-markdown', 'coverage-comment.md')

  assert.equal(code, 1)
  assert.match(out, /branches: 80% -> 79% \(-1\)/)
  assert.match(out, /coverage=regressed/)
  assert.match(comment(cwd), /\*\*1 metric\(s\) below the base/)
  assert.match(comment(cwd), /\| branches \| 80% \| 79% \| -1 \| regressed \|/)
})

test('an unchanged tree passes and reports every metric', async () => {
  const cwd = repo({ base: [90, 80, 70, 90] })
  const { code, out } = await run(cwd, '--coverage-ratchet')

  assert.equal(code, 0)
  assert.match(out, /statements\s+base\s+90\s+head\s+90\s+0\s+unchanged/)
  assert.match(out, /coverage=ok/)
  assert.match(out, /regressions=0/)
  assert.match(out, /No metric is below the base branch/)
})

test('an improvement passes and says so in the comment', async () => {
  const cwd = repo({ head: [95, 80, 70, 90], base: [90, 80, 70, 90] })
  const { code, out } = await run(cwd, '--coverage-ratchet', '--coverage-markdown', 'coverage-comment.md')

  assert.equal(code, 0)
  assert.match(out, /improved/)
  assert.match(comment(cwd), /No metric is below the base\./)
})

test('a drop inside the tolerance is unchanged, and one outside it is not', async () => {
  const inside = repo({ head: [89.97, 80, 70, 90], base: [90, 80, 70, 90] })
  const outside = repo({ head: [89.94, 80, 70, 90], base: [90, 80, 70, 90] })

  assert.equal((await run(inside, '--coverage-ratchet')).code, 0)
  assert.equal((await run(outside, '--coverage-ratchet')).code, 1)
})

test('the tolerance applies to the unrounded difference', async () => {
  // 90.04 - 90.10 is -0.06: a drop of more than 0.05pt that rounds to -0.1 for
  // display. Rounding the delta before comparing would read -0.1, so the case that
  // catches the bug is the one where the two disagree: -0.054 rounds to -0.05.
  const cwd = repo({ head: [90.046, 80, 70, 90], base: [90.1, 80, 70, 90] })
  const { code, out } = await run(cwd, '--coverage-ratchet')

  assert.equal(code, 1)
  assert.match(out, /-0\.05\s+regressed/)
})

test('the tolerance is exact at its own boundary', async () => {
  // exactly -0.05 is not a regression: the rule is "more than the tolerance"
  const cwd = repo({ head: [89.95, 80, 70, 90], base: [90, 80, 70, 90] })

  assert.equal((await run(cwd, '--coverage-ratchet')).code, 0)
})

test('a custom tolerance is honoured', async () => {
  const cwd = repo({ head: [89, 80, 70, 90], base: [90, 80, 70, 90] })

  assert.equal((await run(cwd, '--coverage-ratchet')).code, 1)
  assert.equal((await run(cwd, '--coverage-ratchet', '--coverage-tolerance', '1')).code, 0)
})

test('no baseline fails rather than passing, and says how to get one', async () => {
  const cwd = repo({ base: null })
  const { code, out } = await run(cwd, '--coverage-ratchet', '--coverage-markdown', 'coverage-comment.md')

  assert.equal(code, 1)
  assert.match(out, /No baseline at .*coverage-base/)
  assert.match(out, /gh workflow run coverage-baseline\.yml|default branch/)
  assert.match(out, /coverage=missing/)
  assert.match(comment(cwd), /No baseline was available, so the comparison did not run/)
})

test('a missing baseline can be skipped, for a base commit that predates the workflow', async () => {
  const cwd = repo({ base: null })
  const { code, out } = await run(
    cwd,
    '--coverage-ratchet',
    '--coverage-missing-baseline',
    'skip',
    '--coverage-markdown',
    'coverage-comment.md'
  )

  assert.equal(code, 0)
  assert.match(out, /nothing to compare against/)
  assert.match(out, /coverage=skipped/)
  assert.match(comment(cwd), /No comparison was made/)
})

test('a baseline that is not valid JSON is a usage error, not a finding', async () => {
  const cwd = repo({ base: 'not json at all' })
  const { code, out } = await run(cwd, '--coverage-ratchet')

  assert.equal(code, 2)
  assert.match(out, /could not be read/)
})

test('a report with no total entry is a usage error', async () => {
  const cwd = repo({ base: '{"src/index.js": {"lines": {"pct": 1}}}' })
  const { code, out } = await run(cwd, '--coverage-ratchet')

  assert.equal(code, 2)
  assert.match(out, /carries no `total` entry/)
})

test('a report missing one of the four metrics is a usage error', async () => {
  const broken = summary([90, 80, 70, 90])
  delete broken.total.branches
  const cwd = repo({ base: broken })
  const { code, out } = await run(cwd, '--coverage-ratchet')

  assert.equal(code, 2)
  assert.match(out, /no numeric `branches` percentage/)
})

test('a metric whose pct is not a number is a usage error', async () => {
  const broken = summary([90, 80, 70, 90])
  broken.total.lines.pct = '90'
  const cwd = repo({ base: broken })
  const { code, out } = await run(cwd, '--coverage-ratchet')

  assert.equal(code, 2)
  assert.match(out, /no numeric `lines` percentage/)
})

test('the head summary is read too, and a missing one is a usage error', async () => {
  const cwd = repo({ head: null })
  const { code, out } = await run(cwd, '--coverage-ratchet')

  assert.equal(code, 2)
  assert.match(out, /head summary at .*coverage-summary\.json could not be read/)
})

test('a tolerance that is not a non-negative number is a usage error', async () => {
  const cwd = repo({})

  for (const tolerance of ['0.5pt', '-1']) {
    const { code, out } = await run(cwd, '--coverage-ratchet', '--coverage-tolerance', tolerance)
    assert.equal(code, 2)
    assert.match(out, /--coverage-tolerance must be a non-negative number/)
  }
})

test('an unknown missing-baseline mode is a usage error', async () => {
  const cwd = repo({})
  const { code, out } = await run(cwd, '--coverage-ratchet', '--coverage-missing-baseline', 'warn')

  assert.equal(code, 2)
  assert.match(out, /must be fail or skip/)
})

test('a ratchet option without the mode is refused', async () => {
  const cwd = repo({})
  const { code, out } = await run(cwd, '--coverage-head', 'coverage/coverage-summary.json')

  assert.equal(code, 2)
  assert.match(out, /--coverage-head needs --coverage-ratchet/)
})

test('--dry-run writes no comment and still returns the verdict', async () => {
  const cwd = repo({ head: [80, 80, 70, 90] })
  const { code, out } = await run(
    cwd,
    '--coverage-ratchet',
    '--coverage-markdown',
    'coverage-comment.md',
    '--dry-run'
  )

  assert.equal(code, 1)
  assert.match(out, /would write the coverage comment to coverage-comment\.md/)
  assert.equal(existsSync(join(cwd, 'coverage-comment.md')), false)
})

test('relative paths are resolved against --repo-dir, and absolute ones are not', async () => {
  const cwd = repo({ headPath: 'elsewhere/head.json', basePath: 'elsewhere/base.json' })

  const relative = await run(
    cwd,
    '--coverage-ratchet',
    '--coverage-head',
    'elsewhere/head.json',
    '--coverage-base',
    'elsewhere/base.json'
  )
  assert.equal(relative.code, 0)

  const outside = mkdtempSync(join(tmpdir(), 'ratchet-elsewhere-'))
  writeFileSync(join(outside, 'base.json'), JSON.stringify(summary([90, 80, 70, 90])))

  const direct = await run(
    cwd,
    '--coverage-ratchet',
    '--coverage-head',
    'elsewhere/head.json',
    '--coverage-base',
    join(outside, 'base.json')
  )
  assert.equal(direct.code, 0)
})

test('the comment carries the marker, the note and one row per metric', async () => {
  const cwd = repo({ base: [90, 80, 70, 90] })
  await run(
    cwd,
    '--coverage-ratchet',
    '--coverage-markdown',
    'coverage-comment.md',
    '--coverage-note',
    'Compared against the newest commit the base descends from.'
  )

  const body = comment(cwd)
  assert.match(body, /^<!-- coverage-ratchet -->/)
  assert.match(body, /Compared against the newest commit the base descends from\./)
  assert.equal(body.split('\n').filter((line) => line.startsWith('| ') && !line.startsWith('| Metric') && !line.startsWith('| ---')).length, 4)
})
