// Thin wrapper around the Neutralino native API.
//
// Everything here degrades gracefully when `window.Neutralino` is absent
// (e.g. the Vite bundle opened in a plain browser during development), so the
// UI never hard-crashes just because the native bridge isn't there. Inside the
// real app the globals (NL_TOKEN/NL_PORT/NL_ARGS) are injected by the runtime.

const N = typeof window !== 'undefined' ? window.Neutralino : undefined;

export const hasNative = !!N;

let initialized = false;

/** Initialise the native bridge and wire the graceful-exit handlers. */
export function initNative() {
  if (!N || initialized) return;
  N.init();
  // A borderless-less window still emits windowClose; exit the process so the
  // native side doesn't linger (config uses exitProcessOnClose:false).
  N.events.on('windowClose', () => N.app.exit());
  initialized = true;
}

/**
 * The file path markm was launched with, if any.
 * xdg-open / file managers pass the path as the first non-flag CLI argument;
 * Neutralino exposes them via window.NL_ARGS.
 */
export function launchFilePath() {
  const args = (typeof window !== 'undefined' && window.NL_ARGS) || [];
  // NL_ARGS[0] is the binary path; flags start with '-'. Take the first plain arg.
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (typeof a === 'string' && !a.startsWith('-')) {
      // File managers may hand us a file:// URI (%U); normalise to a path.
      return a.startsWith('file://') ? decodeURIComponent(a.slice(7)) : a;
    }
  }
  return null;
}

/** Read a UTF-8 text file. Returns null on failure. */
export async function readTextFile(path) {
  if (!N) return null;
  try {
    return await N.filesystem.readFile(path);
  } catch {
    return null;
  }
}

const IMAGE_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
};

/**
 * Read a local image as a `data:` URI. Returns null on failure.
 *
 * The webview page is served over http://localhost, and WebKit refuses `file://`
 * subresources from an http origin — so a plain `<img src="/abs/path.png">` can
 * never load. Inlining the bytes is the only way to show an image that lives on
 * disk next to the markdown file.
 */
export async function readImageDataUrl(path) {
  if (!N) return null;
  const ext = path.split('.').pop().toLowerCase();
  const mime = IMAGE_MIME[ext];
  if (!mime) return null;
  try {
    const buf = await N.filesystem.readBinaryFile(path);
    const bytes = new Uint8Array(buf);
    let bin = '';
    // Chunked, because String.fromCharCode(...bytes) blows the argument limit on
    // anything but a tiny image.
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return `data:${mime};base64,${btoa(bin)}`;
  } catch {
    return null;
  }
}

/**
 * Drop the system title bar. The `borderless` flag in neutralino.config.json is
 * not honoured on this GTK/WebKit build (the window still comes up decorated), so
 * we ask for it at runtime — the toolbar is the title bar.
 */
export async function setBorderless() {
  if (!N) return;
  try {
    await N.window.setBorderless(true);
  } catch {
    /* non-fatal — worst case the app keeps its decorations */
  }
}

export async function minimizeWindow() {
  if (!N) return;
  try {
    await N.window.minimize();
  } catch {
    /* non-fatal */
  }
}

/** Maximize, or restore if already maximized. */
export async function toggleMaximizeWindow() {
  if (!N) return;
  try {
    if (await N.window.isMaximized()) await N.window.unmaximize();
    else await N.window.maximize();
  } catch {
    /* non-fatal */
  }
}

/**
 * Make an element drag the (borderless) window, as a title bar would.
 * Only ever applied to the toolbar's empty filler areas, so no exclusion list is
 * needed — buttons and selects live outside the region and keep their clicks.
 */
export async function makeDragRegion(el) {
  if (!N || !el) return;
  try {
    await N.window.setDraggableRegion(el);
  } catch {
    /* non-fatal */
  }
}

/** Write a UTF-8 text file. Returns true on success. */
export async function writeTextFile(path, data) {
  if (!N) return false;
  try {
    await N.filesystem.writeFile(path, data);
    return true;
  } catch {
    return false;
  }
}

/** Show the native "open file" dialog; returns a path or null. */
export async function pickOpenPath() {
  if (!N) return null;
  const entries = await N.os.showOpenDialog('Open text file', {
    filters: [
      { name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd', 'txt'] },
      { name: 'Text', extensions: ['txt', 'json', 'js', 'ts', 'py', 'sh', 'yaml', 'yml', 'xml', 'html', 'htm', 'css', 'log', 'ini', 'cfg', 'conf', 'toml', 'csv'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  return entries && entries.length ? entries[0] : null;
}

/** Show the native "open folder" dialog; returns a directory path or null. */
export async function pickFolderPath() {
  if (!N) return null;
  const path = await N.os.showFolderDialog('Open folder');
  return path || null;
}

// Markdown plus common text-based formats: anything listed here shows up in
// the sidebar and opens in-app (markdown renders rich, the rest as plain text).
const TEXT_EXT = new Set([
  'md', 'markdown', 'mdown', 'mkd', 'mkdn',
  'txt', 'json', 'js', 'ts', 'py', 'sh',
  'yaml', 'yml', 'xml', 'html', 'htm', 'css',
  'log', 'ini', 'cfg', 'conf', 'toml', 'csv',
]);

/**
 * List text files directly inside a folder (non-recursive), sorted by name.
 * Returns [{ name, path }]. Empty array on failure.
 */
export async function listTextFiles(dir) {
  if (!N) return [];
  try {
    const entries = await N.filesystem.readDirectory(dir);
    return entries
      .filter((e) => (e.type || '').toUpperCase() !== 'DIRECTORY')
      .filter((e) => TEXT_EXT.has((e.entry.split('.').pop() || '').toLowerCase()))
      .map((e) => ({ name: e.entry, path: `${dir}/${e.entry}` }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/** Stat a path; returns { isFile, isDirectory, size, modifiedAt } or null. */
export async function pathStat(path) {
  if (!N || !path) return null;
  try {
    return await N.filesystem.getStats(path);
  } catch {
    return null;
  }
}

/** Open a URL or path with the OS default handler (browser, image viewer, …). */
export async function openExternal(target) {
  if (!N || !target) return;
  try {
    await N.os.open(target);
  } catch {
    /* non-fatal */
  }
}

/** Open the OS file manager at a file's containing folder (reveal). */
export async function revealInFileManager(filePath) {
  if (!N || !filePath) return;
  const dir = filePath.slice(0, filePath.lastIndexOf('/')) || '/';
  try {
    await N.os.open(dir);
  } catch {
    /* non-fatal */
  }
}

/** Show the native "save as" dialog; returns a path or null. */
export async function pickSavePath(suggested = 'untitled.md') {
  if (!N) return null;
  const path = await N.os.showSaveDialog('Save markdown file', {
    defaultPath: suggested,
    filters: [
      { name: 'Markdown', extensions: ['md', 'markdown'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  return path || null;
}

/** Persist a small key/value using native storage, with a localStorage fallback. */
/**
 * Neutralino storage keys must match ^[a-zA-Z0-9_-]+$ (each key is a file name);
 * anything else is rejected with NE_ST_INVSTKY. Our per-file keys embed a path
 * (`scroll:/home/x/a.md`), so they have to be folded into the allowed alphabet —
 * with a hash appended, since two different paths can sanitize to the same string.
 */
function safeKey(key) {
  if (/^[a-zA-Z0-9_-]+$/.test(key)) return key;
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (Math.imul(hash, 31) + key.charCodeAt(i)) | 0;
  const folded = key.replace(/[^a-zA-Z0-9_-]/g, '_').slice(-48);
  return `${folded}_${(hash >>> 0).toString(36)}`;
}

export async function saveSetting(key, value) {
  try {
    if (N) await N.storage.setData(safeKey(key), value);
    else localStorage.setItem(key, value);
  } catch {
    /* non-fatal */
  }
}

/** Read a persisted setting; returns null if unset. */
export async function loadSetting(key) {
  try {
    if (N) return await N.storage.getData(safeKey(key));
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

// ---- Git integration (via os.execCommand) ----

/** Directory of a file path. */
function dirname(p) {
  return p.slice(0, p.lastIndexOf('/')) || '/';
}

/** Single-quote a string for safe shell interpolation. */
function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** Run `git -C <dir> <args>`; returns { ok, out }. */
async function execGit(dir, args) {
  if (!N) return { ok: false, out: '' };
  try {
    const r = await N.os.execCommand(`git -C ${shq(dir)} ${args}`);
    return { ok: r.exitCode === 0, out: r.stdOut ?? '' };
  } catch {
    return { ok: false, out: '' };
  }
}

/** Whether a file is tracked in a git working tree. */
export async function gitIsTracked(filePath) {
  if (!N || !filePath) return false;
  const dir = dirname(filePath);
  const inside = await execGit(dir, 'rev-parse --is-inside-work-tree');
  if (!inside.ok || inside.out.trim() !== 'true') return false;
  const ls = await execGit(dir, `ls-files --error-unmatch ${shq(filePath)}`);
  return ls.ok;
}

/**
 * The file's content at HEAD (last commit). Returns null if there is no
 * committed version yet (e.g. a newly added-but-uncommitted file).
 */
export async function gitHeadContent(filePath) {
  if (!N || !filePath) return null;
  const dir = dirname(filePath);
  const rootR = await execGit(dir, 'rev-parse --show-toplevel');
  if (!rootR.ok) return null;
  const root = rootR.out.trim();
  const rel = filePath.startsWith(root + '/') ? filePath.slice(root.length + 1) : filePath;
  const show = await execGit(dir, `show ${shq('HEAD:' + rel)}`);
  return show.ok ? show.out : null;
}

/**
 * Watch a single file for external changes and invoke `onChange` when it is
 * modified on disk. Neutralino watches directories, so we watch the containing
 * folder and filter events down to the target filename. Returns an async
 * cleanup function that removes the watcher and detaches the listener.
 */
export async function watchFile(filePath, onChange) {
  if (!N || !filePath) return async () => {};
  const dir = dirname(filePath);
  const base = filePath.slice(filePath.lastIndexOf('/') + 1);
  let watcherId = null;
  const handler = (evt) => {
    const d = evt?.detail || {};
    // 'modified'/'add' both fire on a save; editors that write-then-rename may
    // only surface the filename on one of them, so react to any name match.
    if (d.filename === base) onChange();
  };
  try {
    N.events.on('watchFile', handler);
    watcherId = await N.filesystem.createWatcher(dir);
  } catch {
    N.events.off('watchFile', handler);
    return async () => {};
  }
  return async () => {
    try {
      N.events.off('watchFile', handler);
      if (watcherId != null) await N.filesystem.removeWatcher(watcherId);
    } catch {
      /* non-fatal */
    }
  };
}

/**
 * Watch a whole directory and invoke `onEvent` for every filesystem event in
 * it (file add/remove/modify/rename). The sidebar uses this to keep its file
 * list live. Returns an async cleanup function.
 *
 * NOTE: Neutralino delivers every filesystem-watcher event — file watchers
 * and directory watchers alike — as `watchFile`; there is no separate
 * `watchDir` event. So we subscribe to `watchFile` and filter by our own
 * watcher id, otherwise sibling watchers (e.g. the open file's watcher on
 * the same folder) would trigger us too.
 */
export async function watchDirectory(dir, onEvent) {
  if (!N || !dir) return async () => {};
  let watcherId = null;
  const handler = (evt) => {
    const d = evt?.detail || {};
    if (watcherId == null || d.id !== watcherId) return;
    onEvent?.(d);
  };
  try {
    N.events.on('watchFile', handler);
    watcherId = await N.filesystem.createWatcher(dir);
  } catch {
    N.events.off('watchFile', handler);
    return async () => {};
  }
  return async () => {
    try {
      N.events.off('watchFile', handler);
      if (watcherId != null) await N.filesystem.removeWatcher(watcherId);
    } catch {
      /* non-fatal */
    }
  };
}

/**
 * Copy text to the system clipboard.
 * Tries, in order: the native bridge, the async clipboard API (the runtime
 * enables javascript-can-access-clipboard), then the legacy execCommand path
 * which WebKitGTK still honours from a user gesture like this button click.
 * @returns {Promise<boolean>} whether the copy succeeded
 */
export async function copyToClipboard(text) {
  try {
    if (N) {
      await N.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* native bridge refused — fall through to the web fallbacks */
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* file:// page without clipboard permission — try execCommand */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (ok) return true;
  } catch {
    /* non-fatal */
  }
  return false;
}

/** Quit the application. */
export async function exitApp() {
  if (!N) return;
  try {
    await N.app.exit();
  } catch {
    /* non-fatal */
  }
}

/** Update the OS window title. */
export async function setWindowTitle(title) {
  if (!N) {
    document.title = title;
    return;
  }
  try {
    await N.window.setTitle(title);
  } catch {
    /* non-fatal */
  }
}
