<#
  Pins that `irm .../install.ps1 | iex` leaves the caller's session as it found it.

  The advertised install runs the script text through Invoke-Expression, in the
  caller's own scope. Before the body was wrapped in its own script block, a
  failed install left the session with $ErrorActionPreference = 'Stop',
  Set-StrictMode -Version Latest switched on, and $repo, $base, $temp and the
  Test-NodeVersion function defined. This runs the installer exactly that way,
  with node removed from PATH so it fails at its first check, offline and before
  anything is downloaded or written, and then compares the session with a
  snapshot taken before.

    pwsh -NoProfile -File scripts/test-install-scope.ps1
    powershell -NoProfile -File scripts/test-install-scope.ps1
#>
$installer = Join-Path $PSScriptRoot '..\install.ps1'
$script = Get-Content -Raw -Path $installer

$ErrorActionPreference = 'Continue'
Set-StrictMode -Off
$eapBefore = $ErrorActionPreference
$pathBefore = $env:Path
$names = 'repo', 'base', 'temp', 'bundleUrl', 'checksumUrl', 'Version', 'InstallDir', 'NoLaunch'

$failed = $null
$env:Path = ''
try { Invoke-Expression $script } catch { $failed = $_ }
finally { $env:Path = $pathBefore }

$problems = @()
if (-not $failed -or "$failed" -notmatch 'Node\.js 20 or newer is required') {
  $problems += "the installer did not stop at the Node.js check as this test expects: $failed"
}
if ($ErrorActionPreference -ne $eapBefore) {
  $problems += "`$ErrorActionPreference changed from $eapBefore to $ErrorActionPreference"
}
$strict = $true
try { $null = $thisVariableIsNeverDefined; $strict = $false } catch { }
if ($strict) { $problems += 'Set-StrictMode was left on in the caller session' }
foreach ($name in $names) {
  if (Get-Variable -Name $name -Scope Global -ErrorAction SilentlyContinue) {
    $problems += "variable `$$name leaked into the caller session"
  }
}
if (Get-Command Test-NodeVersion -ErrorAction SilentlyContinue) {
  $problems += 'function Test-NodeVersion leaked into the caller session'
}

if ($problems.Count) {
  $problems | ForEach-Object { Write-Host "FAIL: $_" -ForegroundColor Red }
  exit 1
}
Write-Host "install.ps1 through Invoke-Expression leaves the caller session unchanged ($($PSVersionTable.PSVersion))"
exit 0
