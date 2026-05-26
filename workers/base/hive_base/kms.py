"""Pluggable Key Encryption Key provider (Python side).

Mirror of `@hive/kms`. Same env vars, same wire-level semantics so a value
encrypted in TS can be decrypted in Python and vice-versa.

Selection: HIVE_KMS_PROVIDER env var, one of 'static' (default) | 'aws'.
"""
from __future__ import annotations

import base64
import binascii
import os
import secrets
from dataclasses import dataclass
from typing import Optional, Protocol, runtime_checkable

from nacl.bindings import (
    crypto_aead_xchacha20poly1305_ietf_encrypt,
    crypto_aead_xchacha20poly1305_ietf_decrypt,
    crypto_aead_xchacha20poly1305_ietf_KEYBYTES,
    crypto_aead_xchacha20poly1305_ietf_NPUBBYTES,
    crypto_aead_xchacha20poly1305_ietf_ABYTES,
)
from nacl.exceptions import CryptoError


@dataclass(frozen=True)
class EncryptedDek:
    ciphertext: str  # base64
    key_id: str
    algorithm: str  # 'AES_256' | 'XCHACHA20'


@runtime_checkable
class HiveKmsProvider(Protocol):
    def encrypt_dek(self, dek: bytes) -> EncryptedDek: ...
    def decrypt_dek(self, encrypted: EncryptedDek) -> bytes: ...
    def current_key_id(self) -> str: ...


# ---- StaticKeyKmsProvider ---------------------------------------------------

_KEYBYTES = crypto_aead_xchacha20poly1305_ietf_KEYBYTES
_NONCEBYTES = crypto_aead_xchacha20poly1305_ietf_NPUBBYTES
_ABYTES = crypto_aead_xchacha20poly1305_ietf_ABYTES


def _parse_hex_key(hex_value: str, where: str) -> bytes:
    trimmed = hex_value.strip()
    expected = _KEYBYTES * 2
    if len(trimmed) != expected:
        raise RuntimeError(
            f"{where} must be {expected} hex chars ({_KEYBYTES} bytes); got {len(trimmed)}"
        )
    try:
        return binascii.unhexlify(trimmed)
    except binascii.Error as e:
        raise RuntimeError(f"{where} is not valid hex: {e}") from e


def _parse_retired(spec: Optional[str]) -> dict[str, bytes]:
    out: dict[str, bytes] = {}
    if not spec:
        return out
    for entry in spec.split(","):
        trimmed = entry.strip()
        if not trimmed:
            continue
        if "=" not in trimmed:
            raise RuntimeError(
                f"HIVE_KMS_STATIC_RETIRED_KEYS entry '{trimmed}' is missing '=' between keyId and hex key"
            )
        key_id, hex_value = trimmed.split("=", 1)
        out[key_id.strip()] = _parse_hex_key(hex_value, f"retired key '{key_id}'")
    return out


class StaticKeyKmsProvider:
    """KEK = HIVE_SECRETS_KEY (32 raw bytes, 64 hex chars)."""

    def __init__(
        self,
        *,
        current_key: Optional[tuple[str, bytes]] = None,
        retired: Optional[dict[str, bytes]] = None,
    ) -> None:
        if current_key:
            self._current_key_id, self._current_key = current_key
        else:
            hex_value = os.environ.get("HIVE_SECRETS_KEY")
            if not hex_value:
                raise RuntimeError(
                    "HIVE_SECRETS_KEY is not set. The static KMS provider needs it to wrap DEKs."
                )
            self._current_key_id = os.environ.get("HIVE_KMS_STATIC_KEY_ID", "static:v1").strip()
            self._current_key = _parse_hex_key(hex_value, "HIVE_SECRETS_KEY")
        self._retired = retired or _parse_retired(os.environ.get("HIVE_KMS_STATIC_RETIRED_KEYS"))
        if self._current_key_id in self._retired:
            raise RuntimeError(
                f"HIVE_KMS_STATIC_RETIRED_KEYS lists '{self._current_key_id}' which is also the current key id"
            )

    def current_key_id(self) -> str:
        return self._current_key_id

    def encrypt_dek(self, dek: bytes) -> EncryptedDek:
        if len(dek) != _KEYBYTES:
            raise ValueError(f"encrypt_dek expected a {_KEYBYTES}-byte DEK, got {len(dek)}")
        nonce = secrets.token_bytes(_NONCEBYTES)
        ct = crypto_aead_xchacha20poly1305_ietf_encrypt(dek, None, nonce, self._current_key)
        payload = nonce + ct
        return EncryptedDek(
            ciphertext=base64.b64encode(payload).decode("ascii"),
            key_id=self._current_key_id,
            algorithm="XCHACHA20",
        )

    def decrypt_dek(self, encrypted: EncryptedDek) -> bytes:
        if encrypted.key_id == self._current_key_id:
            key = self._current_key
        else:
            key = self._retired.get(encrypted.key_id)
        if key is None:
            raise RuntimeError(
                f"static KMS provider has no key for keyId '{encrypted.key_id}'. "
                "Set HIVE_KMS_STATIC_RETIRED_KEYS to make older keys reachable during rotation."
            )
        try:
            payload = base64.b64decode(encrypted.ciphertext)
        except binascii.Error as e:
            raise ValueError(f"encrypted DEK is not valid base64: {e}") from e
        if len(payload) < _NONCEBYTES + _ABYTES:
            raise ValueError("encrypted DEK payload is too short to be valid")
        nonce, ct = payload[:_NONCEBYTES], payload[_NONCEBYTES:]
        try:
            dek = crypto_aead_xchacha20poly1305_ietf_decrypt(ct, None, nonce, key)
        except CryptoError as e:
            raise ValueError(f"decrypt_dek failed under keyId '{encrypted.key_id}': {e}") from e
        if len(dek) != _KEYBYTES:
            raise ValueError(f"unwrapped DEK has wrong length {len(dek)}, expected {_KEYBYTES}")
        return dek


# ---- AwsKmsProvider --------------------------------------------------------


class AwsKmsProvider:
    """KEK lives in AWS KMS. Requires boto3 + HIVE_KMS_KEY_ID env var."""

    def __init__(self, *, key_id: Optional[str] = None, client: object = None) -> None:
        self._key_id = key_id or os.environ.get("HIVE_KMS_KEY_ID")
        if not self._key_id:
            raise RuntimeError("HIVE_KMS_KEY_ID is required when HIVE_KMS_PROVIDER=aws")
        if client is None:
            try:
                import boto3  # local import: only AWS path pulls boto3 in
            except ImportError as e:
                raise RuntimeError(
                    "AwsKmsProvider requires boto3. Install with `pip install boto3`."
                ) from e
            client = boto3.client("kms", region_name=os.environ.get("AWS_REGION"))
        self._client = client

    def current_key_id(self) -> str:
        return self._key_id  # type: ignore[return-value]

    def encrypt_dek(self, dek: bytes) -> EncryptedDek:
        res = self._client.encrypt(KeyId=self._key_id, Plaintext=dek)  # type: ignore[attr-defined]
        return EncryptedDek(
            ciphertext=base64.b64encode(res["CiphertextBlob"]).decode("ascii"),
            key_id=res.get("KeyId", self._key_id),
            algorithm="AES_256",
        )

    def decrypt_dek(self, encrypted: EncryptedDek) -> bytes:
        res = self._client.decrypt(  # type: ignore[attr-defined]
            CiphertextBlob=base64.b64decode(encrypted.ciphertext),
            KeyId=encrypted.key_id,
        )
        return res["Plaintext"]


# ---- Selection -------------------------------------------------------------

_CACHED: Optional[HiveKmsProvider] = None


def resolve_provider_name() -> str:
    raw = os.environ.get("HIVE_KMS_PROVIDER", "static").strip().lower()
    if raw in ("", "static"):
        return "static"
    if raw == "aws":
        return "aws"
    raise RuntimeError(f"Unknown HIVE_KMS_PROVIDER='{raw}'. Expected 'static' or 'aws'.")


def build_kms_provider() -> HiveKmsProvider:
    name = resolve_provider_name()
    if name == "aws":
        return AwsKmsProvider()
    return StaticKeyKmsProvider()


def get_kms_provider() -> HiveKmsProvider:
    global _CACHED
    if _CACHED is None:
        _CACHED = build_kms_provider()
    return _CACHED


def __reset_kms_provider_for_tests() -> None:
    global _CACHED
    _CACHED = None
