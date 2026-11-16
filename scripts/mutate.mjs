#!/usr/bin/env node
/**
 * Mutation check: does the suite actually fail when the code is wrong?
 *
 * Coverage says which lines ran. It does not say whether anything would have
 * noticed if they had run differently. This script takes each guard the tool
 * depends on, breaks it in a copy of release.mjs, runs the suite against that
 * copy, and requires at least one test to fail. A mutation that survives is a
 * guard nothing is checking - which is how an assertion can be deleted in a
 * refactor and never missed.
 *
 * The list is deliberately small and named: each entry is a property that has
 * either broken in production or been argued about in review.
 */
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'release.mjs')

/** { name, find, replace } - find must match exactly once. */
const mutations = [
  {
    name: 'the shallow clone is allowed to skip',
    find: `      if (git(cwd, 'rev-parse', '--is-shallow-repository') === 'true')`,
    replace: `      if (false)`
  },
  {
    name: 'a tag off the branch is published anyway',
    find: `  if (!holding) fail(\`\${tag} is not on \${branch} - refusing to publish it\`)`,
    replace: `  void holding`
  },
  {
    name: '--no-registry-lookup asks anyway',
    find: `  const lookup = !flag('no-registry-lookup')`,
    replace: `  const lookup = true`
  },
  {
    name: 'an unpublished version is treated as published',
    find: `  if (response.status === 404) return false`,
    replace: `  if (response.status === 404) return true`
  },
  {
    name: 'the release is created as a draft never, whatever was asked',
    find: `draft: Boolean(draft)`,
    replace: `draft: false`,
    all: true // github and gitea payloads both carry it
  },
  {
    name: 'an unknown flag is ignored again',
    find: `    if (!known.has(token.slice(2))) fail(\`unknown flag \${token} - run --help for the list\`)`,
    replace: `    if (false) fail(\`unknown flag \${token}\`)`
  },
  {
    name: 'the tag the host created is not created locally',
    find: `  if (succeeds(() => git(cwd, 'rev-parse', '-q', '--verify', \`refs/tags/\${tag}\`))) return false
  return succeeds(() => git(cwd, 'tag', tag, commit))`,
    replace: `  return false`
  },
  {
    name: 'a breaking change stops bumping the major',
    find: `    breaking: Boolean(bang) || /^BREAKING[ -]CHANGE:/m.test(body),`,
    replace: `    breaking: /^BREAKING[ -]CHANGE:/m.test(body),`
  },
  {
    name: 'the version in package.json is never stamped',
    find: `    pkg.version = version
    writeFileSync(packagePath, \`\${JSON.stringify(pkg, null, 2)}\\n\`)`,
    replace: `    void 0`
  },
  {
    name: 'the package.json the tag names is not checked against the tag',
    find: `  if (before === version) {`,
    replace: `  if (false) {`
  },
  {
    name: 'a draft release is not found by listing',
    find: `  return (Array.isArray(releases) ? releases : []).find((release) => release.tag_name === tag) || null`,
    replace: `  return null`
  },
  {
    name: 'the oldest tag decides the base rather than the newest',
    find: `'--merged', 'HEAD', '--list', \`\${prefix}[0-9]*\`, '--sort=-v:refname'`,
    replace: `'--merged', 'HEAD', '--list', \`\${prefix}[0-9]*\`, '--sort=v:refname'`
  },
  {
    name: 'a release is created without looking for an existing one',
    find: `  if (existing && existing.id) {`,
    replace: `  if (false) {`
  },
  {
    name: 'a lookup that fails replaces the refusal that caused it',
    find: `    const existing = await find().catch(() => null)`,
    replace: `    const existing = await find()`
  },
  {
    name: 'the github upload sends the envelope again',
    find: `  if (!field)
    return request(url, {`,
    replace: `  if (false)
    return request(url, {`
  },
  {
    name: 'an asset that holds something other than the build passes',
    find: `  if (mislaid.length)`,
    replace: `  if (false)`
  }
]

const suite = async (entry) => {
  try {
    await exec('node', ['--test'], {
      cwd: root,
      env: { ...process.env, SASJS_RELEASE_ENTRY: entry },
      timeout: 300000
    })
    return { failed: 0, output: '' }
  } catch (error) {
    const output = `${error.stdout || ''}${error.stderr || ''}`
    const failed = Number(output.match(/^ℹ fail (\d+)$/m)?.[1] ?? 0)
    return { failed, output }
  }
}

const scratch = mkdtempSync(join(tmpdir(), 'mutate-'))
const original = readFileSync(source, 'utf8')
const survivors = []
let killed = 0

console.log(`baseline: the suite must pass before any mutation means anything`)
const baseline = await suite(source)
if (baseline.failed) {
  console.error('the suite fails on the real source - fix that first')
  process.exit(1)
}
console.log('baseline ok\n')

for (const [index, mutation] of mutations.entries()) {
  const count = original.split(mutation.find).length - 1
  const expected = mutation.all ? count : 1
  if (count === 0 || (!mutation.all && count !== 1)) {
    // a mutation that no longer matches is itself a finding: the guard moved or
    // was reworded, and this list is now lying about what it checks
    console.error(`✖ ${mutation.name}: pattern matches ${count} times in release.mjs`)
    survivors.push(mutation.name)
    continue
  }

  const copy = join(scratch, `release.${index}.mjs`)
  writeFileSync(
    copy,
    mutation.all
      ? original.split(mutation.find).join(mutation.replace)
      : original.replace(mutation.find, mutation.replace)
  )

  const result = await suite(copy)
  if (result.failed > 0) {
    killed += 1
    console.log(`✔ ${mutation.name} - killed by ${result.failed} test(s)`)
  } else {
    survivors.push(mutation.name)
    console.log(`✖ ${mutation.name} - SURVIVED: nothing tests this`)
  }
}

console.log(`\n${killed} of ${mutations.length} mutations killed`)
if (survivors.length) {
  console.error(`survivors:\n  ${survivors.join('\n  ')}`)
  process.exit(1)
}
