// In-page tooltips for the webviews, in the IntelliJ style. The browser's own
// title tooltips are unreliable inside VS Code webviews (they never show in a
// floating window), so anything that needs one carries `data-tip` instead and
// gets a styled tooltip near the cursor after a short rest.

/** How long the pointer rests on an element before its tooltip shows. */
const DELAY_MS = 600;
/** Where the tooltip sits relative to the pointer. */
const OFFSET = { x: 12, y: 18 };
/** Breathing room kept from the viewport edges. */
const MARGIN = 8;

interface Point {
  x: number;
  y: number;
}

interface Size {
  width: number;
  height: number;
}

/**
 * Where to put a tooltip of `size` for a pointer at `pointer`: below and to the
 * right of it, pulled back inside the viewport, and above the pointer when
 * there is no room below.
 */
export function placeTip(pointer: Point, size: Size, viewport: Size): { left: number; top: number } {
  let left = pointer.x + OFFSET.x;
  let top = pointer.y + OFFSET.y;
  if (left + size.width + MARGIN > viewport.width) left = Math.max(MARGIN, viewport.width - size.width - MARGIN);
  if (top + size.height + MARGIN > viewport.height) top = Math.max(MARGIN, pointer.y - size.height - 10);
  return { left, top };
}

/** Attributes for an icon-only control: the tooltip text doubles as its accessible name. */
export function labelledTip(text: string): { 'data-tip': string; 'aria-label': string } {
  return { 'data-tip': text, 'aria-label': text };
}

/** The nearest element carrying a non-empty `data-tip`, starting at `from`. */
export function tooltipTarget(from: EventTarget | null): HTMLElement | undefined {
  if (!(from instanceof Element)) return undefined;
  const target = from.closest<HTMLElement>('[data-tip]');
  return target && target.dataset.tip ? target : undefined;
}

let tip: HTMLElement | undefined;
let current: HTMLElement | undefined;
let timer: number | undefined;
let pointer: Point = { x: 0, y: 0 };

function hide(): void {
  if (timer !== undefined) window.clearTimeout(timer);
  timer = undefined;
  current = undefined;
  if (tip) tip.hidden = true;
}

function show(target: HTMLElement): void {
  timer = undefined;
  const text = target.dataset.tip;
  if (!tip || current !== target || !target.isConnected || !text) return;
  tip.textContent = text;
  tip.hidden = false;
  // measure at the origin, then move into place
  tip.style.left = '0px';
  tip.style.top = '0px';
  const rect = tip.getBoundingClientRect();
  const at = placeTip(pointer, rect, { width: window.innerWidth, height: window.innerHeight });
  tip.style.left = `${at.left}px`;
  tip.style.top = `${at.top}px`;
}

/** Wire the document once; elements opt in with `data-tip="text"` (newlines make lines). */
export function installTooltips(): void {
  if (tip) return;
  tip = document.createElement('div');
  tip.className = 'tc-tip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  document.body.appendChild(tip);

  document.addEventListener('mousemove', (e) => (pointer = { x: e.clientX, y: e.clientY }), { passive: true });
  document.addEventListener('mouseover', (e) => {
    const target = tooltipTarget(e.target);
    if (target === current) return;
    hide();
    if (!target) return;
    current = target;
    timer = window.setTimeout(() => show(target), DELAY_MS);
  });
  document.addEventListener('mouseout', (e) => {
    const to = e.relatedTarget;
    if (current && !(to instanceof Node && current.contains(to))) hide();
  });
  // anything the user does next makes the tooltip stale
  for (const type of ['mousedown', 'keydown', 'wheel', 'scroll'] as const) {
    document.addEventListener(type, hide, { capture: true, passive: true });
  }
  window.addEventListener('blur', hide);
}
