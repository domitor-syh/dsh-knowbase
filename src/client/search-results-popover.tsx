import * as React from 'react'
import { createPortal } from 'react-dom'
import { useCitationText } from './citation-locale.ts'
import { Icon } from './icons.tsx'
import { pageTokens } from './page-style.ts'
import { useColorScheme } from './theme.ts'

/** Keep results below the search row, inside the viewport, outside page flow. */
export function searchResultsPosition(
  anchor: Pick<DOMRect, 'left' | 'top' | 'bottom' | 'width'>,
  viewport: { width: number; height: number },
): { top: number; left: number; width: number; maxHeight: number } | undefined {
  if (anchor.bottom < 0 || anchor.top >= viewport.height) return undefined
  const width = Math.max(0, Math.min(anchor.width, viewport.width - 16))
  const top = Math.max(8, anchor.bottom + 8)
  const maxHeight = Math.min(480, viewport.height - top - 8)
  if (maxHeight < 96) return undefined
  return {
    top, left: Math.max(8, Math.min(anchor.left, viewport.width - width - 8)), width, maxHeight,
  }
}

/** Nonmodal results: the surrounding page remains usable and never moves. */
export function SearchResultsPopover({ anchor, onClose, children }: {
  anchor: React.RefObject<HTMLDivElement>
  onClose: () => void
  children: React.ReactNode
}): React.ReactElement | null {
  const t = useCitationText()
  const scheme = useColorScheme()
  const id = React.useId()
  const panel = React.useRef<HTMLDivElement>(null)
  const closeButton = React.useRef<HTMLButtonElement>(null)
  const [at, setAt] = React.useState<ReturnType<typeof searchResultsPosition>>()

  React.useLayoutEffect(() => {
    const update = (event?: Event): void => {
      // Scrolling results does not move their anchor or require another render.
      if (event?.target instanceof Node && panel.current?.contains(event.target)) return
      const element = anchor.current
      setAt(element === null ? undefined : searchResultsPosition(element.getBoundingClientRect(), {
        width: window.innerWidth, height: window.innerHeight,
      }))
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [anchor])

  const visible = at !== undefined
  React.useEffect(() => {
    if (visible) closeButton.current?.focus({ preventScroll: true })
  }, [visible])

  if (at === undefined) return null
  return createPortal(
    <div ref={panel} className="kb-search-results" role="dialog" aria-modal="false" aria-labelledby={id}
      data-kb-search-results style={{ ...pageTokens(scheme), ...at }}
      onKeyDown={event => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }}>
      <div className="kb-search-results-head">
        <h2 id={id}>{t('searchResults')}</h2>
        <button ref={closeButton} type="button" className="kb-icon-btn" aria-label={t('closeSearchResults')}
          data-kb-search-results-close onClick={onClose}><Icon name="x" /></button>
      </div>
      <div className="kb-search-results-body">{children}</div>
    </div>, document.body,
  )
}
