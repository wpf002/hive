# Apply with:
#   terraform apply -var-file=staging.tfvars
aws_region          = "us-east-1"
env_label           = "staging"
prod                = false
artifact_bucket     = "hive-artifacts-staging"
rds_instance_class  = "db.t4g.small"
redis_node_type     = "cache.t4g.small"
certificate_arn     = "arn:aws:acm:us-east-1:000000000000:certificate/REPLACE-ME"
api_image           = "000000000000.dkr.ecr.us-east-1.amazonaws.com/hive-api:latest"
ui_image            = "000000000000.dkr.ecr.us-east-1.amazonaws.com/hive-ui:latest"
worker_image_prefix = "000000000000.dkr.ecr.us-east-1.amazonaws.com/hive-worker"
