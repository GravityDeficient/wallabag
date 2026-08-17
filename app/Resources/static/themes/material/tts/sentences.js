/*
 * Map the sentences the server spoke onto the article DOM.
 *
 * The server sends sentence *text*, not character offsets. Offsets would be
 * cheaper but they are fragile: Wallabag re-renders content through Twig, and a
 * single differing whitespace character shifts every subsequent offset, which
 * shows up as highlighting that is subtly and then badly wrong.
 *
 * Matching on text lets the two sides disagree about whitespace and still line
 * up. The one thing both sides must agree on is which elements are skipped --
 * kept in sync with SKIP_TAGS in the service's text.py.
 */

const SKIP_TAGS = new Set([
  'PRE', 'CODE', 'FIGCAPTION', 'NOSCRIPT', 'SCRIPT', 'STYLE', 'TABLE',
]);

/* Characters that routinely differ between the server's extracted text and the
 * rendered DOM. Typographic quotes and dashes survive one path but not always
 * the other depending on entity decoding; soft hyphens and zero-width joiners
 * are invisible either way and must not defeat a match. Written as escapes
 * because literal invisible characters in source are unreviewable. */
const FOLD = {
  '\u2018': "'",
  '\u2019': "'",
  '\u201b': "'",
  '\u201c': '"',
  '\u201d': '"',
  '\u2013': '-',
  '\u2014': '-',
  '\u2212': '-',
  '\u00ad': '',
  '\u200b': '',
  '\u200c': '',
  '\u200d': '',
  '\ufeff': '',
};

/* Whitespace, including the non-breaking and typographic spaces that HTML
 * entities decode into. */
// JS \s already covers NBSP, the U+2000-U+200A spaces, ideographic space
// BOM, so an explicit class would only risk diverging from it.
const SPACE_RE = /\s/;

/*
 * Fold a string for comparison and, optionally, record where each surviving
 * character came from.
 *
 * normalize() and normalizedIndex() are the same function deliberately: if the
 * needle and the haystack were folded by different rules, matching would fail
 * only on the handful of sentences containing a curly quote, which is exactly
 * the kind of bug that survives testing.
 */
function fold(s, wantMap) {
  let out = '';
  const map = wantMap ? [] : null;
  let prevWasSpace = true;

  for (let i = 0; i < s.length; i += 1) {
    const raw = s[i];
    let ch = null;

    if (SPACE_RE.test(raw)) {
      // Collapse runs, and drop leading whitespace entirely.
      if (!prevWasSpace) {
        ch = ' ';
        prevWasSpace = true;
      }
    } else if (Object.prototype.hasOwnProperty.call(FOLD, raw)) {
      // A folded-to-empty character is dropped and contributes no index.
      const folded = FOLD[raw];
      if (folded !== '') {
        ch = folded;
        prevWasSpace = false;
      }
    } else {
      ch = raw.toLowerCase();
      prevWasSpace = false;
    }

    if (ch !== null) {
      out += ch;
      if (map) map.push(i);
    }
  }

  // A trailing collapsed space would make an exact-length match overshoot into
  // the following sentence.
  if (out.endsWith(' ')) {
    out = out.slice(0, -1);
    if (map) map.pop();
  }
  return map ? { norm: out, map } : out;
}

function normalize(s) {
  return fold(s, false);
}

function normalizedIndex(flat) {
  return fold(flat, true);
}

/* Collect the article's text nodes, skipping the same subtrees the server did,
 * and build one flat string plus an index back into the nodes. */
function flatten(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      for (let el = node.parentElement; el && el !== root; el = el.parentElement) {
        if (SKIP_TAGS.has(el.tagName)) return NodeFilter.FILTER_REJECT;
      }
      return node.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });

  const nodes = [];
  let flat = '';
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push({ node: n, start: flat.length, text: n.nodeValue });
    flat += n.nodeValue;
  }
  return { flat, nodes };
}

/* Wrap [start,end) of the flat string in spans, one per text node it spans.
 * Per-node wrapping always succeeds; Range.surroundContents throws whenever a
 * range crosses an element boundary, which mid-sentence <a> and <em> make
 * routine. */
function wrapRange(nodes, start, end, index) {
  nodes.forEach((rec) => {
    const nodeEnd = rec.start + rec.text.length;
    if (nodeEnd <= start || rec.start >= end) return;

    const from = Math.max(start - rec.start, 0);
    const to = Math.min(end - rec.start, rec.text.length);
    if (to <= from) return;

    const range = document.createRange();
    range.setStart(rec.node, from);
    range.setEnd(rec.node, to);

    const span = document.createElement('span');
    span.className = 'tts-s';
    span.dataset.ttsI = String(index);
    try {
      range.surroundContents(span);
    } catch (e) {
      // A range wholly inside one text node cannot straddle an element, so
      // this should not fire; skipping keeps the remaining spans usable.
    }
  });
}

/*
 * Wrap each spoken sentence in <span class="tts-s" data-tts-i="N">.
 *
 * Returns { matched, total }. Sentences are matched in order and the search
 * only moves forward, so a repeated phrase cannot bind to an earlier
 * occurrence and drag highlighting backwards.
 */
export function markSentences(root, sentences) {
  const { flat, nodes } = flatten(root);
  const { norm, map } = normalizedIndex(flat);

  // Wrapping mutates the DOM, invalidating `nodes`. Resolve every range against
  // the pristine text first, then apply them back-to-front so earlier offsets
  // stay valid.
  const ranges = [];
  let cursor = 0;
  let matched = 0;

  sentences.forEach((sentence, i) => {
    const needle = normalize(sentence.text);
    if (!needle) return;
    let at = norm.indexOf(needle, cursor);
    let { length } = needle;
    if (at === -1) {
      // Fall back to a distinctive prefix: extraction occasionally drops a
      // trailing bracket or footnote marker that is still present in the DOM.
      const head = needle.slice(0, Math.min(40, needle.length));
      if (head.length >= 12) {
        at = norm.indexOf(head, cursor);
        length = head.length;
      }
      if (at === -1) return;
    }
    const lastIdx = Math.min(at + length, map.length) - 1;
    if (lastIdx < at) return;
    ranges.push({ i, rawStart: map[at], rawEnd: map[lastIdx] + 1 });
    cursor = at + length;
    matched += 1;
  });

  for (let k = ranges.length - 1; k >= 0; k -= 1) {
    wrapRange(nodes, ranges[k].rawStart, ranges[k].rawEnd, ranges[k].i);
  }
  return { matched, total: sentences.length };
}

export function sentenceSpans(root, index) {
  return root.querySelectorAll(`.tts-s[data-tts-i="${index}"]`);
}

// Exported for tests.
export const internals = { fold, normalize, flatten };
