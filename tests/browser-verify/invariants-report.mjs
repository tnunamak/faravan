// node tests/browser-verify/invariants-report.mjs <Playwright JSON> [report.md]
import {readFile,writeFile} from 'node:fs/promises';
import {INVARIANTS} from './invariants.mjs';
import {FINDINGS} from './invariants-findings.mjs';

const [input,output]=process.argv.slice(2);
if(!input)throw new Error('Pass the Playwright JSON results file.');
const report=JSON.parse(await readFile(input,'utf8'));
const results=[],evidence=[];
function visit(suite) {
  for(const spec of suite.specs??[])for(const test of spec.tests??[])for(const result of test.results??[]) {
    results.push({title:spec.title,project:test.projectName,status:result.status});
    for(const attachment of result.attachments??[])if(attachment.name==='rendered-invariants') {
      const body=attachment.body?Buffer.from(attachment.body,'base64').toString():null;
      if(body)evidence.push({test:spec.title,project:test.projectName,...JSON.parse(body)});
    }
  }
  for(const child of suite.suites??[])visit(child);
}
for(const suite of report.suites??[])visit(suite);
const failures=evidence.flatMap(entry=>entry.failures.map(failure=>({...failure,test:entry.test,project:entry.project})));
const failingRules=[...new Set(failures.map(f=>f.id))].sort();
const summary={findings:FINDINGS.length,invariants:INVARIANTS.length,uncovered:FINDINGS.filter(f=>!f.invariants.length).map(f=>f.finding),
  tests:results.length,passed:results.filter(r=>r.status==='passed').length,failed:results.filter(r=>r.status!=='passed').length,
  journeyReports:evidence.length,observations:evidence.reduce((sum,row)=>sum+row.observations.length,0),failingRules};
console.log(JSON.stringify(summary,null,2));
if(output) {
  const rows=FINDINGS.map(f=>`| ${f.finding} | ${f.title} | ${f.invariants.join(', ')||'UNCOVERED'} | ${f.limits} |`);
  const failureRows=failingRules.map(id=>{
    const matches=failures.filter(f=>f.id===id),rule=INVARIANTS.find(r=>r.id===id);
    const views=[...new Set(matches.map(f=>`${f.actor} at ${f.width}px`))];
    return `| ${id} | ${rule?.title??'Recorder error'} | ${views.join('; ')} | ${matches.length} |`;
  });
  await writeFile(output,`# Rendered invariants\n\n${FINDINGS.length} findings; ${INVARIANTS.length} rules; ${summary.uncovered.length} finding without an executable rule. Coverage limits are part of the mapping.\n\n## Run\n\n\`node scripts/test-two-computer.mjs --invariants\` runs the negative fixtures and all G2 journeys at 390 and 1280 px, headless, with one worker and isolated homes. The shared fixture also checks ordinary G2 invocations.\n\n${summary.passed} of ${summary.tests} tests passed. ${summary.journeyReports} journey reports contain ${summary.observations} distinct labelled observations. Failed journey assertions can stop later states; a missing failure is not proof that an unreached state passed.\n\n## Failing rules\n\n| Rule | Invariant | Views | Observations |\n|---|---|---|---:|\n${failureRows.join('\n')}\n\n## Finding map\n\n| Finding | Judge finding | Rules | Coverage and limits |\n|---|---|---|---|\n${rows.join('\n')}\n\n## Limits of this gate\n\nThe recorder samples intermediate states every 250 ms after each scan completes, plus explicit action checkpoints. It does not capture every browser paint. Context-dependent checks use the real journey action or response; synthetic negative fixtures prove the checker can reject a broken input, not that G2 reaches that product state. The generic text patterns are finite and do not cover all equivalent English wording. The repository CI workflow is manual and does not invoke G2: requiring this command before merge is a separate repository-policy step.\n`);
}
