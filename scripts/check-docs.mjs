import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const blank = text => text.replace(/[^\n]/g, ' ')

/** Ignore fenced examples and inline code while retaining source line positions. */
function prose(source) {
  let fence
  const lines = source.split('\n').map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && marker[2].trim() === '') fence = undefined
      return blank(line)
    }
    if (marker) { fence = marker[1]; return blank(line) }
    return line
  }).join('\n')
  return lines.replace(/(`+)([^]*?)\1(?!`)/g, blank)
}

/** Inline file destinations, including CommonMark angle brackets and link titles. */
export function destinations(source) {
  return [...prose(source).matchAll(/\]\(\s*(?:<([^>\n]*)>|((?:\\.|[^()\s]|\([^()\n]*\))+))(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^\n]*?\)))?[ \t]*\)/g)]
    .map(match => ({ destination: match[1] ?? match[2], line: source.slice(0, match.index).split('\n').length }))
}

/** Validate the clean-checkout file set, not ignored local build artifacts. */
export function checkDocuments(root, trackedFiles) {
  const tracked = new Set(trackedFiles)
  const documents = trackedFiles.filter(file => file.endsWith('.md'))
  const errors = []
  let links = 0
  for (const file of documents) {
    let source
    try { source = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(resolve(root, file))) }
    catch { errors.push({ file, line: 1, message: '文件不可读或不是合法的 UTF-8 编码' }); continue }
    for (const { destination, line } of destinations(source)) {
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(destination)) continue
      let target
      try { target = decodeURIComponent(destination.split(/[?#]/, 1)[0]).replace(/\\([\\()[\]<>])/g, '$1') }
      catch { errors.push({ file, line, message: `链接编码无效：${destination}` }); continue }
      if (target === '') continue
      links++
      const absolute = resolve(root, dirname(file), target)
      const key = relative(root, absolute).split(sep).join('/')
      const outside = isAbsolute(key) || key === '..' || key.startsWith('../')
      const versioned = tracked.has(key) || trackedFiles.some(entry => entry.startsWith(key === '' ? '' : `${key}/`))
      if (outside || !versioned || !existsSync(absolute)) {
        errors.push({ file, line, message: `链接未指向版本库中的现存路径：${destination}` })
      }
    }
  }
  return { documents: documents.length, links, errors }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean)
    const result = checkDocuments(process.cwd(), tracked)
    for (const error of result.errors) console.error(`${error.file}:${error.line}: ${error.message}`)
    console.log(`Checked ${result.documents} Markdown files and ${result.links} local links; ${result.errors.length} errors.`)
    process.exitCode = result.errors.length === 0 ? 0 : 1
  } catch (error) {
    console.error(`Documentation check failed: ${error.message}`)
    process.exitCode = 1
  }
}
