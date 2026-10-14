/**
 * A hand-built PDF, for tests that need a real one and not a 5 MB sample.
 *
 * The plugin's own code never writes PDFs, so this is the only place in the repo
 * that has to know the format: one object per page plus a content stream, an
 * `xref` table whose offsets are computed rather than guessed, and a `trailer`.
 * Offsets are computed because a wrong `xref` is a broken file that pdfjs
 * *might* repair through its recovery scan — which would make the tests pass
 * for the wrong reason, or fail intermittently, depending on the parser's mood.
 *
 * Built and packed as bytes rather than as a string because a test's PDF has to
 * be exactly the bytes a user's file would be: `latin1` keeps every character
 * one byte, so the offsets above stay meaningful.
 *
 * @module tests/fixtures/pdf
 */

/**
 * Build a PDF with one page per entry of `pages`.
 *
 * @param pages - page text, Latin-1 only (the fixture needs no CJK font).
 * @returns the file's bytes.
 */
export function buildPdf(pages: readonly string[]): Uint8Array {
  const pageIds = pages.map((_, index) => 4 + index * 2)
  const contentIds = pages.map((_, index) => 5 + index * 2)

  const objects: { id: number; body: string }[] = [
    { id: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
    {
      id: 2,
      body:
        `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] ` +
        `/Count ${pages.length} >>`,
    },
    { id: 3, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' },
  ]

  pages.forEach((text, index) => {
    objects.push({
      id: pageIds[index]!,
      body:
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentIds[index]} 0 R >>`,
    })
    // `(` and `)` in text would end the PDF string early, so escape them the way
    // the format requires; nothing here needs a wider escape table.
    const stream = `BT /F1 24 Tf 72 700 Td (${text.replace(/([\\()])/g, '\\$1')}) Tj ET\n`
    objects.push({
      id: contentIds[index]!,
      body: `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
    })
  })

  let out = '%PDF-1.4\n'
  const offsets = new Map<number, number>()
  for (const object of objects) {
    offsets.set(object.id, out.length)
    out += `${object.id} 0 obj\n${object.body}\nendobj\n`
  }

  const size = objects.length + 1
  const xrefStart = out.length
  out += `xref\n0 ${size}\n0000000000 65535 f \n`
  for (let id = 1; id < size; id += 1) {
    out += `${String(offsets.get(id) ?? 0).padStart(10, '0')} 00000 n \n`
  }
  out += `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`

  const bytes = new Uint8Array(out.length)
  for (let index = 0; index < out.length; index += 1) bytes[index] = out.charCodeAt(index) & 0xff
  return bytes
}
