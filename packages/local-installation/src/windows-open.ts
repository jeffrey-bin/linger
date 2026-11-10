import { runProcess } from "./process.js";
// The target is stdin data, never PowerShell source or a process argument.
const script = `$ErrorActionPreference='Stop';[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);try{$target=([Console]::In.ReadToEnd() | ConvertFrom-Json);$info=[Diagnostics.ProcessStartInfo]::new();$info.FileName=[string]$target;$info.UseShellExecute=$true;$null=[Diagnostics.Process]::Start($info);exit 0}catch{exit 1}`;
export async function openWindowsTarget(
  target: string,
  options: { signal?: AbortSignal; run?: typeof runProcess } = {},
) {
  const result = await (options.run ?? runProcess)(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { signal: options.signal, timeoutMs: 15000, input: JSON.stringify(target) },
  );
  if (result.code !== 0)
    throw new Error("Windows could not open the requested page");
}
