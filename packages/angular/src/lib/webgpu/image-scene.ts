import { SceneDocument, vec2, type ImageNode } from '@rendera/core';
import type { SceneSource } from './webgpu-scene';

/**
 * Draw a deliberately high-frequency test image: a radial "siren" of thin
 * wedges, fine concentric rings, a hard-edged checker, and crisp text. These
 * are the patterns that expose resampling quality — aliasing/shimmer when
 * minified without mips, and blocky steps when magnified without a good filter.
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

  ctx.fillStyle = '#f4f4f5';
  ctx.fillRect(0, 0, size, size);

  // Radial wedges (a "siren" — very high angular frequency toward the centre).
  const spokes = 72;
  for (let i = 0; i < spokes; i++) {
    ctx.fillStyle = i % 2 === 0 ? '#111114' : '#f4f4f5';
    ctx.beginPath();
    ctx.moveTo(c, c);
    ctx.arc(c, c, size * 0.46, (i / spokes) * 2 * Math.PI, ((i + 1) / spokes) * 2 * Math.PI);
    ctx.closePath();
    ctx.fill();
  }

  // Fine concentric rings.
  ctx.strokeStyle = '#2563eb';
  for (let r = 6; r < size * 0.46; r += 6) {
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(c, c, r, 0, 2 * Math.PI);
    ctx.stroke();
  }

  // A hard-edged checker in the corner.
  const cell = Math.max(2, Math.round(size / 32));
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      ctx.fillStyle = (x + y) % 2 === 0 ? '#dc2626' : '#fde047';
      ctx.fillRect(x * cell, y * cell, cell, cell);
    }
  }

  // Crisp text to judge magnification sharpness.
  ctx.fillStyle = '#111114';
  ctx.font = `${Math.round(size * 0.09)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('RENDERA', c, c);

  return canvas;
}

/**
 * A `SceneSource` for the WebGPU showcase: a single image layer textured by the
 * high-frequency test pattern, so zooming in shows bicubic-smooth magnification
 * and zooming out shows mip/anisotropic-clean minification.
 */
export function createImageSceneSource(size = 512): SceneSource {
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
