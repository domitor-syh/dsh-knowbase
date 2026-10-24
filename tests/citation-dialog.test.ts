import { afterEach, describe, expect, it } from 'vitest'
import { closeSources, showSources, sourceDialogActive } from '../src/client/citation-dialog.ts'

afterEach(() => closeSources())
describe('citation dialog ownership', () => {
  it('invalidates focus trapping before restoring focus', () => {
    const owner = {}
    let restored = false
    // A minimal focus sink, not a DOM renderer: tests the state ordering that
    // the real dialog focusin handler consults before redirecting focus.
    const target = { isConnected: true, focus(options: FocusOptions) {
      expect(sourceDialogActive(owner)).toBe(false)
      expect(options.preventScroll).toBe(true)
      restored = true
    } } as unknown as HTMLElement
    showSources({ owner, passages: [], restoreFocus: target })
    expect(sourceDialogActive(owner)).toBe(true)
    closeSources()
    expect(restored).toBe(true)
  })
  it('unmounting a different answer cannot close the active dialog', () => {
    const old = {}, current = {}
    showSources({ owner: old, passages: [], restoreFocus: null })
    showSources({ owner: current, passages: [], restoreFocus: null })
    closeSources(old)
    expect(sourceDialogActive(current)).toBe(true)
    closeSources(current)
    expect(sourceDialogActive(current)).toBe(false)
  })
  it('does not focus a disconnected trigger and closing twice is harmless', () => {
    const owner = {}
    const target = { isConnected: false, focus() { throw new Error('disconnected') } } as unknown as HTMLElement
    showSources({ owner, passages: [], restoreFocus: target })
    closeSources()
    closeSources()
    expect(sourceDialogActive(owner)).toBe(false)
  })
})
