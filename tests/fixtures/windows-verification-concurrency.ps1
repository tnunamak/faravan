# Pure receipt-protocol fixture. Barrier messages use stdin/stdout, never timing.
param([string]$Runner, [string]$Work, [ValidateSet('Writer','Signer')][string]$Role, [switch]$WithoutLock)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$tokens = $null; $parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Runner, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Runner must parse before concurrency tests.' }
$functions = @('Read-JsonFile','Write-JsonFile','Save-Receipt','Invoke-ManualSignOff')
if (-not $WithoutLock) { $functions += 'Enter-ReceiptLock' }
foreach ($name in $functions) {
    $definition = $ast.Find({ param($item) $item -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $item.Name -eq $name }, $true)
    if (-not $definition) { throw "Missing runner function: $name" }
    . ([scriptblock]::Create($definition.Extent.Text))
}
function Send-Barrier([string]$Message) {
    [Console]::Out.WriteLine($Message)
    [Console]::Out.Flush()
}
function Receive-Barrier([string]$Expected) {
    if ([Console]::ReadLine() -ne $Expected) { throw "Expected barrier: $Expected" }
}
$receiptPath = Join-Path $Work 'receipt.json'
$runDirectory = Join-Path $Work $Role
$null = New-Item -ItemType Directory -Path $runDirectory
$candidateHash = 'b' * 64
$receiptLock = $null
try {
    if (-not $WithoutLock) {
        if ($Role -eq 'Signer') {
            try { $receiptLock = Enter-ReceiptLock $Work } catch {
                if ($_.Exception.Message -notlike '*Cannot open exclusive receipt lock*') { throw }
                Send-Barrier 'SIGNER_BUSY'
                Receive-Barrier 'RETRY'
                $receiptLock = Enter-ReceiptLock $Work
            }
        } else { $receiptLock = Enter-ReceiptLock $Work }
    }
    $state = Read-JsonFile $receiptPath
    if ($Role -eq 'Writer') {
        Send-Barrier 'WRITER_LOADED'
        Receive-Barrier 'FAIL'
        $state.checks[0].result = 'fail'
        $state.history = @([pscustomobject]@{ id = 'WIN-04'; phase = 'Inspect'; result = 'fail' })
        Save-Receipt
        Send-Barrier 'FAILURE_WRITTEN'
        Receive-Barrier 'RELEASE'
    } else {
        Send-Barrier ('SIGNER_LOADED_' + $state.checks[0].result)
        Receive-Barrier 'COMMIT'
        Invoke-ManualSignOff -EvidencePath (Join-Path $Work 'manual.json') -Signer 'Concurrency fixture only'
        Save-Receipt
        Send-Barrier ('SIGNER_SAVED_' + $state.verdict)
    }
} finally {
    if ($receiptLock) { $receiptLock.Dispose() }
}
