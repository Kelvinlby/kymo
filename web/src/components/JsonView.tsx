import { useState } from 'preact/hooks';

/** Collapsible JSON tree viewer. */
export function JsonView({ value }: { value: unknown }) {
  return (
    <div class="json">
      <Node value={value} depth={0} />
    </div>
  );
}

function Node({ name, value, depth }: { name?: string; value: unknown; depth: number }) {
  const [open, setOpen] = useState(depth < 2);
  const label = name !== undefined && (
    <>
      <span class="k">{name}</span>
      <span class="z">: </span>
    </>
  );
  if (value !== null && typeof value === 'object') {
    const isArr = Array.isArray(value);
    const entries = isArr ? (value as unknown[]).map((v, i) => [String(i), v] as const) : Object.entries(value as Record<string, unknown>);
    const br = isArr ? ['[', ']'] : ['{', '}'];
    if (entries.length === 0)
      return (
        <div>
          <span class="toggle" />
          {label}
          <span class="z">{br.join('')}</span>
        </div>
      );
    return (
      <div>
        <span class="toggle" onClick={() => setOpen(!open)}>
          {open ? '▾' : '▸'}
        </span>
        {label}
        {open ? (
          <>
            <span class="z">{br[0]}</span>
            <div class="indent">
              {entries.map(([k, v]) => (
                <Node key={k} name={isArr ? undefined : k} value={v} depth={depth + 1} />
              ))}
            </div>
            <span class="toggle" />
            <span class="z">{br[1]}</span>
          </>
        ) : (
          <span class="z" style={{ cursor: 'pointer' }} onClick={() => setOpen(true)}>
            {br[0]} {entries.length} {isArr ? 'items' : 'keys'} {br[1]}
          </span>
        )}
      </div>
    );
  }
  let cls = 'z';
  let text = String(value);
  if (typeof value === 'string') {
    cls = 's';
    text = JSON.stringify(value);
  } else if (typeof value === 'number') cls = 'n';
  else if (typeof value === 'boolean') cls = 'b';
  return (
    <div>
      <span class="toggle" />
      {label}
      <span class={cls}>{text}</span>
    </div>
  );
}
