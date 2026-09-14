<script>
  import { onMount, onDestroy } from 'svelte';
  import Editor from './lib/Editor.svelte';
  import Preview from './lib/Preview.svelte';
  import Sidebar from './lib/Sidebar.svelte';
  import DiffView from './lib/DiffView.svelte';
  import { THEMES, DEFAULT_THEME, applyTheme } from './lib/themes.js';
  import { FONTS, DEFAULT_FONT, applyFont } from './lib/fonts.js';
  import {
    initNative, launchFilePath, readTextFile, writeTextFile,
    pickOpenPath, pickSavePath, saveSetting, loadSetting, setWindowTitle,
    pickFolderPath, listTextFiles, revealInFileManager,
    gitIsTracked, gitHeadContent, watchFile, exitApp,
    pathStat, openExternal, watchDirectory,
    toggleMaximizeWindow, makeDragRegion, setBorderless,
  } from './lib/neu.js';

  const MD_RE = /\.(md|markdown|mdown|mkd|mkdn)$/i;
  // Everything markm opens in-app: markdown renders rich, the rest as plain text.
  const TEXT_RE = /\.(md|markdown|mdown|mkd|mkdn|txt|json|js|ts|py|sh|ya?ml|xml|html?|css|log|ini|cfg|conf|toml|csv)$/i;

  const WELCOME = `# Welcome to markm

A fast, native markdown viewer with an **edit mode** and lots of themes.

## Try it

- Toggle **View / Edit / Split** with the icon switch in the toolbar
- Pick another file from the **☰ sidebar** on the left — it mirrors the folder live
- Switch the **theme** and **reading font** in the **☰ menu** on the right — everything restyles live
- Open any file with \`xdg-open file.md\`, \`markm file.md\`, or a whole folder with \`markm .\`
- Links are clickable — external ones open in your browser, local text files open here

New to markdown? Start with the
[CommonMark reference](https://commonmark.org/help/) or
[GitHub's markdown guide](https://docs.github.com/en/get-started/writing-on-github).

\`\`\`js
// code blocks are highlighted too
const hello = (who) => \`hi, \${who}\`;
\`\`\`

> Edit this text, then hit **Ctrl+S** to save.

| Shortcut | Action |
|----------|--------|
| Ctrl+E   | Toggle edit |
| Ctrl+S   | Save   |
| Ctrl+O   | Open   |
| Ctrl +/− | Zoom in / out |
| Ctrl+0   | Reset zoom |
| Esc      | Close markm (in View mode) |

markm is open source ([MIT](https://github.com/galvani/markm)) — built by
[Jan Kozak](https://galvani.github.io).
`;

  const ZOOM_MIN = 0.5;
  const ZOOM_MAX = 3;

  // Starts EMPTY, not with WELCOME: markm is nearly always launched on a file, and
  // seeding the welcome doc here made it paint for a frame before onMount replaced
  // it — a visible flash of the wrong document. The welcome text is installed in
  // onMount only when there is no file to open.
  let content = $state('');
  let mode = $state('view'); // 'view' | 'edit' | 'split'
  let themeId = $state(DEFAULT_THEME);
  let fontId = $state(DEFAULT_FONT);
  let filePath = $state(null);
  let dirty = $state(false);
  let reloaded = $state(false); // brief "updated" badge after an on-disk auto-refresh
  let refreshTick = $state(0); // bumped only on an external reload → Preview pulses changed blocks
  let zoom = $state(1);
  let folderPath = $state(null);
  let folderFiles = $state([]);
  let sidebarOpen = $state(false);
  let gitTracked = $state(false);
  let previousContent = $state(null); // file content at HEAD (for the diff view)
  let settingsOpen = $state(false); // appearance menu (font + theme) popover
  let settingsEl = $state(null); // popover root, so an outside click can close it
  let dragLeftEl = $state(null); // toolbar fillers that drag the borderless window
  let dragRightEl = $state(null);
  let dragDepth = $state(0); // file-drag hover counter; overlay shows while > 0
  let cursorLine = $state(1); // caret position in the editor (edit/split modes)
  let cursorCol = $state(1);

  let fileName = $derived(filePath ? filePath.split('/').pop() : 'untitled.md');
  // Non-markdown files render as plain text instead of going through markdown-it.
  let isPlain = $derived(filePath ? !MD_RE.test(filePath) : false);
  let folderName = $derived(folderPath ? folderPath.split('/').pop() : '');

  // Document stats for the status bar. An empty buffer still counts as 1 line
  // (that's where the caret sits); words ignore leading/trailing whitespace.
  let lineCount = $derived(content === '' ? 1 : content.split('\n').length);
  let wordCount = $derived(content.trim() === '' ? 0 : content.trim().split(/\s+/).length);
  let charCount = $derived(content.length);

  // Active file-watcher cleanup + the pulse-reset timer (plain vars, not state).
  let disposeWatcher = null;
  let reloadTimer = null;
  let disposeFolderWatcher = null; // live sidebar listing for folderPath
  let folderTimer = null; // debounce for watcher-event bursts

  // Keep the OS window title in sync with the open file + dirty state.
  $effect(() => {
    setWindowTitle(`${dirty ? '● ' : ''}${fileName} — markm`);
  });

  onMount(async () => {
    initNative();
    setBorderless();

    // Restore all persisted preferences (theme, view mode, zoom/font size).
    const savedTheme = await loadSetting('theme');
    if (savedTheme) themeId = savedTheme;
    applyTheme(themeId);

    const savedFont = await loadSetting('font');
    if (savedFont) fontId = savedFont;
    applyFont(fontId);

    const savedMode = await loadSetting('mode');
    if (savedMode) mode = savedMode;

    const savedZoom = parseFloat(await loadSetting('zoom'));
    applyZoom(Number.isFinite(savedZoom) ? savedZoom : 1);

    // Restore the folder + sidebar. The sidebar stays hidden on startup unless
    // it was open last session ("unless previously").
    const savedFolder = await loadSetting('folder');
    if (savedFolder) await setFolder(savedFolder);
    sidebarOpen = (await loadSetting('sidebarOpen')) === '1' && !!folderPath;

    // If launched with a path (xdg-open / file manager / CLI arg): a directory
    // (e.g. `markm .` or `markm /tmp`) becomes the sidebar folder; a file
    // opens directly (and adopts its folder when none is set yet).
    const launch = launchFilePath();
    if (launch) {
      const st = await pathStat(launch);
      if (st?.isDirectory) await setFolder(launch, true);
      else await openPath(launch);
    }
    if (!filePath) content = WELCOME;

    // Drag + double-click-to-maximize are window gestures on empty chrome, not
    // controls, so they're bound imperatively (as a <div> with a dblclick handler
    // is an a11y smell — there is nothing here for a keyboard user to reach).
    for (const el of [dragLeftEl, dragRightEl]) {
      makeDragRegion(el);
      el?.addEventListener('dblclick', toggleMaximizeWindow);
    }
  });

  // Ctrl + wheel zooms the document, the way every browser and editor does.
  function onWheel(e) {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    applyZoom(zoom + (e.deltaY < 0 ? -0.1 : 0.1));
  }

  // --- Folder sidebar: live listing ---
  // The sidebar always mirrors the folder on disk. A Neutralino directory
  // watcher refreshes the listing on every add/remove/rename, a window-focus
  // refresh catches anything the watcher missed, and file ops (open/save/drop)
  // refresh explicitly. Opening a file adopts its directory,
  // so the sidebar follows your files until you pick a folder.
  async function refreshFolder() {
    if (folderPath) folderFiles = await listTextFiles(folderPath);
  }

  function scheduleFolderRefresh() {
    if (folderTimer) clearTimeout(folderTimer);
    folderTimer = setTimeout(() => { folderTimer = null; refreshFolder(); }, 300);
  }

  async function armFolderWatcher() {
    if (disposeFolderWatcher) { await disposeFolderWatcher(); disposeFolderWatcher = null; }
    if (folderPath) disposeFolderWatcher = await watchDirectory(folderPath, scheduleFolderRefresh);
  }

  async function setFolder(dir, open = false) {
    if (dir === folderPath) { if (open) setSidebar(true); return; }
    folderPath = dir;
    saveSetting('folder', dir);
    await refreshFolder();
    await armFolderWatcher();
    if (open) setSidebar(true);
  }

  // The sidebar always follows the opened file: opening a file anywhere
  // moves the sidebar to that file's directory.
  function adoptFolderFor(path) {
    if (!path) return;
    const dir = path.slice(0, path.lastIndexOf('/'));
    if (dir && dir !== folderPath) setFolder(dir);
  }

  onDestroy(() => {
    if (reloadTimer) clearTimeout(reloadTimer);
    if (folderTimer) clearTimeout(folderTimer);
    if (disposeWatcher) disposeWatcher();
    if (disposeFolderWatcher) disposeFolderWatcher();
  });

  // Native folder dialog → the sidebar shows that folder from now on.
  async function openFolder() {
    const dir = await pickFolderPath();
    if (!dir) return;
    await setFolder(dir, true);
  }

  function setSidebar(open) {
    sidebarOpen = open;
    saveSetting('sidebarOpen', open ? '1' : '0');
  }

  function toggleSidebar() {
    setSidebar(!sidebarOpen);
  }

  function revealCurrent() {
    revealInFileManager(filePath);
  }

  // Zoom scales the document workspace only. We use transform: scale() for the
  // workspace rather than the CSS `zoom` property, because WebKitGTK (unlike
  // Blink) doesn't support `zoom` — so the workspace surface is laid out at 1/z
  // of its pane and scaled back up to fill it, which makes content reflow
  // correctly at the zoomed size. Toolbar chrome stays fixed-size.
  function applyZoom(z) {
    zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 10) / 10));
    // Older builds applied zoom directly to #app. Clear that root transform on
    // every restore/change so persisted zoom cannot shrink the toolbar chrome.
    const root = document.getElementById('app');
    if (root) {
      root.style.transform = 'none';
      root.style.width = '100%';
      root.style.height = '100%';
      root.style.removeProperty('--chrome-scale');
    }
    const el = document.getElementById('zoom-surface');
    if (el) {
      if (zoom === 1) {
        // No transform at 100% — a transformed ancestor breaks CodeMirror's
        // coordinate measurement (selection), so keep the common case clean.
        el.style.transform = 'none';
        el.style.width = '100%';
        el.style.height = '100%';
      } else {
        el.style.transformOrigin = '0 0';
        el.style.transform = `scale(${zoom})`;
        el.style.width = `${100 / zoom}%`;
        el.style.height = `${100 / zoom}%`;
      }
    }
    saveSetting('zoom', String(zoom));
  }

  function changeTheme(id) {
    themeId = applyTheme(id);
    saveSetting('theme', themeId);
  }

  function changeFont(id) {
    fontId = applyFont(id);
    saveSetting('font', fontId);
  }

  function setMode(m) {
    mode = m;
    saveSetting('mode', m);
  }

  async function openPath(path) {
    const text = await readTextFile(path);
    if (text === null) return;
    content = text;
    filePath = path;
    dirty = false;
    cursorLine = 1;
    cursorCol = 1;
    await refreshGit();
    await armWatcher(path);
    adoptFolderFor(path);
    await refreshFolder();
  }

  // (Re)install the on-disk watcher for the open file. Tears down any previous
  // watcher first so we only ever track the currently-open file.
  async function armWatcher(path) {
    if (disposeWatcher) { await disposeWatcher(); disposeWatcher = null; }
    disposeWatcher = await watchFile(path, () => reloadFromDisk(path));
  }

  // React to an external change to the open file. We never clobber unsaved
  // edits: if the buffer is dirty we leave it alone. Otherwise reload — but only
  // pulse when the bytes actually changed, so our own saves stay silent.
  async function reloadFromDisk(path) {
    if (path !== filePath || dirty) return;
    const text = await readTextFile(path);
    if (text === null || text === content) return;
    content = text;
    await refreshGit();
    refreshTick++; // tells Preview to pulse whatever blocks changed
    flashReloaded();
  }

  function flashReloaded() {
    reloaded = true;
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => { reloaded = false; }, 1100);
  }

  // Refresh whether the open file is git-tracked (drives the "Changes" mode).
  async function refreshGit() {
    gitTracked = await gitIsTracked(filePath);
    if (!gitTracked && mode === 'diff') mode = 'view';
    else if (gitTracked && mode === 'diff') previousContent = await gitHeadContent(filePath);
  }

  // Enter the diff view, fetching the latest HEAD version. 'diff' is a transient
  // mode — not persisted as a startup mode (startup needs a loaded, tracked file).
  async function enterDiff() {
    previousContent = await gitHeadContent(filePath);
    mode = 'diff';
  }

  async function openFile() {
    const path = await pickOpenPath();
    if (path) await openPath(path);
  }

  async function save() {
    let path = filePath;
    if (!path) {
      path = await pickSavePath(fileName);
      if (!path) return;
    }
    const ok = await writeTextFile(path, content);
    if (ok) {
      filePath = path;
      dirty = false;
      adoptFolderFor(path); // a first save into a folder adopts it for the sidebar
      await refreshFolder(); // a new filename appears in the listing
    }
  }

  function onEditorChange(v) {
    content = v;
    dirty = true;
  }

  function onEditorCursor(line, col) {
    cursorLine = line;
    cursorCol = col;
  }

  // Route a clicked preview link. External URLs go to the system browser;
  // in-page anchors scroll; local markdown opens in the viewer; anything else
  // local is handed to the OS default handler.
  async function onLink(href) {
    if (!href) return;
    if (/^(https?:|mailto:|tel:)/i.test(href)) { openExternal(href); return; }
    if (href.startsWith('#')) {
      const el = document.getElementById(decodeURIComponent(href.slice(1)));
      if (el) el.scrollIntoView({ behavior: 'smooth' });
      return;
    }
    const abs = resolveLocal(href);
    const st = await pathStat(abs);
    if (st?.isDirectory) { await setFolder(abs, true); return; }
    if (TEXT_RE.test(abs)) { await openPath(abs); return; }
    openExternal(abs); // images, PDFs, etc.
  }

  // Resolve a link target (possibly relative / file://) against the open file's
  // directory into an absolute, normalised path.
  function resolveLocal(href) {
    let p = href;
    try { p = decodeURI(href); } catch { /* leave as-is */ }
    if (p.startsWith('file://')) p = p.slice(7);
    p = p.split(/[?#]/)[0]; // drop any query/fragment
    if (p.startsWith('/')) return normalizePath(p);
    const baseDir = filePath ? filePath.slice(0, filePath.lastIndexOf('/')) : (folderPath || '');
    return normalizePath(`${baseDir}/${p}`);
  }

  // Collapse '.' and '..' segments in an absolute path (no filesystem access).
  function normalizePath(p) {
    const out = [];
    for (const seg of p.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') out.pop();
      else out.push(seg);
    }
    return '/' + out.join('/');
  }

  // File drag-and-drop. File managers offer the path as text/uri-list
  // (file:///abs/path.md); a dropped directory opens the picker, a dropped
  // markdown file opens directly. Anything else is ignored.
  //
  // WebKitGTK doesn't always list 'Files' in dataTransfer.types, so the
  // dragover/drop handlers preventDefault UNCONDITIONALLY (capture phase):
  // a single missed preventDefault lets WebKit navigate the whole window to
  // the dropped file, killing the app. Only the overlay + open logic are
  // gated on the drag looking like a file drag.
  function hasFileDrag(e) {
    const t = [...(e.dataTransfer?.types || [])].map((x) => String(x).toLowerCase());
    return t.includes('files') || t.includes('text/uri-list');
  }
  function onDragEnter(e) {
    if (!hasFileDrag(e)) return;
    e.preventDefault();
    dragDepth++;
  }
  function onDragOver(e) {
    e.preventDefault();
    if (e.dataTransfer && hasFileDrag(e)) e.dataTransfer.dropEffect = 'copy';
  }
  function onDragLeave(e) {
    if (!hasFileDrag(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
  }
  function onDragEnd() {
    dragDepth = 0; // Esc-cancelled (or otherwise aborted) drags
  }
  function dropFilePath(e) {
    const dt = e.dataTransfer;
    const get = (fmt) => { try { return dt?.getData(fmt) || ''; } catch { return ''; } };
    // 1. Standard URI list (most file managers).
    for (const line of get('text/uri-list').split(/\r?\n/)) {
      const p = cleanDropUrl(line);
      if (p) return p;
    }
    // 2. WebKitGTK quirk: Dolphin drops expose the file:// URL only inside a
    // text/html anchor — strip the tags and fish the URL out.
    const htmlText = get('text/html').replace(/<[^>]*>/g, ' ');
    for (const token of htmlText.split(/\s+/)) {
      const p = cleanDropUrl(token);
      if (p) return p;
    }
    // 3. Plain-text fallback (a dragged path or file:// URL).
    const p = cleanDropUrl(get('text/plain'));
    if (p) return p;
    return dt?.files?.[0]?.path || null; // Chromium-style fallback
  }
  // A file:// URL or absolute path → normalized absolute path, else null.
  function cleanDropUrl(s) {
    let p = (s || '').trim();
    if (!p || p.startsWith('#')) return null;
    try { p = decodeURI(p); } catch { /* leave as-is */ }
    if (p.startsWith('file://')) p = p.slice(7);
    p = p.split(/[?#]/)[0].trim();
    return p.startsWith('/') ? normalizePath(p) : null;
  }
  async function onDrop(e) {
    // Capture phase: runs before any in-app (e.g. editor) drop handling.
    e.preventDefault();
    dragDepth = 0;
    if (hasFileDrag(e)) e.stopPropagation(); // don't also insert into the editor
    const p = dropFilePath(e);
    if (!p) return;
    const st = await pathStat(p);
    if (st?.isDirectory) { await setFolder(p, true); return; }
    if (TEXT_RE.test(p)) await openPath(p);
  }

  function onKey(e) {
    // Esc quits, but only in read-only View mode — never mid-edit, so an
    // errant Esc while typing (or in Split/Diff) can't discard work by closing.
    if (e.key === 'Escape') {
      if (settingsOpen) { e.preventDefault(); settingsOpen = false; return; }
      if (mode === 'view') { e.preventDefault(); exitApp(); return; }
    }
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    if (e.key === 's') { e.preventDefault(); save(); }
    else if (e.key === 'o') { e.preventDefault(); openFile(); }
    else if (e.key === 'e') { e.preventDefault(); setMode(mode === 'edit' ? 'view' : 'edit'); }
    // Ctrl/Cmd +/-/0 zoom. '=' is the unshifted '+' key; handle both.
    else if (e.key === '=' || e.key === '+') { e.preventDefault(); applyZoom(zoom + 0.1); }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); applyZoom(zoom - 0.1); }
    else if (e.key === '0') { e.preventDefault(); applyZoom(1); }
  }
</script>

<svelte:window
  on:keydown={onKey}
  on:focus={refreshFolder}
  on:wheel|nonpassive={onWheel}
  on:dragenter={onDragEnter}
  on:dragover|capture={onDragOver}
  on:dragleave={onDragLeave}
  on:dragend={onDragEnd}
  on:drop|capture={onDrop}
  on:click={(e) => { if (settingsOpen && !settingsEl?.contains(e.target)) settingsOpen = false; }}
/>

<div class="app">
  {#if dragDepth > 0}
    <div class="drop-hint" aria-hidden="true"><span>Drop to open</span></div>
  {/if}
  <header class="toolbar">
    <button
      class="icon"
      class:active={sidebarOpen}
      title="Toggle folder sidebar"
      aria-label="Toggle folder sidebar"
      onclick={toggleSidebar}
    >☰</button>
    <div class="file">
      <span class="dot" class:dirty></span>
      <span class="name" title={filePath || ''}>{fileName}</span>
      {#if reloaded}
        <span class="reloaded-badge">updated</span>
      {/if}
      {#if filePath}
        <button
          class="icon reveal"
          title="Reveal in file manager"
          aria-label="Reveal in file manager"
          onclick={revealCurrent}
        >↗</button>
      {/if}
    </div>

    <!-- The window is borderless: these two empty fillers ARE the title bar —
         drag them to move the window, double-click to maximize. They hold no
         controls, so no drag-exclusion list is needed. -->
    <div class="drag" bind:this={dragLeftEl}></div>

    <!-- Icon-only mode switch. Icons are inline SVG (no icon font to ship) and
         inherit currentColor, so they follow the theme like the text did. -->
    <div class="modes" role="group" aria-label="View mode">
      <button class:active={mode === 'view'} title="View" aria-label="View" onclick={() => setMode('view')}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M1.5 12S5 5.5 12 5.5 22.5 12 22.5 12 19 18.5 12 18.5 1.5 12 1.5 12Z"/><circle cx="12" cy="12" r="3.2"/></svg>
      </button>
      <button class:active={mode === 'edit'} title="Edit" aria-label="Edit" onclick={() => setMode('edit')}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4l10-10-4-4L4 16v4Z"/><path d="m14.5 5.5 4 4"/></svg>
      </button>
      <button class:active={mode === 'split'} title="Split" aria-label="Split" onclick={() => setMode('split')}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M12 4.5v15"/></svg>
      </button>
      {#if gitTracked}
        <button class:active={mode === 'diff'} title="Changes vs last commit" aria-label="Changes vs last commit" onclick={enterDiff}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4v9a3 3 0 0 0 3 3h6"/><circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="6" r="2.2"/><path d="M18 10v4"/><path d="M16 12h4"/></svg>
        </button>
      {/if}
    </div>

    <div class="drag" bind:this={dragRightEl}></div>

    <div class="actions">
      <div class="settings" bind:this={settingsEl}>
        <button
          class="icon"
          class:active={settingsOpen}
          title="Appearance (font & theme)"
          aria-label="Appearance settings"
          aria-expanded={settingsOpen}
          onclick={() => (settingsOpen = !settingsOpen)}
        >☰</button>
        {#if settingsOpen}
          <div class="menu">
            <label>
              <span>Font</span>
              <select
                aria-label="Reading font"
                value={fontId}
                onchange={(e) => changeFont(e.currentTarget.value)}
              >
                {#each FONTS as f (f.id)}
                  <option value={f.id}>{f.name}</option>
                {/each}
              </select>
            </label>
            <label>
              <span>Theme</span>
              <select
                aria-label="Theme"
                value={themeId}
                onchange={(e) => changeTheme(e.currentTarget.value)}
              >
                {#each THEMES as t (t.id)}
                  <option value={t.id}>{t.name}</option>
                {/each}
              </select>
            </label>
          </div>
        {/if}
      </div>
      <button class="primary" onclick={save}>Save</button>
    </div>
  </header>

  <div class="workspace">
    <div id="zoom-surface" class="zoom-surface">
      {#if sidebarOpen}
        <Sidebar {folderName} files={folderFiles} activePath={filePath} onSelect={openPath} onOpenFolder={openFolder} />
      {/if}
      <main class="body" class:split={mode === 'split'}>
        {#if mode === 'diff'}
          <section class="pane">
            <DiffView previous={previousContent} current={content} />
          </section>
        {:else}
          {#if mode === 'edit' || mode === 'split'}
            <section class="pane editor-pane">
              <Editor value={content} onChange={onEditorChange} onCursor={onEditorCursor} />
            </section>
          {/if}
          {#if mode === 'view' || mode === 'split'}
            <section class="pane preview-pane">
              <Preview source={content} plain={isPlain} {onLink} pulseTick={refreshTick} basePath={filePath || ''} scrollKey={filePath || ''} />
            </section>
          {/if}
        {/if}
      </main>
    </div>
  </div>
  <footer class="statusbar">
    <span class="stats">{lineCount} lines · {wordCount} words · {charCount} chars</span>
    {#if mode === 'edit' || mode === 'split'}
      <span class="cursor">{cursorLine}:{cursorCol}</span>
    {/if}
  </footer>
</div>

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--bg);
    color: var(--fg);
  }

  .workspace {
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  .zoom-surface {
    display: flex;
    width: 100%;
    height: 100%;
    transform-origin: 0 0;
  }

  .reloaded-badge {
    flex: none;
    font-size: 10px;
    line-height: 1;
    padding: 3px 6px;
    border-radius: 999px;
    background: var(--accent);
    color: var(--accent-fg);
    letter-spacing: 0.03em;
    text-transform: uppercase;
    animation: badge-fade 1.1s ease-out forwards;
  }
  @keyframes badge-fade {
    0% { opacity: 0; transform: translateY(-2px); }
    15% { opacity: 1; transform: translateY(0); }
    70% { opacity: 1; }
    100% { opacity: 0; }
  }

  .toolbar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 3px 10px;
    background: var(--panel);
    color: var(--panel-fg);
    border-bottom: 1px solid var(--border);
    user-select: none;
    flex: none;
  }

  .file {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    flex: 0 1 auto;
  }

  /* Empty, but load-bearing: these are the window's drag handles. */
  .drag {
    flex: 1;
    min-width: 12px;
    align-self: stretch;
  }
  .file .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: transparent;
    border: 1px solid var(--muted);
    flex: none;
  }
  .dot.dirty {
    background: var(--accent);
    border-color: var(--accent);
  }

  .modes button.active {
    background: var(--accent);
    color: var(--accent-fg);
  }

  .icon {
    padding: 0 9px;
    font-size: 14px;
    line-height: 1;
    flex: none;
  }
  .icon.active {
    background: var(--accent);
    color: var(--accent-fg);
    border-color: var(--accent);
  }
  .reveal {
    height: 20px;
    padding: 0 6px;
    font-size: 12px;
    color: var(--muted);
  }

  .actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: none;
    justify-content: flex-end;
  }

  .settings {
    position: relative;
    flex: none;
  }
  .menu {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 20;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
  }
  .menu label {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    font-size: 12px;
    color: var(--muted);
  }
  .menu select {
    min-width: 130px;
  }

  /* All toolbar controls share one height so buttons and the native select
     line up exactly. */
  button,
  select {
    font: inherit;
    font-size: 12px;
    height: 26px;
    box-sizing: border-box;
    padding: 0 10px;
    line-height: normal;
    background: var(--bg);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 6px;
    cursor: pointer;
  }

  .modes {
    display: flex;
    align-items: stretch;
    height: 26px;
    box-sizing: border-box;
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
  }
  .modes button {
    height: 100%;
    border: none;
    border-radius: 0;
  }
  .modes button {
    border-right: 1px solid var(--border);
    padding: 0 11px;
    display: flex;
    align-items: center;
  }
  .modes svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .modes button:last-child { border-right: none; }
  button:hover,
  select:hover { border-color: var(--accent); }
  button.primary {
    background: var(--accent);
    color: var(--accent-fg);
    border-color: var(--accent);
  }

  /* Slim status bar: doc stats left, caret Ln:Col right (edit modes only). */
  .statusbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex: none;
    padding: 2px 10px;
    font-size: 11px;
    line-height: 1.6;
    background: var(--panel);
    color: var(--muted);
    border-top: 1px solid var(--border);
    user-select: none;
  }
  .statusbar .cursor {
    font-variant-numeric: tabular-nums;
  }

  .body {
    flex: 1;
    min-width: 0;
    min-height: 0;
    height: 100%;
    display: grid;
    grid-template-columns: 1fr;
  }
  .body.split {
    grid-template-columns: 1fr 1fr;
  }
  .pane {
    min-width: 0;
    height: 100%;
    overflow: hidden;
  }
  .editor-pane {
    border-right: 1px solid var(--border);
  }
  .body:not(.split) .editor-pane {
    border-right: none;
  }

  /* Full-window drop target hint. pointer-events:none so the drop itself
     still lands on the window handler. */
  .drop-hint {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
    background: rgba(76, 141, 255, 0.1);
    outline: 2px dashed #4c8dff;
    outline-offset: -12px;
  }
  .drop-hint span {
    padding: 8px 18px;
    border-radius: 8px;
    background: var(--bg);
    color: var(--fg);
    border: 1px solid #4c8dff;
    font-size: 14px;
  }
</style>
