// Minimal QR code encoder (ISO/IEC 18004): byte mode, error correction level M, versions 1-15 (up to 412 bytes of
// UTF-8), the mask with the lowest penalty. Enough for the pairing and web sign-in codes of the iOS app; no
// dependency and no third-party service. `qrMatrix(text)[row][col]` is true for dark modules (quiet zone not included).

/** Error correction blocks per version (level M): [count, data codewords per block] groups; EC codewords per block. */
const BLOCKS: Array<{ ec: number; groups: Array<[number, number]> }> = [
  { ec: 10, groups: [[1, 16]] },
  { ec: 16, groups: [[1, 28]] },
  { ec: 26, groups: [[1, 44]] },
  { ec: 18, groups: [[2, 32]] },
  { ec: 24, groups: [[2, 43]] },
  { ec: 16, groups: [[4, 27]] },
  { ec: 18, groups: [[4, 31]] },
  { ec: 22, groups: [[2, 38], [2, 39]] },
  { ec: 22, groups: [[3, 36], [2, 37]] },
  { ec: 26, groups: [[4, 43], [1, 44]] },
  { ec: 30, groups: [[1, 50], [4, 51]] },
  { ec: 22, groups: [[6, 36], [2, 37]] },
  { ec: 22, groups: [[8, 37], [1, 38]] },
  { ec: 24, groups: [[4, 40], [5, 41]] },
  { ec: 24, groups: [[5, 41], [5, 42]] },
];

/** Alignment pattern centers per version. */
const ALIGN: number[][] = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
  [6, 30, 54],
  [6, 32, 58],
  [6, 34, 62],
  [6, 26, 46, 66],
  [6, 26, 48, 70],
];

// GF(256) with the QR polynomial x^8 + x^4 + x^3 + x^2 + 1.
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const mul = (a: number, b: number) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

/** Reed-Solomon error correction codewords of `data`. */
function rsEncode(data: number[], degree: number): number[] {
  // Generator polynomial: product of (x - α^i), i < degree; coefficients highest power first, leading 1 dropped.
  let gen = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j++) {
      next[j] ^= gen[j];
      next[j + 1] ^= mul(gen[j], EXP[i]);
    }
    gen = next;
  }
  const res = new Array(degree).fill(0);
  for (const b of data) {
    const factor = b ^ res.shift()!;
    res.push(0);
    for (let j = 0; j < degree; j++) res[j] ^= mul(gen[j + 1], factor);
  }
  return res;
}

const dataCapacity = (v: number) => BLOCKS[v - 1].groups.reduce((n, [count, size]) => n + count * size, 0);

/** The codewords to place: data bits padded, split in blocks, interleaved, then the interleaved EC codewords. */
function codewords(bytes: Uint8Array, version: number): number[] {
  const capacity = dataCapacity(version);
  const bits: number[] = [];
  const put = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4); // byte mode
  put(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, capacity * 8 - bits.length)); // terminator
  while (bits.length % 8) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0xec; data.length < capacity; pad ^= 0xec ^ 0x11) data.push(pad);

  const { ec, groups } = BLOCKS[version - 1];
  const blocks: number[][] = [];
  let offset = 0;
  for (const [count, size] of groups) {
    for (let i = 0; i < count; i++) {
      blocks.push(data.slice(offset, offset + size));
      offset += size;
    }
  }
  const ecBlocks = blocks.map((b) => rsEncode(b, ec));
  const out: number[] = [];
  const longest = Math.max(...blocks.map((b) => b.length));
  for (let i = 0; i < longest; i++) for (const b of blocks) if (i < b.length) out.push(b[i]);
  for (let i = 0; i < ec; i++) for (const b of ecBlocks) out.push(b[i]);
  return out;
}

const MASKS: Array<(r: number, c: number) => boolean> = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/** BCH remainder of `value` (already shifted) for the format (0x537) and version (0x1f25) codes. */
function bch(value: number, poly: number, polyBits: number): number {
  let v = value;
  for (let i = 31 - Math.clz32(v); i >= polyBits - 1; i = 31 - Math.clz32(v)) v ^= poly << (i - polyBits + 1);
  return v;
}

class Matrix {
  version: number;
  size: number;
  dark: boolean[][];
  fixed: boolean[][];
  constructor(version: number) {
    this.version = version;
    this.size = 17 + 4 * version;
    this.dark = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.fixed = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }
  set(r: number, c: number, on: boolean) {
    this.dark[r][c] = on;
    this.fixed[r][c] = true;
  }
  functionPatterns() {
    const n = this.size;
    // Finder patterns with their separators.
    for (const [r0, c0] of [
      [0, 0],
      [0, n - 7],
      [n - 7, 0],
    ]) {
      for (let r = -1; r <= 7; r++) {
        for (let c = -1; c <= 7; c++) {
          const rr = r0 + r;
          const cc = c0 + c;
          if (rr < 0 || rr >= n || cc < 0 || cc >= n) continue;
          const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3));
          this.set(rr, cc, ring !== 2 && ring !== 4);
        }
      }
    }
    // Timing patterns.
    for (let i = 8; i < n - 8; i++) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }
    // Alignment patterns (not over the finders).
    const pos = ALIGN[this.version - 1];
    for (const r of pos) {
      for (const c of pos) {
        if ((r === 6 && c === 6) || (r === 6 && c === pos[pos.length - 1]) || (r === pos[pos.length - 1] && c === 6)) continue;
        for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) this.set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
      }
    }
    // Reserve the format areas (written per mask) and the dark module.
    this.format(0);
    // Version information (7+).
    if (this.version >= 7) {
      const bits = (this.version << 12) | bch(this.version << 12, 0x1f25, 13);
      for (let i = 0; i < 18; i++) {
        const on = ((bits >>> i) & 1) === 1;
        const a = n - 11 + (i % 3);
        const b = Math.floor(i / 3);
        this.set(b, a, on);
        this.set(a, b, on);
      }
    }
  }
  /** Format information: level M (00) and the mask, in both copies. */
  format(mask: number) {
    const n = this.size;
    const data = (0b00 << 3) | mask;
    const bits = ((data << 10) | bch(data << 10, 0x537, 11)) ^ 0x5412;
    const bit = (i: number) => ((bits >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) this.set(i, 8, bit(i));
    this.set(7, 8, bit(6));
    this.set(8, 8, bit(7));
    this.set(8, 7, bit(8));
    for (let i = 9; i < 15; i++) this.set(8, 14 - i, bit(i));
    for (let i = 0; i < 8; i++) this.set(8, n - 1 - i, bit(i));
    for (let i = 8; i < 15; i++) this.set(n - 15 + i, 8, bit(i));
    this.set(n - 8, 8, true);
  }
  /** Codewords in the zigzag order (two columns at a time, right to left, skipping the vertical timing column). */
  place(words: number[]) {
    const n = this.size;
    let i = 0;
    for (let right = n - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < n; vert++) {
        for (let j = 0; j < 2; j++) {
          const c = right - j;
          const upward = ((right + 1) & 2) === 0;
          const r = upward ? n - 1 - vert : vert;
          if (this.fixed[r][c]) continue;
          if (i < words.length * 8) this.dark[r][c] = ((words[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
          i++;
        }
      }
    }
  }
  applyMask(mask: number) {
    const fn = MASKS[mask];
    for (let r = 0; r < this.size; r++) for (let c = 0; c < this.size; c++) if (!this.fixed[r][c] && fn(r, c)) this.dark[r][c] = !this.dark[r][c];
  }
  /** Penalty score of the current modules (rules N1-N4 of the standard). */
  penalty(): number {
    const n = this.size;
    const m = this.dark;
    let score = 0;
    const line = (get: (i: number) => boolean) => {
      let s = 0;
      let run = 1;
      for (let i = 1; i <= n; i++) {
        if (i < n && get(i) === get(i - 1)) run++;
        else {
          if (run >= 5) s += 3 + (run - 5);
          run = 1;
        }
      }
      // 1:1:3:1:1 finder-like patterns with 4 light modules on one side.
      for (let i = 0; i + 7 <= n; i++) {
        if (![1, 0, 1, 1, 1, 0, 1].every((v, k) => get(i + k) === !!v)) continue;
        const before = [0, 1, 2, 3].every((k) => i - 1 - k < 0 || !get(i - 1 - k));
        const after = [0, 1, 2, 3].every((k) => i + 7 + k >= n || !get(i + 7 + k));
        if (before || after) s += 40;
      }
      return s;
    };
    for (let r = 0; r < n; r++) score += line((i) => m[r][i]);
    for (let c = 0; c < n; c++) score += line((i) => m[i][c]);
    for (let r = 0; r < n - 1; r++) for (let c = 0; c < n - 1; c++) if (m[r][c] === m[r][c + 1] && m[r][c] === m[r + 1][c] && m[r][c] === m[r + 1][c + 1]) score += 3;
    let dark = 0;
    for (const row of m) for (const v of row) if (v) dark++;
    score += Math.floor(Math.abs(dark * 20 - n * n * 10) / (n * n)) * 10;
    return score;
  }
}

/** QR modules of `text` (UTF-8). `mask` forces a mask pattern (tests); otherwise the lowest penalty wins. */
export function qrMatrix(text: string, mask?: number): boolean[][] {
  const bytes = new TextEncoder().encode(text);
  let version = 1;
  while (version <= BLOCKS.length && 4 + (version < 10 ? 8 : 16) + bytes.length * 8 > dataCapacity(version) * 8) version++;
  if (version > BLOCKS.length) throw new Error("Text too long for a QR code");
  const words = codewords(bytes, version);
  let best: Matrix | null = null;
  let bestScore = Infinity;
  for (const m of mask === undefined ? [0, 1, 2, 3, 4, 5, 6, 7] : [mask]) {
    const qr = new Matrix(version);
    qr.functionPatterns();
    qr.place(words);
    qr.applyMask(m);
    qr.format(m);
    const score = mask === undefined ? qr.penalty() : 0;
    if (score < bestScore) {
      best = qr;
      bestScore = score;
    }
  }
  return best!.dark;
}
