# Deploy Cut Tracker to Cloudflare Pages (static files only).
# 1) One-time login in your own terminal (opens browser):
#      npx --yes wrangler@4 login
# 2) Then run:
#      powershell -ExecutionPolicy Bypass -File .\deploy.ps1
# 3) Lock the site: Cloudflare Zero Trust → Access → protect this Pages domain (your email only).

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "Deploying cut-tracker to Cloudflare Pages..."
npx --yes wrangler@4 pages deploy . --project-name cut-tracker --commit-dirty=true

Write-Host ""
Write-Host "Next (security): https://one.dash.cloudflare.com/ → Access → Applications → add your *.pages.dev URL → Allow email = only you."
Write-Host "iPhone: open the URL in Safari → Share → Add to Home Screen."
