module "vpc" {
  source = "git::https://contoso@dev.azure.com/contoso/Platform/_git/terraform-modules//vpc?ref=v1.2.0"
  cidr   = "10.0.0.0/16"
}
