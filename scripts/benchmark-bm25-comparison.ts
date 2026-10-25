import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { cpus, freemem, platform, release, tmpdir, totalmem } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Bm25Index } from '../src/core/bm25.ts'
import { ReferenceBm25Index } from '../tests/fixtures/bm25-reference.ts'
import { SCALE_BASES, SCALE_CORPUS_VERSION, fingerprintDocuments, scaleCases, scaleDocument, type ScaleDocument } from './scale-corpus.ts'

type Implementation = 'baseline' | 'new'
type SearchHit = { readonly id: string; readonly score: number; readonly coverage: number; readonly matchedTerms: readonly string[] }
type IndexLike = {
  add(id: string, text: string, groupId?: string): void
  search(query: string, options?: Record<string, unknown>): SearchHit[]
  remove(id: string): boolean
  clear(): void
}
type QueryResult = {
  readonly scope: string
  readonly id: string
  readonly query: string
  readonly expected: string
  readonly acceptedChunks: number
  readonly resultCount: number
  readonly firstMs: number
  readonly postUpdateFirstMs: number
  readonly n: number
  readonly medianMs: number
  readonly p95Ms: number
  readonly maxMs: number
  readonly samplesMs: readonly number[]
  readonly hits: readonly SearchHit[]
  readonly hitsDigest: string
  readonly postUpdateHits: readonly SearchHit[]
  readonly postUpdateHitsDigest: string
}

type WorkerResult = {
  readonly impl: Implementation
  readonly size: number
  readonly chars: number
  readonly bases: number
  readonly syntheticFiles: number
  readonly utf8Bytes: number
  readonly fingerprint: string
  readonly buildMs: number
  readonly changedChunks: number
  readonly updateMs: number
  readonly baseline: MemorySnapshot
  readonly built: MemorySnapshot
  readonly afterQueries: MemorySnapshot
  readonly afterUpdates: MemorySnapshot
  readonly retainedHeapDeltaBytes: number
  readonly maxRssBytes: number
  readonly queries: readonly QueryResult[]
}

type MemorySnapshot = {
  readonly rss: number
  readonly heapUsed: number
  readonly heapTotal: number
  readonly external: number
  readonly arrayBuffers: number
}

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
  return {
    n: sorted.length,
    medianMs: sorted[Math.ceil(sorted.length * 0.5) - 1]!,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1]!,
    maxMs: sorted.at(-1)!,
  }
}

function collectMemory(): MemorySnapshot {
  globalThis.gc?.()
  const { rss, heapUsed, heapTotal, external, arrayBuffers } = process.memoryUsage()
  return { rss, heapUsed, heapTotal, external, arrayBuffers }
}

function distinct(document: ScaleDocument): string {
  return JSON.stringify([document.kbId, document.materialId, document.text.normalize('NFKC').replace(/\s+/gu, ' ').trim()])
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function allGroups(): string[] {
  return Array.from({ length: SCALE_BASES }, (_, index) => `base-${index}`)
}

function makeIndex(impl: Implementation): IndexLike {
  return (impl === 'baseline' ? new ReferenceBm25Index() : new Bm25Index()) as unknown as IndexLike
}

function add(index: IndexLike, impl: Implementation, document: ScaleDocument, text = `${document.title}\n${document.text}`): void {
  if (impl === 'baseline') index.add(document.id, text)
  else index.add(document.id, text, document.kbId)
}

function searchOptions(
  impl: Implementation,
  scope: { readonly name: string; readonly accept: (document: ScaleDocument) => boolean },
  documents: ReadonlyMap<string, ScaleDocument>,
): Record<string, unknown> {
  const distinctKey = (id: string) => distinct(documents.get(id)!)
  const accept = (id: string) => scope.accept(documents.get(id)!)
  // The production baseline always supplied an accept callback, including all-doc
  // searches. The optimized all-doc path deliberately leaves both filters absent.
  if (impl === 'baseline') return { limit: 6, accept, distinctKey }
  if (scope.name === 'all') return { limit: 6, distinctKey }
  // Recreate the group array for every search, matching the service's normal
  // per-call scope construction and preventing identity-based cache hits.
  const groups = scope.name === 'one-of-eight' ? ['base-0'] : allGroups()
  if (scope.name === 'one-of-eight') return { limit: 6, groups: [...groups], distinctKey }
  return { limit: 6, groups: [...groups], accept, distinctKey }
}

function expectedFor(scope: string, testId: string, expected: string): string {
  return scope === 'one-of-eight' && !['common-zh', 'exact-identifier'].includes(testId) ? 'miss' : expected
}

function validateHits(
  hits: readonly SearchHit[],
  scope: { readonly name: string; readonly accept: (document: ScaleDocument) => boolean },
  documents: ReadonlyMap<string, ScaleDocument>,
  expected: string,
  label: string,
): void {
  assert.equal(hits.length > 0, expected === 'hits', `${label}: unexpected hit/miss`)
  assert.ok(hits.length <= 6, `${label}: limit exceeded`)
  assert.ok(hits.every(hit => scope.accept(documents.get(hit.id)!)), `${label}: out-of-scope hit`)
  assert.equal(new Set(hits.map(hit => distinct(documents.get(hit.id)!))).size, hits.length, `${label}: duplicate evidence`)
  if (label.endsWith('/exact-identifier')) {
    assert.ok(hits.every(hit => documents.get(hit.id)!.materialId === 'manual-0000000.txt'), `${label}: wrong identifier source`)
  }
}

function worker(): void {
  assert.equal(typeof globalThis.gc, 'function', 'Run with --expose-gc for comparable retained memory snapshots')
  const impl = args.get('--impl') as Implementation
  assert.ok(impl === 'baseline' || impl === 'new', 'Worker requires --impl=baseline|new')
  const size = integer('--size', 1000, 100000)
  const chars = integer('--chars', 600, 2000)
  const samples = integer('--samples', 30, 200)
  const warmup = integer('--warmup', 5, 50)
  const output = args.get('--output')
  assert.ok(output, 'Worker requires --output=<temporary JSON path>')

  const baseline = collectMemory()
  const index = makeIndex(impl)
  const documents = new Map<string, ScaleDocument>()
  let utf8Bytes = 0
  const buildStart = performance.now()
  for (let i = 0; i < size; i++) {
    const document = scaleDocument(i, chars)
    utf8Bytes += Buffer.byteLength(document.text, 'utf8')
    documents.set(document.id, document)
    add(index, impl, document)
  }
  const buildMs = performance.now() - buildStart
  const built = collectMemory()
  const fingerprint = fingerprintDocuments(documents.values())
  const scopes = [
    { name: 'all', accept: (_document: ScaleDocument) => true },
    { name: 'one-of-eight', accept: (document: ScaleDocument) => document.kbId === 'base-0' },
    { name: 'fixed-100-chunks', accept: (document: ScaleDocument) => document.id < 'chunk-00000100' },
  ] as const

  const queryResults = scopes.flatMap(scope => scaleCases().map(test => {
    const expected = expectedFor(scope.name, test.id, test.expected)
    const invoke = () => {
      const start = performance.now()
      const hits = index.search(test.query, searchOptions(impl, scope, documents))
      return { ms: performance.now() - start, hits }
    }
    return {
      scope: scope.name,
      id: test.id,
      query: test.query,
      expected,
      acceptedChunks: [...documents.values()].filter(scope.accept).length,
      invoke,
      samplesMs: [] as number[],
      firstMs: 0,
      firstHits: [] as SearchHit[],
      postUpdateFirstMs: 0,
      postUpdateHits: [] as SearchHit[],
      resultCount: 0,
    }
  }))

  // The first call is intentionally outside the warm/sample loops. Validation
  // happens after timing, so assertions never contribute to a timed search.
  for (const result of queryResults) {
    const observed = result.invoke()
    result.firstMs = observed.ms
    result.firstHits = observed.hits
  }
  for (let round = 0; round < warmup + samples; round++) {
    for (let offset = 0; offset < queryResults.length; offset++) {
      const result = queryResults[(round + offset) % queryResults.length]!
      const observed = result.invoke()
      result.resultCount = observed.hits.length
      if (round >= warmup) result.samplesMs.push(observed.ms)
    }
  }
  const afterQueries = collectMemory()

  for (const result of queryResults) {
    const scope = scopes.find(candidate => candidate.name === result.scope)!
    validateHits(result.firstHits, scope, documents, result.expected, `${result.scope}/${result.id}`)
    assert.ok(result.samplesMs.every(Number.isFinite), `${result.scope}/${result.id}: non-finite sample`)
  }
  if (impl === 'new') {
    for (const result of queryResults.filter(query => query.scope === 'all')) {
      const allGroupsHits = index.search(result.query, {
        limit: 6,
        groups: allGroups(),
        distinctKey: (id: string) => distinct(documents.get(id)!),
      })
      assert.deepEqual(allGroupsHits, result.firstHits, `all-groups/global mismatch for ${result.id}`)
    }
  }

  // Replacement uses the public remove/add path on 1% of the indexed chunks.
  // The new index receives the same kbId on replacement, exercising group upkeep.
  const changed = Math.max(1, Math.floor(size / 100))
  const updateStart = performance.now()
  for (let i = 0; i < changed; i++) {
    const document = scaleDocument(i, chars)
    const updated = { ...document, text: `${document.text}\nupdatedcalibration` }
    documents.set(document.id, updated)
    add(index, impl, updated)
  }
  const updateMs = performance.now() - updateStart
  for (const result of queryResults) {
    const observed = result.invoke()
    result.postUpdateFirstMs = observed.ms
    result.postUpdateHits = observed.hits
  }
  const afterUpdates = collectMemory()
  for (const result of queryResults) {
    const scope = scopes.find(candidate => candidate.name === result.scope)!
    validateHits(result.postUpdateHits, scope, documents, result.expected, `post-update/${result.scope}/${result.id}`)
  }

  const result: WorkerResult = {
    impl,
    size,
    chars,
    bases: SCALE_BASES,
    syntheticFiles: Math.ceil(size / 4),
    utf8Bytes,
    fingerprint,
    buildMs,
    changedChunks: changed,
    updateMs,
    baseline,
    built,
    afterQueries,
    afterUpdates,
    retainedHeapDeltaBytes: built.heapUsed - baseline.heapUsed,
    maxRssBytes: process.resourceUsage().maxRSS * 1024,
    queries: queryResults.map(({ invoke: _invoke, firstHits, postUpdateHits, samplesMs, ...result }) => ({
      ...result,
      ...distribution(samplesMs),
      samplesMs,
      hits: firstHits,
      hitsDigest: digest(firstHits),
      postUpdateHits,
      postUpdateHitsDigest: digest(postUpdateHits),
    })),
  }
  writeFileSync(resolve(output), JSON.stringify(result))
}

function p50(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.ceil(sorted.length * 0.5) - 1]!
}

function queryMap(result: WorkerResult): Map<string, QueryResult> {
  return new Map(result.queries.map(query => [`${query.scope}/${query.id}`, query]))
}

function strictCompare(baseline: WorkerResult, current: WorkerResult): void {
  assert.equal(baseline.impl, 'baseline')
  assert.equal(current.impl, 'new')
  assert.equal(current.size, baseline.size)
  assert.equal(current.chars, baseline.chars)
  assert.equal(current.fingerprint, baseline.fingerprint)
  assert.equal(current.utf8Bytes, baseline.utf8Bytes)
  const left = queryMap(baseline)
  const right = queryMap(current)
  assert.equal(left.size, right.size)
  for (const [key, reference] of left) {
    const actual = right.get(key)
    assert.ok(actual, `Missing comparison query ${key}`)
    assert.equal(actual!.acceptedChunks, reference.acceptedChunks, `${key}: scope size mismatch`)
    assert.equal(actual!.resultCount, reference.resultCount, `${key}: result count mismatch`)
    assert.equal(actual!.hitsDigest, digest(reference.hits), `${key}: baseline hit digest invalid`)
    assert.equal(actual!.postUpdateHitsDigest, digest(reference.postUpdateHits), `${key}: baseline post-update digest invalid`)
    assert.deepEqual(actual!.hits, reference.hits, `${key}: hit snapshot mismatch`)
    assert.deepEqual(actual!.postUpdateHits, reference.postUpdateHits, `${key}: post-update hit snapshot mismatch`)
    assert.equal(actual!.hitsDigest, digest(actual!.hits), `${key}: new hit digest invalid`)
    assert.equal(actual!.postUpdateHitsDigest, digest(actual!.postUpdateHits), `${key}: new post-update digest invalid`)
  }
}

function runWorker(root: string, impl: Implementation, size: number, run: number, samples: number, warmup: number, chars: number): WorkerResult {
  const output = join(root, `${impl}-${size}-${run}.json`)
  const child = spawnSync(process.execPath, [
    '--expose-gc', '--max-old-space-size=1536', '--experimental-strip-types', file,
    '--worker', `--impl=${impl}`, `--size=${size}`, `--samples=${samples}`, `--chars=${chars}`, `--warmup=${warmup}`, `--output=${output}`,
  ], { stdio: 'inherit', timeout: 240000, env: { ...process.env, NODE_OPTIONS: '' } })
  assert.equal(child.status, 0, `${impl} worker failed: ${child.error?.message ?? child.signal ?? child.status}`)
  return JSON.parse(readFileSync(output, 'utf8')) as WorkerResult
}

function main(): void {
  const sizes = (args.get('--sizes') ?? '1000,10000,50000').split(',').map(Number)
  if (sizes.some(size => !Number.isSafeInteger(size) || size < 100 || size > 100000)) throw Error('Sizes must be 100..100000 chunks')
  const runs = integer('--runs', 3, 5)
  const samples = integer('--samples', 30, 200)
  const warmup = integer('--warmup', 5, 50)
  const chars = integer('--chars', 600, 2000)
  const outputPath = args.get('--output')
  assert.ok(outputPath, 'Supply --output=<new JSON path>')
  assert.equal(existsSync(resolve(outputPath)), false, 'Output exists; preserve prior measurements and use a new path')
  const sources = [
    'src/core/bm25.ts',
    'tests/fixtures/bm25-reference.ts',
    'src/core/tokenize.ts',
    'src/core/order.ts',
    'scripts/scale-corpus.ts',
    'scripts/benchmark-bm25-comparison.ts',
  ]
  const sourceHashes = Object.fromEntries(sources.map(source => [source, createHash('sha256').update(readFileSync(source)).digest('hex')]))
  const root = mkdtempSync(join(tmpdir(), 'knowbase-o13-bm25-comparison-'))
  const pairs: Array<{ readonly size: number; readonly run: number; readonly order: readonly Implementation[]; readonly baseline: WorkerResult; readonly new: WorkerResult; readonly summary: unknown }> = []
  try {
    for (let sizeIndex = 0; sizeIndex < sizes.length; sizeIndex++) for (let run = 1; run <= runs; run++) {
      const size = sizes[sizeIndex]!
      const order: Implementation[] = (sizeIndex + run) % 2 === 0 ? ['baseline', 'new'] : ['new', 'baseline']
      console.info(`[compare] chunks=${size} run=${run}/${runs} order=${order.join(',')}`)
      const first = runWorker(root, order[0]!, size, run, samples, warmup, chars)
      const second = runWorker(root, order[1]!, size, run, samples, warmup, chars)
      const baseline = first.impl === 'baseline' ? first : second
      const current = first.impl === 'new' ? first : second
      strictCompare(baseline, current)
      const baselineQueries = queryMap(baseline)
      const currentQueries = queryMap(current)
      const queries = [...baselineQueries].map(([key, left]) => {
        const right = currentQueries.get(key)!
        return {
          key,
          firstMs: { baseline: left.firstMs, new: right.firstMs, ratio: right.firstMs / left.firstMs },
          postUpdateFirstMs: { baseline: left.postUpdateFirstMs, new: right.postUpdateFirstMs, ratio: right.postUpdateFirstMs / left.postUpdateFirstMs },
          medianMs: { baseline: left.medianMs, new: right.medianMs, ratio: right.medianMs / left.medianMs },
          p95Ms: { baseline: left.p95Ms, new: right.p95Ms, ratio: right.p95Ms / left.p95Ms },
        }
      })
      const baselineP95 = queries.map(query => query.p95Ms.baseline)
      const currentP95 = queries.map(query => query.p95Ms.new)
      pairs.push({
        size,
        run,
        order,
        baseline,
        new: current,
        summary: {
          p50PerQueryP95Ms: { baseline: p50(baselineP95), new: p50(currentP95), ratio: p50(currentP95) / p50(baselineP95) },
          p50PerQueryMedianMs: {
            baseline: p50(queries.map(query => query.medianMs.baseline)),
            new: p50(queries.map(query => query.medianMs.new)),
            ratio: p50(queries.map(query => query.medianMs.new)) / p50(queries.map(query => query.medianMs.baseline)),
          },
          queries,
        },
      })
    }
    for (const [source, expected] of Object.entries(sourceHashes)) {
      assert.equal(createHash('sha256').update(readFileSync(source)).digest('hex'), expected, `Source changed during measurement: ${source}`)
    }
    const result = {
      schemaVersion: 1,
      corpusVersion: SCALE_CORPUS_VERSION,
      generatedAt: new Date().toISOString(),
      environment: {
        node: process.version,
        platform: platform(),
        release: release(),
        architecture: process.arch,
        cpu: cpus()[0]?.model,
        logicalCpus: cpus().length,
        totalMemoryBytes: totalmem(),
        availableMemoryAtReportBytes: freemem(),
      },
      method: {
        sizes,
        runs,
        samples,
        warmup,
        chars,
        heapLimitMiB: 1536,
        timeoutMs: 240000,
        limit: 6,
        scopes: 'all: baseline accept(true), new groups/accept omitted; one-of-eight: baseline accept(kbId), new groups=[base-0]; fixed-100: baseline accept(id<chunk-00000100), new groups=all bases plus same accept',
        scopeStatistics: 'paired implementations receive identical accepted document ids; all/new exercises the no-filter fast path while baseline retains production accept(true)',
        timing: 'fresh worker per implementation, rotated process order per size/run; first search and warmup/sample query loops are timed without assertions; raw samples retained',
        memory: 'workers include corpus Map and one index; forced-GC snapshots and process maxRSS are recorded',
        parity: 'parent compares exact JSON hit arrays including score, coverage and matchedTerms before writing output',
      },
      sourceHashes,
      results: pairs,
    }
    writeFileSync(resolve(outputPath), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
    console.info(`[compare] wrote ${outputPath}`)
  } finally {
    assert.ok(root.startsWith(join(tmpdir(), 'knowbase-o13-bm25-comparison-')))
    rmSync(root, { recursive: true, force: true })
  }
}

if (args.has('--worker')) worker()
else main()
