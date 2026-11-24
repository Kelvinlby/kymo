// WebAuthn JSON <-> ArrayBuffer conversion (webauthn-rs JSON shapes, base64url without padding).
// Written by hand: PublicKeyCredential.parseCreationOptionsFromJSON is not available everywhere.

export function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '==='.slice((b64.length + 3) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64url(buf: ArrayBuffer | ArrayBufferView): string {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode(...bytes.subarray(i, i + CH));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Recursively drop null/undefined members (browsers reject `null` for enum members). */
function stripNulls<T>(v: T): T {
  if (Array.isArray(v)) return v.map(stripNulls) as T;
  if (v && typeof v === 'object' && !(v instanceof ArrayBuffer) && !ArrayBuffer.isView(v)) {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (x != null) o[k] = stripNulls(x);
    return o as T;
  }
  return v;
}

type JsonDesc = { type: string; id: string; transports?: string[] };

const descToBin = (d: JsonDesc): PublicKeyCredentialDescriptor => ({
  ...d,
  id: b64urlToBytes(d.id),
  transports: d.transports as AuthenticatorTransport[] | undefined,
  type: 'public-key',
});

/** `{publicKey: {...}}` (CreationChallengeResponse) -> CredentialCreationOptions */
export function creationOptionsFromJSON(json: any): CredentialCreationOptions {
  const pk = stripNulls(json?.publicKey ?? json);
  const publicKey: PublicKeyCredentialCreationOptions = {
    ...pk,
    challenge: b64urlToBytes(pk.challenge),
    user: { ...pk.user, id: b64urlToBytes(pk.user.id) },
    excludeCredentials: (pk.excludeCredentials ?? []).map(descToBin),
  };
  return { publicKey };
}

/** `{publicKey: {...}}` (RequestChallengeResponse) -> CredentialRequestOptions */
export function requestOptionsFromJSON(json: any): CredentialRequestOptions {
  const pk = stripNulls(json?.publicKey ?? json);
  const publicKey: PublicKeyCredentialRequestOptions = {
    ...pk,
    challenge: b64urlToBytes(pk.challenge),
    allowCredentials: (pk.allowCredentials ?? []).map(descToBin),
  };
  const out: CredentialRequestOptions = { publicKey };
  if (json?.mediation) out.mediation = json.mediation;
  return out;
}

/** Shape expected by webauthn-rs `RegisterPublicKeyCredential`. */
export interface RegisterCredentialJSON {
  id: string;
  rawId: string;
  type: string;
  response: { attestationObject: string; clientDataJSON: string; transports?: string[] };
  extensions: Record<string, unknown>;
}

/** Shape expected by webauthn-rs `PublicKeyCredential`. */
export interface AuthCredentialJSON {
  id: string;
  rawId: string;
  type: string;
  response: { authenticatorData: string; clientDataJSON: string; signature: string; userHandle: string | null };
  extensions: Record<string, unknown>;
}

export function registrationToJSON(cred: PublicKeyCredential): RegisterCredentialJSON {
  const r = cred.response as AuthenticatorAttestationResponse;
  const out: RegisterCredentialJSON = {
    id: cred.id,
    rawId: bytesToB64url(cred.rawId),
    type: cred.type,
    response: {
      attestationObject: bytesToB64url(r.attestationObject),
      clientDataJSON: bytesToB64url(r.clientDataJSON),
    },
    extensions: {},
  };
  const transports = typeof r.getTransports === 'function' ? r.getTransports() : undefined;
  if (transports && transports.length) out.response.transports = transports;
  return out;
}

export function assertionToJSON(cred: PublicKeyCredential): AuthCredentialJSON {
  const r = cred.response as AuthenticatorAssertionResponse;
  return {
    id: cred.id,
    rawId: bytesToB64url(cred.rawId),
    type: cred.type,
    response: {
      authenticatorData: bytesToB64url(r.authenticatorData),
      clientDataJSON: bytesToB64url(r.clientDataJSON),
      signature: bytesToB64url(r.signature),
      userHandle: r.userHandle ? bytesToB64url(r.userHandle) : null,
    },
    extensions: {},
  };
}

export function webauthnSupported(): boolean {
  return typeof window !== 'undefined' && !!window.PublicKeyCredential && !!navigator.credentials;
}

/** Human message for the usual WebAuthn DOMExceptions. */
export function describeWebauthnError(e: unknown): string {
  const name = (e as { name?: string })?.name;
  if (name === 'NotAllowedError') return 'The passkey prompt was cancelled or timed out.';
  if (name === 'InvalidStateError') return 'This authenticator is already registered.';
  if (name === 'SecurityError') return 'Passkeys are not allowed on this origin (check KYMO_RP_ID / KYMO_ORIGIN).';
  if (name === 'NotSupportedError') return 'No supported authenticator is available.';
  return (e as Error)?.message || String(e);
}
