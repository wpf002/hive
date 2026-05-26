variable "env_label"      { type = string }
variable "vpc_id"         { type = string }
variable "subnet_ids"     { type = list(string) }
variable "vpc_cidr_block" { type = string }
variable "node_type"      { type = string }

resource "aws_elasticache_subnet_group" "this" {
  name       = "hive-${var.env_label}"
  subnet_ids = var.subnet_ids
}

resource "aws_security_group" "redis" {
  name        = "hive-${var.env_label}-redis"
  description = "Redis 6379 from inside the VPC"
  vpc_id      = var.vpc_id
  ingress {
    from_port   = 6379
    to_port     = 6379
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr_block]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_elasticache_replication_group" "this" {
  replication_group_id       = "hive-${var.env_label}"
  description                = "Hive Redis"
  engine                     = "redis"
  engine_version             = "7.1"
  node_type                  = var.node_type
  num_cache_clusters         = 1
  subnet_group_name          = aws_elasticache_subnet_group.this.name
  security_group_ids         = [aws_security_group.redis.id]
  port                       = 6379
  transit_encryption_enabled = true
  at_rest_encryption_enabled = true
}

output "connection_url" {
  value     = "rediss://${aws_elasticache_replication_group.this.primary_endpoint_address}:6379"
  sensitive = true
}
