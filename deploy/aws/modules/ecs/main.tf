# ECS Fargate cluster + per-service task definitions. Workers run as plain
# services with auto-scaling target tracking on CPU. The API + UI sit behind
# the ALB target groups created here and wired up in the alb module.

variable "env_label"          { type = string }
variable "vpc_id"             { type = string }
variable "private_subnet_ids" { type = list(string) }
variable "public_subnet_ids"  { type = list(string) }

variable "database_url"   { type = string, sensitive = true }
variable "redis_url"      { type = string, sensitive = true }
variable "artifact_bucket" { type = string }
variable "kms_key_arn"    { type = string }
variable "log_group_name" { type = string }

variable "api_image"    { type = string }
variable "ui_image"     { type = string }
variable "worker_image" { type = string }

resource "aws_ecs_cluster" "this" {
  name = "hive-${var.env_label}"
}

# ---------- IAM ----------

resource "aws_iam_role" "task_exec" {
  name = "hive-${var.env_label}-task-exec"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "task_exec_basic" {
  role       = aws_iam_role.task_exec.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role" "task" {
  name = "hive-${var.env_label}-task"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "task_app" {
  name = "hive-${var.env_label}-task-app"
  role = aws_iam_role.task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"]
        Resource = [
          "arn:aws:s3:::${var.artifact_bucket}",
          "arn:aws:s3:::${var.artifact_bucket}/*",
        ]
      },
      {
        Effect = "Allow"
        Action = ["kms:Encrypt", "kms:Decrypt", "kms:DescribeKey"]
        Resource = [var.kms_key_arn]
      },
    ]
  })
}

# ---------- Security groups ----------

resource "aws_security_group" "services" {
  name        = "hive-${var.env_label}-svc"
  description = "ECS service network traffic"
  vpc_id      = var.vpc_id
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# ---------- API service ----------

resource "aws_ecs_task_definition" "api" {
  family                   = "hive-${var.env_label}-api"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.task_exec.arn
  task_role_arn            = aws_iam_role.task.arn
  container_definitions = jsonencode([{
    name      = "api"
    image     = var.api_image
    essential = true
    portMappings = [{ containerPort = 4000, protocol = "tcp" }]
    environment = [
      { name = "NODE_ENV", value = "production" },
      { name = "HIVE_ENV_LABEL", value = var.env_label },
      { name = "HIVE_KMS_PROVIDER", value = "aws" },
      { name = "HIVE_KMS_KEY_ID", value = var.kms_key_arn },
      { name = "HIVE_STORAGE_PROVIDER", value = "s3" },
      { name = "HIVE_ARTIFACT_S3_BUCKET", value = var.artifact_bucket },
    ]
    secrets = [
      { name = "DATABASE_URL", valueFrom = aws_ssm_parameter.database_url.arn },
      { name = "REDIS_URL",    valueFrom = aws_ssm_parameter.redis_url.arn },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = var.log_group_name
        awslogs-region        = data.aws_region.current.name
        awslogs-stream-prefix = "api"
      }
    }
  }])
}

resource "aws_ecs_service" "api" {
  name            = "hive-${var.env_label}-api"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = 1
  launch_type     = "FARGATE"
  network_configuration {
    subnets         = var.private_subnet_ids
    security_groups = [aws_security_group.services.id]
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 4000
  }
  depends_on = [aws_lb_target_group.api]
}

# Placeholder target groups — alb module owns the ALB but task definitions
# need to reference TGs by ARN. We declare them here and pass the ARNs up so
# the alb module attaches them to a listener.

resource "aws_lb_target_group" "api" {
  name        = "hive-${var.env_label}-api"
  port        = 4000
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = var.vpc_id
  health_check {
    path                = "/healthz"
    matcher             = "200-299"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 15
    timeout             = 5
  }
}

resource "aws_lb_target_group" "ui" {
  name        = "hive-${var.env_label}-ui"
  port        = 3001
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = var.vpc_id
  health_check {
    path                = "/"
    matcher             = "200-399"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 30
    timeout             = 10
  }
}


locals {
  worker_pools = [
    "scraper", "monitor", "browser", "ai-agent", "trading",
  ]
}

resource "aws_ecs_task_definition" "worker" {
  for_each                 = toset(local.worker_pools)
  family                   = "hive-${var.env_label}-worker-${each.value}"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "512"
  memory                   = each.value == "browser" ? "2048" : "1024"
  execution_role_arn       = aws_iam_role.task_exec.arn
  task_role_arn            = aws_iam_role.task.arn
  container_definitions = jsonencode([{
    name      = "worker"
    image     = "${var.worker_image}-${each.value}:latest"
    essential = true
    environment = [
      { name = "NODE_ENV", value = "production" },
      { name = "HIVE_ENV_LABEL", value = var.env_label },
      { name = "HIVE_KMS_PROVIDER", value = "aws" },
      { name = "HIVE_KMS_KEY_ID", value = var.kms_key_arn },
      { name = "HIVE_STORAGE_PROVIDER", value = "s3" },
      { name = "HIVE_ARTIFACT_S3_BUCKET", value = var.artifact_bucket },
      { name = "HIVE_WORKER_REGION", value = "aws-${data.aws_region.current.name}" },
      { name = "HIVE_WORKER_ZONE", value = "default" },
    ]
    secrets = [
      { name = "DATABASE_URL", valueFrom = aws_ssm_parameter.database_url.arn },
      { name = "REDIS_URL",    valueFrom = aws_ssm_parameter.redis_url.arn },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = var.log_group_name
        awslogs-region        = data.aws_region.current.name
        awslogs-stream-prefix = "worker-${each.value}"
      }
    }
  }])
}

resource "aws_ecs_service" "worker" {
  for_each        = toset(local.worker_pools)
  name            = "hive-${var.env_label}-worker-${each.value}"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.worker[each.key].arn
  desired_count   = 1
  launch_type     = "FARGATE"
  network_configuration {
    subnets         = var.private_subnet_ids
    security_groups = [aws_security_group.services.id]
  }
}

# Auto-scale every worker service to 1..5 on 60% target CPU.
resource "aws_appautoscaling_target" "worker" {
  for_each           = toset(local.worker_pools)
  max_capacity       = 5
  min_capacity       = 1
  resource_id        = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.worker[each.key].name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "worker_cpu" {
  for_each           = toset(local.worker_pools)
  name               = "hive-${var.env_label}-worker-${each.value}-cpu"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.worker[each.key].resource_id
  scalable_dimension = aws_appautoscaling_target.worker[each.key].scalable_dimension
  service_namespace  = aws_appautoscaling_target.worker[each.key].service_namespace
  target_tracking_scaling_policy_configuration {
    target_value       = 60
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}

# ---------- SSM parameters for secrets ----------

resource "aws_ssm_parameter" "database_url" {
  name  = "/hive/${var.env_label}/DATABASE_URL"
  type  = "SecureString"
  value = var.database_url
}

resource "aws_ssm_parameter" "redis_url" {
  name  = "/hive/${var.env_label}/REDIS_URL"
  type  = "SecureString"
  value = var.redis_url
}

data "aws_region" "current" {}

output "api_target_group_arn" { value = aws_lb_target_group.api.arn }
output "ui_target_group_arn"  { value = aws_lb_target_group.ui.arn }
output "cluster_name"         { value = aws_ecs_cluster.this.name }
