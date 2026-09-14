// CodeMirror 6 setup for the markdown source pane.
//
// The theme and syntax highlighting are expressed entirely with `var(--...)`
// CSS custom properties, so switching the app theme (which rewrites those
// variables on <html>) restyles the editor live — no EditorView reconfigure.

import { EditorView, keymap, highlightActiveLine, lineNumbers } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

// Markdown token colors, all driven by theme CSS variables.
const highlight = HighlightStyle.define([
  { tag: t.heading, color: 'var(--heading)', fontWeight: '600' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: [t.link, t.url], color: 'var(--link)' },
  { tag: t.monospace, color: 'var(--code-fg)' },
  { tag: [t.quote], color: 'var(--muted)', fontStyle: 'italic' },
  { tag: [t.list, t.processingInstruction], color: 'var(--accent)' },
  { tag: [t.meta, t.comment], color: 'var(--muted)' },
]);

const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'transparent', color: 'var(--fg)' },
  '.cm-scroller': { fontFamily: 'var(--mono)', fontSize: '14px', lineHeight: '1.6' },
  '.cm-content': { caretColor: 'var(--editor-cursor)', padding: '12px 4px' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--editor-cursor)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--sel)',
  },
  '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--editor-gutter)', border: 'none' },
  '.cm-activeLine': { backgroundColor: 'var(--editor-active)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--editor-active)', color: 'var(--fg)' },
  '.cm-selectionMatch': { backgroundColor: 'var(--sel)' },
  // Find/replace panel, theme-driven like everything else. The panel ships
  // with near-zero base styling, so every control gets explicit treatment:
  // bordered inputs, real buttons with hover + active toggle state, and
  // accent-tinted checkboxes — all in small type to match the slim chrome.
  '.cm-panels': { backgroundColor: 'var(--bg)', color: 'var(--fg)', borderTop: '1px solid var(--border)' },
  '.cm-panel.cm-search': { padding: '5px 8px', fontSize: '12px' },
  '.cm-panel.cm-search input.cm-textfield': {
    backgroundColor: 'var(--editor-active)', color: 'var(--fg)',
    border: '1px solid var(--border)', borderRadius: '5px', padding: '3px 7px',
  },
  '.cm-panel.cm-search input.cm-textfield:focus': { outline: 'none', borderColor: 'var(--accent)' },
  '.cm-panel.cm-search button.cm-button': {
    backgroundColor: 'transparent', color: 'var(--fg)',
    border: '1px solid var(--border)', borderRadius: '5px', padding: '3px 9px',
    marginLeft: '4px', cursor: 'pointer', fontSize: '12px',
  },
  '.cm-panel.cm-search button.cm-button:hover': { backgroundColor: 'var(--editor-active)' },
  '.cm-panel.cm-search button.cm-button[aria-pressed="true"]': {
    backgroundColor: 'var(--accent)', borderColor: 'var(--accent)', color: 'var(--bg)',
  },
  '.cm-panel.cm-search label': { color: 'var(--muted)', marginLeft: '8px' },
  '.cm-panel.cm-search input[type="checkbox"]': { accentColor: 'var(--accent)' },
  '.cm-searchMatch': { backgroundColor: 'var(--sel)' },
  '.cm-searchMatch-selected': { backgroundColor: 'var(--accent)', color: 'var(--bg)' },
});

/**
 * Create a CodeMirror editor.
 * @param {HTMLElement} parent
 * @param {{ doc?: string, onChange?: (value: string) => void, onCursor?: (line: number, col: number) => void }} opts
 * @returns {EditorView}
 */
export function createEditor(parent, { doc = '', onChange, onCursor } = {}) {
  const reportCursor = (state) => {
    if (!onCursor) return;
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    onCursor(line.number, head - line.from + 1);
  };
  const listener = EditorView.updateListener.of((u) => {
    if (u.docChanged && onChange) onChange(u.state.doc.toString());
    // Clicks, arrow keys, typing — anything moving the caret fires an update
    // with selectionSet; doc changes remap the selection too, so report then
    // as well to keep the status bar honest.
    if (u.selectionSet || u.docChanged) reportCursor(u.state);
  });

  const state = EditorState.create({
    doc,
    extensions: [
      lineNumbers(),
      history(),
      // Native browser selection (no drawSelection) — robust under the zoom
      // transform, which otherwise throws off CodeMirror's own selection
      // coordinate measurement in WebKitGTK. Styled via `.cm-content ::selection`.
      highlightActiveLine(),
      // Find/replace panel (Ctrl/Cmd+F, replace via Ctrl/Cmd+H) plus
      // auto-highlight of all matches of the current selection.
      // Panel pinned to the editor bottom, just above the status bar.
      search({ top: false }),
      highlightSelectionMatches(),
      EditorView.lineWrapping,
      markdown({ base: markdownLanguage, codeLanguages: [] }),
      syntaxHighlighting(highlight),
      keymap.of([...defaultKeymap, ...searchKeymap, ...historyKeymap, indentWithTab]),
      theme,
      listener,
    ],
  });

  return new EditorView({ state, parent });
}

/** Replace the editor's whole document (e.g. when a new file is loaded). */
export function setEditorDoc(view, text) {
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
  });
}
