.PHONY: help install dev build clean docker-up docker-down db-migrate workers-install workers-dev

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
