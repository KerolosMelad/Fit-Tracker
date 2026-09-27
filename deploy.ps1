# Deploy KeJu Fit Tracker to Cloudflare Pages via API token.
#
# Setup (once):
#   1. Cloudflare Dashboard → My Profile → API Tokens → Create Token
#      Use "Edit Cloudflare Pages" or custom: Account → Cloudflare Pages → Edit
#   2. Copy token into .env.local in this folder (gitignored):
#        CLOUDFLARE_API_TOKEN=your_token_here
#        CLOUDFLARE_ACCOUNT_ID=9e0c7606399f68e3c80d8a5c4e4d5532
#   3. Run:
#        powershell -ExecutionPolicy Bypass -File .\deploy.ps1

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$envFile = Join-Path $PSScriptRoot ".env.local"
if (Test-Path $envFile) {
  Get-Content $envFile | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#")) { return }
    $parts = $line -split "=", 2
    if ($parts.Count -ne 2) { return }
    $name = $parts[0].Trim()
    $value = $parts[1].Trim().Trim("'").Trim('"')
    if ($name) { Set-Item -Path "Env:$name" -Value $value }
  }
}

if (-not $env:CLOUDFLARE_API_TOKEN) {
  Write-Error "CLOUDFLARE_API_TOKEN missing. Create .env.local with your token (see script header)."
}
if (-not $env:CLOUDFLARE_ACCOUNT_ID) {
  $env:CLOUDFLARE_ACCOUNT_ID = "9e0c7606399f68e3c80d8a5c4e4d5532"
}

Write-Host "Deploying cut-tracker to Cloudflare Pages (token auth)..."
npx --yes wrangler@4 pages deploy . --project-name cut-tracker --commit-dirty=true --branch main

Write-Host ""
Write-Host "Done. Hard-refresh the Pages URL / home-screen app so the latest shell loads."
Write-Host "Then on each phone: Phases → open phase → Reload shipped pack."
