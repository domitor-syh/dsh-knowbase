import { useSyncExternalStore } from 'react'
import type { SourcePassage } from './citation-scan.ts'

export type SourceDialog = Readonly<{
  owner: object
  passages: readonly SourcePassage[]
  restoreFocus: HTMLElement | null
}>
let current: SourceDialog | undefined
const listeners = new Set<() => void>()
const publish = () => listeners.forEach(fn => fn())
export function showSources(value: SourceDialog): void { current = value; publish() }
export function sourceDialogActive(owner: object): boolean { return current?.owner === owner }
export function closeSources(owner?: object): void {
  if (current === undefined || (owner !== undefined && current.owner !== owner)) return
  const target = current.restoreFocus
  current = undefined
  publish()
  if (target?.isConnected) target.focus({ preventScroll: true })
}
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }
const snapshot = () => current
export function useSourceDialog(): SourceDialog | undefined {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
