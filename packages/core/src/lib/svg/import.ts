/**
 * SVG import orchestrator — turns an SVG source string into scene-document nodes.
 *
 * Walks the parsed element tree with an inherited presentation-style context
 * (fill / stroke / stroke-width / fill-rule / colour / font-*, resolved from
 * presentation attributes and the element's inline `style=`, the latter winning)
 * and emits nodes:
 *   - `<svg>`     → a root group carrying the viewBox → viewport transform,
 *   - `<g>`       → a group (its `transform`, `opacity`),
 *   - shapes      → path nodes (rect/circle/ellipse/line/polyline/polygon/path),
 *   - `<text>`    → a text node (font resolved via the caller's `fontFor`),
 *   - `<use>`     → the referenced element, re-imported at the use's position,
 *   - `<defs>`    → skipped (gradients are pre-collected).
 *
 * Geometry is authored in each element's own user space; the element's own
 * `transform` becomes the node transform, so the scene graph composes ancestor
 * transforms exactly (no baking into leaf coordinates). Paints resolve against
 * the gradient registry in the shape's local space.
 */

import type { Bounds } from '../bounds';
import type { SceneDocument } from '../document';
import type { NodeId } from '../id';
import { transformPoint, type Mat2D } from '../matrix';
import type { GroupNode, PathNode, Stroke, TextNode } from '../node';
import type { Gradient, Paint } from '../paint';
import {
  ellipsePath,
  pathBounds,
  polygonPath,
  rectPath,
  roundedRectPath,
  type FillRule,
  type Path,
  type SubPath,
} from '../path';
import type { TextAlign } from '../text/layout';
import type { LinearRgba } from '../render-list';
import { createTransform, matrixToTransform, type Transform } from '../transform';
import { vec2, type Vec2 } from '../vec2';
import { parseColor } from './color';
import { collectGradients, paintRefId, parseInlineStyle, resolveGradient, type GradientRegistry } from './gradients';
import { parsePathData } from './path-data';
import { parseTransform } from './transform-attr';
import { parseXml, textContent, type XmlElement } from './xml';

/** How the caller maps an SVG `font-family` to a registered rendera font id. */
export type FontResolver = (family: string | undefined) => string;

export interface SvgImportOptions {
  /** Map `font-family` → a registered `fontId` (default: the family verbatim). */
  fontFor?: FontResolver;
  /** Colour that `currentColor` resolves to at the root (default opaque black). */
  currentColor?: LinearRgba;
}

export interface SvgImportResult {
  /** The root group node wrapping the imported tree. */
  rootId: NodeId;
  /** Viewport width in px (from `width`, else the viewBox). */
  width: number;
  /** Viewport height in px. */
  height: number;
  /** Distinct font ids referenced by imported text nodes. */
  fonts: string[];
}

/** Inherited presentation properties as we descend the tree. */
interface StyleCtx {
  fill: string;
  fillOpacity: number;
  fillRule: FillRule;
  stroke: string;
  strokeOpacity: number;
  strokeWidth: number;
  color: LinearRgba;
  fontFamily: string | undefined;
  fontSize: number;
  textAnchor: string;
}

const ROOT_STYLE = (color: LinearRgba): StyleCtx => ({
  fill: 'black', // SVG initial fill is opaque black
  fillOpacity: 1,
  fillRule: 'nonzero',
  stroke: 'none',
  strokeOpacity: 1,
  strokeWidth: 1,
  color,
  fontFamily: undefined,
  fontSize: 16,
  textAnchor: 'start',
});

/** Merge an element's presentation attributes + inline style onto the parent. */
function resolveStyle(el: XmlElement, parent: StyleCtx): StyleCtx {
  const style = parseInlineStyle(el.attrs['style']);
  const prop = (name: string): string | undefined => style[name] ?? el.attrs[name];
  const numProp = (name: string, fallback: number): number => {
    const v = prop(name);
    if (v === undefined) return fallback;
    const n = v.endsWith('%') ? (parseFloat(v) / 100) * fallback : parseFloat(v);
    return Number.isNaN(n) ? fallback : n;
  };

  const colorProp = prop('color');
  const color = colorProp ? parseColor(colorProp, parent.color) ?? parent.color : parent.color;
  const fillRule = (prop('fill-rule') as FillRule) ?? parent.fillRule;

  return {
    fill: prop('fill') ?? parent.fill,
    fillOpacity: clamp01(numProp('fill-opacity', parent.fillOpacity)),
    fillRule: fillRule === 'evenodd' ? 'evenodd' : 'nonzero',
    stroke: prop('stroke') ?? parent.stroke,
    strokeOpacity: clamp01(numProp('stroke-opacity', parent.strokeOpacity)),
    strokeWidth: numProp('stroke-width', parent.strokeWidth),
    color,
    fontFamily: prop('font-family') ?? parent.fontFamily,
    fontSize: numProp('font-size', parent.fontSize),
    textAnchor: prop('text-anchor') ?? parent.textAnchor,
  };
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Resolve a fill/stroke value + opacity into a rendera Paint (or null). */
function resolvePaint(
  value: string,
  opacity: number,
  ctx: StyleCtx,
  gradients: GradientRegistry,
  bbox: Bounds | null
): Paint | null {
  const ref = paintRefId(value);
  if (ref && bbox) {
    const grad = resolveGradient(gradients, ref, bbox);
    if (grad) return withOpacity(grad, opacity);
  }
  const color = parseColor(value, ctx.color);
  if (!color) return null; // 'none'
  return { type: 'solid', color: { ...color, a: color.a * opacity } };
}

function withOpacity(g: Gradient, opacity: number): Gradient {
  if (opacity >= 1) return g;
  return { ...g, stops: g.stops.map((s) => ({ ...s, color: { ...s.color, a: s.color.a * opacity } })) };
}

/** Node transform from an element's `transform` attribute (decomposed). */
function nodeTransform(el: XmlElement): Transform {
  const t = el.attrs['transform'];
  return t ? matrixToTransform(parseTransform(t)) : createTransform();
}

// --- shape → path -----------------------------------------------------------

const num = (v: string | undefined, fallback = 0): number => {
  if (v === undefined) return fallback;
  const n = parseFloat(v);
  return Number.isNaN(n) ? fallback : n;
};

function parsePoints(s: string | undefined): Vec2[] {
  if (!s) return [];
  const nums = s.split(/[\s,]+/).filter((t) => t !== '').map(Number);
  const pts: Vec2[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) pts.push(vec2(nums[i], nums[i + 1]));
  return pts;
}

/** An open polyline path through `points` (no closing edge). */
function polylinePath(points: readonly Vec2[]): Path {
  if (points.length === 0) return { subpaths: [] };
  const sub: SubPath = {
    start: points[0],
    closed: false,
    segments: points.slice(1).map((to) => ({ type: 'line', to }) as const),
  };
  return { subpaths: [sub] };
}

/** A rect with (optionally elliptical) rounded corners rx/ry. */
function roundedRectXY(x: number, y: number, w: number, h: number, rx: number, ry: number): Path {
  const a = Math.min(rx, w / 2);
  const b = Math.min(ry, h / 2);
  if (a <= 0 || b <= 0) return rectPath(x, y, w, h);
  if (a === b) return roundedRectPath(x, y, w, h, a);
  // Elliptical corners: four quarter-arcs (approximated as cubics via parsePathData).
  const d =
    `M${x + a},${y} H${x + w - a} A${a},${b} 0 0 1 ${x + w},${y + b} ` +
    `V${y + h - b} A${a},${b} 0 0 1 ${x + w - a},${y + h} ` +
    `H${x + a} A${a},${b} 0 0 1 ${x},${y + h - b} ` +
    `V${y + b} A${a},${b} 0 0 1 ${x + a},${y} Z`;
  return parsePathData(d);
}

/** Build a path for a shape element, or null if it isn't a shape. */
function shapePath(el: XmlElement): Path | null {
  const a = el.attrs;
  switch (el.tag) {
    case 'rect': {
      const w = num(a['width']);
      const h = num(a['height']);
      if (w <= 0 || h <= 0) return { subpaths: [] };
      const rx = a['rx'] !== undefined ? num(a['rx']) : a['ry'] !== undefined ? num(a['ry']) : 0;
      const ry = a['ry'] !== undefined ? num(a['ry']) : a['rx'] !== undefined ? num(a['rx']) : 0;
      return roundedRectXY(num(a['x']), num(a['y']), w, h, rx, ry);
    }
    case 'circle': {
      const r = num(a['r']);
      return r > 0 ? ellipsePath(num(a['cx']), num(a['cy']), r, r) : { subpaths: [] };
    }
    case 'ellipse': {
      const rx = num(a['rx']);
      const ry = num(a['ry']);
      return rx > 0 && ry > 0 ? ellipsePath(num(a['cx']), num(a['cy']), rx, ry) : { subpaths: [] };
    }
    case 'line':
      return polylinePath([vec2(num(a['x1']), num(a['y1'])), vec2(num(a['x2']), num(a['y2']))]);
    case 'polyline':
      return polylinePath(parsePoints(a['points']));
    case 'polygon':
      return polygonPath(parsePoints(a['points']));
    case 'path':
      return a['d'] ? parsePathData(a['d']) : { subpaths: [] };
    default:
      return null;
  }
}

// --- tree walk --------------------------------------------------------------

interface Walker {
  doc: SceneDocument;
  gradients: GradientRegistry;
  byId: Map<string, XmlElement>;
  fontFor: FontResolver;
  fonts: Set<string>;
}

function strokeFrom(ctx: StyleCtx, style: StyleCtx, gradients: GradientRegistry, bbox: Bounds | null): Stroke | undefined {
  if (style.stroke === 'none' || style.strokeWidth <= 0) return undefined;
  const paint = resolvePaint(style.stroke, style.strokeOpacity, ctx, gradients, bbox);
  if (!paint) return undefined;
  return { paint, width: style.strokeWidth };
}

function emitShape(w: Walker, el: XmlElement, style: StyleCtx, parentId: NodeId): void {
  const path = shapePath(el);
  if (!path || path.subpaths.length === 0) return;
  const bbox = pathBounds(path);
  // A <line> has no interior, so SVG never fills it — it is stroke-only.
  const fillable = el.tag !== 'line' && style.fill !== 'none';
  const fill = fillable ? resolvePaint(style.fill, style.fillOpacity, style, w.gradients, bbox) ?? undefined : undefined;
  const stroke = strokeFrom(style, style, w.gradients, bbox);
  if (!fill && !stroke) return; // invisible
  w.doc.insert<PathNode>(
    {
      type: 'path',
      name: el.attrs['id'] || el.tag,
      path,
      fill,
      fillRule: style.fillRule,
      stroke,
      transform: nodeTransform(el),
      opacity: elementOpacity(el),
    },
    { parentId }
  );
}

function emitText(w: Walker, el: XmlElement, style: StyleCtx, parentId: NodeId): void {
  const text = textContent(el).replace(/\s+/g, ' ').trim();
  if (text === '') return;
  const fontId = w.fontFor(style.fontFamily);
  w.fonts.add(fontId);
  const x = num(el.attrs['x']);
  const y = num(el.attrs['y']);
  // SVG positions the baseline at (x, y); rendera's text origin is the block top,
  // so drop by an approximate ascender (~0.8em) to seat the baseline near y.
  const translation = vec2(x, y - 0.8 * style.fontSize);
  const fill = style.fill === 'none' ? undefined : resolvePaint(style.fill, style.fillOpacity, style, w.gradients, null) ?? undefined;
  w.doc.insert<TextNode>(
    {
      type: 'text',
      name: el.attrs['id'] || 'text',
      text,
      fontId,
      fontSize: style.fontSize,
      fill,
      align: anchorToAlign(style.textAnchor),
      transform: createTransform({ translation }),
      opacity: elementOpacity(el),
    },
    { parentId }
  );
}

function anchorToAlign(anchor: string): TextAlign {
  if (anchor === 'middle') return 'center';
  if (anchor === 'end') return 'right';
  return 'left';
}

function elementOpacity(el: XmlElement): number | undefined {
  const style = parseInlineStyle(el.attrs['style']);
  const v = style['opacity'] ?? el.attrs['opacity'];
  if (v === undefined) return undefined;
  const n = v.endsWith('%') ? parseFloat(v) / 100 : parseFloat(v);
  return Number.isNaN(n) ? undefined : clamp01(n);
}

const SKIP = new Set(['defs', 'symbol', 'marker', 'clipPath', 'mask', 'pattern', 'style', 'title', 'desc', 'metadata', 'linearGradient', 'radialGradient']);

function walk(w: Walker, el: XmlElement, parentStyle: StyleCtx, parentId: NodeId): void {
  if (SKIP.has(el.tag)) return;
  const style = resolveStyle(el, parentStyle);

  if (el.tag === 'g' || el.tag === 'a' || el.tag === 'svg') {
    const group = w.doc.insert<GroupNode>(
      { type: 'group', name: el.attrs['id'] || el.tag, transform: nodeTransform(el), opacity: elementOpacity(el) },
      { parentId }
    );
    for (const child of el.children) walk(w, child, style, group.id);
    return;
  }
  if (el.tag === 'text') {
    emitText(w, el, style, parentId);
    return;
  }
  if (el.tag === 'use') {
    const ref = (el.attrs['href'] ?? '')[0] === '#' ? w.byId.get(el.attrs['href'].slice(1)) : undefined;
    if (!ref) return;
    // Wrap in a group carrying the use's x/y offset + transform, then import the target.
    const offset = vec2(num(el.attrs['x']), num(el.attrs['y']));
    const g = w.doc.insert<GroupNode>(
      { type: 'group', name: 'use', transform: composeUseTransform(el, offset), opacity: elementOpacity(el) },
      { parentId }
    );
    walk(w, ref, style, g.id);
    return;
  }
  // Shape (or an unknown container we recurse through).
  if (shapePath(el)) {
    emitShape(w, el, style, parentId);
  } else {
    for (const child of el.children) walk(w, child, style, parentId);
  }
}

function composeUseTransform(el: XmlElement, offset: Vec2): Transform {
  const base = el.attrs['transform'] ? parseTransform(el.attrs['transform']) : undefined;
  const t = base ? transformPoint(base, offset) : offset;
  const decomposed = base ? matrixToTransform(base) : createTransform();
  return { ...decomposed, translation: t };
}

// --- viewport ---------------------------------------------------------------

interface Viewport {
  matrix: Mat2D;
  width: number;
  height: number;
}

/** Compute the viewBox → viewport transform and the pixel viewport size. */
function viewport(svg: XmlElement): Viewport {
  const width = num(svg.attrs['width'], NaN);
  const height = num(svg.attrs['height'], NaN);
  const vb = svg.attrs['viewBox']
    ? svg.attrs['viewBox'].split(/[\s,]+/).filter((t) => t !== '').map(Number)
    : null;

  if (!vb || vb.length !== 4) {
    const w = Number.isNaN(width) ? 300 : width;
    const h = Number.isNaN(height) ? 150 : height;
    return { matrix: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, width: w, height: h };
  }

  const [minx, miny, vbW, vbH] = vb;
  const vw = Number.isNaN(width) ? vbW : width;
  const vh = Number.isNaN(height) ? vbH : height;
  const par = (svg.attrs['preserveAspectRatio'] ?? 'xMidYMid meet').trim();

  if (par.startsWith('none')) {
    const sx = vw / vbW;
    const sy = vh / vbH;
    return { matrix: { a: sx, b: 0, c: 0, d: sy, e: -minx * sx, f: -miny * sy }, width: vw, height: vh };
  }
  // meet (default): uniform scale, centred (xMidYMid).
  const s = Math.min(vw / vbW, vh / vbH);
  const tx = (vw - vbW * s) / 2 - minx * s;
  const ty = (vh - vbH * s) / 2 - miny * s;
  return { matrix: { a: s, b: 0, c: 0, d: s, e: tx, f: ty }, width: vw, height: vh };
}

/** Import an SVG source string into `doc`, returning the root node and size. */
export function importSvg(doc: SceneDocument, source: string, options: SvgImportOptions = {}): SvgImportResult {
  const root = parseXml(source);
  if (root.tag !== 'svg') throw new Error(`expected an <svg> root, got <${root.tag}>`);

  const currentColor = options.currentColor ?? { r: 0, g: 0, b: 0, a: 1 };
  const gradients = collectGradients(root, currentColor);
  const byId = new Map<string, XmlElement>();
  const index = (el: XmlElement): void => {
    if (el.attrs['id']) byId.set(el.attrs['id'], el);
    el.children.forEach(index);
  };
  index(root);

  const vp = viewport(root);
  const w: Walker = {
    doc,
    gradients,
    byId,
    fontFor: options.fontFor ?? ((family) => family ?? 'default'),
    fonts: new Set(),
  };

  // A root group carries the viewBox → viewport transform; children inherit it.
  const rootGroup = doc.insert<GroupNode>({
    type: 'group',
    name: root.attrs['id'] || 'svg',
    transform: matrixToTransform(vp.matrix),
  });
  const rootStyle = resolveStyle(root, ROOT_STYLE(currentColor));
  for (const child of root.children) walk(w, child, rootStyle, rootGroup.id);

  return { rootId: rootGroup.id, width: vp.width, height: vp.height, fonts: [...w.fonts] };
}
