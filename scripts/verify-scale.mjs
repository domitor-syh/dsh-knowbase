import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

// Only tiny correctness runs in CI; timing values are never pass/fail thresholds.
const temporary = mkdtempSync(join(tmpdir(), 'knowbase-o13-'))
const run = (file, args, gc = false) => {
  const child = spawnSync(process.execPath, [...(gc ? ['--expose-gc', '--max-old-space-size=1536'] : []), '--experimental-strip-types', file, ...args],
    { stdio: 'inherit', timeout: 60000, env: { ...process.env, NODE_OPTIONS: '' } })
  assert.ifError(child.error)
  assert.equal(child.status, 0, `${file} failed (${child.signal ?? child.status})`)
}
try {
  const coreOutput = join(temporary, 'core.json')
  run('scripts/benchmark-scale.ts', ['--worker', '--size=100', '--samples=2', '--warmup=1', `--output=${coreOutput}`], true)
  const core = JSON.parse(readFileSync(coreOutput, 'utf8'))
  assert.equal(core.size, 100)
  assert.equal(core.queries.length, 24)
  assert.ok(core.queries.every(query => query.samplesMs.length === 2 && query.samplesMs.every(Number.isFinite)))
  const serviceOutput = join(temporary, 'files-100-repeat-1.json')
  run('scripts/benchmark-service-scale.ts', ['--worker', '--size', '100', '--repeat', '1', '--output', serviceOutput], true)
  const service = JSON.parse(readFileSync(serviceOutput, 'utf8'))
  assert.equal(service.coldCorpus.files, 100)
  assert.equal(service.scans.unchanged.textReads, 0)
  assert.equal(service.scans.changed.textReads, 1)
  const comparisonOutput = join(temporary, 'comparison.json')
  run('scripts/benchmark-bm25-comparison.ts', ['--sizes=100', '--runs=1', '--samples=2', '--warmup=1', `--output=${comparisonOutput}`])
  const comparison = JSON.parse(readFileSync(comparisonOutput, 'utf8'))
  assert.equal(comparison.results.length, 1)
  assert.equal(comparison.results[0].baseline.queries.length, 24)
  assert.equal(comparison.results[0].new.queries.length, 24)
  run('scripts/probe-fts5.ts', ['--check'])
  console.info('Synthetic benchmark smoke passed: scoped retrieval, incremental scans, citations and FTS5 compatibility; no timing thresholds.')
} finally {
  assert.equal(dirname(temporary), resolve(tmpdir()))
  assert.ok(temporary.startsWith(join(tmpdir(), 'knowbase-o13-')))
  rmSync(temporary, { recursive: true, force: true })
}
