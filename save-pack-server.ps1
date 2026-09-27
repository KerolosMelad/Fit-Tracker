# Writes phase packs into templates/ on this PC. No file picker.
# Leave this running while you use Save as pack on the PC.
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$templates = Join-Path $root "templates"
$port = 8765

function Get-Utf8NoBom {
  $enc = New-Object System.Text.UTF8Encoding $false
  return $enc
}

function Write-PackFiles([string]$file, [string]$packJson) {
  if ($file -notmatch '^[A-Za-z0-9._-]+\.json$') {
    throw "Bad pack file name."
  }
  if (-not (Test-Path -LiteralPath $templates)) {
    throw "Missing templates folder: $templates"
  }
  $packPath = Join-Path $templates $file
  $text = $packJson.Trim()
  if (-not $text.StartsWith("{")) { throw "Pack JSON is not an object." }
  [System.IO.File]::WriteAllText($packPath, $text + "`n", (Get-Utf8NoBom))

  $manifestPath = Join-Path $templates "manifest.json"
  $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $today = (Get-Date).ToString("yyyy-MM-dd")
  $manifest.updated = $today
  if (-not (@($manifest.phase) | Where-Object { $_.file -eq $file })) {
    $manifest.phase += [pscustomobject]@{
      id   = ($file -replace '\.json$', '')
      name = ($file -replace '\.json$', '' -replace '[-_]', ' ')
      file = $file
    }
  }
  $manifestJson = ($manifest | ConvertTo-Json -Depth 20)
  [System.IO.File]::WriteAllText($manifestPath, $manifestJson + "`n", (Get-Utf8NoBom))

  $parts = New-Object System.Collections.Generic.List[string]
  foreach ($item in @($manifest.phase)) {
    $name = [string]$item.file
    $path = Join-Path $templates $name
    if (-not (Test-Path -LiteralPath $path)) { continue }
    $raw = (Get-Content -LiteralPath $path -Raw -Encoding UTF8).Trim()
    $key = ($name | ConvertTo-Json -Compress)
    $parts.Add("$key`:$raw")
  }
  $libJson = ($manifest | ConvertTo-Json -Depth 20 -Compress)
  $js = "/* Auto-copied from templates/*.json so shipped packs work without fetch. */`nwindow.KEJU_PHASE_PACKS = {$($parts -join ',')};`nwindow.KEJU_PHASE_LIBRARY = $libJson;`n"
  [System.IO.File]::WriteAllText((Join-Path $templates "packs.js"), $js, (Get-Utf8NoBom))
}

function Send-Response($stream, [int]$code, [string]$status, [string]$body, [string]$type = "text/plain; charset=utf-8") {
  $bytes = [Text.Encoding]::UTF8.GetBytes($body)
  $head = "HTTP/1.1 $code $status`r`nAccess-Control-Allow-Origin: *`r`nAccess-Control-Allow-Methods: GET, POST, OPTIONS`r`nAccess-Control-Allow-Headers: Content-Type`r`nAccess-Control-Allow-Private-Network: true`r`nContent-Type: $type`r`nContent-Length: $($bytes.Length)`r`nConnection: close`r`n`r`n"
  $headerBytes = [Text.Encoding]::ASCII.GetBytes($head)
  $stream.Write($headerBytes, 0, $headerBytes.Length)
  if ($bytes.Length) { $stream.Write($bytes, 0, $bytes.Length) }
}

$tcp = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $port)
try {
  $tcp.Start()
} catch {
  throw "Pack writer could not bind 127.0.0.1:$port. Is it already running?"
}
Write-Host "Pack writer http://127.0.0.1:$port -> $templates"

try {
  while ($true) {
    $client = $tcp.AcceptTcpClient()
    try {
      $stream = $client.GetStream()
      $stream.ReadTimeout = 15000
      $buffer = New-Object byte[] 1024
      $sb = New-Object System.Text.StringBuilder
      $raw = New-Object System.Collections.Generic.List[byte]
      $headerDone = $false
      $contentLength = 0
      while (-not $headerDone) {
        $n = $stream.Read($buffer, 0, $buffer.Length)
        if ($n -le 0) { break }
        for ($i = 0; $i -lt $n; $i++) { $raw.Add($buffer[$i]) }
        $text = [Text.Encoding]::ASCII.GetString($raw.ToArray())
        $split = $text.IndexOf("`r`n`r`n")
        if ($split -ge 0) { $headerDone = $true }
      }
      $all = $raw.ToArray()
      $headerText = [Text.Encoding]::ASCII.GetString($all)
      $idx = $headerText.IndexOf("`r`n`r`n")
      if ($idx -lt 0) {
        Send-Response $stream 400 "Bad Request" "Bad request"
        continue
      }
      $headers = $headerText.Substring(0, $idx)
      $bodyStart = $idx + 4
      $bodyBytes = New-Object System.Collections.Generic.List[byte]
      if ($all.Length -gt $bodyStart) {
        for ($i = $bodyStart; $i -lt $all.Length; $i++) { $bodyBytes.Add($all[$i]) }
      }
      if ($headers -match '(?im)^Content-Length:\s*(\d+)') {
        $contentLength = [int]$Matches[1]
      }
      while ($bodyBytes.Count -lt $contentLength) {
        $n = $stream.Read($buffer, 0, $buffer.Length)
        if ($n -le 0) { break }
        for ($i = 0; $i -lt $n; $i++) { $bodyBytes.Add($buffer[$i]) }
      }
      $reqLine = ($headers -split "`r`n")[0]
      if ($reqLine -match '^OPTIONS ') {
        Send-Response $stream 204 "No Content" ""
        continue
      }
      if ($reqLine -match '^GET /health') {
        Send-Response $stream 200 "OK" "ok"
        continue
      }
      if ($reqLine -match '^POST /save-pack') {
        $body = [Text.Encoding]::UTF8.GetString($bodyBytes.ToArray())
        $parsed = $body | ConvertFrom-Json
        $file = [string]$parsed.file
        $packJson = [string]$parsed.json
        if (-not $packJson) { throw "Missing pack json." }
        Write-PackFiles $file $packJson
        Write-Host "Saved $file"
        $okJson = "{`"ok`":true}"
        Send-Response $stream 200 "OK" $okJson "application/json"
        continue
      }
      Send-Response $stream 404 "Not Found" "not found"
    } catch {
      try { Send-Response $stream 400 "Bad Request" $_.Exception.Message } catch { }
    } finally {
      $client.Close()
    }
  }
} finally {
  $tcp.Stop()
}
