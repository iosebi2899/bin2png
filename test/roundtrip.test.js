'use strict';

/* Round-trip tests for the encoder/decoder (plain Node, no Electron needed). */

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const archiver = require('archiver');
const { PNG } = require('pngjs');
const { encode } = require('../src/main/encoder');
const { decode } = require('../src/main/decoder');

const hashFile = async (p) => crypto.createHash('sha256').update(await fsp.readFile(p)).digest('hex');

async function hashTree(dir, base = dir, out = {}) {
  for (const ent of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    const rel = path.relative(base, full).split(path.sep).join('/');
    if (ent.isDirectory()) {
      out[rel + '/'] = 'dir';
      await hashTree(full, base, out);
    } else out[rel] = await hashFile(full);
  }
  return out;
}

function zipFiles(dest, entries) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest);
    const a = archiver('zip', { zlib: { level: 1 } });
    out.on('close', resolve);
    a.on('error', reject);
    a.pipe(out);
    for (const [name, src] of entries) a.file(src, { name });
    a.finalize();
  });
}

async function main() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'bin2png-test-'));
  const tests = [];
  const test = (name, fn) => tests.push({ name, fn });

  // Fixture: folder with nested dirs, binary + text + empty files, unicode name.
  const src = path.join(root, 'My Folder ✓');
  await fsp.mkdir(path.join(src, 'sub', 'deeper'), { recursive: true });
  await fsp.writeFile(path.join(src, 'random.bin'), crypto.randomBytes(3.5 * 1024 * 1024 + 13));
  await fsp.writeFile(path.join(src, 'sub', 'notes.txt'), 'hello world\n'.repeat(5000));
  await fsp.writeFile(path.join(src, 'sub', 'deeper', 'empty.dat'), Buffer.alloc(0));
  const single = path.join(root, 'video.mp4');
  await fsp.writeFile(single, crypto.randomBytes(2 * 1024 * 1024 + 7));
  const rawZip = path.join(root, 'already.zip');
  await zipFiles(rawZip, [['a/random.bin', path.join(src, 'random.bin')]]);

  const srcTree = await hashTree(src);

  test('folder -> PNGs -> folder (auto-extract)', async () => {
    const pngDir = path.join(root, 'folder_png');
    const enc = await encode({ inputs: [src], outputDir: pngDir, chunkSizeMB: 1 });
    assert.strictEqual(enc.kind, 'dir');
    assert.ok(enc.chunks >= 4, `expected >=4 chunks, got ${enc.chunks}`);
    assert.strictEqual((await fsp.readdir(pngDir)).length, enc.chunks, 'no temp files left behind');
    const out = path.join(root, 'folder_out');
    const dec = await decode({ inputs: [pngDir], outputDir: out, autoExtract: true });
    assert.strictEqual(dec.failed.length, 0);
    assert.strictEqual(dec.restored[0].extracted, true);
    assert.deepStrictEqual(await hashTree(path.join(out, 'My Folder ✓')), srcTree);
    assert.deepStrictEqual(await fsp.readdir(out), ['My Folder ✓'], 'no temp files left behind');
    // Decoding again into the same folder must not overwrite.
    const dec2 = await decode({ inputs: [pngDir], outputDir: out, autoExtract: true });
    assert.notStrictEqual(dec2.restored[0].path, dec.restored[0].path);
    return enc;
  });

  test('single file -> PNGs -> wrapper zip (no extract) and file (extract)', async () => {
    const pngDir = path.join(root, 'single_png');
    const enc = await encode({ inputs: [single], outputDir: pngDir, chunkSizeMB: 1, deflateLevel: 1 });
    assert.strictEqual(enc.kind, 'file');
    const out1 = path.join(root, 'single_out_zip');
    const d1 = await decode({ inputs: [pngDir], outputDir: out1, autoExtract: false });
    assert.strictEqual(d1.restored[0].name, 'video.mp4.zip');
    const out2 = path.join(root, 'single_out');
    const d2 = await decode({ inputs: [pngDir], outputDir: out2, autoExtract: true });
    assert.strictEqual(await hashFile(path.join(out2, 'video.mp4')), await hashFile(single));
    assert.strictEqual(d2.restored[0].path, path.join(out2, 'video.mp4'));
  });

  test('raw .zip is chunked as-is and restored byte-identical', async () => {
    const pngDir = path.join(root, 'zip_png');
    const enc = await encode({ inputs: [rawZip], outputDir: pngDir, chunkSizeMB: 1 });
    assert.strictEqual(enc.kind, 'zip');
    assert.strictEqual(enc.sourceBytes, (await fsp.stat(rawZip)).size);
    const out = path.join(root, 'zip_out');
    const dec = await decode({ inputs: [pngDir], outputDir: out, autoExtract: true });
    assert.strictEqual(dec.restored[0].extracted, false);
    assert.strictEqual(dec.restored[0].name, 'already.zip');
    assert.strictEqual(await hashFile(dec.restored[0].path), await hashFile(rawZip));
  });

  test('Google Photos style ZIP: renamed, shuffled, mixed with other files, two archives', async () => {
    const aDir = path.join(root, 'gp_a');
    const bDir = path.join(root, 'gp_b');
    await encode({ inputs: [single], outputDir: aDir, chunkSizeMB: 1 });
    await encode({ inputs: [rawZip], outputDir: bDir, chunkSizeMB: 1 });
    const entries = [];
    let n = 0;
    for (const d of [aDir, bDir]) {
      for (const f of await fsp.readdir(d)) entries.push([`Takeout/Google Photos/IMG_${1000 + n++}.PNG`, path.join(d, f)]);
    }
    entries.sort(() => Math.random() - 0.5);
    // A regular (non-bin2png) PNG and a JSON sidecar.
    const photo = new PNG({ width: 16, height: 16 });
    photo.data.fill(200);
    const photoPath = path.join(root, 'photo.png');
    await fsp.writeFile(photoPath, PNG.sync.write(photo));
    const jsonPath = path.join(root, 'meta.json');
    await fsp.writeFile(jsonPath, '{}');
    entries.push(['Takeout/Google Photos/holiday.png', photoPath], ['Takeout/Google Photos/IMG_1000.PNG.json', jsonPath]);
    const gpZip = path.join(root, 'Photos.zip');
    await zipFiles(gpZip, entries);

    const out = path.join(root, 'gp_out');
    const dec = await decode({ inputs: [gpZip], outputDir: out, autoExtract: true });
    assert.strictEqual(dec.failed.length, 0);
    assert.strictEqual(dec.restored.length, 2);
    assert.strictEqual(dec.skipped, 1);
    assert.strictEqual(await hashFile(path.join(out, 'video.mp4')), await hashFile(single));
    assert.strictEqual(await hashFile(path.join(out, 'already.zip')), await hashFile(rawZip));
  });

  test('corrupted pixel and missing chunk are detected', async () => {
    const pngDir = path.join(root, 'bad_png');
    await encode({ inputs: [single], outputDir: pngDir, chunkSizeMB: 1 });
    const files = (await fsp.readdir(pngDir)).sort();
    // Flip one payload byte in chunk 2 and re-encode it as a valid PNG.
    const p2 = path.join(pngDir, files[1]);
    const img = PNG.sync.read(await fsp.readFile(p2));
    img.data[500] ^= 0xff;
    await fsp.writeFile(p2, PNG.sync.write(img, { colorType: 6 }));
    // Delete chunk 3.
    await fsp.rm(path.join(pngDir, files[2]));
    const out = path.join(root, 'bad_out');
    const dec = await decode({ inputs: [pngDir], outputDir: out });
    assert.strictEqual(dec.restored.length, 0);
    assert.strictEqual(dec.failed.length, 1);
    assert.deepStrictEqual(dec.failed[0].missing, [2, 3]);
    assert.deepStrictEqual(dec.failed[0].corrupt, [2]);
    assert.deepStrictEqual(await fsp.readdir(out), [], 'temp file removed');
  });

  test('works when PNG metadata (iTXt) is stripped', async () => {
    const pngDir = path.join(root, 'strip_png');
    await encode({ inputs: [src], outputDir: pngDir, chunkSizeMB: 2 });
    for (const f of await fsp.readdir(pngDir)) {
      // Re-encode from pixels only: drops every ancillary chunk.
      const img = PNG.sync.read(await fsp.readFile(path.join(pngDir, f)));
      await fsp.writeFile(path.join(pngDir, f), PNG.sync.write(img, { colorType: 6 }));
    }
    const out = path.join(root, 'strip_out');
    const dec = await decode({ inputs: [pngDir], outputDir: out, autoExtract: true });
    assert.strictEqual(dec.restored[0].extracted, true, 'wrapper detected via ZIP comment');
    assert.deepStrictEqual(await hashTree(path.join(out, 'My Folder ✓')), srcTree);
  });

  test('empty file round-trips', async () => {
    const empty = path.join(root, 'empty.txt');
    await fsp.writeFile(empty, '');
    const pngDir = path.join(root, 'empty_png');
    const enc = await encode({ inputs: [empty], outputDir: pngDir });
    assert.strictEqual(enc.chunks, 1);
    const out = path.join(root, 'empty_out');
    await decode({ inputs: [pngDir], outputDir: out });
    assert.strictEqual((await fsp.stat(path.join(out, 'empty.txt'))).size, 0);
  });

  test('output inside the source folder is rejected', async () => {
    await assert.rejects(encode({ inputs: [src], outputDir: path.join(src, 'out') }), /cannot be inside/);
  });

  let failures = 0;
  for (const t of tests) {
    const start = Date.now();
    try {
      await t.fn();
      console.log(`  ✔ ${t.name} (${Date.now() - start} ms)`);
    } catch (err) {
      failures++;
      console.error(`  ✘ ${t.name}\n    ${err.stack}`);
    }
  }
  await fsp.rm(root, { recursive: true, force: true });
  console.log(failures ? `\n${failures} test(s) failed` : `\nAll ${tests.length} tests passed`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
