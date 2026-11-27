import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {test,expect,connect,compose,send,authorize,CHANGE,LIVE} from './two-computer-journey.mjs';
import {problemView} from '../../ui/v1/src/problem-catalog.mjs';

// A refused summary read (HTTP 422) reaches the page as the catalog's `unknown` problem: the copy and the read action
// come from the catalog, so a reworded recovery never needs this spec edited.
const SUMMARY_PROBLEM=problemView({code:'unknown'},{surface:'desktop'});

// These are real server reads. IPC only gates their delivery or refuses one read;
// successful metadata, transcript bytes and result artifacts come from the app.
const FETCH_DEADLINE=30000;

for(const zeroChanges of [false,true])for(const arrival of ['changes-first','transcript-first']) {
  test(`C: ${zeroChanges?'zero-change':'diff'} summary failure and Retry, ${arrival}`,async({journey:j})=>{
    test.setTimeout(180000);
    const summary=`The deterministic ${zeroChanges?'zero-change':'diff'} result is finished and ready for review.`;
    await connect(j);
    await j.apps.host.control('configure-summary',{zeroChanges,finalMessage:summary});
    // The same signed verification command succeeds for both variants. For the
    // zero-change run the committed, sent tree already contains the expected answer.
    if(zeroChanges){
      await writeFile(join(j.repo,'answer.txt'),CHANGE);
      await j.git('add','answer.txt');
      await j.git('commit','-qm','Establish the zero-change answer');
    }
    await compose(j);
    const hash=await send(j);
    await authorize(j);
    await j.friend.goto((await j.apps.friend.link())+'#/jobs');
    await expect(j.friend.getByRole('heading',{name:'Jobs',exact:true})).toBeVisible();
    await j.apps.host.control('release');

    const [, , digest,circle]=hash.slice(1).split('/');
    const detail=new URL('/api/jobs/'+digest+'?circle='+encodeURIComponent(circle),j.apps.friend.origin).href;
    const token=j.apps.friend.token;
    await expect.poll(async()=>{
      const response=await j.friend.request.get(detail,{headers:{'x-faravan-session-token':token}});
      expect(response.ok()).toBe(true);
      const job=await response.json();
      if(job.state==='failed')throw new Error('The deterministic executor failed: '+JSON.stringify(job));
      return job.state==='result-accepted'&&Boolean(job.result_digest);
    },{message:'The actual coordinator accepts the signed deterministic result',timeout:30000}).toBe(true);

    const held=arrival==='changes-first'?'transcript':'changes';
    await j.apps.friend.control('hold-read',{section:held});
    await j.apps.friend.control('fault-read',{section:'transcript',status:422,once:true,delayMs:14000});
    const responses=[];let failedResponse,backgroundWindowMs,backgroundAt;
    const record=response=>{
      const section=new URL(response.url()).pathname.split('/').at(-1);
      if(section==='transcript'&&response.status()===422)failedResponse=response;
      if(['changes','transcript'].includes(section))responses.push({section,status:response.status(),at:Date.now()});
    };
    j.friend.on('response',record);
    try {
      const firstResponse=j.friend.waitForResponse(response=>{
        const path=new URL(response.url()).pathname;
        return path.endsWith('/'+(arrival==='changes-first'?'changes':'transcript'))&&response.status()===(arrival==='changes-first'?200:422);
      },{timeout:30000});
      const loadingAt=Date.now();
      await j.friend.goto((await j.apps.friend.link())+hash);
      await j.invariants.checkpoint(j.friend,'result summary loading',{firstLiveMessage:LIVE,finalSummary:summary});
      await (await firstResponse).finished();
      await j.apps.friend.control('release-read',{section:held});
      const failure=j.friend.getByRole('alert').filter({hasText:SUMMARY_PROBLEM.detail});
      await expect(failure).toBeVisible({timeout:Math.max(1,FETCH_DEADLINE+1000-(Date.now()-loadingAt))});
      await expect(j.friend.getByRole('status',{name:'Loading result',exact:true})).toHaveCount(0);
      await expect(j.friend.getByText('Loading the agent’s summary…',{exact:true})).toHaveCount(0);
      await expect(j.friend.locator('.job-page .pill').filter({hasText:zeroChanges?'No changes':'Ready to review'})).toBeVisible();
      expect(Date.now()-loadingAt,'A failed summary settles within the read deadline plus one second').toBeLessThanOrEqual(FETCH_DEADLINE+1000);
      const changes=responses.findIndex(row=>row.section==='changes'&&row.status===200);
      const failed=responses.findIndex(row=>row.section==='transcript'&&row.status===422);
      expect(changes).toBeGreaterThanOrEqual(0);expect(failed).toBeGreaterThanOrEqual(0);
      expect(arrival==='changes-first'?changes<failed:failed<changes,'Real response arrival order').toBe(true);
      expect(responses.filter(row=>row.section==='transcript'&&row.status===422)).toHaveLength(1);

      // No navigation or reload is needed after restoration: Retry must re-read
      // the archived transcript and replace the error in this same document.
      const documentId=await j.friend.evaluate(()=>{
        globalThis.__summaryRetryDocument=crypto.randomUUID();return globalThis.__summaryRetryDocument;
      });
      // A slow failed read leaves the normal adaptive background retry farther
      // than five seconds away. Only explicit Retry can meet this deadline.
      await failedResponse.finished();
      const timing=failedResponse.request().timing();
      // The read may have waited in the API queue before Chromium saw it.
      // Use navigation start for the 30s cap, and the observed request start
      // for the doubled response duration: both bound the earliest follow-up.
      backgroundAt=Math.min(loadingAt+30000,timing.startTime+2*timing.responseEnd);
      backgroundWindowMs=backgroundAt-Date.now();
      expect(backgroundWindowMs,'The measured adaptive background window cannot satisfy the five-second manual Retry guard').toBeGreaterThan(6000);
      await j.apps.friend.control('restore-reads');
      const retryAt=Date.now();
      expect(backgroundAt-retryAt,'Restoration leaves the full manual Retry window').toBeGreaterThan(6000);
      const fresh=j.friend.waitForRequest(request=>new URL(request.url()).pathname.endsWith('/transcript')&&request.method()==='GET',{timeout:5000});
      await j.friend.getByRole('button',{name:SUMMARY_PROBLEM.action.label,exact:true}).click();
      const retryRead=await fresh,response=await retryRead.response();
      expect(response?.status()).toBe(200);await response.finished();
      await expect(j.friend.locator('.job-summary')).toHaveText(summary,{timeout:Math.max(1,5000-(Date.now()-retryAt))});
      expect(Date.now()-retryAt,'Retry renders the real final summary within five seconds').toBeLessThanOrEqual(5000);
      expect(Date.now(),'The new GET and rendered summary precede the earliest ordinary retry by a clock margin').toBeLessThan(backgroundAt-1000);
      await expect(failure).toHaveCount(0);
      expect(await j.friend.evaluate(()=>globalThis.__summaryRetryDocument)).toBe(documentId);
      expect(new URL(j.friend.url()).hash).toBe(hash);
      if(zeroChanges)await expect(j.friend.getByRole('region',{name:'Changes',exact:true})).toHaveCount(0);
      else await expect(j.friend.getByRole('region',{name:'Changes',exact:true})).toContainText('the deterministic G2 change');
    } finally {
      j.friend.off('response',record);
      await j.apps.friend.control('release-read',{section:held});
      await test.info().attach('summary-read-order',{body:JSON.stringify({zeroChanges,arrival,backgroundAt,backgroundWindowMs,responses},null,2),contentType:'application/json'});
    }
  });
}
