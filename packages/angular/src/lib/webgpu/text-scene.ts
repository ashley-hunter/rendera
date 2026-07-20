import { createTransform, SceneDocument, vec2, type LinearRgba, type TextNode } from '@rendera/core';
import { crimsonProFont } from './fonts/crimson-pro';
import type { SceneSource } from './webgpu-scene';

/** sRGB 0–255 (+ optional alpha) to a linear-light colour. */
function rgb(r: number, g: number, b: number, a = 1): LinearRgba {
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return { r: lin(r), g: lin(g), b: lin(b), a };
}

const FONT_ID = 'crimson';

/**
 * A `SceneSource` showcasing high-fidelity text: real HarfBuzz shaping
 * (ligatures, kerning) with glyph *outlines* fed through the analytic vector
 * fill — so type is resolution-independent (zoom in, it re-rasterizes razor
 * sharp) and paints with solid colour, gradients, and strokes like any other
 * vector. Crimson Pro (OFL) is embedded so it loads under any bundler / base
 * path.
 */
export function createTextScene(): SceneSource {
  const doc = SceneDocument.create({ name: 'Text' });

  // Display headline with a warm linear-gradient fill.
  doc.insert<TextNode>({
    type: 'text',
    name: 'title',
    text: 'Rendera',
    fontId: FONT_ID,
    fontSize: 132,
    transform: createTransform({ translation: vec2(40, 24) }),
    fill: {
      type: 'linear-gradient',
      start: vec2(0, 0),
      end: vec2(560, 0),
      interpolation: 'oklab',
      stops: [
        { offset: 0, color: rgb(255, 214, 120) },
        { offset: 1, color: rgb(240, 96, 140) },
      ],
    },
  });

  doc.insert<TextNode>({
    type: 'text',
    name: 'subtitle',
    text: 'High-fidelity text, shaped by HarfBuzz',
    fontId: FONT_ID,
    fontSize: 34,
    transform: createTransform({ translation: vec2(46, 188) }),
    fill: { type: 'solid', color: rgb(150, 158, 178) },
  });

  // Ligatures: Crimson Pro forms fi / fj / ffl / ffi etc.
  doc.insert<TextNode>({
    type: 'text',
    name: 'ligatures',
    text: 'ligatures — office · fjord · waffle · affluent · fifth',
    fontId: FONT_ID,
    fontSize: 40,
    transform: createTransform({ translation: vec2(46, 250) }),
    fill: { type: 'solid', color: rgb(232, 236, 245) },
  });

  // Kerning: AV, To, Wa pairs pull together.
  doc.insert<TextNode>({
    type: 'text',
    name: 'kerning',
    text: 'kerning — AVATAR · Wave · To · Yes',
    fontId: FONT_ID,
    fontSize: 40,
    transform: createTransform({ translation: vec2(46, 312) }),
    fill: { type: 'solid', color: rgb(232, 236, 245) },
  });

  // Gradient fill + solid stroke on a large weight — text is just vector paint.
  doc.insert<TextNode>({
    type: 'text',
    name: 'outlined',
    text: 'Vector Type',
    fontId: FONT_ID,
    fontSize: 96,
    transform: createTransform({ translation: vec2(44, 380) }),
    fill: {
      type: 'linear-gradient',
      start: vec2(0, 0),
      end: vec2(0, 96),
      stops: [
        { offset: 0, color: rgb(120, 214, 255) },
        { offset: 1, color: rgb(60, 110, 230) },
      ],
    },
    // Miter join: serif tips stay sharp. A round join would round every acute
    // serif/terminal into a bead (a round join on a sharp corner is a half-disc).
    stroke: { paint: { type: 'solid', color: rgb(14, 22, 44) }, width: 2.5, join: 'miter' },
  });

  // A paragraph auto-wrapped to a width box (greedy word-wrap), proving layout.
  doc.insert<TextNode>({
    type: 'text',
    name: 'paragraph',
    text:
      'Every glyph is an outline — shaped once by HarfBuzz, filled analytically, ' +
      'and razor sharp at any zoom because it is fully resolution independent.',
    fontId: FONT_ID,
    fontSize: 30,
    align: 'left',
    lineHeight: 40,
    maxWidth: 620,
    transform: createTransform({ translation: vec2(44, 510) }),
    fill: { type: 'solid', color: rgb(176, 184, 202) },
  });

  return {
    document: doc,
    clearColor: rgb(15, 16, 22),
    fonts: [{ id: FONT_ID, src: crimsonProFont() }],
  };
}
