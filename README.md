<div align="center">

# dsh-knowbase · 本地知识库插件

<img src="./docs/header.png" alt="dsh-knowbase 项目头图" width="100%">

中文 · [English](./README.en.md)

</div>

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）提供本地知识库：把文档加入知识库，在对话中自动检索相关内容，并通过引用查看资料出处。

## 功能

- **本地资料管理**：每个知识库对应一个文件夹，支持上传文件、直接放入文件夹后重扫，以及增量更新索引。
- **多种资料格式**：支持 TXT、Markdown、JSON、CSV、源码等 UTF-8 文本、文本型 PDF，以及 PNG / JPG 图片的本地中英 OCR。
- **自动检索**：使用中文 n-gram 与 BM25，在对话前检索相关片段，为回答提供资料依据。
- **按会话选库**：在输入区选择一个或多个知识库，选择随会话保存。
- **引用与原文阅读**：查看回答使用的来源、复制引用，并在右侧阅读器打开资料、定位对应内容。
- **检索测试与统计**：在知识库页面测试查询效果，在插件详情页按需开启自动检索统计。
- **新资料提案**：Agent 可以提交文本资料提案，由你预览并批准后保存到知识库。
- **中英双语界面**：跟随 DSH 的系统语言和明暗主题。

## 安装

当前适配 **DSH 0.2.1-rc.5**，声明的兼容范围为 `>=0.2.0-rc.2 <0.3.0-0`。

在仓库根目录构建并打包（Node.js 22.19.0 或更高版本）：

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm pack
```

将生成的 `domitor-syh-dsh-knowbase-0.1.0.tgz` 安装到对应的 profile。请将下列路径替换为包文件的绝对路径。

**Web 端**（`dsh web`）：

```sh
dsh plugin --profile web add /absolute/path/domitor-syh-dsh-knowbase-0.1.0.tgz
```

**桌面端**：

```sh
dsh plugin --profile desktop add /absolute/path/domitor-syh-dsh-knowbase-0.1.0.tgz
```

安装后，Web 端重启 `dsh web` 并刷新页面；桌面端重启应用。从 DSH 源码运行时，在安装命令前加 `pnpm`。

## 使用

1. 点击侧栏的「知识库」，选择「添加知识库」，填写名称和描述。
2. 上传资料，或打开知识库文件夹、放入文件后点击「重扫」。
3. 回到对话，点击输入区的「知识库」按钮，开启本次会话要使用的库。
4. 发送问题，插件会检索所选库中的相关片段供模型参考。
5. 点击回答下方的知识库来源按钮，查看引用、复制出处，或在右侧打开原文。

新会话从关闭状态开始，按需选择知识库即可。修改文件夹内的资料后，点击「重扫」更新内容。

### 图片文字识别

在知识库页面的「图片文字识别」区域下载中英语言包，然后重扫图片资料。语言包准备好后，文字识别在本机完成。

### 检索测试

在知识库页面的搜索框输入问题，选择检索范围，即可查看命中的文件、位置和原文片段。展开「检索详情」可查看得分与覆盖率。

### 新资料提案

需要保存新内容时，可以请 Agent 整理成文本资料提案，再在会话输入区预览、批准或拒绝。批准后，资料会保存到对应知识库并可供检索。

### 常用命令

| 命令 | 用途 |
| --- | --- |
| `/kb help` | 查看命令帮助 |
| `/kb list` | 列出知识库与文件数 |
| `/kb create <名称>` | 新建知识库 |
| `/kb files <库名>` | 查看库内文件 |
| `/kb use <库名[,库名]>` | 选择本会话使用的知识库 |
| `/kb use 全部` / `/kb use 关闭` | 开启全部知识库或关闭本会话检索 |
| `/kb search <问题>` | 测试检索效果 |
| `/kb rescan [--force] [库名]` | 重扫资料；`--force` 强制重新解析 |
| `/kb root` | 查看资料根目录 |

## 许可证与致谢

本项目采用 [MIT](./LICENSE) 许可证。

图片文字识别基于 [Tesseract.js](https://github.com/naptha/tesseract.js)，感谢该项目及其贡献者。Tesseract.js 采用 [Apache-2.0](https://github.com/naptha/tesseract.js/blob/v7.0.0/LICENSE.md) 许可证，其许可文本随插件发布包一同分发。

检索算法正在持续优化中……
