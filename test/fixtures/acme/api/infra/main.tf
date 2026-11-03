module "vpc" {
  source = "git::https://github.com/acme/infra-modules.git//vpc?ref=v1.3.0"
  cidr   = "10.0.0.0/16"
}

# module "old" {
#   source = "git::https://github.com/acme/legacy.git"
# }

module "label" {
  source  = "cloudposse/label/null"
  version = "0.25.0"
  name    = "api"
}
