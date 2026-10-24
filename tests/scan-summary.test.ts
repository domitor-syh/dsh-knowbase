import { describe, expect, it } from 'vitest'
import type { ScanReport } from '../src/core/service.ts'
import { formatScanFailures, formatScanSummary, safeScanLabel } from '../src/scan-summary.ts'
import { TYPERT_REMOTE } from '../src/client/contribution.ts'

const report: ScanReport = {
  mode: 'incremental', startedAt: 100, completedAt: 125, elapsedMs: 25,
  scanned: 3, added: 1, reused: 1, changed: 1, deleted: 1, rebuilt: 2, skipped: 1,
  unsearchable: 1, failures: [{ fileName: 'nested/empty.txt', reason: '未提取到可检索文字。' }], omittedFailures: 0,
}

function schema() {
  const codec = TYPERT_REMOTE.descriptors.find(item => item.method === 'listKnowledgeBases')!.result!
  if (codec.mode !== 'strict') throw new Error('expected strict codec')
  return codec.create() as { parse(value: unknown): unknown; safeParse(value: unknown): { success: boolean } }
}
const base = { id: 'kb', name: 'fixture', description: '', folderName: 'fixture__kb', materialCount: 3, indexedCount: 1, bytes: 10, updatedAt: 100 }

describe('scan report transport and bounded summaries', () => {
  it('preserves a new Host report rather than silently stripping it', () => {
    expect(schema().parse([{ ...base, lastScan: report }])).toEqual([{ ...base, lastScan: report }])
  })
  it('accepts a legacy Host without lastScan', () => {
    expect(schema().parse([base])).toEqual([base])
  })
  it('rejects oversized diagnostics and invalid counters at the wire boundary', () => {
    expect(schema().safeParse([{ ...base, lastScan: { ...report, failures: Array(101).fill(report.failures[0]) } }]).success).toBe(false)
    expect(schema().safeParse([{ ...base, lastScan: { ...report, reused: -1 } }]).success).toBe(false)
  })
  it('sums per-base scan times and all count categories', () => {
    const text = formatScanSummary([report, report])
    expect(text).toContain('扫描 6，新增 2，复用 2，变化 2，删除 2，重建尝试 4，格式跳过 2，不可检索 2')
    expect(text).toContain('分库耗时合计 50 ms')
  })
  it('caps command diagnostics at ten and retains omitted-file totals', () => {
    const failures = Array.from({ length: 15 }, (_, i) => ({ fileName: `file-${i}.txt`, reason: 'empty' }))
    const text = formatScanFailures([{ name: 'a', report: { ...report, failures, unsearchable: 18, omittedFailures: 3 } }, { name: 'b', report }])
    expect(text).toContain('file-9.txt')
    expect(text).not.toContain('file-10.txt')
    expect(text).toContain('另 9 项未展开')
    expect(formatScanFailures([])).toBe('')
  })
  it.each(['C:\\Users\\private.txt', 'C:/Users/private.txt', '\\\\host\\share', '/private/path', 'file:///private/path'])(
    'hides recognizable absolute paths: %s', value => expect(safeScanLabel(value)).toBe('路径已隐藏'),
  )
  it('keeps relative subdirectories, removes controls and bounds diagnostic labels', () => {
    expect(safeScanLabel('nested/file.txt')).toBe('nested/file.txt')
    expect(safeScanLabel('one\r\ntwo')).toBe('one  two')
    expect(safeScanLabel('x'.repeat(700))).toHaveLength(500)
  })
})
