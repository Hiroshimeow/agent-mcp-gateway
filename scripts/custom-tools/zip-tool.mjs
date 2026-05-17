import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { defaultExcludePatterns, resolveInsideTrustedRoots, shouldExclude, toRelativeFromRoot, walkFiles } from './path-utils.mjs';
import { fail, ok } from './response-utils.mjs';

function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (~crc) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  return { time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2), date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate() };
}

function u16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; }

async function writeZip(destination, entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name.replaceAll('\\', '/'));
    const data = await fs.promises.readFile(entry.path);
    const compressed = zlib.deflateRawSync(data);
    const crc = crc32(data);
    const dt = dosDateTime(new Date());
    const local = Buffer.concat([u32(0x04034b50), u16(20), u16(0), u16(8), u16(dt.time), u16(dt.date), u32(crc), u32(compressed.length), u32(data.length), u16(name.length), u16(0), name, compressed]);
    chunks.push(local);
    central.push(Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(0), u16(8), u16(dt.time), u16(dt.date), u32(crc), u32(compressed.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name]));
    offset += local.length;
  }
  const centralStart = offset;
  const centralBuffer = Buffer.concat(central);
  offset += centralBuffer.length;
  const eocd = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(centralBuffer.length), u32(centralStart), u16(0)]);
  await fs.promises.writeFile(destination, Buffer.concat([...chunks, centralBuffer, eocd]));
}

export async function zipCreateTool(args = {}, context = {}) {
  try {
    const source = resolveInsideTrustedRoots(args.source, context, { mustExist: true });
    const destination = resolveInsideTrustedRoots(args.destination, context);
    if (!args.overwrite && fs.existsSync(destination.path)) throw new Error('Destination exists; pass overwrite=true to replace it.');
    const exclude = defaultExcludePatterns(args.exclude || [], { includeGit: Boolean(args.includeGit) });
    if (!args.includeGit && !exclude.includes('.git/**')) exclude.push('.git/**');
    const include = args.include?.length ? args.include : ['**/*'];
    const files = await walkFiles(source.path, source.path, { include, exclude });
    const entries = files
      .map(file => ({ path: file, name: toRelativeFromRoot(file, source.path) }))
      .filter(entry => !shouldExclude(entry.name, exclude) && path.resolve(entry.path) !== path.resolve(destination.path));
    if (!args.dryRun) {
      await fs.promises.mkdir(path.dirname(destination.path), { recursive: true });
      await writeZip(destination.path, entries);
    }
    const bytes = args.dryRun ? 0 : (await fs.promises.stat(destination.path)).size;
    return ok('zip_create', args.dryRun ? 'Dry run completed; zip not created' : 'Created zip archive', { destination: toRelativeFromRoot(destination.path, destination.root), filesAdded: entries.length, bytes, includeGit: Boolean(args.includeGit), excluded: exclude });
  } catch (error) {
    return fail('zip_create', error.code || 'ZIP_ERROR', error.message, error.details || {});
  }
}
