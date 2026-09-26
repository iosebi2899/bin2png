# Bin2PNG Studio

A desktop app (Electron) that converts **any file or folder** into PNG images you can store in Google Photos, and restores the exact original from those PNGs. It also restores straight from the `.zip` you download from Google Photos. The conversion is lossless both ways, and every chunk is checked with SHA-256.

It ships as a portable executable: double-click it and it runs. Nothing to install, and no Node.js or npm needed.

---

## Usage

### Encode (file/folder → PNG chunks)
1. Drop a file or folder onto the drop zone, or use **Browse File…** / **Browse Folder…**.
2. Pick a **chunk size**. The default is 30 MB and the maximum is 180 MB, because Google Photos rejects images over 200 MB.
3. Optionally change the **PNG compression** level. This only affects speed and PNG size; the output is lossless either way.
4. Check the **output directory**. It defaults to `<source_name>_png_chunks/` next to the source.
5. Click **Convert to PNGs**. Once it finishes, use **Reveal in Explorer/Finder**.

Upload the resulting PNGs to Google Photos. Use *Original quality*, not *Storage saver*. Storage saver re-compresses images and destroys the data, and the decoder will report that as a checksum failure.

### Decode (PNGs / Google Photos ZIP → original)
1. Drop in, or browse to, any mix of:
   - a Google Photos download ZIP (e.g. `Photos.zip`, including Takeout parts),
   - a folder containing the `.png` chunks (subfolders are scanned),
   - individual `.png` files.
2. Leave **Auto-extract** checked to get the original folder or file back. Uncheck it to keep the intermediate `.zip`.
3. Choose the **output destination** and click **Restore Original File**.

File names don't matter, since Google Photos renames uploads. Chunks may be in any order, and unrelated photos in the ZIP are skipped. If several encoded archives are mixed together, each one is restored separately. If chunks are missing or altered, the app lists exactly which ones.

---

## Building

Requirements (for building only): Node.js 18+ and npm.

```bash
npm install
npm start            # run in development
npm test             # encoder/decoder round-trip tests (plain Node)
npm run dist         # build for the current OS
```

Platform-specific targets:

| Command              | Output                                      |
|----------------------|---------------------------------------------|
| `npm run dist:win`   | `dist/bin2png-portable.exe` (single-file portable) |
| `npm run dist:mac`   | `dist/mac*/Bin2PNG Studio.app` + zip        |
| `npm run dist:linux` | `dist/bin2png-<version>-<arch>.AppImage`    |

Build each platform on that OS. macOS builds are unsigned, so on first launch right-click the app → **Open**.

---

## How it works

### Encoding pipeline
- **Folder, non-zip file, or multiple items:** these are packed into a *stored* (uncompressed) wrapper ZIP using `archiver`. That keeps names and directory structure, and the PNG deflate step handles compression. The wrapper carries the ZIP comment `BIN2PNG-WRAPPER v1`, which is how the decoder knows it can auto-extract it. The wrapper is written as a temp file in the output folder and deleted afterwards. This step is needed because every chunk header records the total chunk count, and that isn't known until the archive is complete.
- **Existing `.zip`:** chunked as-is, with no re-compression.
- Data is read one chunk at a time, so memory use stays around 2–3× the chunk size regardless of input size (20 GB+ is fine).
- Each chunk becomes a square 8-bit RGBA PNG: `side = ceil(sqrt(ceil((72 + payload) / 4)))`. Trailing bytes are padded with `0x00`.

### Chunk header (first 72 bytes of the pixel buffer)

| Bytes  | Field                                   |
|--------|-----------------------------------------|
| 0–7    | Magic `BIN2PNG\0`                       |
| 8–23   | File UUID (same for all chunks)         |
| 24–27  | Chunk index, `UInt32BE`, 0-based        |
| 28–31  | Total chunks, `UInt32BE`                |
| 32–39  | Payload length, `BigUInt64BE`           |
| 40–71  | SHA-256 of this chunk's payload         |
| 72+    | Payload, then zero padding              |

Each PNG also carries a small `iTXt` chunk (`bin2png`) holding the original name, so restored files keep their name. It is optional: if it gets stripped, restoring still works, and wrapper detection falls back to the ZIP comment.

### Decoding pipeline
- Google Photos ZIPs are read with `yauzl`, one PNG entry at a time, without unpacking the ZIP to disk.
- Each image is decoded, and its magic, header and payload SHA-256 are verified. Its payload is then written straight to its final offset (`index × chunkLength`) in a temp file. This is a single pass, and order doesn't matter.
- After all inputs are read, each UUID group is checked for gaps. The file is then truncated to its exact size, renamed, and optionally extracted. Extraction guards against zip-slip and never overwrites existing files.

### Architecture & security
- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. The renderer reaches only the small API exposed in `src/preload/preload.js`.
- All heavy work (archiving, PNG encode/decode, hashing, extraction) runs in a separate **Electron `utilityProcess`** (`src/main/worker.js`), so the UI never freezes. Cancelling kills the worker and removes its temp files.

```
src/
  main/
    main.js      window, dialogs, IPC, worker lifecycle
    worker.js    utilityProcess entry: runs encode/decode, streams progress
    encoder.js   file/folder → PNG chunks
    decoder.js   PNGs / ZIPs → original, verification, extraction
    header.js    72-byte binary header read/write
    pngio.js     pngjs wrapper + iTXt metadata
  preload/
    preload.js   contextBridge API
  renderer/
    index.html, styles.css, app.js
test/
  roundtrip.test.js
```

## Limits & notes
- Encoding a folder or non-zip file temporarily needs free disk space about equal to the input size in the output folder, for the wrapper ZIP.
- Google Photos limits: 200 MB per image and 150 MP. A 180 MB chunk is about 47 MP, so the chunk size cap keeps you under both.
- Use *Original quality* uploads. Any re-encoding by the cloud service is detected by the checksums, but the data in that chunk can't be recovered.
