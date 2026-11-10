#requires -Version 5.1
[CmdletBinding()]
param([switch]$Purge, [Parameter(ValueFromRemainingArguments = $true)][string[]]$RemainingArguments)
$ErrorActionPreference = 'Stop'
foreach ($argument in $RemainingArguments) {
    if ($argument -eq '--purge') { $Purge = $true }
    else { throw 'Usage: uninstall-linger-computer.ps1 [-Purge | --purge]' }
}
$LingerOperation = 'uninstall'
$LingerPurge = [bool]$Purge
$LingerInstallerEmbedded = $false
# LINGER_WINDOWS_BOOTSTRAP
if (-not $LingerInstallerEmbedded) { throw 'Use the generated /install/uninstall-linger-computer.ps1 entrypoint; this file is a release template.' }
