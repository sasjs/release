import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

// The scorecard's Signed-Releases check reads release assets by filename, so the
// name of the bundle is the whole behaviour of this action - and a test that
// matched the name in the YAML would pass with the guards around it deleted. The
// step's `run:` body is therefore executed, which is also how the sibling suites
// here check prepare-publish and the release tool.
const action = readFileSync(
  new URL('../.github/actions/attest-assets/action.yml', import.meta.url),
  'utf8'
)

/** The shell of the step that names the bundle, with YAML block indentation removed. */
function namingScript() {
  const lines = action.split('\n')
  const at = lines.findIndex((line) => line.trim() === 'run: |')
  assert.ok(at > 0, 'the action must have a run: | step')

  const indent = lines[at].search(/\S/)
  const body = []
  for (const line of lines.slice(at + 1)) {
    if (line.trim() === '') {
      body.push('')
      continue
    }
    if (line.search(/\S/) <= indent) break
    body.push(line.slice(indent + 2))
  }
  assert.ok(body.join('\n').includes('provenance-'), 'the extracted block is not the naming step')
  return body.join('\n')
}

/** Run the naming step with the given environment, in its own directory. */
function run({ bundle, version, out = 'dist' } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'attest-'))
  const env = { ...process.env, OUT: out, GITHUB_OUTPUT: join(cwd, 'output'), VERSION: version ?? '' }
  if (bundle !== undefined) env.BUNDLE = bundle
  else delete env.BUNDLE
  writeFileSync(env.GITHUB_OUTPUT, '')

  const result = spawnSync('bash', ['-c', namingScript()], { cwd, env, encoding: 'utf8' })
  return {
    cwd,
    status: result.status,
    out: `${result.stdout}${result.stderr}`,
    output: readFileSync(env.GITHUB_OUTPUT, 'utf8')
  }
}

const bundleIn = (cwd, name = 'bundle.jsonl', body = '{"statement":1}\n') =>
  writeFileSync(join(cwd, name), body) ?? join(cwd, name)

test('a real bundle is copied to the name the scorecard scores, and reported', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'attest-src-'))
  const bundle = bundleIn(cwd)
  const result = run({ bundle, version: 'v1.2.3' })

  assert.equal(result.status, 0, result.out)
  assert.equal(result.output.trim(), 'path=dist/provenance-1.2.3.intoto.jsonl')
  assert.equal(readFileSync(join(result.cwd, 'dist', 'provenance-1.2.3.intoto.jsonl'), 'utf8'), '{"statement":1}\n')
})

test('a version without its v, and a custom output directory, are both honoured', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'attest-src-'))
  const result = run({ bundle: bundleIn(cwd), version: '2.0.0', out: 'artefacts' })

  assert.equal(result.status, 0, result.out)
  assert.equal(result.output.trim(), 'path=artefacts/provenance-2.0.0.intoto.jsonl')
})

test('an empty version is refused, and nothing is written', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'attest-src-'))
  const result = run({ bundle: bundleIn(cwd), version: 'v' })

  assert.equal(result.status, 1)
  assert.match(result.out, /attest-assets: version is empty/)
  assert.equal(existsSync(join(result.cwd, 'dist')), false)
})

test('a version carrying characters a file name cannot hold is refused', () => {
  // `pkg/v1.2.3` would reach cp as dist/provenance-pkg/1.2.3; a space would end up
  // inside the asset name; a newline would write a second line into $GITHUB_OUTPUT,
  // which truncates the reported path and adds a stray step output.
  for (const version of ['pkg/v1.2.3', '1.0 0', '1.0\n0', 'a	b', 'v1.0;rm']) {
    const cwd = mkdtempSync(join(tmpdir(), 'attest-src-'))
    const result = run({ bundle: bundleIn(cwd), version })

    assert.equal(result.status, 1, `version ${JSON.stringify(version)} must be refused`)
    assert.match(result.out, /has characters that are not valid in a file name/)
    assert.equal(result.output.trim(), '', 'a refused run must not report a path')
    assert.equal(existsSync(join(result.cwd, 'dist')), false)
  }
})

test('a version that is only a path segment is refused', () => {
  for (const version of ['.', '..']) {
    const cwd = mkdtempSync(join(tmpdir(), 'attest-src-'))
    const result = run({ bundle: bundleIn(cwd), version })

    assert.equal(result.status, 1, `version ${version} must be refused`)
    assert.match(result.out, /is not a single path segment/)
  }
})

test('an empty output directory is refused by this action, not by mkdir', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'attest-src-'))
  const result = run({ bundle: bundleIn(cwd), version: '1.0.0', out: '' })

  assert.equal(result.status, 1)
  assert.match(result.out, /attest-assets: output-dir is empty/)
  assert.doesNotMatch(result.out, /mkdir/)
  assert.equal(result.output.trim(), '')
})

test('an unattested bundle path is refused by this action, not by cp', () => {
  for (const bundle of [undefined, '', '/nonexistent/bundle.jsonl']) {
    const result = run({ bundle, version: '1.0.0' })

    assert.equal(result.status, 1, `bundle ${String(bundle)} must be refused`)
    assert.match(result.out, /attest-assets: the attestation reported no bundle/)
    assert.doesNotMatch(result.out, /cannot stat/)
  }
})

test('a zero-byte bundle is refused before anything is written', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'attest-src-'))
  const result = run({ bundle: bundleIn(cwd, 'empty.jsonl', ''), version: '1.0.0' })

  assert.equal(result.status, 1)
  assert.match(result.out, /the bundle at .* is empty - the attestation produced nothing to attach/)
  assert.equal(result.output.trim(), '', 'a refused run must not report a path')
  // a refused run must leave nothing for a release to attach: the directory is the
  // artefact of a partial write, and its absence is the property being pinned
  assert.equal(existsSync(join(result.cwd, 'dist')), false)
})

test('the attestation is generated by a pinned action, not a float', () => {
  const pin = action.match(/uses: (actions\/attest-build-provenance@\S+)/)?.[1] ?? ''
  assert.match(pin, /@[0-9a-f]{40}$/, 'the attest action must be pinned to a full commit')
})

test('the permissions a caller must grant are stated where they will look', () => {
  // a composite action cannot grant its own, and the attestation fails without both
  assert.match(action, /id-token: write/)
  assert.match(action, /attestations: write/)
  assert.doesNotMatch(action, /^permissions:/m, 'a composite action declares no permissions of its own')
})
