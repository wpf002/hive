variable "env_label" { type = string }
variable "cidr_block" { type = string }
variable "az_count"   { type = number, default = 2 }

data "aws_availability_zones" "available" { state = "available" }

resource "aws_vpc" "this" {
  cidr_block           = var.cidr_block
  enable_dns_hostnames = true
  tags = { Name = "hive-${var.env_label}" }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = "hive-${var.env_label}-igw" }
}

resource "aws_subnet" "public" {
  count                   = var.az_count
  vpc_id                  = aws_vpc.this.id
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  cidr_block              = cidrsubnet(var.cidr_block, 4, count.index)
  map_public_ip_on_launch = true
  tags = { Name = "hive-${var.env_label}-public-${count.index}", Tier = "public" }
}

resource "aws_subnet" "private" {
  count             = var.az_count
  vpc_id            = aws_vpc.this.id
  availability_zone = data.aws_availability_zones.available.names[count.index]
  cidr_block        = cidrsubnet(var.cidr_block, 4, count.index + var.az_count)
  tags = { Name = "hive-${var.env_label}-private-${count.index}", Tier = "private" }
}

resource "aws_eip" "nat" {
  count  = var.az_count
  domain = "vpc"
  tags   = { Name = "hive-${var.env_label}-nat-${count.index}" }
}

resource "aws_nat_gateway" "this" {
  count         = var.az_count
  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id
  tags          = { Name = "hive-${var.env_label}-nat-${count.index}" }
  depends_on    = [aws_internet_gateway.this]
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  route { cidr_block = "0.0.0.0/0", gateway_id = aws_internet_gateway.this.id }
  tags   = { Name = "hive-${var.env_label}-public-rt" }
}

resource "aws_route_table" "private" {
  count  = var.az_count
  vpc_id = aws_vpc.this.id
  route  { cidr_block = "0.0.0.0/0", nat_gateway_id = aws_nat_gateway.this[count.index].id }
  tags   = { Name = "hive-${var.env_label}-private-rt-${count.index}" }
}

resource "aws_route_table_association" "public" {
  count          = var.az_count
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "private" {
  count          = var.az_count
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[count.index].id
}

output "vpc_id"             { value = aws_vpc.this.id }
output "public_subnet_ids"  { value = aws_subnet.public[*].id }
output "private_subnet_ids" { value = aws_subnet.private[*].id }
