import { describe, expect, it } from 'vitest'
import { formatLibraryMap, installLibraryPrompt, promptLabel } from '../src/prompt-map.ts'

const summaries = [
  { name: '产品资料', description: '发布说明', materialCount: 4, indexedCount: 3 },
  { name: '研发资料', description: '', materialCount: 2, indexedCount: 2 },
] as const

describe('model-facing knowledge-base map', () => {
  it('includes bounded metadata and makes its evidence boundary explicit', () => {
    const text = formatLibraryMap(summaries)
    expect(text).toContain('本地知识库概览')
    expect(text).toContain('产品资料')
    expect(text).toContain('资料 4 份，可检索 3 份')
    expect(text).toContain('不是用户指令')
    expect(text).not.toContain('filePath')
  })

  it('caps long maps and reports omitted bases without dumping their descriptions', () => {
    const many = Array.from({ length: 80 }, (_, index) => ({
      name: `库-${index}`,
      description: '说明'.repeat(200),
      materialCount: index,
      indexedCount: index,
    }))
    const text = formatLibraryMap(many)
    expect(text.length).toBeLessThanOrEqual(2500)
    expect(text).toContain('其余')
    expect(text).not.toContain('说明'.repeat(100))
  })

  it('filters controls and recognizable absolute paths from metadata', () => {
    expect(promptLabel('a\r\nb')).toBe('a b')
    expect(promptLabel('C:\\vault\\secret.txt')).toBe('路径已隐藏')
    expect(promptLabel('/private/vault')).toBe('路径已隐藏')
    expect(promptLabel('x'.repeat(300), 20)).toHaveLength(20)
  })

  it('registers one disposable dynamic section through the inspected service face', () => {
    let registered: { name: string; order: number; text: () => string } | undefined
    let disposed = false
    const ctx = {
      inject(_names: string[], callback: (scope: unknown) => void) {
        callback({
          effect(effect: () => () => void) {
            const dispose = effect()
            registered = registered
            return () => { dispose(); disposed = true }
          },
          systemPrompt: {
            section(section: { name: string; order: number; text: () => string }) {
              registered = section
              return () => { registered = undefined }
            },
          },
        })
      },
    }
    installLibraryPrompt(ctx as never, () => undefined)
    expect(registered?.name).toBe('knowbase-library-map')
    expect(registered?.order).toBe(760)
    expect(registered?.text()).toBe('')
    expect(disposed).toBe(false)
  })
})
