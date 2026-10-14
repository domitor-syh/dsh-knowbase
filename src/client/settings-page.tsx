/**
 * The 知识库 settings page.
 *
 * Layout follows the plan: a knowledge base list on the left, the selected
 * base's files and tools on the right. Everything talks to the Host through
 * `./api.ts`, so this file contains no transport, no parsing and no knowledge of
 * how a call travels.
 *
 * ## What this page is
 *
 * A file manager over a folder. A base IS a directory in the vault, and every
 * file in it is a material — so the page's job is to list what is there, let the
 * user put more in, and take things out. There is no text editor and no recycle
 * bin: files belong to the user's own explorer, and deleting means the file is
 * moved into the vault's `_回收站` folder, which is a plain folder the user can
 * drag things back out of.
 *
 * The 「重扫」 button is what makes the user's own explorer a supported way in:
 * drop a document into the base's folder, press it, and the file appears.
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
  warn: '#8a6100',
} as const

/**
 * Largest file the browser may push through the Remote channel.
 *
 * Mirrors `MAX_UPLOAD_BYTES` on the Host. It is duplicated rather than fetched
 * so the page can refuse an oversized pick before reading it into memory at all
 * — the Host's own check would only run after the bytes had already crossed.
 */
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024

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

/** The chosen option in a two-way picker, e.g. the retrieval-test scope. */
const activeButton: React.CSSProperties = {
  ...button,
  borderColor: COLORS.accent,
  color: COLORS.accent,
  fontWeight: 600,
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

/** Human-readable byte size. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * Render a retrieval report.
 *
 * The scope note is passed in rather than derived from the report: the Host
 * reports what it found, not what it was asked to search, and a miss has to say
 * *where* it looked — "nothing matched in this one base" and "nothing matched in
 * all seven" are different answers.
 */
function Report(props: { report: SearchReportView; scopeNote: string }): React.ReactElement {
  const { report, scopeNote } = props
  const note = (
    <p style={{ color: COLORS.muted, fontSize: 12, margin: '0 0 8px' }}>
      检索范围：{scopeNote}
    </p>
  )

  if (report.outcome !== 'hits') {
    const text: Record<string, string> = {
      no_match: '未命中：所选知识库中没有相关片段。换个说法或换关键词可能命中。',
      empty_scope: '所选知识库不存在或为空。',
      not_ready: '所选知识库里还没有可检索的文件（目前支持 .txt / .md 等纯文本和文本型 PDF）。',
      error: `检索失败：${report.reason}`,
    }
    return (
      <div data-kb-test-report>
        {note}
        <p style={{ color: COLORS.muted, fontSize: 13, margin: 0 }}>
          {text[report.outcome] ?? report.outcome}（{report.elapsedMs} ms）
        </p>
      </div>
    )
  }

  return (
    <div data-kb-test-report>
      {note}
      <p style={{ color: COLORS.muted, fontSize: 12, margin: '0 0 8px' }}>
        命中 {report.passages.length} 个片段，用时 {report.elapsedMs} ms
      </p>
      {report.passages.map((passage, index) => (
        <div
          key={`${passage.materialTitle}-${passage.locator}-${index}`}
          style={{ ...panel, padding: 10, marginBottom: 8, background: COLORS.subtle }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              gap: 8,
              marginBottom: 4,
            }}
          >
            <div style={{ fontSize: 12, color: COLORS.accent }}>
              [{index + 1}] {passage.kbName} / {passage.materialTitle} · {passage.locator}
            </div>
            <div style={{ fontSize: 11, color: COLORS.muted, whiteSpace: 'nowrap' }}>
              score {passage.score.toFixed(2)} · 覆盖 {Math.round(passage.coverage * 100)}%
            </div>
          </div>
          <div style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{passage.text}</div>
        </div>
      ))}
      <p style={{ color: COLORS.muted, fontSize: 11, margin: '0 2px' }}>
        score 只在同一次提问内可比；覆盖偏低说明命中的查询词少，片段可能只是碰巧重叠。
      </p>
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
  const [vaultRoot, setVaultRoot] = React.useState('')

  const [newBaseName, setNewBaseName] = React.useState('')
  const [query, setQuery] = React.useState('')
  // Retrieval test scope. The chat seam searches a set of bases, so a panel
  // fixed to one base cannot answer "what would be sent?" for a multi-base
  // session — the question the panel exists to answer.
  const [testAll, setTestAll] = React.useState(false)

  // Base info editing.
  const [editingInfo, setEditingInfo] = React.useState(false)
  const [editName, setEditName] = React.useState('')
  const [editDescription, setEditDescription] = React.useState('')

  const uploadInput = React.useRef<HTMLInputElement | null>(null)

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

  /**
   * Push the picked files into the selected base.
   *
   * Oversized files are refused here, before they are read, and reported by
   * name: the remedy is the same one the Host would give (drop it into the
   * folder instead), and saying it now avoids a pointless transfer.
   */
  const uploadFiles = React.useCallback(
    async (files: readonly File[]): Promise<void> => {
      const kbId = selectedId
      if (kbId === '') return
      const current = knowbaseApi()
      if (current === undefined) {
        setError('知识库通道尚未就绪，请稍候重试。')
        return
      }
      const tooBig: string[] = []
      const accepted: { name: string; bytes: Uint8Array }[] = []
      for (const file of files) {
        if (file.size > MAX_UPLOAD_BYTES) {
          tooBig.push(file.name)
          continue
        }
        accepted.push({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) })
      }

      await run(async () => {
        if (accepted.length === 0) {
          return `有 ${tooBig.length} 个文件过大（超过 ${formatBytes(MAX_UPLOAD_BYTES)}），请把它们直接放进知识库文件夹。`
        }
        const result = await current.addFiles(kbId, accepted)
        setMaterials(await current.listMaterials(kbId))
        await refreshBases()
        const parts = [`已加入 ${result.added} 个文件`]
        if (result.rejected.length > 0) parts.push(`${result.rejected.length} 个被拒绝`)
        for (const file of tooBig) parts.push(`「${file}」太大，未上传`)
        return `${parts.join('，')}。`
      })
    },
    [refreshBases, run, selectedId],
  )

  // The channel mounts asynchronously, so the first render has no API yet. The
  // interval also surfaces a mounting failure: a page whose buttons do nothing
  // should say why without the user opening developer tools.
  React.useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      const current = knowbaseApi()
      if (current === undefined) return
      try {
        const [list, root] = await Promise.all([
          current.listKnowledgeBases(),
          current.getVaultRoot(),
        ])
        if (cancelled) return
        setBases(list)
        setVaultRoot(root)
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
  const folderPath = selected === undefined || vaultRoot === '' ? '' : `${vaultRoot}\\${selected.folderName}`

  /** Which bases the retrieval test searches, and what to call that set. */
  const testBases = testAll
    ? bases.map(item => item.id)
    : selected === undefined
      ? []
      : [selected.id]
  const testScopeNote = testAll
    ? `全部 ${bases.length} 个知识库，共 ${bases.reduce((sum, item) => sum + item.indexedCount, 0)} 个可检索文件`
    : `「${selected?.name ?? ''}」，共 ${selected?.indexedCount ?? 0} 个可检索文件`

  /** Run the retrieval test over the chosen scope, without calling the model. */
  const submitTest = (): void => {
    if (busy || query.trim() === '' || testBases.length === 0) return
    void run(async () => {
      setReport(await knowbaseApi()!.testSearch(query, testBases))
      return ''
    })
  }

  /** Switch the selected base and close the retrieval report. */
  const selectBase = (id: string): void => {
    setSelectedId(id)
    setReport(undefined)
    setEditingInfo(false)
  }

  /** Re-read one base — or every base — from the disk. */
  const rescan = (kbId: string): void => {
    void run(async () => {
      const current = knowbaseApi()!
      await current.rescan(kbId)
      await refreshBases()
      if (kbId === '' || kbId === selectedId) setMaterials(await current.listMaterials(kbId === '' ? selectedId : kbId))
      return kbId === '' ? '已重新扫描全部知识库。' : '已重新扫描该知识库。'
    })
  }

  /** Copy the base's folder path, so the user can paste it into Explorer. */
  const copyFolderPath = (): void => {
    if (folderPath === '') return
    void navigator.clipboard
      .writeText(folderPath)
      .then(() => setNotice(`已复制文件夹路径：${folderPath}`))
      .catch(() => setError('复制失败，请手动选中路径文本复制。'))
  }

  return (
    <div style={{ padding: 16, fontSize: 14 }}>
      <h2 style={{ margin: '0 0 4px', fontSize: 18 }}>知识库</h2>
      <p style={{ margin: '0 0 16px', color: COLORS.muted, fontSize: 12 }}>
        每个知识库就是一个文件夹，里面的文件和图片都存在你的电脑上。检索在本机执行（中文 n-gram + BM25），
        未使用语义向量。
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
                    {item.materialCount} 个文件 / {item.indexedCount} 可检索
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
                  const created = await knowbaseApi()!.createKnowledgeBase(newBaseName.trim(), '')
                  setNewBaseName('')
                  await refreshBases()
                  setSelectedId(created.id)
                  return `已创建「${created.name}」，文件夹：${created.folderName}。`
                })
              }
            >
              新建知识库
            </button>
          </div>

          <button
            type="button"
            style={{ ...button, width: '100%', marginTop: 6 }}
            disabled={busy}
            onClick={() => rescan('')}
          >
            重扫全部知识库
          </button>
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
                    <label style={{ display: 'block', marginBottom: 10 }}>
                      <span style={{ display: 'block', fontSize: 12, color: COLORS.muted, marginBottom: 4 }}>
                        名称
                      </span>
                      <input
                        style={input}
                        value={editName}
                        onChange={event => setEditName(event.target.value)}
                      />
                    </label>
                    <label style={{ display: 'block', marginBottom: 10 }}>
                      <span style={{ display: 'block', fontSize: 12, color: COLORS.muted, marginBottom: 4 }}>
                        描述
                      </span>
                      <textarea
                        style={{ ...input, minHeight: 50, fontFamily: 'inherit' }}
                        value={editDescription}
                        onChange={event => setEditDescription(event.target.value)}
                      />
                    </label>
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
                          return '已保存（文件夹也一起改名了）。'
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
                        {selected.materialCount} 个文件 · {selected.indexedCount} 可检索 ·{' '}
                        {formatBytes(selected.bytes)}
                        {selected.description !== '' && ` · ${selected.description}`}
                      </div>
                      {folderPath !== '' && (
                        <div
                          style={{
                            fontSize: 11,
                            color: COLORS.muted,
                            marginTop: 2,
                            wordBreak: 'break-all',
                          }}
                        >
                          文件夹：{folderPath}
                        </div>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: 4, flexShrink: 0, flexWrap: 'wrap' }}>
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
                      <button type="button" style={button} disabled={busy} onClick={copyFolderPath}>
                        复制文件夹路径
                      </button>
                      <ConfirmButton
                        label="删除知识库"
                        confirmLabel="移入 _回收站"
                        disabled={busy}
                        onConfirm={() =>
                          void run(async () => {
                            const name = selected.name
                            await knowbaseApi()!.deleteKnowledgeBase(selected.id)
                            await refreshBases()
                            return `已把「${name}」的文件夹移入 _回收站（没有销毁，需要时可在资源管理器里拖回来）。`
                          })
                        }
                      />
                    </div>
                  </>
                )}
              </div>

              {/* files */}
              <div style={{ ...panel, padding: 10, marginBottom: 12 }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                    marginBottom: 6,
                  }}
                >
                  <span style={{ fontSize: 12, color: COLORS.muted }}>
                    文件（{materials.length}）
                  </span>
                  <span style={{ display: 'flex', gap: 6 }}>
                    <button
                      type="button"
                      style={button}
                      disabled={busy}
                      onClick={() => uploadInput.current?.click()}
                    >
                      上传文件…
                    </button>
                    <button type="button" style={button} disabled={busy} onClick={() => rescan(selected.id)}>
                      重扫
                    </button>
                  </span>
                </div>
                <input
                  ref={uploadInput}
                  type="file"
                  multiple
                  style={{ display: 'none' }}
                  onChange={event => {
                    const files = [...(event.target.files ?? [])]
                    // Clear the input so picking the same file twice still
                    // fires a change event.
                    event.target.value = ''
                    if (files.length > 0) void uploadFiles(files)
                  }}
                />
                {materials.length === 0 ? (
                  <p style={{ color: COLORS.muted, fontSize: 12, margin: 0 }}>
                    还没有文件。用「上传文件」加入，或者把文件直接放进上面那个文件夹再点「重扫」。
                  </p>
                ) : (
                  materials.map(material => (
                    <div
                      key={material.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 8,
                        padding: '6px 0',
                        borderTop: `1px solid ${COLORS.border}`,
                      }}
                    >
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 13, wordBreak: 'break-all' }}>{material.fileName}</div>
                        <div style={{ fontSize: 11, color: COLORS.muted }}>
                          {formatBytes(material.bytes)}
                          {material.indexed ? ' · 可检索' : ' · 暂不可检索'}
                        </div>
                        {material.note === '' ? null : (
                          <div style={{ fontSize: 11, color: COLORS.muted }}>{material.note}</div>
                        )}
                      </div>
                      <ConfirmButton
                        label="删除"
                        confirmLabel="移入 _回收站"
                        disabled={busy}
                        onConfirm={() =>
                          void run(async () => {
                            await knowbaseApi()!.deleteMaterial(selected.id, material.id)
                            setMaterials(await knowbaseApi()!.listMaterials(selected.id))
                            await refreshBases()
                            return `已把「${material.fileName}」移入 _回收站。`
                          })
                        }
                      />
                    </div>
                  ))
                )}
                <p style={{ color: COLORS.muted, fontSize: 11, margin: '8px 2px 0' }}>
                  目前会被检索的是纯文本（.txt / .md 等）和文本型 PDF（保留页码）。
                  图片会上传保存，OCR 提取文字还没做；扫描件 PDF 没有文字层，需要先把页面转成图片。
                </p>
              </div>

              {/* retrieval test */}
              <div data-kb-retrieval-test style={{ ...panel, padding: 10, marginBottom: 12 }}>
                <div style={{ fontSize: 12, color: COLORS.muted, marginBottom: 6 }}>
                  检索测试（不调用模型）
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                  <span style={{ fontSize: 12, color: COLORS.muted }}>范围</span>
                  <button
                    type="button"
                    data-kb-test-scope="base"
                    style={testAll ? button : activeButton}
                    disabled={busy}
                    onClick={() => {
                      setTestAll(false)
                      setReport(undefined)
                    }}
                  >
                    当前库
                  </button>
                  <button
                    type="button"
                    data-kb-test-scope="all"
                    style={testAll ? activeButton : button}
                    disabled={busy || bases.length === 0}
                    onClick={() => {
                      setTestAll(true)
                      setReport(undefined)
                    }}
                  >
                    全部知识库（{bases.length}）
                  </button>
                </div>
                <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                  <input
                    style={input}
                    placeholder="输入一个问题"
                    value={query}
                    onChange={event => setQuery(event.target.value)}
                    onKeyDown={event => {
                      if (event.key === 'Enter') submitTest()
                    }}
                  />
                  <button
                    type="button"
                    style={button}
                    disabled={busy || query.trim() === ''}
                    onClick={submitTest}
                  >
                    检索
                  </button>
                </div>
                {report !== undefined && <Report report={report} scopeNote={testScopeNote} />}
              </div>

              <p style={{ color: COLORS.muted, fontSize: 11, margin: 2 }}>
                知识库根目录：{vaultRoot === '' ? '（读取中…）' : vaultRoot}。删除的库和文件都会移到这里面的
                _回收站 文件夹，没有被销毁。
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
