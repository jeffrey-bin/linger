#requires -Version 5.1
# The ordinary user creates an empty fixture directory and a regular "target"
# file. An administrator runs this script, then the ordinary user sets
# LINGER_TEST_WINDOWS_REPOSITORY_LINK_FIXTURE to that directory for Go tests.
param([Parameter(Mandatory = $true)][string] $FixtureDirectory)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($FixtureDirectory)
$directory = Get-Item -LiteralPath $root -Force
$target = Get-Item -LiteralPath (Join-Path $root 'target') -Force
if (!$directory.PSIsContainer -or ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $target.PSIsContainer -or ($target.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Fixture paths must be ordinary.' }
$links = @{ valid='AGENTS.md'; cycle='unsafe'; dangling='missing'; rules='../rules'; env='../.env'; generated='dist/missing/output'; loop='loop'; 'through-file'='README/inner'; 'readonly-dangling'='../missing'; 'absolute-regular'=$target.FullName; 'absolute-missing'=(Join-Path $root 'missing-target') }
Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class RepositoryFixtureLinks {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CreateSymbolicLink(string link, string target, int flags);
}
'@
foreach ($name in $links.Keys) {
    $destination = Join-Path $root $name
    if (Get-Item -LiteralPath $destination -Force -ErrorAction SilentlyContinue) { throw "Fixture already exists: $destination" }
    if (-not [RepositoryFixtureLinks]::CreateSymbolicLink($destination, $links[$name], 0)) { throw (New-Object ComponentModel.Win32Exception([Runtime.InteropServices.Marshal]::GetLastWin32Error())) }
}
