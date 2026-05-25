"""Hive field-level secret encryption (Python side).

Same wire format as the TypeScript `@hive/crypto` package:

    hive:enc:v1:<base64(nonce(24) || ciphertext+tag(16))>

XChaCha20-Poly1305 AEAD with a single 32-byte master key loaded from the
HIVE_SECRETS_KEY env var (hex). A worker that needs to decrypt secrets must
import this module — it crashes immediately if the env var is missing or the
wrong length so misconfiguration cannot silently fall through to plaintext.
"""
from __future__ import annotations
import base64
import binascii
import os
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

PREFIX = "hive:enc:v1:"

_KEY: Optional[bytes] = None


def _load_key() -> bytes:
    hex_value = os.environ.get("HIVE_SECRETS_KEY")
    if not hex_value:
        raise RuntimeError(
            "HIVE_SECRETS_KEY is not set. Generate one with `openssl rand -hex 32` "
            "and add it to .env. Field-level secret encryption refuses to operate without it."
        )
    trimmed = hex_value.strip()
    expected_hex = crypto_aead_xchacha20poly1305_ietf_KEYBYTES * 2
    if len(trimmed) != expected_hex:
        raise RuntimeError(
            f"HIVE_SECRETS_KEY must be {expected_hex} hex chars "
            f"({crypto_aead_xchacha20poly1305_ietf_KEYBYTES} bytes); got {len(trimmed)}."
        )
    try:
        return binascii.unhexlify(trimmed)
    except binascii.Error as e:
        raise RuntimeError(f"HIVE_SECRETS_KEY is not valid hex: {e}") from e


def _key() -> bytes:
    global _KEY
    if _KEY is None:
        _KEY = _load_key()
    return _KEY


def is_encrypted(value: object) -> bool:
    """True if `value` is a string carrying the canonical hive:enc:v1: prefix."""
    return isinstance(value, str) and value.startswith(PREFIX)


def encrypt(plaintext: str) -> str:
    """Encrypt UTF-8 text. Returns the prefixed wire format."""
    if not isinstance(plaintext, str):
        raise TypeError("encrypt() expects a str")
    k = _key()
    nonce = secrets.token_bytes(crypto_aead_xchacha20poly1305_ietf_NPUBBYTES)
    ciphertext = crypto_aead_xchacha20poly1305_ietf_encrypt(
        plaintext.encode("utf-8"), None, nonce, k
    )
    payload = nonce + ciphertext
    return PREFIX + base64.b64encode(payload).decode("ascii")


def decrypt(value: str) -> str:
    """Decrypt a hive:enc:v1:… string. Raises on tamper / wrong key / bad format."""
    if not is_encrypted(value):
        raise ValueError("decrypt() called on a value missing the hive:enc:v1: prefix")
    k = _key()
    try:
        payload = base64.b64decode(value[len(PREFIX):], validate=False)
    except binascii.Error as e:
        raise ValueError(f"decrypt() received malformed base64: {e}") from e
    nbytes = crypto_aead_xchacha20poly1305_ietf_NPUBBYTES
    abytes = crypto_aead_xchacha20poly1305_ietf_ABYTES
    if len(payload) < nbytes + abytes:
        raise ValueError("decrypt() payload too short — corrupted")
    nonce, ciphertext = payload[:nbytes], payload[nbytes:]
    try:
        msg = crypto_aead_xchacha20poly1305_ietf_decrypt(ciphertext, None, nonce, k)
    except CryptoError as e:
        raise ValueError(f"decryption failed: {e}") from e
    return msg.decode("utf-8")


def assert_key_loaded() -> None:
    """Crash early at startup if the env is misconfigured."""
    _key()
