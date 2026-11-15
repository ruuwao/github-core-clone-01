// git's object model and wire formats, implemented in pure Node.js stdlib (node:zlib +
// node:crypto). No git binary, no dependency. Byte-compatible with the kit's git-client.ts:
// same hashes, same tree sort, same commit/tag layouts, same pkt-line framing.

import { deflateSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';

export const ZERO_OID = '0'.repeat(40);

const HEX40 = /^[0-9a-f]{40}$/;

export function isObjectId(value: string): boolean {
  return HEX40.test(value);
}

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function objectHeader(type: GitObjectType, size: number): Buffer {
  return Buffer.from(`${type} ${size}\u0000`, 'utf8');
}

export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const hash = createHash('sha1');
  hash.update(objectHeader(type, body.length));
  hash.update(body);
  return hash.digest('hex');
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

export interface TagView {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

export function parseTree(data: Uint8Array): TreeEntry[] {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = buffer.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('tree entry has no name terminator');
    if (nul + 21 > buffer.length) throw new Error('tree entry has a truncated object id');
    const mode = buffer.subarray(offset, space).toString('ascii');
    const name = buffer.subarray(space + 1, nul).toString('utf8');
    const oid = buffer.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: ReadonlyArray<TreeEntry>): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseCommit(data: Uint8Array): CommitView {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headerText = buffer.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  if (!isObjectId(tree)) throw new Error('commit has no valid tree header');
  return { tree, parents, author, committer, message };
}

export function parseTag(data: Uint8Array): TagView {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headers = new Map<string, string>();
  for (const line of buffer.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) throw new Error(`tag header ${JSON.stringify(line)} has no value`);
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const object = headers.get('object') ?? '';
  const type = headers.get('type') ?? '';
  if (!isObjectId(object)) throw new Error('tag has no valid object header');
  if (type !== 'commit' && type !== 'tree' && type !== 'blob' && type !== 'tag') {
    throw new Error(`tag has bad type ${JSON.stringify(type)}`);
  }
  return {
    object,
    type: type as GitObjectType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8'),
  };
}

export const CONFORMANCE_IDENTITY = 'Conformance <conformance@make.fun>';

export interface BuildCommitFields {
  readonly tree: string;
  readonly parents?: readonly string[];
  readonly message: string;
  readonly author?: string;
  readonly committer?: string;
  readonly timestamp?: number;
  readonly timezone?: string;
}

export function buildCommit(fields: BuildCommitFields): Buffer {
  const timestamp = fields.timestamp ?? 1700000000;
  const timezone = fields.timezone ?? '+0000';
  const who = `${fields.author ?? CONFORMANCE_IDENTITY} ${timestamp} ${timezone}`;
  const committer = `${fields.committer ?? CONFORMANCE_IDENTITY} ${timestamp} ${timezone}`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

export function buildTag(fields: {
  object: string;
  type: GitObjectType;
  tag: string;
  message: string;
  tagger?: string;
  timestamp?: number;
  timezone?: string;
}): Buffer {
  const timestamp = fields.timestamp ?? 1700000000;
  const timezone = fields.timezone ?? '+0000';
  const tagger = `${fields.tagger ?? CONFORMANCE_IDENTITY} ${timestamp} ${timezone}`;
  return Buffer.from(
    `object ${fields.object}\ntype ${fields.type}\ntag ${fields.tag}\ntagger ${tagger}\n\n${fields.message}`,
    'utf8',
  );
}

export type ObjectLookup = (oid: string) => GitObject | undefined;

/** Every object reachable from `roots`, following commits, trees and tags. */
export function collectReachable(
  roots: Iterable<string>,
  lookup: ObjectLookup,
  options: { allowMissing?: boolean } = {},
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root)) queue.push(root);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) {
      if (options.allowMissing) continue;
      throw new Error(`object ${oid} is missing from the store`);
    }
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/**
 * Objects reachable from `roots` with a depth limit on commits: distance 0 is the root itself,
 * so depth 1 is the roots plus their trees and blobs only. `held` is a set of commits the client
 * already holds: traversal never crosses into a held commit's parents (a shallow boundary cuts
 * the walk), but a held commit's tree and blobs are held.
 */
export function collectReachableDepth(
  roots: Iterable<string>,
  lookup: ObjectLookup,
  options: { depth?: number; held?: ReadonlySet<string> } = {},
): Set<string> {
  const depth = options.depth ?? Number.POSITIVE_INFINITY;
  const held = options.held ?? new Set<string>();
  const seen = new Set<string>();
  const queue: Array<{ oid: string; dist: number }> = [];
  for (const root of roots) if (isObjectId(root)) queue.push({ oid: root, dist: 0 });
  while (queue.length) {
    const { oid, dist } = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push({ oid: commit.tree, dist });
      if (!held.has(oid) && dist + 1 < depth) {
        for (const parent of commit.parents) queue.push({ oid: parent, dist: dist + 1 });
      }
    } else if (object.type === 'tag') {
      queue.push({ oid: parseTag(object.data).object, dist });
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push({ oid: entry.oid, dist });
      }
    }
  }
  return seen;
}

/** Commits reachable from `root`, as a set (parents followed fully). */
export function commitAncestors(root: string, lookup: ObjectLookup): Set<string> {
  const seen = new Set<string>();
  const queue = [root];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid) || !isObjectId(oid)) continue;
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    seen.add(oid);
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return seen;
}

export function isAncestor(ancestor: string, descendant: string, lookup: ObjectLookup): boolean {
  if (ancestor === descendant) return true;
  return commitAncestors(descendant, lookup).has(ancestor);
}

/** The nearest common ancestor of `a` and `b` (first-parent-neutral BFS from `b`). */
export function mergeBase(a: string, b: string, lookup: ObjectLookup): string | null {
  const ancestorsA = commitAncestors(a, lookup);
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsA.has(oid)) return oid;
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// pkt-lines
// ---------------------------------------------------------------------------------------------

export const PKT_LINE_MAX = 65520;

export function encodePktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  if (length > PKT_LINE_MAX) throw new Error(`pkt-line too long: ${length}`);
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

export type PktPacket =
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' }
  | { kind: 'data'; payload: Buffer; raw: Buffer };

const HEX4 = /^[0-9a-f]{4}$/;

/**
 * Decode a complete buffer of pkt-lines. Returns the packets and the offset where the framed
 * part ended (the rest is raw data, e.g. a pack after a flush in receive-pack). Throws on a
 * malformed header. `allowTrailingRaw` stops at the first non-framed bytes instead of throwing.
 */
export function decodePktLines(bytes: Buffer, options: { allowTrailingRaw?: boolean } = {}): { packets: PktPacket[]; consumed: number } {
  const packets: PktPacket[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) throw new Error('truncated pkt-line header');
    const header = bytes.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(header)) {
      if (options.allowTrailingRaw) break;
      throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    }
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length === 3) throw new Error('invalid pkt-line length 0003');
    if (length > PKT_LINE_MAX) throw new Error(`pkt-line length ${length} exceeds ${PKT_LINE_MAX}`);
    if (offset + length > bytes.length) throw new Error('truncated pkt-line');
    const raw = bytes.subarray(offset, offset + length);
    packets.push({ kind: 'data', payload: raw.subarray(4), raw });
    offset += length;
  }
  return { packets, consumed: offset };
}

export function packetLines(packets: readonly PktPacket[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let text = packet.payload.toString('utf8');
    // Protocol lines end with a newline; the newline is framing, not content.
    if (text.endsWith('\n')) text = text.slice(0, -1);
    if (text.endsWith('\r')) text = text.slice(0, -1);
    lines.push(text);
  }
  return lines;
}

/** Wrap `data` in sideband packets of band `band`, chunked so no pkt-line exceeds the limit. */
export function sidebandPackets(data: Buffer, band: 1 | 2 | 3): Buffer[] {
  const out: Buffer[] = [];
  const maxData = PKT_LINE_MAX - 5; // 4 header bytes + 1 band byte
  for (let offset = 0; offset < data.length; offset += maxData) {
    const chunk = data.subarray(offset, offset + maxData);
    out.push(encodePktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// packs
// ---------------------------------------------------------------------------------------------

/** Read a varint of the pack object header: returns [value, bytesConsumed]. */
function readPackVarint(buffer: Buffer, offset: number): [number, number] {
  let value = buffer[offset] ?? 0;
  let size = value & 0x0f;
  let shift = 4;
  let consumed = 1;
  while ((value & 0x80) !== 0) {
    value = buffer[offset + consumed] ?? 0;
    size |= (value & 0x7f) << shift;
    shift += 7;
    consumed += 1;
  }
  return [size, consumed];
}

/** Read an ofs-delta negative offset: returns [offset, bytesConsumed]. */
function readOfsDeltaOffset(buffer: Buffer, offset: number): [number, number] {
  let byte = buffer[offset] ?? 0;
  let value = byte & 0x7f;
  let consumed = 1;
  while ((byte & 0x80) !== 0) {
    byte = buffer[offset + consumed] ?? 0;
    value = ((value + 1) << 7) | (byte & 0x7f);
    consumed += 1;
  }
  return [value, consumed];
}

/** Read a delta size varint: returns [value, bytesConsumed]. */
function readDeltaVarint(buffer: Buffer, offset: number): [number, number] {
  let value = 0;
  let shift = 0;
  let consumed = 0;
  for (;;) {
    const byte = buffer[offset + consumed] ?? 0;
    consumed += 1;
    value |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return [value, consumed];
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const [sourceSize, sourceConsumed] = readDeltaVarint(delta, offset);
  offset += sourceConsumed;
  if (sourceSize !== base.length) throw new Error(`delta base size ${sourceSize} != ${base.length}`);
  const [targetSize, targetConsumed] = readDeltaVarint(delta, offset);
  offset += targetConsumed;
  const parts: Buffer[] = [];
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset] ?? 0;
    offset += 1;
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if ((op & (1 << i)) !== 0) {
          copyOffset |= (delta[offset] ?? 0) << (i * 8);
          offset += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if ((op & (0x10 << i)) !== 0) {
          copySize |= (delta[offset] ?? 0) << (i * 8);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy out of range');
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
      written += copySize;
    } else if (op !== 0) {
      if (offset + op > delta.length) throw new Error('delta insert out of range');
      parts.push(delta.subarray(offset, offset + op));
      offset += op;
      written += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const out = Buffer.concat(parts);
  if (out.length !== targetSize || written !== targetSize) throw new Error(`delta target size ${out.length} != ${targetSize}`);
  return out;
}

interface RawPackEntry {
  type: GitObjectType | 'ofs-delta' | 'ref-delta';
  data: Buffer;
  baseOid?: string;
  baseOffset?: number;
  packOffset: number;
}

/** Parse a pack (v2 or v3), resolve ofs/ref deltas, verify each object's hash and the trailer.
 * `externalLookup` resolves ref-delta bases that are NOT in the pack (real git sends those for
 * objects the server already holds); without it such a pack throws. */
export function readPack(pack: Buffer, externalLookup?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 12 + 20) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const expected = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!expected.equals(trailer)) throw new Error('pack trailer checksum mismatch');

  const entries: RawPackEntry[] = [];
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    const first = pack[offset] ?? 0;
    const typeCode = (first >> 4) & 0x07;
    const [size, sizeConsumed] = readPackVarint(pack, offset);
    offset += sizeConsumed;
    let type: RawPackEntry['type'];
    let baseOid: string | undefined;
    let baseOffset: number | undefined;
    if (typeCode === 6) {
      type = 'ofs-delta';
      const [off, offConsumed] = readOfsDeltaOffset(pack, offset);
      offset += offConsumed;
      baseOffset = entryOffset - off;
    } else if (typeCode === 7) {
      type = 'ref-delta';
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else {
      const mapped = CODE_TYPE[typeCode];
      if (!mapped) throw new Error(`unknown pack object type ${typeCode}`);
      type = mapped;
    }
    const info = inflateSync(pack.subarray(offset), { info: true });
    const inflated = info.buffer;
    // bytesWritten on the inflate engine is the number of compressed bytes the stream
    // consumed: exactly the stream's length, trailing bytes ignored.
    const consumed = info.engine.bytesWritten;
    offset += consumed;
    if (inflated.length !== size) throw new Error(`pack object size ${inflated.length} != ${size}`);
    entries.push({ type, data: inflated, baseOid, baseOffset, packOffset: entryOffset });
  }

  // Resolve deltas in dependency order.
  const byOffset = new Map<number, RawPackEntry>();
  for (const entry of entries) byOffset.set(entry.packOffset, entry);
  const resolved = new Map<string, GitObject>();
  const resolving = new Set<number>();
  const resolve = (entry: RawPackEntry): GitObject => {
    if (entry.type !== 'ofs-delta' && entry.type !== 'ref-delta') {
      const oid = hashObject(entry.type, entry.data);
      const obj: GitObject = { type: entry.type, data: entry.data };
      resolved.set(oid, obj);
      return obj;
    }
    if (resolving.has(entry.packOffset)) throw new Error('delta cycle in pack');
    resolving.add(entry.packOffset);
    let base: GitObject | undefined;
    if (entry.type === 'ref-delta') {
      base = resolved.get(entry.baseOid ?? '') ?? externalLookup?.(entry.baseOid ?? '');
      if (!base) throw new Error(`ref-delta base ${entry.baseOid} not in pack or store`);
    } else {
      const baseEntry = byOffset.get(entry.baseOffset ?? -1);
      if (!baseEntry) throw new Error(`ofs-delta base offset ${entry.baseOffset} not in pack`);
      base = resolve(baseEntry);
    }
    const data = applyDelta(base.data, entry.data);
    const obj: GitObject = { type: base.type, data };
    const oid = hashObject(obj.type, obj.data);
    resolved.set(oid, obj);
    resolving.delete(entry.packOffset);
    return obj;
  };
  for (const entry of entries) resolve(entry);
  return resolved;
}

/** Write a plain (no-delta) pack v2 from objects, in the given order. */
export function writePack(objects: ReadonlyArray<GitObject>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    const typeCode = TYPE_CODE[object.type];
    const size = object.data.length;
    const sizeBytes: number[] = [];
    let remaining = size >>> 4;
    sizeBytes.push((typeCode << 4) | (size & 0x0f) | (remaining > 0 ? 0x80 : 0));
    while (remaining > 0) {
      const next = remaining >>> 7;
      sizeBytes.push((remaining & 0x7f) | (next > 0 ? 0x80 : 0));
      remaining = next;
    }
    parts.push(Buffer.from(sizeBytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------------------------------------
// line diff (multiset, good enough for the suite's additions/deletions checks)
// ---------------------------------------------------------------------------------------------

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function countLineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldCounts = new Map<string, number>();
  for (const line of splitLines(oldText)) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
  const newCounts = new Map<string, number>();
  for (const line of splitLines(newText)) newCounts.set(line, (newCounts.get(line) ?? 0) + 1);
  let additions = 0;
  let deletions = 0;
  for (const [line, count] of newCounts) {
    const old = oldCounts.get(line) ?? 0;
    if (count > old) additions += count - old;
  }
  for (const [line, count] of oldCounts) {
    const next = newCounts.get(line) ?? 0;
    if (count > next) deletions += count - next;
  }
  return { additions, deletions };
}
