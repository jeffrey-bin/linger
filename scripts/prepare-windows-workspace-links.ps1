#requires -Version 5.1
# The test user owns FixtureDirectory and creates an empty outside directory.
# Run this script elevated, then set LINGER_TEST_WINDOWS_WORKSPACE_LINK_FIXTURE
# for TestWindowsPrecreatedWorkspaceLinks under the ordinary test account.
param([Parameter(Mandatory = $true)][string] $FixtureDirectory)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($FixtureDirectory)
$directory = Get-Item -LiteralPath $root -Force
$outside = Get-Item -LiteralPath (Join-Path $root 'outside') -Force
if (-not $directory.PSIsContainer -or ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
    -not $outside.PSIsContainer -or ($outside.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'Fixture and outside paths must be ordinary directories.'
}
$links = @{ cycle = 'unsafe'; dangling = 'missing'; escape = $outside.FullName; readonly = '../playground'; valid = 'AGENTS.md' }
foreach ($name in $links.Keys) {
    $destination = Join-Path $root $name
    if (Get-Item -LiteralPath $destination -Force -ErrorAction SilentlyContinue) { throw "Fixture already exists: $destination" }
}
Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class WorkspaceFixtureLinks {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CreateSymbolicLink(string link, string target, int flags);
}
'@
foreach ($name in $links.Keys) {
    $flags = if ($name -in @('escape', 'readonly')) { 1 } else { 0 }
    if (-not [WorkspaceFixtureLinks]::CreateSymbolicLink((Join-Path $root $name), $links[$name], $flags)) {
        throw (New-Object ComponentModel.Win32Exception([Runtime.InteropServices.Marshal]::GetLastWin32Error()))
    }
}
