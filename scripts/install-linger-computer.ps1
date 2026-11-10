#requires -Version 5.1
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$LingerOperation = 'install'
$LingerPurge = $false
$LingerInstallerEmbedded = $false
# LINGER_WINDOWS_BOOTSTRAP
if (-not $LingerInstallerEmbedded) { throw 'Use the generated /install/linger-computer.ps1 entrypoint; this file is a release template.' }
