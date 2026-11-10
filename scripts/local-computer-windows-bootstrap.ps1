# Shared source, embedded into both published entrypoints by the release builder.
$LingerInstallerEmbedded = $true
$LingerStartedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$LingerRelease = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__LINGER_RELEASE_METADATA_BASE64__')) | ConvertFrom-Json
$LingerHelperBase64 = '__LINGER_INSTALLER_HELPER_BASE64__'
$LingerUtf8 = New-Object Text.UTF8Encoding($false)
# Managed tool runtime modules ship beside the CLI. Releases before they
# existed verify without them, so presence decides the checksum entry list.
$LingerManagedToolEntries = @(
    'cli/managed-tools-runtime.mjs', 'cli/managed-tools-install.mjs', 'cli/managed-tools-launchers.mjs',
    'cli/managed-tools-archive.mjs', 'cli/managed-tools-lock.mjs', 'cli/local-computer-node-distributions.mjs')
$LingerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
if ((New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run Local Computer installation or uninstallation in an ordinary PowerShell window, without Run as administrator.'
}

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or [Environment]::OSVersion.Version.Major -lt 10) {
    throw 'Local Computer requires native Windows 10 or Windows 11.'
}
if (-not [Environment]::Is64BitOperatingSystem) { throw 'Local Computer requires a 64-bit Windows system.' }
$LingerArchitecture = $env:PROCESSOR_ARCHITEW6432
if (-not $LingerArchitecture) { $LingerArchitecture = $env:PROCESSOR_ARCHITECTURE }
switch ($LingerArchitecture.ToUpperInvariant()) {
    'ARM64' { $LingerTarget = 'win32-arm64' }
    'AMD64' { $LingerTarget = 'win32-x64' }
    default { throw "Unsupported native Windows architecture: $LingerArchitecture" }
}

if (-not ('LingerInstallerFileIdentity' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class LingerInstallerFileIdentity {
    [StructLayout(LayoutKind.Sequential)] private struct SecurityAttributes {
        public int Length;
        public IntPtr Descriptor;
        public int InheritHandle;
    }
    [StructLayout(LayoutKind.Sequential)] public struct Info {
        public uint Attributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime, AccessTime, WriteTime;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Info info);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern bool CreateDirectoryW(string path, ref SecurityAttributes attributes);
    public static void CreatePrivateDirectory(string path, byte[] descriptor) {
        IntPtr memory = Marshal.AllocHGlobal(descriptor.Length);
        try {
            Marshal.Copy(descriptor, 0, memory, descriptor.Length);
            SecurityAttributes attributes = new SecurityAttributes();
            attributes.Length = Marshal.SizeOf(typeof(SecurityAttributes));
            attributes.Descriptor = memory;
            if (!CreateDirectoryW(path, ref attributes))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        } finally { Marshal.FreeHGlobal(memory); }
    }
    public static void CheckSingleLink(SafeFileHandle handle) {
        Info value;
        if (!GetFileInformationByHandle(handle, out value) || value.Links != 1 || (value.Attributes & 1024) != 0)
            throw new InvalidOperationException("Installer file identity is unsafe.");
    }
    public static void CheckDacl(byte[] descriptor) {
        var security = new System.Security.AccessControl.RawSecurityDescriptor(descriptor, 0);
        if (security.DiscretionaryAcl == null)
            throw new InvalidOperationException("Installer path has an unrestricted DACL.");
    }
}
'@
}

# Bundled tool dependencies nest deeper than the 260-character path limit that
# Win32 applies to ordinary paths. Address every installer path as an extended
# path so the same code reaches short and deep files alike.
function Get-LingerFullPath([string]$Path) {
    if ($Path.StartsWith('\\?\')) { return $Path }
    $full = [IO.Path]::GetFullPath($Path)
    # Extended paths spell a share as \\?\UNC\server. Installer paths are local,
    # so leave the remote form alone and let the caller's check reject it.
    if ($full.StartsWith('\\')) { return $full }
    return '\\?\' + $full
}

# Numbered steps in plain ASCII; Windows PowerShell 5.1 consoles render no
# Unicode symbols. A console redraws the current line with a spinner and the
# elapsed time; redirected output gets a heartbeat line at most every 10s. The
# Node helper continues the open step on the same line.
$LingerInteractive = -not [Console]::IsOutputRedirected
$LingerStepTotal = 4
# Functions write the step through $script:, so the top level must use the
# same variable even when the installer runs inside a script block.
$script:LingerStep = $null

function Format-LingerDuration([long]$Milliseconds) {
    $seconds = [long][Math]::Max(0, [Math]::Round($Milliseconds / 1000))
    if ($seconds -lt 60) { return "${seconds}s" }
    return '{0}m {1}s' -f [Math]::Floor($seconds / 60), ($seconds % 60)
}

function Write-LingerStepLine([string]$Suffix, [bool]$Final) {
    $line = '[{0}/{1}] {2}... {3}' -f $LingerStep.Number, $LingerStepTotal, $LingerStep.Label, $Suffix
    [Console]::Write("`r" + $line + (' ' * [Math]::Max(0, $LingerStep.Drawn - $line.Length)))
    if ($Final) { [Console]::WriteLine(); $LingerStep.Drawn = 0 } else { $LingerStep.Drawn = $line.Length }
}

# Long loops call this often; it redraws at most four times a second.
function Update-LingerStep([string]$Detail = '', [switch]$Force) {
    if (-not $LingerStep) { return }
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $interval = 10000
    if ($LingerInteractive) { $interval = 250 }
    if (-not $Force -and $now - $LingerStep.LastDraw -lt $interval) { return }
    $LingerStep.LastDraw = $now
    $elapsed = Format-LingerDuration ($now - $LingerStep.StartedAt)
    if ($LingerInteractive) {
        $frame = '|/-\'[$LingerStep.Frame % 4]
        $LingerStep.Frame += 1
        if ($Detail) { $Detail += ' ' }
        Write-LingerStepLine ($Detail + $frame + ' ' + $elapsed) $false
    } elseif (-not $Force) {
        if (-not $Detail) { $Detail = 'still working' }
        [Console]::WriteLine(('      {0} ({1})' -f $Detail, $elapsed))
    }
}

function Stop-LingerStep([string]$Result = 'OK') {
    if (-not $LingerStep) { return }
    $elapsed = Format-LingerDuration ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $LingerStep.StartedAt)
    if ($LingerInteractive) { Write-LingerStepLine ($Result + ' (' + $elapsed + ')') $true }
    else { [Console]::WriteLine(('[{0}/{1}] {2}... {3} ({4})' -f $LingerStep.Number, $LingerStepTotal, $LingerStep.Label, $Result, $elapsed)) }
    $script:LingerStep = $null
}

function Start-LingerStep([int]$Number, [string]$Label) {
    Stop-LingerStep
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $script:LingerStep = @{ Number = $Number; Label = $Label; StartedAt = $now; LastDraw = $now; Drawn = 0; Frame = 0 }
    if (-not $LingerInteractive) { [Console]::WriteLine(('[{0}/{1}] {2}...' -f $Number, $LingerStepTotal, $Label)) }
    Update-LingerStep -Force
}

function Write-LingerNote([string]$Text) {
    if ($LingerInteractive -and $LingerStep) {
        [Console]::Write("`r" + (' ' * $LingerStep.Drawn) + "`r")
        $LingerStep.Drawn = 0
    }
    [Console]::WriteLine($Text)
    if ($LingerInteractive) { Update-LingerStep -Force }
}

# Directories whose whole ancestor chain passed in this run. A bundle has dozens
# of files under the same ancestors; walking each chain again per file took
# seconds. Only a fully successful walk is remembered.
$LingerTrustedDirectories = @{}

function Assert-LingerAncestors([string]$Path) {
    $cursor = Get-LingerFullPath $Path
    $walked = @()
    while ($cursor) {
        if ($LingerTrustedDirectories.ContainsKey($cursor)) { break }
        $ancestor = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
        if ($ancestor.PSIsContainer) { $walked += $cursor }
        if (($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Install path contains a reparse point: $cursor" }
        $ancestorAcl = Get-Acl -LiteralPath $cursor
        [LingerInstallerFileIdentity]::CheckDacl($ancestorAcl.GetSecurityDescriptorBinaryForm())
        $trustedOwners = @($LingerSid.Value, 'S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
        if ($ancestorAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $trustedOwners) { throw "Install ancestor has an untrusted owner: $cursor" }
        foreach ($access in $ancestorAcl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
            # Creating a sibling under C:\ is harmless. Replacing a protected
            # child or its DACL is not. Ignore inherit-only permissions.
            $inheritOnly = ($access.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0
            $replaceRights = 0x00010000 -bor 0x00040000 -bor 0x00080000 -bor 0x40 -bor 0x10000000
            # DELETE on the volume root cannot replace that root. Its children
            # remain protected by the FILE_DELETE_CHILD and ACL-change checks.
            if ($cursor -eq [IO.Path]::GetPathRoot($cursor)) { $replaceRights = $replaceRights -band (-bnot 0x00010000) }
            if (-not $inheritOnly -and $access.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
                $access.IdentityReference.Value -notin $trustedOwners -and ([int]$access.FileSystemRights -band $replaceRights) -ne 0) {
                throw "Install ancestor can be replaced by another user: $cursor"
            }
        }
        $parent = [IO.Path]::GetDirectoryName($cursor)
        if ($parent -eq $cursor) { break }
        $cursor = $parent
    }
    foreach ($directory in $walked) { $LingerTrustedDirectories[$directory] = $true }
}

function Assert-LingerPath([string]$Path, [bool]$Directory) {
    $full = Get-LingerFullPath $Path
    $item = Get-Item -LiteralPath $full -Force -ErrorAction Stop
    if ($item.PSIsContainer -ne $Directory) { throw "Install path has the wrong kind: $full" }
    Assert-LingerAncestors $full
    $acl = Get-Acl -LiteralPath $full
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $LingerSid.Value) { throw "Install path has a different owner: $full" }
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
            $rule.IdentityReference.Value -notin @($LingerSid.Value, 'S-1-5-18', 'S-1-5-32-544')) {
            throw "Install path is not private to the current user: $full"
        }
    }
    if (-not $Directory) {
        $stream = [IO.File]::Open($full, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        try { [LingerInstallerFileIdentity]::CheckSingleLink($stream.SafeFileHandle) }
        finally { $stream.Dispose() }
    }
}

function New-LingerDirectory([string]$Path) {
    $full = Get-LingerFullPath $Path
    if (Test-Path -LiteralPath $full) { Assert-LingerPath $full $true; return }
    $parent = [IO.Path]::GetDirectoryName($full)
    if (-not (Test-Path -LiteralPath $parent)) { New-LingerDirectory $parent }
    Assert-LingerAncestors $parent
    # New product directories inherit no access from a potentially shared parent.
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetOwner($LingerSid)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @($LingerSid, (New-Object Security.Principal.SecurityIdentifier('S-1-5-18')))) {
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    # Apply the private DACL at creation, before another user can open the path.
    [LingerInstallerFileIdentity]::CreatePrivateDirectory($full, $acl.GetSecurityDescriptorBinaryForm())
    Assert-LingerPath $full $true
}

function Get-LingerChecksum([string]$Path) {
    Assert-LingerPath $Path $false
    return (Get-FileHash -LiteralPath (Get-LingerFullPath $Path) -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Read-LingerPrivateText([string]$Path) {
    Assert-LingerPath $Path $false
    return [IO.File]::ReadAllText((Get-LingerFullPath $Path), $LingerUtf8)
}

function Assert-LingerArchitecture([string]$Path) {
    Assert-LingerPath $Path $false
    $stream = [IO.File]::OpenRead((Get-LingerFullPath $Path))
    $reader = New-Object IO.BinaryReader($stream)
    try {
        if ($stream.Length -lt 64 -or $reader.ReadUInt16() -ne 0x5A4D) { throw 'Release executable has no valid PE header.' }
        $stream.Position = 60
        $offset = $reader.ReadUInt32()
        if ($offset -lt 64 -or $offset + 6 -gt $stream.Length) { throw 'Release executable has no valid PE header.' }
        $stream.Position = $offset
        if ($reader.ReadUInt32() -ne 0x00004550) { throw 'Release executable has no valid PE header.' }
        $machine = $reader.ReadUInt16()
        $expected = 0x8664
        if ($LingerTarget -eq 'win32-arm64') { $expected = 0xAA64 }
        if ($machine -ne $expected) { throw 'Release executable architecture does not match this Windows system.' }
    } finally { $reader.Dispose(); $stream.Dispose() }
}

function Assert-LingerSource([string]$Source) {
    if ([IO.Path]::IsPathRooted($Source) -and $Source -notmatch '^[A-Za-z]+://') { return }
    $uri = [Uri]$Source
    if (-not $uri.IsAbsoluteUri -or $uri.UserInfo -or $uri.Fragment) { throw 'Download URL is invalid.' }
    if ($uri.IsFile) {
        if ($uri.IsUnc) { throw 'Remote file URLs are not supported.' }
        return
    }
    if ($uri.Scheme -ne 'https' -and $uri.Scheme -ne 'http') {
        throw 'Download URL must use HTTPS or HTTP.'
    }
}

function Receive-LingerFile([string]$Source, [string]$Destination) {
    Assert-LingerSource $Source
    if ([IO.Path]::IsPathRooted($Source) -and $Source -notmatch '^[A-Za-z]+://') {
        [IO.File]::Copy($Source, $Destination, $false)
        return
    }
    $uri = [Uri]$Source
    if ($uri.IsFile) { [IO.File]::Copy($uri.LocalPath, $Destination, $false); return }
    # Handle redirects ourselves so HTTPS cannot silently downgrade to HTTP.
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    for ($redirects = 0; $redirects -le 5; $redirects++) {
        Assert-LingerSource $uri.AbsoluteUri
        $request = [Net.HttpWebRequest]::Create($uri)
        $request.AllowAutoRedirect = $false
        $request.Timeout = 120000
        $response = $request.GetResponse()
        try {
            if ([int]$response.StatusCode -in @(301, 302, 303, 307, 308)) {
                if (-not $response.Headers['Location']) { throw 'Download redirect has no destination.' }
                $uri = New-Object Uri($uri, $response.Headers['Location'])
                continue
            }
            if ([int]$response.StatusCode -ne 200) { throw "Download failed: $($response.StatusCode)" }
            $output = [IO.File]::Open($Destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            $inputStream = $response.GetResponseStream()
            $length = $response.ContentLength
            $invariant = [Globalization.CultureInfo]::InvariantCulture
            try {
                $buffer = New-Object byte[] 65536
                $total = 0L
                $redraw = [Diagnostics.Stopwatch]::StartNew()
                while (($count = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                    $total += $count
                    if ($total -gt 268435456) { throw 'Release download exceeds the size limit.' }
                    $output.Write($buffer, 0, $count)
                    if ($redraw.ElapsedMilliseconds -ge 250) {
                        $redraw.Restart()
                        if ($length -gt 0) {
                            $filled = [int][Math]::Min(20, [Math]::Floor($total * 20 / $length))
                            Update-LingerStep ([string]::Format($invariant, '[{0}{1}] {2}% {3:F1}/{4:F1} MB',
                                ('#' * $filled), ('-' * (20 - $filled)), [int][Math]::Floor($total * 100 / $length), ($total / 1MB), ($length / 1MB)))
                        } else { Update-LingerStep ([string]::Format($invariant, '{0:F1} MB', ($total / 1MB))) }
                    }
                }
            } finally { $output.Dispose(); $inputStream.Dispose() }
            return
        } finally { $response.Dispose() }
    }
    throw 'Download redirect limit exceeded.'
}

function Read-LingerExact($Stream, [byte[]]$Buffer, [int]$Count) {
    $offset = 0
    while ($offset -lt $Count) {
        $read = $Stream.Read($Buffer, $offset, $Count - $offset)
        if ($read -eq 0) { throw 'Release archive is truncated.' }
        $offset += $read
    }
}

# Writes only the runtime this script and the helper start. The helper extracts
# and verifies the whole package again, so writing thousands of tool files here
# only doubled the work. Every header is still validated.
# The dependency and application archives unpack into one bundle; each call
# writes only the named files the bootstrap needs from its archive.
function Expand-LingerBootstrap([string]$Archive, [string]$Destination, [string[]]$Required) {
    New-LingerDirectory $Destination
    $required = $Required
    $found = @{}
    $sourceStream = [IO.File]::OpenRead($Archive)
    $gzip = New-Object IO.Compression.GZipStream($sourceStream, [IO.Compression.CompressionMode]::Decompress)
    try {
        $header = New-Object byte[] 512
        $buffer = New-Object byte[] 65536
        $total = 0L
        $redraw = [Diagnostics.Stopwatch]::StartNew()
        while ($true) {
            Read-LingerExact $gzip $header 512
            $sum = 0
            foreach ($byte in $header) { $sum += $byte }
            if ($sum -eq 0) { break }
            $name = [Text.Encoding]::UTF8.GetString($header, 0, 100).Split([char]0)[0]
            $prefix = [Text.Encoding]::ASCII.GetString($header, 345, 155).Split([char]0)[0]
            if ($prefix) { $name = $prefix + '/' + $name }
            $sizeText = [Text.Encoding]::ASCII.GetString($header, 124, 12).Trim([char]0, [char]32)
            $checksumText = [Text.Encoding]::ASCII.GetString($header, 148, 8).Trim([char]0, [char]32)
            $headerChecksum = 0
            for ($index = 0; $index -lt 512; $index++) {
                if ($index -ge 148 -and $index -lt 156) { $headerChecksum += 32 }
                else { $headerChecksum += $header[$index] }
            }
            $cliAsset = $name -cmatch '^cli/(linger-computer\.exe|teamhub|teamhub\.cmd|teamhub\.exe|teamhub\.js|teamhub-assets\.json|teamhub-commands\.json|teamhub-chunks/[A-Za-z0-9_-]+\.js)$'
            $toolAsset = $name.StartsWith('cli/computer-tools/') -and (Test-LingerToolPath $name)
            if (($name -notin $required -and $name -notin $LingerManagedToolEntries -and -not $cliAsset -and -not $toolAsset) -or $found.ContainsKey($name) -or ($prefix -and -not $toolAsset) -or
                $header[156] -notin @(0, 48) -or $sizeText -notmatch '^[0-7]+$' -or
                $checksumText -notmatch '^[0-7]+$' -or [Convert]::ToInt64($checksumText, 8) -ne $headerChecksum) {
                throw 'Release archive contains an invalid or unexpected entry.'
            }
            $size = [Convert]::ToInt64($sizeText, 8)
            $total += $size
            if ($size -lt 0 -or ($size -eq 0 -and -not $toolAsset) -or $total -gt 536870912) { throw 'Release archive size is invalid.' }
            $output = $null
            if ($name -in $required) {
                $file = Join-Path $Destination $name
                New-LingerDirectory ([IO.Path]::GetDirectoryName($file))
                $output = [IO.File]::Open((Get-LingerFullPath $file), [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            }
            try {
                $remaining = $size
                while ($remaining -gt 0) {
                    $count = [int][Math]::Min($remaining, $buffer.Length)
                    Read-LingerExact $gzip $buffer $count
                    if ($output) { $output.Write($buffer, 0, $count) }
                    $remaining -= $count
                }
            } finally { if ($output) { $output.Dispose() } }
            $padding = [int]((512 - ($size % 512)) % 512)
            if ($padding -gt 0) { Read-LingerExact $gzip $buffer $padding }
            if ($output) { Assert-LingerPath $file $false }
            $found[$name] = $true
            if ($redraw.ElapsedMilliseconds -ge 250) { $redraw.Restart(); Update-LingerStep }
        }
        foreach ($name in $required) { if (-not $found.ContainsKey($name)) { throw "Release archive is missing $name" } }
        while (($count = $gzip.Read($buffer, 0, $buffer.Length)) -gt 0) {
            for ($index = 0; $index -lt $count; $index++) { if ($buffer[$index] -ne 0) { throw 'Release archive has trailing content.' } }
        }
    } finally { $gzip.Dispose(); $sourceStream.Dispose() }
}

function Test-LingerToolPath([string]$Name) {
    if (-not $Name -or $Name -match '[\\:\x00-\x1f]') { return $false }
    foreach ($part in $Name.Split('/')) { if (-not $part -or $part -eq '.' -or $part -eq '..') { return $false } }
    return $true
}

function Get-LingerComputerToolEntries([string]$Bundle) {
    $root = Join-Path $Bundle 'cli/computer-tools'
    if (-not (Test-Path -LiteralPath (Get-LingerFullPath $root))) { return @() }
    Assert-LingerPath $root $true
    $manifest = (Read-LingerPrivateText (Join-Path $root 'manifest.json')) | ConvertFrom-Json
    if ($manifest.schema_version -ne 1 -or -not $manifest.assets -or
        $manifest.playwright_entry -cne 'node_modules/@playwright/mcp/cli.js' -or $manifest.pi_extension -cne 'extensions/pi-mcp.mjs' -or
        $manifest.cua_entry -cne 'cua/cua-driver.exe' -or $manifest.artifact_sha256 -cnotmatch '^[0-9a-f]{64}$') { throw 'Invalid Computer tool manifest.' }
    $seen = @{}
    $names = @('manifest.json')
    foreach ($asset in $manifest.assets) {
        if ($asset.path -isnot [string] -or -not (Test-LingerToolPath $asset.path) -or $seen.ContainsKey($asset.path)) { throw 'Invalid Computer tool asset path.' }
        $seen[$asset.path] = $true
        $names += $asset.path
    }
    if (-not $seen.ContainsKey($manifest.playwright_entry) -or -not $seen.ContainsKey($manifest.pi_extension) -or -not $seen.ContainsKey($manifest.cua_entry)) { throw 'Computer tool entrypoint is missing.' }
    # Match JavaScript ordinal ordering in the installed bundle checksum.
    [Array]::Sort($names, [StringComparer]::Ordinal)
    return @($names | ForEach-Object { 'cli/computer-tools/' + $_ })
}

function Get-LingerBundleEntries([string]$Bundle) {
    $entries = @('cli/linger-computer.exe', 'daemon/linger-computer-daemon.exe', 'runtime/bin/node.exe', 'runtime/LICENSE')
    $tools = @(Get-LingerComputerToolEntries $Bundle)
    $manifestFile = Join-Path $Bundle 'cli/teamhub-assets.json'
    if (-not (Test-Path -LiteralPath (Get-LingerFullPath $manifestFile))) { return @($entries) + @($tools) }
    $entries += @($LingerManagedToolEntries | Where-Object { Test-Path -LiteralPath (Get-LingerFullPath (Join-Path $Bundle $_)) })
    $manifest = (Read-LingerPrivateText $manifestFile) | ConvertFrom-Json
    if ($manifest.schema_version -ne 1 -or $manifest.entrypoint -cne 'teamhub.js' -or
        -not $manifest.assets -or $manifest.artifact_sha256 -cnotmatch '^[0-9a-f]{64}$') {
        throw 'Release CLI asset manifest is invalid.'
    }
    $nativeEntry = 'cli/teamhub.exe'
    if (-not (Test-Path -LiteralPath (Get-LingerFullPath (Join-Path $Bundle $nativeEntry)))) { $nativeEntry = 'cli/teamhub.cmd' }
    $entries += @('cli/teamhub', $nativeEntry, 'cli/teamhub-assets.json')
    # Bundles before Computer 0.30.11 lack the command manifest.
    if (Test-Path -LiteralPath (Get-LingerFullPath (Join-Path $Bundle 'cli/teamhub-commands.json'))) { $entries += 'cli/teamhub-commands.json' }
    $seen = @{}
    $hasEntry = $false
    $hasChunk = $false
    foreach ($asset in $manifest.assets) {
        if ($asset.path -isnot [string] -or $asset.path -cnotmatch '^(teamhub\.js|teamhub-chunks/[A-Za-z0-9_-]+\.js)$' -or
            $seen.ContainsKey($asset.path)) { throw 'Release CLI asset manifest is invalid.' }
        $seen[$asset.path] = $true
        if ($asset.path -ceq 'teamhub.js') { $hasEntry = $true } else { $hasChunk = $true }
        $entries += 'cli/' + $asset.path
    }
    if (-not $hasEntry -or -not $hasChunk) { throw 'Release CLI asset manifest is incomplete.' }
    return @($entries) + @($tools)
}

function Get-LingerInstalledBundle([string]$Root, [string]$RecoveryBundle = '', [string]$RecoveryChecksum = '') {
    $bundle = $RecoveryBundle
    if (-not $bundle) {
        $pointer = Join-Path $Root 'active-bundle'
        if (-not (Test-Path -LiteralPath $pointer)) { return $null }
        $name = (Read-LingerPrivateText $pointer).Trim()
        if ($name -notmatch '^lib-[0-9a-f]{16}-[0-9a-f-]+$') { throw 'Installed bundle pointer is invalid.' }
        $bundle = Join-Path $Root $name
    }
    Assert-LingerPath $bundle $true
    $sha = [Security.Cryptography.SHA256]::Create()
    $buffer = New-Object byte[] 65536
    $redraw = [Diagnostics.Stopwatch]::StartNew()
    try {
        foreach ($entry in (Get-LingerBundleEntries $bundle)) {
            if ($redraw.ElapsedMilliseconds -ge 250) { $redraw.Restart(); Update-LingerStep }
            $file = Join-Path $bundle $entry
            if (-not $entry.StartsWith('cli/computer-tools/')) { Assert-LingerPath $file $false }
            $prefix = $LingerUtf8.GetBytes($entry + [char]0)
            $null = $sha.TransformBlock($prefix, 0, $prefix.Length, $prefix, 0)
            $stream = [IO.File]::OpenRead((Get-LingerFullPath $file))
            try {
                while (($count = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) { $null = $sha.TransformBlock($buffer, 0, $count, $buffer, 0) }
            } finally { $stream.Dispose() }
        }
        $null = $sha.TransformFinalBlock((New-Object byte[] 0), 0, 0)
        $actual = ([BitConverter]::ToString($sha.Hash)).Replace('-', '').ToLowerInvariant()
    } finally { $sha.Dispose() }
    $expected = $RecoveryChecksum
    if (-not $expected) { $expected = (Read-LingerPrivateText (Join-Path $Root 'installed-bundle-checksum')).Trim() }
    if ($expected -notmatch '^[0-9a-f]{64}$' -or $actual -cne $expected) { throw 'Installed bundle integrity verification failed.' }
    return $bundle
}

# The name a Web origin installs under, derived as install-linger-computer.sh
# does: the host's first label without "-linger", "local" for loopback,
# or the dashed address for an IP, plus any non-default port.
function Get-LingerEnvironmentName([string]$Origin) {
    $uri = [Uri]$Origin
    $hostName = $uri.Host.ToLowerInvariant()
    if ($hostName -in @('localhost', '127.0.0.1', '[::1]') -or $hostName.EndsWith('.localhost')) { $name = 'local' }
    elseif ($hostName.StartsWith('[')) { $name = 'ip-' + ($hostName.Trim('[', ']') -replace '[:.]', '-') }
    elseif ($hostName -match '^[0-9.]+$') { $name = 'ip-' + ($hostName -replace '\.', '-') }
    else {
        $name = $hostName.Split('.')[0]
        if ($name -ne 'linger' -and $name.EndsWith('-linger')) { $name = $name.Substring(0, $name.Length - '-linger'.Length) }
    }
    if (-not $uri.IsDefaultPort) { $name = $name + '-' + $uri.Port }
    return $name
}

$LingerDownloadBase = $env:LINGER_COMPUTER_DOWNLOAD_BASE_URL
if (-not $LingerDownloadBase) { $LingerDownloadBase = $LingerRelease.downloadBaseUrl }
$LingerWebOrigin = $env:LINGER_WEB_URL
if (-not $LingerWebOrigin) { $LingerWebOrigin = $LingerRelease.webOrigin }
# Each Web origin is its own environment with its own install root and its own
# command, linger-computer-<environment>, so Computers of several deployments
# can share one Windows account. linger-computer runs the environment when it
# is the only one installed and lists them otherwise.
$LingerCommandName = 'linger-computer-' + (Get-LingerEnvironmentName $LingerWebOrigin)
if (-not $env:LOCALAPPDATA -and (-not $env:LINGER_COMPUTER_DATA_DIR -or -not $env:LINGER_COMPUTER_BIN_DIR)) { throw 'LOCALAPPDATA is required.' }
$LingerBinDirectory = $env:LINGER_COMPUTER_BIN_DIR
if (-not $LingerBinDirectory) { $LingerBinDirectory = Join-Path $env:LOCALAPPDATA 'Linger\bin' }
if (-not [IO.Path]::IsPathRooted($LingerBinDirectory) -or $LingerBinDirectory.StartsWith('\\')) { throw 'Install bin directory must be an absolute local path.' }
$LingerBinDirectory = [IO.Path]::GetFullPath($LingerBinDirectory)
$LingerDataRoot = $env:LINGER_COMPUTER_DATA_DIR
# Reinstalling an environment upgrades it where its launcher points.
$LingerLauncherConfig = Join-Path $LingerBinDirectory ($LingerCommandName + '.launcher.json')
if (-not $LingerDataRoot -and (Test-Path -LiteralPath $LingerLauncherConfig -PathType Leaf)) {
    $LingerDataRoot = ([IO.File]::ReadAllText($LingerLauncherConfig) | ConvertFrom-Json).dataRoot
}
if (-not $LingerDataRoot) { $LingerDataRoot = Join-Path $env:LOCALAPPDATA ('Linger\Computers\' + (Get-LingerEnvironmentName $LingerWebOrigin)) }
if (-not [IO.Path]::IsPathRooted($LingerDataRoot) -or $LingerDataRoot.StartsWith('\\')) { throw 'Install root must be an absolute local path.' }
$LingerDataRoot = [IO.Path]::GetFullPath($LingerDataRoot)
if ($LingerDataRoot -eq [IO.Path]::GetPathRoot($LingerDataRoot) -or $LingerDataRoot -eq $env:USERPROFILE) { throw 'Install destination is unsafe.' }
$LingerTargetRelease = $LingerRelease.targets.$LingerTarget
if (-not $LingerTargetRelease) { throw "This deployment ships no Local Computer for $LingerTarget." }
foreach ($kind in @('deps', 'app')) {
    $archive = $LingerTargetRelease.$kind
    if (-not $archive -or $archive.sha256 -cnotmatch '^[0-9a-f]{64}$' -or $archive.file -cne ($kind + '-' + $LingerTarget + '-' + $archive.sha256 + '.tar.gz')) {
        throw 'Installer release metadata is invalid.'
    }
}
New-LingerDirectory $LingerDataRoot
New-LingerDirectory $LingerBinDirectory
$LingerLockPath = Join-Path $LingerDataRoot '.install.lock'
if (Test-Path -LiteralPath $LingerLockPath) { Assert-LingerPath $LingerLockPath $false }
try { $LingerLock = [IO.File]::Open($LingerLockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
catch { throw 'Another Local Computer installation or uninstallation is active.' }
$LingerTemporary = Join-Path $LingerDataRoot ('.bootstrap-' + [Guid]::NewGuid().ToString())
$LingerProcess = $null
if ($LingerOperation -eq 'uninstall') { $LingerStepTotal = 3 }
try {
    Start-LingerStep 1 'Checking the installed version'
    New-LingerDirectory $LingerTemporary
    $LingerBootstrapRoot = $null
    $LingerBootstrapFailure = $null
    try { $LingerBootstrapRoot = Get-LingerInstalledBundle $LingerDataRoot }
    catch { $LingerBootstrapFailure = $_ }
    $journalFile = Join-Path $LingerDataRoot '.uninstall-transaction.json'
    if (-not $LingerBootstrapRoot -and (Test-Path -LiteralPath $journalFile)) {
        $journal = (Read-LingerPrivateText $journalFile) | ConvertFrom-Json
        $record = $journal.bundles | Select-Object -First 1
        if ($journal.schemaVersion -ne 1 -or $journal.snapshot -notmatch '^\.uninstall-[0-9a-f-]+$' -or
            -not $record -or $record.name -notmatch '^lib-[0-9a-f]{16}-[0-9a-f-]+$' -or $record.checksum -notmatch '^[0-9a-f]{64}$') { throw 'Uninstall recovery metadata is invalid.' }
        $recoveryBundle = Join-Path (Join-Path $LingerDataRoot $journal.snapshot) $record.name
        $LingerBootstrapRoot = Get-LingerInstalledBundle $LingerDataRoot $recoveryBundle $record.checksum
    }
    if (-not $LingerBootstrapRoot -and $LingerBootstrapFailure) {
        if ($LingerOperation -eq 'uninstall') { throw $LingerBootstrapFailure }
        Write-LingerNote 'Installed program failed integrity verification; downloading a verified package.'
    }
    $LingerBootstrapArchives = $null
    if ($LingerBootstrapRoot) {
        # The helper must not execute a Node/daemon that uninstall will delete.
        # It runs only these two programs from this copy.
        $verified = $LingerBootstrapRoot
        $LingerBootstrapRoot = Join-Path $LingerTemporary 'bundle'
        New-LingerDirectory $LingerBootstrapRoot
        foreach ($entry in @('runtime/bin/node.exe', 'daemon/linger-computer-daemon.exe')) {
            $original = Join-Path $verified $entry
            $copy = Join-Path $LingerBootstrapRoot $entry
            New-LingerDirectory ([IO.Path]::GetDirectoryName($copy))
            [IO.File]::Copy((Get-LingerFullPath $original), (Get-LingerFullPath $copy), $false)
            if ((Get-LingerChecksum $copy) -cne (Get-LingerChecksum $original)) { throw 'Bootstrap copy integrity verification failed.' }
        }
    }
    if (-not $LingerBootstrapRoot) {
        if ($LingerOperation -eq 'uninstall') {
            if ((Test-Path -LiteralPath (Join-Path $LingerBinDirectory ($LingerCommandName + '.exe'))) -or
                (Get-ChildItem -LiteralPath $LingerDataRoot -Force | Where-Object { $_.Name -match '^lib-' })) { throw 'Installed program is missing; files were preserved.' }
            if (-not $LingerPurge) { Stop-LingerStep 'not installed'; Write-LingerNote 'Local Computer is not installed.'; return }
        }
        # Uninstall downloads only the runtime it needs to stop owned processes.
        if ($LingerOperation -eq 'install') {
            if ($LingerBootstrapFailure) { Stop-LingerStep 'needs repair' } else { Stop-LingerStep 'not installed' }
            Start-LingerStep 2 'Downloading the package'
        }
        $LingerBootstrapArchives = @{}
        foreach ($kind in @('deps', 'app')) {
            $archive = Join-Path $LingerTemporary $LingerTargetRelease.$kind.file
            Receive-LingerFile ($LingerDownloadBase.TrimEnd('/') + '/files/' + $LingerTargetRelease.$kind.file) $archive
            $LingerBootstrapArchives[$kind] = $archive
        }
        if ($LingerOperation -eq 'install') { Start-LingerStep 3 'Verifying the package' }
        foreach ($kind in @('deps', 'app')) {
            if ((Get-LingerChecksum $LingerBootstrapArchives[$kind]) -cne $LingerTargetRelease.$kind.sha256) { throw 'Installer runtime bootstrap checksum verification failed.' }
        }
        $LingerBootstrapRoot = Join-Path $LingerTemporary 'bundle'
        Expand-LingerBootstrap $LingerBootstrapArchives['deps'] $LingerBootstrapRoot @('runtime/bin/node.exe', 'runtime/LICENSE')
        Expand-LingerBootstrap $LingerBootstrapArchives['app'] $LingerBootstrapRoot @('daemon/linger-computer-daemon.exe')
    }
    $LingerNode = Join-Path $LingerBootstrapRoot 'runtime\bin\node.exe'
    Assert-LingerArchitecture $LingerNode
    Assert-LingerArchitecture (Join-Path $LingerBootstrapRoot 'daemon\linger-computer-daemon.exe')
    $LingerNodeVersion = & $LingerNode --version
    if ($LASTEXITCODE -ne 0 -or $LingerNodeVersion -cne 'v26.5.0') { throw 'Bundled Node version is invalid.' }
    $helperFile = Join-Path $LingerTemporary 'installer.mjs'
    [IO.File]::WriteAllBytes($helperFile, [Convert]::FromBase64String($LingerHelperBase64))
    Assert-LingerPath $helperFile $false
    $settings = @{
        operation = $LingerOperation; purge = $LingerPurge; target = $LingerTarget
        dataRoot = $LingerDataRoot; binDirectory = $LingerBinDirectory; commandName = $LingerCommandName; configFile = $env:LINGER_COMPUTER_CONFIG
        downloadBaseUrl = $LingerDownloadBase; webOrigin = $LingerWebOrigin; release = $LingerTargetRelease
        bootstrapRoot = $LingerBootstrapRoot; bootstrapArchives = $LingerBootstrapArchives
        progress = @{ startedAt = $LingerStartedAt; step = $script:LingerStep.Number; label = $script:LingerStep.Label; stepStartedAt = $script:LingerStep.StartedAt }
    }
    # The helper continues the open step and reports its own result.
    $script:LingerStep = $null
    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = $LingerNode
    $startInfo.Arguments = '"' + $helperFile + '"'
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardInput = $true
    $LingerProcess = [Diagnostics.Process]::Start($startInfo)
    $inputBytes = $LingerUtf8.GetBytes(($settings | ConvertTo-Json -Depth 10 -Compress))
    $LingerProcess.StandardInput.BaseStream.Write($inputBytes, 0, $inputBytes.Length)
    $LingerProcess.StandardInput.Close()
    $LingerProcess.WaitForExit()
    if ($LingerProcess.ExitCode -ne 0) { throw 'Local Computer installation action failed. See the diagnostic above.' }
    if ($LingerOperation -eq 'install') {
        $LingerLauncher = Join-Path $LingerBinDirectory ($LingerCommandName + '.exe')
        $LingerCommand = $LingerCommandName
        $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
        if (($userPath -split ';') -notcontains $LingerBinDirectory) {
            [Environment]::SetEnvironmentVariable('Path', ($LingerBinDirectory + ';' + $userPath).TrimEnd(';'), 'User')
        }
        if (($env:Path -split ';') -notcontains $LingerBinDirectory) { $env:Path = $LingerBinDirectory + ';' + $env:Path }
        # Running the launcher surfaces an application control block before the user meets it.
        try { & $LingerLauncher version | Out-Null; $launchFailed = $LASTEXITCODE -ne 0 }
        catch { Write-Host $_.Exception.Message; $launchFailed = $true }
        if ($launchFailed) {
            Write-Warning "$LingerCommandName.exe could not start. If Windows reported an application control policy, Smart App Control or an App Control policy blocked this unsigned build."
        }
        $configFile = $env:LINGER_COMPUTER_CONFIG
        if (-not $configFile) { $configFile = Join-Path $LingerDataRoot 'config.json' }
        # The next step follows the real state: log in, start, or inspect.
        $nextCommand = 'login'
        if (-not $launchFailed -and (Test-Path -LiteralPath $configFile)) {
            $nextCommand = 'daemon status'
            try {
                # Windows PowerShell 5.1 turns redirected native stderr into errors under Stop.
                $output = & { $ErrorActionPreference = 'Continue'; & $LingerLauncher daemon status --json 2>$null }
                $report = ($output | Out-String) | ConvertFrom-Json
                if ($report.config.configured -eq $false) { $nextCommand = 'login' }
                elseif ($report.daemon.state -and $report.daemon.state -ne 'running') { $nextCommand = 'daemon start' }
            } catch { }
        }
        Write-Host ''
        Write-Host 'Next:'
        Write-Host "  $LingerCommand $nextCommand"
        Write-Host ''
        Write-Host 'Help:'
        Write-Host "  $LingerCommand --help"
        $environments = @(Get-ChildItem -LiteralPath $LingerBinDirectory -Filter 'linger-computer-*.launcher.json' | ForEach-Object {
                $command = $_.Name.Substring(0, $_.Name.Length - '.launcher.json'.Length)
                $origin = ''
                try { $origin = ([IO.File]::ReadAllText((Join-Path ([IO.File]::ReadAllText($_.FullName) | ConvertFrom-Json).dataRoot 'web-origin'))).Trim() } catch { }
                [pscustomobject]@{ Command = $command; Origin = $origin }
            })
        $dispatcherManaged = Test-Path -LiteralPath (Join-Path $LingerBinDirectory 'linger-computer.exe')
        Write-Host ''
        if ($environments.Count -gt 1) {
            Write-Host "This computer has Linger Computer for $($environments.Count) environments, each with its own command:"
            foreach ($environment in $environments) {
                $note = ''
                if ($environment.Command -eq $LingerCommandName) { $note = '  (this installation)' }
                Write-Host ('  {0,-34} {1}{2}' -f $environment.Command, $environment.Origin, $note)
            }
            if ($dispatcherManaged) { Write-Host 'linger-computer alone lists them instead of choosing one.' }
        } elseif ($dispatcherManaged) {
            Write-Host 'While this is the only environment on this computer, linger-computer runs it too.'
        }
    }
} catch {
    Stop-LingerStep 'FAILED'
    throw
} finally {
    # Do not release the installer lock while its child is still mutating files.
    if ($LingerProcess) {
        if (-not $LingerProcess.HasExited) { $LingerProcess.WaitForExit() }
        $LingerProcess.Dispose()
    }
    if (Test-Path -LiteralPath (Get-LingerFullPath $LingerTemporary)) { Remove-Item -LiteralPath (Get-LingerFullPath $LingerTemporary) -Recurse -Force }
    $LingerLock.Dispose()
}
