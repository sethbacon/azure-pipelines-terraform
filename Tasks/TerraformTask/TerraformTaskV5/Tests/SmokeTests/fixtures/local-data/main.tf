// Smoke-harness fixture (#719): backend "local" + the built-in terraform_data
// resource (Terraform core >= 1.4, no external provider) so `terraform init`
// is fully offline -- no registry.terraform.io dependency in CI. Deliberately
// declares NO cloud provider block, so the ARM_*/AWS_*/GOOGLE_*/etc.
// environment variables the task's handleProvider() writes are simply never
// consumed by terraform -- this is what lets the harness exercise the task's
// real argv-build + real-terraform-exec path with zero cloud calls.
//
// Do NOT use null_resource/random -- both require a provider download.

terraform {
  backend "local" {}
}

variable "env" {
  type    = string
  default = "staging"
}

resource "terraform_data" "example" {
  input = var.env
}

output "env_output" {
  value = var.env
}
