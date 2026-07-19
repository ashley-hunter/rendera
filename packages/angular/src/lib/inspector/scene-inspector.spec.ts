import { TestBed } from '@angular/core/testing';
import { SceneInspector } from './scene-inspector';

function button(host: HTMLElement, label: string): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll('button')).find((b) =>
    b.textContent?.trim().startsWith(label)
  );
  if (!found) {
    throw new Error(`button "${label}" not found`);
  }
  return found;
}

describe('SceneInspector', () => {
  it('renders the canvas and toolbar', async () => {
    const fixture = TestBed.createComponent(SceneInspector);
    fixture.detectChanges();
    await fixture.whenStable();
    const host: HTMLElement = fixture.nativeElement;
    // A real Canvas2D context is available in browser mode (unlike jsdom).
    const canvas = host.querySelector('canvas');
    expect(canvas).toBeTruthy();
    expect(canvas?.getContext('2d')).toBeTruthy();
    expect(host.textContent).toContain('+ Layer');
  });

  it('adds a layer and enables undo', async () => {
    const fixture = TestBed.createComponent(SceneInspector);
    fixture.detectChanges();
    await fixture.whenStable();
    const host: HTMLElement = fixture.nativeElement;

    const before = host.querySelectorAll('.tree li').length;
    button(host, '+ Layer').click();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(host.querySelectorAll('.tree li').length).toBe(before + 1);
    expect(button(host, 'Undo').disabled).toBe(false);
  });
});
