# `stack.ps1 ARGS` runs `localmodels stack ARGS` from the release pinned below. The first run
# downloads that release's self-contained Python + localmodels kit, checks its SHA256 and every
# file it lists, and caches it; later runs start offline. No system Python is needed.
# llm-inference-lab's release pipeline writes the pin; edit the template there, not this copy.
# Windows PowerShell 5.1 or PowerShell 7; Windows needs tar.exe (Windows 10 1803 or newer).
Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# >>> release pin
$StackVersion = '0.1.0.dev28'
$StackSourceCommit = 'c77bed6e5b65c30314d96dfe8dc9b7ab964c5332'
$StackBaseUrl = 'https://d2ikbbcl3j6jz9.cloudfront.net/cli/localmodels/0.1.0.dev28'
$StackKits = @{
    'darwin-arm64' = 'abd3baeabd3d43bd4a4e5fc3694ed2456d5b32b3b8d0b3805856d9b0a57272c8'
    'darwin-x64' = 'c3aeb71c912948acb2fb8a4ef8a9f278d16a767d34323c655be83801ef1a8789'
    'linux-arm64' = 'feffffef4bdfff3d3aff4f248b1daaf804d5a238c3dc58560b42947cb2ecaa09'
    'linux-x64' = '2923a04c83c88237814e753cfc3637bdc80545aa77defa669d8ff42cd85d6eb8'
    'win32-x64' = 'a2301caae3ce51a48b1a9a2409c61bf6c1c8af9b095169e19348c5f2b817cce7'
}
# <<< release pin

function Stop-Stack([string]$Message) {
    [Console]::Error.WriteLine("stack.ps1: $Message")
    exit 2
}

if (-not $StackVersion) {
    Stop-Stack 'this is the unpinned template; run the copy a release wrote to linger scripts/installs'
}

$onWindows = $PSVersionTable.PSVersion.Major -lt 6 -or $IsWindows
if ($onWindows) {
    $arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    $target = @{ 'AMD64' = 'win32-x64' }[$arch]
    $python = 'python\python.exe'
    $cacheBase = $env:LOCALAPPDATA
} else {
    $os = if ($IsMacOS) { 'darwin' } else { 'linux' }
    $machine = (& uname -m).Trim()
    $target = @{ 'x86_64' = "$os-x64"; 'amd64' = "$os-x64"; 'arm64' = "$os-arm64"; 'aarch64' = "$os-arm64" }[$machine]
    $python = 'python/bin/python3'
    $cacheBase = if ($env:XDG_CACHE_HOME) { $env:XDG_CACHE_HOME } else { Join-Path $HOME '.cache' }
}
if (-not $target -or -not $StackKits.ContainsKey($target)) {
    Stop-Stack "release $StackVersion has no kit for this platform"
}
$kit = $StackKits[$target]

# Kits are keyed by archive SHA256, so a new pin never reuses an older kit.
$root = if ($env:LOCALMODELS_KIT_HOME) { $env:LOCALMODELS_KIT_HOME } else { Join-Path $cacheBase 'linger-localmodels/kits' }
$final = Join-Path $root $kit

function Install-Kit {
    # LOCALMODELS_KIT_BASE_URL serves the same files from a mirror; the pinned SHA256 still applies.
    $base = if ($env:LOCALMODELS_KIT_BASE_URL) { $env:LOCALMODELS_KIT_BASE_URL } else { $StackBaseUrl }
    $url = "$base/$target.tgz"
    New-Item -ItemType Directory -Force -Path $root | Out-Null
    $staging = Join-Path $root ('.staging.' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $staging | Out-Null
    try {
        [Console]::Error.WriteLine("stack.ps1: downloading localmodels $StackVersion (source $StackSourceCommit, $target)")
        $archive = Join-Path $staging 'kit.tgz'
        if ($PSVersionTable.PSVersion.Major -lt 6) {
            [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        }
        try {
            Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $archive
        } catch {
            Stop-Stack "download failed: $url"
        }
        $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant()
        if ($actual -ne $kit) {
            Stop-Stack "SHA256 mismatch for ${url}: expected $kit, got $actual"
        }
        $unpacked = Join-Path $staging 'kit'
        New-Item -ItemType Directory -Path $unpacked | Out-Null
        & tar -xzf $archive -C $unpacked
        if ($LASTEXITCODE -ne 0) { Stop-Stack "could not unpack $archive" }
        & (Join-Path $unpacked $python) -I -B (Join-Path $unpacked 'kit.py') prepare $unpacked
        if ($LASTEXITCODE -ne 0) { Stop-Stack 'the downloaded kit failed verification' }
        # Renamed here, after the kit's python exits: Windows cannot rename a running program's folder.
        try {
            [IO.Directory]::Move($unpacked, $final)
        } catch {
            if (-not (Test-Path -LiteralPath (Join-Path $final 'kit.py'))) { throw }
        }
    } finally {
        Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
    }
}

if (-not (Test-Path -LiteralPath (Join-Path $final 'kit.py'))) { Install-Kit }
$arguments = @($args)
if ($arguments.Count -eq 0) { $arguments = @('--help') }
& (Join-Path $final $python) -I -B (Join-Path $final 'kit.py') run stack @arguments
exit $LASTEXITCODE
