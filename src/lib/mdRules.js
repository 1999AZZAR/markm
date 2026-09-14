// Shared markdown-it rules for markm's preview.
//
// Why this file exists: markm renders with html:false so a stray <script> in
// some random file can never execute in the WebKitGTK webview. But html:false
// goes further than escaping at render time — markdown-it 14 SKIPS the
// html_inline rule entirely (early `return false`), so a typed `<br>` never
// even becomes a tag token: it sits inside plain TEXT tokens and shows up as
// literal "<br>" (notably in table cells, where people use it for line breaks).
// So instead of renderer rules (which can never fire), this file SPLITS text
// tokens: allowlisted tags (br/ul/ol/li only) are carved out into html_inline
// tokens, everything else stays escaped text. A renderer allowlist backs this
// up as defense-in-depth.
//
// Second rule: lists-in-cells. Standard Markdown tables only allow inline
// content, so `- one<br>- two` would stay literal dashes. The core rule below
// turns dash segments inside a cell into bullets (•), but only when there are
// 2+ of them: a lone "- 5" (arithmetic, flags, prose) is left untouched,
// mirroring how a single "- x" line outside tables is a paragraph, not a list.
//
// Kept framework-free on purpose so it can be unit-checked in plain node:
//   node --input-type=module -e "import('./src/lib/mdRules.js').then(...)"
const ALLOWED_TAGS = /^\s*<\/?(br|ul|ol|li)\s*\/?>\s*$/i;
const TAG_SPLIT_RE = /(<\/?(?:br|ul|ol|li)\s*\/?>)/i;
const BR_TAG = /^\s*<br\s*\/?>\s*$/i;
const BULLET_PREFIX = /^\s*-\s+/;

function blankToken(content) {
  // Duck-typed html_inline token: only .type/.content are ever read
  // (renderer allowlist below + text_join skips non-text types).
  return {
    type: 'html_inline', tag: '', nesting: 0, attrs: null,
    map: null, level: 0, children: null, content,
    markup: '', info: '', meta: {},
  };
}

function splitAllowedTags(md) {
  md.core.ruler.push('markm_tag_split', (state) => {
    const walk = (tokens) => {
      for (const tok of tokens) {
        if (tok.type === 'inline' && tok.children) {
          const out = [];
          for (const kid of tok.children) {
            if (kid.type !== 'text' || !TAG_SPLIT_RE.test(kid.content)) {
              out.push(kid);
              continue;
            }
            const parts = kid.content.split(TAG_SPLIT_RE);
            parts.forEach((part, i) => {
              if (!part) return;
              if (i % 2 === 1) out.push(blankToken(part));
              else out.push({ ...kid, content: part });
            });
          }
          tok.children = out;
        }
      }
    };
    walk(state.tokens);
    return false;
  });
}

// Walk block tokens; inside td/th cells, rewrite "- " segment starts to "• ".
// A segment start = first inline child, or an inline text child immediately
// following a <br>. Only fires with 2+ items (see header comment).
function tableCellBullets(md) {
  md.core.ruler.push('table_cell_bullets', (state) => {
    let inCell = false;
    for (const tok of state.tokens) {
      if (tok.type === 'td_open' || tok.type === 'th_open') inCell = true;
      else if (tok.type === 'td_close' || tok.type === 'th_close') inCell = false;
      else if (inCell && tok.type === 'inline' && tok.children) {
        const kids = tok.children;
        const starts = [];
        kids.forEach((kid, i) => {
          if (kid.type !== 'text' || !BULLET_PREFIX.test(kid.content)) return;
          if (i === 0) { starts.push(kid); return; }
          const prev = kids[i - 1];
          if (prev.type === 'html_inline' && BR_TAG.test(prev.content)) starts.push(kid);
        });
        if (starts.length >= 2) {
          for (const kid of starts) kid.content = kid.content.replace(BULLET_PREFIX, '• ');
        }
      }
    }
    return false;
  });
}

export function applyTableRules(md) {
  // Backstop: any html_inline token from any source passes only allowlisted
  // tags; everything else (e.g. <script>) stays escaped.
  const guard = (tokens, idx) => {
    const content = tokens[idx].content;
    return ALLOWED_TAGS.test(content) ? content : md.utils.escapeHtml(content);
  };
  md.renderer.rules.html_inline = guard;
  md.renderer.rules.html_block = guard;
  // Splitter must run before the bullet rule (bullets key off the <br> tokens).
  splitAllowedTags(md);
  tableCellBullets(md);
}
