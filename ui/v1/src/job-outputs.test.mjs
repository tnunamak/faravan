import mandelbrot from './fixtures/mandelbrot-final-message.json' with {type:'json'};
import test from 'node:test';
import assert from 'node:assert/strict';
import {ChangesView} from './jobs.jsx';
import {jobOutputWarningVM,jobContextVM} from './view-models.mjs';
import {renderFixture,renderedText} from './render.test-helper.mjs';

test('Changes offers an added image preview on request instead of binary patch text',()=>{
  const data={format:'diff',diff:'diff --git a/faravan-output/circle.png b/faravan-output/circle.png\nnew file mode 100644\nGIT binary patch\nliteral 5\nabc\n',
    files:[{path:'faravan-output/circle.png',status:'added',binary:true,insertions:0,deletions:0,preview:{media_type:'image/png',url:'/api/jobs/test/image?path=faravan-output%2Fcircle.png'}}],diffstat:{files:1,insertions:0,deletions:0}};
  const html=renderFixture(ChangesView,{data});
  assert.match(renderedText(html),/Show image preview/);
  assert.doesNotMatch(html,/<img/);
  assert.match(renderedText(html),/New file/);
  assert.doesNotMatch(html,/literal 5|GIT binary patch|binary file/i);
});
test('a file listed beyond the truncated diff still gets its preview',()=>{
  const html=renderFixture(ChangesView,{data:{diff:'',truncated:true,files:[{path:'circle.png',status:'added',preview:{media_type:'image/png',url:'/api/jobs/test/image?path=circle.png'}}]}});
  assert.match(renderedText(html),/Show image preview/);
});
test('outside output warning names the lost file for the exact Mandelbrot final message',()=>{
  assert.equal(jobOutputWarningVM(mandelbrot.message,'/workspace/project'),
    "The agent saved files outside the project, which don't come back: /tmp/mandelbrot_cel_shaded.png");
});
test('outside paths are bounded and do not mistake workspace files, URLs or relative paths for lost outputs',()=>{
  const summary='Saved `/work/project/faravan-output/a.png`, `/work/project-other/b.png`, `~/render.png`, `/home/agent/report.pdf`. See https://example.com/a.png and faravan-output/c.png.';
  assert.equal(jobOutputWarningVM(summary,'/work/project'),"The agent saved files outside the project, which don't come back: /work/project-other/b.png, ~/render.png, /home/agent/report.pdf");
  assert.equal(jobOutputWarningVM('Saved faravan-output/c.png','/work/project'),'');
  assert.equal(jobOutputWarningVM('Saved /tmp/test.png and /tmp/test.png.',''),"The agent saved files outside the project, which don't come back: /tmp/test.png");
});

test('ordinary routes and removed system-file references are not described as saved output',()=>{
  assert.equal(jobOutputWarningVM('Added a GET /health endpoint and a /api/users route.','/work/project'),'');
  assert.equal(jobOutputWarningVM('I removed /usr/lib/foo.so references.','/work/project'),'');
});
test('signed framing context is separate from the agent summary',()=>{
  const event={type:'faravan.job_context',job_framing_version:1,workspace_path:'/work/project'};
  assert.deepEqual(jobContextVM(JSON.stringify(event)+'\n'+JSON.stringify({type:'result',result:'Saved a file.'})),event);
  assert.deepEqual(jobContextVM('old transcript'),{});
});
test('a final image path without a save verb still names the missing output',()=>{
  assert.equal(jobOutputWarningVM('Image: `/tmp/mandelbrot_cel_shaded.png`.','/work/project'),"The agent saved files outside the project, which don't come back: /tmp/mandelbrot_cel_shaded.png");
});
