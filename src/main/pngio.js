'use strict';

/**
 * PNG encode/decode helpers around pngjs, plus a small iTXt metadata chunk
 * ("bin2png") that carries the original name as a best-effort hint. The
 * authoritative data always lives in the pixel header; the iTXt chunk is only
 * used for naming the restored output.
 */

const { PNG } = require('pngjs');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const META_KEYWORD = 'bin2png';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function buildChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function buildMetaChunk(meta) {
  // iTXt: keyword \0 compressionFlag compressionMethod languageTag \0 translatedKeyword \0 text
  const data = Buffer.concat([
    Buffer.from(META_KEYWORD, 'latin1'),
    Buffer.from([0, 0, 0, 0, 0]),
    Buffer.from(JSON.stringify(meta), 'utf8'),
  ]);
  return buildChunk('iTXt', data);
}

/** Encodes a side×side RGBA pixel buffer into a PNG file buffer. */
function encodePng(pixels, side, { deflateLevel = 6, meta = null } = {}) {
  const png = PNG.sync.write(
    { width: side, height: side, data: pixels },
    {
      colorType: 6,
      inputColorType: 6,
      bitDepth: 8,
      inputHasAlpha: true,
      filterType: 0,
      deflateLevel,
    }
  );
  if (!meta) return png;
  // Insert the iTXt chunk right after IHDR (8-byte signature + 25-byte IHDR chunk).
  const ihdrEnd = 8 + 25;
  return Buffer.concat([png.subarray(0, ihdrEnd), buildMetaChunk(meta), png.subarray(ihdrEnd)]);
}

function isPng(buf) {
  return buf && buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE);
}

/** Extracts the bin2png iTXt metadata, if present. Never throws. */
function readMeta(buf) {
  try {
    let off = 8;
    while (off + 12 <= buf.length) {
      const len = buf.readUInt32BE(off);
      const type = buf.toString('ascii', off + 4, off + 8);
      if (type === 'IDAT' || type === 'IEND') break;
      if (type === 'iTXt') {
        const data = buf.subarray(off + 8, off + 8 + len);
        const kwEnd = data.indexOf(0);
        if (data.toString('latin1', 0, kwEnd) === META_KEYWORD && data[kwEnd + 1] === 0) {
          let p = kwEnd + 3;
          p = data.indexOf(0, p) + 1; // language tag
          p = data.indexOf(0, p) + 1; // translated keyword
          return JSON.parse(data.toString('utf8', p));
        }
      }
      off += 12 + len;
    }
  } catch (_) {
    /* ignore malformed metadata */
  }
  return null;
}

/**
 * Decodes a PNG into its raw RGBA buffer. Returns null for PNGs that cannot
 * carry Bin2PNG data (wrong color type / bit depth) or fail to decode.
 */
function decodePng(buf) {
  if (!isPng(buf)) return null;
  // IHDR: width(4) height(4) bitDepth(1) colorType(1) at offset 16
  if (buf.length < 33 || buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  const bitDepth = buf[24];
  const colorType = buf[25];
  if (bitDepth !== 8 || colorType !== 6) return null;
  try {
    const png = PNG.sync.read(buf);
    return png.data;
  } catch (_) {
    return null;
  }
}

module.exports = { encodePng, decodePng, readMeta, isPng };
