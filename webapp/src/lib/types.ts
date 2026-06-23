export type FontFamily = 'helvetica' | 'times' | 'courier'

export interface TextItem {
  id: string
  pageIndex: number
  itemIndex: number
  originalText: string
  text: string
  /** PDF-space coordinates: origin at bottom-left of the page. */
  x: number
  y: number
  width: number
  height: number
  /** Font height in PDF points (the rendered cap-height ish). */
  fontSize: number
  fontFamily: FontFamily
  bold: boolean
  italic: boolean
  /** Color of the original text, as 0-1 RGB. */
  color: { r: number; g: number; b: number }
  /** True if pdf.js reported a usable font + decodable text. */
  editFriendly: boolean
}

export interface PageDims {
  /** Width in PDF points. */
  width: number
  /** Height in PDF points. */
  height: number
}

export interface LoadedPdf {
  /** Raw bytes of the original file - the source of truth for export. */
  bytes: Uint8Array
  /** Per-page dimensions (PDF points). */
  pages: PageDims[]
  /** All editable text items, grouped by page. */
  items: TextItem[]
}
