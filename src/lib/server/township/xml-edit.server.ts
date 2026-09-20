/**
 * Small helpers for editing the Township save XML by string replacement.
 *
 * The save is a flat XML document; we never parse/serialize it (that would
 * reorder attributes and rewrite entities). Instead every edit is a targeted
 * replacement, which means each helper here has to keep the document
 * well-formed on its own:
 *
 *  - `replaceElement` swaps a whole element, including its closing tag and
 *    children, so a self-closing rewrite cannot leave a stray `</Tag>`.
 *  - `insertInsideRoot` appends before the real document root closer, falling
 *    back to EOF only when the document is not a single-rooted fragment.
 */

const ROOT_CLOSERS = ["</Global>", "</Root>", "</ROOT>", "</root>"];

/** Locate the closing tag that ends the document root. */
function rootCloser(xml: string): { index: number; length: number } | null {
  let best: { index: number; length: number } | null = null;
  for (const closer of ROOT_CLOSERS) {
    const i = xml.lastIndexOf(closer);
    if (i < 0) continue;
    if (!best || i + closer.length > best.index + best.length) {
      best = { index: i, length: closer.length };
    }
  }
  return best;
}

/**
 * Range of the element starting at `start`, where `xml[start]` is `<`.
 * Handles self-closing, nested same-name children, and the plain case.
 */
export function elementRange(xml: string, start: number): { start: number; end: number } | null {
  if (xml[start] !== "<") return null;
  const nameMatch = /^<([A-Za-z_][\w.:-]*)/.exec(xml.slice(start));
  if (!nameMatch) return null;
  const name = nameMatch[1]!;
  const gt = xml.indexOf(">", start);
  if (gt < 0) return null;
  if (xml[gt - 1] === "/") return { start, end: gt + 1 };

  const open = new RegExp(`<${name}\\b`, "gi");
  const close = new RegExp(`</${name}\\s*>`, "gi");
  let depth = 1;
  let pos = gt + 1;
  while (depth > 0) {
    open.lastIndex = pos;
    close.lastIndex = pos;
    const o = open.exec(xml);
    const c = close.exec(xml);
    if (!c) return null;
    if (o && o.index < c.index) {
      const oGt = xml.indexOf(">", o.index);
      if (oGt < 0) return null;
      if (xml[oGt - 1] !== "/") depth++;
      pos = oGt + 1;
    } else {
      depth--;
      if (depth === 0) return { start, end: c.index + c[0].length };
      pos = c.index + c[0].length;
    }
  }
  return null;
}

/**
 * Replace the first element named `name` with `replacement`.
 * Returns the original string when the element is absent.
 */
export function replaceElement(xml: string, name: string, replacement: string): string {
  const re = new RegExp(`<${name}\\b`, "i");
  const m = re.exec(xml);
  if (!m || m.index === undefined) return xml;
  const range = elementRange(xml, m.index);
  if (!range) return xml;
  return xml.slice(0, range.start) + replacement + xml.slice(range.end);
}

/** True when an element named `name` exists anywhere in the document. */
export function hasElement(xml: string, name: string): boolean {
  return new RegExp(`<${name}\\b`, "i").test(xml);
}

/** Insert `fragment` immediately before the document root's closing tag. */
export function insertInsideRoot(xml: string, fragment: string): string {
  const closer = rootCloser(xml);
  if (closer) {
    const sep = xml[closer.index - 1] === "\n" ? "" : "\n";
    return xml.slice(0, closer.index) + sep + fragment + xml.slice(closer.index);
  }
  // No root closer: a trailing `<Tag/>` sibling keeps the fragment inside the
  // document instead of appending after it, which is where a bare `xml + frag`
  // would land when the root element is not named Global/Root.
  const trimmed = xml.replace(/\s*$/, "");
  const open = /^<\?xml[^>]*\?>/.exec(trimmed);
  const firstTag = /<([A-Za-z_][\w.:-]*)\b/.exec(trimmed.slice(open ? open[0].length : 0));
  if (open && firstTag && !new RegExp(`</${firstTag[1]}\\s*>`, "i").test(trimmed)) {
    return `${trimmed}${fragment}`;
  }
  return xml + fragment;
}

/**
 * Cheap tag-balance check for the save document.
 *
 * Guards the push path: a malformed save makes the game discard progress, and
 * from the user's side the edited feature "did nothing". Refusing the push with
 * a clear error is far better than writing a save the game cannot load.
 *
 * Deliberately not a full parser — it skips comments, CDATA and declarations,
 * and only verifies that every open tag has a matching closer in order.
 */
export function findUnbalancedTag(xml: string): string | null {
  const text = xml.replace(/<\?[\s\S]*?\?>/g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");
  const stack: string[] = [];
  const tagRe = /<(\/?)([A-Za-z_][\w.:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(text))) {
    const closing = m[1] === "/";
    const name = m[2]!;
    const selfClosing = m[4] === "/" || m[3]!.trimEnd().endsWith("/");
    if (selfClosing) continue;
    if (closing) {
      const open = stack.pop();
      if (open !== name) return open ? `</${name}> closes <${open}>` : `unexpected </${name}>`;
    } else {
      stack.push(name);
    }
  }
  return stack.length ? `unclosed <${stack[stack.length - 1]}>` : null;
}
/** Read an attribute from a captured open-tag attribute string. */
export function attrValue(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s/>]+)`, "i"));
  if (!m) return null;
  return m[1]!.replace(/^["']|["']$/g, "");
}
