import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The four options that take a path a workflow computes --audit-report,
// --notes-file, --coverage-markdown and --output -- all go through writeNamed, so
// a directory that is not there is created and a write that still fails names the
// option instead of leaving a raw ENOENT at the exit code a gate uses for its
// findings. These cover the two the ratchet's own suite does not.
const CLI =
  process.env.SASJS_RELEASE_ENTRY || fileURLToPath(new URL('../release.mjs', import.meta.url))

const exec = promisify(execFile)

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

/** A repository with one releasable commit, so a notes file has something to hold. */
function repo() {
  const cwd = mkdtempSync(join(tmpdir(), 'write-'))
  git(cwd, 'init', '-b', 'main')
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: '@fixture/pkg', version: '0.0.0' }, null, 2))
  git(cwd, 'add', '.')
  git(cwd, 'commit', '-m', 'feat: fixture')
  return cwd
}

// The child runs in the fixture: `--output` and `--notes-file` take a path as the
// caller wrote it, resolved against the process, which is what a workflow's step
// output does. `--repo-dir` is passed as well so the git side works the same way.
const run = async (cwd, ...argv) => {
  try {
    const { stdout } = await exec('node', [CLI, '--repo-dir', cwd, ...argv], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, ...envelope }
    })
    return { code: 0, out: stdout }
  } catch (error) {
    return { code: error.code, out: String(error.stdout || '') + String(error.stderr || '') }
  }
}

test('--output into a directory that does not exist is created', async () => {
  const cwd = repo()
  const { code } = await run(cwd, '--dry-run', '--output', 'missing/dir/out.env')

  assert.equal(code, 0)
  assert.match(readFileSync(join(cwd, 'missing', 'dir', 'out.env'), 'utf8'), /^released=false$/m)
})

test('--notes-file into a directory that does not exist is created', async () => {
  const cwd = repo()
  const { code } = await run(cwd, '--tag', '--notes-file', 'missing/dir/notes.md')

  assert.equal(code, 0)
  assert.ok(readFileSync(join(cwd, 'missing', 'dir', 'notes.md'), 'utf8').length > 0)
})

test('a path that cannot be written names the option, at the usage exit code', async () => {
  const cwd = repo()
  writeFileSync(join(cwd, 'blocker'), 'not a directory')

  const notes = await run(cwd, '--tag', '--notes-file', 'blocker/notes.md')
  assert.equal(notes.code, 2)
  assert.match(notes.out, /--notes-file: .*blocker[/\\]notes\.md could not be written/)

  const output = await run(cwd, '--dry-run', '--output', 'blocker/out.env')
  assert.equal(output.code, 2)
  assert.match(output.out, /--output: .*blocker[/\\]out\.env could not be written/)
  assert.equal(existsSync(join(cwd, 'blocker', 'out.env')), false)
})
