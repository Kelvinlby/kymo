"""Minimal software WebAuthn authenticator (ES256, "none" attestation) for end-to-end tests."""
from __future__ import annotations

import base64
import hashlib
import json
import os
import struct

import cbor2
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec


def b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def unb64u(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


class SoftPasskey:
    def __init__(self, rp_id: str, origin: str):
        self.rp_id = rp_id
        self.origin = origin
        self.key = ec.generate_private_key(ec.SECP256R1())
        self.cred_id = os.urandom(32)
        self.user_handle = b""
        self.counter = 0

    def _rp_hash(self) -> bytes:
        return hashlib.sha256(self.rp_id.encode()).digest()

    def _client_data(self, typ: str, challenge: str) -> bytes:
        return json.dumps(
            {"type": typ, "challenge": challenge, "origin": self.origin, "crossOrigin": False},
            separators=(",", ":"),
        ).encode()

    def register(self, options: dict) -> dict:
        pk = options["publicKey"]
        self.user_handle = unb64u(pk["user"]["id"])
        nums = self.key.public_key().public_numbers()
        cose = cbor2.dumps({1: 2, 3: -7, -1: 1, -2: nums.x.to_bytes(32, "big"), -3: nums.y.to_bytes(32, "big")})
        auth_data = (
            self._rp_hash()
            + bytes([0x45])  # UP | UV | AT
            + struct.pack(">I", self.counter)
            + bytes(16)  # aaguid
            + struct.pack(">H", len(self.cred_id))
            + self.cred_id
            + cose
        )
        att = cbor2.dumps({"fmt": "none", "attStmt": {}, "authData": auth_data})
        cd = self._client_data("webauthn.create", pk["challenge"])
        return {
            "id": b64u(self.cred_id),
            "rawId": b64u(self.cred_id),
            "type": "public-key",
            "response": {"attestationObject": b64u(att), "clientDataJSON": b64u(cd), "transports": ["internal"]},
            "extensions": {},
        }

    def login(self, options: dict) -> dict:
        pk = options["publicKey"]
        self.counter += 1
        auth_data = self._rp_hash() + bytes([0x05]) + struct.pack(">I", self.counter)
        cd = self._client_data("webauthn.get", pk["challenge"])
        sig = self.key.sign(auth_data + hashlib.sha256(cd).digest(), ec.ECDSA(hashes.SHA256()))
        return {
            "id": b64u(self.cred_id),
            "rawId": b64u(self.cred_id),
            "type": "public-key",
            "response": {
                "authenticatorData": b64u(auth_data),
                "clientDataJSON": b64u(cd),
                "signature": b64u(sig),
                "userHandle": b64u(self.user_handle),
            },
            "extensions": {},
        }
