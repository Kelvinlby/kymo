import { api, type Passkey, type SessionState } from '../api';
import { assertionToJSON, creationOptionsFromJSON, registrationToJSON, requestOptionsFromJSON, webauthnSupported } from './webauthn';

export function defaultPasskeyName(): string {
  const ua = navigator.userAgent;
  const os = /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : 'device';
  const br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'browser';
  return `${br} on ${os}`;
}

export async function registerPasskey(name: string): Promise<Passkey> {
  if (!webauthnSupported()) throw new Error('This browser does not support passkeys (WebAuthn). Use a secure context (https or localhost).');
  const opts = await api.passkeyRegisterStart(name);
  const cred = (await navigator.credentials.create(creationOptionsFromJSON(opts))) as PublicKeyCredential | null;
  if (!cred) throw new Error('No credential was created.');
  return api.passkeyRegisterFinish(name, registrationToJSON(cred));
}

export async function loginWithPasskey(): Promise<SessionState> {
  if (!webauthnSupported()) throw new Error('This browser does not support passkeys (WebAuthn).');
  const opts = await api.passkeyLoginStart();
  const cred = (await navigator.credentials.get(requestOptionsFromJSON(opts))) as PublicKeyCredential | null;
  if (!cred) throw new Error('No passkey was provided.');
  const r = await api.passkeyLoginFinish(assertionToJSON(cred));
  return r.state;
}
