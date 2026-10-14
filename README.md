# dsh-knowbase

[![CI](https://github.com/domitor-syh/dsh-knowbase/actions/workflows/ci.yml/badge.svg)](https://github.com/domitor-syh/dsh-knowbase/actions/workflows/ci.yml)

> dsh 知识库插件，为 dsh 提供轻量级知识管理与智能检索能力
> A lightweight knowledge base plugin for dsh, empowering knowledge management and intelligent retrieval

面向 **DeepSeek Harness（dsh）** 的原生、本地优先知识库插件。目标是在 dsh 内提供完整的「资料入库 → 自动检索 → 引用回答」闭环，不依赖外部知识库服务，也不修改 dsh 宿主核心。

- 当前状态：**阶段 1 核心闭环已跑通**——资料入库 → 中文检索 → 带出处的引用回答，已在真实宿主上端到端验证；设置页 UI 尚未实现，库管理暂由 `/kb` 命令承担。
- 目标宿主：Windows 桌面版 **dsh 0.2.0-rc.2**（官方标签 `dsh-v0.2.0-rc.2`）。
- 技术路线：dsh 原生 Host + Client 插件 + 本地检索引擎（TypeScript）。

## 文档

| 文档 | 说明 |
|---|---|
| [outputs/阶段0-兼容性核查报告.md](outputs/阶段0-兼容性核查报告.md) | **最新**：目标宿主实测接口事实、方案修正与真机加载结果 |
| [outputs/dsh-knowbase-MVP修订方案-v0.2.md](outputs/dsh-knowbase-MVP修订方案-v0.2.md) | 开发方案，含 MVP 范围、UI 设计、验收标准 |
| [outputs/dsh-knowbase-MVP修订方案-v0.2.html](outputs/dsh-knowbase-MVP修订方案-v0.2.html) | 上述方案的阅读版（含界面示意） |
| [outputs/dsh-knowbase-开发方案.md](outputs/dsh-knowbase-开发方案.md) | 首版方案，保留作对照 |

> 以阶段 0 核查报告为准来理解宿主接口；方案文档中的接口假设若与核查报告冲突，以核查报告为准。

## MVP 范围（v0.1）

- **存储与检索全部本地执行**，不引入新的云服务、账号或 API key。
- **不使用 embedding / 向量库 / 重排模型**：采用中文字符 n-gram 词项加本地 BM25 检索，保留英文单词、型号与编号。界面明确标注「关键词检索」。
- **格式**：新建文本、TXT、Markdown、文本型 PDF、PNG/JPG（本地中英 OCR）。
- **回答**：复用 dsh 当前会话模型，联网复用其现有 web 提供方；未命中时给出固定提示，并按权限条件回退。
- **功能**：独立设置页、库增删改名、资料增删与文本编辑、对话开关、单库/全部选择、自动检索、未命中提示与条件联网。
- **必要增强**：来源引用与详情、入库状态/重试/取消、同库重复检测、检索测试、会话选择持久化、软删除与恢复、基础备份导出与恢复。

**后置**：DOCX、扫描 PDF 整本 OCR、表格/演示解析、语义向量与重排、视觉图表理解、自选多个库、目录同步、团队与云同步。

## 开发阶段

| 阶段 | 内容 | 状态 |
|---|---|---|
| 阶段 0 | 0.2.0-rc.2 桌面兼容性验证（先于业务开发） | 三条主线通过；余项：停用清理、带工具调用的多 step 场景 |
| 阶段 1 | 知识库管理与文本问答闭环 | **已完成**：检索内核、存储入库、设置页 UI、对话开关与选库、来源面板与状态徽标、资料阅读器（右栏读原文并高亮命中段）、重复检测、软删除与恢复、备份导出/恢复，全部在真实宿主上自动验证通过 |
| 阶段 2 | 完成 v0.1 MVP 全部范围（PDF、图片 OCR、检索测试面板增强） | **已完成（2026-10-14）**：文本型 PDF 解析（保留页码定位，加密/超页/无文字层都有明确提示）、图片 OCR（PNG/JPG **本地中英 OCR、零云调用**；设置页检测 / 下载 / 进度 / 取消，缺资源就地提示）、检索测试面板增强（范围可选 + score/覆盖）均已在隔离宿主实跑通过（OCR 由 `scripts/probe-ocr.mjs` 31 项覆盖）。**发布级阻断已根治（2026-10-15）**：OCR 引擎改为编进产物、不再作为 npm 依赖发布，新建 profile 首装不再报 `ERR_PNPM_IGNORED_BUILDS`（历史见 HANDOFF 坑 65 与第 16 节 v17） |
| 阶段 3 | 可靠性与发行 | 未开始 |
| 阶段 4 | 按用户选择增强（向量、DOCX、自选多库等） | 未开始 |

阶段 1 之后紧接着的是**页面美化**（等用户给出要求）与**多库勾选**。

## 使用（当前形态）

主要界面在**设置 → 知识库**：建库/改名/描述、加文本或文件、编辑正文并重建索引、查看实际索引内容、回收站与恢复、数据备份导出与导入。

对话区：输入框旁的「知识库」开关与选库弹层（关闭 / 单库 / 全部，按会话记忆）。开启后提问，回答下方出现「N 知识库来源」按钮，点开是带编号的片段与出处；每条片段可「在右栏打开」，在宿主右侧栏读该资料全文并高亮命中的那一段。未命中等情形由插件给出固定文案徽标。

库管理也可以用宿主命令完成：

```
/kb list
/kb create <名称>
/kb rename <旧名> :: <新名>
/kb delete <名称>
/kb add <库名> :: <标题> :: <正文>
/kb rm <标题>
/kb use <库名|全部|关闭>     # 设置本会话的检索范围
/kb search <问题>            # 检索测试，不调用模型
```

新会话默认关闭知识库（与方案一致）。

## 关键约束

以下均已在目标宿主上实测确证，详见[阶段 0 核查报告](outputs/阶段0-兼容性核查报告.md)。

- 优先通过 dsh 官方 slots、Remote 与 Agent 接口接入，**不修改宿主核心、不通过 DOM 注入绕过接口**。
- 目标版本**没有** `systemPrompt.refreshContext`，`PromptContext` 也**没有** `required` 字段；不得沿用 master 新版刷新设计。
- 上下文注入走 `agent/pre-step` waterfall，**已在真实宿主上端到端验证**：订阅用 `ctx.on(name, listener)`，监听器签名 `(payload, next) => Promise<PreStepDecision>`，把插件来源的证据消息追加到 `next()` 返回的决策里。装配顺序是 `systemPrompt.assemble()` → `agent/pre-step`，因此**不依赖 prompt 装配时机**。
- `next()` 必须永远 await 并尊重其结果：**`reject` 要原样透传**，覆盖别人的否决等于悄悄重启一个已被停掉的步骤。
- **Client↔Host 的业务通道是自己接的类型化 Remote**：官方生成器 `dsh-typert-generator` 对独立插件不可用（要求贡献包在 `<根>/packages/`、且把 `dsh-typert-protocol` vendored 进仓库），但**产物本质只是 `zod schema + InvocationDescriptor[]`，全是公开协议类型**，所以手写即可（`src/client/contribution.ts`，方法清单单一事实来源在 `src/remote-methods.ts`）。不能用 `@Remote` 装饰器——tsdown/rolldown 不降级 stage-3 装饰器；改用直接写原型描述符，**`version: 1` 必须有**。
- **浏览器半边只提供宿主模块表里已有的包**：非宿主提供的依赖必须内联（`zod`），且不能用自动 JSX 运行时（`jsx: "react"`）。`scripts/verify-bundles.mjs` 会扫描客户端产物的 `require(...)` 来兜住这条。
- **`inject` 里写不存在的服务名会让插件永久 pending 且无任何报错**。只列已在目标宿主上确认存在的服务。
- **联网能力必须做可选依赖**（`ctx.inject(['web'], ...)`）：静态依赖会在无 provider 时 park 整个插件。
- **desktop profile 被 Electron 应用独占**，CLI 无法驱动；开发迭代用独立 profile，最终在应用内确认。

## 目录结构

```text
.
├── .github/workflows/ # CI 流水线
├── outputs/           # 方案、核查报告与设计文档
├── scripts/           # 构建与验证脚本
├── src/
│   ├── client/        # Client 半边（浏览器）
│   ├── core/          # 与宿主无关的领域逻辑：切分、BM25、词项化、服务
│   ├── commands.ts    # /kb 命令界面
│   ├── index.ts       # Host 半边入口与接线
│   ├── pre-step.ts    # agent/pre-step 检索接缝
│   ├── source.ts      # 插件专属消息来源声明
│   └── store.ts       # storageDomain 持久化
├── tests/             # 单元测试
├── cordis.patch.yml   # 作为 bundle 发布时的装配层
├── dev.patch.yml      # 本地 --patch 开发叠加层
├── tsdown.config.ts   # Host ESM + Client lazy-CJS 双产物
├── tsconfig.json
├── .workbuddy-ai/     # 本地助手工作数据（已 gitignore）
├── .dshdev/           # 隔离的 DSH 开发环境（已 gitignore）
├── .gitattributes     # 行尾统一为 LF
└── README.md
```

## 本地开发

构建产物需要能被宿主解析，所以开发时把包装进一个**独立的开发 profile**，不要碰 `desktop`：

```bash
pnpm install
pnpm typecheck && pnpm build && pnpm verify

# 用隔离的 DSH_HOME，避免污染 ~/.dsh
export DSH_HOME=$PWD/.dshdev
dsh --profile kbdev --from-default-profile web
dsh plugin --profile kbdev add ./domitor-syh-dsh-knowbase-0.1.0.tgz

dsh --profile kbdev --no-open --port 3101
```

`dsh plugin add` 会自动把包写进该 profile 的 `dsh.profile.bundles`，之后无需 `--patch`。

## 持续集成

`.github/workflows/ci.yml` 在推送到 `main` 与 PR 时运行，包含三个任务：

| 任务 | 内容 |
|---|---|
| 检测项目状态 | 判断是否已初始化 `package.json`，未初始化则跳过 Node 校验 |
| 文档检查 | Markdown 必须为合法 UTF-8，站内相对链接必须指向真实存在的路径 |
| 构建与测试 | Node 24 + pnpm，依次执行 `lint` / `typecheck` / `test` / `build` / `verify`（`--if-present`） |

Node 版本取 **24**，对齐目标宿主 `runtime.json` 自报的 `node 24.21.0`。

`verify` 跑 `scripts/verify-bundles.mjs`：`tsc` 证明源码符合类型契约、`tsdown` 证明能打包，但两者都不证明**产物符合宿主运行时约定**——该脚本校验两个产物以宿主的方式加载、导出正确，并确认 `react` 与 `@deepseek-ai/*` 没有被打进产物（"第二套 React"的防线）。

最后汇总为一个名为 `CI` 的稳定检查项，便于在分支保护中只勾选这一条。

## 官方来源

- 官方主页：https://www.deepseek.com/harness/
- 官方仓库：https://github.com/deepseek-ai/deepseek-harness
- 版本与运行要求：https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/package.json

## License

[MIT](LICENSE) © 2026 domitor
