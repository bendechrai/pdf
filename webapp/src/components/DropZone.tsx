import { useRef, useState } from 'react'

interface Props {
  onFile: (file: File) => void
  error?: string | null
  loading?: boolean
}

export function DropZone({ onFile, error, loading }: Props) {
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  function pickFile(files: FileList | null) {
    if (!files || files.length === 0) return
    const file = files[0]
    onFile(file)
  }

  return (
    <div className="drop-wrap">
      <div
        className={`drop${dragging ? ' drop--active' : ''}${
          loading ? ' drop--loading' : ''
        }`}
        onDragEnter={(e) => {
          e.preventDefault()
          if (!loading) setDragging(true)
        }}
        onDragOver={(e) => {
          e.preventDefault()
          if (!loading) setDragging(true)
        }}
        onDragLeave={(e) => {
          e.preventDefault()
          setDragging(false)
        }}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          if (loading) return
          pickFile(e.dataTransfer.files)
        }}
        onClick={() => !loading && inputRef.current?.click()}
      >
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          onChange={(e) => pickFile(e.target.files)}
        />
        <div className="drop__icon" aria-hidden>
          PDF
        </div>
        <h1 className="drop__title">
          {loading ? 'Reading PDF...' : 'Drop a PDF to edit'}
        </h1>
        <p className="drop__sub">
          {loading
            ? 'Extracting text and rendering pages.'
            : 'Or click anywhere in this box to choose a file. Everything runs in your browser - your file is never uploaded.'}
        </p>
        {error ? <p className="drop__error">{error}</p> : null}
      </div>
    </div>
  )
}
