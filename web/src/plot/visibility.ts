// One shared IntersectionObserver and one shared ResizeObserver for all panels.
type VisCb = (visible: boolean) => void;
type SizeCb = (w: number, h: number) => void;

const visCbs = new WeakMap<Element, VisCb>();
let io: IntersectionObserver | null = null;
function getIO() {
  if (!io) {
    io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) visCbs.get(e.target)?.(e.isIntersecting);
      },
      { rootMargin: '300px 0px 300px 0px' },
    );
  }
  return io;
}

export function observeVisibility(el: Element, cb: VisCb): () => void {
  visCbs.set(el, cb);
  getIO().observe(el);
  return () => {
    visCbs.delete(el);
    io?.unobserve(el);
  };
}

const sizeCbs = new WeakMap<Element, SizeCb>();
const timers = new WeakMap<Element, ReturnType<typeof setTimeout>>();
let ro: ResizeObserver | null = null;
function getRO() {
  if (!ro) {
    ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const el = e.target;
        const cr = e.contentRect;
        const prev = timers.get(el);
        if (prev) clearTimeout(prev);
        // debounce: avoid re-laying out charts on every frame of a window drag
        timers.set(
          el,
          setTimeout(() => {
            timers.delete(el);
            sizeCbs.get(el)?.(Math.floor(cr.width), Math.floor(cr.height));
          }, 80),
        );
      }
    });
  }
  return ro;
}

export function observeSize(el: Element, cb: SizeCb): () => void {
  sizeCbs.set(el, cb);
  getRO().observe(el);
  return () => {
    sizeCbs.delete(el);
    const t = timers.get(el);
    if (t) clearTimeout(t);
    ro?.unobserve(el);
  };
}
