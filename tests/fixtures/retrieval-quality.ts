import path from 'node:path'
import { KnowbaseService, MemoryStore } from '../../src/core/service.ts'
import { createMemoryVaultFs } from '../../src/vault-fs.ts'

/** Synthetic, local-only corpus. No user files, OCR runtime or network. */
export const qualityCases = [
  { id: 'zh-question', group: '中文', query: '默认波特率是多少', expected: ['设备手册.md'] },
  { id: 'zh-short', group: '中文', query: '波特率', expected: ['设备手册.md'] },
  { id: 'zh-single', group: '短查询', query: '税', expected: ['财务.txt'] },
  { id: 'zh-single-unrelated', group: '短查询', query: '鲸', expected: [] },
  { id: 'zh-astral', group: '短查询', query: '𠀀', expected: ['生僻字.txt'] },
  { id: 'zh-two', group: '中文', query: '发票', expected: ['财务.txt'] },
  { id: 'number-whole', group: '数字', query: '13363537216', expected: ['刘一江的电话.txt'] },
  { id: 'number-prefix', group: '数字', query: '133', expected: ['刘一江的电话.txt'] },
  { id: 'number-middle', group: '数字', query: '6353', expected: ['刘一江的电话.txt'] },
  { id: 'number-width', group: '数字', query: '１３３６３５３７２１６', expected: ['刘一江的电话.txt'] },
  { id: 'number-false-prefix', group: '数字负例', query: '13399999999', expected: [] },
  { id: 'number-false-middle', group: '数字负例', query: '6353999', expected: [] },
  { id: 'english', group: '英文', query: 'ethernet', expected: ['网络.txt'] },
  { id: 'english-case', group: '英文', query: 'ETHERNET', expected: ['网络.txt'] },
  { id: 'english-width', group: '英文', query: 'ＥＴＨＥＲＮＥＴ', expected: ['网络.txt'] },
  { id: 'mixed', group: '混合', query: 'USB连接方式', expected: ['网络.txt'] },
  { id: 'title-person', group: '标题', query: '刘一江', expected: ['刘一江的电话.txt'] },
  { id: 'title-only', group: '标题', query: '保修政策', expected: ['保修政策.md'] },
  { id: 'identifier', group: '数字', query: 'ZX2048', expected: ['型号.txt'] },
  { id: 'identifier-middle', group: '数字', query: '2048', expected: ['型号.txt'] },
  { id: 'identifier-false', group: '数字负例', query: 'ZX2099', expected: [] },
  { id: 'duplicate-budget', group: '重复片段', query: '恢复出厂设置', expected: ['重复手册.txt', '恢复补充.txt'], distinct: true },

  { id: 'miss-zh', group: '负例', query: '天体轨道力学', expected: [] },
  { id: 'miss-en', group: '负例', query: 'unfindableword', expected: [] },
  { id: 'punctuation', group: '负例', query: '，。！？', expected: [] },
  { id: 'scope', group: '范围', query: '隔离密码', expected: [] },
] as const

export async function createQualityFixture() {
  const root = path.resolve('C:/synthetic-retrieval-quality')
  const service = new KnowbaseService(new MemoryStore(), createMemoryVaultFs(root), root, {
    now: () => 1,
    chunk: { targetChars: 90, maxChars: 160 },
  })
  await service.initialize()
  const base = await service.createKnowledgeBase('测试资料容器')
  const repeated = '恢复出厂设置：长按复位按钮十秒，指示灯闪烁后松开。'
  const files = [
    ['设备手册.md', '# 串口参数\n\n设备出厂默认波特率为115200，可在配置文件中修改。'],
    ['财务.txt', '增值税申报截止日期为每月十五日，发票应当归档。'],
    ['生僻字.txt', '古文字𠀀的释义应查专门字典。'],
    ['刘一江的电话.txt', '13363537216'],
    ['网络.txt', '本产品支持USB与以太网两种连接方式。Ethernet cable connects the device.'],
    ['保修政策.md', '购买后十二个月内免费维修，凭购买单据申请。'],
    ['型号.txt', '控制器型号为ZX2048，工作电压十二伏。'],
    ['重复手册.txt', Array.from({ length: 8 }, () => repeated).join('\n\n')],
    ['恢复补充.txt', '恢复出厂设置之前请先备份配置。恢复出厂设置会清除已保存的数据。'],
    ['无关资料.txt', '园艺种植应选择透气的土壤，定期浇水。'],
  ]
  await service.addFiles(base.id, files.map(([name, text]) => ({ name: name!, data: new TextEncoder().encode(text!) })))
  const hidden = await service.createKnowledgeBase('未选中资料')
  await service.addFiles(hidden.id, [{ name: '隔离.txt', data: new TextEncoder().encode('隔离密码只在未选中的知识库里。') }])
  return { service, kbId: base.id }
}

export async function measureQuality() {
  const { service, kbId } = await createQualityFixture()
  const cases = qualityCases.map(test => {
    const result = service.retrieve(test.query, [kbId], { limit: 3 })
    const titles = result.kind === 'hits' ? result.passages.map(p => p.materialTitle) : []
    const relevantRank = titles.findIndex(title => (test.expected as readonly string[]).includes(title)) + 1
    const recall = test.expected.length === 0 ? null : test.expected.filter(title => titles.includes(title)).length / test.expected.length
    const uniqueText = result.kind === 'hits' ? new Set(result.passages.map(p => `${p.kbId}/${p.materialId}:${p.text.normalize('NFKC').replace(/\s+/gu, ' ').trim()}`)).size === result.passages.length : true
    const passed = test.expected.length === 0 ? result.kind === 'no_match' : relevantRank === 1 && recall === 1 && (!('distinct' in test) || uniqueText)
    return { id: test.id, group: test.group, query: test.query, expected: test.expected, actual: titles, kind: result.kind, reciprocalRank: relevantRank === 0 ? 0 : 1 / relevantRank, recallAt3: recall, uniqueText, passed }
  })
  const positives = cases.filter(test => test.expected.length > 0)
  const negatives = cases.filter(test => test.expected.length === 0)
  return {
    corpus: { files: 10, selectedBases: 1, hiddenFiles: 1, cases: cases.length, limit: 3 },
    metrics: {
      passed: cases.filter(test => test.passed).length,
      total: cases.length,
      mrrAt3: positives.reduce((sum, test) => sum + test.reciprocalRank, 0) / positives.length,
      meanRecallAt3: positives.reduce((sum, test) => sum + (test.recallAt3 ?? 0), 0) / positives.length,
      negativeAccuracy: negatives.filter(test => test.kind === 'no_match').length / negatives.length,
    },
    cases,
  }
}
