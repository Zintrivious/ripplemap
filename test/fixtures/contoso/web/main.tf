module "vpc" {
  source = "git::git@ssh.dev.azure.com:v3/contoso/Platform/terraform-modules//vpc?ref=v1.1.0"
  cidr   = "10.1.0.0/16"
}
