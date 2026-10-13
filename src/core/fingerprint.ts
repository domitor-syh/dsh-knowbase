/**
 * Content fingerprints, for detecting the same material twice in one base.
 *
 * The plan's ingestion pipeline starts with 哈希去重, and the reason is
 * cost rather than tidiness: a duplicated material doubles its chunks in the
 * index, doubles the bytes on disk, and makes every retrieval return the same
 * passage twice — which reads to a user as the plugin not understanding its own
 * content.
 *
 * ## What counts as "the same"
 *
 * Normalisation before hashing is a deliberate choice with a visible
 * consequence, so it is spelled out rather than left implicit:
 *
 * - **NFKC** — the same rule retrieval uses, so `１１５２００` and `115200`
 *   are one material rather than two.
 * - **Whitespace runs collapse to a single space, then the ends are trimmed** —
 *   the same paragraph pasted with different line wrapping is one material.
 *
 * Case is *not* folded, unlike tokenization. Retrieval folds case because a
 * query is a guess at spelling; a stored material is not, and `USB` versus
 * `usb` in two documents is a difference a user can see.
 *
 * This is a duplicate *warning* whose answer a user can override, so the rule
 * is allowed to be this aggressive: a false positive costs one extra click,
 * while a false negative costs a silent duplicate in the index.
 *
 * @module @domitor-syh/dsh-knowbase/core/fingerprint
 */

import { createHash } from 'node:crypto'

/**
 * Reduce text to the form that is compared.
 *
 * Exported because it is the interesting half of the rule — the hash is only
 * the cheap comparison — and tests assert on it directly.
 */
export function normalizeForFingerprint(text: string): string {
  return text.normalize('NFKC').replace(/\s+/gu, ' ').trim()
}

/**
 * A stable identity for a piece of text.
 *
 * SHA-256 rather than a cheap rolling hash: the value is persisted alongside
 * the material, and a collision would silently refuse a legitimate add. There
 * is no secret here, so a cryptographic digest is used purely for its
 * collision resistance.
 */
export function contentFingerprint(text: string): string {
  return createHash('sha256').update(normalizeForFingerprint(text), 'utf8').digest('hex')
}
