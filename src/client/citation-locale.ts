import type { Context } from '@deepseek-ai/cordis'
import { useSyncExternalStore } from 'react'

const zh = {
  searchResults: '检索结果', closeSearchResults: '关闭检索结果',
  statsTitle: '自动检索统计', statsEnable: '记录自动检索统计', statsRefresh: '刷新', statsClear: '清空统计',
  statsConfirm: '确认清空', statsCancel: '取消', statsConfirmHelp: '清空本地累计统计？此操作无法撤销，统计开关保持不变。',
  statsHelp: '仅统计会话中的自动知识检索；手动检索测试和知识库工具调用不计入。默认关闭，仅本地保存计数，不记录问题或正文。命中率不代表回答正确率。',
  statsRetention: '本地保留天数', statsDedup: '同一轮的重复检索仅在本次运行期间去重；重启后重放可能重复计数。',
  statsSince: '累计起始时间', statsNever: '从未开启', statsOff: '记录已关闭；保留期内的历史统计仍可查看。',
  statsLoading: '正在读取统计…', statsFailed: '统计操作失败，请刷新重试。', statsUnavailable: '统计存储暂不可用，无法更改设置或清空。',
  statsPersistence: '部分统计未能保存，重启后可能丢失。', statsDropped: '未记录的统计次数',
  statsRequests: '检索请求', statsHits: '命中', statsNoMatch: '未命中', statsNotReady: '未就绪', statsEmptyScope: '范围失效', statsErrors: '检索失败',
  statsHitRate: '命中率', statsNoRate: '暂无有效检索', statsMaterials: '资料召回', statsRecallTurns: '召回轮次', statsEmpty: '暂无资料召回记录。',
  statsPrevious: '上一页', statsNext: '下一页', statsTotal: '资料总数',
  scanTitle: '最近一次完成的扫描', scanNone: '暂无扫描报告。重扫后可查看；旧版宿主可能不提供报告。',
  scanIncremental: '增量扫描', scanForce: '强制重建', scanTime: '完成时间', scanDuration: '耗时',
  scanScanned: '扫描文件', scanAdded: '新增', scanReused: '复用', scanChanged: '变化', scanDeleted: '删除',
  scanRebuilt: '重建尝试', scanSkipped: '格式跳过', scanUnsearchable: '不可检索',
  scanFailures: '不可检索文件及原因', scanOmitted: '未展开项',
  scanHelp: '重建尝试包含失败、空文件和超限；格式跳过仅统计不支持的常规文件，可与复用重叠。不统计隐藏文件、链接和深度范围外文件。',
  scanRuntime: '报告来自最近完成的启动、上传或重扫，重启后重新建立。扫描中断时保留上次报告；多库扫描可能部分完成。',
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
  searchResults: 'Search results', closeSearchResults: 'Close search results',
  statsTitle: 'Automatic retrieval statistics', statsEnable: 'Record automatic retrieval statistics', statsRefresh: 'Refresh', statsClear: 'Clear statistics',
  statsConfirm: 'Confirm clear', statsCancel: 'Cancel', statsConfirmHelp: 'Clear the local totals? This cannot be undone. Recording remains unchanged.',
  statsHelp: 'Counts automatic knowledge retrieval in conversations only. Manual search tests and knowledge tool calls are excluded. Off by default. Only local counts are stored, without questions or document text. Hit rate does not measure answer accuracy.',
  statsRetention: 'Local retention in days', statsDedup: 'Repeated retrieval within a turn is deduplicated during this run only. Replay after a restart may count again.',
  statsSince: 'Counting since', statsNever: 'Never enabled', statsOff: 'Recording is off. History within the retention period remains visible.',
  statsLoading: 'Loading statistics…', statsFailed: 'Statistics could not be updated. Refresh to retry.', statsUnavailable: 'Statistics storage is unavailable. Settings and clearing are disabled.',
  statsPersistence: 'Some statistics could not be saved and may be lost after a restart.', statsDropped: 'Observations not recorded',
  statsRequests: 'Retrieval requests', statsHits: 'Hits', statsNoMatch: 'No match', statsNotReady: 'Not ready', statsEmptyScope: 'Unavailable scope', statsErrors: 'Retrieval errors',
  statsHitRate: 'Hit rate', statsNoRate: 'No eligible retrievals yet', statsMaterials: 'Material recall', statsRecallTurns: 'Turns recalled', statsEmpty: 'No material recall recorded yet.',
  statsPrevious: 'Previous', statsNext: 'Next', statsTotal: 'Total materials',
  scanTitle: 'Last completed scan', scanNone: 'No scan report yet. Rescan to inspect; older Hosts may omit reports.',
  scanIncremental: 'Incremental scan', scanForce: 'Forced rebuild', scanTime: 'Completed', scanDuration: 'Duration',
  scanScanned: 'Files scanned', scanAdded: 'Added', scanReused: 'Reused', scanChanged: 'Changed', scanDeleted: 'Deleted',
  scanRebuilt: 'Rebuild attempts', scanSkipped: 'Unsupported formats', scanUnsearchable: 'Unsearchable',
  scanFailures: 'Unsearchable files and reasons', scanOmitted: 'Items not shown',
  scanHelp: 'Rebuild attempts include unsuccessful, empty and oversized files. Unsupported regular files can also be reused. Hidden entries, links and files beyond the depth limit are excluded.',
  scanRuntime: 'Reports reflect the last completed startup, upload or rescan and are recreated after restart. Interrupted scans retain the previous report; multi-base scans may partially complete.',
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
