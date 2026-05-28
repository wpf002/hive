"""Shared settings loaded from .env for every Python worker."""
from __future__ import annotations
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    REDIS_URL: str = Field(...)
    DATABASE_URL: str = Field(...)
    WORKER_AUTH_TOKEN: str = Field(...)
    API_BASE_URL: str = Field(default="http://localhost:4000")
    LOG_LEVEL: str = Field(default="info")
    NODE_ENV: str = Field(default="development")
    # Phase 5b: worker self-declared location for affinity-based routing.
    HIVE_WORKER_REGION: str = Field(default="local")
    HIVE_WORKER_ZONE: str = Field(default="default")
    # Phase 6c: optional /healthz HTTP port. 0 = disabled (workers are stream
    # consumers, not HTTP services). Set to expose heartbeat + redis health.
    HIVE_WORKER_HEALTHZ_PORT: int = Field(default=0)

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=True,
    )


def load_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
