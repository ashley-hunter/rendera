import { toPointerInput } from './pointer-input';

describe('toPointerInput', () => {
  it('maps a DOM PointerEvent to a surface-relative PointerInput', () => {
    const surface = document.createElement('div');
    Object.assign(surface.style, {
      position: 'fixed',
      left: '10px',
      top: '20px',
      width: '100px',
      height: '100px',
    });
    document.body.appendChild(surface);
    try {
      const event = new PointerEvent('pointerdown', {
        clientX: 60,
        clientY: 70,
        shiftKey: true,
        buttons: 1,
        pointerId: 3,
        pressure: 0.5,
        pointerType: 'pen',
      });

      const input = toPointerInput(event, surface, 'down');

      expect(input.phase).toBe('down');
      expect(input.pointerId).toBe(3);
      expect(input.pointerType).toBe('pen');
      expect(input.modifiers.shift).toBe(true);
      expect(input.modifiers.alt).toBe(false);
      expect(input.pressure).toBeCloseTo(0.5, 5);
      expect(input.screen.x).toBeCloseTo(50, 1);
      expect(input.screen.y).toBeCloseTo(50, 1);
    } finally {
      surface.remove();
    }
  });
});
