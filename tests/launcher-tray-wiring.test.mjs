import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
test('tray discovery maps saved startup failure before live status replaces it',()=>{
 const app=source('tray/internal/faravantray/app.go');
 assert.match(app,/offlineLine\s*:=\s*startFailureLine\(c.AppPath\)/);
 assert.match(app,/Status:offlineLine/);
 assert.match(app,/Label:offlineLine/);
 assert.ok(app.indexOf('connection.Menu = BuildMenu')>app.indexOf('offlineLine := startFailureLine'));
});
test('native Quit delegates the same connection to tested offline and live paths',()=>{
 const main=source('tray/cmd/faravan-tray/main.go');
 const quit=main.slice(main.indexOf('func (app *trayApp) quit()'),main.indexOf('// stopJob runs'));
 assert.match(quit,/faravantray.RunConnectionQuit\(ctx, connection, flow\)/);
 assert.match(quit,/if quit \{ app.requestExit\(\) \}/);
});
