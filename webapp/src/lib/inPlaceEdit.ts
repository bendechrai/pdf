import {
  PDFDict,
  PDFName,
  PDFRawStream,
  PDFStream,
  PDFArray,
  decodePDFRawStream,
  PDFNumber,
} from 'pdf-lib'
import type { PDFDocument, PDFPage } from 'pdf-lib'
import {
  bytesToHexBody,
  spliceOperands,
  walkTextOperators,
  type TjOp,
  type ByteRange,
} from './contentStream'
import { parseToUnicodeCMap, makeEncoder, type FontEncoder } from './cmap'
import type { TextItem } from './types'

interface PageFont {
  /** Resource key inside the page's /Font dict (e.g., "F1"). */
  key: string
  /** PostScript /BaseFont name, lowercased and stripped of the subset prefix. */
  postscript: string | null
  /** Encoder built from the font's ToUnicode CMap, if any. */
  encoder: FontEncoder | null
}

interface StreamEdit {
  range: ByteRange
  replacement: Uint8Array
}

export interface InPlaceResult {
  /** Item IDs that were edited in place (overlay should skip these). */
  handledIds: Set<string>
}

/**
 * Mutate the PDFDocument in place: for every text item that was edited,
 * try to find the matching Tj in the page's content stream and rewrite
 * the operand using the original embedded font.
 *
 * Returns the set of item IDs that were successfully edited in place. The
 * caller should apply overlay-style edits for items that aren't in that
 * set.
 */
export async function applyInPlaceEdits(
  pdfDoc: PDFDocument,
  items: TextItem[],
): Promise<InPlaceResult> {
  const handledIds = new Set<string>()
  const pages = pdfDoc.getPages()

  const editsByPage = new Map<number, TextItem[]>()
  for (const it of items) {
    if (it.text === it.originalText) continue
    const arr = editsByPage.get(it.pageIndex) ?? []
    arr.push(it)
    editsByPage.set(it.pageIndex, arr)
  }
  if (editsByPage.size === 0) return { handledIds }

  for (const [pageIndex, pageItems] of editsByPage) {
    const page = pages[pageIndex]
    if (!page) continue
    try {
      const handled = applyInPlaceEditsOnPage(pdfDoc, page, pageItems)
      handled.forEach((id) => handledIds.add(id))
    } catch (err) {
      console.warn(`In-place edit failed on page ${pageIndex + 1}`, err)
    }
  }

  return { handledIds }
}

function applyInPlaceEditsOnPage(
  pdfDoc: PDFDocument,
  page: PDFPage,
  items: TextItem[],
): Set<string> {
  const handled = new Set<string>()

  const fonts = readPageFonts(pdfDoc, page)
  const streams = readPageContentStreams(pdfDoc, page)
  if (streams.length === 0) return handled

  // Concatenate streams - the spec treats /Contents as the concatenation of
  // its members. We do the same so position tracking is continuous, then we
  // splice the result back into a single replacement stream.
  const combined = concatBytes(streams.map((s) => s.bytes))

  // Walk to find candidates.
  const operators: TjOp[] = []
  walkTextOperators(combined, (op) => operators.push(op))

  const edits: StreamEdit[] = []
  const tolerance = 3 // PDF points

  const debug = (msg: string) => console.debug(`[in-place] ${msg}`)
  debug(
    `page has ${operators.length} text op(s), ` +
      `${[...fonts.values()].filter((f) => f.encoder).length}/${fonts.size} font(s) with usable ToUnicode CMap`,
  )

  for (const item of items) {
    let bestOp: TjOp | null = null
    let bestDelta = Infinity
    let bestDecoded = ''
    let candidates = 0
    for (const op of operators) {
      const font = op.fontKey ? fonts.get(op.fontKey) : null
      if (!font || !font.encoder) continue
      const decoded = font.encoder.decode(op.operandBytes)
      if (normalize(decoded) !== normalize(item.originalText)) continue
      candidates++
      const dx = Math.abs(op.x - item.x)
      const dy = Math.abs(op.y - item.y)
      if (dx > tolerance || dy > tolerance) continue
      const delta = dx + dy
      if (delta < bestDelta) {
        bestDelta = delta
        bestOp = op
        bestDecoded = decoded
      }
    }
    if (!bestOp) {
      debug(
        `skip "${item.originalText}" -> "${item.text}" ` +
          `(${candidates} text match(es) but none within position tolerance @ pdfjs(${item.x.toFixed(1)},${item.y.toFixed(1)}))`,
      )
      continue
    }
    const font = fonts.get(bestOp.fontKey!)
    if (!font || !font.encoder) continue
    const encoded = font.encoder.encode(item.text)
    if (!encoded) {
      const missing = findMissingChars(item.text, font.encoder)
      debug(
        `skip "${item.originalText}" -> "${item.text}" ` +
          `(font "${font.postscript ?? font.key}" cannot encode: ${missing})`,
      )
      continue
    }

    const replacement = renderReplacement(bestOp, encoded)
    edits.push({ range: getReplaceRange(bestOp, combined.length), replacement })
    handled.add(item.id)
    debug(
      `replace "${bestDecoded}" -> "${item.text}" ` +
        `via ${bestOp.operator} @ (${bestOp.x.toFixed(1)},${bestOp.y.toFixed(1)})`,
    )
  }

  if (edits.length === 0) return handled

  const spliced = spliceOperands(combined, edits)
  replacePageContents(pdfDoc, page, spliced)
  return handled
}

function renderReplacement(op: TjOp, encoded: Uint8Array): Uint8Array {
  const hexBody = bytesToHexBody(encoded)
  if (op.operator === 'TJ') {
    // operandRange covers the entire [...] array. Replace with a single
    // hex string wrapped in brackets so TJ still has a valid array operand.
    return strToBytes(`[<${hexBody}>]`)
  }
  // For Tj/'/", operandRange is just the body bytes between the delimiters
  // (parens for literal, angle brackets for hex). We always emit hex, and
  // for a literal-string original we also need to swap the surrounding
  // parens for angle brackets - so include them in our replacement and
  // expand the range by one byte each side.
  if (op.operandIsHex) return strToBytes(hexBody)
  // Caller already targets just the inner bytes; but here we need to also
  // overwrite the surrounding ( ) with < >. Expand the range outside this
  // function would require returning a new range too. Instead, return
  // marker-padded replacement bytes that include the brackets and expect
  // callers to pass the expanded range.
  return strToBytes(`<${hexBody}>`)
}

function getReplaceRange(op: TjOp, combinedLen: number): ByteRange {
  if (op.operator === 'TJ') return op.operandRange
  if (op.operandIsHex) return op.operandRange
  return {
    start: Math.max(0, op.operandRange.start - 1),
    end: Math.min(combinedLen, op.operandRange.end + 1),
  }
}

function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function findMissingChars(text: string, encoder: { encode: (s: string) => Uint8Array | null }): string {
  const missing: string[] = []
  for (const ch of text) {
    if (encoder.encode(ch) == null) missing.push(ch)
  }
  return missing.length === 0 ? '(none?)' : JSON.stringify(missing.join(''))
}

function strToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff
  return out
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

function readPageFonts(pdfDoc: PDFDocument, page: PDFPage): Map<string, PageFont> {
  const fonts = new Map<string, PageFont>()
  const resources = page.node.Resources()
  if (!resources) return fonts
  const fontDict = resources.lookupMaybe(PDFName.of('Font'), PDFDict)
  if (!fontDict) return fonts

  for (const [keyName, value] of fontDict.entries()) {
    const key = keyName.asString().replace(/^\//, '')
    const fontObj = resolveDict(pdfDoc, value)
    if (!fontObj) continue
    const postscript = readPostScriptName(fontObj)
    const encoder = readEncoder(pdfDoc, fontObj)
    fonts.set(key, { key, postscript, encoder })
  }
  return fonts
}

function resolveDict(pdfDoc: PDFDocument, value: unknown): PDFDict | null {
  if (value instanceof PDFDict) return value
  // value is likely a PDFRef
  try {
    const looked = pdfDoc.context.lookup(value as never, PDFDict)
    return looked ?? null
  } catch {
    return null
  }
}

function readPostScriptName(fontObj: PDFDict): string | null {
  const base = fontObj.get(PDFName.of('BaseFont'))
  if (!base) return null
  const name = String((base as { asString?: () => string }).asString?.() ?? '')
  // BaseFont can be `/AAAAAA+InterRegular`. Strip the subset prefix.
  return name.replace(/^\//, '').replace(/^[A-Z]{6}\+/, '').toLowerCase()
}

function readEncoder(pdfDoc: PDFDocument, fontObj: PDFDict): FontEncoder | null {
  const toUnicode = fontObj.get(PDFName.of('ToUnicode'))
  if (!toUnicode) return null
  let stream: PDFStream | null = null
  try {
    stream = pdfDoc.context.lookup(toUnicode as never, PDFStream)
  } catch {
    return null
  }
  if (!stream || !(stream instanceof PDFRawStream)) return null
  let bytes: Uint8Array
  try {
    bytes = decodePDFRawStream(stream).decode()
  } catch {
    return null
  }
  const text = bytesToAscii(bytes)
  const fwd = parseToUnicodeCMap(text)
  if (!fwd) return null
  return makeEncoder(fwd)
}

function bytesToAscii(bytes: Uint8Array): string {
  let s = ''
  const chunk = 8192
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, Math.min(i + chunk, bytes.length))),
    )
  }
  return s
}

interface PageStream {
  bytes: Uint8Array
}

function readPageContentStreams(
  pdfDoc: PDFDocument,
  page: PDFPage,
): PageStream[] {
  const contents = page.node.Contents()
  if (!contents) return []
  const refs: unknown[] = []
  if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i++) refs.push(contents.get(i))
  } else {
    refs.push(contents)
  }

  const streams: PageStream[] = []
  for (const ref of refs) {
    try {
      const stream = pdfDoc.context.lookup(ref as never, PDFStream)
      if (!stream || !(stream instanceof PDFRawStream)) continue
      const bytes = decodePDFRawStream(stream).decode()
      streams.push({ bytes })
    } catch {
      /* skip */
    }
  }
  return streams
}

function replacePageContents(
  pdfDoc: PDFDocument,
  page: PDFPage,
  bytes: Uint8Array,
) {
  // Build a fresh uncompressed content stream and point the page at it.
  const dict = pdfDoc.context.obj({}) as PDFDict
  dict.set(PDFName.of('Length'), PDFNumber.of(bytes.length))
  const newStream = PDFRawStream.of(dict, bytes)
  const newRef = pdfDoc.context.register(newStream)
  page.node.set(PDFName.of('Contents'), newRef)
}
