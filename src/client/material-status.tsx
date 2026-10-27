import * as React from 'react'
import type { MaterialView } from '../remote.ts'
import { Icon, type IconName } from './icons.tsx'

/** Use the Host's committed scan outcome; absence is not evidence of success. */
export function MaterialStatus({ material }: { material: MaterialView }): React.ReactElement | null {
  const status = material.indexStatus
  if (status === undefined) return null
  const variants: Record<NonNullable<MaterialView['indexStatus']>, { icon: IconName; label: string; detail: string }> = {
    searchable: { icon: 'check-circle', label: '可检索', detail: '已提取可检索文字；不代表提取内容完全准确。' },
    unsupported: { icon: 'skip-circle', label: '格式不支持', detail: '已扫描，当前格式不支持提取文字，文件仍保留。' },
    unsearchable: { icon: 'alert-triangle', label: '不可检索', detail: material.note || '未提取到可检索文字，文件可能为空或只含空白。' },
  }
  const view = variants[status]
  const description = `${view.label}：${view.detail}`
  return <span className={`kb-file-status kb-file-status--${status}`} data-kb-file-status={status}
    role="img" aria-label={description} title={description} tabIndex={0}>
    <Icon name={view.icon} size={15} />
  </span>
}
