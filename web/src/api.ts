// Typed client for the Kymo HTTP API (SPEC.md §2, §4).

export type SessionState = 'full' | 'passkey_required' | 'enroll_passkey';
export type Timestamp = string | number; // RFC3339 or unix seconds; see lib/format.toDate

export interface User {
  id: number;
  username: string;
  display_name: string;
  is_admin: boolean;
}
export interface AuthState {
  setup_required: boolean;
  session_state: SessionState | null;
  user: User | null;
  policy: { passkey_required_for_all: boolean };
  version: string;
}
export type ProjectRole = 'owner' | 'admin' | 'editor' | 'viewer';
export type ShareRole = 'viewer' | 'editor';
export interface UserRef {
  id: number;
  username: string;
  display_name?: string;
}
export interface Project {
  id: number;
  name: string;
  description: string;
  owner: UserRef;
  created_at: Timestamp;
  experiment_count: number;
  last_activity: Timestamp | null;
  /** SPEC §1 sharing; optional so older servers (with `shared: bool`) keep working */
  role?: ProjectRole;
  everyone?: ShareRole | null;
  member_count?: number;
  running_count?: number;
  /** legacy (pre-sharing servers) */
  shared?: boolean;
  /** when a backup of this project was last downloaded completely (null = never) */
  last_backup_at?: Timestamp | null;
}
export interface Sharing {
  everyone: ShareRole | null;
  members: { user: UserRef; role: ShareRole }[];
}
export type Status = 'running' | 'finished' | 'failed' | 'crashed';
export interface Experiment {
  id: number;
  name: string;
  status: Status;
  tags: string[];
  notes?: string;
  created_at: Timestamp;
  updated_at: Timestamp;
  host?: string | null;
  config: Record<string, unknown>;
  metric_count: number;
  last_step: number | null;
  project?: { id: number; name: string };
}
export interface MetricSummary {
  key: string;
  count: number;
  first_step: number;
  last_step: number;
  min: number | null;
  max: number | null;
  last_value: number | null;
  last_ts: number | null;
}
export interface SeriesRef {
  experiment_id: number;
  key: string;
}
export interface SeriesQuery {
  series: SeriesRef[];
  max_points?: number;
  step_min?: number | null;
  step_max?: number | null;
}
export interface SeriesResult extends SeriesRef {
  total: number;
  downsampled: boolean;
  step: number[];
  value: (number | null)[];
  min?: (number | null)[];
  max?: (number | null)[];
  ts: number[];
}
export interface ApiToken {
  id: number;
  name: string;
  prefix: string;
  created_at: Timestamp;
  last_used_at: Timestamp | null;
  /** switched off: requests with it get 401 token_disabled until it is enabled again */
  disabled?: boolean;
}
export interface Passkey {
  id: number;
  name: string;
  created_at: Timestamp;
  last_used_at: Timestamp | null;
}
export interface AdminUser extends User {
  disabled: boolean;
  created_at: Timestamp;
  passkey_count: number;
  last_login_at: Timestamp | null;
}
export interface Invite {
  id: number;
  username: string | null;
  expires_at: Timestamp;
  used_at: Timestamp | null;
  created_at: Timestamp;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

type Listener = (e: ApiError) => void;
const authListeners = new Set<Listener>();
/** Called on 401 / session-state 403 so the app can re-check /auth/state. */
export function onAuthError(fn: Listener) {
  authListeners.add(fn);
  return () => authListeners.delete(fn);
}

export async function request<T>(method: string, path: string, body?: unknown, opts: { signal?: AbortSignal; quietAuth?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET' && method !== 'HEAD') headers['X-Kymo-CSRF'] = '1';
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch('/api/v1' + path, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError(0, 'network', 'Network error: cannot reach the Kymo server');
  }
  const text = await res.text();
  let data: any = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const err = new ApiError(res.status, data?.code || 'http_' + res.status, data?.error || res.statusText || 'Request failed');
    if (!opts.quietAuth && (res.status === 401 || (res.status === 403 && /^session_/.test(err.code)))) {
      for (const l of authListeners) l(err);
    }
    throw err;
  }
  return data as T;
}

const get = <T>(p: string, signal?: AbortSignal) => request<T>('GET', p, undefined, { signal });
const post = <T>(p: string, b?: unknown) => request<T>('POST', p, b ?? {});
const patch = <T>(p: string, b: unknown) => request<T>('PATCH', p, b);
const put = <T>(p: string, b: unknown) => request<T>('PUT', p, b);
const del = <T = unknown>(p: string) => request<T>('DELETE', p);

export const api = {
  // auth
  state: () => request<AuthState>('GET', '/auth/state', undefined, { quietAuth: true }),
  setup: (b: { setup_token: string; username: string; password: string; display_name?: string }) => post<{ state: SessionState }>('/auth/setup', b),
  login: (username: string, password: string) => request<{ state: SessionState }>('POST', '/auth/login', { username, password }, { quietAuth: true }),
  logout: () => post('/auth/logout'),
  invite: (token: string) => get<{ valid: boolean; username?: string }>('/auth/invite/' + encodeURIComponent(token)),
  signup: (b: { invite_token: string; username: string; password: string; display_name?: string }) => post<{ state: SessionState }>('/auth/signup', b),
  reset: (reset_token: string, password: string) => post('/auth/reset', { reset_token, password }),
  changePassword: (old_password: string, new_password: string) => post('/auth/password', { old_password, new_password }),
  passkeyRegisterStart: (name: string) => post<any>('/auth/passkey/register/start', { name }),
  passkeyRegisterFinish: (name: string, credential: unknown) => post<Passkey>('/auth/passkey/register/finish', { name, credential }),
  passkeyLoginStart: () => post<any>('/auth/passkey/login/start'),
  passkeyLoginFinish: (credential: unknown) => post<{ state: SessionState }>('/auth/passkey/login/finish', { credential }),
  passkeys: () => get<Passkey[]>('/auth/passkeys'),
  deletePasskey: (id: number) => del('/auth/passkeys/' + id),
  // tokens
  tokens: () => get<ApiToken[]>('/tokens'),
  createToken: (name: string) => post<{ id: number; name: string; token: string; created_at: Timestamp }>('/tokens', { name }),
  deleteToken: (id: number) => del('/tokens/' + id),
  setTokenDisabled: (id: number, disabled: boolean) => patch<ApiToken>('/tokens/' + id, { disabled }),
  // admin
  users: () => get<AdminUser[]>('/admin/users'),
  patchUser: (id: number, b: { disabled?: boolean; reset_passkeys?: boolean; display_name?: string }) => patch<AdminUser>('/admin/users/' + id, b),
  deleteUser: (id: number) => del('/admin/users/' + id),
  resetPasswordLink: (id: number) => post<{ url: string }>('/admin/users/' + id + '/reset-password'),
  invites: () => get<Invite[]>('/admin/invites'),
  createInvite: (b: { username?: string; expires_hours?: number }) => post<{ id: number; token: string; url: string; username: string | null; expires_at: Timestamp }>('/admin/invites', b),
  deleteInvite: (id: number) => del('/admin/invites/' + id),
  settings: () => get<{ passkey_required_for_all: boolean }>('/admin/settings'),
  putSettings: (b: { passkey_required_for_all: boolean }) => put<{ passkey_required_for_all: boolean }>('/admin/settings', b),
  // projects
  projects: () => get<Project[]>('/projects'),
  project: (id: number) => get<Project>('/projects/' + id),
  createProject: (name: string, description?: string) => post<Project>('/projects', { name, description }),
  patchProject: (id: number, b: { name?: string; description?: string }) => patch<Project>('/projects/' + id, b),
  sharing: (id: number) => get<Sharing>('/projects/' + id + '/sharing'),
  putSharing: (id: number, b: { everyone: ShareRole | null; members: { user_id: number; role: ShareRole }[] }) => put<Sharing>('/projects/' + id + '/sharing', b),
  directory: () => get<UserRef[]>('/users'),
  deleteProject: (id: number) => del('/projects/' + id),
  experiments: (pid: number, signal?: AbortSignal) => get<Experiment[]>('/projects/' + pid + '/experiments', signal),
  metricKeys: (pid: number) => get<string[]>('/projects/' + pid + '/metric-keys'),
  // experiments
  experiment: (id: number) => get<Experiment>('/experiments/' + id),
  patchExperiment: (id: number, b: { name?: string; tags?: string[]; notes?: string; status?: Status }) => patch<Experiment>('/experiments/' + id, b),
  deleteExperiment: (id: number) => del('/experiments/' + id),
  metrics: (id: number, signal?: AbortSignal) => get<MetricSummary[]>('/experiments/' + id + '/metrics', signal),
  query: (q: SeriesQuery, signal?: AbortSignal) => request<{ series: SeriesResult[] }>('POST', '/series/query', q, { signal }),
  backupUrl: (projectId: number) => `/api/v1/projects/${projectId}/backup`,
  rawUrl: (experimentId: number, key: string, format: 'csv' | 'json' = 'csv') =>
    `/api/v1/series/raw?experiment_id=${experimentId}&key=${encodeURIComponent(key)}&format=${format}`,
};

/** The caller's role in a project; falls back to owner/admin/viewer for servers without `role`. */
export function projectRole(p: Project | null | undefined, user: User | null | undefined): ProjectRole {
  if (!p) return 'viewer';
  if (p.role) return p.role;
  if (user && p.owner.id === user.id) return 'owner';
  if (user?.is_admin) return 'admin';
  return 'viewer';
}
export const canManage = (r: ProjectRole) => r === 'owner' || r === 'admin';
export const canEdit = (r: ProjectRole) => r !== 'viewer';
/** `everyone` with a fallback for legacy `shared: true`. */
export const everyoneRole = (p: Project): ShareRole | null => (p.everyone !== undefined ? p.everyone : p.shared ? 'viewer' : null);
