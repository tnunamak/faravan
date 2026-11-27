import {execFileSync} from 'node:child_process';

/** Read Windows process details from CIM. A missing or inaccessible process is unknown. */
export function readWindowsProcess(pid, {execFile = execFileSync, fullPrecision = false} = {}) {
  const command = fullPrecision
    ? "$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter 'ProcessId="+pid+"'; if (-not $p) { throw 'Process unavailable' }; $os=Get-CimInstance Win32_OperatingSystem; [pscustomobject]@{ExecutablePath=$p.ExecutablePath; CommandLine=$p.CommandLine; CreationDate=$p.CreationDate.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture); Boot=$os.LastBootUpTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)} | ConvertTo-Json -Compress"
    : `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object CommandLine,ExecutablePath,CreationDate | ConvertTo-Json -Compress`;
  const args = ['-NoProfile', '-NonInteractive', '-Command',
    command];
  let output;
  try {
    output = execFile('powershell.exe', args,
      {encoding:'utf8', timeout:5000, windowsHide:true, stdio:['ignore','pipe','ignore']});
  } catch (error) {
    if (error.code !== 'ETIMEDOUT') throw error;
    // One retry handles a cold PowerShell start; further uncertainty fails closed.
    output = execFile('powershell.exe', args,
      {encoding:'utf8', timeout:5000, windowsHide:true, stdio:['ignore','pipe','ignore']});
  }
  const info = JSON.parse(output);
  if (!info || typeof info !== 'object' || Array.isArray(info)) return null;
  return info;
}

export function readWindowsProcessCreationIdentity(pid, options) {
  const info = readWindowsProcess(pid, options);
  return typeof info?.CreationDate === 'string' && info.CreationDate ? info.CreationDate : null;
}
