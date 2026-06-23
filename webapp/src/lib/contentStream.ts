/**
 * Minimal PDF content stream walker.
 *
 * Goal: find every text-showing operator (Tj/TJ/'/") inside the stream,
 * record its byte range, the current font key, the absolute baseline
 * position, and the decoded source bytes - so callers can match a Tj
 * against a known text item and splice in a replacement.
 *
 * This is intentionally not a full PDF parser. It understands enough of
 * the content stream grammar to walk operands correctly (strings, hex
 * strings, arrays, names, numbers, dicts) and tracks the text matrix /
 * line matrix exactly per the spec.
 */

export type ByteRange = { start: number; end: number }

export interface TjOp {
  operator: 'Tj' | "'" | '"' | 'TJ'
  /** Byte range that should be replaced when rewriting the operand. For
   *  Tj/'/", this is just inside the string delimiters. For TJ, this is the
   *  entire `[...]` array including its brackets, and `operandIsHex` is
   *  ignored - the replacement should be a complete `[<...>]` expression. */
  operandRange: ByteRange
  /** True if the original literal was hex-encoded. Ignored for TJ. */
  operandIsHex: boolean
  /** Concatenated raw font bytes from this op (joining all TJ string parts). */
  operandBytes: Uint8Array
  /** Current font resource key ("F1") and size. */
  fontKey: string | null
  fontSize: number
  /** Baseline position in PDF user space (after CTM and text matrix). */
  x: number
  y: number
}

/** ASCII helpers. */
const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20])
const DELIMS = new Set([
  0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25,
])

type Token =
  | { kind: 'num'; v: number; start: number; end: number }
  | { kind: 'name'; v: string; start: number; end: number }
  | { kind: 'string'; raw: Uint8Array; start: number; end: number; bodyStart: number; bodyEnd: number; isHex: boolean }
  | { kind: 'array'; tokens: Token[]; start: number; end: number }
  | { kind: 'dict'; start: number; end: number }
  | { kind: 'op'; v: string; start: number; end: number }
  | { kind: 'bool'; v: boolean; start: number; end: number }

function isWs(b: number) {
  return WS.has(b)
}
function isDelim(b: number) {
  return DELIMS.has(b)
}
function isRegular(b: number) {
  return !isWs(b) && !isDelim(b)
}

/**
 * Single-pass tokenizer with a moving cursor. Arrays are parsed by
 * recursing on `nextToken` with the same buffer, never by slicing or
 * re-tokenizing - that's what blows up on long TJ kerning arrays.
 */
function tokenize(buf: Uint8Array): Token[] {
  const cursor = { i: 0 }
  const tokens: Token[] = []
  while (cursor.i < buf.length) {
    const before = cursor.i
    const tok = nextToken(buf, cursor)
    if (tok) {
      tokens.push(tok)
      continue
    }
    if (cursor.i === before) cursor.i++
  }
  return tokens
}

function nextToken(
  buf: Uint8Array,
  cursor: { i: number },
): Token | null {
  skipTrivia(buf, cursor)
  if (cursor.i >= buf.length) return null
  const i = cursor.i
  const b = buf[i]
  const n = buf.length

  // Literal string
  if (b === 0x28) {
    const start = i
    const bodyStart = i + 1
    let j = bodyStart
    let depth = 1
    while (j < n && depth > 0) {
      const c = buf[j]
      if (c === 0x5c) {
        j += 2
        continue
      }
      if (c === 0x28) depth++
      else if (c === 0x29) {
        depth--
        if (depth === 0) break
      }
      j++
    }
    const bodyEnd = j
    const end = j + 1
    cursor.i = end
    return {
      kind: 'string',
      raw: decodeLiteralString(buf.subarray(bodyStart, bodyEnd)),
      start,
      end,
      bodyStart,
      bodyEnd,
      isHex: false,
    }
  }

  // Hex string or dict open
  if (b === 0x3c) {
    if (buf[i + 1] === 0x3c) {
      // Dict - skip balanced << >>
      const start = i
      let j = i + 2
      let depth = 1
      while (j < n && depth > 0) {
        if (buf[j] === 0x3c && buf[j + 1] === 0x3c) {
          depth++
          j += 2
        } else if (buf[j] === 0x3e && buf[j + 1] === 0x3e) {
          depth--
          j += 2
        } else {
          j++
        }
      }
      cursor.i = j
      return { kind: 'dict', start, end: j }
    }
    const start = i
    const bodyStart = i + 1
    let j = bodyStart
    while (j < n && buf[j] !== 0x3e) j++
    const bodyEnd = j
    const end = j + 1
    cursor.i = end
    return {
      kind: 'string',
      raw: decodeHexString(buf.subarray(bodyStart, bodyEnd)),
      start,
      end,
      bodyStart,
      bodyEnd,
      isHex: true,
    }
  }

  // Array
  if (b === 0x5b) {
    const start = i
    cursor.i = i + 1
    const items: Token[] = []
    while (cursor.i < n) {
      skipTrivia(buf, cursor)
      if (cursor.i >= n) break
      if (buf[cursor.i] === 0x5d) {
        cursor.i++
        break
      }
      const sub = nextToken(buf, cursor)
      if (!sub) break
      items.push(sub)
    }
    return { kind: 'array', tokens: items, start, end: cursor.i }
  }

  // Name
  if (b === 0x2f) {
    const start = i
    let j = i + 1
    while (j < n && isRegular(buf[j])) j++
    cursor.i = j
    const name = asciiSlice(buf, start + 1, j)
    return { kind: 'name', v: name, start, end: j }
  }

  // Closing bracket or other lone delimiter we can't start a token with.
  if (b === 0x5d || b === 0x3e || b === 0x29 || b === 0x7b || b === 0x7d) {
    cursor.i = i + 1
    return null
  }

  // Number / operator / bool / null
  const start = i
  let j = i
  while (j < n && isRegular(buf[j])) j++
  cursor.i = j
  const text = asciiSlice(buf, start, j)
  if (text === 'true' || text === 'false') {
    return { kind: 'bool', v: text === 'true', start, end: j }
  }
  if (/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(text)) {
    return { kind: 'num', v: parseFloat(text), start, end: j }
  }
  if (text === 'null') return null
  if (text.length === 0) {
    cursor.i = j + 1
    return null
  }
  return { kind: 'op', v: text, start, end: j }
}

function skipTrivia(buf: Uint8Array, cursor: { i: number }) {
  const n = buf.length
  while (cursor.i < n) {
    const b = buf[cursor.i]
    if (isWs(b)) {
      cursor.i++
      continue
    }
    if (b === 0x25) {
      // comment to end of line
      while (cursor.i < n && buf[cursor.i] !== 0x0a && buf[cursor.i] !== 0x0d) {
        cursor.i++
      }
      continue
    }
    break
  }
}

function asciiSlice(buf: Uint8Array, start: number, end: number): string {
  let s = ''
  for (let i = start; i < end; i++) s += String.fromCharCode(buf[i])
  return s
}

function decodeLiteralString(body: Uint8Array): Uint8Array {
  const out: number[] = []
  let i = 0
  while (i < body.length) {
    const b = body[i]
    if (b === 0x5c) {
      const next = body[i + 1]
      i += 2
      switch (next) {
        case 0x6e: out.push(0x0a); break
        case 0x72: out.push(0x0d); break
        case 0x74: out.push(0x09); break
        case 0x62: out.push(0x08); break
        case 0x66: out.push(0x0c); break
        case 0x28: out.push(0x28); break
        case 0x29: out.push(0x29); break
        case 0x5c: out.push(0x5c); break
        default:
          // Octal escape \ddd
          if (next != null && next >= 0x30 && next <= 0x37) {
            let oct = next - 0x30
            for (let k = 0; k < 2; k++) {
              const c = body[i]
              if (c == null || c < 0x30 || c > 0x37) break
              oct = oct * 8 + (c - 0x30)
              i++
            }
            out.push(oct & 0xff)
          } else if (next != null) {
            out.push(next)
          }
          break
      }
    } else {
      out.push(b)
      i++
    }
  }
  return Uint8Array.from(out)
}

function decodeHexString(body: Uint8Array): Uint8Array {
  let hex = ''
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (WS.has(c)) continue
    hex += String.fromCharCode(c)
  }
  if (hex.length % 2 === 1) hex += '0'
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16)
  }
  return out
}

interface State {
  // CTM (a b c d e f) - current transformation matrix. Identity at start.
  ctm: [number, number, number, number, number, number]
  // Stack of saved CTMs for q/Q.
  ctmStack: [number, number, number, number, number, number][]
  // Text matrix.
  tm: [number, number, number, number, number, number] | null
  // Text line matrix.
  tlm: [number, number, number, number, number, number] | null
  // Text leading.
  tl: number
  // Current font key (e.g. "F1") and size.
  fontKey: string | null
  fontSize: number
  inText: boolean
}

function identity(): [number, number, number, number, number, number] {
  return [1, 0, 0, 1, 0, 0]
}

// 6-value matrix multiplication (PDF text/graphics matrices are 3x3 affine).
function mul(
  a: [number, number, number, number, number, number],
  b: [number, number, number, number, number, number],
): [number, number, number, number, number, number] {
  // [a b 0]   [a' b' 0]
  // [c d 0] x [c' d' 0]
  // [e f 1]   [e' f' 1]
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ]
}

/**
 * Walk a content stream, calling back for each text-show operator with
 * the current font + position + operand.
 */
export function walkTextOperators(buf: Uint8Array, emit: (op: TjOp) => void) {
  const tokens = tokenize(buf)
  const state: State = {
    ctm: identity(),
    ctmStack: [],
    tm: null,
    tlm: null,
    tl: 0,
    fontKey: null,
    fontSize: 0,
    inText: false,
  }
  const operandStack: Token[] = []

  const nums = (n: number): number[] | null => {
    if (operandStack.length < n) return null
    const out: number[] = []
    for (let i = operandStack.length - n; i < operandStack.length; i++) {
      const t = operandStack[i]
      if (t.kind !== 'num') return null
      out.push(t.v)
    }
    return out
  }

  const consume = (n: number) => operandStack.splice(operandStack.length - n, n)

  for (const t of tokens) {
    if (t.kind !== 'op') {
      operandStack.push(t)
      continue
    }
    const op = t.v
    switch (op) {
      case 'q':
        state.ctmStack.push(state.ctm.slice() as [number, number, number, number, number, number])
        consume(operandStack.length)
        break
      case 'Q': {
        const popped = state.ctmStack.pop()
        if (popped) state.ctm = popped
        consume(operandStack.length)
        break
      }
      case 'cm': {
        const m = nums(6)
        if (m) state.ctm = mul(m as [number, number, number, number, number, number], state.ctm)
        consume(operandStack.length)
        break
      }
      case 'BT':
        state.inText = true
        state.tm = identity()
        state.tlm = identity()
        consume(operandStack.length)
        break
      case 'ET':
        state.inText = false
        state.tm = null
        state.tlm = null
        consume(operandStack.length)
        break
      case 'Tf': {
        // operands: name, size
        if (operandStack.length >= 2) {
          const sizeTok = operandStack[operandStack.length - 1]
          const nameTok = operandStack[operandStack.length - 2]
          if (sizeTok.kind === 'num' && nameTok.kind === 'name') {
            state.fontKey = nameTok.v
            state.fontSize = sizeTok.v
          }
        }
        consume(operandStack.length)
        break
      }
      case 'TL': {
        const m = nums(1)
        if (m) state.tl = m[0]
        consume(operandStack.length)
        break
      }
      case 'Td':
      case 'TD': {
        const m = nums(2)
        if (m && state.tlm) {
          const move: [number, number, number, number, number, number] = [1, 0, 0, 1, m[0], m[1]]
          state.tlm = mul(move, state.tlm)
          state.tm = state.tlm.slice() as [number, number, number, number, number, number]
          if (op === 'TD') state.tl = -m[1]
        }
        consume(operandStack.length)
        break
      }
      case 'Tm': {
        const m = nums(6)
        if (m) {
          state.tm = m as [number, number, number, number, number, number]
          state.tlm = m.slice() as [number, number, number, number, number, number]
        }
        consume(operandStack.length)
        break
      }
      case 'T*': {
        if (state.tlm) {
          const move: [number, number, number, number, number, number] = [1, 0, 0, 1, 0, -state.tl]
          state.tlm = mul(move, state.tlm)
          state.tm = state.tlm.slice() as [number, number, number, number, number, number]
        }
        consume(operandStack.length)
        break
      }
      case 'Tj':
      case "'":
      case '"': {
        const tokOperand = operandStack[operandStack.length - 1]
        if (op === "'" || op === '"') {
          // Equivalent to T* then Tj
          if (state.tlm) {
            const move: [number, number, number, number, number, number] = [1, 0, 0, 1, 0, -state.tl]
            state.tlm = mul(move, state.tlm)
            state.tm = state.tlm.slice() as [number, number, number, number, number, number]
          }
        }
        if (
          tokOperand &&
          tokOperand.kind === 'string' &&
          state.inText &&
          state.tm
        ) {
          const combined = mul(state.tm, state.ctm)
          emit({
            operator: op as 'Tj' | "'" | '"',
            operandRange: {
              start: tokOperand.bodyStart,
              end: tokOperand.bodyEnd,
            },
            operandIsHex: tokOperand.isHex,
            operandBytes: tokOperand.raw,
            fontKey: state.fontKey,
            fontSize: state.fontSize,
            x: combined[4],
            y: combined[5],
          })
        }
        consume(operandStack.length)
        break
      }
      case 'TJ': {
        const tokOperand = operandStack[operandStack.length - 1]
        if (
          tokOperand &&
          tokOperand.kind === 'array' &&
          state.inText &&
          state.tm
        ) {
          // Concatenate every string element. Numeric kerning entries are
          // dropped - we're rebuilding the run as a single uniformly-spaced
          // string, which costs a small layout shift but preserves the font.
          const parts: Uint8Array[] = []
          for (const item of tokOperand.tokens) {
            if (item.kind === 'string') parts.push(item.raw)
          }
          const concat = concatBytesLocal(parts)
          const combined = mul(state.tm, state.ctm)
          emit({
            operator: 'TJ',
            operandRange: { start: tokOperand.start, end: tokOperand.end },
            operandIsHex: false,
            operandBytes: concat,
            fontKey: state.fontKey,
            fontSize: state.fontSize,
            x: combined[4],
            y: combined[5],
          })
        }
        consume(operandStack.length)
        break
      }
      default:
        consume(operandStack.length)
    }
  }
}

/**
 * Splice replacement operand bytes back into a content stream.
 * Edits are applied in reverse order of position so byte offsets stay valid.
 */
export function spliceOperands(
  original: Uint8Array,
  edits: Array<{ range: ByteRange; replacement: Uint8Array }>,
): Uint8Array {
  const sorted = [...edits].sort((a, b) => b.range.start - a.range.start)
  // Build a list of segments.
  let out = original
  for (const e of sorted) {
    const before = out.subarray(0, e.range.start)
    const after = out.subarray(e.range.end)
    const merged = new Uint8Array(before.length + e.replacement.length + after.length)
    merged.set(before, 0)
    merged.set(e.replacement, before.length)
    merged.set(after, before.length + e.replacement.length)
    out = merged
  }
  return out
}

function concatBytesLocal(parts: Uint8Array[]): Uint8Array {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

/** Encode a raw font byte sequence as a PDF hex string body (without < >). */
export function bytesToHexBody(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) {
    const v = bytes[i]
    s += (v < 0x10 ? '0' : '') + v.toString(16)
  }
  return s
}
