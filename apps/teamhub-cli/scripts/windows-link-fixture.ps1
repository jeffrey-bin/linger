# Run Prepare as the test user, Links as an administrator with symlink rights,
# then set LINGER_TEST_WINDOWS_FILE_LINKS to Root and run the two
# windows-precreated-{file-executor,resources}.test.ts files as the test user.
# Run Clean as the test user after the tests. Use a new Root for each run.
param(
  [Parameter(Mandatory = $true)][ValidateSet('Prepare', 'Links', 'Clean')][string]$Action,
  [Parameter(Mandatory = $true)][string]$Root
)
$ErrorActionPreference = 'Stop'
if (-not [IO.Path]::IsPathRooted($Root)) { throw 'Root must be absolute.' }
if ($Action -eq 'Prepare') {
  if (Test-Path -LiteralPath $Root) { throw 'Root already exists.' }
  New-Item -ItemType Directory -Path $Root | Out-Null
  [IO.File]::WriteAllText((Join-Path $Root '.teamhub-link-fixture'), 'teamhub-test-fixture-v1')
  foreach ($directory in @('env/nested', 'env-production/nested', 'env-example/nested', 'node-modules/nested/node_modules', 'tracked', 'tracked-original', 'message/.teamhub', 'skill/playground/skills/example', 'workspace/work', 'standalone')) {
    New-Item -ItemType Directory -Path (Join-Path $Root $directory) -Force | Out-Null
  }
  foreach ($name in @('env/nested/.env', 'env-production/nested/.env.production', 'env-example/nested/.env.example', 'node-modules/nested/node_modules/private.txt', 'message/.teamhub/private.pdf', 'message/valid.pdf', 'skill/outside.txt', 'workspace/secret')) {
    [IO.File]::WriteAllText((Join-Path $Root $name), 'fixture')
  }
  [IO.File]::WriteAllText((Join-Path $Root 'tracked/actual.md'), 'original')
  [IO.File]::WriteAllText((Join-Path $Root 'tracked-original/actual.md'), 'original')
  [IO.File]::WriteAllText((Join-Path $Root 'standalone/target'), 'fixture')
  [IO.File]::WriteAllText((Join-Path $Root 'skill/playground/skills/example/SKILL.md'), "---`nname: example`ndescription: Example`n---`ntext`n")
} elseif ($Action -eq 'Links') {
  if ((Get-Content -LiteralPath (Join-Path $Root '.teamhub-link-fixture') -Raw) -ne 'teamhub-test-fixture-v1') { throw 'Fixture marker mismatch.' }
  foreach ($pair in @(@('env/public.txt', 'env/nested/.env'), @('env-production/public.txt', 'env-production/nested/.env.production'), @('env-example/public.txt', 'env-example/nested/.env.example'), @('node-modules/public.txt', 'node-modules/nested/node_modules/private.txt'), @('tracked/prepared-link', 'tracked/actual.md'), @('tracked-original/prepared-link', 'tracked-original/actual.md'), @('message/alias.pdf', 'message/.teamhub/private.pdf'), @('skill/playground/skills/example/linked.txt', 'skill/outside.txt'), @('workspace/work/shortcut', 'workspace/secret'), @('workspace/shortcut-original', 'workspace/secret'), @('standalone/skill', 'standalone/target'), @('standalone/publication', 'standalone/target'))) {
    New-Item -ItemType SymbolicLink -Path (Join-Path $Root $pair[0]) -Target (Join-Path $Root $pair[1]) | Out-Null
  }
} else {
  $item = Get-Item -LiteralPath $Root -Force
  if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Root must be a regular directory.' }
  if ((Get-Content -LiteralPath (Join-Path $Root '.teamhub-link-fixture') -Raw) -ne 'teamhub-test-fixture-v1') { throw 'Fixture marker mismatch.' }
  Remove-Item -LiteralPath $Root -Recurse -Force
}
