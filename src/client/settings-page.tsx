/**
 * The 知识库 settings page.
 *
 * Layout follows the plan: a knowledge base list on the left, the selected
 * base's materials and tools on the right. Everything talks to the Host through
 * `./api.ts`, so this file contains no transport, no parsing and no knowledge of
 * how a call travels.
 *
 * ## What is deliberately present
 *
 * The chunk view and the text editor are not polish. A user who cannot see what
 * the plugin actually indexed is guessing about every search result, and a
 * material with a typo could previously only be fixed by deleting it — an
 * irreversible action with no confirmation. Both are what makes the plugin
 * trustworthy rather than merely functional.
 *
 * ## Deliberate first-iteration boundaries
 *
 * No file/PDF/OCR ingestion (stage 2), no drag-and-drop, no soft delete with a
 * recycle bin (the plan's next batch) — destructive actions are two-step instead.
 *
 * @module @domitor-syh/dsh-knowbase/client/settings-page
 */

import * as React from 'react'
import type {
  DuplicateView,
  KnowledgeBaseView,
  MaterialView,
  PassageView,
  RecycleBinView,
  SearchReportView,
} from '../remote.ts'
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

/** Human-readable byte size, for the export summary. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * Save a string as a file, through a blob URL.
 *
 * The browser owns the destination, which is the point: the Host never decides
 * where a user's backup lands, so there is no path for it to get wrong and
 * nothing to configure. The URL is released on a timer rather than immediately
 * because revoking it synchronously can cancel the download in some engines
 * before the blob has been read.
 */
function downloadText(fileName: string, text: string): void {
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
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

/**
 * A destructive action that asks once.
 *
 * The first click arms the row; the second commits and anything else disarms it.
 * Rendered inline rather than as a modal because it is one row, and because a
 * page should not grow a dialog stack before it grows a design system.
 */
function ConfirmButton(props: {
  label: string
  confirmLabel: string
  disabled?: boolean
  onConfirm: () => void
}): React.ReactElement {
  const [armed, setArmed] = React.useState(false)

  React.useEffect(() => {
    if (!armed) return
    const timer = window.setTimeout(() => setArmed(false), 4000)
    return () => window.clearTimeout(timer)
  }, [armed])

  if (!armed) {
    return (
      <button
        type="button"
        style={{ ...button, color: COLORS.danger }}
        disabled={props.disabled}
        onClick={() => setArmed(true)}
      >
        {props.label}
      </button>
    )
  }

  return (
    <span style={{ display: 'inline-flex', gap: 4 }}>
      <button
        type="button"
        style={{ ...button, borderColor: COLORS.danger, color: COLORS.danger }}
        disabled={props.disabled}
        onClick={() => {
          setArmed(false)
          props.onConfirm()
        }}
      >
        {props.confirmLabel}
      </button>
      <button type="button" style={button} onClick={() => setArmed(false)}>
        取消
      </button>
    </span>
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

  // Base info editing.
  const [editingInfo, setEditingInfo] = React.useState(false)
  const [editName, setEditName] = React.useState('')
  const [editDescription, setEditDescription] = React.useState('')

  // The material detail view: chunks as indexed, plus the editor.
  const [detailId, setDetailId] = React.useState('')
  const [detailTitle, setDetailTitle] = React.useState('')
  const [detailChunks, setDetailChunks] = React.useState<readonly PassageView[]>([])
  const [detailText, setDetailText] = React.useState('')
  const [detailLoading, setDetailLoading] = React.useState(false)

  // The recycle bin: soft-deleted bases and materials.
  const [recycle, setRecycle] = React.useState<RecycleBinView | undefined>(undefined)
  const [recycleOpen, setRecycleOpen] = React.useState(false)

  // Same-base duplicate warning for the add form. Held as the found material so
  // the warning can name it, rather than as a boolean the page would then have
  // to explain without knowing what it collided with.
  const [duplicate, setDuplicate] = React.useState<DuplicateView | null>(null)
  const backupFile = React.useRef<HTMLInputElement | null>(null)

  /** Run one Host call with shared busy/error handling. */
  const run = React.useCallback(async (action: () => Promise<string>): Promise<void> => {
    const current = knowbaseApi()
    if (current === undefined) {
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
    const current = knowbaseApi()
    if (current === undefined) return
    const list = await current.listKnowledgeBases()
    setBases(list)
    setSelectedId(existing =>
      list.some(item => item.id === existing) ? existing : (list[0]?.id ?? ''),
    )
  }, [])

  const refreshRecycle = React.useCallback(async (): Promise<void> => {
    const current = knowbaseApi()
    if (current === undefined) return
    try {
      setRecycle(await current.listRecycleBin())
    } catch (failure) {
      setError(messageOf(failure))
    }
  }, [])

  /** Export the library — or one base — and hand the file to the browser. */
  const exportBackup = React.useCallback(
    (kbId: string, label: string): void => {
      void run(async () => {
        const payload = await knowbaseApi()!.exportBackup(kbId)
        if (payload.bases === 0) {
          return kbId === '' ? '还没有可导出的知识库。' : '该知识库中没有可导出的资料。'
        }
        downloadText(payload.fileName, payload.json)
        return (
          `已导出${label}：${payload.bases} 个知识库 / ${payload.materials} 份资料，` +
          `${formatBytes(payload.bytes)}。文件名 ${payload.fileName}`
        )
      })
    },
    [run],
  )

  /**
   * Restore a backup the user picked.
   *
   * Handled outside `run` because a rejected file belongs in the error strip
   * with the reason the format check produced — it is an answer, not a notice.
   */
  const importBackup = React.useCallback(
    async (file: File): Promise<void> => {
      const current = knowbaseApi()
      if (current === undefined) {
        setError('知识库通道尚未就绪，请稍候重试。')
        return
      }
      setBusy(true)
      setError('')
      setNotice('')
      try {
        const result = await current.importBackup(await file.text())
        if (result.outcome === 'rejected') {
          setError(`导入失败：${result.reason}`)
          return
        }
        await refreshBases()
        await refreshRecycle()
        const notes: string[] = []
        if (result.skippedMaterials > 0) notes.push(`跳过 ${result.skippedMaterials} 份无正文资料`)
        if (result.reallocatedBases > 0) {
          notes.push(`${result.reallocatedBases} 个知识库因 ID 已被占用而重新编号`)
        }
        setNotice(
          `已导入 ${result.bases} 个知识库、${result.materials} 份资料` +
            (notes.length === 0 ? '。' : `（${notes.join('，')}）。`),
        )
      } catch (failure) {
        setError(messageOf(failure))
      } finally {
        setBusy(false)
      }
    },
    [refreshBases, refreshRecycle],
  )

  /**
   * Add the composed material, checking for a same-base duplicate first.
   *
   * The Host is asked rather than the error string being matched: that is what
   * lets the page offer 「仍然添加」 as a button instead of making the user read a
   * message and guess at the remedy. The Host still refuses the add itself, so a
   * client that skipped this check would get an error, not a silent duplicate.
   */
  const submitMaterial = (allowDuplicate: boolean): void => {
    const kbId = selectedId
    if (kbId === '') return
    void run(async () => {
      const current = knowbaseApi()!
      if (!allowDuplicate) {
        const found = await current.findDuplicateMaterial(kbId, newText)
        if (found !== null) {
          setDuplicate(found)
          return ''
        }
      }
      const material = await current.addTextMaterial(
        kbId,
        newTitle.trim(),
        newText,
        allowDuplicate,
      )
      setNewTitle('')
      setNewText('')
      setDuplicate(null)
      setMaterials(await current.listMaterials(kbId))
      await refreshBases()
      return `已加入「${material.title}」（${material.chunkCount} 个片段）。`
    })
  }

  // The channel mounts asynchronously, so the first render has no API yet. The
  // interval also surfaces a mounting failure: a page whose buttons do nothing
  // should say why without the user opening developer tools.
  React.useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      const current = knowbaseApi()
      if (current === undefined) return
      try {
        const [list, bin] = await Promise.all([
          current.listKnowledgeBases(),
          current.listRecycleBin(),
        ])
        if (cancelled) return
        setBases(list)
        setRecycle(bin)
        setSelectedId(existing =>
          list.some(item => item.id === existing) ? existing : (list[0]?.id ?? ''),
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
    const current = knowbaseApi()
    if (current === undefined || selectedId === '') {
      setMaterials([])
      return
    }
    void current
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

  /** Open the material detail view and load what was actually indexed. */
  const openDetail = React.useCallback(
    async (material: MaterialView): Promise<void> => {
      const current = knowbaseApi()
      if (current === undefined) return
      setDetailId(material.id)
      setDetailTitle(material.title)
      setDetailLoading(true)
      try {
        const [passages, text] = await Promise.all([
          current.readMaterialChunks(material.id),
          current.readMaterialText(material.id),
        ])
        setDetailChunks(passages)
        setDetailText(text)
      } catch (failure) {
        setError(messageOf(failure))
      } finally {
        setDetailLoading(false)
      }
    },
    [],
  )

  /** Switch the selected base and close any open material detail. */
  const selectBase = (id: string): void => {
    setSelectedId(id)
    setDetailId('')
    setDetailChunks([])
    setDetailText('')
    setReport(undefined)
    setEditingInfo(false)
    // A duplicate warning names a material in the base it was found in, so it
    // cannot survive a change of base.
    setDuplicate(null)
  }

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
                  onClick={() => selectBase(item.id)}
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
                  ...panel,
                  padding: 10,
                  marginBottom: 12,
                  display: 'flex',
                  alignItems: 'flex-start',
                  justifyContent: 'space-between',
                  gap: 8,
                }}
              >
                {editingInfo ? (
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Field label="名称">
                      <input
                        style={input}
                        value={editName}
                        onChange={event => setEditName(event.target.value)}
                      />
                    </Field>
                    <Field label="描述">
                      <textarea
                        style={{ ...input, minHeight: 50, fontFamily: 'inherit' }}
                        value={editDescription}
                        onChange={event => setEditDescription(event.target.value)}
                      />
                    </Field>
                    <button
                      type="button"
                      style={button}
                      disabled={busy || editName.trim() === ''}
                      onClick={() =>
                        void run(async () => {
                          const current = knowbaseApi()!
                          await current.renameKnowledgeBase(selected.id, editName.trim())
                          await current.updateDescription(selected.id, editDescription)
                          await refreshBases()
                          setEditingInfo(false)
                          return '已保存。'
                        })
                      }
                    >
                      保存
                    </button>{' '}
                    <button
                      type="button"
                      style={button}
                      onClick={() => {
                        setEditingInfo(false)
                        setEditName('')
                        setEditDescription('')
                      }}
                    >
                      取消
                    </button>
                  </div>
                ) : (
                  <>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600 }}>{selected.name}</div>
                      <div style={{ fontSize: 11, color: COLORS.muted }}>
                        {selected.materialCount} 份资料 / {selected.chunkCount} 个片段
                        {selected.description !== '' && ` · ${selected.description}`}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                      <button
                        type="button"
                        style={button}
                        onClick={() => {
                          setEditName(selected.name)
                          setEditDescription(selected.description)
                          setEditingInfo(true)
                        }}
                      >
                        编辑信息
                      </button>
                      <ConfirmButton
                        label="删除知识库"
                        confirmLabel="移入回收站"
                        disabled={busy}
                        onConfirm={() =>
                          void run(async () => {
                            const name = selected.name
                            await knowbaseApi()!.deleteKnowledgeBase(selected.id)
                            setDetailId('')
                            await refreshBases()
                            await refreshRecycle()
                            return `已把「${name}」移入回收站，可在页面底部恢复。`
                          })
                        }
                      />
                    </div>
                  </>
                )}
              </div>

              {/* materials */}
              <div style={{ ...panel, padding: 10, marginBottom: 12 }}>
                <div style={{ fontSize: 12, color: COLORS.muted, marginBottom: 6 }}>资料</div>
                {materials.length === 0 ? (
                  <p style={{ color: COLORS.muted, fontSize: 12, margin: 0 }}>还没有资料。</p>
                ) : (
                  materials.map(material => (
                    <div key={material.id} style={{ borderTop: `1px solid ${COLORS.border}` }}>
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          padding: '4px 0',
                          gap: 8,
                        }}
                      >
                        <button
                          type="button"
                          onClick={() =>
                            void openDetail(detailId === material.id ? material : material)
                          }
                          style={{
                            flex: 1,
                            minWidth: 0,
                            textAlign: 'left',
                            border: 'none',
                            background: 'transparent',
                            padding: 0,
                            cursor: 'pointer',
                            color: detailId === material.id ? COLORS.accent : 'inherit',
                          }}
                        >
                          <div style={{ fontSize: 13 }}>{material.title}</div>
                          <div style={{ fontSize: 11, color: COLORS.muted }}>
                            {material.chunkCount} 个片段 · 第 {material.revision} 版
                          </div>
                        </button>
                        <ConfirmButton
                          label="删除"
                          confirmLabel="移入回收站"
                          disabled={busy}
                          onConfirm={() =>
                            void run(async () => {
                              await knowbaseApi()!.deleteMaterial(material.id)
                              if (detailId === material.id) setDetailId('')
                              setMaterials(await knowbaseApi()!.listMaterials(selected.id))
                              await refreshBases()
                              await refreshRecycle()
                              return `已把「${material.title}」移入回收站。`
                            })
                          }
                        />
                      </div>

                      {detailId === material.id && (
                        <div style={{ padding: '8px 0 12px' }}>
                          {detailLoading ? (
                            <p style={{ color: COLORS.muted, fontSize: 12, margin: 0 }}>加载中…</p>
                          ) : (
                            <>
                              <div style={{ fontSize: 12, color: COLORS.muted, marginBottom: 6 }}>
                                索引内容（共 {detailChunks.length} 个片段）
                              </div>
                              {detailChunks.map(chunk => (
                                <div
                                  key={chunk.ordinal}
                                  style={{
                                    background: COLORS.subtle,
                                    border: `1px solid ${COLORS.border}`,
                                    borderRadius: 6,
                                    padding: 8,
                                    marginBottom: 6,
                                  }}
                                >
                                  <div style={{ fontSize: 11, color: COLORS.accent, marginBottom: 4 }}>
                                    片段 {chunk.ordinal + 1} · {chunk.headingPath || '（无标题）'} ·{' '}
                                    {chunk.locator}
                                  </div>
                                  <div style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>
                                    {chunk.text}
                                  </div>
                                </div>
                              ))}
                              <div style={{ fontSize: 12, color: COLORS.muted, margin: '10px 0 6px' }}>
                                编辑正文
                              </div>
                              <textarea
                                style={{ ...input, minHeight: 120, fontFamily: 'inherit' }}
                                value={detailText}
                                onChange={event => setDetailText(event.target.value)}
                              />
                              <div style={{ marginTop: 8 }}>
                                <button
                                  type="button"
                                  style={button}
                                  disabled={busy || detailText.trim() === ''}
                                  onClick={() =>
                                    void run(async () => {
                                      const material = await knowbaseApi()!.updateMaterialText(
                                        detailId,
                                        detailText,
                                      )
                                      setMaterials(await knowbaseApi()!.listMaterials(selected.id))
                                      await refreshBases()
                                      // Reload the detail view as well: saving
                                      // changes the chunk boundaries, so the list
                                      // above would otherwise keep showing the
                                      // old cut until a manual refresh.
                                      const [passages, text] = await Promise.all([
                                        knowbaseApi()!.readMaterialChunks(detailId),
                                        knowbaseApi()!.readMaterialText(detailId),
                                      ])
                                      setDetailChunks(passages)
                                      setDetailText(text)
                                      setDetailTitle(material.title)
                                      return `已保存「${material.title}」（${material.chunkCount} 个片段，第 ${material.revision} 版）。`
                                    })
                                  }
                                >
                                  保存并重建索引
                                </button>
                                <button
                                  type="button"
                                  style={{ ...button, marginLeft: 6 }}
                                  onClick={() => void openDetail({ ...material })}
                                >
                                  放弃修改
                                </button>
                              </div>
                              {detailTitle !== '' && detailTitle !== material.title && (
                                <p style={{ color: COLORS.muted, fontSize: 11, margin: '6px 0 0' }}>
                                  已保存为「{detailTitle}」。
                                </p>
                              )}
                            </>
                          )}
                        </div>
                      )}
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
                    onChange={event => {
                      setNewText(event.target.value)
                      // The warning described the previous text; keeping it
                      // would warn about content that is no longer in the box.
                      setDuplicate(null)
                    }}
                  />
                </Field>
                {duplicate !== null && (
                  <div
                    style={{
                      ...panel,
                      borderColor: '#d9a300',
                      background: '#fff9e6',
                      padding: '8px 10px',
                      marginBottom: 8,
                      fontSize: 12,
                    }}
                  >
                    该知识库中已有内容相同的资料「{duplicate.title}」（{duplicate.chunkCount}{' '}
                    个片段）。再存一份会让同一个答案在检索里出现两次。
                  </div>
                )}
                <button
                  type="button"
                  style={button}
                  disabled={busy || newTitle.trim() === '' || newText.trim() === ''}
                  onClick={() => submitMaterial(duplicate !== null)}
                >
                  {duplicate !== null ? '仍然添加' : '加入知识库'}
                </button>
                {duplicate !== null && (
                  <button
                    type="button"
                    style={{ ...button, marginLeft: 6 }}
                    onClick={() => setDuplicate(null)}
                  >
                    取消
                  </button>
                )}
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

              {/* data backup */}
              <div style={{ ...panel, padding: 10, marginTop: 12 }}>
                <div style={{ fontSize: 12, color: COLORS.muted, marginBottom: 6 }}>数据备份</div>
                <p style={{ fontSize: 11, color: COLORS.muted, margin: '0 0 8px' }}>
                  备份是 JSON 文件，含资料正文；片段由正文重建，不写入文件。导入只会新增，
                  不会覆盖或删除已有知识库。
                </p>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    style={button}
                    disabled={busy || bases.length === 0}
                    onClick={() => exportBackup('', '全部知识库')}
                  >
                    导出全部知识库
                  </button>
                  <button
                    type="button"
                    style={button}
                    disabled={busy || selected === undefined}
                    onClick={() => exportBackup(selected?.id ?? '', `「${selected?.name ?? ''}」`)}
                  >
                    导出当前知识库
                  </button>
                  <button
                    type="button"
                    style={button}
                    disabled={busy}
                    onClick={() => backupFile.current?.click()}
                  >
                    导入备份…
                  </button>
                </div>
                <input
                  ref={backupFile}
                  type="file"
                  accept=".json,application/json"
                  style={{ display: 'none' }}
                  onChange={event => {
                    const file = event.target.files?.[0]
                    // Clear the input so picking the same file twice still
                    // fires a change event — otherwise a retry after a rejected
                    // import would do nothing at all.
                    event.target.value = ''
                    if (file !== undefined) void importBackup(file)
                  }}
                />
              </div>

              {/* recycle bin */}
              <div style={{ ...panel, padding: 10, marginTop: 12 }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                  }}
                >
                  <button
                    type="button"
                    onClick={() => setRecycleOpen(open => !open)}
                    style={{
                      border: 'none',
                      background: 'transparent',
                      padding: 0,
                      cursor: 'pointer',
                      font: 'inherit',
                      color: 'inherit',
                      display: 'flex',
                      alignItems: 'baseline',
                      gap: 6,
                    }}
                  >
                    <span style={{ fontSize: 12, color: COLORS.muted }}>
                      {recycleOpen ? '▾' : '▸'} 回收站
                    </span>
                    <span style={{ fontSize: 11, color: COLORS.muted }}>
                      {recycle === undefined
                        ? ''
                        : `（${recycle.bases.length} 个知识库 / ${recycle.materials.length} 份资料）`}
                    </span>
                  </button>
                  {recycleOpen && (
                    <button
                      type="button"
                      style={button}
                      disabled={busy}
                      onClick={() => void refreshRecycle()}
                    >
                      刷新
                    </button>
                  )}
                </div>

                {recycleOpen && (
                  <div style={{ marginTop: 8 }}>
                    {recycle === undefined ? (
                      <p style={{ color: COLORS.muted, fontSize: 12, margin: 0 }}>加载中…</p>
                    ) : (
                      recycle.bases.length === 0 &&
                      recycle.materials.length === 0 && (
                        <p style={{ color: COLORS.muted, fontSize: 12, margin: 0 }}>
                          回收站是空的。
                        </p>
                      )
                    )}

                    {recycle !== undefined && recycle.bases.length > 0 && (
                      <div style={{ marginBottom: 10 }}>
                        <div style={{ fontSize: 11, color: COLORS.muted, marginBottom: 4 }}>
                          已删除的知识库（恢复会带回应有资料）
                        </div>
                        {recycle.bases.map(base => (
                          <div
                            key={base.id}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              gap: 8,
                              padding: '4px 0',
                              borderTop: `1px solid ${COLORS.border}`,
                            }}
                          >
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontSize: 13 }}>{base.name}</div>
                              <div style={{ fontSize: 11, color: COLORS.muted }}>
                                {base.materialCount} 份资料 / {base.chunkCount} 个片段
                              </div>
                            </div>
                            <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                              <button
                                type="button"
                                style={button}
                                disabled={busy}
                                onClick={() =>
                                  void run(async () => {
                                    await knowbaseApi()!.restoreKnowledgeBase(base.id)
                                    await refreshBases()
                                    await refreshRecycle()
                                    return `已恢复「${base.name}」。`
                                  })
                                }
                              >
                                恢复
                              </button>
                              <ConfirmButton
                                label="永久删除"
                                confirmLabel={`永久删除（含 ${base.materialCount} 份资料）`}
                                disabled={busy}
                                onConfirm={() =>
                                  void run(async () => {
                                    await knowbaseApi()!.purgeKnowledgeBase(base.id)
                                    await refreshRecycle()
                                    return `已永久删除「${base.name}」，不可恢复。`
                                  })
                                }
                              />
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {recycle !== undefined && recycle.materials.length > 0 && (
                      <div>
                        <div style={{ fontSize: 11, color: COLORS.muted, marginBottom: 4 }}>
                          已删除的资料
                        </div>
                        {recycle.materials.map(material => {
                          const baseName =
                            bases.find(base => base.id === material.kbId)?.name ??
                            recycle.bases.find(base => base.id === material.kbId)?.name
                          return (
                            <div
                              key={material.id}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                gap: 8,
                                padding: '4px 0',
                                borderTop: `1px solid ${COLORS.border}`,
                              }}
                            >
                              <div style={{ minWidth: 0 }}>
                                <div style={{ fontSize: 13 }}>{material.title}</div>
                                <div style={{ fontSize: 11, color: COLORS.muted }}>
                                  {material.chunkCount} 个片段
                                  {baseName !== undefined && ` · 原属「${baseName}」`}
                                </div>
                              </div>
                              <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                                <button
                                  type="button"
                                  style={button}
                                  disabled={busy}
                                  onClick={() =>
                                    void run(async () => {
                                      await knowbaseApi()!.restoreMaterial(material.id)
                                      await refreshBases()
                                      await refreshRecycle()
                                      if (selectedId === material.kbId) {
                                        setMaterials(
                                          await knowbaseApi()!.listMaterials(selectedId),
                                        )
                                      }
                                      return `已恢复「${material.title}」。`
                                    })
                                  }
                                >
                                  恢复
                                </button>
                                <ConfirmButton
                                  label="永久删除"
                                  confirmLabel="确认永久删除"
                                  disabled={busy}
                                  onConfirm={() =>
                                    void run(async () => {
                                      await knowbaseApi()!.purgeMaterial(material.id)
                                      await refreshRecycle()
                                      return `已永久删除「${material.title}」，不可恢复。`
                                    })
                                  }
                                />
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}

                    <p style={{ color: COLORS.muted, fontSize: 11, margin: '8px 2px 0' }}>
                      删除的知识库和资料保存在回收站，可随时恢复；「永久删除」不可恢复。
                    </p>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
