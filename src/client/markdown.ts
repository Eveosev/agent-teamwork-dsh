/** Lightweight parser for the Markdown subset used in reports and questions, plus plain-text URL linkification; never interprets raw HTML. */

export type Align = 'left' | 'center' | 'right'
export type Inline = { kind: 'text' | 'bold' | 'code'; text: string } | { kind: 'link'; text: string; url: string }
  | { kind: 'local'; text: string; path: string } | { kind: 'image'; alt: string; src: string }
export type Block = { kind: 'heading' | 'paragraph'; text: string } | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'table'; headers: string[]; align: Align[]; rows: string[][] } | { kind: 'code'; language: string; text: string }
  | { kind: 'image'; alt: string; src: string } | { kind: 'rule' }

function shortUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const path = parsed.pathname.length > 24 ? `${parsed.pathname.slice(0, 24)}…` : parsed.pathname
    return `${parsed.host}${path === '/' ? '' : path}`
  } catch (error) { void error /* Not a URL after all; show it as written. */; return url }
}
/** Splits plain text into text and bare-URL link nodes, excluding trailing sentence punctuation from URLs. */
export function linkify(text: string): Inline[] {
  return text.split(/(https?:\/\/[^\s)，。]*[^\s)，。.,;:!?'"])/).filter(Boolean).map((part): Inline => /^https?:\/\//.test(part)
    ? { kind: 'link', text: shortUrl(part), url: part } : { kind: 'text', text: part })
}
export function inlines(text: string): Inline[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`|!\[[^\]]*\]\([^)\s]+\)|\[[^\]]+\]\([^)\s]+\))/).flatMap((part): Inline[] => {
    if (/^\*\*[^*]+\*\*$/.test(part)) return [{ kind: 'bold', text: part.slice(2, -2) }]
    if (/^`[^`]+`$/.test(part)) return [{ kind: 'code', text: part.slice(1, -1) }]
    const image = /^!\[([^\]]*)\]\(([^)\s]+)\)$/.exec(part)
    if (image) return [{ kind: 'image', alt: image[1]!, src: image[2]! }]
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part)
    if (link) {
      const target = link[2]!
      // Local files (absolute or relative to the Team directory) are opened through the authenticated file route.
      if (target.startsWith('/') || target.startsWith('file://')
        || /^(?:\.{0,2}\/)?[^:]+?\.(?:md|markdown|txt|json|ya?ml|toml|tsx?|jsx?|py|css|html|sh|log|png|jpe?g|webp|gif|avif)(?:#.*)?$/i.test(target))
        return [{ kind: 'local', text: link[1]!, path: target }]
      return /^https?:\/\//.test(target) ? [{ kind: 'link', text: link[1]!, url: target }] : [{ kind: 'text', text: part }]
    }
    return linkify(part)
  })
}
/** Split a pipe-table row, dropping the optional outer bars and unescaping `\|`. */
function tableCells(line: string): string[] {
  let text = line.trim()
  if (text.startsWith('|')) text = text.slice(1)
  if (text.endsWith('|')) text = text.slice(0, -1)
  return text.split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'))
}
/** Read a `|---|:---:|` alignment row, or undefined when the line is not one. */
function tableAlign(line: string): Align[] | undefined {
  if (!line.includes('|')) return undefined
  const cells = tableCells(line)
  if (!cells.length || cells.some(cell => !/^:?-{1,}:?$/.test(cell))) return undefined
  return cells.map(cell => cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : 'left')
}
export function markdownBlocks(text: string): Block[] {
  const blocks: Block[] = []
  const lines = text.split('\n')
  let list: Extract<Block, { kind: 'list' }> | undefined
  let index = 0
  while (index < lines.length) {
    const line = lines[index]!
    const fence = /^\s*(?:```+|~~~+)\s*([^\s`]*)\s*$/.exec(line)
    if (fence) {
      const code: string[] = []
      const language = fence[1] ?? ''
      index += 1
      while (index < lines.length && !/^\s*(?:```+|~~~+)\s*$/.test(lines[index]!)) code.push(lines[index++]!)
      if (index < lines.length) index += 1
      blocks.push({ kind: 'code', language, text: code.join('\n') })
      list = undefined
      continue
    }
    if (!line.trim()) {
      list = undefined
      index += 1
      continue
    }
    const align = index + 1 < lines.length ? tableAlign(lines[index + 1]!) : undefined
    if (align && line.includes('|')) {
      const headers = tableCells(line)
      const rows: string[][] = []
      index += 2
      while (index < lines.length && lines[index]!.trim() && lines[index]!.includes('|')) {
        const cells = tableCells(lines[index]!)
        rows.push(headers.map((_, at) => cells[at] ?? ''))
        index += 1
      }
      blocks.push({ kind: 'table', headers, align, rows })
      list = undefined
      continue
    }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ kind: 'rule' })
      list = undefined
      index += 1
      continue
    }
    const item = /^\s*[-*]\s+(.*)$/.exec(line) ?? /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (item) {
      const ordered = !/^\s*[-*]/.test(line)
      if (!list || list.ordered !== ordered) blocks.push(list = { kind: 'list', ordered, items: [] })
      list.items.push(item[1]!)
      index += 1
      continue
    }
    list = undefined
    const image = /^\s*!\[([^\]]*)\]\(\s*(\S+?)\s*\)\s*$/.exec(line)
    if (image) {
      blocks.push({ kind: 'image', alt: image[1]!, src: image[2]! })
      index += 1
      continue
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line)
    blocks.push(heading ? { kind: 'heading', text: heading[1]! } : { kind: 'paragraph', text: line })
    index += 1
  }
  return blocks
}
