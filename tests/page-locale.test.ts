import { describe, expect, it } from 'vitest'
import { pageFileManager, pageFormat, pageMessage, renderPageMessage, type PageMessage, type PageText } from '../src/client/page-locale.ts'

const zh: PageText = chinese => chinese
const en: PageText = (_chinese, english) => english

describe('page feedback localization', () => {
  it('renders a retained message in Chinese, English, and Chinese again', () => {
    let language: 'zh' | 'en' = 'zh'
    const tx: PageText = (chinese, english) => language === 'zh' ? chinese : english
    const message = pageMessage('正在扫描知识库…', 'Scanning knowledge bases…')

    expect(renderPageMessage(message, tx)).toBe('正在扫描知识库…')
    language = 'en'
    expect(renderPageMessage(message, tx)).toBe('Scanning knowledge bases…')
    language = 'zh'
    expect(renderPageMessage(message, tx)).toBe('正在扫描知识库…')
  })

  it('keeps dynamic feedback reactive without changing user text', () => {
    const name = '用户资料 $& {count}.txt'
    const message: PageMessage = tx => pageFormat(
      tx('已加入「{name}」，共 {count} 个文件。', 'Added “{name}”; {count} files in total.'),
      { name, count: 2 },
    )
    expect(renderPageMessage(message, zh)).toBe(`已加入「${name}」，共 2 个文件。`)
    expect(renderPageMessage(message, en)).toBe(`Added “${name}”; 2 files in total.`)
    expect(renderPageMessage(message, zh)).toBe(`已加入「${name}」，共 2 个文件。`)
  })

  it('keeps cleared feedback empty in either language', () => {
    expect(renderPageMessage('', zh)).toBe('')
    expect(renderPageMessage('', en)).toBe('')
  })
})

describe('page template interpolation', () => {
  it.each(['用户资料 $& {count}', "$` $' $$", '{name}/{count}', '中文 name'])('preserves the literal user name %s', name => {
    expect(pageFormat('Files in {name} ({count})', { name, count: 3 })).toBe(`Files in ${name} (3)`)
  })

  it('replaces repeated fields once and does not expand inserted placeholder text', () => {
    expect(pageFormat('{name} / {name} / {count}', { name: '{count}', count: 0 })).toBe('{count} / {count} / 0')
  })

  it('preserves unknown placeholders and ignores inherited properties', () => {
    expect(pageFormat('{name} {unknown} {toString}', { name: '资料' })).toBe('资料 {unknown} {toString}')
  })
})

describe('page file manager labels', () => {
  it.each([
    ['文件资源管理器', 'File Explorer'],
    ['访达', 'Finder'],
    ['文件管理器', 'File Manager'],
  ])('localizes the known Host label %s', (chinese, english) => {
    expect(pageFileManager(chinese, zh)).toBe(chinese)
    expect(pageFileManager(chinese, en)).toBe(english)
  })

  it('preserves application names supplied by the Host', () => {
    expect(pageFileManager('用户管理器 $& {name}', en)).toBe('用户管理器 $& {name}')
  })
})
