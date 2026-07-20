/**
 * Text layout — turn a string + font + style into positioned glyph outlines.
 *
 * Shapes each itemized run with HarfBuzz, reorders runs into visual order by
 * bidi level, advances a pen (with letter spacing) to place glyphs, stacks
 * lines, applies alignment, and bakes every glyph's outline into ONE combined
 * `Path` in the text's local space (Y-down, scaled to the font size). That path
 * is then just vector geometry — it flows through the same analytic fill the
 * renderer already uses, so text is resolution-independent and can carry a
 * solid or gradient fill and a stroke like any other shape.
 *
 * Line wrapping is intentionally out of scope for now (hard `\n` breaks only);
 * it's a follow-up that layers on top of this run model.
 */

import type { Mat2D } from '../matrix';
import type { TextNode } from '../node';
import { transformPath, type Path, type SubPath } from '../path';
import type { RenderaFont } from './font';
import { itemize, reorderRunsVisually } from './itemize';

export type TextAlign = 'left' | 'center' | 'right';
export type TextDirection = 'auto' | 'ltr' | 'rtl';

/** Styling for a laid-out text block. */
export interface TextOptions {
  /** Em size in local px. */
  readonly fontSize: number;
  /** Baseline-to-baseline distance in px; defaults to the font's natural line. */
  readonly lineHeight?: number;
  /** Extra advance between glyphs in px (tracking). */
  readonly letterSpacing?: number;
  /** Horizontal alignment within the block (default `left`). */
  readonly align?: TextAlign;
  /** Base paragraph direction; `auto` detects from the first strong char. */
  readonly direction?: TextDirection;
  /** BCP-47 language for language-specific shaping. */
  readonly language?: string;
  /** OpenType feature toggles, e.g. `['dlig', 'ss01', '-liga']`. */
  readonly features?: readonly string[];
  /** Wrap width in px. When set, lines break greedily at word boundaries (with
   * break-word fallback for overlong tokens) to fit within it. */
  readonly maxWidth?: number;
}

/** The result of laying out a text block. */
export interface TextLayout {
  /** Combined glyph outlines in local space (Y-down, scaled to `fontSize`). */
  readonly path: Path;
  /** Widest line, px. */
  readonly width: number;
  /** Total block height, px. */
  readonly height: number;
  readonly lineCount: number;
  /** First baseline offset from the top, px. */
  readonly ascent: number;
  /** Resolved line height, px. */
  readonly lineHeight: number;
}

interface PlacedGlyph {
  glyphId: number;
  /** Pen x at the glyph origin (px from the line's left edge). */
  x: number;
  /** Vertical shaping offset (px, up-positive). */
  yOffset: number;
}

/** Per-line shaping context (font-independent style, resolved to px scale). */
interface ShapeContext {
  scale: number;
  letter: number;
  baseDir?: 'ltr' | 'rtl';
  language?: string;
  features?: readonly string[];
}

/** Shape one line (bidi-itemized, reordered, pen-advanced) to placed glyphs. */
function shapeLine(font: RenderaFont, line: string, ctx: ShapeContext): { glyphs: PlacedGlyph[]; width: number } {
  const { runs } = itemize(line, ctx.baseDir);
  const shaped = runs.map((r) => ({
    level: r.level,
    glyphs: font.shape(line.slice(r.start, r.end), {
      direction: r.rtl ? 'rtl' : 'ltr',
      language: ctx.language,
      features: ctx.features,
    }),
  }));
  const visual = reorderRunsVisually(shaped);
  let penX = 0;
  const glyphs: PlacedGlyph[] = [];
  for (const run of visual) {
    for (const g of run.glyphs) {
      glyphs.push({ glyphId: g.glyphId, x: penX + g.xOffset * ctx.scale, yOffset: g.yOffset * ctx.scale });
      penX += g.xAdvance * ctx.scale + ctx.letter;
    }
  }
  const width = Math.max(0, penX - (glyphs.length > 0 ? ctx.letter : 0));
  return { glyphs, width };
}

const trimEnd = (s: string): string => s.replace(/\s+$/u, '');

// `Intl.Segmenter` is available on all modern runtimes but absent from some TS
// `lib` targets, so reach it through a typed indirection (with a regex fallback)
// rather than the global type — keeps core self-contained for any consumer.
interface Segments {
  segment(input: string): Iterable<{ segment: string }>;
}
type SegmenterCtor = new (
  locale?: string,
  options?: { granularity?: 'grapheme' | 'word' }
) => Segments;
const IntlSegmenter = (Intl as unknown as { Segmenter?: SegmenterCtor }).Segmenter;

/** Split `text` at word or grapheme boundaries (Intl.Segmenter, with fallback). */
function segments(text: string, granularity: 'word' | 'grapheme', locale?: string): string[] {
  if (IntlSegmenter) {
    return [...new IntlSegmenter(locale || undefined, { granularity }).segment(text)].map((s) => s.segment);
  }
  return granularity === 'word' ? text.split(/(?<=\s)(?=\S)/u) : [...text];
}

/** Split an overlong token to fit `maxWidth` at grapheme boundaries. */
function breakToken(font: RenderaFont, token: string, ctx: ShapeContext, maxWidth: number): string[] {
  if (token === '' || shapeLine(font, token, ctx).width <= maxWidth) {
    return [token];
  }
  const graphemes = segments(token, 'grapheme', ctx.language);
  const out: string[] = [];
  let cur = '';
  for (const g of graphemes) {
    if (cur !== '' && shapeLine(font, cur + g, ctx).width > maxWidth) {
      out.push(cur);
      cur = g;
    } else {
      cur += g;
    }
  }
  if (cur !== '') {
    out.push(cur);
  }
  return out;
}

/** Greedily wrap a paragraph to `maxWidth`, breaking at word boundaries. */
function wrapParagraph(font: RenderaFont, para: string, ctx: ShapeContext, maxWidth: number): string[] {
  if (para === '') {
    return [''];
  }
  const tokens = segments(para, 'word', ctx.language);
  const lines: string[] = [];
  let cur = '';
  for (const tok of tokens) {
    if (cur !== '' && shapeLine(font, trimEnd(cur + tok), ctx).width > maxWidth) {
      lines.push(trimEnd(cur));
      cur = /^\s+$/u.test(tok) ? '' : tok; // whitespace never starts a wrapped line
    } else {
      cur += tok;
    }
  }
  lines.push(trimEnd(cur));
  return lines.flatMap((l) => breakToken(font, l, ctx, maxWidth));
}

/** Lay out `text` with `font` and `options` into positioned glyph outlines. */
export function layoutText(font: RenderaFont, text: string, options: TextOptions): TextLayout {
  const scale = options.fontSize / font.upem;
  const letter = options.letterSpacing ?? 0;
  const align = options.align ?? 'left';
  const baseDir =
    options.direction === 'ltr' ? 'ltr' : options.direction === 'rtl' ? 'rtl' : undefined;
  const m = font.metrics;
  const lineHeight = options.lineHeight ?? (m.ascender + m.descender + m.lineGap) * scale;
  const ascent = m.ascender * scale;
  const ctx: ShapeContext = { scale, letter, baseDir, language: options.language, features: options.features };

  const wrap = options.maxWidth && options.maxWidth > 0 ? options.maxWidth : 0;
  const rawLines = text.split('\n');
  const lines = wrap ? rawLines.flatMap((p) => wrapParagraph(font, p, ctx, wrap)) : rawLines;

  // Pass 1: shape + place each line's glyphs, measuring line width.
  const perLine = lines.map((line) => shapeLine(font, line, ctx));
  // Alignment is within the wrap box when set, else the widest line.
  const blockWidth = wrap ? wrap : perLine.reduce((w, l) => Math.max(w, l.width), 0);

  // Pass 2: bake glyph outlines into one local-space path, aligned + stacked.
  const subpaths: SubPath[] = [];
  perLine.forEach((line, li) => {
    const baseline = ascent + li * lineHeight;
    const offset =
      align === 'center'
        ? (blockWidth - line.width) / 2
        : align === 'right'
          ? blockWidth - line.width
          : 0;
    for (const g of line.glyphs) {
      const em = font.glyphPath(g.glyphId);
      if (em.subpaths.length === 0) {
        continue; // blank glyph (space)
      }
      // em space is Y-up; flip to local Y-down and scale to the font size.
      const place: Mat2D = { a: scale, b: 0, c: 0, d: -scale, e: offset + g.x, f: baseline - g.yOffset };
      subpaths.push(...transformPath(em, place).subpaths);
    }
  });

  const height =
    lines.length > 0 ? (lines.length - 1) * lineHeight + (m.ascender + m.descender) * scale : 0;
  return { path: { subpaths }, width: blockWidth, height, lineCount: lines.length, ascent, lineHeight };
}

/** One glyph placed in the text's local space (origin at the glyph pen/baseline). */
export interface PositionedGlyph {
  readonly glyphId: number;
  /** Pen x at the glyph origin (local px). */
  readonly originX: number;
  /** Baseline y at the glyph origin (local px, Y-down). */
  readonly originY: number;
}

/** Positioned glyphs plus block metrics — the input to atlas (MSDF) rendering. */
export interface GlyphLayout {
  readonly glyphs: readonly PositionedGlyph[];
  readonly width: number;
  readonly height: number;
  readonly lineCount: number;
  readonly ascent: number;
  readonly lineHeight: number;
}

/**
 * Lay out `text` into positioned glyphs (no outline baking) — for atlas/MSDF
 * rendering, where each glyph is drawn as a textured quad. Shares shaping,
 * wrapping, alignment, and line stacking with `layoutText`.
 */
export function layoutTextGlyphs(font: RenderaFont, text: string, options: TextOptions): GlyphLayout {
  const scale = options.fontSize / font.upem;
  const letter = options.letterSpacing ?? 0;
  const align = options.align ?? 'left';
  const baseDir =
    options.direction === 'ltr' ? 'ltr' : options.direction === 'rtl' ? 'rtl' : undefined;
  const m = font.metrics;
  const lineHeight = options.lineHeight ?? (m.ascender + m.descender + m.lineGap) * scale;
  const ascent = m.ascender * scale;
  const ctx: ShapeContext = { scale, letter, baseDir, language: options.language, features: options.features };

  const wrap = options.maxWidth && options.maxWidth > 0 ? options.maxWidth : 0;
  const rawLines = text.split('\n');
  const lines = wrap ? rawLines.flatMap((p) => wrapParagraph(font, p, ctx, wrap)) : rawLines;
  const perLine = lines.map((line) => shapeLine(font, line, ctx));
  const blockWidth = wrap ? wrap : perLine.reduce((w, l) => Math.max(w, l.width), 0);

  const glyphs: PositionedGlyph[] = [];
  perLine.forEach((line, li) => {
    const baseline = ascent + li * lineHeight;
    const offset =
      align === 'center'
        ? (blockWidth - line.width) / 2
        : align === 'right'
          ? blockWidth - line.width
          : 0;
    for (const g of line.glyphs) {
      glyphs.push({ glyphId: g.glyphId, originX: offset + g.x, originY: baseline - g.yOffset });
    }
  });
  const height =
    lines.length > 0 ? (lines.length - 1) * lineHeight + (m.ascender + m.descender) * scale : 0;
  return { glyphs, width: blockWidth, height, lineCount: lines.length, ascent, lineHeight };
}

/** Lay out a `TextNode`'s positioned glyphs (for MSDF), mapping its style. */
export function layoutTextNodeGlyphs(font: RenderaFont, node: TextNode): GlyphLayout {
  return layoutTextGlyphs(font, node.text, {
    fontSize: node.fontSize,
    lineHeight: node.lineHeight,
    letterSpacing: node.letterSpacing,
    align: node.align,
    direction: node.direction,
    language: node.language,
    features: node.features,
    maxWidth: node.maxWidth,
  });
}

/** Lay out a `TextNode` with a resolved font, mapping its style fields. */
export function layoutTextNode(font: RenderaFont, node: TextNode): TextLayout {
  return layoutText(font, node.text, {
    fontSize: node.fontSize,
    lineHeight: node.lineHeight,
    letterSpacing: node.letterSpacing,
    align: node.align,
    direction: node.direction,
    language: node.language,
    features: node.features,
    maxWidth: node.maxWidth,
  });
}
