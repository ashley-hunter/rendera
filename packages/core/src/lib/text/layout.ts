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

  const lines = text.split('\n');

  // Pass 1: shape + place each line's glyphs, measuring line width.
  const perLine = lines.map((line) => {
    const { runs } = itemize(line, baseDir);
    const shaped = runs.map((r) => ({
      level: r.level,
      glyphs: font.shape(line.slice(r.start, r.end), {
        direction: r.rtl ? 'rtl' : 'ltr',
        language: options.language,
        features: options.features,
      }),
    }));
    const visual = reorderRunsVisually(shaped);
    let penX = 0;
    const glyphs: PlacedGlyph[] = [];
    for (const run of visual) {
      for (const g of run.glyphs) {
        glyphs.push({ glyphId: g.glyphId, x: penX + g.xOffset * scale, yOffset: g.yOffset * scale });
        penX += g.xAdvance * scale + letter;
      }
    }
    const width = Math.max(0, penX - (glyphs.length > 0 ? letter : 0));
    return { glyphs, width };
  });
  const blockWidth = perLine.reduce((w, l) => Math.max(w, l.width), 0);

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
  });
}
