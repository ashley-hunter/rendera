import { SceneDocument, vec2, type ImageNode } from '@rendera/core';
import type { SceneSource } from './webgpu-scene';

/**
 * Draw a high-resolution showcase image with crisp edges, bounded-frequency
 * detail, a smooth gradient, saturated swatches, and multi-size text — the
 * content that reads as *crisp*: sharp when magnified (bicubic), clean when
 * minified (mips), banding-free in the gradient (dither). Deliberately avoids
 * infinite-frequency detail (e.g. a radial siren) that can only ever moiré.
 */
function drawTestPattern(size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return canvas;
  }
  const c = size / 2;

  const grad = ctx.createLinearGradient(0, 0, 0, size);
  grad.addColorStop(0, '#fbfbfd');
  grad.addColorStop(1, '#e7e7ee');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  // Thin crisp grid.
  ctx.strokeStyle = 'rgba(30,41,59,0.18)';
  ctx.lineWidth = Math.max(1, size / 1024);
  for (let x = 0; x <= size; x += size / 16) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, size);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, x);
    ctx.lineTo(size, x);
    ctx.stroke();
  }

  // Bounded-frequency concentric rings (fixed spacing — never converge).
  ctx.strokeStyle = '#1e3a8a';
  ctx.lineWidth = Math.max(2, size / 340);
  for (let r = size * 0.08; r < size * 0.46; r += size * 0.05) {
    ctx.beginPath();
    ctx.arc(c, c, r, 0, 2 * Math.PI);
    ctx.stroke();
  }

  // Saturated colour swatches.
  const cols = ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7', '#ec4899'];
  const sw = size / cols.length;
  cols.forEach((col, i) => {
    ctx.fillStyle = col;
    ctx.fillRect(i * sw, size * 0.8, sw, size * 0.12);
  });

  // Crisp text at two sizes, to judge magnification sharpness.
  ctx.fillStyle = '#0f172a';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `700 ${Math.round(size * 0.11)}px system-ui, sans-serif`;
  ctx.fillText('RENDERA', c, c);
  ctx.font = `500 ${Math.round(size * 0.032)}px system-ui, sans-serif`;
  ctx.fillText('WebGPU · linear-light · bicubic', c, c + size * 0.09);

  return canvas;
}

/**
 * A `SceneSource` for the WebGPU showcase: a single image layer textured by the
 * high-frequency test pattern, so zooming in shows bicubic-smooth magnification
 * and zooming out shows mip/anisotropic-clean minification.
 */
export function createImageSceneSource(size = 1024): SceneSource {
  const assetId = 'test-pattern';
  const doc = SceneDocument.create({ name: 'Image' });
  doc.insert<ImageNode>({
    type: 'image',
    name: 'Test pattern',
    assetId,
    size: vec2(size, size),
  });
  return {
    document: doc,
    clearColor: { r: 0.05, g: 0.05, b: 0.06, a: 1 },
    async setup(renderer) {
      const bitmap = await createImageBitmap(drawTestPattern(size));
      renderer.registerImage(assetId, bitmap);
    },
  };
}
