/**
 * MSDF glyph atlas — a growing RGBA8 texture packed with per-glyph MSDF cells.
 *
 * Glyphs are baked (see `msdf.ts`) and skyline-packed on first use and cached,
 * so dense/repeated text costs one bake per unique glyph. The atlas holds the
 * CPU-side image and per-glyph placement (UV rect in px + em-space plane
 * bounds); the renderer uploads the image to a GPU texture and re-uploads when
 * `version` changes (after a grow). Pure and DOM-free — unit-tested with no GPU.
 */

import { generateGlyphMsdf } from './msdf';
import type { RenderaFont } from './font';

/** A glyph's placement in the atlas. */
export interface AtlasGlyph {
  readonly glyphId: number;
  /** Cell rectangle in atlas pixels. */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** Quad bounds in em units relative to the glyph origin (Y-up), padded so the
   * cell's AA band is included. */
  readonly plane: { left: number; right: number; top: number; bottom: number };
}

export interface MsdfAtlasOptions {
  /** Em size of glyphs in the atlas, px. Default 40. */
  readonly emPx?: number;
  /** Distance range (spread) in atlas px. Default 4. */
  readonly pxRange?: number;
  /** Initial atlas square size in px (grows as needed). Default 256. */
  readonly initialSize?: number;
}

/** Bottom-left skyline rectangle packer over a fixed width. */
class Skyline {
  private nodes: { x: number; y: number; w: number }[];
  constructor(
    private width: number,
    private height: number
  ) {
    this.nodes = [{ x: 0, y: 0, w: width }];
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.nodes = [{ x: 0, y: 0, w: width }];
  }

  /** Place a `w`×`h` rect, returning its top-left, or null if it doesn't fit. */
  add(w: number, h: number): { x: number; y: number } | null {
    let best: { x: number; y: number; i: number } | null = null;
    let bestY = Infinity;
    let bestX = Infinity;
    for (let i = 0; i < this.nodes.length; i++) {
      const y = this.fit(i, w);
      if (y >= 0 && y + h <= this.height) {
        const top = y + h;
        if (top < bestY || (top === bestY && this.nodes[i].x < bestX)) {
          bestY = top;
          bestX = this.nodes[i].x;
          best = { x: this.nodes[i].x, y, i };
        }
      }
    }
    if (!best) {
      return null;
    }
    this.split(best.i, best.x, best.y + h, w);
    return { x: best.x, y: best.y };
  }

  /** Lowest y at which a width-`w` span starting at node `i` clears the skyline. */
  private fit(i: number, w: number): number {
    const x = this.nodes[i].x;
    if (x + w > this.width) {
      return -1;
    }
    let y = 0;
    let remaining = w;
    let j = i;
    while (remaining > 0) {
      if (j >= this.nodes.length) {
        return -1;
      }
      y = Math.max(y, this.nodes[j].y);
      remaining -= this.nodes[j].w;
      j++;
    }
    return y;
  }

  /** Raise the skyline over the placed rect, then merge same-height nodes. */
  private split(i: number, x: number, top: number, w: number): void {
    const inserted: { x: number; y: number; w: number } = { x, y: top, w };
    this.nodes.splice(i, 0, inserted);
    // Trim/consume the nodes the new rect overlaps.
    for (let j = i + 1; j < this.nodes.length; ) {
      const node = this.nodes[j];
      const prev = this.nodes[j - 1];
      if (node.x < prev.x + prev.w) {
        const shrink = prev.x + prev.w - node.x;
        node.x += shrink;
        node.w -= shrink;
        if (node.w <= 0) {
          this.nodes.splice(j, 1);
          continue;
        }
      }
      break;
    }
    // Merge adjacent nodes at the same height.
    for (let j = 0; j < this.nodes.length - 1; ) {
      if (this.nodes[j].y === this.nodes[j + 1].y) {
        this.nodes[j].w += this.nodes[j + 1].w;
        this.nodes.splice(j + 1, 1);
      } else {
        j++;
      }
    }
  }
}

/** A growing MSDF atlas for one font. */
export class MsdfAtlas {
  readonly emPx: number;
  readonly pxRange: number;
  private size: number;
  private image: Uint8ClampedArray;
  private packer: Skyline;
  private readonly glyphs = new Map<number, AtlasGlyph | null>();
  private readonly fields = new Map<number, { data: Uint8ClampedArray; w: number; h: number }>();
  private _version = 0;
  private readonly pad = 1;

  constructor(
    private readonly font: RenderaFont,
    options: MsdfAtlasOptions = {}
  ) {
    this.emPx = options.emPx ?? 40;
    this.pxRange = options.pxRange ?? 4;
    this.size = options.initialSize ?? 256;
    this.image = new Uint8ClampedArray(this.size * this.size * 4);
    this.packer = new Skyline(this.size, this.size);
  }

  /** The atlas image and its dimensions for GPU upload. */
  get texture(): { data: Uint8ClampedArray; width: number; height: number } {
    return { data: this.image, width: this.size, height: this.size };
  }

  /** Bumped whenever the image is reallocated/repacked (re-upload needed). */
  get version(): number {
    return this._version;
  }

  /**
   * The atlas placement for `glyphId`, baking + packing it on first use. Returns
   * null for a blank glyph (e.g. space) that has no field.
   */
  glyph(glyphId: number): AtlasGlyph | null {
    const cached = this.glyphs.get(glyphId);
    if (cached !== undefined) {
      return cached;
    }
    const msdf = generateGlyphMsdf(this.font.glyphPath(glyphId), {
      upem: this.font.upem,
      emPx: this.emPx,
      pxRange: this.pxRange,
    });
    if (msdf.empty) {
      this.glyphs.set(glyphId, null);
      return null;
    }
    this.fields.set(glyphId, { data: msdf.data, w: msdf.width, h: msdf.height });
    const placed = this.place(glyphId, msdf.width, msdf.height, msdf.plane);
    this.glyphs.set(glyphId, placed);
    return placed;
  }

  /** Pack a baked field into the atlas, growing (and repacking) if needed. */
  private place(
    glyphId: number,
    w: number,
    h: number,
    plane: AtlasGlyph['plane']
  ): AtlasGlyph {
    let spot = this.packer.add(w + this.pad, h + this.pad);
    while (!spot) {
      this.grow();
      spot = this.packer.add(w + this.pad, h + this.pad);
    }
    this.blit(this.fields.get(glyphId)!, spot.x, spot.y);
    return { glyphId, x: spot.x, y: spot.y, w, h, plane };
  }

  /** Double the atlas and re-pack every already-placed glyph. */
  private grow(): void {
    this.size *= 2;
    this.image = new Uint8ClampedArray(this.size * this.size * 4);
    this.packer.resize(this.size, this.size);
    this._version++;
    for (const [glyphId, g] of this.glyphs) {
      if (!g) {
        continue;
      }
      const field = this.fields.get(glyphId)!;
      const spot = this.packer.add(field.w + this.pad, field.h + this.pad);
      if (!spot) {
        // Extremely unlikely after doubling; grow again.
        this.grow();
        return;
      }
      this.blit(field, spot.x, spot.y);
      this.glyphs.set(glyphId, { ...g, x: spot.x, y: spot.y });
    }
  }

  /** Copy a field's rows into the atlas image at (dx, dy). */
  private blit(field: { data: Uint8ClampedArray; w: number; h: number }, dx: number, dy: number): void {
    for (let row = 0; row < field.h; row++) {
      const src = row * field.w * 4;
      const dst = ((dy + row) * this.size + dx) * 4;
      this.image.set(field.data.subarray(src, src + field.w * 4), dst);
    }
  }
}
