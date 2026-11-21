import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// The reusable workflow is the half of the coverage gate that runs on a caller's
// default branch, so its contract is checked here rather than discovered by the
// first caller whose pull request job is built differently. Text, not a YAML
// parser: this package ships with no dependencies, and the shapes below are the
// ones a caller's failure would come from.
const workflow = readFileSync(
  new URL('../.github/workflows/coverage-baseline.yml', import.meta.url),
  'utf8'
)

/** The body of one `workflow_call` input: from its key to the next key at that indentation. */
const inputBlock = (name) =>
  workflow.match(new RegExp(`^ {6}${name}:\\n([\\s\\S]*?)(?=^ {6}\\S)`, 'm'))?.[1] ?? ''

// The image and the Node version decide how the numbers are produced: two
// percentages computed by different toolchains are not comparable, which is the
// whole reason this workflow exists. Both are required, with no default, so a
// caller that forgets one fails at its call site instead of quietly inheriting a
// toolchain different from the job it is measuring against.
for (const name of ['runs-on', 'node-version']) {
  test(`${name} is required, with no default`, () => {
    const block = inputBlock(name)

    assert.ok(block, `${name} must be declared as a workflow_call input`)
    assert.match(
      block,
      /^ {8}required: true$/m,
      `${name} must be required: a default lets a caller inherit a different toolchain in silence`
    )
    assert.doesNotMatch(block, /^ {8}default:/m, `${name} must carry no default at all`)
  })
}

test('the step takes its Node version from the input, not a literal', () => {
  // The same defect as a pinned image, one line over: a hardcoded `node-version: 22`
  // in the setup-node step measures every caller on a toolchain none of them chose,
  // and the required input would still be accepted and ignored.
  const versions = [...workflow.matchAll(/^ {10}node-version: *(.*)$/gm)].map((match) => match[1].trim())

  assert.ok(versions.length, 'the setup-node step must state a node-version')
  for (const version of versions)
    assert.equal(version, '${{ inputs.node-version }}', 'the step must use the input, not a literal')
})

test('every job takes its image from the input, and none pins its own', () => {
  // Not `/runs-on: ubuntu/`: a second job on windows-latest or macos-latest would
  // pass that and still be a job with an image of its own.
  const images = [...workflow.matchAll(/^ {4}runs-on: *(.*)$/gm)].map((match) => match[1].trim())

  assert.ok(images.length, 'the file must declare at least one job')
  for (const image of images)
    assert.equal(image, '${{ inputs.runs-on }}', 'the job image must come from the input')
})

test('a baseline that publishes nothing fails the caller', () => {
  // Anchored at the column the upload step's `with:` keys sit in, which also anchors
  // them to live lines: an unanchored /if-no-files-found: error/ is satisfied by the
  // commented-out key, and a comment publishes nothing exactly like a deletion.
  assert.match(workflow, /^ {10}name: coverage-summary$/m)
  assert.match(workflow, /^ {10}path: coverage\/coverage-summary\.json$/m)
  assert.match(workflow, /^ {10}if-no-files-found: error$/m)
})

test('the caller keeps its own concurrency', () => {
  // a called workflow cannot be given a concurrency group, and cancelling a baseline
  // leaves a commit with none at all - so this file must not pretend to own one
  assert.doesNotMatch(workflow, /^concurrency:/m)
})
