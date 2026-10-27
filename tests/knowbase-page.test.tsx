/** Structural regression contracts, not a browser/layout or timer execution test. */
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { KnowbasePage } from '../src/client/knowbase-page.tsx'
import { ScopePicker } from '../src/client/scope-picker.tsx'
import { KnowbasePanelIcon } from '../src/client/panel.tsx'

const styles = readFileSync(new URL('../src/client/page-style.ts', import.meta.url), 'utf8')
const page = readFileSync(new URL('../src/client/knowbase-page.tsx', import.meta.url), 'utf8')
const scope = readFileSync(new URL('../src/client/scope-picker.tsx', import.meta.url), 'utf8')
const composer = readFileSync(new URL('../src/client/composer-toggle.tsx', import.meta.url), 'utf8')

function rule(selector: string): string {
  const start = styles.indexOf(`\n${selector} {`)
  expect(start).toBeGreaterThanOrEqual(0)
  return styles.slice(start, styles.indexOf('}', start) + 1)
}

describe('knowledge-base page UI contracts', () => {
  it('renders one accessible scope selector and the requested query hint', () => {
    const html = renderToStaticMarkup(createElement(KnowbasePage))
    expect(html.match(/data-kb-test-scope-select/g)).toHaveLength(1)
    expect(html).toContain('aria-label="检索范围"')
    expect(html).toMatch(/<button[^>]*data-kb-test-scope-select[^>]*value="base"/)
    expect(html).toContain('aria-haspopup="listbox"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('>当前库</span>')
    expect(html).not.toContain('role="listbox"')
    expect(html).toContain('placeholder="检索测试(不调用模型)，请输入一个问题"')
    expect(html).not.toContain('检索测试（不调用模型）</h2>')
    expect(html).not.toContain('data-kb-statistics')
  })

  it('exposes all-base scope and count while respecting the busy state', () => {
    const html = renderToStaticMarkup(createElement(ScopePicker, {
      value: 'all', baseCount: 3, currentAvailable: true, disabled: true, onChange: () => {},
    }))
    expect(html).toContain('value="all"')
    expect(html).toContain('data-kb-base-count="3"')
    expect(html).toContain('>全部库</span>')
    expect(html).toContain('disabled=""')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('role="listbox"')
  })

  it('insets and rotates the scope arrow and shares the button radius with popup and options', () => {
    expect(rule('.kb-scope-picker')).toContain('flex: 0 0 90px')
    expect(rule('.kb-scope-trigger')).toContain('justify-content: flex-end')
    expect(rule('.kb-scope-trigger')).toContain('gap: 4px')
    expect(rule('.kb-scope-trigger')).toContain('padding: 0 12px')
    expect(rule('.kb-scope-chevron')).toContain('transition: transform 140ms ease')
    expect(rule('.kb-scope-trigger[aria-expanded="true"] .kb-scope-chevron')).toContain('rotate(180deg)')
    for (const selector of ['.kb-scope-trigger', '.kb-scope-menu', '.kb-scope-option']) {
      expect(rule(selector)).toContain('border-radius: var(--brand-radius)')
    }
    expect(rule('.kb-scope-option[aria-selected="true"]')).toContain('background: var(--brand-sidebar-accent)')
    expect(rule('.kb-scope-option:focus-visible')).toContain('outline: 2px solid var(--brand-ring)')
    expect(styles).toContain('.kb-scope-option:hover:not(:disabled):not([aria-selected="true"])')
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)')
  })

  it('keeps the scope popup outside card clipping with theme tokens and dismissal cleanup', () => {
    expect(scope).toContain('createPortal(')
    expect(scope).toContain('document.body')
    expect(scope).toContain('...pageTokens(scheme)')
    expect(rule('.kb-scope-menu')).toContain('position: fixed')
    expect(scope).toContain('getBoundingClientRect()')
    for (const event of ['pointerdown', 'focusin']) {
      expect(scope).toContain(`document.addEventListener('${event}'`)
      expect(scope).toContain(`document.removeEventListener('${event}'`)
    }
    for (const event of ['scroll', 'resize']) {
      expect(scope).toContain(`window.addEventListener('${event}'`)
      expect(scope).toContain(`window.removeEventListener('${event}'`)
    }
    for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', 'Escape', 'Tab']) {
      expect(scope).toContain(`'${key}'`)
    }
    expect(scope).toContain('trigger.current?.focus({ preventScroll: true })')
    expect(scope).toContain('aria-selected={value === option.value}')
    expect(scope).toContain('disabled={unavailable(index)}')
    expect(scope).toContain('if (disabled) setAt(undefined)')
    expect(page).toContain("setTestAll(value === 'all')")
    expect(page).toContain('setReport(undefined)')
  })

  it('keeps overlays outside the scrollable content layer', () => {
    const html = renderToStaticMarkup(createElement(KnowbasePage))
    expect(html).toContain('class="kb-page-content"')
    expect(rule('#kb-settings-page')).toContain('position: relative')
    expect(rule('#kb-settings-page')).toContain('overflow: hidden')
    expect(rule('.kb-page-content')).toContain('overflow-y: auto')
    expect(rule('.kb-modal-overlay')).toContain('position: absolute')
    expect(rule('.kb-modal-overlay')).toContain('inset: 0')
    expect(rule('.kb-modal-overlay')).toContain('justify-content: center')
  })

  it('defines a compact page-local toast, success circle and cleaned-up 3s timer', () => {
    expect(rule('.kb-alert')).toContain('position: absolute')
    expect(rule('.kb-alert')).toContain('left: 50%')
    expect(rule('.kb-alert')).toContain('width: max-content')
    expect(rule('.kb-alert--notice svg')).toContain('var(--state-success)')
    expect(page).toContain("'alert-triangle' : 'check-circle'")
    expect(page).toContain('window.setTimeout(() => setShown(false), 3000)')
    expect(page).toContain('window.clearTimeout(timer)')
  })

  it('separates both recycle-bin explanations as small warning paragraphs', () => {
    expect(page.match(/<p className="kb-delete-note">删除 = 移入 _回收站，不销毁。<\/p>/g)).toHaveLength(2)
    expect(rule('.kb-modal-body .kb-delete-note')).toContain('font-size: 12px')
    expect(rule('.kb-modal-body .kb-delete-note')).toContain('color: var(--state-warning)')
  })

  it('bounds standalone retrieval results and places utilities after the main lists', () => {
    const html = renderToStaticMarkup(createElement(KnowbasePage))
    expect(rule('.kb-retrieval-toolbar')).toContain('flex: none')
    expect(rule('.kb-search-results')).toContain('position: fixed')
    expect(rule('.kb-search-results-body')).toContain('overflow-y: auto')
    for (const selector of ['.kb-search-results', '.kb-input, .kb-textarea']) {
      expect(rule(selector)).toContain('background: var(--brand-card)')
      expect(rule(selector)).toContain('color: var(--brand-foreground)')
    }
    expect(rule('.kb-lib-row:hover')).toContain('background: var(--dsw-alias-bg-layer-2)')
    expect(rule('.kb-lib-row.is-selected')).toContain('background: var(--dsw-alias-bg-layer-2)')
    expect(rule('.kb-columns')).toContain('min-height: 360px')
    expect(rule('.kb-search-row')).toContain('flex: none')
    expect(rule('.kb-search-row')).not.toContain('flex-wrap')
    expect(html.indexOf('class="kb-utilities"')).toBeGreaterThan(html.indexOf('class="kb-columns"'))
    expect(html.match(/data-kb-new-base/g)).toHaveLength(1)
    expect(html.match(/data-kb-ocr-section/g)).toHaveLength(1)
    expect(styles).not.toContain('contain: size')
  })

  it('groups the scan icon before size and gives file controls room beside the scrollbar', () => {
    const metadata = page.slice(page.indexOf('<div className="kb-file-meta">'), page.indexOf('<div className="kb-file-actions">'))
    expect(metadata.indexOf('<MaterialStatus')).toBeGreaterThan(0)
    expect(metadata.indexOf('<MaterialStatus')).toBeLessThan(metadata.indexOf('data-kb-file-size'))
    expect(rule('.kb-file-list')).toContain('padding: 8px 12px 0 0')
    expect(rule('.kb-file-list')).toContain('scrollbar-gutter: stable')
    expect(rule('.kb-columns')).toContain('border-bottom: 1px solid var(--dsw-alias-border-l1)')
    expect(rule('.kb-utilities')).not.toContain('border-top')
    expect(rule('.kb-file-status')).not.toContain('opacity: 0')
  })

  it('uses host page spacing and typography without raised main cards', () => {
    expect(rule('.kb-page-content')).toContain('padding: 32px 48px')
    expect(rule('.kb-head-title')).toContain('font-family: inherit')
    expect(rule('.kb-head-title')).toContain('font-weight: 500')
    expect(rule('.kb-head-title')).toContain('font-size: 20px')
    expect(rule('.kb-head-description')).toContain('font-size: 13px')
    expect(rule('.kb-card, .kb-placeholder')).toContain('font-family: inherit')
    expect(rule('.kb-card')).toContain('box-shadow: none')
    expect(rule('.kb-card')).toContain('background: transparent')
  })

  it('optically centers the composer book icon without moving the whole button', () => {
    const icon = composer.slice(composer.indexOf('function BookGlyph('), composer.indexOf('/** The search box'))
    expect(icon).toContain('data-kb-toggle-icon')
    expect(icon).toContain("style={{ display: 'block', flexShrink: 0, transform: 'translateY(1px)' }}")
    expect(composer).toContain("alignItems: 'center'")
    expect(composer).toContain('<BookGlyph size={14} />')
  })

  it('does not paint the composer panel before its anchor is measured', () => {
    expect(composer).toContain('React.useLayoutEffect(() => {')
    expect(composer).toContain('open && anchor !== undefined &&')
    expect(composer).not.toContain('anchor?.left ?? 0')
    expect(composer).not.toContain('anchor?.bottom ?? 0')
  })

  it('shows only material totals in the composer knowledge-base popover', () => {
    expect(composer).toContain(": `${base.materialCount} 个文件`")
    expect(composer).not.toContain('个文件 / ${base.indexedCount} 可检索')
  })

  it('removes inline SVG baseline space and nudges the sidebar icon into the label center', () => {
    const html = renderToStaticMarkup(createElement(KnowbasePanelIcon, { size: 20 }))
    expect(html).toContain('style="display:block;transform:translateY(1px)"')
    expect(html).toContain('width="20" height="20"')
  })
})
