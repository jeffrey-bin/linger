#requires -Version 5.1
# The test user creates an empty directory and target.json before an elevated
# account runs this script. Set LINGER_TEST_WINDOWS_SYMLINK_FIXTURE to that
# directory when running the computercli and teamhub-cli symlink tests.
param(
    [Parameter(Mandatory = $true)]
    [string] $FixtureDirectory
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($FixtureDirectory)
$directory = Get-Item -LiteralPath $root -Force
if (-not $directory.PSIsContainer -or ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'The fixture directory must be an existing ordinary directory.'
}
$target = Join-Path $root 'target.json'
$targetItem = Get-Item -LiteralPath $target -Force
if ($targetItem.PSIsContainer -or ($targetItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'The fixture target must be an existing ordinary file.'
}
$link = Join-Path $root 'config-link.json'
if (Test-Path -LiteralPath $link) { throw 'The fixture link already exists.' }
New-Item -ItemType SymbolicLink -Path $link -Target $target -ErrorAction Stop | Out-Null
Write-Output "Prepared $link"
