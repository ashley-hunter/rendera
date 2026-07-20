/**
 * SVG gradient (`<linearGradient>` / `<radialGradient>`) → rendera `Paint`.
 *
 * Gradient elements are collected into a registry (keyed by `id`), resolving the
 * `href` inheritance chain that lets one gradient borrow another's stops and
 * attributes. Resolving a `fill="url(#id)"` reference produces a rendera
 * `Gradient` expressed in the target shape's LOCAL space — the space its path is
 * authored in — so it composes with the node transform exactly like any paint:
 *
 *  - `userSpaceOnUse`: coordinates are already in the shape's user space.
 *  - `objectBoundingBox` (default): coordinates are unit-square fractions mapped
 *    through the shape's bounding box.
 *  - `gradientTransform` is baked into the resulting points (and the radius via
 *    the transform's scale).
 *
 * Colours interpolate in linear light (rendera's physically-correct default),
 * which can differ subtly at gradient midpoints from SVG's legacy sRGB blending.
 * A radial gradient on a non-square `objectBoundingBox` is a true ellipse in SVG;
 * rendera's two-circle model approximates it with the box's mean radius.
 */

import type { Bounds } from '../bounds';
import { transformPoint, type Mat2D, IDENTITY, determinant } from '../matrix';
import type { Gradient, GradientStop, SpreadMode } from '../paint';
import type { LinearRgba } from '../render-list';
import { vec2, type Vec2 } from '../vec2';
import { parseColor } from './color';
import { parseTransform } from './transform-attr';
import type { XmlElement } from './xml';

interface GradientDef {
  kind: 'linear' | 'radial';
  attrs: Record<string, string>;
  stops: GradientStop[];
}

export type GradientRegistry = Map<string, GradientDef>;

/** Parse `<stop>` children into resolved colour stops (offset-sorted by caller). */
function parseStops(el: XmlElement, current?: LinearRgba): GradientStop[] {
  const stops: GradientStop[] = [];
  for (const child of el.children) {
    if (child.tag !== 'stop') continue;
    const style = parseInlineStyle(child.attrs['style']);
    const get = (k: string): string | undefined => style[k] ?? child.attrs[k];
    const offset = parseOffset(get('offset') ?? '0');
    const color = parseColor(get('stop-color') ?? 'black', current) ?? { r: 0, g: 0, b: 0, a: 1 };
    const opacityRaw = get('stop-opacity');
    const opacity = opacityRaw === undefined ? 1 : clamp01(parseNumberOrPercent(opacityRaw));
    stops.push({ offset, color: { ...color, a: color.a * opacity } });
  }
  return stops;
}

/** Split a `style="a:b;c:d"` declaration into a property map. */
export function parseInlineStyle(style: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!style) return out;
  for (const decl of style.split(';')) {
    const i = decl.indexOf(':');
    if (i === -1) continue;
    const key = decl.slice(0, i).trim();
    const value = decl.slice(i + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

function parseOffset(s: string): number {
  return clamp01(parseNumberOrPercent(s));
}

/** A number, or a percentage that becomes its 0–1 fraction. */
function parseNumberOrPercent(s: string): number {
  const t = s.trim();
  return t.endsWith('%') ? parseFloat(t) / 100 : parseFloat(t);
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Build a registry of every gradient element in the tree, keyed by id. */
export function collectGradients(root: XmlElement, current?: LinearRgba): GradientRegistry {
  const raw = new Map<string, XmlElement>();
  const walk = (el: XmlElement): void => {
    if ((el.tag === 'linearGradient' || el.tag === 'radialGradient') && el.attrs['id']) {
      raw.set(el.attrs['id'], el);
    }
    el.children.forEach(walk);
  };
  walk(root);

  const registry: GradientRegistry = new Map();
  const resolve = (id: string, seen: Set<string>): GradientDef | null => {
    if (registry.has(id)) return registry.get(id) ?? null;
    const el = raw.get(id);
    if (!el || seen.has(id)) return null;
    seen.add(id);

    let attrs: Record<string, string> = { ...el.attrs };
    let stops = parseStops(el, current);
    const href = el.attrs['href'];
    if (href && href[0] === '#') {
      const parent = resolve(href.slice(1), seen);
      if (parent) {
        // Inherit the parent's attributes and, if we have none, its stops.
        attrs = { ...parent.attrs, ...attrs };
        if (stops.length === 0) stops = parent.stops;
      }
    }
    stops = [...stops].sort((a, b) => a.offset - b.offset);
    const def: GradientDef = { kind: el.tag === 'radialGradient' ? 'radial' : 'linear', attrs, stops };
    registry.set(id, def);
    return def;
  };
  for (const id of raw.keys()) resolve(id, new Set());
  return registry;
}

/** Extract the `#id` from a `url(#id)` paint reference, or null. */
export function paintRefId(value: string): string | null {
  const m = /url\(\s*#([^)\s]+)\s*\)/.exec(value);
  return m ? m[1] : null;
}

function spread(method: string | undefined): SpreadMode | undefined {
  if (method === 'repeat') return 'repeat';
  if (method === 'reflect') return 'reflect';
  return undefined; // 'pad' (rendera default)
}

/**
 * Resolve a gradient definition into a rendera `Gradient` in the shape's local
 * space, given the shape's local bounding box. Returns null if the gradient is
 * unknown or has no stops.
 */
export function resolveGradient(
  registry: GradientRegistry,
  id: string,
  bbox: Bounds
): Gradient | null {
  const def = registry.get(id);
  if (!def || def.stops.length === 0) return null;

  const objectBox = (def.attrs['gradientUnits'] ?? 'objectBoundingBox') === 'objectBoundingBox';
  const gt: Mat2D = def.attrs['gradientTransform'] ? parseTransform(def.attrs['gradientTransform']) : IDENTITY;
  const w = bbox.maxX - bbox.minX;
  const h = bbox.maxY - bbox.minY;

  // Map a gradient-space point to the shape's local space.
  const toLocal = (x: number, y: number): Vec2 => {
    const g = transformPoint(gt, vec2(x, y));
    return objectBox ? vec2(bbox.minX + g.x * w, bbox.minY + g.y * h) : g;
  };
  // Radius scaling: gradientTransform scale, and (objectBoundingBox) box size.
  const gtScale = Math.sqrt(Math.abs(determinant(gt))) || 1;
  const boxScale = objectBox ? (w + h) / 2 : 1;
  const scaleR = (r: number): number => r * gtScale * boxScale;

  const num = (v: string | undefined, fallback: number): number =>
    v === undefined ? fallback : parseNumberOrPercent(v);

  const common = { stops: def.stops, spread: spread(def.attrs['spreadMethod']) };

  if (def.kind === 'linear') {
    const start = toLocal(num(def.attrs['x1'], 0), num(def.attrs['y1'], 0));
    const end = toLocal(num(def.attrs['x2'], 1), num(def.attrs['y2'], 0));
    return { type: 'linear-gradient', start, end, ...common };
  }

  const cx = num(def.attrs['cx'], 0.5);
  const cy = num(def.attrs['cy'], 0.5);
  const r = num(def.attrs['r'], 0.5);
  const fx = num(def.attrs['fx'], cx);
  const fy = num(def.attrs['fy'], cy);
  return {
    type: 'radial-gradient',
    start: { center: toLocal(fx, fy), radius: 0 },
    end: { center: toLocal(cx, cy), radius: scaleR(r) },
    ...common,
  };
}
