import { TestBed } from '@angular/core/testing';
import { WebGpuScene } from './webgpu-scene';

describe('WebGpuScene', () => {
  it('renders a canvas and settles device init gracefully', async () => {
    const fixture = TestBed.createComponent(WebGpuScene);
    fixture.detectChanges();
    await fixture.whenStable();

    const component = fixture.componentInstance;
    await component.settled; // wait for async WebGPU init to resolve
    fixture.detectChanges();

    const host: HTMLElement = fixture.nativeElement;
    expect(host.querySelector('canvas')).toBeTruthy();

    // The Angular test browser has no WebGPU adapter (no SwiftShader flags),
    // so this exercises the graceful-fallback path; a machine with WebGPU
    // would report 'ready'. Either way it must settle, never hang.
    expect(['ready', 'unsupported']).toContain(component.renderState());
    if (component.renderState() === 'unsupported') {
      expect(host.textContent).toContain('WebGPU is not available');
    }
  });
});
