import { createHash } from 'node:crypto'

export interface ScaleDocument {
  readonly id: string
  readonly kbId: string
  readonly materialId: string
  readonly title: string
  readonly text: string
}

export const SCALE_CORPUS_VERSION = 'synthetic-mixed-v1'
export const SCALE_BASES = 8
const topics = [
  '设备出厂默认波特率为115200，恢复出厂设置前应当备份配置。',
  '增值税申报截止日期为每月十五日，发票应归档并核对税额。',
  '以太网连接需要检查网线接口，Ethernet cable connects the device.',
  '园艺种植选择透气土壤并定期浇水，观察植物的叶片和根系。',
  '保修期内凭购买单据申请维修，记录设备型号和故障现象。',
  '备份数据库之前检查剩余空间，执行恢复演练并保存结果。',
  '固件升级后复核网络参数，验证串口通信和电源工作状态。',
  '古文字𠀀的释义应查专门字典，测量设备温度与运行电压。',
]

/** Four chunks per synthetic file; the first two deliberately duplicate evidence. */
export function scaleDocument(index: number, chars = 600): ScaleDocument {
  const material = Math.floor(index / 4)
  const ordinal = index % 4
  const kbId = `base-${material % SCALE_BASES}`
  const materialId = `manual-${String(material).padStart(7, '0')}.txt`
  const identifier = `ZX${String(material).padStart(8, '0')}`
  const topic = topics[material % topics.length]!
  const prefix = `${identifier}；${ordinal < 2 ? '标准说明' : `补充说明${ordinal}`}。${topic}`
  const text = (prefix + topic.repeat(Math.ceil(chars / topic.length))).slice(0, chars)
  return { id: `chunk-${String(index).padStart(8, '0')}`, kbId, materialId, title: materialId, text }
}

export function scaleCases() {
  return [
    { id: 'common-zh', query: '恢复出厂设置', expected: 'hits' },
    { id: 'single-han', query: '税', expected: 'hits' },
    { id: 'two-han', query: '发票', expected: 'hits' },
    { id: 'astral-han', query: '𠀀', expected: 'hits' },
    { id: 'latin-word', query: 'ethernet', expected: 'hits' },
    { id: 'exact-identifier', query: 'ZX00000000', expected: 'hits' },
    { id: 'identifier-miss', query: 'ZX99999999', expected: 'miss' },
    { id: 'unseen-word', query: 'unfindablesyntheticterm', expected: 'miss' },
  ] as const
}

export function fingerprintDocuments(documents: Iterable<ScaleDocument>): string {
  const hash = createHash('sha256')
  for (const document of documents) hash.update(JSON.stringify(document) + '\n')
  return hash.digest('hex')
}
