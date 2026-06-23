import { pdfjs } from './pdfjs'
import type { LoadedPdf, TextItem, FontFamily, PageDims } from './types'

interface PdfJsFontInfo {
  name?: string
  loadedName?: string
  fallbackName?: string
  isBold?: boolean
  isItalic?: boolean
  italicAngle?: number
}

const FAMILY_KEYS: Record<string, FontFamily> = {
  helv: 'helvetica',
  arial: 'helvetica',
  swiss: 'helvetica',
  sans: 'helvetica',
  liberation: 'helvetica',
  times: 'times',
  roman: 'times',
  serif: 'times',
  georgia: 'times',
  cmr: 'times',
  courier: 'courier',
  mono: 'courier',
  consolas: 'courier',
  cour: 'courier',
}

function classifyFont(fontInfo: PdfJsFontInfo | undefined, fontName: string): {
  family: FontFamily
  bold: boolean
  italic: boolean
} {
  const candidate = `${fontInfo?.name ?? ''} ${fontInfo?.fallbackName ?? ''} ${fontName}`.toLowerCase()

  let family: FontFamily = 'helvetica'
  for (const [key, fam] of Object.entries(FAMILY_KEYS)) {
    if (candidate.includes(key)) {
      family = fam
      break
    }
  }

  const bold = Boolean(fontInfo?.isBold) || /bold|black|heavy/.test(candidate)
  const italic =
    Boolean(fontInfo?.isItalic) ||
    (typeof fontInfo?.italicAngle === 'number' && fontInfo.italicAngle !== 0) ||
    /italic|oblique/.test(candidate)

  return { family, bold, italic }
}

export async function loadPdf(bytes: Uint8Array): Promise<LoadedPdf> {
  const t0 = performance.now()
  console.info(`[load] starting, ${bytes.length} bytes`)
  // pdf.js may transfer/consume the buffer, so pass a copy.
  const task = pdfjs.getDocument({ data: bytes.slice() })
  const doc = await task.promise
  console.info(`[load] doc opened in ${Math.round(performance.now() - t0)}ms, ${doc.numPages} pages`)

  const pages: PageDims[] = []
  const items: TextItem[] = []

  for (let pageIndex = 0; pageIndex < doc.numPages; pageIndex++) {
    const page = await doc.getPage(pageIndex + 1)
    const viewport = page.getViewport({ scale: 1 })
    pages.push({ width: viewport.width, height: viewport.height })

    const textContent = await page.getTextContent()

    let itemIndex = 0
    for (const raw of textContent.items) {
      if (!('str' in raw)) continue
      const item = raw as {
        str: string
        transform: number[]
        width: number
        height: number
        fontName: string
        hasEOL?: boolean
      }
      if (!item.str || !item.str.trim()) continue

      const [a, b, , d, e, f] = item.transform
      const fontSize = Math.hypot(a, b) || Math.abs(d) || 12

      let fontInfo: PdfJsFontInfo | undefined
      try {
        fontInfo = page.commonObjs.get(item.fontName) as PdfJsFontInfo | undefined
      } catch {
        fontInfo = undefined
      }
      const { family, bold, italic } = classifyFont(fontInfo, item.fontName)

      items.push({
        id: `p${pageIndex}-i${itemIndex}`,
        pageIndex,
        itemIndex,
        originalText: item.str,
        text: item.str,
        x: e,
        y: f,
        width: item.width || estimateWidth(item.str, fontSize),
        height: item.height || fontSize,
        fontSize,
        fontFamily: family,
        bold,
        italic,
        color: { r: 0, g: 0, b: 0 },
        editFriendly: family !== undefined,
      })
      itemIndex++
    }

    page.cleanup()
  }

  await task.destroy()
  console.info(
    `[load] complete in ${Math.round(performance.now() - t0)}ms, ` +
      `${items.length} text item(s)`,
  )
  return { bytes, pages, items }
}

function estimateWidth(text: string, fontSize: number): number {
  // Rough fallback when pdf.js doesn't report a width.
  return text.length * fontSize * 0.5
}
