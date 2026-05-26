variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "env_label" {
  type        = string
  description = "Sets HIVE_ENV_LABEL and tags on every resource. 'staging' or 'production'."
}

variable "prod" {
  type        = bool
  default     = false
  description = "Enable production-grade defaults: multi-AZ RDS, larger ASG ceilings."
}

variable "vpc_cidr" {
  type    = string
  default = "10.40.0.0/16"
}

variable "artifact_bucket" {
  type        = string
  description = "S3 bucket name for artifact storage. Must be globally unique."
}

variable "rds_instance_class" {
  type    = string
  default = "db.t4g.small"
}

variable "redis_node_type" {
  type    = string
  default = "cache.t4g.small"
}

variable "certificate_arn" {
  type        = string
  description = "ACM cert ARN for the ALB. Must be in the same region."
}

variable "api_image" {
  type        = string
  description = "ECR image URI for the API service."
}

variable "ui_image" {
  type        = string
  description = "ECR image URI for the UI service."
}

variable "worker_image_prefix" {
  type        = string
  description = "ECR repo prefix for worker images, e.g. 'ACCT.dkr.ecr.us-east-1.amazonaws.com/hive-worker'. Per-pool images get suffixed with -<pool>."
}
