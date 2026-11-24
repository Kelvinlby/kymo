// Backup / restore dialog. One self-describing .kymo.tar.gz per project (format: BACKUP-FORMAT.md).
// Back up: every project is checked by default; where the browser can write to a folder
// (File System Access API) the files are streamed there with progress, else each one is a
// normal browser download. Restore: each chosen file is uploaded and becomes a new project.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ApiError, api, type Project } from '../api';
import { useAuth } from '../auth';
import { refreshProjects, useProjectsData } from '../lib/data';
import { absTime, fmtInt, relTime } from '../lib/format';
import { navigate } from '../router';
import { ArchiveRestore, CircleCheck, CircleX, DatabaseBackup, LoaderCircle, Upload } from './icons';
import { toast } from './overlay';
import { Button, Dialog, Tabs, cx } from './ui';

type Tab = 'backup' | 'restore';

interface FileProgress {
  state: 'waiting' | 'running' | 'done' | 'error';
  bytes: number;
  error?: string;
}

const fmtBytes = (n: number) => (n < 1024 ? n + ' B' : n < 1 << 20 ? (n / 1024).toFixed(1) + ' KB' : n < 1 << 30 ? (n / (1 << 20)).toFixed(1) + ' MB' : (n / (1 << 30)).toFixed(2) + ' GB');

/** Last backup in the viewer's own timezone (the server stores UTC). */
function LastBackup({ p }: { p: Project }) {
  if (!p.last_backup_at) return <span class="faint">Never backed up</span>;
  return (
    <span title={absTime(p.last_backup_at)}>
      Last backup {absTime(p.last_backup_at)} <span class="faint">· {relTime(p.last_backup_at)}</span>
    </span>
  );
}

function fileNameOf(res: Response, p: Project): string {
  const m = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '');
  return m ? m[1] : p.name + '.kymo.tar.gz';
}

type DirHandle = { getFileHandle: (n: string, o: { create: boolean }) => Promise<{ createWritable: () => Promise<WritableStream<Uint8Array>> }> };
/** File System Access API folder picker (Chromium); undefined elsewhere. Looked up at call time. */
const dirPicker = () => (window as unknown as { showDirectoryPicker?: (o: object) => Promise<DirHandle> }).showDirectoryPicker?.bind(window);

function BackupTab({ onClose }: { onClose: () => void }) {
  const { auth } = useAuth();
  const d = useProjectsData();
  const projects = useMemo(() => [...(d.projects || [])].sort((a, b) => a.name.localeCompare(b.name) || a.owner.username.localeCompare(b.owner.username)), [d.projects]);
  // everything is checked by default; this holds the ones the user unchecked
  const [unchecked, setUnchecked] = useState<Set<number>>(new Set());
  const [prog, setProg] = useState<Map<number, FileProgress>>(new Map());
  const [busy, setBusy] = useState(false);
  const chosen = projects.filter((p) => !unchecked.has(p.id));
  const allRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (allRef.current) allRef.current.indeterminate = chosen.length > 0 && chosen.length < projects.length;
  }, [chosen.length, projects.length]);
  // plain browser downloads report nothing back: poll so finished backups show their new time
  const pollUntil = useRef(0);
  useEffect(() => () => void (pollUntil.current = 0), []);
  const poll = () => {
    const first = pollUntil.current < Date.now();
    pollUntil.current = Date.now() + 120_000;
    if (!first) return;
    const tick = () => {
      if (Date.now() > pollUntil.current) return;
      refreshProjects().finally(() => setTimeout(tick, 3000));
    };
    setTimeout(tick, 2000);
  };

  const toggle = (id: number) => {
    const s = new Set(unchecked);
    if (s.has(id)) s.delete(id);
    else s.add(id);
    setUnchecked(s);
  };
  const setP = (id: number, f: FileProgress) => setProg((m) => new Map(m).set(id, f));

  const pickDir = dirPicker();
  const toFolder = async () => {
    let dir: DirHandle;
    try {
      dir = await dirPicker()!({ id: 'kymo-backups', mode: 'readwrite', startIn: 'downloads' });
    } catch {
      return; // picker cancelled
    }
    setBusy(true);
    setProg(new Map(chosen.map((p) => [p.id, { state: 'waiting', bytes: 0 }])));
    let ok = 0;
    for (const p of chosen) {
      setP(p.id, { state: 'running', bytes: 0 });
      try {
        const res = await fetch(api.backupUrl(p.id), { credentials: 'same-origin' });
        if (!res.ok || !res.body) {
          const j = await res.json().catch(() => null);
          throw new Error(j?.error || res.statusText);
        }
        const fh = await dir.getFileHandle(fileNameOf(res, p), { create: true });
        const out = await fh.createWritable();
        let bytes = 0;
        let last = 0;
        const count = new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, ctl) {
            bytes += chunk.byteLength;
            if (performance.now() - last > 150) {
              last = performance.now();
              setP(p.id, { state: 'running', bytes });
            }
            ctl.enqueue(chunk);
          },
        });
        await res.body.pipeThrough(count).pipeTo(out);
        setP(p.id, { state: 'done', bytes });
        ok++;
      } catch (e) {
        setP(p.id, { state: 'error', bytes: 0, error: (e as Error).message || String(e) });
      }
    }
    setBusy(false);
    refreshProjects();
    toast(ok === chosen.length ? `Saved ${ok} ${ok === 1 ? 'backup' : 'backups'}` : `Saved ${ok} of ${chosen.length} backups`, { kind: ok === chosen.length ? 'success' : 'error' });
  };

  const download = async () => {
    setBusy(true);
    for (const p of chosen) {
      const a = document.createElement('a');
      a.href = api.backupUrl(p.id);
      a.download = '';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setP(p.id, { state: 'done', bytes: 0 });
      await new Promise((r) => setTimeout(r, 600)); // browsers drop rapid-fire downloads
    }
    setBusy(false);
    poll();
    toast(`Started ${chosen.length} ${chosen.length === 1 ? 'download' : 'downloads'}`, {
      description: chosen.length > 1 ? 'If your browser asks, allow this site to download multiple files.' : undefined,
    });
  };

  if (!d.projects) return <div class="backup-empty faint">Loading projects…</div>;
  if (!projects.length) return <div class="backup-empty faint">There are no projects to back up yet.</div>;
  return (
    <>
      <div class="backup-intro">
        One file per project: a <span class="mono">.kymo.tar.gz</span> with every experiment, its config and notes, and every
        metric point at full precision. It is plain JSON and CSV with the format described in a README inside, so it can be
        read without Kymo.
      </div>
      <div class="backup-list" role="group" aria-label="Projects to back up">
        <label class="backup-row backup-all">
          <input
            ref={allRef}
            type="checkbox"
            class="checkbox"
            checked={chosen.length === projects.length}
            disabled={busy}
            onChange={() => setUnchecked(chosen.length === projects.length ? new Set(projects.map((p) => p.id)) : new Set())}
          />
          <span class="grow">
            <b>All projects</b> <span class="faint">· {chosen.length} of {projects.length} selected</span>
          </span>
        </label>
        {projects.map((p) => {
          const pr = prog.get(p.id);
          return (
            <label key={p.id} class={cx('backup-row', unchecked.has(p.id) && 'off')}>
              <input type="checkbox" class="checkbox" checked={!unchecked.has(p.id)} disabled={busy} onChange={() => toggle(p.id)} />
              <span class="grow backup-main">
                <span class="backup-name">
                  <span class="mono">{p.owner.id === auth.user?.id ? p.name : `${p.owner.username}/${p.name}`}</span>
                  <span class="faint">
                    {' '}
                    · {fmtInt(p.experiment_count)} {p.experiment_count === 1 ? 'experiment' : 'experiments'}
                  </span>
                </span>
                <span class="backup-when">
                  <LastBackup p={p} />
                </span>
              </span>
              {pr && <ProgressMark f={pr} />}
            </label>
          );
        })}
      </div>
      <div class="backup-actions">
        <span class="faint grow">{pickDir ? 'You choose a folder; each project is saved there as its own file.' : 'Each project downloads as its own file.'}</span>
        <Button onClick={onClose} disabled={busy}>
          Close
        </Button>
        <Button variant="primary" icon={DatabaseBackup} loading={busy} disabled={!chosen.length} onClick={pickDir ? toFolder : download}>
          {pickDir ? 'Save' : 'Download'} {chosen.length} {chosen.length === 1 ? 'backup' : 'backups'}
        </Button>
      </div>
    </>
  );
}

function ProgressMark({ f }: { f: FileProgress }) {
  if (f.state === 'waiting') return <span class="backup-prog faint">Waiting</span>;
  if (f.state === 'running')
    return (
      <span class="backup-prog">
        <LoaderCircle size={14} class="spin" aria-hidden="true" /> {fmtBytes(f.bytes)}
      </span>
    );
  if (f.state === 'error')
    return (
      <span class="backup-prog err" title={f.error}>
        <CircleX size={14} aria-hidden="true" /> Failed
      </span>
    );
  return (
    <span class="backup-prog ok">
      <CircleCheck size={14} aria-hidden="true" /> {f.bytes ? fmtBytes(f.bytes) : 'Started'}
    </span>
  );
}

interface UploadItem {
  file: File;
  state: 'waiting' | 'uploading' | 'importing' | 'done' | 'error';
  sent: number;
  result?: { project: Project; experiments: number; metrics: number; points: number };
  error?: string;
}

/** POST one file with upload progress (fetch cannot report it). */
function uploadBackup(file: File, onSent: (n: number) => void): Promise<UploadItem['result']> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', '/api/v1/projects/import');
    x.setRequestHeader('X-Kymo-CSRF', '1');
    x.withCredentials = true;
    x.upload.onprogress = (e) => onSent(e.loaded);
    x.onerror = () => reject(new ApiError(0, 'network', 'Network error while uploading'));
    x.onload = () => {
      let j: any = null;
      try {
        j = JSON.parse(x.responseText);
      } catch {
        /* not JSON */
      }
      if (x.status >= 200 && x.status < 300) resolve(j);
      else reject(new ApiError(x.status, j?.code || 'http_' + x.status, j?.error || x.statusText || 'Import failed'));
    };
    x.send(file);
  });
}

function RestoreTab({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const run = async (files: File[]) => {
    if (!files.length || busy) return;
    const list: UploadItem[] = files.map((file) => ({ file, state: 'waiting', sent: 0 }));
    setItems(list);
    setBusy(true);
    const upd = (i: number, p: Partial<UploadItem>) => {
      list[i] = { ...list[i], ...p };
      setItems([...list]);
    };
    for (let i = 0; i < list.length; i++) {
      upd(i, { state: 'uploading' });
      try {
        const r = await uploadBackup(list[i].file, (n) => upd(i, { sent: n, state: n >= list[i].file.size ? 'importing' : 'uploading' }));
        upd(i, { state: 'done', result: r });
      } catch (e) {
        upd(i, { state: 'error', error: (e as Error).message });
      }
    }
    setBusy(false);
    refreshProjects();
  };

  return (
    <>
      <div class="backup-intro">
        Each backup file becomes a <b>new project</b> owned by you; nothing existing is changed. If you already have a project with
        that name, the restored one gets a <span class="mono">-restored</span> suffix.
      </div>
      <div
        class={cx('drop-zone', over && 'over', busy && 'busy')}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          run([...(e.dataTransfer?.files || [])]);
        }}
        onClick={() => !busy && input.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), !busy && input.current?.click())}
      >
        <Upload size={22} aria-hidden="true" />
        <div>
          <b>Choose backup files</b> or drop them here
        </div>
        <div class="faint">.kymo.tar.gz — several at once is fine</div>
        <input
          ref={input}
          type="file"
          multiple
          accept=".gz,.tgz,.tar,application/gzip,application/x-tar"
          hidden
          onChange={(e) => {
            const t = e.target as HTMLInputElement;
            run([...(t.files || [])]);
            t.value = '';
          }}
        />
      </div>
      {items.length > 0 && (
        <div class="backup-list">
          {items.map((it, i) => (
            <div class="backup-row" key={i}>
              <span class="grow backup-main">
                <span class="backup-name mono">{it.file.name}</span>
                <span class="backup-when">
                  {it.state === 'waiting' && <span class="faint">Waiting · {fmtBytes(it.file.size)}</span>}
                  {it.state === 'uploading' && (
                    <span>
                      Uploading {fmtBytes(it.sent)} of {fmtBytes(it.file.size)}
                    </span>
                  )}
                  {it.state === 'importing' && <span>Importing…</span>}
                  {it.state === 'error' && <span class="error">{it.error}</span>}
                  {it.state === 'done' && it.result && (
                    <span>
                      Restored as{' '}
                      <a
                        href={'/p/' + it.result.project.id}
                        onClick={(e) => {
                          e.preventDefault();
                          onClose();
                          navigate('/p/' + it.result!.project.id);
                        }}
                      >
                        {it.result.project.name}
                      </a>{' '}
                      <span class="faint">
                        · {fmtInt(it.result.experiments)} experiments · {fmtInt(it.result.metrics)} metrics · {fmtInt(it.result.points)} points
                      </span>
                    </span>
                  )}
                </span>
              </span>
              {(it.state === 'uploading' || it.state === 'importing') && (
                <span class="backup-prog">
                  <LoaderCircle size={14} class="spin" aria-hidden="true" />
                </span>
              )}
              {it.state === 'done' && (
                <span class="backup-prog ok">
                  <CircleCheck size={14} aria-hidden="true" />
                </span>
              )}
              {it.state === 'error' && (
                <span class="backup-prog err">
                  <CircleX size={14} aria-hidden="true" />
                </span>
              )}
            </div>
          ))}
        </div>
      )}
      <div class="backup-actions">
        <span class="grow" />
        <Button onClick={onClose} disabled={busy}>
          Close
        </Button>
      </div>
    </>
  );
}

export function BackupDialog({ onClose, initialTab = 'backup' }: { onClose: () => void; initialTab?: Tab }) {
  const [tab, setTab] = useState<Tab>(initialTab);
  return (
    <Dialog title="Backup & restore" icon={DatabaseBackup} onClose={onClose} size="lg" bodyClass="backup-body">
      <Tabs
        ariaLabel="Backup or restore"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'backup', label: 'Back up', icon: DatabaseBackup },
          { value: 'restore', label: 'Restore', icon: ArchiveRestore },
        ]}
      />
      {tab === 'backup' ? <BackupTab onClose={onClose} /> : <RestoreTab onClose={onClose} />}
    </Dialog>
  );
}
