import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
const root=new URL('../',import.meta.url).pathname;
test('the retired lending path has no product files, names or text',()=>{
  const matches=[];
  function scan(dir){for(const row of readdirSync(dir,{withFileTypes:true})){
    const path=join(dir,row.name);
    if(/pace50/i.test(row.name))matches.push(path);
    if(row.isDirectory())scan(path);
    else {let text=readFileSync(path,'utf8');
      if(path===join(root,'lib/v1/telemetry/catalog.json')){
        const catalog=JSON.parse(text);
        // Released enum intervals remain readable; scan only values current clients may emit.
        for(const [name,rows] of Object.entries(catalog.enums))catalog.enums[name]=rows.filter(row=>row.until===undefined||row.until>catalog.schema_version);
        text=JSON.stringify(catalog);
      }
      if(/pace50|lendingPolicy_|lending-lendingPolicy|maxJobUsd|\bownerMaxJobUsdMicro\b|\bperJobCapChanged\b|set_owner_settings|ownerLimitAction|owner-limit|window_origin|allow_once|attest_window|window_origins|lending_owner_settings|allowOnce|attestWindow|owner-settings|presence-override|window-origin|AUTO_RUN_CAPABILITY|auto_run_intents|release_hold/i.test(text.replace('delete settings.lendingPolicyMigration.perJobCapChanged;', '')))matches.push(path);}
  }}
  for(const directory of ['lib','ui/v1/src','docs','bin','telemetry']){const path=join(root,directory);if(existsSync(path))scan(path);}
  assert.deepEqual(matches,[]);
  for(const name of ['lender-pace50','lending-pace50-adapter','lending-pace50-source','presence-override','window-origin','owner-settings'])
    assert.equal(existsSync(join(root,'lib/v1',name+'.mjs')),false);
});
