param([string]$Version = "")

if (-not $Version) {
    $Version = (Get-Content "$PSScriptRoot\..\package.json" | ConvertFrom-Json).version
}

$src  = "$PSScriptRoot\..\release\win-unpacked"
$dest = "$PSScriptRoot\..\release\GCPT-$Version-win-x64.zip"

if (-not (Test-Path $src)) {
    Write-Error "win-unpacked 디렉터리 없음: $src"
    exit 1
}

if (Test-Path $dest) { Remove-Item $dest -Force }
Compress-Archive -Path "$src\*" -DestinationPath $dest -CompressionLevel Optimal
$mb = [math]::Round((Get-Item $dest).Length / 1MB, 1)
Write-Output "ZIP 생성 완료: $dest ($mb MB)"
