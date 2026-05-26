variable "env_label" { type = string }

resource "aws_kms_key" "envelope" {
  description             = "Hive ${var.env_label} envelope-encryption KEK"
  deletion_window_in_days = 30
  enable_key_rotation     = true  # AWS-managed annual rotation; HIVE_KMS_KEY_ID arn stays the same.
  tags = { Name = "hive-${var.env_label}-kek" }
}

resource "aws_kms_alias" "envelope" {
  name          = "alias/hive-${var.env_label}-kek"
  target_key_id = aws_kms_key.envelope.key_id
}

output "key_id"  { value = aws_kms_key.envelope.id }
output "key_arn" { value = aws_kms_key.envelope.arn }
output "alias"   { value = aws_kms_alias.envelope.name }
