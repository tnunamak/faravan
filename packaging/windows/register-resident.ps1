param([Parameter(Mandatory=$true)][string]$Layout)
$ErrorActionPreference = 'Stop'
$node = Join-Path $Layout 'app\runtime\node.exe'
$resident = Join-Path $Layout 'app\lib\v1\resident.mjs'
$tray = Join-Path $Layout 'faravan-tray.exe'
# Explicit launch clears Quit. Task Scheduler retries always use --background.
& $node $resident --enable
if ($LASTEXITCODE -ne 0) { throw 'Could not save the Faravan launch intent.' }
# MSIX version directories change on update. The task resolves the installed
# package each time and removes itself when that package has been uninstalled.
$package = Get-AppxPackage | Where-Object InstallLocation -eq $Layout | Select-Object -First 1
$family = if ($package) { $package.PackageFamilyName.Replace("'", "''") } else { '' }
$savedLayout = $Layout.Replace("'", "''")
$script = @'
$ErrorActionPreference = 'Stop'
$family = '__FAMILY__'
$layout = '__LAYOUT__'
if ($family) {
  $package = Get-AppxPackage | Where-Object PackageFamilyName -eq $family | Select-Object -First 1
  if ($package) { $layout = $package.InstallLocation } else { $layout = '' }
}
if (-not $layout -or -not (Test-Path (Join-Path $layout 'app\lib\v1\resident.mjs'))) {
  Unregister-ScheduledTask -TaskName 'Faravan-resident' -Confirm:$false
  exit 0
}
& (Join-Path $layout 'app\runtime\node.exe') (Join-Path $layout 'app\lib\v1\resident.mjs') --background --tray (Join-Path $layout 'faravan-tray.exe')
exit $LASTEXITCODE
'@
$script = $script.Replace('__FAMILY__', $family).Replace('__LAYOUT__', $savedLayout)
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
$action = New-ScheduledTaskAction -Execute (Join-Path $PSHOME 'powershell.exe') -Argument ('-NoProfile -NonInteractive -EncodedCommand ' + $encoded)
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'Faravan-resident' -Action $action -Principal $principal -Trigger $trigger -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName 'Faravan-resident'
