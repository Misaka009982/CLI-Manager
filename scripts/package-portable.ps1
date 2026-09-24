[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Version,
    [string]$SourceDir = "src-tauri/target/release",
    [string]$OutputDir = "dist/portable"
)

$ErrorActionPreference = "Stop"

$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$resolvedSourceDir = if ([System.IO.Path]::IsPathRooted($SourceDir)) {
    [System.IO.Path]::GetFullPath($SourceDir)
} else {
    [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot $SourceDir))
}
$resolvedOutputDir = if ([System.IO.Path]::IsPathRooted($OutputDir)) {
    [System.IO.Path]::GetFullPath($OutputDir)
} else {
    [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot $OutputDir))
}

$normalizedVersion = $Version.Trim().TrimStart([char[]]@("V", "v"))
if ($normalizedVersion -notmatch "^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$") {
    throw "Invalid release version: $Version"
}

$executableNames = @(
    "cli-manager.exe",
    "cli-manager-codex-proxy.exe",
    "cli-manager-daemon.exe",
    "cli-manager-web-daemon.exe"
)
$resourcesDir = Join-Path $resolvedSourceDir "resources"
$petEResourceDir = Join-Path $resourcesDir "pet-e"
$webDistDir = Join-Path $resolvedSourceDir "apps/web/dist"
foreach ($relativePath in ($executableNames + @("apps/web/dist/index.html"))) {
    $requiredPath = Join-Path $resolvedSourceDir $relativePath
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "Missing portable package input: $requiredPath"
    }
}
foreach ($requiredPath in @($resourcesDir, $petEResourceDir, (Join-Path $webDistDir "assets"))) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Container)) {
        throw "Missing portable package input: $requiredPath"
    }
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js is required to validate the Desktop Pet E portable resources"
}
$packageVerifier = Join-Path $repositoryRoot "scripts/verify-pet-e-package.mjs"
& node $packageVerifier --root $petEResourceDir
if ($LASTEXITCODE -ne 0) {
    throw "Desktop Pet E resource validation failed with exit code $LASTEXITCODE"
}

New-Item -ItemType Directory -Force -Path $resolvedOutputDir | Out-Null
$stagingDir = Join-Path $resolvedOutputDir "CLI-Manager"
$archivePath = Join-Path $resolvedOutputDir "CLI-Manager-V$normalizedVersion-Windows-x64-portable.zip"

$outputPrefix = $resolvedOutputDir.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
$stagingFullPath = [System.IO.Path]::GetFullPath($stagingDir)
$archiveFullPath = [System.IO.Path]::GetFullPath($archivePath)
if (-not $stagingFullPath.StartsWith($outputPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Portable staging path escaped the output directory: $stagingFullPath"
}
if (-not $archiveFullPath.StartsWith($outputPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Portable archive path escaped the output directory: $archiveFullPath"
}

if (Test-Path -LiteralPath $stagingFullPath) {
    Remove-Item -LiteralPath $stagingFullPath -Recurse -Force
}
if (Test-Path -LiteralPath $archiveFullPath) {
    Remove-Item -LiteralPath $archiveFullPath -Force
}

New-Item -ItemType Directory -Path $stagingFullPath | Out-Null
foreach ($name in $executableNames) {
    Copy-Item -LiteralPath (Join-Path $resolvedSourceDir $name) -Destination (Join-Path $stagingFullPath $name)
}
Copy-Item -LiteralPath $resourcesDir -Destination (Join-Path $stagingFullPath "resources") -Recurse
$webDestination = Join-Path $stagingFullPath "apps/web"
New-Item -ItemType Directory -Path $webDestination -Force | Out-Null
Copy-Item -LiteralPath $webDistDir -Destination (Join-Path $webDestination "dist") -Recurse
New-Item -ItemType File -Path (Join-Path $stagingFullPath "portable.flag") | Out-Null

Compress-Archive -LiteralPath $stagingFullPath -DestinationPath $archiveFullPath -CompressionLevel Optimal
Write-Output $archiveFullPath
