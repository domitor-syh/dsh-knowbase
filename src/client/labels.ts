/**
 * Pure presentation helpers for the composer's knowledge-base control.
 *
 * Kept out of the component file so they are testable without a DOM or React:
 * what the user is told about a scope — including the invalid one after a base
 * was deleted — is behaviour, not decoration. The component only renders it.
 *
 * The hand-off replaced the old prose label (「知识库：全部（2）」, 「知识库：关闭」)
 * with a count, so the button now answers one question — how many bases will be
 * searched — and every other distinction moved into the popover, where there is
 * room for it. The count deliberately ignores ids whose base no longer exists:
 * it is a promise about retrieval, and a deleted base cannot be retrieved.
 *
 * @module @domitor-syh/dsh-knowbase/client/labels
 */

import type { KnowledgeBaseView, SessionScopeView } from '../remote.ts'

/**
 * How many bases this scope will actually search.
 *
 * Zero covers both "switched off" and "nothing ticked", which the control now
 * treats as the same thing: no switch on means the knowledge base is not used.
 */
export function scopeCount(
  scope: SessionScopeView | undefined,
  bases: readonly KnowledgeBaseView[],
): number {
  if (scope === undefined || !scope.enabled) return 0
  if (scope.all) return bases.length
  return scope.kbIds.filter(id => bases.some(base => base.id === id)).length
}

/**
 * The compact button label for one scope.
 *
 * 「知识库」 alone means nothing will be searched; 「知识库 · N」 names the count.
 * A deleted base is reported by the popover rather than smuggled into the count,
 * so the number always equals the number of bases that can answer.
 */
export function scopeLabel(
  scope: SessionScopeView | undefined,
  bases: readonly KnowledgeBaseView[],
): string {
  const count = scopeCount(scope, bases)
  return count === 0 ? '知识库' : `知识库 · ${count}`
}

/**
 * Whether every existing base is in scope.
 *
 * Drives the popover's one footer action, whose label flips between 「全部开启」
 * and 「全部关闭」: the hand-off gives that slot a single action, and this is
 * what lets one slot carry both without inventing a second one.
 */
export function allSelected(
  scope: SessionScopeView | undefined,
  bases: readonly KnowledgeBaseView[],
): boolean {
  if (scope === undefined || !scope.enabled || bases.length === 0) return false
  if (scope.all) return true
  return bases.every(base => scope.kbIds.includes(base.id))
}

/**
 * Selected base ids that no longer exist.
 *
 * Empty unless the scope is enabled and specific; the caller renders a warning
 * for each and never rewrites the selection itself. The plan requires a deleted
 * selection to be shown as invalid instead of being silently widened to every
 * base — and now that the button carries only a count, this warning is the only
 * place that requirement is still visible.
 */
export function missingBaseIds(
  scope: SessionScopeView | undefined,
  bases: readonly KnowledgeBaseView[],
): readonly string[] {
  if (scope === undefined || !scope.enabled || scope.all) return []
  return scope.kbIds.filter(id => bases.every(base => base.id !== id))
}

/**
 * Whether one base's switch should read as on.
 *
 * `enabled` gates this exactly as it gates the count, and the gate is not
 * decoration: the Host's default for a session that has never chosen is
 * `{ enabled: false, all: true }` (see `core/session-scope.ts`), so without it
 * every switch is drawn on while the button says the knowledge base is not in
 * use — the panel and the pill contradicting each other about the same fact.
 */
export function isBaseSelected(scope: SessionScopeView | undefined, id: string): boolean {
  if (scope === undefined || !scope.enabled) return false
  return scope.all || scope.kbIds.includes(id)
}

/**
 * The selected ids after ticking or unticking one base.
 *
 * The stored shape has two ways to say the same set — `all: true` and an
 * explicit list of every id — and they are not interchangeable: `all` also
 * covers bases created later. So unticking one base while `all` is on has to
 * materialise the list the user was looking at before dropping one, or the
 * untick would silently do nothing.
 *
 * `all` only counts as "everything is ticked" when the scope is *enabled*. A
 * switched-off scope still remembers `all`, and treating that as a full tick
 * list inverts the first thing a user does: ticking one base would expand `all`
 * to every id and then drop the one clicked, so asking for A would select B.
 *
 * Existing ids keep their order and are appended to, so the list never
 * reshuffles under the pointer; ids whose base was deleted stay in the list
 * rather than being dropped, which is what keeps a stale selection visible as
 * stale instead of quietly shrinking to "valid".
 */
export function toggleBaseSelection(
  scope: SessionScopeView | undefined,
  bases: readonly KnowledgeBaseView[],
  id: string,
): readonly string[] {
  const current: readonly string[] =
    scope === undefined || !scope.enabled
      ? []
      : scope.all
        ? bases.map(base => base.id)
        : [...scope.kbIds]
  if (current.includes(id)) return current.filter(candidate => candidate !== id)
  return [...current, id]
}

/**
 * Whether a base name survives the popover's search box.
 *
 * Substring, case- and width-insensitive, so a name typed in half-width
 * characters still matches one stored in full-width. An empty query matches
 * everything, which is what makes the box's cleared state the full list.
 */
export function matchesQuery(name: string, query: string): boolean {
  const needle = query.normalize('NFKC').trim().toLowerCase()
  if (needle === '') return true
  return name.normalize('NFKC').toLowerCase().includes(needle)
}
