#requires -Version 5.1
# The ordinary test user creates two directories, diagnostic and model, each
# containing a regular retained file with the text "unchanged". Run elevated;
# set LINGER_TEST_PROVIDER_LINK_ROOT to this directory for the provider suite.
# The two model links are consumed by the suite; prepare a fresh root per run.
param([Parameter(Mandatory = $true)][string] $FixtureDirectory)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($FixtureDirectory)
foreach ($name in @('diagnostic', 'model')) {
    $directory = Get-Item -LiteralPath (Join-Path $root $name) -Force
    $target = Get-Item -LiteralPath (Join-Path $directory.FullName 'retained') -Force
    if (!$directory.PSIsContainer -or ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $target.PSIsContainer -or ($target.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Fixture paths must be ordinary directories and files.' }
}
foreach ($pair in @(@('diagnostic/runner-diagnostics.log', 'diagnostic/retained'), @('model/prepared-link', 'model/retained'), @('model/roundtrip-link', 'model/retained'))) {
    $link = Join-Path $root $pair[0]
    if (Get-Item -LiteralPath $link -Force -ErrorAction SilentlyContinue) { throw "Fixture already exists: $link" }
    New-Item -ItemType SymbolicLink -Path $link -Target (Join-Path $root $pair[1]) -ErrorAction Stop | Out-Null
}
