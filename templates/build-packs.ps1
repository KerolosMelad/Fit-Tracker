# Rebuild templates/packs.js from the JSON files listed in manifest.json.
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$manifestPath = Join-Path $root "manifest.json"
$outPath = Join-Path $root "packs.js"

$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$packs = [ordered]@{}
foreach ($item in @($manifest.phase)) {
  $file = [string]$item.file
  $path = Join-Path $root $file
  if (-not (Test-Path -LiteralPath $path)) {
    throw "Missing pack file: $file"
  }
  $packs[$file] = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
}

$lib = $manifest | ConvertTo-Json -Depth 20 -Compress
$packJson = ($packs | ConvertTo-Json -Depth 100 -Compress)
$js = @"
/* Auto-copied from templates/*.json so shipped packs work without fetch. */
window.KEJU_PHASE_PACKS = $packJson;
window.KEJU_PHASE_LIBRARY = $lib;
"@
Set-Content -LiteralPath $outPath -Value $js -Encoding UTF8
Write-Host "Wrote $outPath"
