# Receipt logic tests only. These do not call Windows APIs or generate native acceptance evidence.
param([string]$Runner, [string]$Work)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Runner, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Runner must parse before receipt tests.' }
foreach ($name in @('Read-JsonFile','Write-JsonFile','Save-Receipt','Invoke-Check','Invoke-ManualSignOff')) {
    $definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
    . ([scriptblock]::Create($definition.Extent.Text))
}
$runDirectory = $Work
$receiptPath = Join-Path $Work 'fixture-receipt.json'
$candidateHash = 'b' * 64
$Phase = 'Inspect'
$Operator = 'Receipt unit test fixture'
$ManualEvidence = Join-Path $Work 'fixture-manual.json'
$evidencePath = Join-Path $Work 'fixture-evidence.txt'
'fixture evidence, not Windows observations' | Set-Content -LiteralPath $evidencePath -Encoding UTF8
$state = [pscustomobject]@{ runId = 'fixture-run'; checks = @(
    [pscustomobject]@{ id = 'WIN-04'; phase = 'Inspect'; result = 'not yet run'; logPaths = @(); evidence = @(); observedAt = $null },
    [pscustomobject]@{ id = 'WIN-04'; phase = 'Review'; result = 'not yet run'; logPaths = @(); evidence = @(); observedAt = $null },
    [pscustomobject]@{ id = 'WIN-05'; phase = 'Review'; result = 'not yet run'; logPaths = @(); evidence = @(); observedAt = $null })
    verdict = 'incomplete'; runtimeError = $null; history = @(); signOff = $null }

function Assert-ReceiptValue($Actual, $Expected) {
    if ($Actual -ne $Expected) { throw "Expected '$Expected', received '$Actual'" }
}
function Assert-ReceiptRejection([string]$Expected) {
    try { Invoke-ManualSignOff -EvidencePath $ManualEvidence -Signer $Operator } catch {
        if ($_.Exception.Message -like "*$Expected*") { return }
        throw
    }
    throw "Expected rejection containing: $Expected"
}
function Write-FixtureManual($RunId, $Hash, $Observations) {
    [pscustomobject]@{ runId = $RunId; candidateSha256 = $Hash; observations = $Observations } |
        ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $ManualEvidence -Encoding UTF8
}
$observed = [pscustomobject]@{ id = 'WIN-04'; result = 'pass'; notes = 'fixture only'
    observedAt = '2026-10-28T00:00:00Z'; evidence = @($evidencePath) }
Save-Receipt
Assert-ReceiptValue $state.verdict 'incomplete'
Invoke-Check 'WIN-04' { throw 'fixture first-run failure' }
Assert-ReceiptValue $state.checks[0].result 'fail'
Assert-ReceiptValue $state.verdict 'fail'
Assert-ReceiptValue $state.history.Count 1
$failureLog = $state.history[-1].logPath
Invoke-Check 'WIN-04' { 'later diagnostic success' }
Assert-ReceiptValue $state.checks[0].result 'fail'
Assert-ReceiptValue $state.history[-1].result 'pass'
Assert-ReceiptValue $state.verdict 'fail'
Assert-ReceiptValue ((Get-Content -LiteralPath $failureLog -Raw -Encoding UTF8).Contains('fixture first-run failure')) $true
$state = Read-JsonFile $receiptPath
Save-Receipt
Assert-ReceiptValue $state.verdict 'fail'
Write-FixtureManual 'wrong-run' $candidateHash @($observed)
Assert-ReceiptRejection 'another run/build'
Write-FixtureManual 'fixture-run' ('c' * 64) @($observed)
Assert-ReceiptRejection 'another run/build'
Write-FixtureManual 'fixture-run' $candidateHash @($observed, $observed)
Assert-ReceiptRejection 'Duplicate'
$observed.evidence = @()
Write-FixtureManual 'fixture-run' $candidateHash @($observed)
Assert-ReceiptRejection 'evidence file paths'
$observed.evidence = @($evidencePath)
$observed.observedAt = 'not a timestamp'
Write-FixtureManual 'fixture-run' $candidateHash @($observed)
Assert-ReceiptRejection 'timestamp'
$observed.observedAt = '2026-10-28T00:00:00Z'
$unknown = [pscustomobject]@{ id = 'WIN-99'; result = 'pass'; notes = 'fixture'; observedAt = $observed.observedAt; evidence = @($evidencePath) }
Write-FixtureManual 'fixture-run' $candidateHash @($observed, $unknown)
Assert-ReceiptRejection 'Unknown'
Assert-ReceiptValue $state.checks[1].result 'not yet run'
Write-FixtureManual 'fixture-run' $candidateHash @($observed)
Invoke-ManualSignOff -EvidencePath $ManualEvidence -Signer $Operator
Save-Receipt
Assert-ReceiptValue $state.verdict 'fail'
Assert-ReceiptValue $state.checks[1].evidence.Count 2
Assert-ReceiptValue $state.checks[2].result 'not yet run'
$state.checks[2].result = 'pass'
Save-Receipt
Assert-ReceiptValue $state.verdict 'fail'
# Even a later implementation overwriting the current result cannot erase failed history.
$state.checks[0].result = 'pass'
Save-Receipt
Assert-ReceiptValue $state.verdict 'fail'
$state.checks[1].result = 'fail'
Invoke-ManualSignOff -EvidencePath $ManualEvidence -Signer $Operator
Assert-ReceiptValue $state.checks[1].result 'fail'
Save-Receipt
Assert-ReceiptValue $state.verdict 'fail'
# A separate clean receipt still distinguishes unrun checks from a complete pass.
$receiptPath = Join-Path $Work 'clean-fixture-receipt.json'
$state.runId = 'fixture-clean-run'
$state.history = @()
$state.signOff = $null
$state.checks[0].result = 'pass'; $state.checks[1].result = 'pass'; $state.checks[2].result = 'not yet run'
Write-FixtureManual 'fixture-clean-run' $candidateHash @($observed)
Invoke-ManualSignOff -EvidencePath $ManualEvidence -Signer $Operator
Save-Receipt
Assert-ReceiptValue $state.verdict 'incomplete'
$state.checks[2].result = 'pass'
Save-Receipt
Assert-ReceiptValue $state.verdict 'pass'
Write-Output 'PASS receipt aggregation, UTF-8 manual evidence, sticky failed retries/history/reload/sign-off, persistent failure logs and rejected invalid sign-offs'
