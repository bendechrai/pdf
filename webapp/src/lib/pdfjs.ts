import * as pdfjs from 'pdfjs-dist'

// Serve the worker as a flat static asset from public/. Going through Vite's
// `?worker` or `?url` transforms breaks pdf.js v5's ESM worker - either by
// running it on the main thread or by killing the shared worker on
// StrictMode's double-effect cleanup. A static file with `workerSrc` lets
// pdf.js create a fresh dedicated worker per loading task.
pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'

export { pdfjs }
export type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
