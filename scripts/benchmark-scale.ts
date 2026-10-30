import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { cpus, freemem, platform, release, tmpdir, totalmem } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Bm25Index } from '../src/core/bm25.ts'
import { SCALE_BASES, SCALE_CORPUS_VERSION, fingerprintDocuments, scaleCases, scaleDocument, type ScaleDocument } from './scale-corpus.ts'

const file = fileURLToPath(import.meta.url)
const args = new Map(process.argv.slice(2).map(value => {
  const at = value.indexOf('=')
  return at < 0 ? [value, 'true'] : [value.slice(0, at), value.slice(at + 1)]
}))
function integer(name: string, fallback: number, max: number): number {
  const value = Number(args.get(name) ?? fallback)
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw Error(`Invalid ${name}`)
  return value
}
function distribution(samples: readonly number[]) {
  const sorted = [...samples].sort((a, b) => a - b)
  return { n: sorted.length, medianMs: sorted[Math.ceil(sorted.length * 0.5) - 1]!, p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1]!, maxMs: sorted.at(-1)! }
}
function collectMemory() {
  globalThis.gc?.()
  const { rss, heapUsed, heapTotal, external, arrayBuffers } = process.memoryUsage()
  return { rss, heapUsed, heapTotal, external, arrayBuffers }
}
function distinct(document: ScaleDocument): string {
  return JSON.stringify([document.kbId, document.materialId, document.text.normalize('NFKC').replace(/\s+/gu, ' ').trim()])
}

function worker() {
  assert.equal(typeof globalThis.gc, 'function', 'Run with --expose-gc for comparable retained memory snapshots')
  const size = integer('--size', 1000, 100000)
  const chars = integer('--chars', 600, 2000)
  const samples = integer('--samples', 30, 200)
  const warmup = integer('--warmup', 5, 50)
  const baseline = collectMemory()
  const index = new Bm25Index()
  const documents = new Map<string, ScaleDocument>()
  let utf8Bytes = 0
  const buildStart = performance.now()
  for (let i = 0; i < size; i++) {
    const document = scaleDocument(i, chars)
    utf8Bytes += Buffer.byteLength(document.text, 'utf8')
    documents.set(document.id, document)
    index.add(document.id, `${document.title}\n${document.text}`)
  }
  const buildMs = performance.now() - buildStart
  const built = collectMemory()
  const fingerprint = fingerprintDocuments(documents.values())
  const scopes = [
    { name: 'all', accept: (_document: ScaleDocument) => true },
    { name: 'one-of-eight', accept: (document: ScaleDocument) => document.kbId === 'base-0' },
    { name: 'fixed-100-chunks', accept: (document: ScaleDocument) => document.id < 'chunk-00000100' },
  ]
  const queryResults = scopes.flatMap(scope => scaleCases().map(test => {
    const expected = scope.name === 'one-of-eight' && !['common-zh', 'exact-identifier'].includes(test.id) ? 'miss' : test.expected
    const options = {
      limit: 6,
      accept: (id: string) => scope.accept(documents.get(id)!),
      distinctKey: (id: string) => distinct(documents.get(id)!),
    }
    const invoke = () => {
      const start = performance.now()
      const hits = index.search(test.query, options)
      const ms = performance.now() - start
      assert.equal(hits.length > 0, expected === 'hits', `${scope.name}/${test.id}: unexpected hit/miss`)
      assert.ok(hits.length <= 6)
      assert.ok(hits.every(hit => scope.accept(documents.get(hit.id)!)))
      assert.equal(new Set(hits.map(hit => distinct(documents.get(hit.id)!))).size, hits.length)
      if (test.id === 'exact-identifier') assert.ok(hits.every(hit => documents.get(hit.id)!.materialId === 'manual-0000000.txt'))
      return { ms, count: hits.length }
    }
    return { scope: scope.name, id: test.id, query: test.query, expected, options, invoke, acceptedChunks: [...documents.values()].filter(scope.accept).length, samplesMs: [] as number[], resultCount: 0, firstMs: 0 }
  }))
  // Rotate case order across rounds; forced GC is outside all timed search calls.
  for (const result of queryResults) result.firstMs = result.invoke().ms
  for (let round = 0; round < warmup + samples; round++) {
    for (let i = 0; i < queryResults.length; i++) {
      const result = queryResults[(round + i) % queryResults.length]!
      const observed = result.invoke()
      result.resultCount = observed.count
      if (round >= warmup) result.samplesMs.push(observed.ms)
    }
  }
  const afterQueries = collectMemory()
  // Replacement uses the public remove/add path on 1% of the indexed chunks.
  const changed = Math.max(1, Math.floor(size / 100))
  const updateStart = performance.now()
  for (let i = 0; i < changed; i++) {
    const document = scaleDocument(i, chars)
    index.add(document.id, `${document.title}\n${document.text}\nupdatedcalibration`)
  }
  const updateMs = performance.now() - updateStart
  const output = {
    size, chars, bases: SCALE_BASES, syntheticFiles: Math.ceil(size / 4), utf8Bytes, fingerprint,
    buildMs, changedChunks: changed, updateMs, baseline, built, afterQueries,
    retainedHeapDeltaBytes: built.heapUsed - baseline.heapUsed,
    maxRssBytes: process.resourceUsage().maxRSS * 1024,
    queries: queryResults.map(({ scope, id, query, expected, acceptedChunks, samplesMs, resultCount, firstMs }) => ({ scope, id, query, expected, acceptedChunks, resultCount, firstMs, ...distribution(samplesMs), samplesMs })),
  }
  writeFileSync(args.get('--output')!, JSON.stringify(output))
}

function main() {
  const sizes = (args.get('--sizes') ?? '1000,10000,50000').split(',').map(Number)
  if (sizes.some(size => !Number.isSafeInteger(size) || size < 100 || size > 100000)) throw Error('Sizes must be 100..100000 chunks')
  const runs = integer('--runs', 3, 5)
  const samples = integer('--samples', 30, 200)
  const chars = integer('--chars', 600, 2000)
  const warmup = integer('--warmup', 5, 50)
  const outputPath = args.get('--output') ?? join(tmpdir(), `knowbase-scale-${randomUUID()}.json`)
  assert.ok(outputPath, 'Supply --output=<new JSON path>')
  const sources = ['src/core/bm25.ts', 'src/core/tokenize.ts', 'src/core/order.ts', 'scripts/scale-corpus.ts', 'scripts/benchmark-scale.ts']
  const sourceHashes = Object.fromEntries(sources.map(source => [source, createHash('sha256').update(readFileSync(source)).digest('hex')]))
  const root = mkdtempSync(join(tmpdir(), 'knowbase-scale-'))
  const results: unknown[] = []
  try {
    for (const size of sizes) for (let run = 1; run <= runs; run++) {
      console.info(`[scale] chunks=${size} run=${run}/${runs}`)
      const resultPath = join(root, `${size}-${run}.json`)
      const child = spawnSync(process.execPath, ['--expose-gc', '--max-old-space-size=1536', '--experimental-strip-types', file,
        '--worker', `--size=${size}`, `--samples=${samples}`, `--chars=${chars}`, `--warmup=${warmup}`, `--output=${resultPath}`],
      { stdio: 'inherit', timeout: 240000 })
      assert.equal(child.status, 0, `Worker failed: ${child.error?.message ?? child.signal ?? child.status}`)
      results.push({ run, ...JSON.parse(readFileSync(resultPath, 'utf8')) })
    }
    const result = {
      schemaVersion: 1, corpusVersion: SCALE_CORPUS_VERSION, generatedAt: new Date().toISOString(),
      environment: { node: process.version, platform: platform(), release: release(), architecture: process.arch,
        cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryBytes: totalmem(), availableMemoryAtStartBytes: freemem() },
      method: { sizes, runs, samples, warmup, chars, heapLimitMiB: 1536, limit: 6, gcBeforeMemorySnapshots: true,
        scopeStatistics: 'same accept/distinct contracts as production Bm25Index; no service citation or disk extraction cost',
        timing: 'index build includes deterministic corpus creation; queries rotate per round; nearest-rank quantiles per worker, not confidence bounds',
        memory: 'worker includes raw corpus Map and index; deltas are retained JS heap after forced GC; maxRSS is whole process high-water mark' },
      sourceHashes, results,
    }
    writeFileSync(resolve(outputPath), JSON.stringify(result, null, 2) + '\n')
    console.info(`[scale] wrote ${outputPath}`)
  } finally {
    assert.ok(root.startsWith(join(tmpdir(), 'knowbase-scale-')))
    rmSync(root, { recursive: true, force: true })
  }
}

if (args.has('--worker')) worker()
else main()
