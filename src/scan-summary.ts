import type { ScanReport } from './core/service.ts'

/** Bounded, one-line diagnostic labels; never copy raw OS exception messages. */
export function safeScanLabel(value: string): string {
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').trim()
  return /[a-z]:[\\/]|\\\\|file:\/\/|(^|\s)\//iu.test(clean) ? '路径已隐藏' : clean.slice(0, 500)
}

export function formatScanSummary(reports: readonly ScanReport[]): string {
  const total = (key: 'scanned' | 'added' | 'reused' | 'changed' | 'deleted' | 'rebuilt' | 'skipped' | 'unsearchable' | 'elapsedMs') =>
    reports.reduce((sum, report) => sum + report[key], 0)
  return `扫描 ${total('scanned')}，新增 ${total('added')}，复用 ${total('reused')}，变化 ${total('changed')}，删除 ${total('deleted')}，重建尝试 ${total('rebuilt')}，格式跳过 ${total('skipped')}，不可检索 ${total('unsearchable')}，分库耗时合计 ${Math.round(total('elapsedMs'))} ms。`
}

export function formatScanFailures(items: readonly { name: string; report: ScanReport }[]): string {
  const lines: string[] = []
  let total = 0
  for (const { name, report } of items) {
    total += report.failures.length + report.omittedFailures
    for (const failure of report.failures) {
      if (lines.length === 10) break
      lines.push(`「${safeScanLabel(name)} / ${safeScanLabel(failure.fileName)}」：${safeScanLabel(failure.reason)}`)
    }
  }
  if (total === 0) return ''
  return '\n不可检索文件（包含空文件、超限及 OCR 未就绪等）：\n' + lines.join('\n') +
    (total > lines.length ? `\n另 ${total - lines.length} 项未展开。` : '')
}
