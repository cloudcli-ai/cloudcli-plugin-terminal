/**
 * Finger scrolling for full-screen terminal apps.
 *
 * Claude Code, vim, less and htop run on the alternate screen, and most of
 * them also turn on mouse reporting. xterm.js skips its own touch handling
 * entirely while mouse events are active (`if (areMouseEventsActive) return`
 * in its touchstart/touchmove listeners), and the alternate screen has no
 * scrollback for a viewport scroll to move anyway. Those apps scroll
 * themselves when the terminal forwards the mouse wheel — as SGR 64/65 with
 * mouse reporting, or as arrow keys without it — which is why a wheel scrolls
 * them and a finger does nothing.
 *
 * So while the app owns scrolling, a vertical drag is turned into wheel events
 * on the terminal, which xterm then forwards exactly like a real wheel, and a
 * flick keeps gliding after the finger lifts. A plain shell on the normal
 * buffer is left to xterm's own touch path.
 */

import type { Terminal } from '@xterm/xterm';

const MIN_VELOCITY = 0.15;  // px/ms below which a lift is a stop, not a flick
const MAX_VELOCITY = 4;     // px/ms cap, so a hard flick stays controllable
const DECAY = 0.96;         // per 16 ms frame — roughly a second of glide
const STOP_VELOCITY = 0.03; // px/ms at which the glide ends
const MAX_IDLE_MS = 120;    // a finger parked before lifting has no flick

export function attachTouchScroll(terminal: Terminal, host: HTMLElement): { dispose(): void } {
  let tracking = false;
  let lastX = 0;
  let lastY = 0;
  let lastT = 0;
  let velocity = 0; // px/ms, smoothed
  let frame: number | null = null;

  const appScrolls = (): boolean =>
    terminal.modes.mouseTrackingMode !== 'none' || terminal.buffer.active.type === 'alternate';

  function sendWheel(deltaY: number): void {
    // xterm listens for the wheel on its root element; dispatching on the
    // screen lets it bubble there with coordinates inside the grid, which
    // mouse reporting needs.
    const target = terminal.element?.querySelector('.xterm-screen') ?? terminal.element;
    if (!target || !deltaY) return;
    target.dispatchEvent(new WheelEvent('wheel', {
      deltaY, deltaMode: WheelEvent.DOM_DELTA_PIXEL, bubbles: true, cancelable: true,
      clientX: lastX, clientY: lastY,
    }));
  }

  function cancelGlide(): void {
    if (frame !== null) { cancelAnimationFrame(frame); frame = null; }
  }

  function startGlide(): void {
    if (Math.abs(velocity) < MIN_VELOCITY) return;
    if (performance.now() - lastT > MAX_IDLE_MS) return;
    let v = Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, velocity));
    let prev = performance.now();
    const step = (now: number): void => {
      // The tab may have been closed or hidden mid-flick.
      if (!host.isConnected || host.hidden) { frame = null; return; }
      const dt = Math.max(1, now - prev);
      prev = now;
      v *= DECAY ** (dt / 16);
      if (Math.abs(v) < STOP_VELOCITY) { frame = null; return; }
      sendWheel(v * dt);
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
  }

  const onTouchStart = (event: TouchEvent): void => {
    cancelGlide();
    velocity = 0;
    tracking = event.touches.length === 1 && appScrolls();
    if (!tracking) return;
    lastX = event.touches[0].clientX;
    lastY = event.touches[0].clientY;
    lastT = performance.now();
  };

  const onTouchMove = (event: TouchEvent): void => {
    if (!tracking) return;
    if (event.touches.length !== 1) { tracking = false; return; }
    const { clientX, clientY } = event.touches[0];
    const now = performance.now();
    const dy = lastY - clientY;
    const dt = now - lastT;
    lastX = clientX;
    lastY = clientY;
    lastT = now;
    if (dt > 0) velocity = velocity * 0.4 + (dy / dt) * 0.6;
    if (dy === 0) return;
    sendWheel(dy);
    // Keep the page itself from scrolling or rubber-banding under the drag.
    if (event.cancelable) event.preventDefault();
  };

  const onTouchEnd = (): void => {
    if (tracking) startGlide();
    tracking = false;
  };

  const onTouchCancel = (): void => {
    cancelGlide();
    tracking = false;
  };

  host.addEventListener('touchstart', onTouchStart, { passive: true });
  host.addEventListener('touchmove', onTouchMove, { passive: false });
  host.addEventListener('touchend', onTouchEnd, { passive: true });
  host.addEventListener('touchcancel', onTouchCancel, { passive: true });

  return {
    dispose(): void {
      cancelGlide();
      host.removeEventListener('touchstart', onTouchStart);
      host.removeEventListener('touchmove', onTouchMove);
      host.removeEventListener('touchend', onTouchEnd);
      host.removeEventListener('touchcancel', onTouchCancel);
    },
  };
}
