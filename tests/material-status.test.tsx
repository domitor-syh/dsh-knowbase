import { readFileSync } from 'node:fs'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MaterialStatus } from '../src/client/material-status.tsx'
import type { MaterialView } from '../src/remote.ts'
const material: MaterialView = { id: 'sample.txt', kbId: 'base', fileName: 'sample.txt', title: 'sample.txt', bytes: 32, extension: 'txt', indexed: false, mtimeMs: 1, note: '' }
const component = readFileSync(new URL('../src/client/material-status.tsx', import.meta.url), 'utf8')
const render = (overrides: Partial<MaterialView>) => renderToStaticMarkup(<MaterialStatus material={{ ...material, ...overrides }} />)
describe('file scan outcome indicators', () => {
  it('does not infer a result when the Host has not supplied one', () => {
    expect(render({})).toBe('')
    expect(render({ indexed: true })).toBe('')
  })
  it.each([
    ['searchable', '可检索', '不代表提取内容完全准确'],
    ['unsupported', '格式不支持', '文件仍保留'],
    ['unsearchable', '不可检索', '可能为空或只含空白'],
  ] as const)('renders a named, focusable %s outcome without a delayed native tooltip', (indexStatus, label, detail) => {
    const html = render({ indexStatus })
    expect(html).toContain(`data-kb-file-status="${indexStatus}"`)
    expect(html).toContain('tabindex="0"')
    expect(html).toContain(`aria-label="${label}：`)
    expect(html).toContain(detail)
    expect(html).not.toContain('title=')
  })
  it('keeps tooltip lifetime tied to hover/focus rather than a timeout', () => {
    expect(component).toContain('createPortal(')
    expect(component).toContain('onMouseEnter=')
    expect(component).toContain('onMouseLeave=')
    expect(component).toContain('onFocus=')
    expect(component).toContain('role="tooltip"')
    expect(component).not.toContain('setTimeout')
  })
  it('escapes authored failure reasons', () => {
    const html = render({ indexStatus: 'unsearchable', note: '文件不是 UTF-8 <script>bad</script>' })
    expect(html).toContain('UTF-8 &lt;script&gt;bad&lt;/script&gt;')
    expect(html).not.toContain('<script>')
  })
  it('distinguishes outcomes by shape', () => {
    const shapes = (['searchable', 'unsupported', 'unsearchable'] as const).map(indexStatus => {
      const html = render({ indexStatus })
      return html.slice(html.indexOf('<svg'))
    })
    expect(new Set(shapes).size).toBe(3)
  })
})
