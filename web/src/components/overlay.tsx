// Overlay infrastructure: escape-key layer stack, focus trap, toasts, confirm dialogs, tooltips.
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { CircleCheck, CircleExclamationPoint, Info, X } from './icons';

// ------------------------------------------------------------------------------------- layers
interface Layer {
  id: number;
  modal: boolean;
  onEscape: () => void;
}
const stack: Layer[] = [];
let layerId = 0;

/** Register an overlay; Escape closes only the top-most one. */
export function pushLayer(onEscape: () => void, modal = false): () => void {
  const l = { id: ++layerId, modal, onEscape };
  stack.push(l);
  return () => {
    const i = stack.indexOf(l);
    if (i >= 0) stack.splice(i, 1);
  };
}
export const modalOpen = () => stack.some((l) => l.modal);
export const anyLayerOpen = () => stack.length > 0;

if (typeof window !== 'undefined') {
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape' || !stack.length) return;
      e.preventDefault();
      e.stopPropagation();
      stack[stack.length - 1].onEscape();
    },
    true,
  );
}

/** Stable-callback layer registration while `active`. */
export function useLayer(active: boolean, onEscape: () => void, modal = false) {
  const cb = useRef(onEscape);
  cb.current = onEscape;
  useEffect(() => {
    if (!active) return;
    return pushLayer(() => cb.current(), modal);
  }, [active, modal]);
}

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** Keep Tab focus inside `ref` while mounted; restore focus to the previous element on unmount. */
export function useFocusTrap(ref: { current: HTMLElement | null }, active = true) {
  useEffect(() => {
    if (!active) return;
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    if (!el) return;
    // explicit autofocus first, then the first field in the body; otherwise the dialog itself
    // (focusing the close button would pop its tooltip and invite accidental dismissal)
    const first =
      (el.querySelector('[autofocus],[data-autofocus]') as HTMLElement | null) ||
      (el.querySelector('.dialog-body input:not([type=checkbox]),.dialog-body textarea,.dialog-body select') as HTMLElement | null);
    // after paint so transitions/portals are attached
    requestAnimationFrame(() => (first || el).focus({ preventScroll: true }));
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null || x === document.activeElement);
      if (!items.length) {
        e.preventDefault();
        return;
      }
      const a = items[0];
      const b = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === a || !el.contains(document.activeElement))) {
        e.preventDefault();
        b.focus();
      } else if (!e.shiftKey && (document.activeElement === b || !el.contains(document.activeElement))) {
        e.preventDefault();
        a.focus();
      }
    };
    el.addEventListener('keydown', onKey);
    return () => {
      el.removeEventListener('keydown', onKey);
      if (prev && document.contains(prev)) prev.focus({ preventScroll: true });
    };
  }, [active]);
}

// ------------------------------------------------------------------------------------- toasts
export type ToastKind = 'success' | 'error' | 'info';
interface ToastItem {
  id: number;
  kind: ToastKind;
  title: string;
  description?: string;
  leaving?: boolean;
}
let toasts: ToastItem[] = [];
let toastId = 0;
const toastSubs = new Set<() => void>();
const emitToasts = () => toastSubs.forEach((f) => f());

function dismissToast(id: number) {
  toasts = toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t));
  emitToasts();
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    emitToasts();
  }, 160);
}

export function toast(title: string, opts: { kind?: ToastKind; description?: string; duration?: number } = {}) {
  const id = ++toastId;
  const kind = opts.kind || 'success';
  toasts = [...toasts.slice(-4), { id, kind, title, description: opts.description }];
  emitToasts();
  setTimeout(() => dismissToast(id), opts.duration ?? (kind === 'error' ? 7000 : 3800));
}
toast.error = (e: unknown, title = 'Something went wrong') => toast(title, { kind: 'error', description: (e as Error)?.message || String(e) });

function Toasts() {
  const [, set] = useState(0);
  useEffect(() => {
    const f = () => set((n) => n + 1);
    toastSubs.add(f);
    return () => toastSubs.delete(f);
  }, []);
  return (
    <div class="toasts" role="region" aria-label="Notifications">
      {toasts.map((t) => {
        const Icon = t.kind === 'success' ? CircleCheck : t.kind === 'error' ? CircleExclamationPoint : Info;
        return (
          <div key={t.id} class={'toast toast-' + t.kind + (t.leaving ? ' leaving' : '')} role={t.kind === 'error' ? 'alert' : 'status'}>
            <Icon size={18} class="toast-icon" aria-hidden="true" />
            <div class="toast-text">
              <div class="toast-title">{t.title}</div>
              {t.description && <div class="toast-desc">{t.description}</div>}
            </div>
            <button class="toast-x" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------------------------- confirm
export interface ConfirmOpts {
  title: string;
  message?: ComponentChildren;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}
type ConfirmReq = ConfirmOpts & { resolve: (b: boolean) => void };
let confirmReq: ConfirmReq | null = null;
const confirmSubs = new Set<() => void>();

export function confirmDialog(o: ConfirmOpts): Promise<boolean> {
  return new Promise((resolve) => {
    confirmReq?.resolve(false);
    confirmReq = { ...o, resolve };
    confirmSubs.forEach((f) => f());
  });
}

// lazily imported to avoid a cycle (ui.tsx imports this module)
let DialogImpl: ((p: any) => any) | null = null;
export function registerDialog(d: (p: any) => any) {
  DialogImpl = d;
}

function ConfirmHost() {
  const [, set] = useState(0);
  useEffect(() => {
    const f = () => set((n) => n + 1);
    confirmSubs.add(f);
    return () => confirmSubs.delete(f);
  }, []);
  const r = confirmReq;
  if (!r || !DialogImpl) return null;
  const done = (b: boolean) => {
    confirmReq = null;
    r.resolve(b);
    set((n) => n + 1);
  };
  const D = DialogImpl;
  return (
    <D
      title={r.title}
      size="sm"
      role="alertdialog"
      onClose={() => done(false)}
      footer={
        <>
          <button class="btn btn-secondary btn-md" onClick={() => done(false)}>
            {r.cancelLabel || 'Cancel'}
          </button>
          <button class={'btn btn-md ' + (r.danger ? 'btn-danger' : 'btn-primary')} data-autofocus onClick={() => done(true)}>
            {r.confirmLabel || 'Confirm'}
          </button>
        </>
      }
    >
      {r.message && <div class="confirm-msg">{r.message}</div>}
    </D>
  );
}

// ------------------------------------------------------------------------------------- tooltips
// One floating element for every [data-tip] in the document (icon buttons etc).
function initTooltips() {
  const tip = document.createElement('div');
  tip.className = 'tooltip';
  tip.setAttribute('role', 'tooltip');
  document.body.appendChild(tip);
  let target: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastHide = 0;
  const hide = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (target) lastHide = performance.now();
    target = null;
    tip.classList.remove('show');
  };
  const show = (el: HTMLElement) => {
    const text = el.dataset.tip;
    if (!text) return;
    const kbd = el.dataset.kbd;
    tip.textContent = text;
    if (kbd) {
      const k = document.createElement('span');
      k.className = 'tooltip-kbd';
      k.textContent = kbd;
      tip.appendChild(k);
    }
    tip.style.left = '0px';
    tip.style.top = '0px';
    tip.classList.add('show');
    const r = el.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let x = r.left + r.width / 2 - tw / 2;
    x = Math.max(6, Math.min(window.innerWidth - tw - 6, x));
    const placeBelow = el.dataset.tipPos === 'bottom' || r.top - th - 8 < 4;
    const y = placeBelow ? r.bottom + 6 : r.top - th - 6;
    const side = el.dataset.tipPos === 'right';
    if (side) {
      tip.style.left = Math.round(r.right + 8) + 'px';
      tip.style.top = Math.round(r.top + r.height / 2 - th / 2) + 'px';
    } else {
      tip.style.left = Math.round(x) + 'px';
      tip.style.top = Math.round(y) + 'px';
    }
  };
  const schedule = (el: HTMLElement, immediate = false) => {
    if (el === target) return;
    hide();
    target = el;
    const warm = performance.now() - lastHide < 400;
    timer = setTimeout(() => target === el && document.contains(el) && show(el), immediate || warm ? 0 : 450);
  };
  document.addEventListener('pointerover', (e) => {
    if ((e as PointerEvent).pointerType === 'touch') return;
    const el = (e.target as Element)?.closest?.('[data-tip]') as HTMLElement | null;
    if (el) schedule(el);
    else if (target) hide();
  });
  document.addEventListener('pointerdown', hide, true);
  document.addEventListener('scroll', hide, true);
  document.addEventListener('keydown', (e) => e.key !== 'Tab' && hide(), true);
  document.addEventListener('focusin', (e) => {
    const el = (e.target as Element)?.closest?.('[data-tip]') as HTMLElement | null;
    if (el && el.matches(':focus-visible')) schedule(el, true);
  });
  document.addEventListener('focusout', () => target && hide());
}

/** Global hosts; mount once. */
export function OverlayHost() {
  useEffect(() => initTooltips(), []);
  return (
    <>
      <Toasts />
      <ConfirmHost />
    </>
  );
}
