import { localizeLocator } from './ui-locale.ts'
import type { SourcePassage } from './citation-scan.ts'

export function validCitationId(value: unknown): value is string {
  return typeof value === 'string' && value.length === 75 && /^kb-cite-v1-[a-f0-9]{64}$/.test(value)
}

/** Original answer indexes survive grouping and filtering. Legacy titles are best effort. */
export function sourceGroups(passages: readonly SourcePassage[]) {
  const groups = new Map<string, {
    key: string; kbName: string; materialTitle: string
    entries: { passage: SourcePassage; index: number }[]
  }>()
  passages.forEach((passage, index) => {
    const key = passage.kbId !== undefined && passage.materialId !== undefined
      ? JSON.stringify(['id', passage.kbId, passage.materialId])
      : JSON.stringify(['legacy', passage.kbName, passage.materialTitle])
    let group = groups.get(key)
    if (group === undefined) {
      group = { key, kbName: passage.kbName, materialTitle: passage.materialTitle, entries: [] }
      groups.set(key, group)
    }
    group.entries.push({ passage, index })
  })
  return [...groups.values()]
}

export interface CopyLabels {
  base: string; file: string; location: string; id: string; legacy: string; hidden: string
}

/** Historical/custom metadata may itself contain paths; never copy those labels. */
export function citationLabel(value: string, hidden: string): string {
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').trim()
  return /[a-z]:[\\/]|\\\\|file:\/\/|(^|\s)\//iu.test(clean) ? hidden : clean.slice(0, 500)
}

/** Explicit allowlist. Never serialize the source object, path, IDs or document text. */
export function citationCopyText(passage: SourcePassage, index: number, labels: CopyLabels): string {
  return [
    `[${index + 1}]`,
    `${labels.base}: ${citationLabel(passage.kbName, labels.hidden)}`,
    `${labels.file}: ${citationLabel(passage.materialTitle, labels.hidden)}`,
    `${labels.location}: ${citationLabel(localizeLocator(passage.locator), labels.hidden)}`,
    validCitationId(passage.citationId) ? `${labels.id}: ${passage.citationId}` : labels.legacy,
  ].join('\n')
}

export type CopyResult = 'copied' | 'unavailable' | 'failed'
/** User click only. No clipboard reads, execCommand fallback, or raw errors. */
export async function copyCitation(text: string, clipboard?: Pick<Clipboard, 'writeText'>): Promise<CopyResult> {
  if (clipboard === undefined || typeof clipboard.writeText !== 'function') return 'unavailable'
  try {
    await clipboard.writeText(text)
    return 'copied'
  } catch {
    return 'failed'
  }
}
