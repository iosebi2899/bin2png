'use strict';

/**
 * Background worker, launched by the main process via Electron's
 * utilityProcess so encoding/decoding/hashing never blocks the UI.
 *
 * Protocol (parentPort messages):
 *   in:  { job: 'encode' | 'decode', options }
 *   out: { type: 'progress', stage, message, percent }
 *        { type: 'temp', path }        temp file to clean up if cancelled
 *        { type: 'done', result }
 *        { type: 'error', message }
 */

const { encode } = require('./encoder');
const { decode } = require('./decoder');

const port = process.parentPort;
const PROGRESS_INTERVAL_MS = 80;

port.once('message', async ({ data }) => {
  const { job, options } = data || {};
  let lastSent = 0;
  let lastStage = null;

  const hooks = {
    onProgress(p) {
      const now = Date.now();
      if (p.stage === lastStage && p.stage !== 'done' && now - lastSent < PROGRESS_INTERVAL_MS) return;
      lastSent = now;
      lastStage = p.stage;
      port.postMessage({ type: 'progress', ...p });
    },
    onTempFile(path) {
      port.postMessage({ type: 'temp', path });
    },
  };

  try {
    const fn = job === 'encode' ? encode : job === 'decode' ? decode : null;
    if (!fn) throw new Error(`Unknown job: ${job}`);
    const result = await fn(options, hooks);
    port.postMessage({ type: 'done', result });
  } catch (err) {
    port.postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
  } finally {
    setTimeout(() => process.exit(0), 100);
  }
});
