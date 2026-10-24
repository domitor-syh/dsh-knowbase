/** Strict local text extraction: no parser, execution, transcoding or replacement characters. */
export class TextReadError extends Error {
  readonly code: 'too-large' | 'invalid-utf8' | 'binary'

  constructor(code: 'too-large' | 'invalid-utf8' | 'binary') {
    super(code)
    this.code = code
    this.name = 'TextReadError'
  }
}

/** Validate bytes before they become searchable text. UTF-8 BOM is accepted and removed. */
export function decodeUtf8Text(bytes: Uint8Array, maxBytes?: number): string {
  if (maxBytes !== undefined && bytes.byteLength > maxBytes) throw new TextReadError('too-large')
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new TextReadError('invalid-utf8')
  }
  // Reject binary/control payloads, including UTF-16 NULs and terminal escape sequences.
  // TAB, LF and CR remain valid whitespace. This is not arbitrary file-type detection:
  // any byte stream composed only of valid printable UTF-8 is indistinguishable from text.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(text)) {
    throw new TextReadError('binary')
  }
  return text
}
