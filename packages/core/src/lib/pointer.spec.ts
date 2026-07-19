import { createCamera } from './camera';
import { pointerToWorld, type PointerInput } from './pointer';
import { screenToWorld } from './camera';
import { approxEquals, vec2 } from './vec2';

function pointer(screen: { x: number; y: number }): PointerInput {
  return {
    phase: 'down',
    pointerId: 1,
    pointerType: 'mouse',
    screen: vec2(screen.x, screen.y),
    buttons: 1,
    modifiers: { shift: false, ctrl: false, alt: false, meta: false },
    pressure: 1,
    tiltX: 0,
    tiltY: 0,
    coalesced: [],
  };
}

describe('pointerToWorld', () => {
  it('maps the pointer screen position through the camera', () => {
    const camera = createCamera({ pan: vec2(20, 10), zoom: 2 });
    const input = pointer({ x: 120, y: 90 });
    expect(
      approxEquals(
        pointerToWorld(input, camera),
        screenToWorld(camera, input.screen)
      )
    ).toBe(true);
  });
});
