import path from "node:path";
import { runProcess } from "./process.js";

// The program is fixed. Only a path and operation travel over stdin; no file
// contents, user-controlled PowerShell, or credentials appear in argv/output.
export const WINDOWS_PRIVATE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $system = 'S-1-5-18'; $admins = 'S-1-5-32-544'
  $item = Get-Item -LiteralPath $request.path -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or ($item.PSIsContainer -ne ($request.kind -eq 'directory'))) { throw 'Unsafe type' }
  $acl = Get-Acl -LiteralPath $item.FullName
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Unsafe owner' }
  $parent = $item.Directory
  if ($item.PSIsContainer) { $parent = $item.Parent }
  while ($parent) {
    if ($parent.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unsafe parent link' }
    $parentAcl = Get-Acl -LiteralPath $parent.FullName
    $owner = $parentAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($owner -notin @($sid.Value, $system, $admins, 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')) { throw 'Unsafe parent owner' }
    foreach ($rule in $parentAcl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
      # InheritOnly ACEs do not authorize mutation of this ancestor. They are
      # still checked below when present on the private target itself.
      if ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) { continue }
      if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin @($sid.Value, $system, $admins, 'S-1-3-0', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464') -and
          ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]'Delete,DeleteSubdirectoriesAndFiles,ChangePermissions,TakeOwnership')) { throw 'Unsafe parent permissions' }
    }
    $parent = $parent.Parent
  }
  if ($request.repair) {
    $acl = if ($item.PSIsContainer) { [Security.AccessControl.DirectorySecurity]::new() } else { [Security.AccessControl.FileSecurity]::new() }
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($principal in @($sid, [Security.Principal.SecurityIdentifier]::new($system))) {
      $rule = if ($item.PSIsContainer) {
        [Security.AccessControl.FileSystemAccessRule]::new($principal, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
      } else { [Security.AccessControl.FileSystemAccessRule]::new($principal, 'FullControl', 'Allow') }
      $acl.AddAccessRule($rule)
    }
    # DACL-only persistence avoids Set-Acl's SACL privilege requirement.
    $null = $acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
    if ($PSVersionTable.PSEdition -eq 'Core') { [IO.FileSystemAclExtensions]::SetAccessControl($item, $acl) } else { $item.SetAccessControl($acl) }
    $acl = Get-Acl -LiteralPath $item.FullName
  }
  if ($request.kind -eq 'directory' -and !$acl.AreAccessRulesProtected) { throw 'Inherited private permissions' }
  $currentAllowed = $false
  foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq 'Allow') {
      if ($rule.IdentityReference.Value -notin @($sid.Value, $system)) { throw 'Non-private permissions' }
      if ($rule.IdentityReference.Value -eq $sid.Value) { $currentAllowed = $true }
    }
  }
  if (!$currentAllowed) { throw 'Missing owner access' }
  exit 0
} catch { exit 1 }
`;
export async function windowsPrivatePath(
  file: string,
  kind: "file" | "directory",
  repair = false,
  run: typeof runProcess = runProcess,
): Promise<void> {
  const result = await run(
    path.win32.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(WINDOWS_PRIVATE_SCRIPT, "utf16le").toString("base64"),
    ],
    {
      input: JSON.stringify({ path: path.resolve(file), kind, repair }),
      timeoutMs: 30000,
    },
  );
  if (result.code !== 0)
    throw new Error(
      "Windows private path validation failed; use a current-user owned local directory without links or shared access.",
    );
}
