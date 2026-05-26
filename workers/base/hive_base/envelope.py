"""Envelope encryption (Python side).

Same wire format as the TS `apps/api/src/lib/envelope.ts`:

  v2:  hive:enc:v2:<b64url(keyId)>:<b64(wrappedDek)>:<b64(nonce || ct+tag)>

Backward compatibility:
  v1 envelopes (hive:enc:v1:…) are accepted by decrypt_value() so existing
  Bot.config rows keep working. New writes always emit v2.
"""
from __future__ import annotations

import base64
import secrets
from typing import Optional

from nacl.bindings import (
    crypto_aead_xchacha20poly1305_ietf_encrypt,
    crypto_aead_xchacha20poly1305_ietf_decrypt,
    crypto_aead_xchacha20poly1305_ietf_KEYBYTES,
    crypto_aead_xchacha20poly1305_ietf_NPUBBYTES,
    crypto_aead_xchacha20poly1305_ietf_ABYTES,
)
from nacl.exceptions import CryptoError

from .crypto import PREFIX as PREFIX_V1, decrypt as decrypt_v1, is_encrypted as is_v1
from .kms import EncryptedDek, HiveKmsProvider, get_kms_provider

PREFIX_V2 = "hive:enc:v2:"

_KEYBYTES = crypto_aead_xchacha20poly1305_ietf_KEYBYTES
_NONCEBYTES = crypto_aead_xchacha20poly1305_ietf_NPUBBYTES
_ABYTES = crypto_aead_xchacha20poly1305_ietf_ABYTES


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _from_b64url(s: str) -> bytes:
    pad = "=" * ((4 - len(s) % 4) % 4)
    return base64.urlsafe_b64decode(s + pad)


def is_envelope(value: object) -> bool:
    return isinstance(value, str) and (value.startswith(PREFIX_V2) or value.startswith(PREFIX_V1))


def is_v2(value: object) -> bool:
    return isinstance(value, str) and value.startswith(PREFIX_V2)


def encrypt_value(plaintext: str, *, kms: Optional[HiveKmsProvider] = None) -> str:
    if not isinstance(plaintext, str):
        raise TypeError("encrypt_value() expects a str")
    provider = kms or get_kms_provider()

    dek = secrets.token_bytes(_KEYBYTES)
    try:
        wrapped = provider.encrypt_dek(dek)
        nonce = secrets.token_bytes(_NONCEBYTES)
        ct = crypto_aead_xchacha20poly1305_ietf_encrypt(
            plaintext.encode("utf-8"), None, nonce, dek
        )
        data_payload = nonce + ct
        key_id_field = _b64url(wrapped.key_id.encode("utf-8"))
        wrapped_b64 = base64.b64encode(base64.b64decode(wrapped.ciphertext)).decode("ascii")
        return ":".join(
            [
                PREFIX_V2 + key_id_field,
                wrapped_b64,
                base64.b64encode(data_payload).decode("ascii"),
            ]
        )
    finally:
        # Python doesn't expose secure scrub; rely on GC.
        del dek


def _parse_v2(blob: str) -> tuple[EncryptedDek, bytes, bytes]:
    if not blob.startswith(PREFIX_V2):
        raise ValueError("parse_v2: missing hive:enc:v2: prefix")
    rest = blob[len(PREFIX_V2):]
    parts = rest.split(":")
    if len(parts) != 3:
        raise ValueError(f"parse_v2: expected 3 fields after prefix, got {len(parts)}")
    key_id_field, wrapped_b64, data_b64 = parts
    key_id = _from_b64url(key_id_field).decode("utf-8")
    data = base64.b64decode(data_b64)
    if len(data) < _NONCEBYTES + _ABYTES:
        raise ValueError("parse_v2: data payload too short")
    wrapped = EncryptedDek(ciphertext=wrapped_b64, key_id=key_id, algorithm="XCHACHA20")
    nonce, ct = data[:_NONCEBYTES], data[_NONCEBYTES:]
    return wrapped, nonce, ct


def decrypt_value(blob: str, *, kms: Optional[HiveKmsProvider] = None) -> str:
    if is_v2(blob):
        provider = kms or get_kms_provider()
        wrapped, nonce, ct = _parse_v2(blob)
        dek = provider.decrypt_dek(wrapped)
        try:
            plain = crypto_aead_xchacha20poly1305_ietf_decrypt(ct, None, nonce, dek)
            return plain.decode("utf-8")
        except CryptoError as e:
            raise ValueError(f"data decryption failed: {e}") from e
        finally:
            del dek
    if is_v1(blob):
        return decrypt_v1(blob)
    raise ValueError("decrypt_value: input is not a recognized hive envelope")


def key_id_of(blob: str) -> Optional[str]:
    if not is_v2(blob):
        return None
    try:
        wrapped, _, _ = _parse_v2(blob)
        return wrapped.key_id
    except ValueError:
        return None
