import * as React from 'react'
import { createPortal } from 'react-dom'
import type { MaterialView } from '../remote.ts'
import { Icon, type IconName } from './icons.tsx'
import { pageTokens } from './page-style.ts'
import { useColorScheme } from './theme.ts'
import { useUiText, localizeError } from './ui-locale.ts'

const useBrowserLayoutEffect = typeof window === 'undefined' ? React.useEffect : React.useLayoutEffect

/** Immediate tooltip, with no lifetime timer and no dependency on native title. */
export function MaterialStatus({ material }: { material: MaterialView }): React.ReactElement | null {
  const tx = useUiText()
  const scheme = useColorScheme()
  const [hovered, setHovered] = React.useState(false)
  const [focused, setFocused] = React.useState(false)
  const trigger = React.useRef<HTMLSpanElement>(null)
  const tooltip = React.useRef<HTMLSpanElement>(null)
  const id = React.useId()
  const status = material.indexStatus
  const open = (hovered || focused) && status !== undefined
  const [at, setAt] = React.useState<{ left: number; top: number }>()
  const description = status === 'searchable' ? tx('可检索：已提取可检索文字；不代表提取内容完全准确。', 'Searchable: text has been extracted for search; extraction may contain inaccuracies.')
    : status === 'unsupported' ? tx('格式不支持：已扫描，当前格式不支持提取文字，文件仍保留。', 'Unsupported format: scanned, but text extraction is unavailable for this format. The file is retained.')
      : `${tx('不可检索：', 'Not searchable: ')}${material.note ? localizeError(material.note) : tx('未提取到可检索文字，文件可能为空或只含空白。', 'No searchable text was extracted. The file may be empty or contain only whitespace.')}`
  useBrowserLayoutEffect(() => {
    if (!open) { setAt(undefined); return }
    const update = (): void => {
      const anchor = trigger.current?.getBoundingClientRect()
      const panel = tooltip.current?.getBoundingClientRect()
      if (!anchor || !panel) return
      const left = Math.max(8, Math.min(anchor.left + anchor.width / 2 - panel.width / 2, window.innerWidth - panel.width - 8))
      const above = anchor.top - panel.height - 8
      const top = Math.max(8, Math.min(above >= 8 ? above : anchor.bottom + 8, window.innerHeight - panel.height - 8))
      setAt({ left, top })
    }
    update()
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
    }
  }, [open, description, scheme])
  if (status === undefined) return null
  const icons: Record<NonNullable<MaterialView['indexStatus']>, IconName> = {
    searchable: 'check-circle', unsupported: 'skip-circle', unsearchable: 'alert-triangle',
  }
  return <>
    <span ref={trigger} className={`kb-file-status kb-file-status--${status}`} data-kb-file-status={status}
      role="img" aria-label={description} aria-describedby={open ? id : undefined} tabIndex={0}
      onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}>
      <Icon name={icons[status]} size={15} />
    </span>
    {open && typeof document !== 'undefined' && createPortal(
      <span ref={tooltip} id={id} className="kb-file-status-tooltip" role="tooltip"
        style={{ ...pageTokens(scheme), left: at?.left ?? 0, top: at?.top ?? 0, visibility: at ? 'visible' : 'hidden' }}>
        {description}
      </span>, document.body,
    )}
  </>
}
