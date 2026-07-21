/**
 * SVG export — serialize a `SceneDocument` back to an SVG string (the inverse of
 * `importSvg`). Owned and dependency-free.
 *
 * Covers the vector core: `path` nodes (with solid / linear / radial gradient
 * fills and strokes, fill rule, and stroke caps/joins/miter), `group`s, and
 * `layer` rectangles, each with its transform and opacity. Colours are converted
 * from the model's linear-light back to sRGB (SVG is authored in sRGB). Nodes SVG
 * can't represent losslessly — conic gradients (no SVG primitive → the first stop
 * as a solid), image-paint fills, text, booleans — degrade gracefully rather than
 * emit invalid markup. Pure and DOM-free, so it's unit-tested with no browser.
 */

import type { SceneDocument } from '../document';
import { transformPoint, type Mat2D } from '../matrix';
import type { GroupNode, LayerNode, PathNode, SceneNode, Stroke } from '../node';
import { normalizedStops, type Gradient, type Paint } from '../paint';
import type { Bounds } from '../bounds';
import type { Path } from '../path';
import type { LinearRgba } from '../render-list';
import { toMatrix } from '../transform';

/** Options for `exportSvg`. */
export interface SvgExportOptions {
  /** Explicit viewBox `[minX, minY, width, height]`; default fits the content. */
  readonly viewBox?: readonly [number, number, number, number];
  /** Padding added around the fitted content viewBox (default 0). */
  readonly padding?: number;
}

/** A compact number: rounded to 4 decimals, trailing zeros stripped. */
function num(n: number): string {
  const r = Math.round(n * 1e4) / 1e4;
  return Object.is(r, -0) ? '0' : String(r);
}

/** Exact linear-light → sRGB transfer for one 0–1 channel. */
function toSrgb(c: number): number {
  const v = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.min(255, Math.max(0, Math.round(v * 255)));
}

/** A linear colour → `#rrggbb`. */
function hex(c: LinearRgba): string {
  const h = (v: number): string => toSrgb(v).toString(16).padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

/** Escape a string for an XML attribute value. */
function attrEsc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Serialize a path's subpaths to SVG path data (M/L/Q/C/Z). */
export function pathToData(path: Path): string {
  const out: string[] = [];
  for (const sp of path.subpaths) {
    out.push(`M${num(sp.start.x)} ${num(sp.start.y)}`);
    for (const seg of sp.segments) {
      if (seg.type === 'line') {
        out.push(`L${num(seg.to.x)} ${num(seg.to.y)}`);
      } else if (seg.type === 'quad') {
        out.push(`Q${num(seg.control.x)} ${num(seg.control.y)} ${num(seg.to.x)} ${num(seg.to.y)}`);
      } else {
        out.push(
          `C${num(seg.c1.x)} ${num(seg.c1.y)} ${num(seg.c2.x)} ${num(seg.c2.y)} ${num(seg.to.x)} ${num(seg.to.y)}`
        );
      }
    }
    if (sp.closed) out.push('Z');
  }
  return out.join(' ');
}

const SPREAD_SVG: Record<string, string> = { pad: 'pad', repeat: 'repeat', reflect: 'reflect' };

/** Collects gradient <defs>, handing back a stable id per distinct gradient. */
class Defs {
  private readonly items: string[] = [];
  private n = 0;

  add(g: Gradient): string {
    const id = `g${this.n++}`;
    const stops = normalizedStops(g.stops)
      .map((s) => `<stop offset="${num(s.offset)}" stop-color="${hex(s.color)}" stop-opacity="${num(s.color.a)}"/>`)
      .join('');
    const spread = g.spread && g.spread !== 'pad' ? ` spreadMethod="${SPREAD_SVG[g.spread]}"` : '';
    if (g.type === 'linear-gradient') {
      this.items.push(
        `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${num(g.start.x)}" y1="${num(g.start.y)}" x2="${num(g.end.x)}" y2="${num(g.end.y)}"${spread}>${stops}</linearGradient>`
      );
    } else {
      // radial: end circle → (cx,cy,r), start circle → focal (fx,fy,fr).
      this.items.push(
        `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${num(g.end.center.x)}" cy="${num(g.end.center.y)}" r="${num(g.end.radius)}" fx="${num(g.start.center.x)}" fy="${num(g.start.center.y)}" fr="${num(g.start.radius)}"${spread}>${stops}</radialGradient>`
      );
    }
    return id;
  }

  markup(): string {
    return this.items.length ? `<defs>${this.items.join('')}</defs>` : '';
  }
}

/** A paint → an SVG paint value (`#hex`, `url(#id)`, or `none`) + its opacity.
 *  Gradients register a def; conic falls back to its first stop; image to none. */
function paintValue(paint: Paint | undefined, defs: Defs): { value: string; opacity: number } {
  if (!paint) return { value: 'none', opacity: 1 };
  if (paint.type === 'solid') return { value: hex(paint.color), opacity: paint.color.a };
  if (paint.type === 'image') return { value: 'none', opacity: 1 };
  if (paint.type === 'conic-gradient') {
    const s = normalizedStops(paint.stops)[0];
    return { value: hex(s.color), opacity: s.color.a };
  }
  return { value: `url(#${defs.add(paint)})`, opacity: 1 };
}

/** Fill + stroke presentation attributes for a painted node. */
function paintAttrs(fill: Paint | undefined, fillRule: string | undefined, stroke: Stroke | undefined, defs: Defs): string {
  const a: string[] = [];
  const f = paintValue(fill, defs);
  a.push(`fill="${f.value}"`);
  if (f.opacity < 1) a.push(`fill-opacity="${num(f.opacity)}"`);
  if (fillRule === 'evenodd') a.push('fill-rule="evenodd"');
  if (stroke) {
    const s = paintValue(stroke.paint, defs);
    a.push(`stroke="${s.value}"`, `stroke-width="${num(stroke.width)}"`);
    if (s.opacity < 1) a.push(`stroke-opacity="${num(s.opacity)}"`);
    if (stroke.cap && stroke.cap !== 'butt') a.push(`stroke-linecap="${stroke.cap}"`);
    if (stroke.join && stroke.join !== 'miter') a.push(`stroke-linejoin="${stroke.join}"`);
    if (stroke.miterLimit != null && stroke.miterLimit !== 4) a.push(`stroke-miterlimit="${num(stroke.miterLimit)}"`);
  }
  return a.join(' ');
}

/** `transform="matrix(...)"` for a non-identity local matrix, else ''. */
function transformAttr(m: Mat2D): string {
  if (m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && m.e === 0 && m.f === 0) return '';
  return ` transform="matrix(${num(m.a)} ${num(m.b)} ${num(m.c)} ${num(m.d)} ${num(m.e)} ${num(m.f)})"`;
}

function opacityAttr(node: SceneNode): string {
  const o = (node as { opacity?: number }).opacity;
  return o != null && o < 1 ? ` opacity="${num(o)}"` : '';
}

/** Union the world-space AABB of every drawable node (for a fitted viewBox). */
function contentBounds(doc: SceneDocument): Bounds | null {
  let b: Bounds | null = null;
  const visit = (node: SceneNode): void => {
    if ((node as { visible?: boolean }).visible === false) return;
    const local = doc.getLocalBounds(node.id);
    if (local) {
      const m = doc.getWorldMatrix(node.id);
      for (const p of [
        transformPoint(m, { x: local.minX, y: local.minY }),
        transformPoint(m, { x: local.maxX, y: local.minY }),
        transformPoint(m, { x: local.minX, y: local.maxY }),
        transformPoint(m, { x: local.maxX, y: local.maxY }),
      ]) {
        b = b
          ? { minX: Math.min(b.minX, p.x), minY: Math.min(b.minY, p.y), maxX: Math.max(b.maxX, p.x), maxY: Math.max(b.maxY, p.y) }
          : { minX: p.x, minY: p.y, maxX: p.x, maxY: p.y };
      }
    }
    for (const c of doc.getChildren(node.id)) visit(c);
  };
  for (const c of doc.getChildren(doc.root.id)) visit(c);
  return b;
}

/** Serialize `doc` to a standalone SVG string. */
export function exportSvg(doc: SceneDocument, options: SvgExportOptions = {}): string {
  const defs = new Defs();

  const emit = (node: SceneNode, indent: string): string => {
    if ((node as { visible?: boolean }).visible === false) return '';
    const tf = transformAttr(doc.getLocalMatrix(node));
    const op = opacityAttr(node);
    if (node.type === 'group') {
      const g = node as GroupNode;
      const kids = doc.getChildren(node.id).map((c) => emit(c, indent + '  ')).filter(Boolean);
      if (kids.length === 0 && !tf && !op) return '';
      const nm = g.name ? ` id="${attrEsc(g.name)}"` : '';
      return `${indent}<g${nm}${tf}${op}>\n${kids.join('\n')}\n${indent}</g>`;
    }
    if (node.type === 'path') {
      const p = node as PathNode;
      const d = pathToData(p.path);
      if (!d) return '';
      return `${indent}<path d="${d}" ${paintAttrs(p.fill, p.fillRule, p.stroke, defs)}${tf}${op}/>`;
    }
    if (node.type === 'layer') {
      const l = node as LayerNode;
      const f = paintValue(l.fill, defs);
      const fo = f.opacity < 1 ? ` fill-opacity="${num(f.opacity)}"` : '';
      return `${indent}<rect x="0" y="0" width="${num(l.size.x)}" height="${num(l.size.y)}" fill="${f.value}"${fo}${tf}${op}/>`;
    }
    // Unsupported (text, image, boolean): recurse children if any, else skip.
    const kids = doc.getChildren(node.id).map((c) => emit(c, indent)).filter(Boolean);
    return kids.join('\n');
  };

  const body = doc.getChildren(doc.root.id).map((c) => emit(c, '  ')).filter(Boolean).join('\n');
  const defsMarkup = defs.markup();

  const vb = options.viewBox ?? (() => {
    const b = contentBounds(doc);
    const pad = options.padding ?? 0;
    if (!b) return [0, 0, 100, 100] as const;
    return [b.minX - pad, b.minY - pad, b.maxX - b.minX + 2 * pad, b.maxY - b.minY + 2 * pad] as const;
  })();
  const viewBox = `${num(vb[0])} ${num(vb[1])} ${num(vb[2])} ${num(vb[3])}`;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${num(vb[2])}" height="${num(vb[3])}">\n` +
    (defsMarkup ? `  ${defsMarkup}\n` : '') +
    (body ? body + '\n' : '') +
    `</svg>\n`
  );
}
