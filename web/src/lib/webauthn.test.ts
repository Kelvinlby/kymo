import { describe, expect, it } from 'vitest';
import { assertionToJSON, b64urlToBytes, bytesToB64url, creationOptionsFromJSON, registrationToJSON, requestOptionsFromJSON } from './webauthn';

describe('base64url', () => {
  it('round-trips every length without padding', () => {
    for (let n = 0; n < 40; n++) {
      const b = new Uint8Array(n).map((_, i) => (i * 97 + n) & 255);
      const s = bytesToB64url(b);
      expect(s).not.toMatch(/[=+/]/);
      expect(Array.from(b64urlToBytes(s))).toEqual(Array.from(b));
    }
  });
  it('decodes url-safe alphabet', () => {
    expect(Array.from(b64urlToBytes('-_8'))).toEqual([0xfb, 0xff]);
    expect(bytesToB64url(new Uint8Array([0xfb, 0xff]))).toBe('-_8');
  });
});

describe('options from webauthn-rs JSON', () => {
  it('converts creation options', () => {
    const o = creationOptionsFromJSON({
      publicKey: {
        rp: { name: 'Kymo', id: 'localhost' },
        user: { id: 'AQID', name: 'alice', displayName: 'Alice' },
        challenge: 'BAUG',
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        excludeCredentials: [{ type: 'public-key', id: 'BwgJ' }],
        authenticatorSelection: { authenticatorAttachment: null, userVerification: 'preferred' },
        timeout: 60000,
      },
    });
    const pk = o.publicKey!;
    expect(Array.from(new Uint8Array(pk.challenge as ArrayBuffer))).toEqual([4, 5, 6]);
    expect(Array.from(new Uint8Array(pk.user.id as ArrayBuffer))).toEqual([1, 2, 3]);
    expect(Array.from(new Uint8Array(pk.excludeCredentials![0].id as ArrayBuffer))).toEqual([7, 8, 9]);
    expect('authenticatorAttachment' in pk.authenticatorSelection!).toBe(false);
    expect(pk.rp.id).toBe('localhost');
  });
  it('converts request options', () => {
    const o = requestOptionsFromJSON({ publicKey: { challenge: 'AA', allowCredentials: [{ type: 'public-key', id: 'AQ' }], rpId: 'localhost' } });
    expect(Array.from(new Uint8Array(o.publicKey!.allowCredentials![0].id as ArrayBuffer))).toEqual([1]);
    expect(o.publicKey!.rpId).toBe('localhost');
  });
});

describe('credential to JSON', () => {
  const buf = (...a: number[]) => new Uint8Array(a).buffer;
  it('serialises a registration', () => {
    const cred = {
      id: 'AQI',
      rawId: buf(1, 2),
      type: 'public-key',
      response: { attestationObject: buf(3), clientDataJSON: buf(4), getTransports: () => ['internal'] },
      getClientExtensionResults: () => ({}),
    } as unknown as PublicKeyCredential;
    expect(registrationToJSON(cred)).toEqual({
      id: 'AQI',
      rawId: 'AQI',
      type: 'public-key',
      response: { attestationObject: 'Aw', clientDataJSON: 'BA', transports: ['internal'] },
      extensions: {},
    });
  });
  it('serialises an assertion', () => {
    const cred = {
      id: 'AQI',
      rawId: buf(1, 2),
      type: 'public-key',
      response: { authenticatorData: buf(5), clientDataJSON: buf(6), signature: buf(7), userHandle: null },
    } as unknown as PublicKeyCredential;
    expect(assertionToJSON(cred).response).toEqual({ authenticatorData: 'BQ', clientDataJSON: 'Bg', signature: 'Bw', userHandle: null });
  });
});
