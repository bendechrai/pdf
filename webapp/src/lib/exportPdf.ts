import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import type { PDFFont } from 'pdf-lib'
import type { FontFamily, TextItem } from './types'
import { applyInPlaceEdits } from './inPlaceEdit'

type StyleKey = `${FontFamily}|${boolean}|${boolean}`

function standardFontFor(family: FontFamily, bold: boolean, italic: boolean): StandardFonts {
  if (family === 'times') {
    if (bold && italic) return StandardFonts.TimesRomanBoldItalic
    if (bold) return StandardFonts.TimesRomanBold
    if (italic) return StandardFonts.TimesRomanItalic
    return StandardFonts.TimesRoman
  }
  if (family === 'courier') {
    if (bold && italic) return StandardFonts.CourierBoldOblique
    if (bold) return StandardFonts.CourierBold
    if (italic) return StandardFonts.CourierOblique
    return StandardFonts.Courier
  }
  if (bold && italic) return StandardFonts.HelveticaBoldOblique
  if (bold) return StandardFonts.HelveticaBold
  if (italic) return StandardFonts.HelveticaOblique
  return StandardFonts.Helvetica
}

function styleKey(item: TextItem): StyleKey {
  return `${item.fontFamily}|${item.bold}|${item.italic}`
}

export interface ExportOptions {
  /** Overlay every text run in a standard font, so the whole document is
   *  visually consistent. Disables the in-place edit path. */
  rebuildAllFonts?: boolean
}

export async function exportEditedPdf(
  originalBytes: Uint8Array,
  items: TextItem[],
  opts: ExportOptions = {},
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(originalBytes)
  const pages = pdfDoc.getPages()

  const fontCache = new Map<StyleKey, PDFFont>()
  const getFont = async (item: TextItem): Promise<PDFFont> => {
    const key = styleKey(item)
    const cached = fontCache.get(key)
    if (cached) return cached
    const font = await pdfDoc.embedFont(
      standardFontFor(item.fontFamily, item.bold, item.italic),
    )
    fontCache.set(key, font)
    return font
  }

  let edits: TextItem[]
  if (opts.rebuildAllFonts) {
    // Force every text run through the overlay path, using the live `text`
    // value (which equals originalText for unedited runs).
    edits = items
    console.info(`Rebuilding all ${items.length} text run(s) in standard fonts.`)
  } else {
    // First pass: try true in-place editing using the original embedded font.
    const { handledIds } = await applyInPlaceEdits(pdfDoc, items)
    edits = items.filter(
      (it) => it.text !== it.originalText && !handledIds.has(it.id),
    )
    if (edits.length > 0) {
      console.info(
        `Falling back to overlay for ${edits.length} item(s); ` +
          `${handledIds.size} edited in place.`,
      )
    }
  }

  const warnedChars = new Set<string>()

  for (const item of edits) {
    const page = pages[item.pageIndex]
    if (!page) continue
    const font = await getFont(item)

    // Whiteout the original text. pdf.js width is fairly accurate; pad a bit
    // for descenders / antialiasing fringe.
    const padX = item.fontSize * 0.05
    const padTop = item.fontSize * 0.2
    const padBottom = item.fontSize * 0.25
    const boxWidth = Math.max(item.width + padX * 2, item.fontSize * 0.3)
    const boxHeight = item.fontSize + padTop + padBottom

    page.drawRectangle({
      x: item.x - padX,
      y: item.y - padBottom,
      width: boxWidth,
      height: boxHeight,
      color: rgb(1, 1, 1),
      borderWidth: 0,
    })

    if (item.text.trim().length === 0) continue

    const drawText = sanitizeForStandardFont(item.text, font, warnedChars)
    if (drawText.length === 0) continue

    // Shrink-to-fit so the replacement does not bleed past the whiteout box.
    let drawSize = item.fontSize
    const available = boxWidth - padX
    const replacementWidth = font.widthOfTextAtSize(drawText, drawSize)
    if (replacementWidth > available && replacementWidth > 0) {
      drawSize = Math.max(4, (drawSize * available) / replacementWidth)
    }

    page.drawText(drawText, {
      x: item.x,
      y: item.y,
      size: drawSize,
      font,
      color: rgb(item.color.r, item.color.g, item.color.b),
    })
  }

  return pdfDoc.save()
}

const COMMON_SUBSTITUTIONS: Record<string, string> = {
  '№': 'No.', // numero sign
  '‘': "'",
  '’': "'",
  '‚': ',',
  '“': '"',
  '”': '"',
  '„': '"',
  '–': '-', // en dash
  '—': '-', // em dash
  '−': '-', // minus
  '…': '...',
  ' ': ' ', // nbsp
  '·': '.',
  '•': '*', // bullet
  '′': "'", // prime
  '″': '"', // double prime
  '×': 'x', // multiplication sign
  '÷': '/',
  '±': '+/-',
  '°': 'deg',
}

/**
 * Map a Unicode string to bytes the embedded standard font (Helvetica/Times/
 * Courier) can actually encode. Substitutes common typographic characters
 * with their WinAnsi equivalents, and replaces anything still un-encodable
 * with `?`. The caller passes a `warned` set so each offending character is
 * only logged once per export.
 */
function sanitizeForStandardFont(
  text: string,
  font: PDFFont,
  warned: Set<string>,
): string {
  let out = ''
  for (const ch of text) {
    const sub = COMMON_SUBSTITUTIONS[ch] ?? ch
    let segment = ''
    for (const c of sub) {
      if (canEncode(font, c)) {
        segment += c
      } else {
        if (!warned.has(c)) {
          warned.add(c)
          console.warn(
            `[export] standard font cannot encode ${JSON.stringify(c)} ` +
              `(U+${c.codePointAt(0)!.toString(16).toUpperCase()}); substituting "?"`,
          )
        }
        segment += '?'
      }
    }
    out += segment
  }
  return out
}

function canEncode(font: PDFFont, ch: string): boolean {
  try {
    font.widthOfTextAtSize(ch, 1)
    return true
  } catch {
    return false
  }
}
