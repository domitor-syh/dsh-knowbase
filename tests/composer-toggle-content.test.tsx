import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ComposerToggleContent } from '../src/client/composer-toggle.tsx'

const render = (label: string) => renderToStaticMarkup(<ComposerToggleContent label={label} />)

describe('composer knowledge-toggle content alignment', () => {
  it('keeps identical icon and line-box geometry with no selection, one base or a multi-digit count', () => {
    const labels = ['知识库', '知识库 · 1', '知识库 · 12']
    const markup = labels.map(render)
    const geometry = markup.map((html, index) => html.replace(labels[index]!, '__LABEL__'))
    expect(geometry[1]).toBe(geometry[0])
    expect(geometry[2]).toBe(geometry[0])
    expect(markup[0]).toContain('align-items:center;gap:5px;height:14px')
    expect(markup[0]).toContain('font-size:12px;font-weight:400;line-height:12px')
    expect(markup[0]).toContain('width="14" height="14"')
  })

  it('renders the complete enabled label, including its count, in one explicit line box', () => {
    const html = render('知识库 · 12')
    expect(html).toMatch(/<span data-kb-toggle-label="[^"]*" style="display:block;line-height:12px">知识库 · 12<\/span>/)
    expect(html.match(/data-kb-toggle-icon/g)).toHaveLength(1)
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain('transform:translateY(1px)')
  })
})
