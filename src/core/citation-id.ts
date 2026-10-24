import { createHash } from 'node:crypto'

/** Exact evidence identity. Material rename/move may change materialId. */
export interface CitationIdentity {
  readonly kbId: string
  readonly materialId: string
  readonly ordinal: number
  readonly locator: string
  readonly text: string
}

/** v1 hashes the exact UTF-8 JSON tuple; no absolute paths, rank or revision.
 * This is an evidence fingerprint, not permanent identity or history storage.
 */
export function createCitationId(evidence: CitationIdentity): string {
  const tuple = JSON.stringify([
    evidence.kbId, evidence.materialId, evidence.ordinal, evidence.locator, evidence.text,
  ])
  return `kb-cite-v1-${createHash('sha256').update(tuple, 'utf8').digest('hex')}`
}
