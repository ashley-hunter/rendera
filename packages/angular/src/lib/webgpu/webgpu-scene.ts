import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  signal,
  viewChild,
} from '@angular/core';
import {
  buildRenderList,
  createCamera,
  fitBounds,
  panBy,
  subtract,
  vec2,
  zoomAround,
  type Camera,
  type Vec2,
} from '@rendera/core';
import { WebGpuRenderer } from '@rendera/webgpu';
import { createSampleDocument } from '../sample-scene';

type Status = 'pending' | 'ready' | 'unsupported';

/**
 * A GPU-rendered showcase of the shared sample document via `@rendera/webgpu`,
 * with drag-pan and wheel-zoom. Device init is async, and the component
 * degrades gracefully when WebGPU is unavailable (ADR 0002). This is the first
 * on-screen GPU path; the Canvas2D `SceneInspector` remains the always-works
 * debug view.
 */
@Component({
  selector: 'rendera-webgpu-scene',
  imports: [],
  templateUrl: './webgpu-scene.html',
  styleUrl: './webgpu-scene.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WebGpuScene {
  private readonly canvasRef =
    viewChild<ElementRef<HTMLCanvasElement>>('canvas');

  private readonly document = createSampleDocument();
  private readonly camera = signal<Camera>(createCamera({ pan: vec2(20, 20) }));
  private renderer: WebGpuRenderer | null = null;
  private resizeObserver?: ResizeObserver;
  private lastScreen: Vec2 | null = null;
  private dragging = false;
  private frame = 0;

  /** Device-init state: 'pending' -> 'ready' | 'unsupported'. */
  readonly renderState = signal<Status>('pending');
  protected readonly message = signal('');

  /** Resolves once device init has settled (ready or unsupported). */
  readonly settled: Promise<void>;
  private settle!: () => void;

  constructor() {
    this.settled = new Promise<void>((resolve) => (this.settle = resolve));
    afterNextRender(() => {
      void this.init();
    });
  }

  private async init(): Promise<void> {
    const canvas = this.canvasRef()?.nativeElement;
    if (!canvas) {
      this.fail('No canvas element.');
      return;
    }
    this.sizeCanvas(canvas);
    try {
      this.renderer = await WebGpuRenderer.create(canvas, { colorSpace: 'srgb' });
      this.renderer.setClearColor({ r: 0.02, g: 0.02, b: 0.03, a: 1 });
      this.renderState.set('ready');
      if (typeof ResizeObserver !== 'undefined') {
        this.resizeObserver = new ResizeObserver(() => this.onResize());
        this.resizeObserver.observe(canvas);
      }
      this.draw();
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
    }
    this.settle();
  }

  private fail(message: string): void {
    this.renderState.set('unsupported');
    this.message.set(message);
  }

  protected fit(): void {
    const canvas = this.canvasRef()?.nativeElement;
    const bounds = this.document.getWorldBounds(this.document.root.id);
    if (!canvas || !bounds) {
      return;
    }
    this.camera.set(
      fitBounds(bounds, { width: canvas.width, height: canvas.height }, 24)
    );
    this.draw();
  }

  protected onPointerDown(event: PointerEvent): void {
    const canvas = this.canvasRef()?.nativeElement;
    if (!canvas) {
      return;
    }
    try {
      canvas.setPointerCapture?.(event.pointerId);
    } catch {
      // Ignore non-active pointers (e.g. synthetic events).
    }
    this.dragging = true;
    this.lastScreen = this.toCanvas(event, canvas);
  }

  protected onPointerMove(event: PointerEvent): void {
    const canvas = this.canvasRef()?.nativeElement;
    if (!this.dragging || !this.lastScreen || !canvas) {
      return;
    }
    const screen = this.toCanvas(event, canvas);
    this.camera.update((c) => panBy(c, subtract(screen, this.lastScreen as Vec2)));
    this.lastScreen = screen;
    this.draw();
  }

  protected onPointerUp(): void {
    this.dragging = false;
    this.lastScreen = null;
  }

  protected onWheel(event: WheelEvent): void {
    event.preventDefault();
    const canvas = this.canvasRef()?.nativeElement;
    if (!canvas) {
      return;
    }
    const anchor = this.toCanvas(event, canvas);
    this.camera.update((c) => zoomAround(c, anchor, event.deltaY < 0 ? 1.1 : 1 / 1.1));
    this.draw();
  }

  private toCanvas(event: MouseEvent, canvas: HTMLCanvasElement): Vec2 {
    const rect = canvas.getBoundingClientRect();
    return vec2(event.clientX - rect.left, event.clientY - rect.top);
  }

  private onResize(): void {
    const canvas = this.canvasRef()?.nativeElement;
    if (!canvas || !this.renderer) {
      return;
    }
    this.sizeCanvas(canvas);
    this.renderer.resize(canvas.width, canvas.height);
    this.draw();
  }

  private sizeCanvas(canvas: HTMLCanvasElement): void {
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(rect.width));
    canvas.height = Math.max(1, Math.round(rect.height));
  }

  /**
   * Coalesce draw requests into a single render per animation frame. Presenting
   * to a WebGPU canvas must happen inside the frame callback so the swapchain
   * texture is the one the compositor will show (multiple `draw()` calls in one
   * task collapse to one GPU submit).
   */
  private draw(): void {
    if (!this.renderer || this.frame) {
      return;
    }
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.drawNow();
    });
  }

  private drawNow(): void {
    if (!this.renderer) {
      return;
    }
    this.renderer.setRenderList(buildRenderList(this.document, this.camera()));
    this.renderer.render();
  }
}
