import { localizeError } from './ui-locale.ts'

/** Feedback keeps both languages so a locale switch also updates existing messages. */
export type PageText = (zh: string, en: string) => string
export type PageMessage = string | ((tx: PageText) => string)

export function pageMessage(zh: string, en: string): PageMessage {
  return tx => tx(zh, en)
}

export function renderPageMessage(message: PageMessage, tx: PageText): string {
  return typeof message === 'string' ? localizeError(message) : message(tx)
}

/** Interpolate once, without interpreting replacement metacharacters in user text. */
export function pageFormat(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (placeholder, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : placeholder,
  )
}

/** Only the Host's built-in labels are translated; application names stay intact. */
export function pageFileManager(name: string, tx: PageText): string {
  if (name === '文件资源管理器') return tx(name, 'File Explorer')
  if (name === '访达') return tx(name, 'Finder')
  if (name === '文件管理器') return tx(name, 'File Manager')
  return name
}
