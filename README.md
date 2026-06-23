# pdf

In-browser PDF text editor. Drop in a PDF, click any text run to edit it, and
export the result. Everything runs client-side - the file never leaves your
browser.

## Stack

- Vite + React + TypeScript SPA
- `pdfjs-dist` for rendering pages and extracting text positions
- `pdf-lib` for re-saving the edited PDF
- Served in dev via the Vite dev server in a Docker container
- Public dev URL via devtun: `https://pdf.dev.vennlabs.dev`

## How editing works

For v1, every edit is applied as a **whiteout + overlay**: the original glyph
run is covered with a white rectangle and the replacement text is drawn on top
in the closest standard font (Helvetica, Times, or Courier, picked to match
the original font family and weight).

This works on every PDF, including documents that use subset/embedded fonts
where true in-place text-stream editing would break. The font is rarely a
pixel-perfect match for custom fonts, but it preserves layout and is correct
for the receipts, invoices, and form-filled documents this is aimed at.

A true in-place edit path (modifying the page content stream directly when
the original uses a standard font with simple encoding) is wired up at the
type level (`TextItem.editFriendly`) but not yet used for export.

## Local dev

From this directory:

```
docker compose up --build
```

Then open https://pdf.dev.vennlabs.dev.
