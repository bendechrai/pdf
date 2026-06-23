import { useEffect, useMemo, useState } from 'react'
import { pdfjs } from '../lib/pdfjs'
import type { PDFDocumentProxy } from '../lib/pdfjs'
import type { PDFDocumentLoadingTask } from 'pdfjs-dist'
import { exportEditedPdf } from '../lib/exportPdf'
import type { LoadedPdf, TextItem } from '../lib/types'
import { PdfPage } from './PdfPage'

interface Props {
  fileName: string
  loaded: LoadedPdf
  onReset: () => void
}

export function PdfEditor({ fileName, loaded, onReset }: Props) {
  const [items, setItems] = useState<TextItem[]>(loaded.items)
  const [scale, setScale] = useState(1.2)
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [exporting, setExporting] = useState(false)
  const [rebuildAllFonts, setRebuildAllFonts] = useState(false)

  useEffect(() => {
    let cancelled = false
    let task: PDFDocumentLoadingTask | null = pdfjs.getDocument({
      data: loaded.bytes.slice(),
    })

    task.promise
      .then((d) => {
        if (cancelled) return
        setDoc(d)
      })
      .catch((err) => {
        if (!cancelled) console.error('Failed to open PDF for rendering', err)
      })

    return () => {
      cancelled = true
      setDoc(null)
      if (task) {
        task.destroy().catch(() => {})
        task = null
      }
    }
  }, [loaded.bytes])

  const itemsByPage = useMemo(() => {
    const map = new Map<number, TextItem[]>()
    for (const it of items) {
      const arr = map.get(it.pageIndex) ?? []
      arr.push(it)
      map.set(it.pageIndex, arr)
    }
    return map
  }, [items])

  const editedCount = useMemo(
    () => items.filter((it) => it.text !== it.originalText).length,
    [items],
  )

  function handleItemChange(id: string, text: string) {
    setItems((prev) =>
      prev.map((it) => (it.id === id ? { ...it, text } : it)),
    )
  }

  function handleResetEdits() {
    setItems((prev) => prev.map((it) => ({ ...it, text: it.originalText })))
  }

  async function handleExport() {
    console.info('[export] click', {
      totalItems: items.length,
      edits: items.filter((it) => it.text !== it.originalText).length,
    })
    setExporting(true)
    try {
      const t0 = performance.now()
      const bytes = await exportEditedPdf(loaded.bytes, items, {
        rebuildAllFonts,
      })
      console.info(
        `[export] done in ${Math.round(performance.now() - t0)}ms, ` +
          `${bytes.length} bytes`,
      )
      const blob = new Blob([bytes as unknown as BlobPart], {
        type: 'application/pdf',
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = exportName(fileName)
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (err) {
      console.error('Export failed', err)
      alert(`Export failed: ${(err as Error).message}`)
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="editor">
      <header className="editor__bar">
        <div className="editor__bar-left">
          <button onClick={onReset}>Load another PDF</button>
          <span className="editor__file">{fileName}</span>
          <span className="editor__meta">
            {loaded.pages.length} page{loaded.pages.length === 1 ? '' : 's'}
            {' '}&middot;{' '}
            {editedCount} edit{editedCount === 1 ? '' : 's'}
          </span>
        </div>
        <div className="editor__bar-right">
          <label
            className="editor__toggle"
            title="Redraw every text run in Helvetica/Times/Courier on export, so edited and unedited text use the same font."
          >
            <input
              type="checkbox"
              checked={rebuildAllFonts}
              onChange={(e) => setRebuildAllFonts(e.target.checked)}
            />
            Rebuild fonts
          </label>
          <div className="editor__zoom">
            <button onClick={() => setScale((s) => Math.max(0.5, s - 0.1))}>
              -
            </button>
            <span>{Math.round(scale * 100)}%</span>
            <button onClick={() => setScale((s) => Math.min(3, s + 0.1))}>
              +
            </button>
          </div>
          <button onClick={handleResetEdits} disabled={editedCount === 0}>
            Reset edits
          </button>
          <button
            className="primary"
            onClick={handleExport}
            disabled={exporting}
          >
            {exporting ? 'Exporting...' : 'Export PDF'}
          </button>
        </div>
      </header>
      <div className="editor__scroll">
        <div className="editor__stack">
          {doc &&
            loaded.pages.map((p, idx) => (
              <PdfPage
                key={idx}
                doc={doc}
                pageIndex={idx}
                pageWidthPt={p.width}
                pageHeightPt={p.height}
                scale={scale}
                items={itemsByPage.get(idx) ?? []}
                onItemChange={handleItemChange}
              />
            ))}
        </div>
      </div>
    </div>
  )
}

function exportName(original: string): string {
  const base = original.replace(/\.pdf$/i, '')
  return `${base}-edited.pdf`
}
