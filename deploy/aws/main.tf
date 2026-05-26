# Hive on AWS — Terraform root. Production target.
#
# Apply with:
#   cd deploy/aws
#   terraform init
#   terraform plan -var-file=staging.tfvars
#   terraform apply -var-file=staging.tfvars
#
# Modules build:
#   - VPC + 2 AZ subnets + security groups (vpc/)
#   - RDS Postgres (rds/), single-AZ for dev, multi-AZ when prod=true
#   - ElastiCache Redis cluster (elasticache/)
#   - S3 bucket for artifacts (s3/)
#   - KMS key with IAM access for API + worker roles (kms/)
#   - ECS Fargate cluster + task definitions per service (ecs/)
#   - ALB fronting the API and UI tasks (alb/)
#   - CloudWatch log groups (logs/)
#
# The hard work is in the modules; this file just wires them.

terraform {
  required_version = ">= 1.6.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.50" }
  }
  # Remote state recommended for any environment that survives a laptop.
  # backend "s3" {
  #   bucket = "hive-terraform-state"
  #   key    = "hive/main.tfstate"
  #   region = "us-east-1"
  # }
}

provider "aws" {
  region = var.aws_region
  default_tags {
    tags = {
      Project = "hive"
      Env     = var.env_label
      Managed = "terraform"
    }
  }
}

module "vpc" {
  source        = "./modules/vpc"
  env_label     = var.env_label
  cidr_block    = var.vpc_cidr
  az_count      = 2
}

module "kms" {
  source    = "./modules/kms"
  env_label = var.env_label
}

module "s3" {
  source    = "./modules/s3"
  env_label = var.env_label
  bucket    = var.artifact_bucket
}

module "rds" {
  source         = "./modules/rds"
  env_label      = var.env_label
  vpc_id         = module.vpc.vpc_id
  subnet_ids     = module.vpc.private_subnet_ids
  vpc_cidr_block = var.vpc_cidr
  multi_az       = var.prod
  instance_class = var.rds_instance_class
}

module "elasticache" {
  source         = "./modules/elasticache"
  env_label      = var.env_label
  vpc_id         = module.vpc.vpc_id
  subnet_ids     = module.vpc.private_subnet_ids
  vpc_cidr_block = var.vpc_cidr
  node_type      = var.redis_node_type
}

module "logs" {
  source    = "./modules/logs"
  env_label = var.env_label
}

module "ecs" {
  source    = "./modules/ecs"
  env_label = var.env_label

  vpc_id              = module.vpc.vpc_id
  private_subnet_ids  = module.vpc.private_subnet_ids
  public_subnet_ids   = module.vpc.public_subnet_ids

  database_url    = module.rds.connection_url
  redis_url       = module.elasticache.connection_url
  artifact_bucket = module.s3.bucket_name
  kms_key_arn     = module.kms.key_arn
  log_group_name  = module.logs.log_group_name

  api_image    = var.api_image
  ui_image     = var.ui_image
  worker_image = var.worker_image_prefix
}

module "alb" {
  source    = "./modules/alb"
  env_label = var.env_label

  vpc_id            = module.vpc.vpc_id
  public_subnet_ids = module.vpc.public_subnet_ids
  certificate_arn   = var.certificate_arn

  api_target_group_arn = module.ecs.api_target_group_arn
  ui_target_group_arn  = module.ecs.ui_target_group_arn
}

output "api_url" { value = module.alb.api_url }
output "ui_url"  { value = module.alb.ui_url }
output "artifact_bucket" { value = module.s3.bucket_name }
output "kms_key_arn"     { value = module.kms.key_arn }
