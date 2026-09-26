'use strict';

/* Bin2PNG Studio — renderer UI controller. All privileged work goes through window.bin2png (preload). */

const api = window.bin2png;
const $ = (id) => document.getElementById(id);

// ---------- helpers ----------

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c instanceof Node ? c : String(c));
  return node;
}

function formatBytes(n) {
  if (!Number.isFinite(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : n < 10 ? 2 : 1)} ${units[i]}`;
}

const stem = (name) => name.replace(/\.[^.]+$/, '') || name;
const revealLabel = api.platform === 'darwin' ? 'Reveal in Finder' : api.platform === 'win32' ? 'Reveal in Explorer' : 'Reveal in File Manager';

// ---------- tabs ----------

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => {
      t.classList.toggle('active', t === tab);
      t.setAttribute('aria-selected', String(t === tab));
    });
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${tab.dataset.tab}`));
  });
});

// ---------- shared panel controller ----------

function createPanel(cfg) {
  const state = { items: [], outputTouched: false, running: false };
  const drop = $(`${cfg.prefix}-drop`);
  const list = $(`${cfg.prefix}-selection`);
  const output = $(`${cfg.prefix}-output`);
  const startBtn = $(`${cfg.prefix}-start`);
  const cancelBtn = $(`${cfg.prefix}-cancel`);
  const progress = $(`${cfg.prefix}-progress`);
  const status = $(`${cfg.prefix}-status`);
  const percent = $(`${cfg.prefix}-percent`);
  const fill = $(`${cfg.prefix}-fill`);
  const result = $(`${cfg.prefix}-result`);

  function refresh() {
    list.replaceChildren(
      ...state.items.map((it, idx) =>
        el(
          'li',
          { title: it.path },
          el('span', { class: 'kind' }, cfg.kindLabel(it)),
          el('span', { class: 'name' }, it.name),
          el('span', { class: 'meta' }, it.isDirectory ? it.dir : formatBytes(it.size)),
          el('button', {
            class: 'remove',
            title: 'Remove',
            'aria-label': `Remove ${it.name}`,
            onclick: () => {
              state.items.splice(idx, 1);
              refresh();
              updateDefaultOutput();
            },
          }, '×')
        )
      )
    );
    list.hidden = state.items.length === 0;
    drop.classList.toggle('compact', state.items.length > 0);
    updateStartEnabled();
  }

  function updateStartEnabled() {
    startBtn.disabled = state.running || state.items.length === 0 || !output.value.trim();
  }

  async function updateDefaultOutput() {
    if (state.outputTouched) return;
    const first = state.items[0];
    output.value = first ? await api.join(first.dir, cfg.defaultOutputName(first, state.items)) : '';
    updateStartEnabled();
  }

  async function addPaths(paths) {
    if (state.running || !paths.length) return;
    const described = await api.describe(paths);
    if (!described.length) return;
    if (cfg.replaceSelection) state.items = described;
    else {
      const known = new Set(state.items.map((i) => i.path));
      state.items.push(...described.filter((d) => !known.has(d.path)));
    }
    result.hidden = true;
    refresh();
    updateDefaultOutput();
  }

  // Browse buttons
  drop.querySelectorAll('[data-pick]').forEach((btn) =>
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      addPaths(await api.pick(btn.dataset.pick));
    })
  );

  // Drag and drop
  ['dragenter', 'dragover'].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      if (!state.running) drop.classList.add('dragover');
    })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      if (ev === 'dragleave' && drop.contains(e.relatedTarget)) return;
      drop.classList.remove('dragover');
    })
  );
  drop.addEventListener('drop', (e) => {
    const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
    addPaths(paths);
  });

  // Output directory
  output.addEventListener('input', () => {
    state.outputTouched = output.value.trim() !== '';
    updateStartEnabled();
  });
  $(`${cfg.prefix}-output-btn`).addEventListener('click', async () => {
    const [dir] = await api.pick('outputDir');
    if (dir) {
      output.value = dir;
      state.outputTouched = true;
      updateStartEnabled();
    }
  });

  // Run / cancel
  function setRunning(running) {
    state.running = running;
    drop.classList.toggle('disabled', running);
    cancelBtn.hidden = !running;
    cancelBtn.disabled = false;
    cfg.lockables.forEach((id) => ($(id).disabled = running));
    output.disabled = running;
    $(`${cfg.prefix}-output-btn`).disabled = running;
    progress.classList.toggle('running', running);
    updateStartEnabled();
  }

  function setProgress(message, pct) {
    status.textContent = message;
    status.title = message;
    const p = Math.max(0, Math.min(100, pct || 0));
    percent.textContent = `${p.toFixed(p < 100 ? 1 : 0)}%`;
    fill.style.width = `${p}%`;
  }

  startBtn.addEventListener('click', async () => {
    result.hidden = true;
    progress.hidden = false;
    progress.classList.remove('error');
    setProgress('Starting background worker…', 0);
    setRunning(true);
    progress.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    try {
      await api.startJob(cfg.type, { inputs: state.items.map((i) => i.path), outputDir: output.value.trim(), ...cfg.options() });
    } catch (err) {
      onEvent({ event: 'error', message: String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') });
    }
  });

  cancelBtn.addEventListener('click', () => {
    cancelBtn.disabled = true;
    setProgress('Cancelling…', parseFloat(fill.style.width) || 0);
    api.cancelJob(cfg.type);
  });

  function showBanner(kind, title, ...body) {
    result.className = `banner ${kind}`;
    result.replaceChildren(el('h3', {}, title), ...body.flat().filter(Boolean));
    result.hidden = false;
    requestAnimationFrame(() => result.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
  }

  function onEvent(ev) {
    if (ev.event === 'progress') return setProgress(ev.message, ev.percent);
    setRunning(false);
    if (ev.event === 'done') {
      setProgress(ev.result && ev.result.failed && ev.result.failed.length ? 'Finished with errors' : 'Complete', 100);
      cfg.renderResult(ev.result, showBanner);
    } else if (ev.event === 'cancelled') {
      progress.classList.add('error');
      setProgress('Cancelled', parseFloat(fill.style.width) || 0);
      showBanner('warn', 'Operation cancelled', el('p', {}, 'Temporary and partially written files were removed.'));
    } else {
      progress.classList.add('error');
      setProgress('Failed', parseFloat(fill.style.width) || 0);
      showBanner('error', 'Something went wrong', el('div', { class: 'mono' }, ev.message || 'Unknown error'));
    }
  }

  return { onEvent };
}

// ---------- Encode tab ----------

const chunkInput = $('enc-chunk');
$('enc-chunk-preset').addEventListener('change', (e) => {
  if (e.target.value) chunkInput.value = e.target.value;
  e.target.value = '';
});
chunkInput.addEventListener('change', () => {
  const v = Math.round(Number(chunkInput.value));
  chunkInput.value = Number.isFinite(v) ? Math.min(180, Math.max(1, v)) : 30;
});

const encodePanel = createPanel({
  prefix: 'enc',
  type: 'encode',
  replaceSelection: true,
  lockables: ['enc-chunk', 'enc-chunk-preset', 'enc-deflate'],
  kindLabel: (it) => (it.isDirectory ? 'Folder' : /\.zip$/i.test(it.name) ? 'ZIP' : 'File'),
  defaultOutputName: (first, items) => `${items.length > 1 ? 'bin2png_bundle' : first.isDirectory ? first.name : stem(first.name)}_png_chunks`,
  options: () => ({ chunkSizeMB: Number(chunkInput.value) || 30, deflateLevel: Number($('enc-deflate').value) }),
  renderResult(r, showBanner) {
    const modeText = { zip: 'ZIP streamed as-is', file: 'File packed into ZIP', dir: 'Folder packed into ZIP', multi: 'Items packed into ZIP' }[r.kind];
    showBanner(
      'success',
      `✓ ${r.chunks} PNG chunk${r.chunks === 1 ? '' : 's'} created`,
      el(
        'dl',
        {},
        el('dt', {}, 'Source'), el('dd', {}, `${r.name} — ${modeText}`),
        el('dt', {}, 'Data size'), el('dd', {}, formatBytes(r.sourceBytes)),
        el('dt', {}, 'Chunk size'), el('dd', {}, `${r.chunkSizeMB} MB`),
        el('dt', {}, 'Archive ID'), el('dd', { class: 'mono' }, r.uuid),
        el('dt', {}, 'Output folder'), el('dd', { class: 'mono' }, r.outputDir)
      ),
      el(
        'div',
        { class: 'row' },
        el('button', { class: 'btn secondary small', onclick: () => api.reveal(r.files[0] || r.outputDir) }, revealLabel),
        el('button', { class: 'btn secondary small', onclick: () => api.openPath(r.outputDir) }, 'Open Folder')
      )
    );
  },
});

// ---------- Decode tab ----------

const decodePanel = createPanel({
  prefix: 'dec',
  type: 'decode',
  replaceSelection: false,
  lockables: ['dec-extract'],
  kindLabel: (it) => (it.isDirectory ? 'Folder' : /\.zip$/i.test(it.name) ? 'ZIP' : /\.png$/i.test(it.name) ? 'PNG' : 'File'),
  defaultOutputName: (first) => `${first.isDirectory ? first.name : stem(first.name)}_restored`,
  options: () => ({ autoExtract: $('dec-extract').checked }),
  renderResult(r, showBanner) {
    const items = r.restored.map((it) =>
      el(
        'div',
        { class: 'item' },
        el(
          'dl',
          {},
          el('dt', {}, 'Restored'), el('dd', {}, el('strong', {}, it.name)),
          el('dt', {}, 'Size'), el('dd', {}, it.extracted ? `${formatBytes(it.extractedBytes)} extracted (${formatBytes(it.bytes)} archive)` : formatBytes(it.bytes)),
          el('dt', {}, 'Integrity'), el('dd', {}, `✓ ${it.integrity}`),
          el('dt', {}, 'Location'), el('dd', { class: 'mono' }, it.path)
        ),
        el(
          'div',
          { class: 'row' },
          el('button', { class: 'btn secondary small', onclick: () => api.reveal(it.path) }, revealLabel),
          el('button', { class: 'btn secondary small', onclick: () => api.openPath(r.outputDir) }, 'Open Folder')
        )
      )
    );
    const failures = r.failed.map((f) =>
      el(
        'div',
        { class: 'item' },
        el(
          'dl',
          {},
          el('dt', {}, 'Archive'), el('dd', {}, f.name || el('span', { class: 'mono' }, f.uuid)),
          el('dt', {}, 'Missing chunks'), el('dd', {}, `${f.missing.length} of ${f.total}: ${f.missing.slice(0, 30).join(', ')}${f.missing.length > 30 ? ', …' : ''}`),
          f.corrupt.length ? [el('dt', {}, 'Checksum failed'), el('dd', {}, f.corrupt.join(', '))] : null
        )
      )
    );
    const notes = [];
    if (r.skipped) notes.push(`${r.skipped} unrelated image(s) were skipped.`);
    notes.push(...r.warnings);
    const notesEl = notes.length ? el('ul', {}, notes.map((n) => el('li', {}, n))) : null;

    if (r.failed.length === 0) {
      showBanner('success', `✓ Restore complete${r.restored.length > 1 ? ` — ${r.restored.length} archives` : ''}`, items, notesEl);
    } else {
      showBanner(
        r.restored.length ? 'warn' : 'error',
        r.restored.length ? `Restored ${r.restored.length}, ${r.failed.length} incomplete` : 'Restore failed — chunks missing or corrupted',
        items,
        failures,
        notesEl
      );
    }
  },
});

api.onJobEvent((ev) => (ev.type === 'encode' ? encodePanel : decodePanel).onEvent(ev));

// Prevent the window from navigating when files are dropped outside a drop zone.
['dragover', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => e.preventDefault()));
