/**
 * Minimal deflate ZIP writer for a flat set of files (replaces
 * `shutil.make_archive(..., 'zip', dir)` for the time-series bundle).
 */

import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

/** Most a ZIP may expand to when read back (time-series bundles). */
const MAX_UNZIPPED_BYTES = 1024 * 1024 * 1024;

/**
 * Reads a ZIP (stored or deflated entries, no ZIP64) from its central
 * directory. Directory entries are skipped; names are returned as stored.
 */
export function readZip(zip: Buffer): ZipEntry[] {
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i -= 1) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('Not a ZIP archive');
  const count = zip.readUInt16LE(end + 10);
  let offset = zip.readUInt32LE(end + 16);
  const entries: ZipEntry[] = [];
  let total = 0;
  for (let n = 0; n < count; n += 1) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('Corrupt ZIP central directory');
    }
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const size = zip.readUInt32LE(offset + 24);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const local = zip.readUInt32LE(offset + 42);
    const name = zip.toString('utf8', offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;
    total += size;
    if (total > MAX_UNZIPPED_BYTES) throw new Error('ZIP archive is too large');
    if (zip.readUInt32LE(local) !== 0x04034b50) {
      throw new Error('Corrupt ZIP entry');
    }
    const start =
      local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(start, start + compressedSize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) {
      data = inflateRawSync(raw, { maxOutputLength: Math.max(size, 1) });
    } else throw new Error(`Unsupported ZIP compression method ${method}`);
    if (data.length !== size) throw new Error('Corrupt ZIP entry size');
    entries.push({ name, data });
  }
  return entries;
}

export interface ZipEntry {
  name: string;
  data: Buffer;
}

/** DOS date/time fields for `date`. */
function dosDateTime(date: Date): [number, number] {
  const time =
    (date.getHours() << 11) |
    (date.getMinutes() << 5) |
    Math.floor(date.getSeconds() / 2);
  const day =
    ((date.getFullYear() - 1980) << 9) |
    ((date.getMonth() + 1) << 5) |
    date.getDate();
  return [time, day];
}

export function createZip(entries: ZipEntry[], now = new Date()): Buffer {
  const [time, day] = dosDateTime(now);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const compressed = deflateRawSync(entry.data);
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + compressed.length;
  }

  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}
