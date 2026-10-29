import * as React from 'react'

export interface SourceFilterOption { readonly value: string; readonly label: string }

/** In-dialog listbox: no OS-owned select popup, portal, or persistent focus ring. */
export function SourceFilter({ label, value, options, onChange }: {
  label: string
  value: string
  options: readonly SourceFilterOption[]
  onChange: (value: string) => void
}): React.ReactElement {
  const id = React.useId()
  const root = React.useRef<HTMLDivElement>(null)
  const trigger = React.useRef<HTMLButtonElement>(null)
  const menu = React.useRef<HTMLDivElement>(null)
  const [open, setOpen] = React.useState(false)
  const [active, setActive] = React.useState(0)
  const selected = Math.max(0, options.findIndex(option => option.value === value))
  const close = (restore = false): void => {
    setOpen(false)
    if (restore) trigger.current?.focus({ preventScroll: true })
  }
  const show = (index: number): void => { setActive(index); setOpen(true) }
  React.useEffect(() => {
    if (!open) return
    menu.current?.focus({ preventScroll: true })
    const outside = (event: Event): void => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('focusin', outside)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('focusin', outside)
    }
  }, [open])
  React.useEffect(() => {
    if (open) menu.current?.querySelector<HTMLElement>(`[data-kb-filter-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [open, active])
  const choose = (index: number): void => {
    const option = options[index]
    if (!option) return
    onChange(option.value)
    close(true)
  }
  return <div className="kb-source-filter" data-kb-source-filter ref={root}>
    <button ref={trigger} type="button" className="kb-source-filter-trigger" aria-label={label}
      aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => open ? close() : show(selected)}
      onKeyDown={event => {
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault()
          show(event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : selected)
        }
      }}>
      <span>{options[selected]?.label}</span>
      <svg className="kb-source-filter-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true" focusable="false"><path d="m6 9 6 6 6-6" /></svg>
    </button>
    {open ? <div ref={menu} id={id} className="kb-source-filter-menu" role="listbox" aria-label={label}
      tabIndex={-1} aria-activedescendant={`${id}-${active}`}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return }
        if (event.key === 'Tab') { close(true); return }
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(active); return }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        setActive(index => event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length)
      }}>
      {options.map((option, index) => <div key={option.value} id={`${id}-${index}`} role="option"
        data-kb-filter-index={index} aria-selected={value === option.value} data-active={active === index}
        className="kb-source-filter-option" onPointerMove={() => setActive(index)} onClick={() => choose(index)}>
        <span>{option.label}</span>
        {value === option.value ? <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="m5 12 4 4 10-10" /></svg> : null}
      </div>)}
    </div> : null}
  </div>
}
