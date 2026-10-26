import type { Context } from '@deepseek-ai/cordis'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { StatisticsView } from '../src/core/statistics-types.ts'
import { createKnowbaseApi, KnowbaseRemoteError } from '../src/client/api.ts'
import { TYPERT_REMOTE } from '../src/client/contribution.ts'
import { installCitationLocale } from '../src/client/citation-locale.ts'
import { KnowbaseDiagnostics } from '../src/client/statistics-settings.tsx'
import { createStatisticsController, StatisticsContent, StatisticsPanel, type StatisticsPanelState } from '../src/client/statistics-panel.tsx'

const view = (patch: Partial<StatisticsView> = {}): StatisticsView => ({
  enabled: false, available: true, persistenceError: false, retentionDays: 30, since: 0,
  runtimeDedupOnly: true, dropped: 0,
  counters: { requests: 6, hits: 2, noMatch: 1, notReady: 1, emptyScope: 1, errors: 1 },
  hitRate: 2 / 3,
  entries: [{ kbId: 'kb-a', materialId: 'guide.md', kbName: '项目资料', title: '指南.md', recallTurns: 2 }],
  total: 1, offset: 0, nextOffset: null, ...patch,
})
function fixture() {
  const api = {
    getStatistics: vi.fn(async (_offset: number, _limit: number) => view()),
    setStatisticsEnabled: vi.fn(async (enabled: boolean) => view({ enabled, since: 1 })),
    clearStatistics: vi.fn(async () => view({ entries: [], total: 0, hitRate: null })),
  }
  const controller = createStatisticsController(() => api)
  return { api, controller }
}
async function settle() { await Promise.resolve(); await Promise.resolve() }
function content(patch: Partial<StatisticsPanelState> = {}) {
  return renderToStaticMarkup(<StatisticsContent state={{ open: true, busy: false, failed: false, confirmClear: false, view: view(), ...patch }} controller={fixture().controller} />)
}

describe('statistics panel requests', () => {
  it('stays idle while collapsed and loads only on opening or explicit requests, fifty at a time', async () => {
    const { api, controller } = fixture()
    const interval = vi.spyOn(globalThis, 'setInterval')
    expect(renderToStaticMarkup(<StatisticsPanel />)).toContain('<summary')
    expect(renderToStaticMarkup(<KnowbaseDiagnostics view="summary" />)).toBe('')
    const details = renderToStaticMarkup(<KnowbaseDiagnostics view="page" />)
    expect(details).toContain('data-kb-statistics')
    expect(details).not.toContain('open=""')
    expect(controller.snapshot()).toMatchObject({ open: false, busy: false })
    await controller.refresh()
    expect(api.getStatistics).not.toHaveBeenCalled()
    controller.setOpen(true)
    await settle()
    expect(api.getStatistics).toHaveBeenCalledWith(0, 50)
    await controller.refresh(50)
    expect(api.getStatistics).toHaveBeenLastCalledWith(50, 50)
    controller.setOpen(false)
    await controller.refresh(100)
    expect(api.getStatistics).toHaveBeenCalledTimes(2)
    controller.setOpen(true)
    await settle()
    expect(api.getStatistics).toHaveBeenLastCalledWith(0, 50)
    expect(interval).not.toHaveBeenCalled()
    interval.mockRestore()
  })

  it('requires explicit inline confirmation and serializes clear and enable controls', async () => {
    const { api, controller } = fixture()
    controller.setOpen(true)
    await settle()
    await controller.clear()
    expect(api.clearStatistics).not.toHaveBeenCalled()
    controller.requestClear()
    expect(controller.snapshot().confirmClear).toBe(true)
    controller.cancelClear()
    await controller.clear()
    expect(api.clearStatistics).not.toHaveBeenCalled()
    await controller.setEnabled(true)
    expect(api.setStatisticsEnabled).toHaveBeenCalledWith(true)
    expect(controller.snapshot().view?.enabled).toBe(true)
    controller.requestClear()
    const clearing = controller.clear()
    await controller.setEnabled(false)
    expect(api.setStatisticsEnabled).toHaveBeenCalledTimes(1)
    await clearing
    expect(api.clearStatistics).toHaveBeenCalledTimes(1)
    expect(controller.snapshot()).toMatchObject({ busy: false, confirmClear: false, view: { entries: [] } })
  })

  it('disables mutations when storage is unavailable while allowing an explicit retry', async () => {
    const { api, controller } = fixture()
    api.getStatistics.mockResolvedValueOnce(view({ available: false }))
    controller.setOpen(true)
    await settle()
    controller.requestClear()
    await controller.clear()
    await controller.setEnabled(true)
    expect(controller.snapshot().confirmClear).toBe(false)
    expect(api.clearStatistics).not.toHaveBeenCalled()
    expect(api.setStatisticsEnabled).not.toHaveBeenCalled()
    await controller.refresh()
    expect(controller.snapshot().view?.available).toBe(true)
  })

  it('ignores late responses after disposal and prevents an older request overwriting a newer one', async () => {
    let resolveOld!: (value: StatisticsView) => void
    const { api, controller } = fixture()
    api.getStatistics.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
    const dispose = controller.activate()
    controller.setOpen(true)
    expect(controller.snapshot().busy).toBe(true)
    await controller.refresh(50)
    expect(api.getStatistics).toHaveBeenCalledTimes(1)
    dispose()
    controller.activate()
    await controller.refresh()
    expect(controller.snapshot().view?.total).toBe(1)
    resolveOld(view({ total: 999 }))
    await settle()
    expect(controller.snapshot().view?.total).toBe(1)
    const finalDispose = controller.activate()
    finalDispose()
    await controller.refresh()
    expect(api.getStatistics).toHaveBeenCalledTimes(2)
  })

  it('reports failures without discarding history or exposing raw error text and retries manually', async () => {
    const { api, controller } = fixture()
    controller.setOpen(true)
    await settle()
    api.getStatistics.mockRejectedValueOnce(new Error('C:\\private\\query.txt'))
    await controller.refresh()
    expect(controller.snapshot()).toMatchObject({ failed: true, busy: false, view: { total: 1 } })
    expect(JSON.stringify(controller.snapshot())).not.toContain('private')
    await controller.refresh()
    expect(controller.snapshot().failed).toBe(false)
    const missing = createStatisticsController(() => undefined)
    missing.setOpen(true)
    await settle()
    expect(missing.snapshot()).toMatchObject({ failed: true, busy: false })
  })
})

describe('statistics panel presentation and transport', () => {
  it('shows all counters, recall turns, default-off history, never enabled and the retention caveat', () => {
    const html = content()
    for (const text of ['检索请求', '命中率', '66.7%', '未命中', '未就绪', '范围失效', '检索失败', '项目资料', '指南.md', '召回轮次', '从未开启', '本地保留天数', '30', '记录已关闭', '重启后重放可能重复计数']) expect(html).toContain(text)
    expect(html).toContain('role="switch"')
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('aria-checked="false"')
    expect(html).not.toContain('确认清空')
    expect(content({ confirmClear: true })).toContain('确认清空')
  })

  it('distinguishes unavailable storage, failed saves and dropped observations; null rate is not zero', () => {
    const html = content({ view: view({ available: false, persistenceError: true, dropped: 3, hitRate: null, entries: [] }) })
    for (const text of ['统计存储暂不可用', '部分统计未能保存', '未记录的统计次数', '暂无有效检索', '暂无资料召回记录']) expect(html).toContain(text)
    expect(html).not.toContain('0.0%')
    expect(html).toMatch(/role="switch"[^>]*disabled/)
    expect(content({ busy: true })).toContain('aria-busy="true"')
    expect(content({ failed: true })).toContain('role="alert"')
  })

  it('uses the installed locale subscription for English and Chinese labels', () => {
    let language = 'en'
    let changed = () => {}
    const dictionaries = new Map<string, Record<string, string>>()
    let dispose = () => {}
    const ctx = { effect(fn: () => () => void) { dispose = fn() }, locale: {
      register(_ns: string, locale: string, dictionary: Record<string, string>) { dictionaries.set(locale, dictionary); return () => { dictionaries.delete(locale) } },
      bind: () => (key: string) => dictionaries.get(language)![key]!,
      subscribe(fn: () => void) { changed = fn; return () => {} },
    } } as unknown as Context
    installCitationLocale(ctx)
    try {
      expect(content()).toContain('Record automatic retrieval statistics')
      language = 'zh'
      changed()
      expect(content()).toContain('记录自动检索统计')
    } finally { dispose() }
  })

  it('unwraps all three typed API calls and rejects Host failures', async () => {
    const payload = view()
    const wire = {
      getStatistics: vi.fn(async () => ({ ok: true, value: payload })),
      setStatisticsEnabled: vi.fn(async () => ({ ok: true, value: payload })),
      clearStatistics: vi.fn(async () => ({ ok: false, error: { message: 'Unavailable' } })),
    }
    const api = createKnowbaseApi({ remote: { knowbase: wire } } as unknown as Context)
    await expect(api.getStatistics(50, 50)).resolves.toEqual(payload)
    expect(wire.getStatistics).toHaveBeenCalledWith(50, 50)
    await expect(api.setStatisticsEnabled(false)).resolves.toEqual(payload)
    expect(wire.setStatisticsEnabled).toHaveBeenCalledWith(false)
    await expect(api.clearStatistics()).rejects.toBeInstanceOf(KnowbaseRemoteError)
  })

  it('publishes bounded statistics wire codecs matching the shared view', () => {
    const descriptors = TYPERT_REMOTE.descriptors.filter(descriptor => ['getStatistics', 'setStatisticsEnabled', 'clearStatistics'].includes(descriptor.method))
    expect(descriptors).toHaveLength(3)
    for (const descriptor of descriptors) {
      const result = descriptor.result!
      if (result.mode !== 'strict') throw new Error('Statistics results require a strict codec')
      const codec = result.create() as unknown as { safeParse(input: unknown): { success: boolean } }
      expect(codec.safeParse(view()).success).toBe(true)
      expect(codec.safeParse(view({ hitRate: null })).success).toBe(true)
      expect(codec.safeParse(view({ entries: Array.from({ length: 51 }, () => view().entries[0]!) })).success).toBe(false)
    }
    const get = descriptors.find(descriptor => descriptor.method === 'getStatistics')!
    const parameter = get.parameters[1]!.codec
    if (parameter.mode !== 'strict') throw new Error('Statistics limits require a strict codec')
    const limit = parameter.create() as unknown as { safeParse(input: unknown): { success: boolean } }
    expect(limit.safeParse(50).success).toBe(true)
    expect(limit.safeParse(51).success).toBe(false)
    expect(limit.safeParse(0).success).toBe(false)
  })
})
