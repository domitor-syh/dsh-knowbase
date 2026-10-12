/**
 * The 知识库 settings page.
 *
 * Layout follows the plan: a knowledge base list on the left, the selected
 * base's materials and tools on the right. Everything talks to the Host through
 * `./api.ts`, so this file contains no transport, no parsing and no knowledge of
 * how a call travels.
 *
 * Deliberate first-iteration boundaries, so the gaps are visible rather than
 * surprising: no file/PDF/OCR ingestion (stage 2), no material text editing, no
 * rename UI (the Host method exists), and no drag-and-drop. Retrieval testing is
 * present because it is the only way to judge ranking without spending model
 * calls, and it costs almost nothing on top of the retrieval that already runs.
 *
 * @module @domitor-syh/dsh-knowbase/client/settings-page
 */

import * as React from 'react'
import type { KnowledgeBaseView, MaterialView, SearchReportView } from '../remote.ts'
import { knowbaseApi, knowbaseChannelError } from './api.ts'

const COLORS = {
  border: '#dce3ed',
  muted: '#526176',
  accent: '#185fa5',
  danger: '#b3261e',
  surface: '#fff',
  subtle: '#f6f8fb',
} as const

const panel: React.CSSProperties = {
  border: `1px solid ${COLORS.border}`,
  borderRadius: 8,
  background: COLORS.surface,
}

const button: React.CSSProperties = {
  border: `1px solid ${COLORS.border}`,
  borderRadius: 6,
  background: COLORS.surface,
  padding: '4px 10px',
  fontSize: 13,
  cursor: 'pointer',
}

const input: React.CSSProperties = {
  border: `1px solid ${COLORS.border}`,
  borderRadius: 6,
  padding: '6px 8px',
  fontSize: 13,
  width: '100%',
  boxSizing: 'border-box',
}

/** Report a failure without letting it escape into React's error path. */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** One labelled form row. */
function Field(props: {
  label: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <label style={{ display: 'block', marginBottom: 10 }}>
      <span style={{ display: 'block', fontSize: 12, color: COLORS.muted, marginBottom: 4 }}>
        {props.label}
      </span>
      {props.children}
    </label>
  )
}

/** Render a retrieval report. */
function Report(props: { report: SearchReportView }): React.ReactElement {
  const { report } = props
  if (report.outcome !== 'hits') {
    const text: Record<string, string> = {
      no_match: '未命中：所选知识库中没有相关片段。换个说法或换关键词可能命中。',
      empty_scope: '所选知识库不存在或为空。',
      not_ready: '所选知识库中还没有已索引的资料，先添加文本再检索。',
      error: `检索失败：${report.reason}`,
    }
    return (
      <p style={{ color: COLORS.muted, fontSize: 13 }}>
        {text[report.outcome] ?? report.outcome}（{report.elapsedMs} ms）
      </p>
    )
  }

  return (
    <div>
      <p style={{ color: COLORS.muted, fontSize: 12, margin: '0 0 8px' }}>
        命中 {report.passages.length} 个片段，用时 {report.elapsedMs} ms
      </p>
      {report.passages.map((passage, index) => (
        <div
          key={`${passage.materialTitle}-${passage.locator}-${index}`}
          style={{ ...panel, padding: 10, marginBottom: 8, background: COLORS.subtle }}
        >
          <div style={{ fontSize: 12, color: COLORS.accent, marginBottom: 4 }}>
            [{index + 1}] {passage.kbName} / {passage.materialTitle} · {passage.locator}
          </div>
          <div style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{passage.text}</div>
        </div>
      ))}
    </div>
  )
}

/** The settings page. */
export function KnowbaseSettingsPage(): React.ReactElement {
  const [bases, setBases] = React.useState<readonly KnowledgeBaseView[]>([])
  const [selectedId, setSelectedId] = React.useState<string>('')
  const [materials, setMaterials] = React.useState<readonly MaterialView[]>([])
  const [report, setReport] = React.useState<SearchReportView | undefined>(undefined)
  const [error, setError] = React.useState('')
  const [notice, setNotice] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  const [newBaseName, setNewBaseName] = React.useState('')
  const [newTitle, setNewTitle] = React.useState('')
  const [newText, setNewText] = React.useState('')
  const [query, setQuery] = React.useState('')

  /** Run one Host call with shared busy/error handling. */
  const run = React.useCallback(async (action: () => Promise<string>): Promise<void> => {
    const api = knowbaseApi()
    if (api === undefined) {
      setError('知识库通道尚未就绪，请稍候重试。')
      return
    }
    setBusy(true)
    setError('')
    try {
      setNotice(await action())
    } catch (failure) {
      setError(messageOf(failure))
    } finally {
      setBusy(false)
    }
  }, [])

  const refreshBases = React.useCallback(async (): Promise<void> => {
    const api = knowbaseApi()
    if (api === undefined) return
    const list = await api.listKnowledgeBases()
    setBases(list)
    setSelectedId(current => {
      if (list.some(item => item.id === current)) return current
      return list[0]?.id ?? ''
    })
  }, [])

  // The channel mounts asynchronously, so the first render has no API yet. The
  // interval also surfaces a mounting failure: a page whose buttons do nothing
  // should say why without the user opening developer tools.
  React.useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      const api = knowbaseApi()
      if (api === undefined) return
      try {
        const list = await api.listKnowledgeBases()
        if (cancelled) return
        setBases(list)
        setSelectedId(current =>
          list.some(item => item.id === current) ? current : (list[0]?.id ?? ''),
        )
      } catch (failure) {
        if (!cancelled) setError(messageOf(failure))
      }
    }
    void load()
    const timer = window.setInterval(() => {
      const failure = knowbaseChannelError()
      if (failure !== undefined) {
        window.clearInterval(timer)
        setError(`知识库通道挂载失败：${failure}`)
        return
      }
      if (knowbaseApi() !== undefined) {
        window.clearInterval(timer)
        void load()
      }
    }, 500)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  React.useEffect(() => {
    let cancelled = false
    const api = knowbaseApi()
    if (api === undefined || selectedId === '') {
      setMaterials([])
      return
    }
    void api
      .listMaterials(selectedId)
      .then(list => {
        if (!cancelled) setMaterials(list)
      })
      .catch((failure: unknown) => {
        if (!cancelled) setError(messageOf(failure))
      })
    return () => {
      cancelled = true
    }
  }, [selectedId, bases])

  const selected = bases.find(item => item.id === selectedId)

  return (
    <div style={{ padding: 16, fontSize: 14 }}>
      <h2 style={{ margin: '0 0 4px', fontSize: 18 }}>知识库</h2>
      <p style={{ margin: '0 0 16px', color: COLORS.muted, fontSize: 12 }}>
        资料保存在本机，检索在本机执行。当前为关键词检索（中文 n-gram + BM25），未使用语义向量。
      </p>

      {error !== '' && (
        <div
          style={{
            ...panel,
            borderColor: COLORS.danger,
            color: COLORS.danger,
            padding: '8px 10px',
            marginBottom: 12,
            fontSize: 13,
          }}
        >
          {error}
        </div>
      )}
      {notice !== '' && (
        <div
          style={{ ...panel, padding: '8px 10px', marginBottom: 12, fontSize: 13, color: COLORS.muted }}
        >
          {notice}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '220px minmax(0, 1fr)', gap: 16 }}>
        {/* ------------------------------------------------- knowledge bases */}
        <div>
          <div style={{ ...panel, padding: 8 }}>
            {bases.length === 0 && (
              <p style={{ color: COLORS.muted, fontSize: 12, margin: '4px 2px' }}>还没有知识库。</p>
            )}
            {bases.map(item => {
              const active = item.id === selectedId
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setSelectedId(item.id)}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    border: 'none',
                    borderRadius: 6,
                    padding: '6px 8px',
                    marginBottom: 2,
                    fontSize: 13,
                    cursor: 'pointer',
                    background: active ? '#e8f0fa' : 'transparent',
                    color: active ? COLORS.accent : 'inherit',
                  }}
                >
                  <div style={{ fontWeight: active ? 600 : 400 }}>{item.name}</div>
                  <div style={{ fontSize: 11, color: COLORS.muted }}>
                    {item.materialCount} 份资料 / {item.chunkCount} 个片段
                  </div>
                </button>
              )
            })}
          </div>

          <div style={{ marginTop: 10 }}>
            <input
              style={{ ...input, marginBottom: 6 }}
              placeholder="新知识库名称"
              value={newBaseName}
              onChange={event => setNewBaseName(event.target.value)}
            />
            <button
              type="button"
              style={{ ...button, width: '100%' }}
              disabled={busy || newBaseName.trim() === ''}
              onClick={() =>
                void run(async () => {
                  const created = await knowbaseApi()!.createKnowledgeBase(
                    newBaseName.trim(),
                    '',
                  )
                  setNewBaseName('')
                  await refreshBases()
                  setSelectedId(created.id)
                  return `已创建「${created.name}」。`
                })
              }
            >
              新建知识库
            </button>
          </div>
        </div>

        {/* ------------------------------------------------------ detail pane */}
        <div style={{ minWidth: 0 }}>
          {selected === undefined ? (
            <div style={{ ...panel, padding: 24, color: COLORS.muted, textAlign: 'center' }}>
              左侧选择或新建一个知识库。
            </div>
          ) : (
            <>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: 10,
                }}
              >
                <div>
                  <div style={{ fontWeight: 600 }}>{selected.name}</div>
                  <div style={{ fontSize: 11, color: COLORS.muted }}>
                    {selected.materialCount} 份资料 / {selected.chunkCount} 个片段
                  </div>
                </div>
                <button
                  type="button"
                  style={{ ...button, color: COLORS.danger }}
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const name = selected.name
                      await knowbaseApi()!.deleteKnowledgeBase(selected.id)
                      await refreshBases()
                      return `已删除「${name}」。`
                    })
                  }
                >
                  删除知识库
                </button>
              </div>

              {/* materials */}
              <div style={{ ...panel, padding: 10, marginBottom: 12 }}>
                <div style={{ fontSize: 12, color: COLORS.muted, marginBottom: 6 }}>资料</div>
                {materials.length === 0 ? (
                  <p style={{ color: COLORS.muted, fontSize: 12, margin: 0 }}>还没有资料。</p>
                ) : (
                  materials.map(material => (
                    <div
                      key={material.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '4px 0',
                        borderTop: `1px solid ${COLORS.border}`,
                      }}
                    >
                      <div>
                        <div style={{ fontSize: 13 }}>{material.title}</div>
                        <div style={{ fontSize: 11, color: COLORS.muted }}>
                          {material.chunkCount} 个片段 · 第 {material.revision} 版
                        </div>
                      </div>
                      <button
                        type="button"
                        style={{ ...button, color: COLORS.danger }}
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            await knowbaseApi()!.deleteMaterial(material.id)
                            setMaterials(await knowbaseApi()!.listMaterials(selected.id))
                            await refreshBases()
                            return `已删除「${material.title}」。`
                          })
                        }
                      >
                        删除
                      </button>
                    </div>
                  ))
                )}
              </div>

              {/* add text */}
              <div style={{ ...panel, padding: 10, marginBottom: 12 }}>
                <div style={{ fontSize: 12, color: COLORS.muted, marginBottom: 6 }}>添加文本</div>
                <Field label="标题">
                  <input
                    style={input}
                    value={newTitle}
                    onChange={event => setNewTitle(event.target.value)}
                  />
                </Field>
                <Field label="正文">
                  <textarea
                    style={{ ...input, minHeight: 90, fontFamily: 'inherit' }}
                    value={newText}
                    onChange={event => setNewText(event.target.value)}
                  />
                </Field>
                <button
                  type="button"
                  style={button}
                  disabled={busy || newTitle.trim() === '' || newText.trim() === ''}
                  onClick={() =>
                    void run(async () => {
                      const material = await knowbaseApi()!.addTextMaterial(
                        selected.id,
                        newTitle.trim(),
                        newText,
                      )
                      setNewTitle('')
                      setNewText('')
                      setMaterials(await knowbaseApi()!.listMaterials(selected.id))
                      await refreshBases()
                      return `已加入「${material.title}」（${material.chunkCount} 个片段）。`
                    })
                  }
                >
                  加入知识库
                </button>
              </div>

              {/* retrieval test */}
              <div style={{ ...panel, padding: 10 }}>
                <div style={{ fontSize: 12, color: COLORS.muted, marginBottom: 6 }}>
                  检索测试（不调用模型）· 本库共 {selected.chunkCount} 个片段
                </div>
                <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                  <input
                    style={input}
                    placeholder="输入一个问题"
                    value={query}
                    onChange={event => setQuery(event.target.value)}
                    onKeyDown={event => {
                      if (event.key !== 'Enter' || query.trim() === '') return
                      void run(async () => {
                        setReport(await knowbaseApi()!.testSearch(query, [selected.id]))
                        return ''
                      })
                    }}
                  />
                  <button
                    type="button"
                    style={button}
                    disabled={busy || query.trim() === ''}
                    onClick={() =>
                      void run(async () => {
                        setReport(await knowbaseApi()!.testSearch(query, [selected.id]))
                        return ''
                      })
                    }
                  >
                    检索
                  </button>
                </div>
                {report !== undefined && <Report report={report} />}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
