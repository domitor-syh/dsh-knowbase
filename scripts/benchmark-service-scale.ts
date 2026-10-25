/** O13 synthetic, memory-only KnowbaseService lifecycle. Output is exclusive-create. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { KnowbaseService, MemoryStore, type ScanReport } from '../src/core/service.ts'
import { createMemoryVaultFs, type VaultFileSystem } from '../src/vault-fs.ts'

const SCRIPT = fileURLToPath(import.meta.url)
const PROJECT = path.resolve(path.dirname(SCRIPT), '..')
const OUTPUT = path.join(PROJECT, 'outputs', 'o13-service-scale.json')
const SIZES = [100, 1000, 5000] as const
const REPEATS = 3, WARMUP = 3, SAMPLES = 30, BASES = 4, HEAP_MIB = 1536
const TEMP_PREFIX = 'knowbase-o13-'
const QUERIES = { commonChinese: '设备配置', rareIdentifier: 'QZID0000000', miss: 'ZXQNOHIT987654321' }
type Category = keyof typeof QUERIES
type Scope = 'allBases' | 'oneBase'

function summary(values: readonly number[]) {
  assert(values.length > 0)
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return { count: values.length,
    median: sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1]!, min: sorted[0]!, max: sorted.at(-1)! }
}
function memory() {
  assert.equal(typeof globalThis.gc, 'function', 'Run with --expose-gc')
  globalThis.gc!()
  return { ...process.memoryUsage(), maxRssKiB: process.resourceUsage().maxRSS }
}
/** Exactly 2046 characters, eight paragraphs; input independent of repeat. */
function syntheticText(index: number, changed = false): string {
  const filler = '设备配置需要检查网络连接和运行状态。维护人员按顺序记录参数并确认操作结果。系统支持本地资料检索和安全重启。'
  return Array.from({ length: 8 }, (_, paragraph) => {
    const heading = `${paragraph === 0 ? `QZID${String(index).padStart(7, '0')} ` : ''}合成资料${String(index).padStart(5, '0')}段落${paragraph}修订${changed ? '乙' : '甲'}。`
    return (heading + filler.repeat(8)).slice(0, 254)
  }).join('\n\n')
}
function fileName(i: number) { return `synthetic-${String(i).padStart(5, '0')}.txt` }
function baseId(i: number) { return `kb_013${String(i).padStart(8, '0')}` }
function folderName(i: number) { return `Synthetic${i}--${baseId(i)}` }

function corpus(service: KnowbaseService) {
  const materials = service.listMaterials()
  let sourceUtf8Bytes = 0, extractedUtf8Bytes = 0, chunkUtf8Bytes = 0, chunks = 0, extractedFiles = 0
  let minChars = Infinity, maxChars = 0, minChunks = Infinity, maxChunks = 0
  for (const material of materials) {
    sourceUtf8Bytes += material.bytes
    if (material.extractedText !== undefined) {
      extractedFiles++
      extractedUtf8Bytes += Buffer.byteLength(material.extractedText, 'utf8')
      minChars = Math.min(minChars, material.extractedText.length)
      maxChars = Math.max(maxChars, material.extractedText.length)
    }
    assert(material.indexed && material.chunks.length > 1, 'Every file must produce multiple actual chunks')
    chunks += material.chunks.length
    minChunks = Math.min(minChunks, material.chunks.length)
    maxChunks = Math.max(maxChunks, material.chunks.length)
    for (const chunk of material.chunks) chunkUtf8Bytes += Buffer.byteLength(chunk.text, 'utf8')
  }
  return { files: materials.length, extractedFiles, chunks, sourceUtf8Bytes, extractedUtf8Bytes, chunkUtf8Bytes,
    extractedCharsPerFile: { min: minChars, max: maxChars }, chunksPerFile: { min: minChunks, max: maxChunks },
    filesPerBase: Array.from({ length: BASES }, (_, i) => service.listMaterials(baseId(i)).length) }
}
function scanReport(service: KnowbaseService) {
  const reports = Array.from({ length: BASES }, (_, i) => {
    const report = service.getLastScanReport(baseId(i))
    assert(report)
    const { mode, elapsedMs, scanned, rebuilt, skipped, added, reused, changed, deleted, unsearchable } = report
    assert.equal(report.failures.length + report.omittedFailures, 0)
    return { mode, elapsedMs, scanned, rebuilt, skipped, added, reused, changed, deleted, unsearchable }
  })
  const fields = ['scanned', 'rebuilt', 'skipped', 'added', 'reused', 'changed', 'deleted', 'unsearchable'] as const
  const totals = Object.fromEntries(fields.map(key => [key, reports.reduce((sum, r) => sum + r[key], 0)])) as
    Pick<ScanReport, typeof fields[number]>
  return { totals, perBase: reports }
}
async function timedScan(service: KnowbaseService, fsReads: () => number, operation: () => Promise<unknown>) {
  const beforeReads = fsReads(), start = performance.now()
  await operation()
  const elapsedMs = performance.now() - start
  return { elapsedMs, textReads: fsReads() - beforeReads, ...scanReport(service) }
}
function benchmarkRetrieve(service: KnowbaseService) {
  const measurements = []
  for (const scope of ['allBases', 'oneBase'] as const) {
    const ids = scope === 'allBases' ? Array.from({ length: BASES }, (_, i) => baseId(i)) : [baseId(0)]
    for (const category of Object.keys(QUERIES) as Category[]) {
      const query = QUERIES[category]
      let citationsChecked = 0
      const check = (result: ReturnType<KnowbaseService['retrieve']>) => {
        if (category === 'miss') { assert.equal(result.kind, 'no_match'); return }
        assert.equal(result.kind, 'hits')
        if (result.kind !== 'hits') throw new Error('Expected hits')
        assert(result.passages.length > 0 && result.passages.length <= 6)
        for (const passage of result.passages) {
          assert.match(passage.citationId ?? '', /^kb-cite-v1-[a-f0-9]{64}$/)
          assert(ids.includes(passage.kbId!))
          const material = service.getMaterial(passage.kbId!, passage.materialId!)
          assert(material)
          const chunk = material.chunks[passage.ordinal!]
          assert(chunk)
          assert.equal(chunk.text, passage.text)
          assert.equal(chunk.locator, passage.locator)
          assert.equal(passage.filePath, path.join(service.root, service.getKnowledgeBase(passage.kbId!)!.folderName, material.fileName))
          if (category === 'rareIdentifier') assert.equal(passage.materialId, fileName(0))
          citationsChecked++
        }
      }
      for (let i = 0; i < WARMUP; i++) check(service.retrieve(query, ids))
      const samplesMs = [], passageCounts = []
      for (let i = 0; i < SAMPLES; i++) {
        const start = performance.now(), result = service.retrieve(query, ids)
        samplesMs.push(performance.now() - start)
        check(result) // Assertions excluded from timing; citation construction included.
        passageCounts.push(result.kind === 'hits' ? result.passages.length : 0)
      }
      measurements.push({ scope, category, query, samplesMs, summaryMs: summary(samplesMs), passageCounts, citationsChecked })
    }
  }
  return measurements
}

async function worker(size: number, repeat: number, output: string) {
  assert(SIZES.includes(size as typeof SIZES[number]))
  assert(Number.isInteger(repeat) && repeat >= 1 && repeat <= REPEATS)
  assert.equal(path.dirname(path.dirname(output)), path.resolve(os.tmpdir()))
  assert(path.basename(path.dirname(output)).startsWith(TEMP_PREFIX))
  assert.equal(path.basename(output), `files-${size}-repeat-${repeat}.json`)
  const root = path.resolve(os.tmpdir(), 'o13-synthetic-memory-vault') // Label only, never a disk vault.
  const snapshots: Record<string, ReturnType<typeof memory>> = { baseline: memory() }
  const raw = createMemoryVaultFs(root)
  let reads = 0
  const fs: VaultFileSystem = { ...raw, async readText(file, maxBytes) { reads++; return raw.readText(file, maxBytes) } }
  const store = new MemoryStore(), inputHash = createHash('sha256')
  for (let i = 0; i < BASES; i++) {
    store.seedKnowledgeBase({ id: baseId(i), name: `Synthetic${i}`, description: 'O13 deterministic synthetic text',
      folderName: folderName(i), createdAt: 1700000000000, updatedAt: 1700000000000, indexRevision: 0 })
    await fs.ensureDir(path.join(root, folderName(i)))
  }
  for (let i = 0; i < size; i++) {
    const text = syntheticText(i)
    assert.equal(text.length, 2046)
    inputHash.update(JSON.stringify([i % BASES, fileName(i), text]))
    await fs.writeFile(path.join(root, folderName(i % BASES), fileName(i)), text)
  }
  snapshots.seededVault = memory()
  const service = new KnowbaseService(store, fs, root) // Default chunking, no overrides.
  const initial = await timedScan(service, () => reads, () => service.initialize())
  assert.equal(initial.totals.rebuilt, size)
  assert.equal(initial.totals.added, size)
  assert.equal(initial.textReads, size)
  assert.equal(initial.totals.unsearchable, 0)
  const coldCorpus = corpus(service)
  assert.equal(coldCorpus.extractedFiles, size)
  assert.equal(coldCorpus.sourceUtf8Bytes, coldCorpus.extractedUtf8Bytes)
  snapshots.afterCold = memory()
  const revisions = Array.from({ length: BASES }, (_, i) => service.getKnowledgeBase(baseId(i))!.indexRevision)
  const unchanged = await timedScan(service, () => reads, () => service.rescan())
  assert.equal(unchanged.totals.rebuilt, 0)
  assert.equal(unchanged.totals.reused, size)
  assert.equal(unchanged.totals.changed, 0)
  assert.equal(unchanged.textReads, 0)
  assert.deepEqual(Array.from({ length: BASES }, (_, i) => service.getKnowledgeBase(baseId(i))!.indexRevision), revisions)
  snapshots.afterUnchanged = memory()
  const changedFiles = size / 100, touchedBases = new Set<number>(), changedHash = createHash('sha256')
  for (let i = 0; i < changedFiles; i++) {
    touchedBases.add(i % BASES)
    const file = path.join(root, folderName(i % BASES), fileName(i))
    const prior = await fs.stat(file), text = syntheticText(i, true)
    changedHash.update(JSON.stringify([i % BASES, fileName(i), text]))
    await fs.writeFile(file, text)
    const after = await fs.stat(file)
    assert(prior && after && after.mtimeMs > prior.mtimeMs, 'Rewrite must change mtime')
    assert.equal(after.size, prior.size, 'Same-byte-length edit isolates mtime detection')
  }
  const changed = await timedScan(service, () => reads, () => service.rescan())
  assert.equal(changed.totals.rebuilt, changedFiles)
  assert.equal(changed.totals.changed, changedFiles)
  assert.equal(changed.totals.reused, size - changedFiles)
  assert.equal(changed.textReads, changedFiles)
  assert.equal(changed.totals.added + changed.totals.deleted + changed.totals.unsearchable, 0)
  for (let i = 0; i < BASES; i++) assert.equal(service.getKnowledgeBase(baseId(i))!.indexRevision, revisions[i]! + (touchedBases.has(i) ? 1 : 0))
  const changedCorpus = corpus(service)
  assert.equal(changedCorpus.chunks, coldCorpus.chunks)
  assert.equal(changedCorpus.sourceUtf8Bytes, coldCorpus.sourceUtf8Bytes)
  for (let i = 0; i < changedFiles; i++) assert.equal(service.getMaterial(baseId(i % BASES), fileName(i))!.extractedText, syntheticText(i, true))
  snapshots.afterChanged = memory()
  const retrieve = benchmarkRetrieve(service)
  snapshots.afterRetrieve = memory()
  const result = { files: size, repeat, initialCorpusSha256: inputHash.digest('hex'), changedFilesSha256: changedHash.digest('hex'),
    coldCorpus, changedCorpus, scans: { initial, unchanged, changed },
    relativeToCold: { unchanged: unchanged.elapsedMs / initial.elapsedMs, changed: changed.elapsedMs / initial.elapsedMs },
    changedFiles, retrieve, memoryBytes: snapshots, peakMaxRssKiB: process.resourceUsage().maxRSS }
  await writeFile(output, JSON.stringify(result), { encoding: 'utf8', flag: 'wx' })
  console.log(`O13 files=${size} repeat=${repeat}: chunks=${coldCorpus.chunks} cold=${initial.elapsedMs.toFixed(1)}ms unchanged=${unchanged.elapsedMs.toFixed(1)}ms changed=${changed.elapsedMs.toFixed(1)}ms maxRSS=${result.peakMaxRssKiB}KiB`)
}
async function sourceHashes() {
  const names = ['package.json', 'src/vault-fs.ts', 'scripts/benchmark-service-scale.ts',
    ...(await readdir(path.join(PROJECT, 'src/core'))).filter(name => name.endsWith('.ts')).map(name => `src/core/${name}`)]
  return Object.fromEntries(await Promise.all(names.sort().map(async name =>
    [name, createHash('sha256').update(await readFile(path.join(PROJECT, name))).digest('hex')])))
}
async function readWorker(file: string) {
  return JSON.parse(await readFile(file, 'utf8')) as {
    files: number; repeat: number; initialCorpusSha256: string; changedFilesSha256: string;
    coldCorpus: ReturnType<typeof corpus>; changedCorpus: ReturnType<typeof corpus>; changedFiles: number;
    scans: Record<'initial' | 'unchanged' | 'changed', Awaited<ReturnType<typeof timedScan>>>;
    relativeToCold: Record<'unchanged' | 'changed', number>; peakMaxRssKiB: number;
    memoryBytes: Record<string, ReturnType<typeof memory>>; retrieve: ReturnType<typeof benchmarkRetrieve>;
  }
}
async function main(output: string) {
  assert.equal(output, OUTPUT, 'Explicit --output must be outputs/o13-service-scale.json')
  try { await lstat(output); throw new Error('Output exists; read and preserve/remove explicitly before rerunning') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const hashes = await sourceHashes(), temporary = await mkdtemp(path.join(os.tmpdir(), TEMP_PREFIX))
  const runs: Awaited<ReturnType<typeof readWorker>>[] = []
  try {
    for (const files of SIZES) for (let repeat = 1; repeat <= REPEATS; repeat++) {
      const childOutput = path.join(temporary, `files-${files}-repeat-${repeat}.json`)
      const child = spawnSync(process.execPath, ['--expose-gc', `--max-old-space-size=${HEAP_MIB}`, '--experimental-strip-types',
        SCRIPT, '--worker', '--size', String(files), '--repeat', String(repeat), '--output', childOutput],
      { cwd: PROJECT, stdio: 'inherit', timeout: 180000, env: { ...process.env, NODE_OPTIONS: '' } })
      assert.ifError(child.error)
      assert.equal(child.status, 0, `Worker files=${files} repeat=${repeat} failed (signal ${child.signal})`)
      const result = await readWorker(childOutput)
      assert.equal(result.files, files)
      assert.equal(result.repeat, repeat)
      runs.push(result)
    }
    assert.deepEqual(await sourceHashes(), hashes, 'Sources changed during run; cannot publish mixed results')
    const aggregates = SIZES.map(files => {
      const selected = runs.filter(run => run.files === files)
      assert.equal(new Set(selected.map(run => run.initialCorpusSha256)).size, 1)
      assert.equal(new Set(selected.map(run => run.changedFilesSha256)).size, 1)
      return { files, corpus: selected[0]!.coldCorpus, initialCorpusSha256: selected[0]!.initialCorpusSha256, changedFiles: selected[0]!.changedFiles,
        scansMs: Object.fromEntries((['initial', 'unchanged', 'changed'] as const).map(phase =>
          [phase, { samples: selected.map(run => run.scans[phase].elapsedMs), ...summary(selected.map(run => run.scans[phase].elapsedMs)) }])),
        relativeToCold: Object.fromEntries((['unchanged', 'changed'] as const).map(phase => [phase, summary(selected.map(run => run.relativeToCold[phase]))])),
        peakMaxRssKiB: summary(selected.map(run => run.peakMaxRssKiB)),
        postGcHeapUsedBytes: Object.fromEntries(Object.keys(selected[0]!.memoryBytes).map(phase => [phase, summary(selected.map(run => run.memoryBytes[phase]!.heapUsed))])),
        retrieve: (['allBases', 'oneBase'] as Scope[]).flatMap(scope => (Object.keys(QUERIES) as Category[]).map(category => {
          const cells = selected.map(run => run.retrieve.find(cell => cell.scope === scope && cell.category === category)!)
          return { scope, category, query: QUERIES[category], ...summary(cells.flatMap(cell => cell.samplesMs)) }
        })) }
    })
    const result = {
      benchmark: 'O13 KnowbaseService synthetic lifecycle', schemaVersion: 1, generatedAt: new Date().toISOString(),
      environment: { node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch, osRelease: os.release(),
        cpuModel: os.cpus()[0]?.model ?? 'unknown', logicalCpuCount: os.cpus().length, totalMemoryBytes: os.totalmem(), heapLimitMiB: HEAP_MIB,
        gcExposed: typeof globalThis.gc === 'function' },
      methodology: { sizesFiles: SIZES, bases: BASES, repeats: REPEATS, processIsolation: 'Fresh child for each size and repeat; serial workers',
        workers: { stdio: 'inherit', timeoutMs: 180000, nodeOptions: 'cleared', flags: ['--expose-gc', '--max-old-space-size=1536', '--experimental-strip-types'] },
        invocation: 'node --expose-gc --max-old-space-size=1536 --experimental-strip-types scripts/benchmark-service-scale.ts --output outputs/o13-service-scale.json',
        input: 'Deterministic UTF-8 .txt; 2046 characters each, 8 paragraphs; round-robin across four seeded MemoryStore bases',
        chunking: 'KnowbaseService defaults; no chunk options; actual counts/bytes from materials',
        cold: 'initialize() on seeded MemoryStore/createMemoryVaultFs; reconcile/extraction/chunking/indexing included; seeding excluded',
        unchanged: 'Global rescan; assert zero rebuilt/text reads, all reused, unchanged revisions',
        changed: 'Rewrite first 1% directly in memory fs; identical byte length; assert increasing mtime; global rescan once',
        retrieval: 'Actual service.retrieve defaults after changed scan; citation generation included, assertions excluded; three queries x two scopes',
        warmupsPerCell: WARMUP, timedSamplesPerCellPerRepeat: SAMPLES, percentile: 'Nearest-rank p95; conventional median; no machine thresholds',
        memory: 'Forced GC snapshots outside timing; process.memoryUsage in bytes; resourceUsage.maxRSS in KiB, whole-worker peak',
        memoryDuplication: 'Memory vault retains UTF-8 arrays while service retains decoded extractedText, chunk strings/contexts and BM25 structures. Seeded-vault baseline included; not disk-backed service-only memory.',
        limitations: ['Synthetic text only; no PDF extraction or OCR measurements', 'Memory fs omits disk latency, permissions and persistence costs',
          'One fixed query per category; warm samples do not measure quality or a production workload',
          '1536 MiB limits V8 old space, not total RSS; maxRSS includes all worker phases',
          'Cold initialize and incremental rescans do different reconciliation/state work; ratios describe this fixture only',
          'Three lifecycle samples: lifecycle p95 is maximum; retrieval pools 90 samples per cell'] },
      sourceSha256: hashes, aggregates, runs,
    }
    const json = JSON.stringify(result, null, 2) + '\n'
    assert(!/[A-Za-z]:\\\\|\\Users\\|\/Users\//.test(json), 'No absolute user paths in output')
    await mkdir(path.dirname(output), { recursive: true })
    await writeFile(output, json, { encoding: 'utf8', flag: 'wx' })
    console.log('O13 complete: outputs/o13-service-scale.json')
  } finally {
    assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()))
    assert(path.basename(temporary).startsWith(TEMP_PREFIX))
    await rm(temporary, { recursive: true, force: true })
  }
}
const args = process.argv.slice(2), isWorker = args[0] === '--worker'
const expected = isWorker ? ['--worker', '--size', '--repeat', '--output'] : ['--output']
const seen = new Set<string>(), values = new Map<string, string>()
for (let i = 0; i < args.length; i++) {
  const key = args[i]!
  assert(expected.includes(key) && !seen.has(key), `Unexpected or duplicate argument: ${key}`)
  seen.add(key)
  if (key !== '--worker') { const value = args[++i]; assert(value && !value.startsWith('--'), `Missing value: ${key}`); values.set(key, value) }
}
assert.equal(seen.size, expected.length, 'Usage: --output outputs/o13-service-scale.json')
const output = path.resolve(PROJECT, values.get('--output')!)
if (isWorker) await worker(Number(values.get('--size')), Number(values.get('--repeat')), output)
else await main(output)
