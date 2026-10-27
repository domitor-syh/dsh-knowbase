import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MaterialStatus } from '../src/client/material-status.tsx'
import type { MaterialView } from '../src/remote.ts'

const material: MaterialView = {
  id: 'sample.txt', kbId: 'base', fileName: 'sample.txt', title: 'sample.txt',
  bytes: 32, extension: 'txt', indexed: false, mtimeMs: 1, note: '',
}
const render = (overrides: Partial<MaterialView>) => renderToStaticMarkup(<MaterialStatus material={{ ...material, ...overrides }} />)

describe('file scan outcome indicators', () => {
  it('does not infer a scan result when the Host has not supplied one', () => {
    expect(render({})).toBe('')
    expect(render({ indexed: true })).toBe('')
  })

  it.each([
    ['searchable', '可检索', '不代表提取内容完全准确'],
    ['unsupported', '格式不支持', '文件仍保留'],
    ['unsearchable', '不可检索', '可能为空或只含空白'],
  ] as const)('shows a persistent %s icon with a named, focusable hover target', (indexStatus, label, detail) => {
    const html = render({ indexStatus })
    expect(html).toContain(`data-kb-file-status="${indexStatus}"`)
    expect(html).toContain('role="img"')
    expect(html).toContain('tabindex="0"')
    expect(html).toContain(`title="${label}：`)
    expect(html).toContain(`aria-label="${label}：`)
    expect(html).toContain(detail)
    expect(html).toContain('aria-hidden="true"')
    expect(html).not.toContain('<button')
  })

  it('uses the scan failure reason and escapes file-derived text', () => {
    const html = render({ indexStatus: 'unsearchable', note: '文件不是 UTF-8 <script>bad</script>' })
    expect(html).toContain('文件不是 UTF-8 &lt;script&gt;bad&lt;/script&gt;')
    expect(html).not.toContain('<script>')
  })

  it('distinguishes all three outcomes by shape as well as color', () => {
    const glyphs = ['searchable', 'unsupported', 'unsearchable'].map(indexStatus => {
      const html = render({ indexStatus: indexStatus as MaterialView['indexStatus'] })
      return html.slice(html.indexOf('<svg'))
    })
    expect(new Set(glyphs).size).toBe(3)
  })
})
