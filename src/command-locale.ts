import type { Context } from '@deepseek-ai/cordis'
import type { ScanReport } from './core/service.ts'
import { localizeDiagnostic, localizePosition, type DiagnosticLanguage } from './diagnostic-locale.ts'
import { formatScanFailures, formatScanSummary, safeScanLabel } from './scan-summary.ts'

export type CommandText = (zh: string, en: string) => string

/** Read public profile entries and live settings; never depend on a profile row id. */
export function commandLanguage(ctx: Context): DiagnosticLanguage {
  const access = ctx as unknown as { get?: (name: string) => unknown }
  try {
    const editor = access.get?.('configEditor') as {
      entries(): readonly { options: { name?: string; id: string } }[]
    } | undefined
    const settings = access.get?.('settings') as {
      describe(options: { redactSecrets: boolean }): readonly { ns: string; value: unknown }[]
    } | undefined
    if (editor === undefined || settings === undefined) return 'zh'
    const entries = editor.entries().filter(entry => entry.options.name === '@deepseek-ai/dsh-client-locale')
    if (entries.length !== 1) return 'zh'
    const value = settings.describe({ redactSecrets: true }).find(item => item.ns === entries[0]!.options.id)?.value
    const preference = value !== null && typeof value === 'object' ? (value as { preference?: unknown }).preference : undefined
    // No persisted choice means the browser chooses its provisional language.
    // Host commands cannot observe that browser-local fallback; retain legacy Chinese.
    return typeof preference === 'string' && preference !== '' && !preference.toLowerCase().startsWith('zh') ? 'en' : 'zh'
  } catch {
    return 'zh'
  }
}

export function commandText(ctx: Context): CommandText {
  const language = commandLanguage(ctx)
  return (zh, en) => language === 'en' ? en : zh
}

export function commandDiagnostic(message: string, tx: CommandText): string {
  return localizeDiagnostic(message, tx('zh', 'en') as DiagnosticLanguage)
}

export function commandPosition(value: string, tx: CommandText): string {
  return localizePosition(value, tx('zh', 'en') as DiagnosticLanguage)
}

export function commandScanSummary(reports: readonly ScanReport[], tx: CommandText): string {
  if (tx('zh', 'en') === 'zh') return formatScanSummary(reports)
  const total = (key: 'scanned' | 'added' | 'reused' | 'changed' | 'deleted' | 'rebuilt' | 'skipped' | 'unsearchable' | 'elapsedMs') =>
    reports.reduce((sum, report) => sum + report[key], 0)
  return `Scanned ${total('scanned')}, added ${total('added')}, reused ${total('reused')}, changed ${total('changed')}, deleted ${total('deleted')}, rebuild attempts ${total('rebuilt')}, unsupported formats ${total('skipped')}, unsearchable ${total('unsearchable')}, total scan time ${Math.round(total('elapsedMs'))} ms.`
}

export function commandScanFailures(items: readonly { name: string; report: ScanReport }[], tx: CommandText): string {
  if (tx('zh', 'en') === 'zh') return formatScanFailures(items)
  const label = (value: string): string => {
    const safe = safeScanLabel(value)
    return safe === '路径已隐藏' && value !== safe ? 'Path hidden' : safe
  }
  const lines: string[] = []
  let total = 0
  for (const { name, report } of items) {
    total += report.failures.length + report.omittedFailures
    for (const failure of report.failures) {
      if (lines.length === 10) break
      lines.push(`“${label(name)} / ${label(failure.fileName)}”: ${commandDiagnostic(label(failure.reason), tx)}`)
    }
  }
  if (total === 0) return ''
  return '\nUnsearchable files (including empty files, size limits, and missing OCR packs):\n' + lines.join('\n') +
    (total > lines.length ? `\n${total - lines.length} more not shown.` : '')
}
