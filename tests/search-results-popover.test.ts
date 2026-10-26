import { describe, expect, it } from 'vitest'
import { searchResultsPosition } from '../src/client/search-results-popover.tsx'

const row = { left: 100, top: 120, bottom: 160, width: 720 }

describe('search results viewport placement', () => {
  it('stays below and aligned with the search row, with bounded result height', () => {
    expect(searchResultsPosition(row, { width: 1200, height: 900 })).toEqual({
      left: 100, top: 168, width: 720, maxHeight: 480,
    })
  })

  it('fits the viewport when the page is narrower than the anchor', () => {
    const at = searchResultsPosition(row, { width: 360, height: 640 })!
    expect(at.left).toBe(8)
    expect(at.width).toBe(344)
    expect(at.maxHeight).toBe(464)
    expect(at.left + at.width).toBeLessThanOrEqual(352)
    expect(at.top + at.maxHeight).toBeLessThanOrEqual(632)
  })

  it('keeps results below the row when scrolling reduces the space beneath it', () => {
    expect(searchResultsPosition({ ...row, top: 400, bottom: 440 }, { width: 900, height: 600 })).toMatchObject({
      top: 448, maxHeight: 144,
    })
    expect(searchResultsPosition({ ...row, left: -40 }, { width: 900, height: 600 })?.left).toBe(8)
  })

  it('does not pin stale results to the viewport when the search row scrolls away', () => {
    expect(searchResultsPosition({ ...row, top: -80, bottom: -40 }, { width: 900, height: 600 })).toBeUndefined()
    expect(searchResultsPosition({ ...row, top: 600, bottom: 640 }, { width: 900, height: 600 })).toBeUndefined()
    expect(searchResultsPosition({ ...row, top: 500, bottom: 540 }, { width: 900, height: 600 })).toBeUndefined()
  })
})
