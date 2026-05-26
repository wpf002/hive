variable "env_label"         { type = string }
variable "vpc_id"            { type = string }
variable "public_subnet_ids" { type = list(string) }
variable "certificate_arn"   { type = string }
variable "api_target_group_arn" { type = string }
variable "ui_target_group_arn"  { type = string }

resource "aws_security_group" "alb" {
  name        = "hive-${var.env_label}-alb"
  description = "ALB ingress 443 + egress to services"
  vpc_id      = var.vpc_id
  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_lb" "this" {
  name               = "hive-${var.env_label}"
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = var.public_subnet_ids
}

# Redirect plain HTTP to HTTPS.
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn
  # Default to the UI; API takes /api/* via a routing rule below.
  default_action {
    type             = "forward"
    target_group_arn = var.ui_target_group_arn
  }
}

resource "aws_lb_listener_rule" "api" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 100
  action {
    type             = "forward"
    target_group_arn = var.api_target_group_arn
  }
  condition {
    path_pattern { values = ["/api/*", "/healthz"] }
  }
}

output "api_url" { value = "https://${aws_lb.this.dns_name}/api" }
output "ui_url"  { value = "https://${aws_lb.this.dns_name}/" }
output "dns_name" { value = aws_lb.this.dns_name }
