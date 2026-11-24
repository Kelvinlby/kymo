// Framework-neutral "log your first metrics" snippets: shell env, Python (plain dict), curl.
import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { CopyButton, Tabs } from './ui';

type Lang = 'python' | 'curl' | 'env';

/** Tiny highlighter: strings, numbers, comments, a few keywords. Input is escaped by Preact. */
function hl(code: string, lang: Lang): ComponentChildren[] {
  const re =
    lang === 'python'
      ? /(#[^\n]*)|("(?:[^"\\]|\\.)*")|\b(import|for|in|range|def|return|from)\b|(\b\d+(?:\.\d+)?(?:e-?\d+)?\b)/g
      : /(#[^\n]*)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")|\b(curl|export)\b|(\$\w+)/g;
  const out: ComponentChildren[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    if (m.index > last) out.push(code.slice(last, m.index));
    const cls = m[1] ? 'tok-c' : m[2] ? 'tok-s' : m[3] ? 'tok-k' : 'tok-n';
    out.push(
      <span class={cls} key={m.index}>
        {m[0]}
      </span>,
    );
    last = m.index + m[0].length;
  }
  out.push(code.slice(last));
  return out;
}

export function snippetSet(token?: string, project = 'my-project') {
  const host = location.origin;
  const env = `export KYMO_HOST=${host}\nexport KYMO_API_KEY=${token || 'kymo_…   # create one in Settings → API tokens'}`;
  const python = `import kymo  # pip install kymo-logger  (reads KYMO_HOST / KYMO_API_KEY)

run = kymo.init(
    project="${project}",
    experiment="run-1",
    config={"lr": 3e-4, "batch_size": 64},  # any JSON-like dict
)

for step in range(1000):
    loss = 1.0 / (step + 1)
    # log a plain dict; "train/loss" is grouped under "train"
    run.log({"train/loss": loss, "eval": {"acc": 1 - loss}})

run.finish()`;
  const curl = `# any language works: POST JSON; "step" is optional (the server assigns it)
curl -H "Authorization: Bearer $KYMO_API_KEY" \\
     -H "Content-Type: application/json" \\
     -d '{"project":"${project}","experiment":"run-1","metrics":{"loss":1.2}}' \\
     $KYMO_HOST/api/v1/ingest`;
  return { env, python, curl };
}

export function CodeTabs({ token, project, initial = 'python' }: { token?: string; project?: string; initial?: Lang }) {
  const [tab, setTab] = useState<Lang>(initial);
  const s = snippetSet(token, project);
  const code = tab === 'python' ? s.python : tab === 'curl' ? s.curl : s.env;
  return (
    <div class="codetabs">
      <div class="codetabs-head">
        <Tabs
          ariaLabel="Snippet language"
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'python', label: 'Python' },
            { value: 'curl', label: 'curl' },
            { value: 'env', label: 'Environment' },
          ]}
        />
        <CopyButton text={code} size="xs" variant="ghost" />
      </div>
      <pre>
        <code>{hl(code, tab === 'python' ? 'python' : 'curl')}</code>
      </pre>
    </div>
  );
}
