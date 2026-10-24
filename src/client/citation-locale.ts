import type { Context } from '@deepseek-ai/cordis'
import { useSyncExternalStore } from 'react'

const zh = {
  sources: '知识库来源', view: '查看本次回答引用的知识库片段', close: '关闭',
  base: '知识库', file: '文件', location: '位置', id: '引用 ID',
  legacy: '旧消息无稳定引用 ID', hidden: '路径已隐藏', copy: '复制引用', copying: '正在复制…',
  copied: '已复制引用', unavailable: '剪贴板不可用，请手动复制下方引用。',
  failed: '复制失败，请手动复制下方引用。', manual: '可手动复制的引用',
  all: '全部来源文件', filter: '筛选来源文件', open: '在右栏打开', openHint: '在右侧栏打开资料并定位到片段',
  openFailed: '资料暂时无法打开，请稍后重试。',
  note: '编号与回答中的 [1] 等标记对应；筛选不会重新编号。片段是当时检索命中的原文，阅读器显示最近扫描版本。',
  no_match: '未检索到相关知识', not_ready: '知识库还没有资料', no_selection: '未勾选知识库',
  empty_scope: '所选知识库已失效', error: '知识库检索暂不可用',
  no_matchHint: '本次提问在所选知识库里没有命中片段。回答可能来自模型自身知识，不是库内资料。',
  not_readyHint: '所选知识库里还没有已索引的资料，本次回答没有知识库依据。',
  no_selectionHint: '本会话已开启知识库，但一个库都没有勾选，本次没有检索任何知识库。',
  empty_scopeHint: '本次选中的知识库不存在或已被删除，本次回答没有知识库依据。',
  errorHint: '知识库检索失败，本次回答没有知识库依据。',
} as const
export type CitationText = (key: keyof typeof zh) => string
const en: Record<keyof typeof zh, string> = {
  sources: 'Knowledge base sources', view: 'View knowledge base evidence for this answer', close: 'Close',
  base: 'Knowledge base', file: 'File', location: 'Location', id: 'Citation ID',
  legacy: 'Legacy message: no stable citation ID', hidden: 'Path hidden', copy: 'Copy citation', copying: 'Copying…',
  copied: 'Citation copied', unavailable: 'Clipboard unavailable. Copy the citation below manually.',
  failed: 'Copy failed. Copy the citation below manually.', manual: 'Citation for manual copying',
  all: 'All source files', filter: 'Filter source files', open: 'Open in side panel', openHint: 'Open the material at this passage',
  openFailed: 'Unable to open this material. Please try again.',
  note: 'Numbers match [1] markers in the answer and remain unchanged when filtered. Passages are recorded evidence; the reader shows the latest scan.',
  no_match: 'No relevant knowledge found', not_ready: 'No indexed materials yet', no_selection: 'No knowledge base selected',
  empty_scope: 'Selected knowledge bases unavailable', error: 'Knowledge retrieval unavailable',
  no_matchHint: 'No passages matched in the selected knowledge bases. The answer may use model knowledge.',
  not_readyHint: 'Selected knowledge bases have no indexed materials. This answer has no knowledge base evidence.',
  no_selectionHint: 'Knowledge retrieval is enabled, but no knowledge bases are selected.',
  empty_scopeHint: 'Selected knowledge bases no longer exist. This answer has no knowledge base evidence.',
  errorHint: 'Knowledge retrieval failed. This answer has no knowledge base evidence.',
}
let translate: CitationText = key => zh[key]
let revision = 0
const listeners = new Set<() => void>()
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }
const snapshot = () => revision
const publish = () => { revision++; listeners.forEach(fn => fn()) }

export function useCitationText(): CitationText {
  useSyncExternalStore(subscribe, snapshot, snapshot)
  return translate
}
export function installCitationLocale(ctx: Context): void {
  const locale = (ctx as unknown as { locale: {
    register(ns: string, locale: string, dict: Record<string, string>): () => void
    bind(ns: string): (key: string) => string
    subscribe(fn: () => void): () => void
  } }).locale
  ctx.effect(() => {
    const offZh = locale.register('knowbase-citations', 'zh', { ...zh })
    const offEn = locale.register('knowbase-citations', 'en', { ...en })
    const bound = locale.bind('knowbase-citations')
    translate = key => bound(key)
    const offChange = locale.subscribe(publish)
    publish()
    return () => {
      offChange(); offEn(); offZh()
      translate = key => zh[key]
      publish()
    }
  })
}
