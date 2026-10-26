import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RetrievalReport } from '../src/client/knowbase-page.tsx'
import type { SearchReportView } from '../src/remote.ts'

const report: SearchReportView = {
  outcome: 'hits', elapsedMs: 1, reason: '',
  passages: [
    { kbName: '验收测试', materialTitle: '保修说明.txt', locator: '第 1 行', text: '设备 QV7319 的保修期为五年。', score: 12.15, coverage: 0.77 },
    { kbName: '设备资料', materialTitle: '维护说明.txt', locator: '第 1-2 行', text: '保修期为三年。\n维护周期为六个月。', score: 1.05, coverage: 0.23 },
  ],
}
const render = (value: SearchReportView): string => renderToStaticMarkup(createElement(RetrievalReport, {
  report: value, scopeNote: '检索范围：全部 2 个知识库，共 2 个可检索文件',
}))

describe('compact retrieval report', () => {
  it('keeps full source text and locations in the reading area, with metrics folded by default', () => {
    const html = render(report)
    const detailStart = html.indexOf('<details')
    expect(detailStart).toBeGreaterThan(0)
    const reading = html.slice(0, detailStart)
    const details = html.slice(detailStart)
    expect(reading).toContain('2 个片段 · 1 ms')
    expect(reading).toContain('全部 2 个知识库')
    for (const hit of report.passages) {
      expect(reading).toContain(hit.materialTitle)
      expect(reading).toContain(`${hit.kbName} · ${hit.locator}`)
      expect(reading).toContain(hit.text)
    }
    expect(reading).not.toContain('score')
    expect(reading).not.toContain('覆盖')
    expect(details).toMatch(/^<details class="kb-report-details">/)
    expect(details).toContain('<summary>检索详情</summary>')
    expect(details).toContain('score 12.15 · 覆盖 77%')
    expect(details).toContain('score 1.05 · 覆盖 23%')
    expect(details).toContain('同一次提问内可比')
  })

  it.each([
    ['no_match', '未找到相关片段'],
    ['empty_scope', '所选知识库不存在或为空'],
    ['not_ready', '还没有可检索的文件'],
    ['error', '检索失败：读取失败'],
  ])('retains the scope and useful %s status without empty metric controls', (outcome, text) => {
    const html = render({ ...report, outcome, passages: [], reason: '读取失败' })
    expect(html).toContain(text)
    expect(html).toContain('全部 2 个知识库')
    expect(html).toContain('1 ms')
    expect(html).not.toContain('<details')
    expect(html).not.toContain('kb-hit-list')
  })
})
