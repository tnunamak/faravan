# Pure pack tests. No Windows APIs or installed product code run here.
param(
    [string]$Runner, [string]$Work, [string]$Node,
    [ValidateSet('EncodingWrite','EncodingRead','RetainedData')][string]$Mode
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$tokens = $null; $parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Runner, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Runner must parse before regression tests.' }
foreach ($name in @('Read-JsonFile','Write-JsonFile','Invoke-Utf8Process','Get-RetainedInventory','Assert-RetainedInventory')) {
    $definition = $ast.Find({ param($item) $item -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $item.Name -eq $name }, $true)
    . ([scriptblock]::Create($definition.Extent.Text))
}
function Assert-FixtureEqual($Actual, $Expected) {
    if ($Actual -ne $Expected) { throw "Expected '$Expected', received '$Actual'" }
}
function Assert-RetentionRejected($Inventory, [string]$Expected) {
    try { Assert-RetainedInventory $Inventory } catch {
        if ($_.Exception.Message -like "*$Expected*") { return }
        throw
    }
    throw "Expected retention rejection: $Expected"
}
if ($Mode -like 'Encoding*') {
    $candidate = Read-JsonFile (Join-Path $Work 'candidate.json')
    $receiptFile = Join-Path $Work 'unicode-receipt.json'
    if ($Mode -eq 'EncodingWrite') {
        Assert-FixtureEqual $candidate.output $Work
        $jsonOutput = Invoke-Utf8Process -Executable $Node -Arguments @((Join-Path $Work 'unicode-output.mjs'), $candidate.evidence) -StdoutPath (Join-Path $Work 'native.stdout.json') -StderrPath (Join-Path $Work 'native.stderr.log')
        $native = $jsonOutput | ConvertFrom-Json
        Assert-FixtureEqual $native.path $candidate.evidence
        Write-JsonFile -Path $receiptFile -Value $candidate
        # This demonstrates why ANSI decoding is unsafe; it does not emulate Windows PowerShell.
        $bytes = [Text.Encoding]::UTF8.GetBytes($Work)
        if ([Text.Encoding]::GetEncoding(1252).GetString($bytes) -eq $Work) { throw 'Fixture must contain non-ASCII path characters.' }
        Write-Output 'PASS UTF-8 candidate read, native stdout/stderr decoding and receipt write'
    } else {
        $receipt = Read-JsonFile $receiptFile
        Assert-FixtureEqual $receipt.artifact $candidate.artifact
        Assert-FixtureEqual $receipt.output $Work
        Assert-FixtureEqual $receipt.evidence $candidate.evidence
        $native = Read-JsonFile (Join-Path $Work 'native.stdout.json')
        Assert-FixtureEqual $native.path $candidate.evidence
        Assert-FixtureEqual ((Get-Content -LiteralPath (Join-Path $Work 'native.stderr.log') -Raw -Encoding UTF8).Trim()) $candidate.evidence
        Assert-FixtureEqual (Test-Path -LiteralPath $receipt.artifact -PathType Leaf) $true
        Assert-FixtureEqual (Test-Path -LiteralPath $receipt.evidence -PathType Leaf) $true
        Write-JsonFile -Path $receiptFile -Value $receipt
        Write-Output 'PASS UTF-8 paths survive a second PowerShell invocation'
    }
} else {
    $data = Join-Path $Work 'retained'
    $keyOnly = Join-Path $Work 'only-device-key'
    $null = New-Item -ItemType Directory -Path $data, $keyOnly
    $files = @('device.pem','state.json','app-settings.json','history-export.json','result.txt','coordinator.sqlite') | ForEach-Object {
        $path = Join-Path $data $_
        Write-JsonFile -Path $path -Value @{ fixture = $_ }
        [pscustomobject]@{ path = $path; comparison = if ($_ -eq 'coordinator.sqlite') { 'exists' } else { 'sha256' } }
    }
    $before = @(Get-RetainedInventory $files)
    Assert-RetainedInventory $before
    # Construct the review's key-only survivor counterexample without deleting any file.
    Copy-Item -LiteralPath (Join-Path $data 'device.pem') -Destination $keyOnly
    $onlyKeyInventory = @($before | ForEach-Object {
        [pscustomobject]@{ path = Join-Path $keyOnly ([IO.Path]::GetFileName($_.path)); comparison = $_.comparison; sha256 = $_.sha256 }
    })
    Assert-RetentionRejected $onlyKeyInventory 'Missing retained file after uninstall'
    foreach ($name in @('state.json','app-settings.json','history-export.json','result.txt')) {
        $path = Join-Path $data $name
        $original = Read-JsonFile $path
        Write-JsonFile -Path $path -Value @{ altered = $true }
        Assert-RetentionRejected $before 'Retained file changed after uninstall'
        Write-JsonFile -Path $path -Value $original
    }
    # SQLite may checkpoint during shutdown. Its declared existence check permits byte changes.
    Write-JsonFile -Path (Join-Path $data 'coordinator.sqlite') -Value @{ checkpointed = $true }
    Assert-RetainedInventory $before
    Write-Output 'PASS retained state/settings/history/results hashes and coordinator existence; key-only survivors and altered files rejected'
}
