/**
 * Minimal, dependency-free XML parser — enough for SVG, no browser DOM.
 *
 * Produces a plain element tree (`XmlElement`): tag local-name, attributes, child
 * elements, and concatenated direct text. It skips comments, CDATA sections,
 * processing instructions, and the DOCTYPE, decodes the standard XML entities
 * (plus numeric character references), and strips namespace prefixes from tags
 * and from `xlink:` attributes (so `xlink:href` reads as `href`). It is a
 * well-formed-input parser, not a validator: it throws on obviously broken
 * markup (unclosed tags, mismatched end tags) rather than trying to recover.
 */

export interface XmlElement {
  /** Local tag name (namespace prefix stripped), e.g. `svg`, `linearGradient`. */
  readonly tag: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: readonly XmlElement[];
  /** Concatenated direct text content (whitespace preserved). */
  readonly text: string;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** Decode XML entities and numeric character references in a run of text. */
function decodeEntities(s: string): string {
  if (s.indexOf('&') === -1) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, body) ? ENTITIES[body] : m;
  });
}

/** Strip a namespace prefix, keeping `xlink:href` addressable as `href`. */
function localName(qualified: string): string {
  const colon = qualified.indexOf(':');
  return colon === -1 ? qualified : qualified.slice(colon + 1);
}

interface MutableElement {
  tag: string;
  attrs: Record<string, string>;
  children: MutableElement[];
  text: string;
}

/** Parse an XML/SVG source string into its root element. */
export function parseXml(src: string): XmlElement {
  let i = 0;
  const n = src.length;

  const skipUntil = (marker: string): void => {
    const at = src.indexOf(marker, i);
    i = at === -1 ? n : at + marker.length;
  };

  // Advance past prolog / comments / doctype until the first element.
  const stack: MutableElement[] = [];
  let root: MutableElement | null = null;

  const parseAttrs = (raw: string): Record<string, string> => {
    const attrs: Record<string, string> = {};
    const re = /([^\s=/]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) {
      const name = localName(m[1]);
      const value = decodeEntities(m[3] !== undefined ? m[3] : m[4] ?? '');
      attrs[name] = value;
    }
    return attrs;
  };

  while (i < n) {
    if (src[i] === '<') {
      if (src.startsWith('<!--', i)) {
        i += 4;
        skipUntil('-->');
        continue;
      }
      if (src.startsWith('<![CDATA[', i)) {
        const end = src.indexOf(']]>', i);
        const content = src.slice(i + 9, end === -1 ? n : end);
        if (stack.length) stack[stack.length - 1].text += content;
        i = end === -1 ? n : end + 3;
        continue;
      }
      if (src.startsWith('<!', i) || src.startsWith('<?', i)) {
        // DOCTYPE or processing instruction — skip to the closing '>'.
        skipUntil('>');
        continue;
      }
      if (src[i + 1] === '/') {
        // End tag.
        const close = src.indexOf('>', i);
        const tag = localName(src.slice(i + 2, close === -1 ? n : close).trim());
        const top = stack.pop();
        if (!top || top.tag !== tag) {
          throw new Error(`mismatched closing tag </${tag}>`);
        }
        i = close === -1 ? n : close + 1;
        continue;
      }
      // Start (or self-closing) tag.
      const close = src.indexOf('>', i);
      if (close === -1) throw new Error('unterminated tag');
      let inner = src.slice(i + 1, close);
      const selfClose = inner.endsWith('/');
      if (selfClose) inner = inner.slice(0, -1);
      const space = inner.search(/\s/);
      const tag = localName((space === -1 ? inner : inner.slice(0, space)).trim());
      const attrs = space === -1 ? {} : parseAttrs(inner.slice(space + 1));
      const el: MutableElement = { tag, attrs, children: [], text: '' };
      if (stack.length) stack[stack.length - 1].children.push(el);
      else if (!root) root = el;
      if (!selfClose) stack.push(el);
      i = close + 1;
      continue;
    }
    // Text content up to the next '<'.
    const lt = src.indexOf('<', i);
    const text = src.slice(i, lt === -1 ? n : lt);
    if (stack.length && text) stack[stack.length - 1].text += decodeEntities(text);
    i = lt === -1 ? n : lt;
  }

  if (!root) throw new Error('no root element found');
  if (stack.length) throw new Error(`unclosed element <${stack[stack.length - 1].tag}>`);
  return root;
}

/** Collect the text of an element and all its descendants, in document order. */
export function textContent(el: XmlElement): string {
  let out = el.text;
  for (const c of el.children) out += textContent(c);
  return out;
}
