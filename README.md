# dsh-knowbase

[![CI](https://github.com/domitor-syh/dsh-knowbase/actions/workflows/ci.yml/badge.svg)](https://github.com/domitor-syh/dsh-knowbase/actions/workflows/ci.yml)

> dsh 知识库插件：资料留在本机、检索在本机执行、回答带出处
> A native, local-first knowledge base plugin for DeepSeek Harness

面向 **DeepSeek Harness（dsh）** 的原生知识库插件。在 dsh 内提供完整的「资料入库 → 自动检索 → 引用回答」闭环：**不依赖外部知识库服务、不调用云端模型、不修改宿主核心**。

- 目标宿主：Windows 桌面版 **dsh 0.2.0-rc.2**（官方标签 `dsh-v0.2.0-rc.2`），`dsh.engines` 声明 `>=0.2.0-rc.2 <0.3.0-0`；**0.2.1-rc.2 上已实测通过**。从 0.2.1 起宿主优先按 `engines.dsh` 判定插件兼容性，比较时**包含预发布版本**（`semver.satisfies(..., { includePrerelease: true })`），所以 `0.2.1-rc.2` 落在该范围内，而 `0.3.0-rc.1` 不会。
- 当前版本：**0.1.0**（MVP 范围已全部实现，发布前五项验收通过）。
- 技术路线：dsh 原生 Host + Client 插件（TypeScript）+ 本地检索引擎。

---

## 它做什么

### 入库：库就是一个文件夹

**库 = `$DSH_HOME/knowbase/` 下的一个文件夹**，库里的文件就是库内容。

- 在知识库页面「上传文件…」，或**直接用资源管理器把文件丢进库文件夹**，再点「重扫」——外部丢入的文件会被采纳。
- 外部**改名**会被跟随、外部**删除**会被丢弃。磁盘是资料的唯一真相。
- 删除资料 = 把它**移进 `<库根>/_回收站/`**，不销毁。想恢复就在资源管理器里拖回去（插件不提供回收站面板，这是刻意的）。
- 同名文件自动编号（`说明书 (2).pdf`），两份都保住。

支持格式与上限：

| 格式 | 处理方式 | 上限 |
|---|---|---|
| TXT / Markdown | 直接切分索引 | 2 MB |
| 文本型 PDF | worker 线程抽取文字，**页码写进引用定位** | 20 MB、100 页 |
| PNG / JPG | **本地中英 OCR**（Tesseract，零云调用） | 20 MB |
| 其它格式 | 列表里如实标注「不可检索」并给出原因 | — |

加密 PDF、扫描件（无文字层）、超页、超大文件各有独立文案，不会静默失败。库文件夹递归扫描上限 8 层。

### 检索：中文 n-gram + BM25，不走向量

- **不使用 embedding / 向量库 / 重排模型**，因此不需要 API key、不需要联网、也没有索引重建的等待。
- 中文按字符 n-gram 建索引；**含数字的词整词 + n-gram 双写**（`6353` 这种编号按任意片段都能回忆起来）；纯拉丁词只做整词匹配（`port` 不会命中 `ports`）。
- **资料标题进索引**，库名不进（否则该库每条片段都会命中库名）。
- 排序与机器无关：`src/core/order.ts` 用 `Intl.Collator('zh-Hans-CN')` 钉死拼音序，判等退码位；CI 有一条「模拟非中文机器」的测试配置守这条。

### 对话：模型请求前注入证据，回答带出处

- 输入区有「知识库」药丸按钮 + 选库弹层（搜索框、每库一个开关、页脚「全部开启 · 全部关闭」与开启计数）。**开关本身就是「是否使用」**——一个都没开就不使用知识库，按钮不显蓝色。
- 选择**按会话持久化**，宿主重启后保留。
- 命中后，回答操作条出现「N 知识库来源」按钮；点开是带编号的片段与出处，每条可「在右栏打开」，在宿主右侧栏读该资料全文并高亮命中那一段。
- 没命中时给固定文案徽标，区分五种情形：**未命中 / 空库 / 未勾选 / 库失效 / 检索失败**。检索失败会说明原因，而不是编一个答案。

### 知识库页面：侧栏图标 + 中央列独立页面

与「插件管理」「定时任务」并列在侧栏。页面里可以：建库 / 改名 / 描述 / 删库；上传文件、查看索引片段、重扫全部；「从文件资源管理器打开」库文件夹；OCR 区块的**检测 / 下载语言包 / 进度 / 取消**；以及一个**检索测试面板**（范围可选、命中显示 score 与覆盖率，不调用模型）。

页面跟随应用明暗主题。

---

## 安装

```bash
# 打包（在仓库根目录）
pnpm install
pnpm build
pnpm pack            # 产出 domitor-syh-dsh-knowbase-0.1.0.tgz
```

```bash
# 装进一个 dsh profile
dsh plugin --profile <profile> add /绝对路径/domitor-syh-dsh-knowbase-0.1.0.tgz
```

三个容易踩的点：

1. **`dsh plugin add` 的 tarball 必须给绝对路径。** 裸相对名会被当成 npm 包名去 registry 找，报 404。
2. **想装进隔离环境就先设 `DSH_HOME`。** 漏了它，命令会「在别处成功」——报 `Done` 但目标目录什么都不长，实际装到了真实的 `~/.dsh`。
3. **同版本 tarball 需要先删安装副本。** pnpm 会按 lockfile 里的旧 integrity 静默复用，症状是「源码改了、包也装了、页面行为没变」。先删 `<profile>/node_modules` 与 `pnpm-lock.yaml` 再 `add`。

**OCR 引擎已编进产物**（`lib/ocr-runtime.cjs` + `lib/ocr-worker.cjs` + 3 个 wasm），`tesseract.js` 不是发布依赖 ⇒ **全新 profile 首装零手工步骤**，不需要 `allowBuilds`。

**OCR 语言包首次使用时下载**（中英共约 4.5 MB），也可以提前在知识库页面的「图片文字识别」里点「下载语言包」。检测只做两次 `stat`、不联网；下载可取消，取消会删掉本次已落盘的文件。**资源到位后识别全程零网络请求。**

---

## 使用

1. 点侧栏的「知识库」图标，新建一个库。
2. 上传文件（或把文件丢进库文件夹后点「重扫」）。
3. 回到对话，点输入区的「知识库」药丸，打开要用到的库。
4. 提问。回答下方出现「N 知识库来源」，点开可核对出处、在右栏读原文。

命令行也能管理库（`/kb` 系列，用户后续可能移除）：

```
/kb help
/kb list                                   # 列出知识库与文件数
/kb files <库名>                            # 列出库内的文件
/kb create <名称>                           # 新建知识库（同时建好它的文件夹）
/kb rename <旧名> :: <新名>                  # 重命名（文件夹一起改名）
/kb delete <名称>                           # 删除知识库（文件夹移入 _回收站，不销毁）
/kb rm <库名> :: <文件名>                     # 删除文件（移入 _回收站，不销毁）
/kb rescan [库名]                           # 重新扫描磁盘（在资源管理器里丢进文件后用它）
/kb use <库名[,库名]|全部|关闭>               # 设置本会话的检索范围
/kb search <问题>                           # 检索测试（不调用模型）
/kb root                                    # 显示知识库根目录（文件实际存放的位置）
```

---

## 数据在哪，边界在哪

| 内容 | 位置 |
|---|---|
| 库记录、会话选择 | `$DSH_HOME/storages/`（宿主 `storageDomain`：`dsh_knowbase` / `dsh_knowbase_sessions`） |
| 资料文件 | `$DSH_HOME/knowbase/<库名>--<库 id>/` |
| 删除的资料 | `$DSH_HOME/knowbase/_回收站/` |
| OCR 语言包 | `$DSH_HOME/knowbase/.ocr/` |

**⚠ 库根目录在 `$DSH_HOME` 下 ⇒ 只在本地宿主有效。** 远程 / 云宿主下该目录不存在或不可写，插件会明确报错而不是静默丢数据。

**库是存储记录，文件夹只是它的物化。** 反过来说：删掉库文件夹不会删库，下次启动会被重建；要删库请走页面上的删除（或 `/kb delete`）。而**库内的资料**以磁盘为准——这条规则只适用于资料，不适用于库本身。

**整个库文件夹拷走就是完整备份。** 没有 JSON 中间层，也没有单独的导出功能——这是文件模型的直接结果。

---

## 设计取舍（有意为之，不是没做）

| 取舍 | 原因 |
|---|---|
| 关键词检索，不走向量 | 本地、零依赖、零联网、改完文件立刻可搜；换来的是不理解同义改写 |
| 不做回收站面板 | 删除即搬家，恢复交给资源管理器；少一套要保持一致的状态 |
| 不做重复检测 | 撞名自动编号即可，两份都保住比「拦住用户」更少摩擦 |
| 阅读器只读 | 它的职责是「看见证据」，多一个写入面就多一条要保持一致的路径 |
| 不切宿主官方预览 | 官方预览对 Markdown 的源码行导航不可用，而引用最常落在 `.md` 上 |
| 不做「检索中」徽标 | 检索发生在模型请求之前，宿主没有把这个瞬间作为可订阅状态暴露出来；假转圈会把「检索」和「生成」混成一段，比不做更误导 |
| 不提供对话区的「管理知识库」快捷入口 | 被宿主 API 挡住：设置面板的开关状态是闭包 store，未作为服务发布 |

---

## 目录结构

```text
.
├── .github/workflows/   # CI 流水线
├── outputs/             # 方案、阶段 0 核查报告、页面功能清单
├── scripts/             # 构建、产物契约校验、真机探针
├── src/
│   ├── client/          # Client 半边（浏览器）
│   │   ├── knowbase-page.tsx    # 独立页面整页
│   │   ├── page-style.ts        # 页面样式表 + 明暗两套 token
│   │   ├── composer-toggle.tsx  # 输入区药丸 + 选库弹层
│   │   ├── ocr-panel.tsx        # OCR 区块
│   │   ├── reader-panel.tsx     # 右栏资料阅读器
│   │   ├── citation-*.tsx       # 来源按钮与浮层
│   │   ├── contribution.ts      # 手写的 Remote 原型描述符
│   │   ├── api.ts               # UI 唯一的 Remote 入口
│   │   ├── icons.tsx / theme.ts / labels.ts / spin.ts
│   ├── core/            # 与宿主无关的领域逻辑
│   │   ├── vault.ts / vault-fs.ts   # 文件式库模型
│   │   ├── service.ts               # 入库、检索、范围解析
│   │   ├── tokenize.ts / bm25.ts / chunk.ts / order.ts
│   │   ├── pdf.ts / ocr.ts / ocr-resources.ts
│   │   ├── session-scope.ts / shell.ts / model.ts
│   ├── index.ts         # Host 半边入口与接线
│   ├── pre-step.ts      # agent/pre-step 检索接缝
│   ├── remote.ts / remote-methods.ts  # 类型化 Remote（清单单一来源）
│   ├── store.ts         # storageDomain 持久化
│   ├── commands.ts      # /kb 命令
│   └── source.ts        # 插件专属消息来源声明
├── tests/               # 单元测试（403 项 / 19 文件）
├── cordis.patch.yml     # 作为 bundle 发布时的装配层
├── dev.patch.yml        # 本地 --patch 开发叠加层
├── scripts/build.mjs    # 构建入口（tsdown 四 target + 拷贝 OCR 引擎）
└── HANDOFF.md           # 开发进度与交接报告（权威文档）
```

---

## 本地开发

```bash
pnpm install
pnpm typecheck                 # 门禁第一条：它拦得住 CSS 模板串里的语法事故
pnpm test                      # 403 项 / 19 文件
pnpm test:ci-locale            # 同上，但把 locale 换成非中文，验证排序与机器无关
pnpm build                     # tsdown 四 target + 拷贝 3 个 wasm 与第三方许可
pnpm verify                    # 产物契约：以宿主方式加载两个产物并检查 require 白名单
```

**沙箱 / CI 之外的本地跑测试**建议直接调入口并关掉文件级并行，否则偶发因临时目录 `EPERM` 少收集测试文件：

```bash
node node_modules/vitest/vitest.mjs run --no-file-parallelism
```

### 在隔离宿主里验证

**永远不要把开发包装进 `desktop` profile**（它被 Electron 应用独占）。用独立的 `DSH_HOME` 与 profile：

```bash
export DSH_HOME=$PWD/.dshdev
dsh --profile kbdev --from-default-profile web
dsh plugin --profile kbdev add /绝对路径/domitor-syh-dsh-knowbase-0.1.0.tgz
dsh --profile kbdev --no-open --port 3111
```

`dsh plugin add` 会自动写进该 profile 的 `dsh.profile.bundles`，之后不需要 `--patch`。

**部署后必须核对哈希**：对比本地 `lib/client.js`、`lib/index.js` 与 `<profile>/node_modules/@domitor-syh/dsh-knowbase/lib/` 下的副本。验收物是**安装副本**，不是 profile 的 `package.json`（那只是声明）。

### 真机探针

探针用 Node 自带的 `fetch` + `WebSocket` 直连 CDP，不依赖额外包。它们会真点按钮、真传文件、真发提问：

| 探针 | 覆盖 |
|---|---|
| `probe-real-usage.mjs` | **端到端真实使用**：五种格式入库 → 提问 → 核对引用与内容准确性 → 「不该命中的说不认识」 |
| `probe-files.mjs` | 知识库页面：建库、上传、删除、重扫、文件夹路径 |
| `probe-multi-select.mjs` | 输入区药丸与选库弹层（含关闭态的首个操作） |
| `probe-status-badge.mjs` | 五种来源状态徽标（自备夹具 + 自清索引） |
| `probe-retrieval-test.mjs` | 检索测试面板：范围切换、score 与覆盖率 |
| `probe-reader.mjs` | 引用 → 右栏阅读器 → 命中段高亮 |
| `probe-ocr.mjs` | OCR：检测不联网、真下载、取消即删、重扫后可检索 |
| `probe-citation.mjs` | 来源按钮与浮层 |

`probe-backup.mjs` 与 `probe-right-panel.mjs` **已过期**（它们验证的能力随文件模型移除 / 是一次性可行性 spike），保留仅作历史参考，不要再当门禁跑。

---

## 持续集成

`.github/workflows/ci.yml` 在推送到 `main`、开 PR 与手动触发时运行：

| 任务 | 内容 |
|---|---|
| 检测项目状态 | 判断是否已初始化 `package.json`，未初始化则跳过 Node 校验 |
| 文档检查 | Markdown 必须是合法 UTF-8；站内相对链接必须指向真实存在的路径 |
| 构建与测试 | Node 24 + pnpm，依次 `lint` / `typecheck` / `test` / `build` / `verify`（均 `--if-present`） |
| CI | 汇总上述结果，作为分支保护里唯一要勾选的稳定检查项 |

Node 版本取 **24**，对齐目标宿主 `runtime.json` 自报的 `node 24.21.0`。

`verify` 跑 `scripts/verify-bundles.mjs`：`tsc` 只证明源码符合类型契约、`tsdown` 只证明能打包，两者都不证明**产物符合宿主运行时约定**。该脚本以宿主的方式加载两个产物并实调 `apply()`、在 stub 的模块表下求值客户端产物、扫描 `require(...)` 白名单（只允许 `react` / `react-dom` / `@deepseek-ai/*`），另外校验 OCR 引擎两半与三个 wasm 都在位且不解析任何 npm 依赖。

---

## 文档

| 文档 | 说明 |
|---|---|
| [HANDOFF.md](HANDOFF.md) | **权威交接文档**：设计决策、逐版本变更、已踩过的坑、部署与验证流程。要改这个项目就先读它 |
| [outputs/知识库页面功能清单.md](outputs/知识库页面功能清单.md) | 页面逐区块的功能清单、可展示字段、必须保留的探针钩子与文案承诺 |
| [outputs/阶段0-兼容性核查报告.md](outputs/阶段0-兼容性核查报告.md) | 目标宿主接口的实测事实（与方案文档冲突时以它为准） |
| [outputs/dsh-knowbase-MVP修订方案-v0.2.md](outputs/dsh-knowbase-MVP修订方案-v0.2.md) | MVP 范围与验收标准（历史方案，部分已被文件模型取代） |

---

## 关键约束（改动前请先读）

以下均在目标宿主上实测确证，细节见 [HANDOFF.md](HANDOFF.md) 第 7 节。

- 只通过 dsh 官方 slots / Remote / Agent 接口接入，**不修改宿主核心、不用 DOM 注入绕过接口**。
- 目标版本**没有** `systemPrompt.refreshContext`，`PromptContext` 也**没有** `required`；上下文注入走 `agent/pre-step` waterfall，把证据消息追加进 `next()` 返回的决策。**`next()` 必须永远 await 并尊重其结果**——覆盖别人的 `reject` 等于悄悄重启一个已被停掉的步骤。
- Client↔Host 的业务通道是**自己接的类型化 Remote**：官方生成器对独立插件不可用，但产物本质只是 `zod schema + InvocationDescriptor[]`，手写即可（`src/client/contribution.ts`）。不能用装饰器；原型描述符里的 **`version: 1` 必须有**。方法清单的唯一来源是 `src/remote-methods.ts`。
- 浏览器半边**只能用宿主模块表里已有的包**：非宿主依赖必须内联（`zod`），且不能用自动 JSX 运行时（`jsx: "react"`）。
- **`inject` 里写不存在的服务名会让插件永久 pending 且零报错。** 只列已在目标宿主上确认存在的服务；可选服务（如 `theme`）必须用 `ctx.inject([...], scope => …)` 动态取。
- `desktop` profile 被 Electron 应用独占，CLI 无法驱动。

---

## 官方来源

- 官方主页：https://www.deepseek.com/harness/
- 官方仓库：https://github.com/deepseek-ai/deepseek-harness
- 版本与运行要求：https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/package.json

## License

[MIT](LICENSE) © 2026 domitor

OCR 引擎来自 [tesseract.js](https://github.com/naptha/tesseract.js)（Apache-2.0），其许可随产物一起分发于 `lib/THIRD-PARTY-LICENSE-tesseract.txt`。
