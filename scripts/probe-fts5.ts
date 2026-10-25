import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { Bm25Index } from '../src/core/bm25.ts'
import { tokenize } from '../src/core/tokenize.ts'
import { createCitationId } from '../src/core/citation-id.ts'

// Synthetic compatibility spike only: every database is :memory:; the sole write
// is the explicitly requested JSON report. No profile, vault or plugin runtime.
const root = fileURLToPath(new URL('../', import.meta.url))
const args = process.argv.slice(2)
const checkOnly = args.length === 1 && args[0] === '--check'
assert.ok(checkOnly || (args.length === 2 && args[0] === '--output'),
  'Usage: node scripts/probe-fts5.ts --check | --output outputs/o13-fts5-compatibility.json')
const output = checkOnly ? undefined : path.resolve(root, args[1]!)
if (output !== undefined) assert.equal(output, path.join(root, 'outputs', 'o13-fts5-compatibility.json'))
const sources = await Promise.all([
  'scripts/probe-fts5.ts', 'src/core/tokenize.ts', 'src/core/bm25.ts',
  'src/core/service.ts', 'src/core/citation-id.ts',
].map(async file => ({ file, sha256: createHash('sha256').update(await readFile(path.join(root, file))).digest('hex') })))
const db = new DatabaseSync(':memory:')
const assertions: { name: string; passed: boolean }[] = []
function check(name: string, value: boolean) { assertions.push({ name, passed: value }) }
const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
const quote = (text: string) => '"' + text.replaceAll('"', '""') + '"'
const runtimeRow = db.prepare("SELECT sqlite_version() sqlite, sqlite_compileoption_used('ENABLE_FTS5') enableFts5").get() as { sqlite: string; enableFts5: number }
const runtime = {
  node: process.version, platform: process.platform, arch: process.arch,
  sqlite: runtimeRow.sqlite, enableFts5: runtimeRow.enableFts5,
  compileOptions: db.prepare('PRAGMA compile_options').all().map(row => row.compile_options),
}
check('ENABLE_FTS5 is compiled in', runtime.enableFts5 === 1)
const docs = [
  ['han', '增值税申报截止日期，发票应当归档。古文字𠀀说明。默认波特率115200。'],
  ['ident', '电话13363537216，型号ZX2048'], ['split', '1234 5678'], ['joined', '12345678'],
  ['mixed', '本产品支持USB与以太网两种连接方式。Ethernet cable connects the device.'],
  ['width', 'ＺＸ２０４８ ＥＴＨＥＲＮＥＴ １３３６３５３７２１６'],
  ['latin', 'ethernetting'], ['scattered', '635 353 zx20 2048'],
] as const
const baseline = new Bm25Index()
for (const [id, body] of docs) baseline.add(id, body)
for (const [table, tokenizer] of [['u', 'unicode61'], ['t', 'trigram'], ['grams', 'unicode61']]) {
  db.exec(`CREATE VIRTUAL TABLE ${table} USING fts5(id UNINDEXED,body,tokenize='${tokenizer}')`)
  for (const [id, body] of docs) db.prepare(`INSERT INTO ${table}(id,body) VALUES (?,?)`).run(id, table === 'grams' ? tokenize(body).join(' ') : body)
}
function ids(table: string, match: string): string[] {
  return db.prepare(`SELECT id FROM ${table} WHERE ${table} MATCH ? ORDER BY id`).all(match).map(row => row.id as string)
}
const expectations: [string, readonly string[]][] = [
  ['税', ['han']], ['𠀀', ['han']], ['发票', ['han']], ['波特率', ['han']],
  ['6353', ['ident', 'width']], ['133', ['ident', 'width']], ['35', ['ident', 'scattered', 'width']],
  ['3456', ['joined']], ['ZX2048', ['ident', 'width']], ['ZX2099', []],
  ['13399999999', []], ['6353999', []], ['ＺＸ２０４８', ['ident', 'width']],
  ['ethernet', ['mixed', 'width']], ['Ethernet', ['mixed', 'width']],
  ['USB连接方式', ['mixed']], ['电话13399999999是多少', ['ident', 'width']],
]
const queryCases = expectations.map(([query, expected]) => {
  const currentBm25 = baseline.search(query, { limit: 20 }).map(hit => hit.id).sort()
  const orQuery = [...new Set(tokenize(query))].map(quote).join(' OR ')
  const rawUnicode61 = ids('u', quote(query))
  const rawTrigram = ids('t', quote(query))
  const pretokenizedOr = ids('grams', orQuery)
  check(`current contract: ${query}`, equal(currentBm25, expected))
  return { query, currentBm25, rawUnicode61, rawTrigram, pretokenizedOr, orQuery,
    recallSetParity: { rawUnicode61: equal(rawUnicode61, currentBm25), rawTrigram: equal(rawTrigram, currentBm25), pretokenizedOr: equal(pretokenizedOr, currentBm25) } }
})
const row = (query: string) => queryCases.find(candidate => candidate.query === query)!
for (const query of ['税', '𠀀', '发票', '35']) check(`raw trigram misses short query: ${query}`, row(query).rawTrigram.length === 0)
for (const query of ['税', '𠀀']) check(`pretokenized OR needs single-Han side postings: ${query}`, row(query).pretokenizedOr.length === 0)
for (const query of ['发票', '35', 'ethernet', 'USB连接方式']) check(`pretokenized OR recall parity: ${query}`, row(query).recallSetParity.pretokenizedOr)
check('raw trigram overmatches whole English word', row('ethernet').rawTrigram.includes('latin'))
check('pretokenized OR needs contiguous identifier guard', row('ZX2099').pretokenizedOr.length > 0 && row('ZX2099').currentBm25.length === 0)
check('trigram contiguous fragment does not cross separate runs', equal(row('3456').rawTrigram, ['joined']))
for (const table of ['u', 't']) db.exec(`CREATE VIRTUAL TABLE ${table}_vocab USING fts5vocab(${table},'instance')`)
const tokenEvidence = {
  unicode61Han: db.prepare('SELECT term,col,offset FROM u_vocab WHERE doc=1 ORDER BY offset').all(),
  trigramAstral: db.prepare("SELECT term,offset FROM t_vocab WHERE doc=1 AND term LIKE '%𠀀%' ORDER BY offset").all(),
  shortLikeFallback: db.prepare("SELECT id FROM t WHERE body LIKE '%税%' ORDER BY id").all(),
}
// The SQL scope predicate filters returned rows, but bm25 still uses table-wide statistics.
db.exec("CREATE VIRTUAL TABLE scoped USING fts5(id UNINDEXED,kb UNINDEXED,body,tokenize='unicode61')")
const add = db.prepare('INSERT INTO scoped(id,kb,body) VALUES (?,?,?)')
const currentScope = new Bm25Index()
for (const [id, text] of [['a', 'alpha beta'], ['b', 'alpha alpha beta']]) { add.run(id!, 'allowed', text!); currentScope.add(id!, text!) }
const selected = () => db.prepare("SELECT id,bm25(scoped) score FROM scoped WHERE scoped MATCH 'alpha' AND kb='allowed' ORDER BY score,id").all()
const accepted = () => currentScope.search('alpha', { accept: id => id === 'a' || id === 'b' })
const scopeBefore = selected(), currentBefore = accepted()
for (let i = 0; i < 20; i++) { const text = 'gamma '.repeat(i + 1); add.run(`hidden${i}`, 'hidden', text); currentScope.add(`hidden${i}`, text) }
const scopeAfter = selected(), currentAfter = accepted()
check('raw bm25 selected scores change after hidden inserts', !equal(scopeBefore, scopeAfter))
check('current scoped scores remain exactly equal after hidden inserts', equal(currentBefore, currentAfter))
const scope = { sql: "SELECT id,bm25(scoped) score FROM scoped WHERE scoped MATCH 'alpha' AND kb='allowed' ORDER BY score,id", hiddenDocumentsAdded: 20, rawBefore: scopeBefore, rawAfter: scopeAfter, currentBefore, currentAfter }
// Rank all candidates, collapse equivalent evidence, then apply the context limit.
db.exec("CREATE VIRTUAL TABLE duplicate USING fts5(id UNINDEXED,kb UNINDEXED,material UNINDEXED,body,tokenize='unicode61')")
const dup = db.prepare('INSERT INTO duplicate(id,kb,material,body) VALUES (?,?,?,?)')
for (let i = 0; i < 12; i++) dup.run(`a${String(i).padStart(2, '0')}`, 'A', 'same', 'alpha')
dup.run('z', 'A', 'other', 'alpha beta gamma delta')
const scored = "SELECT id,kb,material,body,bm25(duplicate) score FROM duplicate WHERE duplicate MATCH 'alpha'"
const limitFirstSql = `SELECT id,material FROM (${scored} ORDER BY score,id LIMIT 2) GROUP BY kb,material,body`
const dedupFirstSql = `WITH scored AS MATERIALIZED (${scored}), winners AS (SELECT *,row_number() OVER(PARTITION BY kb,material,body ORDER BY score,id) n FROM scored) SELECT id,material,score FROM winners WHERE n=1 ORDER BY score,id LIMIT 2`
const limitFirst = db.prepare(limitFirstSql).all(), dedupFirst = db.prepare(dedupFirstSql).all()
check('LIMIT first loses the supplemental source', equal(limitFirst.map(hit => hit.id), ['a00']))
check('rank/dedup before LIMIT fills the budget', equal(dedupFirst.map(hit => hit.id), ['a00', 'z']))
const distinct = { repeatedChunks: 12, limit: 2, limitFirstSql, dedupFirstSql, limitFirst, dedupFirst,
  caveat: 'Probe uses already identical bodies; a real adapter needs [kbId, materialId, NFKC+whitespace-normalized body], retaining original evidence and existing tie order.' }
db.exec("CREATE VIRTUAL TABLE inc USING fts5(id UNINDEXED,body,tokenize='trigram')")
const hits = (query: string) => db.prepare('SELECT id,body FROM inc WHERE inc MATCH ? ORDER BY id').all(quote(query))
db.prepare('INSERT INTO inc(id,body) VALUES (?,?)').run('a', '增值税申报')
const inserted = hits('增值税')
db.exec("BEGIN; UPDATE inc SET body='园艺种植技术' WHERE id='a'; COMMIT;")
const replaced = { old: hits('增值税'), next: hits('园艺种') }
db.exec("DELETE FROM inc WHERE id='a'")
const removed = hits('园艺种')
check('regular FTS insert recalls', inserted.length === 1)
check('regular FTS UPDATE removes old postings and adds new', replaced.old.length === 0 && replaced.next.length === 1)
check('regular FTS DELETE removes postings', removed.length === 0)
db.exec("CREATE VIRTUAL TABLE norm USING fts5(id UNINDEXED,body,tokenize='trigram')")
db.prepare('INSERT INTO norm(id,body) VALUES (?,?)').run('width', 'ＺＸ２０４８ ＥＴＨＥＲＮＥＴ'.normalize('NFKC').toLowerCase())
const normalization = ['ZX2048', 'ＺＸ２０４８', 'ethernet'].map(query => ({ query, ids: ids('norm', quote(query.normalize('NFKC').toLowerCase())) }))
check('explicit NFKC at ingestion/query restores fullwidth recall', normalization.every(result => equal(result.ids, ['width'])))
const identity = { kbId: 'synthetic-base', materialId: 'synthetic.txt', ordinal: 0, locator: '第 1 行', text: '恢复出厂设置 ＡＢＣ。' }
const citation = { identity, id: createCitationId(identity), normalizedBodyId: createCitationId({ ...identity, text: identity.text.normalize('NFKC') }),
  caveat: 'Exact existing citation function only; no service/reader integration or migration was attempted.' }
check('citation must retain original body rather than normalized indexed body', citation.id !== citation.normalizedBodyId)
db.close()
const report = {
  schemaVersion: 1, kind: 'O13 synthetic in-memory FTS5 compatibility spike', generatedAt: new Date().toISOString(),
  command: 'node --experimental-strip-types scripts/probe-fts5.ts --output outputs/o13-fts5-compatibility.json',
  runtime, sources, corpus: docs.map(([id, body]) => ({ id, body })), queryCases, tokenEvidence, scope, distinct,
  increments: { inserted, replaced, removed, caveat: 'Regular content-bearing FTS5 table only; external-content triggers, crash durability and storage migration are untested.' },
  normalization, citation, assertions, summary: { passed: assertions.filter(item => item.passed).length, total: assertions.length },
  conclusion: 'Raw unicode61/trigram and built-in bm25 are not contract-compatible drop-in replacements. SQLite may support a custom adapter; this probe does not implement or benchmark one.',
  nextGates: [
    'Retain current NFKC/tokenization, single-Han side postings (including astral), identifier-run continuity guard, OR recall, coverage and positive score semantics.',
    'Implement exact scoped N/DF/average-length statistics and scoring, excluding single-Han-only documents from ordinary BM25 statistics; test arbitrary multi-base selections and hidden mutations.',
    'Preserve title+body indexing, original citation metadata/text, normalized evidence dedup before limit, and deterministic tie order; run all 26 quality cases plus rebuild/increment regressions.',
    'Measure complete compatible adapter against current implementation at 1k/10k/50k synthetic chunks: build/query/update/delete latency, candidate fanout, process memory and SQLite pages; include short-query fallback scans.',
    'Require separate authorization before any production adapter, persistent storage design, migration, external dependency or real knowledge-base access.',
  ],
}
assert.ok(assertions.every(item => item.passed), 'Compatibility probe expectation failed: ' + assertions.filter(item => !item.passed).map(item => item.name).join(', '))
if (output === undefined) {
  console.log(`FTS5 compatibility probe: ${report.summary.passed}/${report.summary.total} assertions passed; ${queryCases.length} query cases; no files written.`)
} else {
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', 'utf8')
  console.log(JSON.stringify({ output: path.relative(root, output).replaceAll('\\', '/'), runtime: { node: runtime.node, sqlite: runtime.sqlite, enableFts5: runtime.enableFts5 }, assertions: report.summary, queryCases: queryCases.length, scope: { rawBefore: scopeBefore, rawAfter: scopeAfter }, distinct: { limitFirst, dedupFirst } }, null, 2))
}
