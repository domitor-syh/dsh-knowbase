# dsh-knowbase

> dsh 知识库插件，为 dsh 提供轻量级知识管理与智能检索能力
> A lightweight knowledge base plugin for dsh, empowering knowledge management and intelligent retrieval

面向 **DeepSeek Harness（dsh）** 的原生、本地优先知识库插件。目标是在 dsh 内提供完整的「资料入库 → 自动检索 → 引用回答」闭环，不依赖外部知识库服务，也不修改 dsh 宿主核心。

- 当前状态：**方案阶段**，尚未开始插件业务实现。
- 目标宿主：Windows 桌面版 **dsh 0.2.0-rc.2**（官方标签 `dsh-v0.2.0-rc.2`）。
- 技术路线：dsh 原生 Host + Client 插件 + 本地检索引擎（TypeScript）。

## 文档

| 文档 | 说明 |
|---|---|
| [outputs/dsh-knowbase-MVP修订方案-v0.2.md](outputs/dsh-knowbase-MVP修订方案-v0.2.md) | 当前生效方案，含 MVP 范围、接口核查、UI 设计、验收标准 |
| [outputs/dsh-knowbase-MVP修订方案-v0.2.html](outputs/dsh-knowbase-MVP修订方案-v0.2.html) | 上述方案的阅读版（含界面示意） |
| [outputs/dsh-knowbase-开发方案.md](outputs/dsh-knowbase-开发方案.md) | 首版方案，保留作对照 |

> 以 v0.2 修订方案为准，早期 v0.1 稿仅作历史记录。

## MVP 范围（v0.1）

- **存储与检索全部本地执行**，不引入新的云服务、账号或 API key。
- **不使用 embedding / 向量库 / 重排模型**：采用中文字符 n-gram 词项加本地 BM25 检索，保留英文单词、型号与编号。界面明确标注「关键词检索」。
- **格式**：新建文本、TXT、Markdown、文本型 PDF、PNG/JPG（本地中英 OCR）。
- **回答**：复用 dsh 当前会话模型，联网复用其现有 web 提供方；未命中时给出固定提示，并按权限条件回退。
- **功能**：独立设置页、库增删改名、资料增删与文本编辑、对话开关、单库/全部选择、自动检索、未命中提示与条件联网。
- **必要增强**：来源引用与详情、入库状态/重试/取消、同库重复检测、检索测试、会话选择持久化、软删除与恢复、基础备份导出与恢复。

**后置**：DOCX、扫描 PDF 整本 OCR、表格/演示解析、语义向量与重排、视觉图表理解、自选多个库、目录同步、团队与云同步。

## 开发阶段

| 阶段 | 内容 |
|---|---|
| 阶段 0 | 0.2.0-rc.2 桌面兼容性验证（先于业务开发，含 pre-step 合法来源消息接入验证） |
| 阶段 1 | 知识库管理与文本问答闭环 |
| 阶段 2 | 完成 v0.1 MVP 全部范围（PDF、图片 OCR、检索测试、备份恢复等） |
| 阶段 3 | 可靠性与发行 |
| 阶段 4 | 按用户选择增强（向量、DOCX、自选多库等） |

## 关键约束

- 优先通过 dsh 官方 slots、Remote 与 Agent 接口接入，**不修改宿主核心、不通过 DOM 注入绕过接口**。
- 目标版本 `dsh-v0.2.0-rc.2` **没有** `systemPrompt.refreshContext`，`PromptContext` 也**没有** `required` 字段；不得沿用 master 新版刷新设计。
- 首次模型上下文接入需先验证公开、合法的插件来源证据消息，无法安全表达时调整接入方案而非硬套新版 API。

## 目录结构

```text
.
├── outputs/          # 方案与设计文档
├── .workbuddy-ai/    # 本地助手工作数据（已 gitignore）
└── README.md
```

插件实现代码的目录结构将在阶段 0 兼容性验证通过后确定。

## 官方来源

- 官方主页：https://www.deepseek.com/harness/
- 官方仓库：https://github.com/deepseek-ai/deepseek-harness
- 版本与运行要求：https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/package.json

## License

[MIT](LICENSE) © 2026 domitor
