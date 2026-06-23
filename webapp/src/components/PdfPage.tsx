import { useEffect, useRef } from 'react'
import type { PDFDocumentProxy } from '../lib/pdfjs'
import type { TextItem } from '../lib/types'

interface Props {
  doc: PDFDocumentProxy
  pageIndex: number
  pageWidthPt: number
  pageHeightPt: number
  scale: number
  items: TextItem[]
  onItemChange: (id: string, text: string) => void
}

export function PdfPage({
  doc,
  pageIndex,
  pageWidthPt,
  pageHeightPt,
  scale,
  items,
  onItemChange,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const renderTokenRef = useRef(0)

  useEffect(() => {
    const token = ++renderTokenRef.current
    let cancelled = false
    let activeTask: { cancel: () => void } | null = null
    const canvas = canvasRef.current
    if (!canvas) return

    ;(async () => {
      const page = await doc.getPage(pageIndex + 1)
      if (cancelled || token !== renderTokenRef.current) {
        page.cleanup()
        return
      }
      const dpr = window.devicePixelRatio || 1
      const viewport = page.getViewport({ scale: scale * dpr })
      canvas.width = Math.floor(viewport.width)
      canvas.height = Math.floor(viewport.height)
      canvas.style.width = `${pageWidthPt * scale}px`
      canvas.style.height = `${pageHeightPt * scale}px`
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      const task = page.render({ canvasContext: ctx, viewport, canvas })
      activeTask = task
      try {
        await task.promise
      } catch (err) {
        const name = (err as { name?: string } | null)?.name
        if (name !== 'RenderingCancelledException') throw err
      } finally {
        page.cleanup()
      }
    })().catch((err) => {
      console.error(`Failed to render page ${pageIndex + 1}`, err)
    })

    return () => {
      cancelled = true
      if (activeTask) {
        try {
          activeTask.cancel()
        } catch {
          /* noop */
        }
      }
    }
  }, [doc, pageIndex, pageWidthPt, pageHeightPt, scale])

  const renderWidth = pageWidthPt * scale
  const renderHeight = pageHeightPt * scale

  return (
    <div
      className="pdf-page"
      style={{ width: renderWidth, height: renderHeight }}
    >
      <canvas ref={canvasRef} className="pdf-page__canvas" />
      <div className="pdf-page__overlay">
        {items.map((item) => (
          <TextField
            key={item.id}
            item={item}
            scale={scale}
            pageHeightPt={pageHeightPt}
            onChange={(text) => onItemChange(item.id, text)}
          />
        ))}
      </div>
    </div>
  )
}

interface FieldProps {
  item: TextItem
  scale: number
  pageHeightPt: number
  onChange: (text: string) => void
}

function TextField({ item, scale, pageHeightPt, onChange }: FieldProps) {
  // pdf.js gives baseline y in PDF space (origin bottom-left). Convert to
  // top-left CSS coords using the page height, and place the box from the
  // baseline up by the font height.
  const baselineFromTopPt = pageHeightPt - item.y
  const topPt = baselineFromTopPt - item.fontSize * 0.82
  const heightPt = item.fontSize * 1.05
  const widthPt = Math.max(item.width, item.fontSize * 0.5)

  const fontStack =
    item.fontFamily === 'times'
      ? 'Times New Roman, Times, serif'
      : item.fontFamily === 'courier'
        ? 'Courier New, Courier, monospace'
        : 'Helvetica, Arial, sans-serif'

  const edited = item.text !== item.originalText
  const textColor = `rgb(${Math.round(item.color.r * 255)}, ${Math.round(
    item.color.g * 255,
  )}, ${Math.round(item.color.b * 255)})`

  return (
    <input
      className={`pdf-text${edited ? ' pdf-text--edited' : ''}`}
      value={item.text}
      onChange={(e) => onChange(e.target.value)}
      spellCheck={false}
      style={
        {
          left: item.x * scale,
          top: topPt * scale,
          width: widthPt * scale,
          height: heightPt * scale,
          fontSize: item.fontSize * scale,
          fontFamily: fontStack,
          fontWeight: item.bold ? 700 : 400,
          fontStyle: item.italic ? 'italic' : 'normal',
          '--text-color': textColor,
        } as React.CSSProperties
      }
    />
  )
}
