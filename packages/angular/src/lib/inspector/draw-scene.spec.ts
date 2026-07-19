import {
  createCamera,
  createSequentialIdFactory,
  createTransform,
  SceneDocument,
  vec2,
  type LayerNode,
} from '@rendera/core';
import { drawScene, INSPECTOR_COLORS } from './draw-scene';

interface FillOp {
  op: 'fill';
  fillStyle: string;
}

function mockContext() {
  const ops: Array<FillOp | { op: string }> = [];
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    setTransform: () => undefined,
    clearRect: () => undefined,
    fillRect: () => ops.push({ op: 'fillRect' }),
    beginPath: () => undefined,
    moveTo: () => undefined,
    lineTo: () => undefined,
    closePath: () => undefined,
    fill(this: { fillStyle: string }) {
      ops.push({ op: 'fill', fillStyle: this.fillStyle });
    },
    stroke: () => ops.push({ op: 'stroke' }),
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, ops };
}

function docWithTwoLayers() {
  const doc = SceneDocument.create({ idFactory: createSequentialIdFactory('n') });
  const back = doc.insert<LayerNode>({
    type: 'layer',
    name: 'back',
    size: vec2(50, 50),
    transform: createTransform({ translation: vec2(0, 0) }),
  });
  const front = doc.insert<LayerNode>({
    type: 'layer',
    name: 'front',
    size: vec2(50, 50),
    transform: createTransform({ translation: vec2(60, 0) }),
  });
  return { doc, back, front };
}

describe('drawScene', () => {
  it('fills one polygon per layer, back-to-front', () => {
    const { ctx, ops } = mockContext();
    const { doc, front } = docWithTwoLayers();

    drawScene(ctx, doc, createCamera(), {
      width: 400,
      height: 300,
      dpr: 1,
      selectedId: front.id,
    });

    const fills = ops.filter((o): o is FillOp => o.op === 'fill');
    expect(fills).toHaveLength(2);
    // The selected (front) layer is drawn last with the highlight fill.
    expect(fills[0].fillStyle).toBe(INSPECTOR_COLORS.fill);
    expect(fills[1].fillStyle).toBe(INSPECTOR_COLORS.selectedFill);
  });

  it('does not highlight when nothing is selected', () => {
    const { ctx, ops } = mockContext();
    const { doc } = docWithTwoLayers();

    drawScene(ctx, doc, createCamera(), { width: 400, height: 300, dpr: 1 });

    const fills = ops.filter((o): o is FillOp => o.op === 'fill');
    expect(fills.every((f) => f.fillStyle === INSPECTOR_COLORS.fill)).toBe(true);
  });
});
