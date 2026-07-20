/**
 * Font resource — a thin wrapper over HarfBuzz (WASM) for shaping and glyph
 * outline extraction.
 *
 * HarfBuzz is the shaper browsers/Android use; we drive it for *both* shaping
 * (ligatures, kerning, GPOS/GSUB, complex scripts) and real glyph **outlines**
 * (via its draw API), so text feeds our own analytic vector fill — resolution
 * independent, and gradient/stroke-capable like any other path.
 *
 * The wasm is lazy-loaded on first `load()` (a dynamic import, so pulling in
 * `@rendera/core` doesn't cost 400 KB of wasm unless text is actually used) and
 * works unchanged in Node (tests) and the browser — HarfBuzz resolves its own
 * `.wasm` per environment. Outlines come back in font design units, Y-up; the
 * caller scales + flips into local space.
 */

import type { Path, PathSegment, SubPath } from '../path';
import { vec2 } from '../vec2';

/** One positioned glyph from shaping, in font design units. */
export interface ShapedGlyph {
  /** Glyph index within the font (not a Unicode codepoint). */
  readonly glyphId: number;
  /** Index of the first input character this glyph derives from. */
  readonly cluster: number;
  readonly xAdvance: number;
  readonly yAdvance: number;
  readonly xOffset: number;
  readonly yOffset: number;
}

/** Per-run shaping controls (a run is uniform direction + script). */
export interface ShapeOptions {
  /** Text direction; omit to let HarfBuzz guess from the run. */
  readonly direction?: 'ltr' | 'rtl' | 'ttb' | 'btt';
  /** BCP-47 language (e.g. `en`, `ar`), affecting language-specific features. */
  readonly language?: string;
  /** OpenType feature toggles, e.g. `['dlig', '-liga', 'ss01']` (a leading
   * `-` disables). */
  readonly features?: readonly string[];
}

/** Vertical metrics in font design units. */
export interface FontMetrics {
  readonly upem: number;
  readonly ascender: number;
  readonly descender: number;
  readonly lineGap: number;
}

type HarfBuzz = typeof import('harfbuzzjs');
type HbFont = InstanceType<HarfBuzz['Font']>;
type HbBuffer = InstanceType<HarfBuzz['Buffer']>;

/** Lazily imported HarfBuzz module (its wasm instantiates on import). */
let hbPromise: Promise<HarfBuzz> | null = null;
function harfbuzz(): Promise<HarfBuzz> {
  return (hbPromise ??= import('harfbuzzjs'));
}

/** Parse a feature string (`ss01`, `-liga`, `dlig`) into (tag, value). */
function parseFeature(spec: string): { tag: string; value: number } {
  return spec.startsWith('-')
    ? { tag: spec.slice(1), value: 0 }
    : { tag: spec, value: 1 };
}

/** A loaded font: shape text and extract glyph outlines. */
export class RenderaFont {
  readonly metrics: FontMetrics;
  /** Glyph outline cache (em space, Y-up), keyed by glyph id. */
  private readonly glyphCache = new Map<number, Path>();
  private readonly buffer: HbBuffer;

  private constructor(
    private readonly hb: HarfBuzz,
    private readonly font: HbFont,
    upem: number
  ) {
    const ext = font.hExtents();
    this.metrics = {
      upem,
      // hExtents ascender is positive-up, descender negative-up; normalize to a
      // positive descent below the baseline.
      ascender: ext?.ascender ?? Math.round(upem * 0.8),
      descender: Math.abs(ext?.descender ?? Math.round(upem * 0.2)),
      lineGap: ext?.lineGap ?? 0,
    };
    this.buffer = new hb.Buffer();
  }

  /** Load a font from raw sfnt bytes (`.ttf`/`.otf`; not WOFF/WOFF2). */
  static async load(data: ArrayBuffer | Uint8Array): Promise<RenderaFont> {
    const hb = await harfbuzz();
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const blob = new hb.Blob(ab as ArrayBuffer);
    const face = new hb.Face(blob, 0);
    const font = new hb.Font(face);
    return new RenderaFont(hb, font, face.upem);
  }

  get upem(): number {
    return this.metrics.upem;
  }

  /** Shape a uniform run of text into positioned glyphs (font design units). */
  shape(text: string, options: ShapeOptions = {}): ShapedGlyph[] {
    const buf = this.buffer;
    buf.reset();
    buf.addText(text);
    buf.guessSegmentProperties();
    if (options.direction) {
      buf.setDirection(this.directionEnum(options.direction));
    }
    if (options.language) {
      buf.setLanguage(options.language);
    }
    const features = (options.features ?? []).map((spec) => {
      const { tag, value } = parseFeature(spec);
      return new this.hb.Feature(tag, value);
    });
    this.hb.shape(this.font, buf, features);
    return buf.getGlyphInfosAndPositions().map((g) => ({
      glyphId: g.codepoint,
      cluster: g.cluster,
      xAdvance: g.xAdvance ?? 0,
      yAdvance: g.yAdvance ?? 0,
      xOffset: g.xOffset ?? 0,
      yOffset: g.yOffset ?? 0,
    }));
  }

  /**
   * The outline of glyph `glyphId` as a `Path` in font design units (Y-up),
   * cached. Empty subpaths for a blank glyph (e.g. space).
   */
  glyphPath(glyphId: number): Path {
    const cached = this.glyphCache.get(glyphId);
    if (cached) {
      return cached;
    }
    const path = commandsToPath(this.font.glyphToJson(glyphId));
    this.glyphCache.set(glyphId, path);
    return path;
  }

  private directionEnum(dir: NonNullable<ShapeOptions['direction']>) {
    const D = this.hb.Direction;
    return dir === 'rtl' ? D.RTL : dir === 'ttb' ? D.TTB : dir === 'btt' ? D.BTT : D.LTR;
  }
}

/** Convert HarfBuzz draw commands (M/L/Q/C/Z, Y-up font units) to a `Path`. */
function commandsToPath(commands: readonly { type: string; values: number[] }[]): Path {
  const subpaths: SubPath[] = [];
  let segments: PathSegment[] = [];
  let start = vec2(0, 0);
  let open = false;
  const flush = (closed: boolean): void => {
    if (open) {
      subpaths.push({ start, closed, segments });
      segments = [];
      open = false;
    }
  };
  for (const cmd of commands) {
    const v = cmd.values;
    switch (cmd.type) {
      case 'M':
        flush(false);
        start = vec2(v[0], v[1]);
        open = true;
        break;
      case 'L':
        segments.push({ type: 'line', to: vec2(v[0], v[1]) });
        break;
      case 'Q':
        segments.push({ type: 'quad', control: vec2(v[0], v[1]), to: vec2(v[2], v[3]) });
        break;
      case 'C':
        segments.push({
          type: 'cubic',
          c1: vec2(v[0], v[1]),
          c2: vec2(v[2], v[3]),
          to: vec2(v[4], v[5]),
        });
        break;
      case 'Z':
        flush(true);
        break;
    }
  }
  flush(false);
  return { subpaths };
}
