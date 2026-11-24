export const $ = <T extends Element = HTMLElement>(s: string, root: ParentNode = document) => root.querySelector(s) as T;
export const fmt = (n: number) => n.toLocaleString('en-IN');

export const store = {
  get(k: string) {
    try { return localStorage.getItem(k); } catch { return null; }
  },
  set(k: string, v: string) {
    try { localStorage.setItem(k, v); } catch { /* private mode: preference just isn't kept */ }
  },
  /** Removes every key starting with `prefix`. */
  clear(prefix: string) {
    try { Object.keys(localStorage).filter((k) => k.startsWith(prefix)).forEach((k) => localStorage.removeItem(k)); } catch { /* nothing kept anyway */ }
  },
};

/** Full-screen panels sit on a stack tied to history, so the phone's back button closes them. */
const stack: { el: HTMLElement; onClose?: () => void }[] = [];
export function openPanel(el: HTMLElement, onClose?: () => void) {
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('open'));
  stack.push({ el, onClose });
  history.pushState({ panel: stack.length }, '');
  (el.querySelector('[data-close]') as HTMLElement | null)?.focus({ preventScroll: true, focusVisible: false } as FocusOptions);
}
function pop() {
  const top = stack.pop();
  if (!top) return;
  top.el.classList.remove('open');
  setTimeout(() => !top.el.classList.contains('open') && (top.el.hidden = true), 280);
  top.onClose?.();
}
export function closeTop() {
  if (stack.length) history.back();
}
addEventListener('popstate', pop);
addEventListener('keydown', (e) => e.key === 'Escape' && closeTop());

