#requires -Version 5.1
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Native Windows is required.' }
$repositoryRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repositoryRoot
$node = (Get-Command node.exe -ErrorAction Stop).Source
$pnpm = (Get-Command pnpm.cmd -ErrorAction Stop).Source
$go = (Get-Command go.exe -ErrorAction Stop).Source
$architecture = (& $node -p 'process.arch').Trim()
if ($architecture -notin @('x64', 'arm64')) { throw 'Windows x64 or ARM64 is required.' }
$nativeArchitecture = $env:PROCESSOR_ARCHITEW6432
if (-not $nativeArchitecture) { $nativeArchitecture = $env:PROCESSOR_ARCHITECTURE }
$expectedArchitecture = switch ($nativeArchitecture.ToUpperInvariant()) {
    'AMD64' { 'x64' }
    'ARM64' { 'arm64' }
    default { throw 'Windows x64 or ARM64 is required.' }
}
if ($architecture -ne $expectedArchitecture) { throw 'Use the Node build matching the native Windows architecture.' }
if ((& $node --version).Trim() -ne 'v26.5.0') { throw 'The native verification requires Node 26.5.0.' }
$runId = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ') + '-' + $architecture
$reportDirectory = Join-Path $repositoryRoot ('.linger-runtime/windows-verification/' + $runId)
New-Item -ItemType Directory -Path $reportDirectory -Force | Out-Null
$steps = New-Object 'System.Collections.Generic.List[object]'
# CIM can deny ordinary SSH sessions. System version reporting must not require
# administrative WMI access before the ordinary-user verification begins.
$windowsVersion = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
$windowsName = if ([int]$windowsVersion.CurrentBuildNumber -ge 22000) { 'Windows 11' } else { 'Windows 10' }
$report = [ordered]@{
    platform = 'win32'; architecture = $architecture; nativeArchitecture = $nativeArchitecture
    operatingSystem = $windowsName + ' ' + $windowsVersion.EditionID
    osBuild = $windowsVersion.CurrentBuildNumber + '.' + $windowsVersion.UBR
    osVersion = [Environment]::OSVersion.Version.ToString()
    powershellVersion = $PSVersionTable.PSVersion.ToString()
    testTimeoutScale = $(if ($env:LINGER_TEST_WINDOWS_TIMEOUT_SCALE) { [int]$env:LINGER_TEST_WINDOWS_TIMEOUT_SCALE } else { 1 })
    source = (& git rev-parse HEAD).Trim()
    dirty = [bool](& git status --porcelain)
    startedAt = (Get-Date).ToUniversalTime().ToString('o')
    status = 'running'; steps = $steps
}
function Invoke-Verification([string]$Name, [string]$Command, [string[]]$Arguments) {
    $savedPreference = $ErrorActionPreference
    try {
        # Windows PowerShell 5.1 wraps native stderr as ErrorRecord. Exit code
        # remains the authority; harmless Node diagnostics must not abort it.
        $ErrorActionPreference = 'Continue'
        & $Command @Arguments 2>&1 | Tee-Object -FilePath (Join-Path $reportDirectory ($Name + '.log'))
        $exitCode = $LASTEXITCODE
    } finally { $ErrorActionPreference = $savedPreference }
    $steps.Add([ordered]@{ name = $Name; exitCode = $exitCode })
    if ($exitCode -ne 0) { throw ($Name + ' failed with exit code ' + $exitCode) }
}
try {
    Invoke-Verification 'installer' $pnpm @('exec', 'vitest', 'run', '--no-file-parallelism', 'scripts/local-computer-windows-native.test.ts')
    Push-Location (Join-Path $repositoryRoot 'apps/computer/local-daemon')
    try {
        Invoke-Verification 'native-platform' $go @('test', './internal/platform/...', './internal/linger/control')
        Invoke-Verification 'native-identity' $go @('test', './internal/linger/transport', '-run', '^(TestGenerateDerivesStableDaemonIDAndSigns|TestNewRejectsMismatchedKeyPair|TestFileStore.*)$')
        Invoke-Verification 'native-services' $go @('test', './internal/process', '-run', '^(TestManagedServiceSurvivesStartingProcessExitAndStopsDescendants|TestManagedServiceRefusesPreexistingJob)$')
        Invoke-Verification 'native-runtimes' $go @('test', './internal/provider', '-run', '^TestWindowsDiscoverNativeProtocolsAndAuthenticationWithSanitizedEnvironment$')
        Invoke-Verification 'native-task-trees' $go @('test', './internal/process')
        Invoke-Verification 'native-runtime-contracts' $go @('test', './internal/provider/native', '-run', '^(TestRuntime.*|TestCommand.*|TestPi.*|TestCodexContract.*|TestCodexRPC.*|TestCodexEvents.*|TestWindowsRuntimeLaunchUsesConfiguredNodeSearchPath|TestWindowsClaudeInstructionSnapshotRejectsPublicACL)$')
        Invoke-Verification 'native-projection' $go @('test', './internal/linger/context', '-run', '^(TestWindowsContextRejectsFilenameAliasesBeforePublication|TestViewStoreAppliesRefreshesAndReleasesAtomically|TestViewStoreExportsOnlyReadyReceiptRegularFiles|TestCLIConfigurationInstallIsPrivateIdempotentAndFenced)$')
        Invoke-Verification 'cli' $go @('test', './internal/computercli', './internal/computerconfig')
        Invoke-Verification 'native-launcher' $go @('test', './cmd/linger-computer-launcher')
        Invoke-Verification 'native-helper' $go @('test', './cmd/linger-computer-daemon', '-run', '^(TestPlatformEntry.*|TestWindowsPlatform.*|TestInstalledTeamHubCLIBinUsesPlatformLauncher)$')
        Invoke-Verification 'native-skills' $go @('test', './internal/linger/localskills', '-run', '^(TestWindowsSkillScan.*|TestCatalogScansAndReplaysDurably|TestPackageDigestMatchesTypeScriptContract)$')
        Invoke-Verification 'native-runtime-home' $go @('test', './internal/workspace')
    } finally { Pop-Location }
    $report.status = 'passed'
} catch {
    $report.status = 'failed'
    throw
} finally {
    $report['finishedAt'] = (Get-Date).ToUniversalTime().ToString('o')
    $report | ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 (Join-Path $reportDirectory 'result.json')
    Write-Host ('Native Windows verification report: ' + $reportDirectory)
}
