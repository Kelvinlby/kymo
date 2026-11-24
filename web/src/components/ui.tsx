// Small component kit: buttons, inputs, switches, segmented controls, popovers/menus, dialogs,
// tabs, badges, skeletons, empty states. Styling lives in styles/components.css.
import type { ButtonHTMLAttributes, ComponentChildren, Ref, VNode } from 'preact';
import { createPortal } from 'preact/compat';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { copyText } from '../lib/format';
import { Check, CircleExclamationPoint, Copy, Info, LoaderCircle, X, type LucideIcon } from './icons';
import { registerDialog, toast, useFocusTrap, useLayer } from './overlay';

export const cx = (...a: (string | false | null | undefined | 0)[]) => a.filter(Boolean).join(' ');

// ------------------------------------------------------------------------------------- buttons
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-ghost';
type Size = 'xs' | 'sm' | 'md' | 'lg';

type BtnProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'icon' | 'size'> & {
  variant?: Variant;
  size?: Size;
  icon?: LucideIcon;
  iconRight?: LucideIcon;
  loading?: boolean;
  disabled?: boolean;
  type?: 'button' | 'submit' | 'reset';
  btnRef?: Ref<HTMLButtonElement>;
};

const ICON_PX: Record<Size, number> = { xs: 13, sm: 14, md: 16, lg: 17 };

export function Button({ variant = 'secondary', size = 'md', icon: Icon, iconRight: IconR, loading, children, class: cls, btnRef, type = 'button', disabled, ...rest }: BtnProps) {
  return (
    <button ref={btnRef} type={type} class={cx('btn', 'btn-' + variant, 'btn-' + size, loading && 'loading', cls as string)} disabled={disabled || loading} {...rest}>
      {loading ? <LoaderCircle size={ICON_PX[size]} class="spin" aria-hidden="true" /> : Icon && <Icon size={ICON_PX[size]} aria-hidden="true" />}
      {children != null && children !== false && <span class="btn-label">{children}</span>}
      {IconR && <IconR size={ICON_PX[size]} aria-hidden="true" class="btn-icon-r" />}
    </button>
  );
}

type IconBtnProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'icon' | 'size' | 'label'> & {
  icon: LucideIcon;
  label: string;
  kbd?: string;
  active?: boolean;
  size?: Size;
  variant?: Variant;
  tipPos?: 'top' | 'bottom' | 'right';
  disabled?: boolean;
  btnRef?: Ref<HTMLButtonElement>;
  iconSize?: number;
};

export function IconButton({ icon: Icon, label, kbd, active, size = 'sm', variant = 'ghost', tipPos, class: cls, btnRef, iconSize, ...rest }: IconBtnProps) {
  return (
    <button
      ref={btnRef}
      type="button"
      class={cx('btn', 'btn-icon', 'btn-' + variant, 'btn-' + size, active && 'active', cls as string)}
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      data-tip={label}
      data-kbd={kbd}
      data-tip-pos={tipPos}
      {...rest}
    >
      <Icon size={iconSize ?? ICON_PX[size]} aria-hidden="true" />
    </button>
  );
}

export function Kbd({ children }: { children: ComponentChildren }) {
  return <kbd class="kbd">{children}</kbd>;
}

export function Spinner({ size = 16 }: { size?: number }) {
  return <LoaderCircle size={size} class="spin" aria-label="Loading" />;
}

// ------------------------------------------------------------------------------------- form fields
export function Field(props: { label: ComponentChildren; hint?: ComponentChildren; error?: string | false | null; children: ComponentChildren; optional?: boolean; class?: string }) {
  return (
    <label class={cx('field', props.error && 'has-error', props.class)}>
      <span class="field-label">
        {props.label}
        {props.optional && <span class="field-opt">optional</span>}
      </span>
      {props.children}
      {props.error ? (
        <span class="field-error" role="alert">
          <CircleExclamationPoint size={13} aria-hidden="true" />
          {props.error}
        </span>
      ) : (
        props.hint && <span class="field-hint">{props.hint}</span>
      )}
    </label>
  );
}

export function SearchInput(props: {
  value: string;
  onInput: (v: string) => void;
  placeholder?: string;
  icon?: LucideIcon;
  kbd?: string;
  invalid?: boolean;
  title?: string;
  class?: string;
  inputRef?: Ref<HTMLInputElement>;
  mono?: boolean;
  ariaLabel?: string;
  onKeyDown?: (e: KeyboardEvent) => void;
}) {
  const Icon = props.icon;
  return (
    <div class={cx('input-wrap', props.invalid && 'invalid', props.class)} title={props.title}>
      {Icon && <Icon size={15} class="input-icon" aria-hidden="true" />}
      <input
        ref={props.inputRef}
        type="search"
        class={cx('input', Icon && 'has-icon', props.mono && 'mono')}
        placeholder={props.placeholder}
        aria-label={props.ariaLabel || props.placeholder}
        aria-invalid={props.invalid || undefined}
        value={props.value}
        onInput={(e) => props.onInput((e.target as HTMLInputElement).value)}
        onKeyDown={props.onKeyDown}
      />
      {props.kbd && !props.value && <kbd class="kbd input-kbd">{props.kbd}</kbd>}
      {props.value && (
        <button type="button" class="input-clear" aria-label="Clear" onClick={() => props.onInput('')}>
          <X size={13} />
        </button>
      )}
    </div>
  );
}

export function Switch(props: { checked: boolean; onChange: (b: boolean) => void; label?: ComponentChildren; description?: ComponentChildren; disabled?: boolean; id?: string; ariaLabel?: string }) {
  const btn = (
    <button
      type="button"
      role="switch"
      id={props.id}
      aria-checked={props.checked}
      aria-label={props.ariaLabel}
      disabled={props.disabled}
      class={cx('switch', props.checked && 'on')}
      onClick={() => props.onChange(!props.checked)}
    >
      <span class="switch-thumb" />
    </button>
  );
  if (!props.label) return btn;
  return (
    <label class={cx('switch-row', props.disabled && 'disabled')}>
      <span class="switch-text">
        <span class="switch-label">{props.label}</span>
        {props.description && <span class="switch-desc">{props.description}</span>}
      </span>
      {btn}
    </label>
  );
}

export interface SegOption<T> {
  value: T;
  label?: ComponentChildren;
  icon?: LucideIcon;
  tip?: string;
}
export function Segmented<T extends string | number>(props: { value: T; options: SegOption<T>[]; onChange: (v: T) => void; size?: 'sm' | 'md'; ariaLabel: string; class?: string }) {
  return (
    <div class={cx('seg', 'seg-' + (props.size || 'sm'), props.class)} role="radiogroup" aria-label={props.ariaLabel}>
      {props.options.map((o) => {
        const on = o.value === props.value;
        const Icon = o.icon;
        return (
          <button
            type="button"
            key={String(o.value)}
            role="radio"
            aria-checked={on}
            aria-label={o.label ? undefined : o.tip}
            class={cx('seg-item', on && 'on')}
            data-tip={o.tip}
            onClick={() => props.onChange(o.value)}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
              e.preventDefault();
              const i = props.options.findIndex((x) => x.value === props.value);
              const n = props.options[(i + (e.key === 'ArrowRight' ? 1 : -1) + props.options.length) % props.options.length];
              props.onChange(n.value);
              const sib = (e.currentTarget as HTMLElement).parentElement?.children[props.options.indexOf(n)] as HTMLElement | undefined;
              sib?.focus();
            }}
          >
            {Icon && <Icon size={14} aria-hidden="true" />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------------------------- popover / menu
type Placement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end' | 'right-start' | 'right-end';

export interface TriggerProps {
  open: boolean;
  toggle: () => void;
  ref: Ref<HTMLElement>;
  'aria-expanded': boolean;
  'aria-haspopup': 'menu' | 'dialog';
}

/** Floating panel portalled to <body>, positioned next to its trigger. */
export function Popover(props: {
  trigger: (p: TriggerProps) => VNode;
  children: (close: () => void) => ComponentChildren;
  placement?: Placement;
  class?: string;
  menu?: boolean;
  onOpenChange?: (o: boolean) => void;
  width?: number;
}) {
  const [open, setOpenRaw] = useState(false);
  const trig = useRef<HTMLElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const setOpen = (o: boolean) => {
    setOpenRaw(o);
    props.onOpenChange?.(o);
  };
  const close = () => setOpen(false);
  useLayer(open, () => {
    close();
    trig.current?.focus();
  });

  const place = () => {
    const t = trig.current;
    const p = pop.current;
    if (!t || !p) return;
    const r = t.getBoundingClientRect();
    const pw = p.offsetWidth;
    const ph = p.offsetHeight;
    const pl = props.placement || 'bottom-start';
    const gap = 6;
    let x: number;
    let y: number;
    if (pl.startsWith('right')) {
      x = r.right + gap;
      y = pl.endsWith('end') ? r.bottom - ph : r.top;
      if (x + pw > window.innerWidth - 8) x = r.left - pw - gap;
    } else {
      x = pl.endsWith('end') ? r.right - pw : r.left;
      const below = r.bottom + gap;
      const above = r.top - gap - ph;
      y = pl.startsWith('top') ? (above > 8 ? above : below) : below + ph > window.innerHeight - 8 && above > 8 ? above : below;
    }
    x = Math.max(8, Math.min(window.innerWidth - pw - 8, x));
    y = Math.max(8, Math.min(window.innerHeight - ph - 8, y));
    p.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  };

  useLayoutEffect(() => {
    if (!open) return;
    place();
    const onDown = (e: PointerEvent) => {
      const tg = e.target as Node;
      if (pop.current?.contains(tg) || trig.current?.contains(tg)) return;
      // clicks inside a nested popover/dialog portalled elsewhere
      if ((tg as Element).closest?.('.popover, .dialog-backdrop')) return;
      close();
    };
    const onMove = () => place();
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    // focus the first menu item (keyboard users) or the first field
    requestAnimationFrame(() => {
      const el = pop.current;
      if (!el) return;
      const f = el.querySelector<HTMLElement>('[data-autofocus]') || (props.menu ? el.querySelector<HTMLElement>('.menu-item:not([disabled])') : null);
      f?.focus({ preventScroll: true });
    });
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (!props.menu) return;
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    const items = [...(pop.current?.querySelectorAll<HTMLElement>('.menu-item:not([disabled])') || [])];
    if (!items.length) return;
    e.preventDefault();
    const i = items.indexOf(document.activeElement as HTMLElement);
    const n = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[n].focus();
  };

  return (
    <>
      {props.trigger({ open, toggle: () => setOpen(!open), ref: trig, 'aria-expanded': open, 'aria-haspopup': props.menu ? 'menu' : 'dialog' })}
      {open &&
        createPortal(
          <div
            ref={pop}
            class={cx('popover', props.menu && 'menu', props.class)}
            role={props.menu ? 'menu' : 'dialog'}
            style={props.width ? { width: props.width + 'px' } : undefined}
            onKeyDown={onKeyDown}
          >
            {props.children(close)}
          </div>,
          document.body,
        )}
    </>
  );
}

export function MenuItem(props: {
  icon?: LucideIcon;
  children: ComponentChildren;
  onSelect?: () => void;
  danger?: boolean;
  kbd?: string;
  disabled?: boolean;
  href?: string;
  download?: boolean;
  checked?: boolean;
  hint?: ComponentChildren;
}) {
  const Icon = props.icon;
  const inner = (
    <>
      <span class="menu-icon">{props.checked !== undefined ? props.checked && <Check size={15} /> : Icon && <Icon size={15} aria-hidden="true" />}</span>
      <span class="menu-text">{props.children}</span>
      {props.hint && <span class="menu-hint">{props.hint}</span>}
      {props.kbd && <kbd class="kbd">{props.kbd}</kbd>}
    </>
  );
  const cls = cx('menu-item', props.danger && 'danger');
  if (props.href)
    return (
      <a class={cls} role="menuitem" href={props.href} download={props.download} onClick={props.onSelect} tabIndex={-1}>
        {inner}
      </a>
    );
  return (
    <button
      type="button"
      class={cls}
      role={props.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'}
      aria-checked={props.checked}
      disabled={props.disabled}
      tabIndex={-1}
      onClick={props.onSelect}
    >
      {inner}
    </button>
  );
}
export const MenuSep = () => <div class="menu-sep" role="separator" />;
export const MenuLabel = ({ children }: { children: ComponentChildren }) => <div class="menu-label">{children}</div>;

// ------------------------------------------------------------------------------------- dialog
export function Dialog(props: {
  title?: ComponentChildren;
  description?: ComponentChildren;
  onClose: () => void;
  children?: ComponentChildren;
  footer?: ComponentChildren;
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
  class?: string;
  role?: 'dialog' | 'alertdialog';
  icon?: LucideIcon;
  bodyClass?: string;
  headerExtra?: ComponentChildren;
  ariaLabel?: string;
  backdropClass?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [closing, setClosing] = useState(false);
  const close = () => {
    if (closing) return;
    setClosing(true);
    setTimeout(props.onClose, 130);
  };
  useLayer(true, close, true);
  useFocusTrap(ref);
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);
  const titleId = useRef('dlg' + Math.random().toString(36).slice(2, 8)).current;
  const Icon = props.icon;
  return createPortal(
    <div class={cx('dialog-backdrop', props.backdropClass, closing && 'closing')} onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div ref={ref} class={cx('dialog', 'dialog-' + (props.size || 'md'), props.class)} role={props.role || 'dialog'} aria-modal="true" aria-labelledby={props.title ? titleId : undefined} aria-label={props.title ? undefined : props.ariaLabel} tabIndex={-1}>
        {props.title && (
          <div class="dialog-head">
            {Icon && (
              <span class="dialog-icon">
                <Icon size={18} aria-hidden="true" />
              </span>
            )}
            <div class="dialog-titles">
              <h2 id={titleId}>{props.title}</h2>
              {props.description && <p class="dialog-desc">{props.description}</p>}
            </div>
            {props.headerExtra}
            <IconButton icon={X} label="Close" onClick={close} class="dialog-x" />
          </div>
        )}
        <div class={cx('dialog-body', props.bodyClass)}>{props.children}</div>
        {props.footer && <div class="dialog-foot">{props.footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
registerDialog(Dialog);

// ------------------------------------------------------------------------------------- tabs
export function Tabs<T extends string>(props: { value: T; onChange: (v: T) => void; tabs: { value: T; label: ComponentChildren; icon?: LucideIcon; count?: number }[]; class?: string; ariaLabel?: string }) {
  return (
    <div class={cx('tabs', props.class)} role="tablist" aria-label={props.ariaLabel}>
      {props.tabs.map((t) => {
        const on = t.value === props.value;
        const Icon = t.icon;
        return (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={on}
            tabIndex={on ? 0 : -1}
            class={cx('tab', on && 'on')}
            onClick={() => props.onChange(t.value)}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
              const i = props.tabs.findIndex((x) => x.value === props.value);
              const n = props.tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + props.tabs.length) % props.tabs.length];
              props.onChange(n.value);
              ((e.currentTarget as HTMLElement).parentElement?.children[props.tabs.indexOf(n)] as HTMLElement)?.focus();
            }}
          >
            {Icon && <Icon size={15} aria-hidden="true" />}
            {t.label}
            {t.count != null && <span class="tab-count">{t.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------------------------- display
type Tone = 'neutral' | 'accent' | 'success' | 'danger' | 'warning' | 'info';
export function Badge({ tone = 'neutral', children, class: cls, title }: { tone?: Tone; children: ComponentChildren; class?: string; title?: string }) {
  return (
    <span class={cx('badge', 'badge-' + tone, cls)} title={title}>
      {children}
    </span>
  );
}

const STATUS_LABEL: Record<string, string> = { running: 'Running', finished: 'Finished', failed: 'Failed', crashed: 'Crashed' };
export function StatusPill({ status, compact }: { status: string; compact?: boolean }) {
  return (
    <span class={cx('status', 'status-' + status, compact && 'compact')} title={compact ? STATUS_LABEL[status] || status : undefined}>
      <span class="status-dot" aria-hidden="true" />
      {compact ? <span class="sr-only">{STATUS_LABEL[status] || status}</span> : STATUS_LABEL[status] || status}
    </span>
  );
}

export function StatusDot({ status, title }: { status: string; title?: string }) {
  return <span class={'status-dot solo status-' + status} title={title || STATUS_LABEL[status]} aria-label={title || STATUS_LABEL[status]} role="img" />;
}

export function Skeleton({ w, h = 14, class: cls, r }: { w?: number | string; h?: number | string; class?: string; r?: number }) {
  return <span class={cx('skeleton', cls)} style={{ width: typeof w === 'number' ? w + 'px' : w, height: typeof h === 'number' ? h + 'px' : h, borderRadius: r }} aria-hidden="true" />;
}

export function EmptyState(props: { icon?: LucideIcon; title: ComponentChildren; children?: ComponentChildren; action?: ComponentChildren; compact?: boolean }) {
  const Icon = props.icon;
  return (
    <div class={cx('empty-state', props.compact && 'compact')}>
      {Icon && (
        <span class="empty-icon">
          <Icon size={props.compact ? 18 : 22} aria-hidden="true" />
        </span>
      )}
      <div class="empty-title">{props.title}</div>
      {props.children && <div class="empty-body">{props.children}</div>}
      {props.action && <div class="empty-action">{props.action}</div>}
    </div>
  );
}

export function Card(props: { title?: ComponentChildren; description?: ComponentChildren; actions?: ComponentChildren; children: ComponentChildren; class?: string; flush?: boolean; id?: string }) {
  return (
    <section class={cx('card', props.class)} id={props.id}>
      {(props.title || props.actions) && (
        <header class="card-head">
          <div class="card-titles">
            {props.title && <h2 class="card-title">{props.title}</h2>}
            {props.description && <p class="card-desc">{props.description}</p>}
          </div>
          {props.actions && <div class="card-actions">{props.actions}</div>}
        </header>
      )}
      <div class={cx('card-body', props.flush && 'flush')}>{props.children}</div>
    </section>
  );
}

export function Alert({ tone = 'danger', title, children }: { tone?: 'danger' | 'warning' | 'info' | 'success'; title?: ComponentChildren; children?: ComponentChildren }) {
  const Icon = tone === 'info' || tone === 'success' ? Info : CircleExclamationPoint;
  return (
    <div class={'alert alert-' + tone} role={tone === 'danger' ? 'alert' : 'status'}>
      <Icon size={16} aria-hidden="true" class="alert-icon" />
      <div class="alert-text">
        {title && <div class="alert-title">{title}</div>}
        {children && <div>{children}</div>}
      </div>
    </div>
  );
}

export function ErrorBox({ error, title }: { error: unknown; title?: string }) {
  if (!error) return null;
  const msg = (error as Error)?.message || String(error);
  return <Alert tone="danger" title={title}>{msg}</Alert>;
}

export function Avatar({ name, size = 28 }: { name: string; size?: number }) {
  const parts = name.trim().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const ini = ((parts[0]?.[0] || '?') + (parts[1]?.[0] || '')).toUpperCase();
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return (
    <span class="avatar" style={{ width: size + 'px', height: size + 'px', fontSize: Math.round(size * 0.4) + 'px', '--av-h': String(h % 360) } as Record<string, string>} aria-hidden="true">
      {ini}
    </span>
  );
}

// ------------------------------------------------------------------------------------- copy
export function CopyButton({ text, label = 'Copy', size = 'sm', variant = 'secondary', iconOnly, class: cls, tipPos }: { text: string; label?: string; size?: Size; variant?: Variant; iconOnly?: boolean; class?: string; tipPos?: 'top' | 'bottom' | 'right' }) {
  const [done, setDone] = useState(false);
  const onClick = async () => {
    if (await copyText(text)) {
      setDone(true);
      setTimeout(() => setDone(false), 1400);
    } else toast('Copy failed', { kind: 'error', description: 'Your browser blocked clipboard access.' });
  };
  if (iconOnly) return <IconButton icon={done ? Check : Copy} label={done ? 'Copied' : label} size={size} variant={variant === 'secondary' ? 'ghost' : variant} onClick={onClick} class={cx(done && 'copied', cls)} tipPos={tipPos} />;
  return (
    <Button size={size} variant={variant} icon={done ? Check : Copy} onClick={onClick} class={cx(done && 'copied', cls)}>
      {done ? 'Copied' : label}
    </Button>
  );
}

export function CopyField({ value, mono = true }: { value: string; mono?: boolean }) {
  return (
    <div class="copyfield">
      <input class={cx('input', mono && 'mono')} readOnly value={value} aria-label="Value to copy" onFocus={(e) => (e.target as HTMLInputElement).select()} />
      <CopyButton text={value} variant="primary" size="md" />
    </div>
  );
}

export function CodeBlock({ code, label }: { code: string; label?: string }) {
  return (
    <div class="codeblock">
      <div class="codeblock-head">
        <span>{label}</span>
        <CopyButton text={code} size="xs" variant="ghost" />
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

// ------------------------------------------------------------------------------------- data
/** Small hook for async loaders with reload. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | undefined; error: unknown; loading: boolean; reload: () => void; setData: (t: T) => void } {
  const [state, setState] = useState<{ data: T | undefined; error: unknown; loading: boolean }>({ data: undefined, error: null, loading: true });
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    fn().then(
      (data) => alive && setState({ data, error: null, loading: false }),
      (error) => alive && setState((s) => ({ data: s.data, error, loading: false })),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return { ...state, reload: () => setN((x) => x + 1), setData: (data: T) => setState({ data, error: null, loading: false }) };
}

/** Re-render every `ms` (for relative timestamps). */
export function useTick(ms = 30000) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => document.visibilityState === 'visible' && set((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}
