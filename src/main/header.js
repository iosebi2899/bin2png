'use strict';

/**
 * Binary header embedded in the first 72 bytes of every PNG chunk's RGBA pixel buffer.
 *
 *   0–7    Magic "BIN2PNG\0"
 *   8–23   File UUID (16 bytes, shared by all chunks of one archive)
 *   24–27  Chunk index (UInt32BE, 0-based)
 *   28–31  Total chunks (UInt32BE)
 *   32–39  Payload length (BigUInt64BE, excludes header and padding)
 *   40–71  SHA-256 of this chunk's payload
 *   72+    Payload, then zero padding
 */

const crypto = require('crypto');

const MAGIC = Buffer.from('BIN2PNG\0', 'utf8');
const HEADER_SIZE = 72;

function newUuid() {
  return Buffer.from(crypto.randomUUID().replace(/-/g, ''), 'hex');
}

function uuidToString(buf) {
  const h = buf.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest();
}

/** Writes the header into `target` at offset 0. */
function writeHeader(target, { uuid, index, total, payloadLength, checksum }) {
  if (uuid.length !== 16) throw new Error('UUID must be 16 bytes');
  if (checksum.length !== 32) throw new Error('Checksum must be 32 bytes');
  MAGIC.copy(target, 0);
  uuid.copy(target, 8);
  target.writeUInt32BE(index, 24);
  target.writeUInt32BE(total, 28);
  target.writeBigUInt64BE(BigInt(payloadLength), 32);
  checksum.copy(target, 40);
  return target;
}

/** Returns the parsed header, or null if the buffer is not a Bin2PNG chunk. */
function readHeader(buf) {
  if (!buf || buf.length < HEADER_SIZE) return null;
  if (!buf.subarray(0, 8).equals(MAGIC)) return null;
  const uuid = Buffer.from(buf.subarray(8, 24));
  const index = buf.readUInt32BE(24);
  const total = buf.readUInt32BE(28);
  const payloadLength = buf.readBigUInt64BE(32);
  const checksum = Buffer.from(buf.subarray(40, 72));
  if (total === 0 || index >= total) return null;
  if (payloadLength > BigInt(buf.length - HEADER_SIZE)) return null;
  return {
    uuid,
    uuidString: uuidToString(uuid),
    index,
    total,
    payloadLength: Number(payloadLength),
    checksum,
  };
}

/** Side length of the square RGBA image needed to hold header + payload. */
function sideForPayload(payloadLength) {
  const pixelsNeeded = Math.ceil((HEADER_SIZE + payloadLength) / 4);
  return Math.max(1, Math.ceil(Math.sqrt(pixelsNeeded)));
}

module.exports = {
  MAGIC,
  HEADER_SIZE,
  newUuid,
  uuidToString,
  sha256,
  writeHeader,
  readHeader,
  sideForPayload,
};
