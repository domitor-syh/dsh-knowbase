import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MaterialView, ProposalView, SearchReportView } from '../src/remote.ts'
import { installTestLocale } from './fixtures/locale.ts'
import { subscribeUiLocale, uiLocaleSnapshot } from '../src/client/citation-locale.ts'
import { localizeError, uiLanguage, uiText } from '../src/client/ui-locale.ts'
import { ComposerKnowbaseToggle } from '../src/client/composer-toggle.tsx'
import { ScopePicker } from '../src/client/scope-picker.tsx'
import { MaterialStatus } from '../src/client/material-status.tsx'
import { OcrHint, OcrSection, type OcrController } from '../src/client/ocr-panel.tsx'
import { ProposalCard, ProposalInbox } from '../src/client/proposal-inbox.tsx'
import { ReaderPanel, ReaderTitle, ReaderView, type LoadedMaterial } from '../src/client/reader-panel.tsx'
import { KnowbasePage, RetrievalReport } from '../src/client/knowbase-page.tsx'
import { ScanSummary } from '../src/client/scan-summary.tsx'
import { KnowbaseDiagnostics } from '../src/client/statistics-settings.tsx'
import { usePalette } from '../src/client/theme.ts'

const render = (element: React.ReactElement) => renderToStaticMarkup(element)
const noop = () => {}
const sourceText = '知识库 关闭 第 2 段 — Search results <原文>'
const sourceTitle = '知识库 第 2 段 原文.txt'
const material: LoadedMaterial = {
  title: sourceTitle, fileName: sourceTitle, extension: 'txt', text: sourceText, chunks: [], note: '',
}
const file: MaterialView = {
  id: sourceTitle, kbId: 'base', fileName: sourceTitle, title: sourceTitle,
  bytes: 24, extension: 'txt', indexed: false, mtimeMs: 1, note: '', indexStatus: 'unsearchable',
}
const proposal: ProposalView = {
  id: 'proposal', sessionId: 'session', kbId: 'base', kbName: '知识库 我的中文库', fileName: sourceTitle,
  content: sourceText, contentPreview: sourceText, contentBytes: 24, contentHash: 'hash',
  reason: '保留用户原因：批准写入', baseRevision: 3, createdAt: 1, expiresAt: 2, status: 'pending',
}
function Review({ busy = false }: { busy?: boolean }) {
  return <ProposalCard proposal={proposal} busy={busy} onAction={noop} palette={usePalette()} />
}
function ocr(overrides: Partial<OcrController> = {}): OcrController {
  return {
    status: undefined, download: undefined, error: '', running: false,
    refresh: async () => undefined, start: async () => {}, cancel: async () => {}, ...overrides,
  }
}

describe('Host locale integration across the knowledge base UI', () => {
  let locale: ReturnType<typeof installTestLocale>
  beforeEach(() => { locale = installTestLocale('zh-CN') })
  afterEach(() => {
    locale.dispose()
    expect(locale.registrations).toBe(0)
    expect(locale.subscriptions).toBe(0)
    expect(uiLanguage()).toBe('zh')
  })

  it('publishes language changes to React subscribers and restores Chinese on disposal', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeUiLocale(listener)
    try {
      const before = uiLocaleSnapshot()
      locale.setLocale('en-US')
      expect(uiLocaleSnapshot()).toBeGreaterThan(before)
      expect(listener).toHaveBeenCalledTimes(1)
      expect(uiText('中文', 'English')).toBe('English')
      locale.setLocale('zh-TW')
      expect(uiText('中文', 'English')).toBe('中文')
      expect(listener).toHaveBeenCalledTimes(2)
    } finally { unsubscribe() }
    locale.dispose()
    expect(uiText('中文', 'English')).toBe('中文')
  })

  it('renders the main page in zh → en → zh with localized accessible controls', () => {
    const page = <KnowbasePage />
    const chinese = render(page)
    expect(chinese).toContain('>知识库</h1>')
    expect(chinese).toContain('aria-label="添加知识库"')
    expect(chinese).toContain('placeholder="检索测试(不调用模型)，请输入一个问题"')
    expect(chinese).toContain('>当前库</span>')
    locale.setLocale('en-US')
    const english = render(page)
    expect(english).toContain('>Knowledge bases</h1>')
    expect(english).toContain('aria-label="Add knowledge base"')
    expect(english).toContain('placeholder="Enter a question to test retrieval (no model call)"')
    expect(english).toContain('>Current</span>')
    expect(english).toContain('Image text recognition (OCR)')
    expect(english).not.toContain('>知识库</h1>')
    locale.setLocale('zh-CN')
    expect(render(page)).toBe(chinese)
  })

  it('switches composer labels and both search scopes without changing selection', () => {
    const composer = <ComposerKnowbaseToggle sessionId="session" />
    const picker = (value: 'all' | 'base') => <ScopePicker value={value} baseCount={2} currentAvailable disabled={false} onChange={noop} />
    expect(render(composer)).toContain('>知识库</span>')
    expect(render(picker('all'))).toContain('>全部库</span>')
    locale.setLocale('en')
    expect(render(composer)).toContain('>Knowledge bases</span>')
    expect(render(picker('all'))).toContain('>All bases</span>')
    expect(render(picker('base'))).toContain('>Current</span>')
    expect(render(picker('base'))).toContain('aria-label="Search scope"')
    expect(render(picker('base'))).toContain('class="kb-scope-picker" lang="en"')
    expect(render(picker('all'))).toContain('value="all"')
    locale.setLocale('zh')
    expect(render(picker('base'))).toContain('aria-label="检索范围"')
  })

  it('translates status diagnostics while preserving unknown author-provided reasons', () => {
    const known = <MaterialStatus material={{ ...file, note: '图片里没有识别出文字。' }} />
    expect(render(known)).toContain('不可检索：图片里没有识别出文字。')
    locale.setLocale('en')
    expect(render(known)).toContain('Not searchable: No text was recognized in the image.')
    expect(render(<MaterialStatus material={{ ...file, indexStatus: 'searchable' }} />)).toContain('Searchable:')
    expect(render(<MaterialStatus material={{ ...file, indexStatus: 'unsupported' }} />)).toContain('Unsupported format:')
    expect(render(<MaterialStatus material={{ ...file, note: sourceText }} />)).toContain('知识库 关闭 第 2 段 — Search results &lt;原文&gt;')
    locale.setLocale('zh')
    expect(render(known)).toContain('不可检索：图片里没有识别出文字。')
  })

  it('retranslates existing OCR states and completion messages while retaining directory paths', () => {
    const controller = ocr({
      status: { ready: true, dir: 'C:\\语言包\\知识库', packs: [{ lang: 'chi_sim', bytes: 1024, fileName: 'chi_sim.traineddata', url: 'https://example.test/chi_sim.gz', gzipBytes: 512, present: true }], downloadedBytes: 1024, fetchBytes: 0, missing: [] },
      download: { state: 'done', downloadedBytes: 1024, totalBytes: 1024, lang: '', message: '语言包已下载完成。' },
    })
    const section = <OcrSection controller={controller} disabled={false} onDetect={async () => {}} />
    const chinese = render(section)
    expect(chinese).toContain('语言包已下载完成。')
    locale.setLocale('en')
    const english = render(section)
    expect(english).toContain('Language packs downloaded.')
    expect(english).toContain('Language packs ready (chi_sim 1.0 KB)')
    expect(english).toContain('>Check</button>')
    expect(english).toContain('C:\\语言包\\知识库')
    expect(render(<OcrHint controller={controller} disabled={false} onDetect={async () => {}} />)).toContain('Language packs downloaded.')
    locale.setLocale('zh')
    expect(render(section)).toBe(chinese)
  })

  it('localizes missing packs, download progress and recognized errors from raw OCR state', () => {
    locale.setLocale('en')
    const controller = ocr({
      status: { ready: false, dir: '语言包', packs: [], downloadedBytes: 0, fetchBytes: 2048, missing: ['eng', 'chi_sim'] },
      running: true,
      download: { state: 'running', downloadedBytes: 1024, totalBytes: 2048, lang: 'chi_sim', message: '' },
      error: '知识库通道尚未就绪，请稍候重试。',
    })
    const section = <OcrSection controller={controller} disabled={false} onDetect={async () => {}} />
    expect(render(section)).toContain('Missing language packs: eng, chi_sim.')
    expect(render(section)).toContain('Downloading chi_sim')
    expect(render(section)).toContain('Cancel download')
    expect(render(section)).toContain('The knowledge base connection is not ready.')
    locale.setLocale('zh')
    expect(render(section)).toContain('正在下载 chi_sim')
    expect(render(section)).toContain('知识库通道尚未就绪，请稍候重试。')
  })

  it('translates proposal decisions and busy state without translating proposed content or names', () => {
    expect(render(<ProposalInbox sessionId="empty-session" />)).toBe('')
    const chinese = render(<Review />)
    expect(chinese).toContain('>拒绝</button>')
    locale.setLocale('en')
    const english = render(<Review />)
    expect(english).toContain('>Reject</button>')
    expect(english).toContain('>Approve write</button>')
    expect(render(<Review busy />)).toContain('>Processing…</button>')
    for (const value of [proposal.kbName, proposal.fileName, proposal.reason]) expect(english).toContain(value)
    expect(english).toContain('知识库 关闭 第 2 段 — Search results &lt;原文&gt;')
    locale.setLocale('zh')
    expect(render(<Review />)).toBe(chinese)
  })

  it('translates reader notices and generated locators while preserving source titles and passages', () => {
    const hit = { passage: { ordinal: 2, headingPath: '用户标题', locator: '第 2 段', text: sourceText }, range: undefined }
    const view = <ReaderView heading={sourceTitle} material={material} hit={hit} revision={0} kbId="base" materialId={sourceTitle} />
    const chinese = render(view)
    expect(chinese).toContain('命中片段（原文中未能精确定位，可能已被编辑）')
    locale.setLocale('en')
    const english = render(view)
    expect(english).toContain('Matching passage (could not locate it precisely')
    expect(english).toContain(' · Passage 2')
    expect(english).toContain(sourceTitle)
    expect(english).toContain('知识库 关闭 第 2 段 — Search results &lt;原文&gt;')
    expect(render(<ReaderPanel />)).toContain('Loading file…')
    expect(render(<ReaderTitle />)).toContain('Knowledge base file')
    const absent = { ...material, title: '', text: '', chunks: [] }
    expect(render(<ReaderView heading={sourceTitle} material={absent} hit={undefined} revision={0} kbId="base" materialId={sourceTitle} />)).toContain('This file no longer exists.')
    const unreadable = { ...material, text: '', note: '图片里没有识别出文字。' }
    expect(render(<ReaderView heading={sourceTitle} material={unreadable} hit={undefined} revision={0} kbId="base" materialId={sourceTitle} />)).toContain('No text was recognized in the image.')
    locale.setLocale('zh')
    expect(render(view)).toBe(chinese)
  })

  it('localizes retrieval results and diagnostics but preserves retrieved source text', () => {
    const report: SearchReportView = { outcome: 'hits', elapsedMs: 4, reason: '', passages: [{ kbName: proposal.kbName, materialTitle: sourceTitle, locator: '第 2 段', text: sourceText, score: 2.5, coverage: 0.5 }] }
    const results = <RetrievalReport report={report} scopeNote="用户定义范围" />
    expect(render(results)).toContain('检索详情')
    locale.setLocale('en')
    const english = render(results)
    expect(english).toContain('Search details')
    expect(english).toContain('coverage 50%')
    expect(english).toContain('Passage 2')
    for (const value of [proposal.kbName, sourceTitle, '用户定义范围']) expect(english).toContain(value)
    expect(english).toContain('知识库 关闭 第 2 段 — Search results &lt;原文&gt;')
    expect(render(<ScanSummary />)).toContain('No scan report yet.')
    expect(render(<KnowbaseDiagnostics view="page" />)).toContain('Automatic retrieval statistics')
    locale.setLocale('zh')
    expect(render(results)).toContain('检索详情')
    expect(render(<KnowbaseDiagnostics view="page" />)).toContain('自动检索统计')
  })

  it('translates recognized errors without modifying arbitrary user strings', () => {
    const raw = '知识库名称不能为空。'
    expect(localizeError(raw)).toBe(raw)
    locale.setLocale('en')
    expect(localizeError(raw)).toBe('The knowledge base name cannot be empty.')
    expect(localizeError(sourceText)).toBe(sourceText)
    locale.setLocale('zh')
    expect(localizeError(raw)).toBe(raw)
  })
})
