import { SHORTCUTS } from '../lib/hotkeys';
import { Keyboard } from './icons';
import { Dialog } from './ui';

export function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="Keyboard shortcuts" description="Single-key shortcuts work whenever you are not typing in a field." icon={Keyboard} onClose={onClose} size="lg">
      <div class="shortcuts">
        {SHORTCUTS.map((g) => (
          <section key={g.group}>
            <h3>{g.group}</h3>
            {g.items.map((s) => (
              <div class="shortcut" key={s.label}>
                <span>{s.label}</span>
                <span class="shortcut-keys">
                  {s.keys.map((k, i) => (
                    <>
                      {i > 0 && s.keys.length === 2 && s.keys[0].length === 1 && s.keys[1].length === 1 ? <span>then</span> : null}
                      <kbd class="kbd" key={k}>
                        {k}
                      </kbd>
                    </>
                  ))}
                </span>
              </div>
            ))}
          </section>
        ))}
      </div>
    </Dialog>
  );
}
