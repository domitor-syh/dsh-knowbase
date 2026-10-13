/**
 * Pure presentation helpers for the composer's knowledge-base control.
 *
 * Kept out of the component file so they are testable without a DOM or React:
 * what the user is told about a scope — including the invalid one after a base
 * was deleted — is behaviour, not decoration. The component only renders it.
 *
 * @module @domitor-syh/dsh-knowbase/client/labels
 */

import type { KnowledgeBaseView, SessionScopeView } from '../remote.ts'

/**
 * The compact button label for one scope.
 *
 * A scope whose bases were all deleted reads 「范围失效」 rather than falling
 * back to anything: the plan requires a deleted selection to be shown as
 * invalid instead of being silently widened to every base.
 */
export function scopeLabel(
  scope: SessionScopeView | undefined,
  bases: readonly KnowledgeBaseView[],
): string {
  if (scope === undefined) return '知识库'
  if (!scope.enabled) return '知识库：关闭'
  if (scope.all) return `知识库：全部（${bases.length}）`
  if (scope.kbIds.length === 0) return '知识库：未选择'
  const names = scope.kbIds.map(id => bases.find(base => base.id === id)?.name ?? '已删除')
  return `知识库：${names.join('、')}`
}

/**
 * Selected base ids that no longer exist.
 *
 * Empty unless the scope is enabled and specific; the caller renders a warning
 * for each and never rewrites the selection itself.
 */
export function missingBaseIds(
  scope: SessionScopeView | undefined,
  bases: readonly KnowledgeBaseView[],
): readonly string[] {
  if (scope === undefined || !scope.enabled || scope.all) return []
  return scope.kbIds.filter(id => bases.every(base => base.id !== id))
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
    scope === undefined ? [] : scope.all ? bases.map(base => base.id) : [...scope.kbIds]
  if (current.includes(id)) return current.filter(candidate => candidate !== id)
  return [...current, id]
}