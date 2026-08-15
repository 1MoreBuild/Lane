$ErrorActionPreference = "Stop"

$expectedPublisher = $env:AZURE_SIGNING_PUBLISHER_NAME
if ([string]::IsNullOrWhiteSpace($expectedPublisher)) {
  throw "AZURE_SIGNING_PUBLISHER_NAME is required for release verification"
}
$expectedPublisher = $expectedPublisher.Trim()

$package = Get-Content -Raw -LiteralPath "package.json" | ConvertFrom-Json
$version = $package.version
$installerName = "Lane-$version-windows-setup.exe"
$paths = @(
  "release\win-unpacked\Lane.exe",
  "release\win-unpacked\resources\bin\lane-cli.exe",
  "release\win-unpacked\resources\bin\lane-native-host.exe",
  "release\$installerName"
)

foreach ($path in $paths) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "Expected signed release file is missing: $path"
  }
  $signature = Get-AuthenticodeSignature -LiteralPath $path
  if ($signature.Status -ne "Valid") {
    throw "Invalid Authenticode signature on ${path}: $($signature.StatusMessage)"
  }
  $actualPublisher = $signature.SignerCertificate.GetNameInfo(
    [System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,
    $false
  )
  if ($actualPublisher -cne $expectedPublisher) {
    throw "Unexpected Authenticode publisher on ${path}: $actualPublisher"
  }
  if ($null -eq $signature.TimeStamperCertificate) {
    throw "Authenticode signature is missing a trusted timestamp: $path"
  }
}

$metadataPath = "release\latest.yml"
$blockmapPath = "release\$installerName.blockmap"
if (-not (Test-Path -LiteralPath $metadataPath -PathType Leaf)) {
  throw "Windows update metadata is missing: $metadataPath"
}
if (-not (Test-Path -LiteralPath $blockmapPath -PathType Leaf)) {
  throw "Windows differential update blockmap is missing: $blockmapPath"
}
$metadata = Get-Content -Raw -LiteralPath $metadataPath
if ($metadata -notmatch "(?m)^version: $([regex]::Escape($version))$") {
  throw "latest.yml does not match package version $version"
}
if ($metadata -notmatch "(?m)^path: $([regex]::Escape($installerName))$") {
  throw "latest.yml does not point to $installerName"
}
if ($metadata -notmatch "(?m)^sha512: .+$") {
  throw "latest.yml does not contain an installer checksum"
}

Write-Output "Verified Azure Artifact Signing publisher, timestamps, x64, NSIS, and updater artifacts for Lane $version"
