import { vec2, type PointerInput, type PointerPhase, type Vec2 } from '@rendera/core';

function normalizePointerType(type: string): PointerInput['pointerType'] {
  return type === 'pen' || type === 'touch' ? type : 'mouse';
}

/**
 * Translate a browser `PointerEvent` into the framework-agnostic `PointerInput`
 * consumed by the engine. Screen coordinates are made relative to `surface`
 * (logical px). This is the DOM boundary: the engine core never sees a DOM event.
 */
export function toPointerInput(
  event: PointerEvent,
  surface: Element,
  phase: PointerPhase
): PointerInput {
  const rect = surface.getBoundingClientRect();
  const toSurface = (clientX: number, clientY: number): Vec2 =>
    vec2(clientX - rect.left, clientY - rect.top);

  const coalesced =
    typeof event.getCoalescedEvents === 'function'
      ? event.getCoalescedEvents().map((e) => toSurface(e.clientX, e.clientY))
      : [];

  return {
    phase,
    pointerId: event.pointerId,
    pointerType: normalizePointerType(event.pointerType),
    screen: toSurface(event.clientX, event.clientY),
    buttons: event.buttons,
    modifiers: {
      shift: event.shiftKey,
      ctrl: event.ctrlKey,
      alt: event.altKey,
      meta: event.metaKey,
    },
    pressure: event.pressure,
    tiltX: event.tiltX ?? 0,
    tiltY: event.tiltY ?? 0,
    coalesced,
  };
}
