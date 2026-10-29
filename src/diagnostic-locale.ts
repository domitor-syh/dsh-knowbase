/** Pure translations shared by Host commands and reactive Client UI. */
export type DiagnosticLanguage = 'zh' | 'en'

/** Translate only plugin-generated position syntax; document headings stay verbatim. */
export function localizePosition(value: string, language: DiagnosticLanguage): string {
  if (language !== 'en') return value
  const line = value.match(/^第 (\d+(?:-\d+)?) 行$/)
  if (line) return `Line${line[1]?.includes('-') ? 's' : ''} ${line[1]}`
  const page = value.match(/^第 (\d+) 页(?: · (第 \d+(?:-\d+)? 行))?$/)
  if (page) return `Page ${page[1]}${page[2] ? ` · ${localizePosition(page[2], language)}` : ''}`
  const passage = value.match(/^第 (\d+) 段$/)
  return passage ? `Passage ${passage[1]}` : value
}

const messages: Readonly<Record<string, string>> = {
  '知识库操作失败': 'Knowledge base operation failed',
  '知识库通道尚未就绪，请稍候重试。': 'The knowledge base connection is not ready. Please try again shortly.',
  '知识库通道尚未就绪，请稍后重试。': 'The knowledge base connection is not ready. Please try again shortly.',
  '知识库通道尚未就绪。': 'The knowledge base connection is not ready.',
  '已挂载 Remote 贡献，但 remote.knowbase 服务未出现（等待 5 秒超时）。': 'The Remote contribution mounted, but remote.knowbase did not become available within 5 seconds.',
  '资料阅读器尚未就绪，请稍后重试。': 'The material reader is not ready. Please try again shortly.',
  '提案操作失败。': 'Proposal operation failed.',
  '文件已不存在，或它太大，无法在这里预览。': 'The file no longer exists or is too large to preview here.',
  '这个标签页没有指向任何文件。': 'This tab does not point to a file.',
  '知识库名称不能为空。': 'The knowledge base name cannot be empty.',
  '知识库不存在。': 'The knowledge base does not exist.',
  '该知识库已不存在。': 'This knowledge base no longer exists.',
  '未提取到可检索文字。': 'No searchable text was extracted.',
  '未提取到可检索文字，文件可能为空或只含空白。': 'No searchable text was extracted. The file may be empty or contain only whitespace.',
  '文件不是有效的 UTF-8 文本，请转换编码后重扫。': 'The file is not valid UTF-8 text. Convert its encoding and rescan.',
  '文件包含二进制或不支持的控制字符，未作为文本解析。': 'The file contains binary data or unsupported control characters and was not parsed as text.',
  '文件无法读取，可能已被其他程序占用或删除。': 'The file could not be read. Another program may be using it, or it may have been deleted.',
  '图片里没有识别出文字。': 'No text was recognized in the image.',
  'PDF 解析失败，未能提取文字。': 'PDF parsing failed. No text could be extracted.',
  'PDF 已加密，先去掉密码再导入。': 'The PDF is encrypted. Remove its password before importing it.',
  'PDF 已加密，需要密码才能提取文字。': 'The PDF is encrypted. A password is required to extract text.',
  '这不是可解析的 PDF，可能已损坏或并非 PDF。': 'This file cannot be parsed as a PDF. It may be damaged or use another format.',
  '文件不是可解析的 PDF，可能已损坏或并非 PDF。': 'This file cannot be parsed as a PDF. It may be damaged or use another format.',
  'PDF 解析已取消。': 'PDF parsing was cancelled.',
  'PDF 解析超时，已放弃这一份文件。': 'PDF parsing timed out. This file was skipped.',
  'PDF 解析进程提前退出。': 'The PDF parsing process exited early.',
  '图片文字识别失败，未能提取文字。': 'Image text recognition failed. No text could be extracted.',
  '图片文字识别已取消。': 'Image text recognition was cancelled.',
  '图片文字识别超时，已放弃这一份文件。': 'Image text recognition timed out. This file was skipped.',
  '图片文字识别进程提前退出。': 'The image text recognition process exited early.',
  '图片文字识别需要 OCR 语言包（约 4.5 MB）：在上方「图片文字识别」里点「下载语言包」，下载后重扫即可检索。': 'Image text recognition requires OCR language packs (about 4.5 MB). Click “Download language packs” under “Image text recognition”, then rescan to make images searchable.',
  '响应没有内容': 'The response has no body',
  '压缩包过大，已放弃': 'The archive is too large and was rejected',
  '下载到的不是有效的 gzip 数据': 'The download is not valid gzip data',
  '已取消': 'Cancelled',
  '连接超时': 'Connection timed out',
  '已取消下载，本次下载的文件已删除。': 'Download cancelled. Files from this download were removed.',
  '语言包已就绪，无需下载。': 'Language packs are ready. No download is needed.',
  '语言包已下载完成。': 'Language packs downloaded.',
  '文件内容不是合法的 base64。': 'The file content is not valid base64.',
  '文件过大，无法通过浏览器上传。请把它直接放进该知识库的文件夹。': 'The file is too large to upload through the browser. Place it directly in the knowledge base folder.',
  '目标文件已存在，提案不会覆盖原资料。': 'The target file already exists. The proposal will not overwrite it.',
  '目标文件已存在，提案未覆盖原资料。': 'The target file already exists. The proposal did not overwrite it.',
  '该提案已经结束，不能重复拒绝。': 'This proposal has already been resolved and cannot be rejected again.',
  '该提案已经结束，不能重复批准。': 'This proposal has already been resolved and cannot be approved again.',
  '提案已过期，请重新生成。': 'This proposal has expired. Generate a new one.',
  '知识库在提案后发生变化，请重新生成提案。': 'The knowledge base has changed since this proposal was created. Generate a new proposal.',
  '写入未完成，知识库未确认应用。': 'The write did not complete. The knowledge base has not confirmed the change.',
  '提案不存在或不属于当前会话。': 'The proposal does not exist or does not belong to this session.',
  '知识库仍在初始化。': 'The knowledge base is still initializing.',
  '当前会话的知识库已关闭，请由用户开启。': 'Knowledge bases are disabled for this session. Ask the user to enable them.',
  '当前会话没有勾选知识库。': 'No knowledge bases are selected for this session.',
  '尚无知识库。': 'There are no knowledge bases yet.',
  '该知识库不在当前会话可写入范围内。': 'This knowledge base is outside the writable scope of this session.',
  '文件名必须是安全的单层文本文件名，并使用已知 UTF-8 文本扩展名。': 'Use a safe filename without directories and a supported UTF-8 text extension.',
  '文件名必须是安全的单层文本文件名。': 'Use a safe filename without directories.',
  '文本不能为空且不能超过 64 KiB。': 'Text must be non-empty and no larger than 64 KiB.',
  '文本必须是有效且可索引的 UTF-8 内容。': 'Text must be valid, indexable UTF-8 content.',
  '新文件未出现在提交后的扫描结果中。': 'The new file did not appear in the scan after the write.',
  '写入失败且自动回滚失败，请先停止继续写入并检查回收站。': 'The write and automatic rollback both failed. Stop writing and check the recycle folder.',
  '统计服务尚未就绪。': 'The statistics service is not ready.',
  '统计分页参数不合法。': 'Invalid statistics pagination parameters.',
  '统计开关参数不合法。': 'Invalid statistics recording setting.',
  '统计存储尚未就绪。': 'Statistics storage is not ready.',
  '统计设置未保存，请重试。': 'Statistics settings were not saved. Please try again.',
  '文件资源管理器': 'File Explorer', '访达': 'Finder', '文件管理器': 'File Manager',
}

/** Localize known diagnostics only. Never run on names, paths, or document text. */
export function localizeDiagnostic(message: string, language: DiagnosticLanguage): string {
  if (language !== 'en') return message
  const exact = messages[message]
  if (exact !== undefined) return exact
  let match: RegExpMatchArray | null
  if ((match = message.match(/^已存在名为「(.*)」的知识库。$/s))) return `A knowledge base named “${match[1]}” already exists.`
  if ((match = message.match(/^文件超过 (.+)，未(解析|识别)。(请拆分后再导入。)?$/))) return `The file exceeds ${match[1]} and was not ${match[2] === '解析' ? 'parsed' : 'recognized'}.${match[3] ? ' Split it before importing.' : ''}`
  if ((match = message.match(/^PDF 有 (\d+) 页，超过 (\d+) 页上限。$/))) return `The PDF has ${match[1]} pages, exceeding the ${match[2]}-page limit.`
  if ((match = message.match(/^PDF 里没有可提取的文字（共 (\d+) 页，可能是扫描件）。把需要的页面转成图片再导入即可；本版不做整本扫描件 OCR。$/))) return `No extractable text was found in this ${match[1]}-page PDF. It may be scanned. Import the pages you need as images; full scanned-PDF OCR is not supported.`
  if ((match = message.match(/^OCR 语言包（(.+)）尚未下载。(.*)$/s))) return `OCR language packs (${match[1]?.replaceAll('、', ', ')}) have not been downloaded.${match[2] ? ` ${localizeDiagnostic(match[2], language)}` : ''}`
  if ((match = message.match(/^下载 (.+) 语言包失败：(.*)。请检查网络后重试。$/s))) return `Failed to download the ${match[1]} language pack: ${localizeDiagnostic(match[2] ?? '', language)}. Check your connection and try again.`
  if ((match = message.match(/^(下载失败|PDF 解析失败|PDF 解析出错|图片文字识别失败|图片文字识别出错)：(.*)$/s))) {
    const prefix: Record<string, string> = { '下载失败': 'Download failed', 'PDF 解析失败': 'PDF parsing failed', 'PDF 解析出错': 'PDF parsing error', '图片文字识别失败': 'Image text recognition failed', '图片文字识别出错': 'Image text recognition error' }
    return `${prefix[match[1] ?? '']}: ${localizeDiagnostic(match[2] ?? '', language)}`
  }
  if ((match = message.match(/^这台机器上没有可用的(.+)。$/))) return `${localizeDiagnostic(match[1] ?? '', language)} is unavailable on this machine.`
  if ((match = message.match(/^没能打开(.+)：(.*)$/s))) return `Could not open ${localizeDiagnostic(match[1] ?? '', language)}: ${localizeDiagnostic(match[2] ?? '', language)}`
  if ((match = message.match(/^资料阅读器未能在 (\d+) 秒内就绪：宿主没有提供右侧栏服务（sidebarRight）。$/))) return `The material reader was not ready within ${match[1]} seconds: the host did not provide sidebarRight.`
  if ((match = message.match(/^不是知识库资料地址：(.*)$/s))) return `Not a knowledge base material address: ${match[1]}`
  if ((match = message.match(/^(知识库根目录不是目录|知识库路径已存在且不是目录|拒绝访问知识库真实根目录之外的路径|拒绝访问知识库根目录之外的路径)：(.*)$/s))) return `${match[1]?.startsWith('拒绝') ? 'Access outside the knowledge base root was denied' : 'The knowledge base path is not a directory'}: ${match[2]}`
  return message
}
