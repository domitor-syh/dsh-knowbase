/**
 * Backup format tests.
 *
 * A backup is the one artifact that has to work when everything else has already
 * gone wrong, so the properties worth pinning down are the ones that decide
 * whether a file is trusted: the header check runs before the field check, an
 * unknown future version is refused rather than half-read, and a restore never
 * overwrites — it reallocates ids and disambiguates names instead.
 */

import { describe, expect, it } from 'vitest'
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  BackupError,
  backupFileName,
  buildBackupDocument,
  parseBackupDocument,
  planImport,
  serializeBackup,
  type BackupBase,
  type BackupDocument,
} from '../src/core/backup.ts'
import { contentFingerprint, normalizeForFingerprint } from '../src/core/fingerprint.ts'

/** A minimal material, overridable per test. */
function material(overrides: Partial<BackupBase['materials'][number]> = {}) {
  return {
    id: 'mat_1',
    title: '端口说明',
    text: '出厂默认波特率为115200。',
    createdAt: 1000,
    updatedAt: 1000,
    revision: 1,
    ...overrides,
  }
}

/** A minimal base, overridable per test. */
function base(overrides: Partial<BackupBase> = {}): BackupBase {
  return {
    id: 'kb_1',
    name: '产品资料',
    description: '',
    createdAt: 1000,
    updatedAt: 1000,
    materials: [material()],
    ...overrides,
  }
}

/** A document as `buildBackupDocument` would produce it. */
function documentOf(bases: readonly BackupBase[]): BackupDocument {
  return buildBackupDocument({ bases, exportedAt: 5_000, generator: 'test' })
}

/** A deterministic id factory, so plans are comparable. */
function counter(): (prefix: string) => string {
  let next = 0
  return prefix => {
    next += 1
    return `${prefix}_new${next}`
  }
}

describe('fingerprint — what counts as the same content', () => {
  it('ignores whitespace layout', () => {
    expect(contentFingerprint('甲  乙\n\n丙')).toBe(contentFingerprint('甲 乙 丙'))
    expect(contentFingerprint('  甲  ')).toBe(contentFingerprint('甲'))
  })

  it('normalises full-width characters, as retrieval does', () => {
    expect(contentFingerprint('１１５２００')).toBe(contentFingerprint('115200'))
  })

  it('does not fold case — a stored document is not a query', () => {
    expect(contentFingerprint('USB')).not.toBe(contentFingerprint('usb'))
  })

  it('separates genuinely different text', () => {
    expect(contentFingerprint('甲')).not.toBe(contentFingerprint('乙'))
  })

  it('exposes the normalisation it compares on', () => {
    expect(normalizeForFingerprint('  甲\n\n乙  ')).toBe('甲 乙')
  })
})

describe('backup — build', () => {
  it('orders bases by name and materials by creation time', () => {
    const document = documentOf([
      base({ id: 'kb_b', name: '乙', materials: [] }),
      base({
        id: 'kb_a',
        name: '甲',
        materials: [
          material({ id: 'mat_late', createdAt: 2000 }),
          material({ id: 'mat_early', createdAt: 1000 }),
        ],
      }),
    ])
    expect(document.bases.map(item => item.name)).toEqual(['甲', '乙'])
    expect(document.bases[0]!.materials.map(item => item.id)).toEqual(['mat_early', 'mat_late'])
  })

  it('is byte-identical for unchanged data, so backups are diffable', () => {
    const once = serializeBackup(documentOf([base()]))
    const twice = serializeBackup(documentOf([base()]))
    expect(once).toBe(twice)
  })

  it('stamps the format and version it claims', () => {
    const document = documentOf([base()])
    expect(document.format).toBe(BACKUP_FORMAT)
    expect(document.version).toBe(BACKUP_VERSION)
  })
})

describe('backup — parse', () => {
  it('round-trips a serialized document', () => {
    const document = documentOf([base()])
    expect(parseBackupDocument(serializeBackup(document))).toEqual(document)
  })

  it('refuses text that is not JSON at all', () => {
    expect(() => parseBackupDocument('not json')).toThrow(BackupError)
    expect(() => parseBackupDocument('not json')).toThrow(/不是一个 JSON/)
  })

  it('refuses JSON that is not a backup, before complaining about fields', () => {
    // The ordering matters: a user who picked the wrong file should be told
    // that, not handed a field-level complaint about a document they never
    // meant to import.
    expect(() => parseBackupDocument('{"hello":"world"}')).toThrow(/不是 dsh-knowbase 的备份文件/)
  })

  it('refuses a top-level array', () => {
    expect(() => parseBackupDocument('[]')).toThrow(/顶层应当是一个对象/)
  })

  it('refuses a backup from a newer plugin instead of reading it partially', () => {
    const future = JSON.stringify({
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION + 1,
      exportedAt: 1,
      generator: 'test',
      bases: [],
    })
    expect(() => parseBackupDocument(future)).toThrow(/高于当前插件支持的/)
  })

  it('refuses a document missing a required field', () => {
    const broken = JSON.stringify({
      format: BACKUP_FORMAT,
      version: 1,
      exportedAt: 1,
      generator: 'test',
      bases: [{ id: 'kb_1', name: '甲', description: '', createdAt: 1, updatedAt: 1 }],
    })
    expect(() => parseBackupDocument(broken)).toThrow(/内容不完整/)
  })

  it('accepts a record carrying fields it does not know', () => {
    // Forward compatibility: a newer build that added a field must not make the
    // file unreadable on an older one.
    const extended = JSON.stringify({
      format: BACKUP_FORMAT,
      version: 1,
      exportedAt: 1,
      generator: 'test',
      futureField: true,
      bases: [
        {
          id: 'kb_1',
          name: '甲',
          description: '',
          createdAt: 1,
          updatedAt: 1,
          materials: [
            { id: 'm', title: 't', text: 'x', createdAt: 1, updatedAt: 1, revision: 1, tag: 'y' },
          ],
        },
      ],
    })
    const parsed = parseBackupDocument(extended)
    expect(parsed.bases).toHaveLength(1)
    expect(parsed.bases[0]!.materials[0]!.text).toBe('x')
  })
})

describe('backup — filename', () => {
  it('is derived from the export time, not from the locale', () => {
    const at = new Date(2026, 9, 13, 9, 5, 7).getTime()
    expect(backupFileName(at)).toBe('dsh-knowbase-backup-20261013-090507.json')
  })
})

describe('backup — restore plan', () => {
  const nothingTaken = { baseIds: [] as string[], baseNames: [] as string[] }

  it('keeps the original id when it is free', () => {
    const plan = planImport(documentOf([base()]), nothingTaken, counter())
    expect(plan.bases[0]!.id).toBe('kb_1')
    expect(plan.reallocatedBases).toBe(0)
  })

  it('reallocates an id that is already in use, rather than replacing that base', () => {
    const plan = planImport(
      documentOf([base()]),
      { baseIds: ['kb_1'], baseNames: [] },
      counter(),
    )
    expect(plan.bases[0]!.id).toBe('kb_new1')
    expect(plan.reallocatedBases).toBe(1)
  })

  it('reallocates an empty id', () => {
    const plan = planImport(documentOf([base({ id: '' })]), nothingTaken, counter())
    expect(plan.bases[0]!.id).toBe('kb_new1')
    expect(plan.reallocatedBases).toBe(1)
  })

  it('disambiguates a name that is already taken', () => {
    const plan = planImport(
      documentOf([base()]),
      { baseIds: [], baseNames: ['产品资料'] },
      counter(),
    )
    expect(plan.bases[0]!.name).toBe('产品资料（导入 2）')
  })

  it('keeps disambiguating when several copies are already there', () => {
    const plan = planImport(
      documentOf([base()]),
      { baseIds: [], baseNames: ['产品资料', '产品资料（导入 2）'] },
      counter(),
    )
    expect(plan.bases[0]!.name).toBe('产品资料（导入 3）')
  })

  it('separates two same-named bases inside one file', () => {
    const plan = planImport(
      documentOf([base({ id: 'kb_a' }), base({ id: 'kb_b' })]),
      nothingTaken,
      counter(),
    )
    expect(plan.bases.map(item => item.name)).toEqual(['产品资料', '产品资料（导入 2）'])
  })

  it('keeps the suffix inside the name limit', () => {
    const long = '甲'.repeat(120)
    const plan = planImport(
      documentOf([base({ name: long })]),
      { baseIds: [], baseNames: ['甲'.repeat(80)] },
      counter(),
    )
    expect(plan.bases[0]!.name.length).toBeLessThanOrEqual(80)
    expect(plan.bases[0]!.name.endsWith('（导入 2）')).toBe(true)
  })

  it('drops materials with no indexable text and counts them', () => {
    const plan = planImport(
      documentOf([
        base({
          materials: [material(), material({ id: 'mat_2', text: '   \n  ' })],
        }),
      ]),
      nothingTaken,
      counter(),
    )
    expect(plan.bases[0]!.materials).toHaveLength(1)
    expect(plan.skippedMaterials).toBe(1)
  })

  it('always allocates fresh material ids', () => {
    const plan = planImport(documentOf([base()]), nothingTaken, counter())
    expect(plan.bases[0]!.materials[0]!.id).toBe('mat_new1')
  })

  it('preserves timestamps and revision, so old citations still resolve', () => {
    const plan = planImport(
      documentOf([base({ materials: [material({ revision: 7, createdAt: 42, updatedAt: 99 })] })]),
      nothingTaken,
      counter(),
    )
    const planned = plan.bases[0]!.materials[0]!
    expect(planned.revision).toBe(7)
    expect(planned.createdAt).toBe(42)
    expect(planned.updatedAt).toBe(99)
  })
})
