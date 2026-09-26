'use strict';

/**
 * Encoder: file/folder -> PNG chunks.
 *
 * - A single .zip input is chunked as-is (no re-compression).
 * - Anything else (folder, non-zip file, multiple items) is first packed into a
 *   stored (uncompressed) wrapper ZIP in the output directory, because every
 *   chunk header needs the final chunk count before the first PNG is written.
 *   The wrapper ZIP carries a comment so the decoder can auto-extract it.
 * - Data is read one chunk at a time, so memory use is bounded by chunk size.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const archiver = require('archiver');
const { HEADER_SIZE, newUuid, uuidToString, sha256, writeHeader, sideForPayload } = require('./header');
const { encodePng } = require('./pngio');

const WRAPPER_COMMENT = 'BIN2PNG-WRAPPER v1';
const MB = 1024 * 1024;
const MAX_CHUNK_MB = 180; // Google Photos rejects images over 200 MB

function safeName(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '') || 'file';
}

async function totalSize(p) {
  const st = await fsp.lstat(p);
  if (st.isSymbolicLink()) return 0;
  if (!st.isDirectory()) return st.size;
  let sum = 0;
  for (const ent of await fsp.readdir(p, { withFileTypes: true })) {
    sum += await totalSize(path.join(p, ent.name));
  }
  return sum;
}

async function readFully(fh, target, offset, length, position) {
  let done = 0;
  while (done < length) {
    const { bytesRead } = await fh.read(target, offset + done, length - done, position + done);
    if (bytesRead === 0) throw new Error('Unexpected end of file while reading source');
    done += bytesRead;
  }
}

function buildWrapperZip(inputs, dest, totalBytes, report) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest);
    const archive = archiver('zip', { store: true, comment: WRAPPER_COMMENT });
    let failed = false;
    const fail = (err) => {
      if (failed) return;
      failed = true;
      archive.abort();
      out.destroy();
      reject(err);
    };
    archive.on('warning', (err) => {
      if (err.code !== 'ENOENT') fail(err);
    });
    archive.on('error', fail);
    archive.on('progress', (p) => {
      const frac = totalBytes > 0 ? Math.min(1, p.fs.processedBytes / totalBytes) : 1;
      report(frac, `Archiving... ${p.entries.processed} item(s), ${(p.fs.processedBytes / MB).toFixed(1)} MB`);
    });
    out.on('error', fail);
    out.on('close', () => {
      if (!failed) resolve();
    });
    archive.pipe(out);

    (async () => {
      for (const input of inputs) {
        const st = await fsp.stat(input);
        const base = path.basename(input);
        if (st.isDirectory()) archive.directory(input, base);
        else archive.file(input, { name: base });
      }
      await archive.finalize();
    })().catch(fail);
  });
}

/**
 * @param {object} opts
 * @param {string[]} opts.inputs     Files and/or folders to encode
 * @param {string}   opts.outputDir  Destination folder for PNG chunks
 * @param {number}   [opts.chunkSizeMB=30]
 * @param {number}   [opts.deflateLevel=6]  PNG zlib level (0-9)
 * @param {object}   hooks  { onProgress({stage,message,percent}), onTempFile(path) }
 */
async function encode(opts, hooks = {}) {
  const onProgress = hooks.onProgress || (() => {});
  const onTempFile = hooks.onTempFile || (() => {});
  const inputs = (opts.inputs || []).map((p) => path.resolve(p));
  if (inputs.length === 0) throw new Error('No input selected');
  if (!opts.outputDir) throw new Error('No output directory selected');

  const chunkSizeMB = Math.min(MAX_CHUNK_MB, Math.max(1, Number(opts.chunkSizeMB) || 30));
  const chunkBytes = Math.floor(chunkSizeMB * MB);
  const deflateLevel = Math.min(9, Math.max(0, Math.round(Number(opts.deflateLevel ?? 6))));
  const outputDir = path.resolve(opts.outputDir);
  for (const input of inputs) {
    const rel = path.relative(input, outputDir);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
      throw new Error('The output directory cannot be inside the folder being encoded');
    }
  }
  await fsp.mkdir(outputDir, { recursive: true });

  const uuid = newUuid();
  const uuidStr = uuidToString(uuid);
  const shortId = uuidStr.slice(0, 8);

  const firstStat = await fsp.stat(inputs[0]);
  const isRawZip = inputs.length === 1 && firstStat.isFile() && /\.zip$/i.test(inputs[0]);

  let sourcePath;
  let tempZip = null;
  let kind;
  let name;
  let archiveWeight = 0;

  if (isRawZip) {
    sourcePath = inputs[0];
    kind = 'zip';
    name = path.basename(inputs[0]);
  } else {
    kind = inputs.length > 1 ? 'multi' : firstStat.isDirectory() ? 'dir' : 'file';
    name = inputs.length > 1 ? `bin2png_bundle_${shortId}` : path.basename(inputs[0]);
    archiveWeight = 0.35;
    onProgress({ stage: 'archive', message: 'Measuring input...', percent: 0 });
    let bytes = 0;
    for (const p of inputs) bytes += await totalSize(p);
    tempZip = path.join(outputDir, `.bin2png-${shortId}.tmp.zip`);
    onTempFile(tempZip);
    onProgress({ stage: 'archive', message: 'Archiving...', percent: 0 });
    await buildWrapperZip(inputs, tempZip, bytes, (frac, message) =>
      onProgress({ stage: 'archive', message, percent: frac * archiveWeight * 100 })
    );
    sourcePath = tempZip;
  }

  try {
    const size = (await fsp.stat(sourcePath)).size;
    const total = Math.max(1, Math.ceil(size / chunkBytes));
    const pad = String(total).length;
    const baseName = safeName(name);
    const meta = { v: 1, name, kind, size };
    const files = [];

    const fh = await fsp.open(sourcePath, 'r');
    try {
      for (let i = 0; i < total; i++) {
        const pct = (step) => (archiveWeight + (1 - archiveWeight) * ((i + step) / total)) * 100;
        const position = i * chunkBytes;
        const payloadLength = Math.min(chunkBytes, size - position);
        const side = sideForPayload(payloadLength);

        onProgress({ stage: 'read', message: `Reading chunk ${i + 1} of ${total}...`, percent: pct(0) });
        const pixels = Buffer.alloc(side * side * 4); // zero-filled = padding
        await readFully(fh, pixels, HEADER_SIZE, payloadLength, position);
        const checksum = sha256(pixels.subarray(HEADER_SIZE, HEADER_SIZE + payloadLength));
        writeHeader(pixels, { uuid, index: i, total, payloadLength, checksum });

        onProgress({ stage: 'encode', message: `Encoding chunk ${i + 1} of ${total} (${side}×${side} px)...`, percent: pct(0.1) });
        const png = encodePng(pixels, side, { deflateLevel, meta });

        onProgress({ stage: 'write', message: `Writing PNG ${i + 1} of ${total}...`, percent: pct(0.9) });
        const fileName = `${baseName}_${shortId}_${String(i + 1).padStart(pad, '0')}of${total}.png`;
        const outPath = path.join(outputDir, fileName);
        onTempFile(outPath); // an incomplete chunk set is useless: removed if cancelled
        files.push(outPath);
        await fsp.writeFile(outPath, png);
      }
    } catch (err) {
      await Promise.all(files.map((f) => fsp.rm(f, { force: true }).catch(() => {})));
      throw err;
    } finally {
      await fh.close();
    }

    onProgress({ stage: 'done', message: `Done — ${total} chunk(s) created`, percent: 100 });
    return { uuid: uuidStr, name, kind, sourceBytes: size, chunks: total, chunkSizeMB, outputDir, files };
  } finally {
    if (tempZip) await fsp.rm(tempZip, { force: true }).catch(() => {});
  }
}

module.exports = { encode, WRAPPER_COMMENT, MAX_CHUNK_MB, safeName };
