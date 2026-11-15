// pkt-line codec and git packfile read/write (plain objects only; deltas are read
// and applied, never written). Pack objects are zlib streams; a stream's exact
// length is recovered by binary search because inflateSync ignores trailing bytes.
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';

export function pktLine(text: string): Buffer {
  return pktLineBuf(Buffer.from(text, 'utf8'));
}

export function pktLineBuf(data: Buffer): Buffer {
  const len = data.length + 4;
  const prefix = len.toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(prefix, 'ascii'), data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export type PktLine =
  | { type: 'data'; data: Buffer }
  | { type: 'flush' }
  | { type: 'delim' }
  | { type: 'response-end' };

/** Parse pkt-lines from the front of a buffer; returns lines and the unconsumed rest. */
export function parsePktLines(buf: Buffer): { lines: PktLine[]; rest: Buffer } {
  const lines: PktLine[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const lenHex = buf.subarray(offset, offset + 4).toString('ascii');
    const len = Number.parseInt(lenHex, 16);
    if (Number.isNaN(len)) break;
    if (len === 0) {
      lines.push({ type: 'flush' });
      offset += 4;
      continue;
    }
    if (len === 1) {
      lines.push({ type: 'delim' });
      offset += 4;
      continue;
    }
    if (len === 2) {
      lines.push({ type: 'response-end' });
      offset += 4;
      continue;
    }
    if (len < 4 || offset + len > buf.length) break;
    lines.push({ type: 'data', data: buf.subarray(offset + 4, offset + len) });
    offset += len;
  }
  return { lines, rest: buf.subarray(offset) };
}

/** Encode one object's type+size varint header for a pack entry. */
function packEntryHeader(typeNum: number, size: number): Buffer {
  const bytes: number[] = [];
  let remaining = size;
  let first = (typeNum << 4) | (remaining & 0x0f);
  remaining >>= 4;
  if (remaining > 0) first |= 0x80;
  bytes.push(first);
  while (remaining > 0) {
    let next = remaining & 0x7f;
    remaining >>= 7;
    if (remaining > 0) next |= 0x80;
    bytes.push(next);
  }
  return Buffer.from(bytes);
}

export const PACK_TYPE = { commit: 1, tree: 2, blob: 3, tag: 4, ofsDelta: 6, refDelta: 7 } as const;
export type PackObjectType = keyof typeof PACK_TYPE;

function typeNumToName(num: number): PackObjectType | null {
  switch (num) {
    case 1:
      return 'commit';
    case 2:
      return 'tree';
    case 3:
      return 'blob';
    case 4:
      return 'tag';
    case 6:
      return 'ofsDelta';
    case 7:
      return 'refDelta';
    default:
      return null;
  }
}

/** Deflated bytes per stored object, keyed by the object's data Buffer. Objects
 * are immutable and content-addressed, and the store returns the same Buffer
 * for an oid, so a cached deflate is always correct — and a repeated fetch of
 * the same objects (e.g. 50 clones of one repo) skips re-deflating them. */
const deflateCache = new WeakMap<Buffer, Buffer>();
function deflated(data: Buffer): Buffer {
  const cached = deflateCache.get(data);
  if (cached !== undefined) return cached;
  const out = zlib.deflateSync(data);
  deflateCache.set(data, out);
  return out;
}

/** Write a packfile of plain objects (no deltas), with the 20-byte SHA-1 trailer. */
export function writePack(objects: readonly { type: PackObjectType; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    parts.push(packEntryHeader(PACK_TYPE[obj.type], obj.data.length));
    parts.push(deflated(obj.data));
  }
  const body = Buffer.concat(parts);
  // Trailer: SHA-1 of every preceding pack byte.
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Apply a git delta to a base buffer. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset];
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const baseSize = readVarint();
  const resultSize = readVarint();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset];
    offset += 1;
    if ((op & 0x80) !== 0) {
      // Copy from base: offset and size are little-endian bit fields.
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if ((op & (1 << i)) !== 0) {
          copyOffset |= delta[offset] << (8 * i);
          offset += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if ((op & (0x10 << i)) !== 0) {
          copySize |= delta[offset] << (8 * i);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op !== 0) {
      out.push(delta.subarray(offset, offset + op));
      offset += op;
      produced += op;
    } else {
      throw new Error('invalid delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (produced !== resultSize || result.length !== resultSize) throw new Error('delta result size mismatch');
  return result;
}

/** Minimal length of the zlib stream at the front of `buf` (binary search). */
function zlibStreamLength(buf: Buffer): number {
  let lo = 1;
  let hi = buf.length;
  let first = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      zlib.inflateSync(buf.subarray(0, mid));
      first = mid;
      hi = mid - 1;
    } catch {
      lo = mid + 1;
    }
  }
  if (first === -1) throw new Error('corrupt zlib stream in pack');
  return first;
}

export interface ReadPackObject {
  /** Deltas are resolved during the read, so only plain object types occur here. */
  type: 'commit' | 'tree' | 'blob' | 'tag';
  data: Buffer;
  /** Byte offset of this entry's header inside the pack (for OFS delta bases). */
  offset: number;
}

/** Parse a packfile, applying deltas, and return plain objects in pack order. */
export function readPack(pack: Buffer): ReadPackObject[] {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const byOffset = new Map<number, ReadPackObject>();
  const objects: ReadPackObject[] = [];
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    let byte = pack[offset];
    offset += 1;
    const typeNum = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = pack[offset];
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    const type = typeNumToName(typeNum);
    if (type === null) throw new Error(`unknown pack object type ${typeNum}`);
    let baseOffset: number | null = null;
    if (type === 'ofsDelta') {
      // Negative offset varint: 7 bits per byte, big-endian accumulation.
      byte = pack[offset];
      offset += 1;
      let negativeOffset = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        byte = pack[offset];
        offset += 1;
        negativeOffset = ((negativeOffset + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = entryOffset - negativeOffset;
    } else if (type === 'refDelta') {
      throw new Error('ref-delta packs are not supported by this reader');
    }
    const compressedLen = zlibStreamLength(pack.subarray(offset));
    const raw = zlib.inflateSync(pack.subarray(offset, offset + compressedLen));
    offset += compressedLen;
    if (type === 'ofsDelta') {
      const baseEntry = baseOffset === null ? undefined : byOffset.get(baseOffset);
      if (baseEntry === undefined) throw new Error('ofs-delta base not found');
      const entry: ReadPackObject = { type: baseEntry.type, data: applyDelta(baseEntry.data, raw), offset: entryOffset };
      byOffset.set(entryOffset, entry);
      objects.push(entry);
    } else {
      const entry: ReadPackObject = { type: type as 'commit' | 'tree' | 'blob' | 'tag', data: raw, offset: entryOffset };
      byOffset.set(entryOffset, entry);
      objects.push(entry);
    }
    void size;
  }
  return objects;
}
