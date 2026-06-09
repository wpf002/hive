# Deploying Hive to AWS

This is the production target. Everything lives in `deploy/aws/` as Terraform
modules; running `terraform apply` builds the full stack — VPC, RDS, Redis,
S3, KMS, ECS Fargate, ALB, CloudWatch — in one shot.

## Prerequisites

- An AWS account with administrative credentials configured locally
  (`aws configure` or `AWS_*` env vars).
- An ACM certificate for your domain in the deploy region.
- An ECR repository per image (we suggest `hive-api`, `hive-ui`, and
  `hive-worker-<pool>` per pool).
- `terraform >= 1.6` and `docker buildx` installed.

## Build + push images

```bash
ACCT=000000000000
REGION=us-east-1
REPO=$ACCT.dkr.ecr.$REGION.amazonaws.com

# Login to ECR
aws ecr get-login-password --region $REGION \
  | docker login --username AWS --password-stdin $REPO

# Build + push the API
docker buildx build --platform linux/amd64,linux/arm64 \
  -f deploy/fly/Dockerfile.ts-app \
  --build-arg SERVICE=apps/api \
  -t $REPO/hive-api:latest --push .

# UI
docker buildx build --platform linux/amd64,linux/arm64 \
  -f deploy/fly/Dockerfile.ts-app \
  --build-arg SERVICE=apps/ui \
  -t $REPO/hive-ui:latest --push .

# Workers (loop over the pool set)
  DOCKERFILE=deploy/fly/Dockerfile.python-worker
  [ "$pool" = "browser" ] && DOCKERFILE=workers/browser/Dockerfile
  docker buildx build --platform linux/amd64 \
    -f "$DOCKERFILE" --build-arg WORKER=$pool \
    -t "$REPO/hive-worker-${pool//_/-}:latest" --push .
done

for pool in ai_agent trading mcp_host; do
  TS_NAME="${pool//_/-}"
  docker buildx build --platform linux/amd64,linux/arm64 \
    -f deploy/fly/Dockerfile.ts-app \
    --build-arg SERVICE=workers/$pool \
    -t "$REPO/hive-worker-${TS_NAME}:latest" --push .
done
```

## Terraform apply

```bash
cd deploy/aws

# Bring up staging first.
terraform init
terraform plan  -var-file=staging.tfvars
terraform apply -var-file=staging.tfvars

# Outputs include the ALB DNS name + bucket + KMS ARN. Configure DNS:
#   <alb-dns> CNAME at hive-staging.your-domain.com

# Production once staging is healthy.
terraform workspace new prod   # optional — segregate state
terraform apply -var-file=production.tfvars
```

## Initial migration + seed

Terraform creates RDS + ECS but doesn't run Prisma migrations. Run them
through a one-shot ECS task or from a VPN-attached bastion:

```bash
# From within the VPC (bastion or ECS exec)
DATABASE_URL='postgresql://...?sslmode=require' pnpm --filter @hive/db migrate deploy
DATABASE_URL='postgresql://...?sslmode=require' pnpm --filter @hive/api seed
DATABASE_URL='postgresql://...?sslmode=require' pnpm --filter @hive/api upgrade-envelope-v1-to-v2
```

## KMS integration

Unlike Fly, AWS gets real KMS:

- The Terraform `kms` module creates a CMK with annual rotation enabled.
- The ECS task definitions set `HIVE_KMS_PROVIDER=aws` and pass
  `HIVE_KMS_KEY_ID` to the CMK ARN.
- The task IAM role has `kms:Encrypt` + `kms:Decrypt` scoped to that ARN.
- Cost: ~$1/month per CMK + ~$0.03/10k requests. Envelope encryption keeps
  request volume low (one KMS call per write, none per cached read).

To rotate manually via the Hive CLI rather than annual auto-rotation:

```bash
# Inside the API ECS task or a bastion with kms:* perms
pnpm --filter @hive/api kms:rotate --new-key-id arn:aws:kms:us-east-1:...:key/new-uuid
```

## Scaling

- API + dispatcher are pinned to 1 (single Redis consumer group on
  `hive:dispatch`). Don't scale them.
- Worker services auto-scale 1..5 on 60% target CPU (see `ecs/main.tf`).
- Bump `max_capacity` in the `aws_appautoscaling_target` resources if your
  fleet needs more headroom.

## Observability

- CloudWatch Logs group `/hive/<env_label>` collects every container's stdout.
- ALB access logs are not enabled by default — add an `aws_lb_logs` bucket if
  you want them.

## Tear-down

```bash
cd deploy/aws
terraform destroy -var-file=staging.tfvars
```

Destroy refuses to drop RDS in production unless you also set
`deletion_protection = false` and re-apply first.

## Known friction points

- The very first `terraform apply` takes ~15 minutes (RDS + ElastiCache are
  the slow steps).
- Multi-arch image builds add 2-3 minutes per service. Single-arch (linux/amd64)
  builds are fine on AWS Graviton too if you build natively on ARM.
- Browser worker image is ~500 MB. ECR's pull-time matters; set
  `essential = true` only and let the worker self-heal.
