/**
 * Minimal ToUnicode CMap parser.
 *
 * PDF spec: ISO 32000-1, section 9.10.3.
 * We only parse the subset needed to invert a CMap into a forward map
 * (Unicode codepoint -> font character code bytes). That covers `bfchar`
 * and `bfrange` blocks, which is what virtually every embedded font uses.
 *
 * Returns null when the CMap is missing or unparseable; the caller should
 * fall back to overlay-based editing in that case.
 */

export interface FontEncoder {
  /** Number of bytes per source code (1 for simple fonts, 2 for Identity-H). */
  codeWidth: number
  /** Encode a Unicode string into the font's raw byte sequence, or null if any
   *  character isn't representable. */
  encode(text: string): Uint8Array | null
  /** Decode font bytes back to a Unicode string (best-effort, for matching). */
  decode(bytes: Uint8Array): string
}

interface ForwardMap {
  /** Map of unicode codepoint -> font code (number, big-endian). */
  fwd: Map<number, number>
  /** Map of font code -> unicode codepoint (best-effort, for decode). */
  rev: Map<number, number>
  codeWidth: number
}

/**
 * Parse a ToUnicode CMap and return an inverted forward map.
 */
export function parseToUnicodeCMap(cmapText: string): ForwardMap | null {
  const fwd = new Map<number, number>()
  const rev = new Map<number, number>()
  let codeWidth = 1

  // Detect code width from the first bfchar/bfrange source we see.
  const detectWidth = (hex: string) => {
    const w = Math.ceil(hex.length / 2)
    if (w > codeWidth) codeWidth = w
  }

  // bfchar blocks: `N beginbfchar ... endbfchar`
  const bfcharBlocks = cmapText.matchAll(
    /beginbfchar([\s\S]*?)endbfchar/g,
  )
  for (const block of bfcharBlocks) {
    const body = block[1]
    const pairs = body.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)
    for (const [, srcHex, dstHex] of pairs) {
      detectWidth(srcHex)
      const src = parseInt(srcHex, 16)
      const codepoint = hexToCodepoint(dstHex)
      if (codepoint == null) continue
      fwd.set(codepoint, src)
      rev.set(src, codepoint)
    }
  }

  // bfrange blocks: `N beginbfrange ... endbfrange`
  // Each entry is either `<start> <end> <dstStart>` (linear range)
  // or `<start> <end> [<dst1> <dst2> ...]` (explicit array).
  const bfrangeBlocks = cmapText.matchAll(
    /beginbfrange([\s\S]*?)endbfrange/g,
  )
  for (const block of bfrangeBlocks) {
    const body = block[1]
    // We need a token-aware walk for the array form. Do a simple state machine.
    const tokens = tokenizeCmapBody(body)
    let i = 0
    while (i < tokens.length - 2) {
      const a = tokens[i]
      const b = tokens[i + 1]
      const c = tokens[i + 2]
      if (a.kind !== 'hex' || b.kind !== 'hex') {
        i++
        continue
      }
      detectWidth(a.text)
      const start = parseInt(a.text, 16)
      const end = parseInt(b.text, 16)

      if (c.kind === 'hex') {
        const dstStartHex = c.text
        const dstStart = hexToCodepoint(dstStartHex)
        if (dstStart != null) {
          for (let src = start, off = 0; src <= end; src++, off++) {
            const cp = dstStart + off
            fwd.set(cp, src)
            rev.set(src, cp)
          }
        }
        i += 3
      } else if (c.kind === 'array') {
        let src = start
        for (const item of c.items) {
          if (src > end) break
          if (item.kind === 'hex') {
            const cp = hexToCodepoint(item.text)
            if (cp != null) {
              fwd.set(cp, src)
              rev.set(src, cp)
            }
          }
          src++
        }
        i += 3
      } else {
        i++
      }
    }
  }

  if (fwd.size === 0) return null
  return { fwd, rev, codeWidth }
}

type Tok =
  | { kind: 'hex'; text: string }
  | { kind: 'array'; items: Tok[] }
  | { kind: 'other' }

function tokenizeCmapBody(body: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < body.length) {
    const ch = body[i]
    if (ch === undefined) break
    if (/\s/.test(ch)) {
      i++
      continue
    }
    if (ch === '<') {
      const end = body.indexOf('>', i)
      if (end === -1) break
      out.push({ kind: 'hex', text: body.slice(i + 1, end) })
      i = end + 1
      continue
    }
    if (ch === '[') {
      const items: Tok[] = []
      i++
      while (i < body.length && body[i] !== ']') {
        const c = body[i]
        if (/\s/.test(c)) {
          i++
          continue
        }
        if (c === '<') {
          const end = body.indexOf('>', i)
          if (end === -1) break
          items.push({ kind: 'hex', text: body.slice(i + 1, end) })
          i = end + 1
        } else {
          i++
        }
      }
      if (body[i] === ']') i++
      out.push({ kind: 'array', items })
      continue
    }
    i++
  }
  return out
}

function hexToCodepoint(hex: string): number | null {
  // ToUnicode dst is UTF-16BE bytes. Most commonly a single BMP codepoint
  // (4 hex chars). Surrogate pairs (8 chars) get folded into one codepoint.
  if (hex.length === 4) {
    return parseInt(hex, 16)
  }
  if (hex.length === 8) {
    const hi = parseInt(hex.slice(0, 4), 16)
    const lo = parseInt(hex.slice(4, 8), 16)
    if (hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff) {
      return 0x10000 + ((hi - 0xd800) << 10) + (lo - 0xdc00)
    }
    return hi
  }
  if (hex.length === 2) {
    return parseInt(hex, 16)
  }
  // Fallback for other lengths: parse as a single integer.
  return hex.length > 0 ? parseInt(hex, 16) : null
}

export function makeEncoder(map: ForwardMap): FontEncoder {
  return {
    codeWidth: map.codeWidth,
    encode(text: string): Uint8Array | null {
      const codes: number[] = []
      for (const ch of text) {
        const cp = ch.codePointAt(0)!
        const code = map.fwd.get(cp)
        if (code === undefined) return null
        codes.push(code)
      }
      const out = new Uint8Array(codes.length * map.codeWidth)
      for (let i = 0; i < codes.length; i++) {
        const c = codes[i]
        if (map.codeWidth === 1) {
          out[i] = c & 0xff
        } else if (map.codeWidth === 2) {
          out[i * 2] = (c >> 8) & 0xff
          out[i * 2 + 1] = c & 0xff
        } else {
          for (let b = 0; b < map.codeWidth; b++) {
            out[i * map.codeWidth + map.codeWidth - 1 - b] = (c >> (8 * b)) & 0xff
          }
        }
      }
      return out
    },
    decode(bytes: Uint8Array): string {
      let s = ''
      for (let i = 0; i + map.codeWidth <= bytes.length; i += map.codeWidth) {
        let code = 0
        for (let b = 0; b < map.codeWidth; b++) {
          code = (code << 8) | bytes[i + b]
        }
        const cp = map.rev.get(code)
        if (cp == null) {
          s += '�'
        } else {
          s += String.fromCodePoint(cp)
        }
      }
      return s
    },
  }
}

/**
 * Encoder for non-composite fonts using WinAnsi (latin-1-ish) encoding,
 * built as a fallback when no ToUnicode CMap is present.
 */
export function winAnsiEncoder(): FontEncoder {
  // WinAnsiEncoding is essentially Windows-1252. Build a small mapping.
  const fwd = new Map<number, number>()
  const rev = new Map<number, number>()
  for (let code = 0; code <= 0x7f; code++) {
    fwd.set(code, code)
    rev.set(code, code)
  }
  // Latin-1 supplement passes through above 0xA0.
  for (let code = 0xa0; code <= 0xff; code++) {
    fwd.set(code, code)
    rev.set(code, code)
  }
  // CP1252-specific high-range characters.
  const cp1252: [number, number][] = [
    [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84],
    [0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88],
    [0x2030, 0x89], [0x0160, 0x8a], [0x2039, 0x8b], [0x0152, 0x8c],
    [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92], [0x201c, 0x93],
    [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
    [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b],
    [0x0153, 0x9c], [0x017e, 0x9e], [0x0178, 0x9f],
  ]
  for (const [cp, code] of cp1252) {
    fwd.set(cp, code)
    rev.set(code, cp)
  }
  return makeEncoder({ fwd, rev, codeWidth: 1 })
}
