import { useState } from 'react'
import { DropZone } from './components/DropZone'
import { PdfEditor } from './components/PdfEditor'
import { loadPdf } from './lib/loadPdf'
import type { LoadedPdf } from './lib/types'
import './app.css'

interface OpenFile {
  name: string
  loaded: LoadedPdf
}

export default function App() {
  const [file, setFile] = useState<OpenFile | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleFile(f: File) {
    setError(null)
    setLoading(true)
    try {
      const buf = new Uint8Array(await f.arrayBuffer())
      const loaded = await loadPdf(buf)
      setFile({ name: f.name, loaded })
    } catch (err) {
      console.error('Failed to load PDF', err)
      setError(`Could not read PDF: ${(err as Error).message}`)
    } finally {
      setLoading(false)
    }
  }

  if (file) {
    return (
      <PdfEditor
        fileName={file.name}
        loaded={file.loaded}
        onReset={() => setFile(null)}
      />
    )
  }

  return <DropZone onFile={handleFile} loading={loading} error={error} />
}
