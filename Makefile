.PHONY: help install dev build clean docker-up docker-down db-migrate workers-install workers-dev rotate-secrets-key minio-init

help:
	@echo "Hive — Distributed bot orchestration"
	@echo ""
	@echo "Setup:"
	@echo "  make install          Install all dependencies (TS + Python)"
	@echo "  make docker-up        Start Postgres + Redis"
	@echo "  make db-migrate       Run database migrations"
	@echo ""
	@echo "Development:"
	@echo "  make dev              Run control plane (API + UI + dispatcher)"
	@echo "  make workers-dev      Run all worker pools"
	@echo "  make build            Build all TS packages"
	@echo ""
	@echo "Ops:"
	@echo "  make docker-down      Stop infrastructure"
	@echo "  make clean            Remove build artifacts"

install:
	pnpm install
	bash scripts/install-workers.sh

dev:
	pnpm dev

build:
	pnpm build

docker-up:
	docker compose -f infra/docker/docker-compose.yml up -d

docker-down:
	docker compose -f infra/docker/docker-compose.yml down

db-migrate:
	pnpm db:migrate

workers-install:
	bash scripts/install-workers.sh

workers-dev:
	bash scripts/dev-workers.sh

clean:
	rm -rf node_modules apps/*/node_modules apps/*/.next apps/*/dist
	rm -rf packages/*/node_modules packages/*/dist
	find workers -type d -name __pycache__ -exec rm -rf {} +
	find workers -type d -name .venv -exec rm -rf {} +

rotate-secrets-key:
	@echo "Phase 5a — online rotation via envelope encryption."
	@echo "  1. Bring up the new KEK (set HIVE_SECRETS_KEY to the new value;"
	@echo "     for static provider also set HIVE_KMS_STATIC_KEY_ID and put"
	@echo "     HIVE_KMS_STATIC_RETIRED_KEYS='<oldKeyId>=<oldHex>' so the"
	@echo "     sweep can still unwrap old DEKs)."
	@echo "  2. pnpm --filter @hive/api kms:rotate"
	@echo "     (For AWS: pnpm --filter @hive/api kms:rotate --new-key-id <new ARN>)"

# Create the local MinIO bucket so S3-backed artifact dev mode works. Idempotent.
minio-init:
	@docker run --rm --network host \
		-e MC_HOST_local=http://hive:hivehive@localhost:9000 \
		minio/mc:latest mb --ignore-existing local/hive-artifacts
	@echo "MinIO bucket 'hive-artifacts' is ready at http://localhost:9001"
