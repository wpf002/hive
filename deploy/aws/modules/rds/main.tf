variable "env_label"      { type = string }
variable "vpc_id"         { type = string }
variable "subnet_ids"     { type = list(string) }
variable "vpc_cidr_block" { type = string }
variable "multi_az"       { type = bool, default = false }
variable "instance_class" { type = string }

resource "random_password" "db" {
  length  = 32
  special = false
}

resource "aws_db_subnet_group" "this" {
  name       = "hive-${var.env_label}"
  subnet_ids = var.subnet_ids
}

resource "aws_security_group" "rds" {
  name        = "hive-${var.env_label}-rds"
  description = "Postgres 5432 from inside the VPC"
  vpc_id      = var.vpc_id

  ingress {
    from_port   = 5432
    to_port     = 5432
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

resource "aws_db_instance" "this" {
  identifier              = "hive-${var.env_label}"
  engine                  = "postgres"
  engine_version          = "16"
  instance_class          = var.instance_class
  allocated_storage       = 20
  max_allocated_storage   = 200
  storage_encrypted       = true
  multi_az                = var.multi_az
  username                = "hive"
  password                = random_password.db.result
  db_name                 = "hive"
  db_subnet_group_name    = aws_db_subnet_group.this.name
  vpc_security_group_ids  = [aws_security_group.rds.id]
  publicly_accessible     = false
  skip_final_snapshot     = !var.multi_az
  deletion_protection     = var.multi_az
  backup_retention_period = var.multi_az ? 14 : 1
  tags = { Name = "hive-${var.env_label}-pg" }
}

output "connection_url" {
  value     = "postgresql://${aws_db_instance.this.username}:${random_password.db.result}@${aws_db_instance.this.endpoint}/${aws_db_instance.this.db_name}?sslmode=require"
  sensitive = true
}
