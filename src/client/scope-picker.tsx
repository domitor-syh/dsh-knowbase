import * as React from 'react'
import { createPortal } from 'react-dom'
import { pageTokens } from './page-style.ts'
import { useColorScheme } from './theme.ts'

export type TestScope = 'base' | 'all'

const OPTIONS = [
  { value: 'base', label: '当前库' },
  { value: 'all', label: '全部库' },
] as const

interface PopupAt {
  top: number
  left: number
  width: number
}

/** Retrieval-only selector. The portal avoids the fixed-height card's clipping. */
export function ScopePicker(props: {
  value: TestScope
  onChange: (value: TestScope) => void
  baseCount: number
  currentAvailable: boolean
  disabled: boolean
}): React.ReactElement {
  const { value, onChange, baseCount, currentAvailable, disabled } = props
  const scheme = useColorScheme()
  const id = React.useId()
  const trigger = React.useRef<HTMLButtonElement>(null)
  const menu = React.useRef<HTMLDivElement>(null)
  const options = React.useRef<Array<HTMLButtonElement | null>>([])
  const initialFocus = React.useRef(0)
  const [at, setAt] = React.useState<PopupAt | undefined>(undefined)
  const open = at !== undefined && !disabled
  const unavailable = (index: number): boolean => index === 0 ? !currentAvailable : baseCount === 0

  const close = (restoreFocus = false): void => {
    setAt(undefined)
    if (restoreFocus) trigger.current?.focus({ preventScroll: true })
  }

  // Read geometry in events/effects, never during render. Re-measure on scroll
  // and resize so the menu stays attached without escaping the viewport.
  const position = React.useCallback((): PopupAt | undefined => {
    const button = trigger.current
    if (button === null || !button.isConnected) return undefined
    const rect = button.getBoundingClientRect()
    const width = Math.min(Math.max(rect.width, 112), window.innerWidth - 16)
    const height = menu.current?.getBoundingClientRect().height ?? 78
    const below = rect.bottom + 4
    return {
      top: below + height <= window.innerHeight - 8 ? below : Math.max(8, rect.top - height - 4),
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      width,
    }
  }, [])

  const show = (index: number): void => {
    initialFocus.current = index
    setAt(position())
  }

  React.useEffect(() => {
    if (!open) return
    const target = options.current[initialFocus.current]
    const fallback = options.current.find(option => option !== null && !option.disabled)
    if (target !== null && target !== undefined && !target.disabled) target.focus({ preventScroll: true })
    else if (fallback != null) fallback.focus({ preventScroll: true })
    else menu.current?.focus({ preventScroll: true })
  }, [open])

  React.useEffect(() => {
    if (disabled) setAt(undefined)
  }, [disabled])

  React.useEffect(() => {
    if (!open) return
    const outside = (event: Event): void => {
      const target = event.target as Node | null
      if (target !== null && !trigger.current?.contains(target) && !menu.current?.contains(target)) {
        setAt(undefined)
      }
    }
    const update = (): void => setAt(position())
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('focusin', outside)
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('focusin', outside)
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open, position])

  const choose = (index: number): void => {
    if (unavailable(index)) return
    onChange(OPTIONS[index]!.value)
    close(true)
  }

  const onMenuKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close(true)
      return
    }
    if (event.key === 'Tab') {
      // Restore the anchor before native Tab navigation so it reaches the next
      // page control, not a random element following the portal in document.body.
      close(true)
      return
    }
    const focused = options.current.findIndex(option => option === document.activeElement)
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      if (focused >= 0) choose(focused)
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const enabled = options.current.filter((option): option is HTMLButtonElement => option !== null && !option.disabled)
    const index = enabled.findIndex(option => option === document.activeElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length
    enabled[next]?.focus({ preventScroll: true })
  }

  return (
    <div className="kb-scope-picker">
      <button
        ref={trigger}
        type="button"
        className="kb-input kb-scope-trigger"
        data-kb-test-scope-select
        data-kb-base-count={baseCount}
        value={value}
        aria-label="检索范围"
        aria-describedby={`${id}-value`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-options` : undefined}
        disabled={disabled}
        onClick={() => open ? close() : show(value === 'all' ? 1 : 0)}
        onKeyDown={event => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
            event.preventDefault()
            show(event.key === 'Home' ? 0 : event.key === 'End' ? 1 : value === 'all' ? 1 : 0)
          } else if (event.key === 'Escape' && open) {
            event.preventDefault()
            close(true)
          }
        }}
      >
        <span id={`${id}-value`}>{value === 'all' ? '全部库' : '当前库'}</span>
        <span className="kb-scope-chevron" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" focusable="false">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </span>
      </button>
      {open && createPortal(
        <div
          ref={menu}
          id={`${id}-options`}
          className="kb-scope-menu"
          role="listbox"
          aria-label="检索范围选项"
          tabIndex={-1}
          style={{ ...pageTokens(scheme), ...at }}
          onKeyDown={onMenuKeyDown}
        >
          {OPTIONS.map((option, index) => (
            <button
              key={option.value}
              ref={node => { options.current[index] = node }}
              type="button"
              role="option"
              className="kb-scope-option"
              data-kb-test-scope-option={option.value}
              value={option.value}
              aria-selected={value === option.value}
              tabIndex={-1}
              disabled={unavailable(index)}
              onClick={() => choose(index)}
            >
              <span>{option.label}</span>
              {value === option.value && (
                <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" focusable="false">
                  <path d="m5 12 4 4 10-10" />
                </svg>
              )}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  )
}
