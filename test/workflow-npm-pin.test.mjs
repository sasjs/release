import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// The real-npm suite is also run by release and publish, not just PR CI.
// Keep its runtime fixed on every path so a runner update cannot silently
// change the contract the suite exercises.
test('every workflow running the suite pins npm before running it', () => {
  for (const file of ['test.yml', 'release.yml', 'publish.yml']) {
    const text = readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8')
    const jobs = text.split(/^  [A-Za-z_][A-Za-z0-9_-]*:\s*$/m).slice(1)
    const suiteJobs = jobs.filter((job) => /node --test|npm run test:(coverage|mutate)/.test(job))
    assert.ok(suiteJobs.length, `${file} contains no suite job`)
    for (const job of suiteJobs) {
      const steps = job.split(/^      - /m).slice(1)
      const pin = steps.findIndex((step) => step.startsWith('name: Pin npm for audit integration tests'))
      const suite = steps.findIndex((step) => /node --test|npm run test:(coverage|mutate)/.test(step))
      assert.ok(pin >= 0 && pin < suite, `${file}: npm must be pinned before the suite`)
      assert.match(steps[pin], /npm install --global --ignore-scripts npm@11\.6\.2/)
      assert.match(steps[pin], /npm --version/)
      assert.doesNotMatch(steps[pin], /continue-on-error:/)
      const condition = (step) => step.match(/^        if: (.+)$/m)?.[1]
      assert.equal(condition(steps[pin]), condition(steps[suite]), `${file}: pin and suite conditions differ`)
    }
  }
})
