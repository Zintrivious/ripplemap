module "vpc" {
  source = "github.com/acme/infra-modules//vpc?ref=v1.1.0"
  cidr   = "10.1.0.0/16"
}
