// Formatted experiment config: dotted keys, type-aware values, search, copy-on-hover. Never raw JSON.
import { useMemo, useState } from 'preact/hooks';
import { configKind, flattenConfig, fmtConfigNumber, fmtConfigValue, rawConfigValue } from '../lib/format';
import { Braces, Search } from './icons';
import { CopyButton, EmptyState, SearchInput, cx } from './ui';

export function ConfigValue({ v, compact }: { v: unknown; compact?: boolean }) {
  const k = configKind(v);
  if (k === 'number') return <span class="cv-num">{fmtConfigNumber(v as number)}</span>;
  if (k === 'boolean') return <span class={cx('cv-bool', v ? 'on' : 'off')}>{String(v)}</span>;
  if (k === 'null') return <span class="cv-null">{v === null ? 'null' : '—'}</span>;
  if (k === 'string') return (v as string) === '' ? <span class="cv-null">empty</span> : <span class="cv-str">{v as string}</span>;
  if (k === 'array') {
    const a = v as unknown[];
    if (!a.length) return <span class="cv-null">empty list</span>;
    if (compact) return <span class="cv-str">{fmtConfigValue(a)}</span>;
    return (
      <span class="chips">
        {a.map((x, i) => (
          <span class={cx('chip', typeof x === 'number' && 'mono')} key={i}>
            {fmtConfigValue(x)}
          </span>
        ))}
      </span>
    );
  }
  return <span class="cv-null">{fmtConfigValue(v)}</span>;
}

export function ConfigView({ config }: { config: Record<string, unknown> }) {
  const [q, setQ] = useState('');
  const flat = useMemo(() => Object.entries(flattenConfig(config || {})), [config]);
  const rows = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return flat;
    return flat.filter(([k, v]) => k.toLowerCase().includes(t) || fmtConfigValue(v).toLowerCase().includes(t));
  }, [flat, q]);

  if (!flat.length)
    return (
      <div class="card">
        <EmptyState icon={Braces} title="No config logged">
          Send a <code>config</code> object with your first ingest request and it shows up here.
        </EmptyState>
      </div>
    );

  return (
    <div class="card config-card">
      <div class="card-head">
        <SearchInput value={q} onInput={setQ} placeholder="Filter keys and values" icon={Search} class="config-search" />
        <span class="faint tnum" style={{ fontSize: 12 }}>
          {rows.length === flat.length ? `${flat.length} keys` : `${rows.length} of ${flat.length}`}
        </span>
        <span class="spacer" />
        <CopyButton text={JSON.stringify(config, null, 2)} label="Copy as JSON" size="sm" variant="ghost" />
      </div>
      {rows.length === 0 ? (
        <EmptyState compact icon={Search} title="No matching keys" />
      ) : (
        <div class="config-table" role="table" aria-label="Config">
          {rows.map(([k, v]) => {
            const dot = k.lastIndexOf('.');
            return (
              <div class="config-row" role="row" key={k}>
                <div class="config-key" role="cell" title={k}>
                  {dot > 0 && <span class="ck-pfx">{k.slice(0, dot + 1)}</span>}
                  <span class="ck-name">{k.slice(dot + 1)}</span>
                </div>
                <div class="config-val" role="cell">
                  <ConfigValue v={v} />
                </div>
                <div class="config-copy">
                  <CopyButton text={rawConfigValue(v)} label="Copy value" iconOnly size="xs" />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
