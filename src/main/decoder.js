'use strict';

/**
 * Decoder: PNG chunks (loose files, folders, or Google Photos ZIPs) -> original data.
 *
 * Single pass: every PNG is decoded, its header validated and its payload
 * SHA-256 verified, then the payload is written at its final offset
 * (index × chunkLength) in a per-UUID temp file. Chunks may arrive in any
 * order. After all sources are consumed each group is checked for gaps, then
 * renamed to its final name, and wrapper ZIPs are optionally extracted.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { pipeline } = require('stream/promises');
const yauzl = require('yauzl');
const { HEADER_SIZE, sha256, readHeader } = require('./header');
const { decodePng, readMeta, isPng } = require('./pngio');
const { WRAPPER_COMMENT, safeName } = require('./encoder');

const WRAPPER_KINDS = new Set(['file', 'dir', 'multi']);

// ---------- yauzl helpers ----------

function openZip(zipPath, options) {
  return new Promise((resolve, reject) =>
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true, ...options }, (err, zf) => (err ? reject(err) : resolve(zf)))
  );
}

function openEntryStream(zf, entry) {
  return new Promise((resolve, reject) => zf.openReadStream(entry, (err, s) => (err ? reject(err) : resolve(s))));
}

/** Iterates every entry of a zip, awaiting the async handler before moving on. */
async function forEachEntry(zipPath, options, handler) {
  const zf = await openZip(zipPath, options);
  await new Promise((resolve, reject) => {
    let failed = false;
    const fail = (err) => {
      if (failed) return;
      failed = true;
      try {
        zf.close();
      } catch (_) {
        /* already closed */
      }
      reject(err);
    };
    zf.on('entry', (entry) => {
      Promise.resolve(handler(entry, zf)).then(() => zf.readEntry(), fail);
    });
    zf.on('end', () => !failed && resolve());
    zf.on('error', fail);
    zf.readEntry();
  });
  return zf;
}

const entryName = (entry) => (Buffer.isBuffer(entry.fileName) ? entry.fileName.toString('utf8') : entry.fileName);
const isPngEntry = (entry) => /\.png$/i.test(entryName(entry)) && !/\/$/.test(entryName(entry));

async function readEntryBuffer(zf, entry) {
  const stream = await openEntryStream(zf, entry);
  const parts = [];
  for await (const part of stream) parts.push(part);
  return Buffer.concat(parts);
}

// ---------- source discovery ----------

async function collectPngFiles(dir, out) {
  for (const ent of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) await collectPngFiles(full, out);
    else if (ent.isFile() && /\.png$/i.test(ent.name)) out.push(full);
  }
}

async function discoverSources(inputs) {
  const sources = [];
  for (const input of inputs) {
    const st = await fsp.stat(input);
    if (st.isDirectory()) {
      const pngs = [];
      await collectPngFiles(input, pngs);
      pngs.sort();
      for (const p of pngs) sources.push({ type: 'png', path: p, bytes: (await fsp.stat(p)).size });
    } else if (/\.zip$/i.test(input)) {
      let bytes = 0;
      let count = 0;
      await forEachEntry(input, { decodeStrings: false }, (entry) => {
        if (isPngEntry(entry)) {
          bytes += entry.compressedSize;
          count++;
        }
      });
      sources.push({ type: 'zip', path: input, bytes, count });
    } else {
      sources.push({ type: 'png', path: input, bytes: st.size });
    }
  }
  return sources;
}

// ---------- extraction ----------

async function uniquePath(p) {
  const { dir, name, ext } = path.parse(p);
  let candidate = p;
  for (let n = 1; ; n++) {
    try {
      await fsp.access(candidate);
    } catch {
      return candidate;
    }
    candidate = path.join(dir, `${name} (${n})${ext}`);
  }
}

async function zipComment(zipPath) {
  try {
    const zf = await openZip(zipPath, {});
    zf.close();
    return zf.comment || '';
  } catch {
    return null; // not a zip
  }
}

async function extractZip(zipPath, destDir, report) {
  // First pass: top-level names, to avoid overwriting existing files.
  const roots = new Set();
  let totalBytes = 0;
  await forEachEntry(zipPath, {}, (entry) => {
    roots.add(entry.fileName.split('/')[0]);
    totalBytes += entry.uncompressedSize;
  });

  let target = destDir;
  for (const r of roots) {
    try {
      await fsp.access(path.join(destDir, r));
      target = await uniquePath(path.join(destDir, `restored_${path.parse(zipPath).name}`));
      break;
    } catch {
      /* no conflict */
    }
  }
  await fsp.mkdir(target, { recursive: true });
  const root = path.resolve(target);

  let done = 0;
  await forEachEntry(zipPath, {}, async (entry, zf) => {
    const out = path.resolve(root, entry.fileName);
    if (out !== root && !out.startsWith(root + path.sep)) throw new Error(`Unsafe path in archive: ${entry.fileName}`);
    if (/\/$/.test(entry.fileName)) {
      await fsp.mkdir(out, { recursive: true });
      return;
    }
    await fsp.mkdir(path.dirname(out), { recursive: true });
    await pipeline(await openEntryStream(zf, entry), fs.createWriteStream(out));
    const mtime = entry.getLastModDate();
    await fsp.utimes(out, mtime, mtime).catch(() => {});
    done += entry.uncompressedSize;
    report(totalBytes ? done / totalBytes : 1, `Extracting ${entry.fileName}`);
  });

  return {
    extractedTo: root,
    paths: [...roots].map((r) => path.join(root, r)),
    bytes: totalBytes,
  };
}

// ---------- main ----------

/**
 * @param {object} opts
 * @param {string[]} opts.inputs       ZIP files, PNG files and/or folders of PNGs
 * @param {string}   opts.outputDir
 * @param {boolean}  [opts.autoExtract=true]
 * @param {object}   hooks  { onProgress({stage,message,percent}), onTempFile(path) }
 */
async function decode(opts, hooks = {}) {
  const onProgress = hooks.onProgress || (() => {});
  const onTempFile = hooks.onTempFile || (() => {});
  const inputs = (opts.inputs || []).map((p) => path.resolve(p));
  if (inputs.length === 0) throw new Error('No input selected');
  if (!opts.outputDir) throw new Error('No output destination selected');
  const autoExtract = opts.autoExtract !== false;
  const outputDir = path.resolve(opts.outputDir);
  await fsp.mkdir(outputDir, { recursive: true });

  onProgress({ stage: 'scan', message: 'Scanning chunks...', percent: 0 });
  const sources = await discoverSources(inputs);
  const totalBytes = sources.reduce((s, x) => s + x.bytes, 0) || 1;
  const totalImages = sources.reduce((s, x) => s + (x.type === 'zip' ? x.count : 1), 0);
  if (totalImages === 0) throw new Error('No PNG files found in the selected input');

  const SCAN_WEIGHT = 0.85;
  let bytesSeen = 0;
  let imagesSeen = 0;
  let skipped = 0;
  const warnings = [];
  const groups = new Map();

  const pct = () => (bytesSeen / totalBytes) * SCAN_WEIGHT * 100;

  async function writeAt(group, buf, position) {
    let off = 0;
    while (off < buf.length) {
      const { bytesWritten } = await group.fh.write(buf, off, buf.length - off, position + off);
      off += bytesWritten;
    }
  }

  async function processPng(buf, label) {
    imagesSeen++;
    onProgress({ stage: 'scan', message: `Reading image ${imagesSeen} of ${totalImages}...`, percent: pct() });
    if (!isPng(buf)) return void skipped++;
    const pixels = decodePng(buf);
    const h = pixels && readHeader(pixels);
    if (!h) return void skipped++; // not a Bin2PNG chunk (e.g. a regular photo)

    let group = groups.get(h.uuidString);
    if (!group) {
      const tmpPath = path.join(outputDir, `.bin2png-${h.uuidString.slice(0, 8)}.part`);
      onTempFile(tmpPath);
      group = {
        uuid: h.uuidString,
        total: h.total,
        meta: null,
        chunkLength: null,
        lastLength: null,
        pendingLast: null,
        received: new Set(),
        corrupt: new Set(),
        tmpPath,
        fh: await fsp.open(tmpPath, 'w+'),
      };
      groups.set(h.uuidString, group);
    }
    if (h.total !== group.total) {
      warnings.push(`${label}: chunk count mismatch for ${group.uuid} (ignored)`);
      return;
    }
    if (group.received.has(h.index)) return; // duplicate of an already verified chunk

    onProgress({
      stage: 'verify',
      message: `Verifying SHA-256 checksum for chunk ${h.index + 1} of ${h.total}...`,
      percent: pct(),
    });
    const payload = pixels.subarray(HEADER_SIZE, HEADER_SIZE + h.payloadLength);
    if (!sha256(payload).equals(h.checksum)) {
      group.corrupt.add(h.index);
      warnings.push(`${label}: SHA-256 mismatch on chunk ${h.index + 1} of ${h.total} — image was altered`);
      return;
    }
    group.corrupt.delete(h.index);
    if (!group.meta) group.meta = readMeta(buf);

    onProgress({ stage: 'write', message: `Writing chunk ${h.index + 1} of ${h.total}...`, percent: pct() });
    const isLast = h.index === h.total - 1;
    if (!isLast) {
      if (group.chunkLength === null) group.chunkLength = h.payloadLength;
      else if (group.chunkLength !== h.payloadLength) {
        throw new Error(`Inconsistent chunk sizes in archive ${group.uuid}`);
      }
      await writeAt(group, payload, h.index * group.chunkLength);
      if (group.pendingLast) {
        await writeAt(group, group.pendingLast, (group.total - 1) * group.chunkLength);
        group.pendingLast = null;
      }
    } else {
      group.lastLength = h.payloadLength;
      if (h.total === 1) await writeAt(group, payload, 0);
      else if (group.chunkLength !== null) await writeAt(group, payload, h.index * group.chunkLength);
      else group.pendingLast = Buffer.from(payload);
    }
    group.received.add(h.index);
  }

  try {
    for (const src of sources) {
      if (src.type === 'png') {
        await processPng(await fsp.readFile(src.path), path.basename(src.path));
        bytesSeen += src.bytes;
      } else {
        await forEachEntry(src.path, { decodeStrings: false }, async (entry, zf) => {
          if (!isPngEntry(entry)) return;
          await processPng(await readEntryBuffer(zf, entry), entryName(entry));
          bytesSeen += entry.compressedSize;
        });
      }
    }

    if (groups.size === 0) {
      throw new Error(`No Bin2PNG chunks found (${skipped} unrelated image(s) skipped)`);
    }

    // ---------- finalize each archive ----------
    onProgress({ stage: 'reconstruct', message: 'Reconstructing file...', percent: SCAN_WEIGHT * 100 });
    const restored = [];
    const failed = [];
    let gi = 0;
    for (const group of groups.values()) {
      const base = (SCAN_WEIGHT + (1 - SCAN_WEIGHT) * (gi / groups.size)) * 100;
      const span = ((1 - SCAN_WEIGHT) / groups.size) * 100;
      gi++;
      const missing = [];
      for (let i = 0; i < group.total; i++) if (!group.received.has(i)) missing.push(i + 1);
      const name = group.meta && typeof group.meta.name === 'string' ? group.meta.name : null;

      if (missing.length) {
        await group.fh.close();
        await fsp.rm(group.tmpPath, { force: true });
        failed.push({
          uuid: group.uuid,
          name,
          total: group.total,
          missing,
          corrupt: [...group.corrupt].map((i) => i + 1),
        });
        continue;
      }

      const size = group.total === 1 ? group.lastLength : (group.total - 1) * group.chunkLength + group.lastLength;
      await group.fh.truncate(size);
      await group.fh.close();

      onProgress({ stage: 'reconstruct', message: `Reconstructing ${name || group.uuid}...`, percent: base });
      const comment = await zipComment(group.tmpPath);
      const isZip = comment !== null;
      const kind = group.meta?.kind;
      const isWrapper = isZip && (comment.startsWith(WRAPPER_COMMENT) || WRAPPER_KINDS.has(kind));

      const result = {
        uuid: group.uuid,
        name: name || null,
        chunks: group.total,
        bytes: size,
        integrity: `All ${group.total} chunk(s) passed SHA-256 verification`,
        extracted: false,
      };

      if (isWrapper && autoExtract) {
        onProgress({ stage: 'extract', message: 'Extracting archive...', percent: base + span * 0.2 });
        const ex = await extractZip(group.tmpPath, outputDir, (f, msg) =>
          onProgress({ stage: 'extract', message: msg, percent: base + span * (0.2 + 0.8 * f) })
        );
        await fsp.rm(group.tmpPath, { force: true });
        Object.assign(result, {
          extracted: true,
          path: ex.paths.length === 1 ? ex.paths[0] : ex.extractedTo,
          paths: ex.paths,
          extractedBytes: ex.bytes,
          name: name || path.basename(ex.paths[0] || ex.extractedTo),
        });
      } else {
        let fileName;
        if (name && kind === 'zip') fileName = safeName(name);
        else if (name && isWrapper) fileName = `${safeName(name)}.zip`;
        else fileName = `restored_${group.uuid.slice(0, 8)}${isZip ? '.zip' : '.bin'}`;
        const finalPath = await uniquePath(path.join(outputDir, fileName));
        await fsp.rename(group.tmpPath, finalPath);
        Object.assign(result, { path: finalPath, name: path.basename(finalPath) });
      }
      restored.push(result);
    }

    const ok = failed.length === 0;
    onProgress({
      stage: 'done',
      message: ok ? 'Restore complete' : `Restored ${restored.length}, failed ${failed.length}`,
      percent: 100,
    });
    return { outputDir, restored, failed, skipped, warnings: warnings.slice(0, 50) };
  } finally {
    for (const g of groups.values()) {
      await g.fh.close().catch(() => {});
      await fsp.rm(g.tmpPath, { force: true }).catch(() => {});
    }
  }
}

module.exports = { decode };
