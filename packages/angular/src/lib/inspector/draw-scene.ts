/**
 * Debug visualization of a `SceneDocument` on a Canvas2D context.
 *
 * This is an inspector/showcase renderer, NOT the product renderer (that is the
 * WebGPU backend, Phase 2). It is a small pure function so it can be unit-tested
 * with a mock context and later informs — but does not prematurely define — the
 * formal renderer seam.
 */

import {
  fromScaling,
  multiply,
  transformPoint,
  vec2,
  worldToScreenMatrix,
  type Camera,
  type LayerNode,
  type NodeId,
  type SceneDocument,
} from '@rendera/core';

export const INSPECTOR_COLORS = {
  background: '#1e1e1e',
  fill: 'rgba(200, 200, 200, 0.18)',
  stroke: '#888888',
  selectedFill: 'rgba(78, 161, 255, 0.35)',
  selectedStroke: '#4ea1ff',
} as const;

export interface DrawSceneOptions {
  /** Backing-store width in device pixels. */
  width: number;
  /** Backing-store height in device pixels. */
  height: number;
  /** Device pixel ratio (backing store is width x height device px). */
  dpr: number;
  /** Currently selected nodes, highlighted if they are drawable layers. */
  selectedIds?: ReadonlySet<NodeId>;
  background?: string;
}

/** Draw the document's layers onto `ctx`, back-to-front, through the camera. */
export function drawScene(
  ctx: CanvasRenderingContext2D,
  doc: SceneDocument,
  camera: Camera,
  options: DrawSceneOptions
): void {
  const { width, height, dpr, selectedIds } = options;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = options.background ?? INSPECTOR_COLORS.background;
  ctx.fillRect(0, 0, width, height);

  // world -> device pixels = dpr scale * (world -> screen).
  const device = multiply(fromScaling(vec2(dpr, dpr)), worldToScreenMatrix(camera));

  const drawNode = (nodeId: NodeId): void => {
    const node = doc.get(nodeId);
    if (!node) {
      return;
    }
    if (node.type === 'layer') {
      const { size } = node as LayerNode;
      const m = multiply(device, doc.getWorldMatrix(nodeId));
      const corners = [
        transformPoint(m, vec2(0, 0)),
        transformPoint(m, vec2(size.x, 0)),
        transformPoint(m, vec2(size.x, size.y)),
        transformPoint(m, vec2(0, size.y)),
      ];
      const selected = selectedIds?.has(nodeId) ?? false;
      ctx.beginPath();
      ctx.moveTo(corners[0].x, corners[0].y);
      ctx.lineTo(corners[1].x, corners[1].y);
      ctx.lineTo(corners[2].x, corners[2].y);
      ctx.lineTo(corners[3].x, corners[3].y);
      ctx.closePath();
      ctx.fillStyle = selected
        ? INSPECTOR_COLORS.selectedFill
        : INSPECTOR_COLORS.fill;
      ctx.fill();
      ctx.lineWidth = (selected ? 2 : 1) * dpr;
      ctx.strokeStyle = selected
        ? INSPECTOR_COLORS.selectedStroke
        : INSPECTOR_COLORS.stroke;
      ctx.stroke();
    }
    for (const child of doc.getChildren(nodeId)) {
      drawNode(child.id);
    }
  };

  for (const child of doc.getChildren(doc.root.id)) {
    drawNode(child.id);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}
