import {defineConfig} from 'vite';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {takeSession} from './src/helpers.mjs';
import {bootstrap} from './src/bootstrap.mjs';
import {recoveryBootstrapSource} from './src/session-recovery.mjs';
const recoveryTokens=readFileSync(resolve(import.meta.dirname,'src/tokens.css'),'utf8');
const recoveryPage=readFileSync(resolve(import.meta.dirname,'src/recovery.css'),'utf8');
const recoveryStyles=(recoveryTokens+'\n'+recoveryPage).replace(/url\(\.\/fonts\/([^)]+)\)/g,(_,name)=>
  'url(data:font/woff2;base64,'+readFileSync(resolve(import.meta.dirname,'src/fonts',name)).toString('base64')+')');
// The recovery screen shows the mark from the sprite's #mark symbol, its one source.
const markSymbol=/<symbol id="mark" (viewBox="[^"]+")>([\s\S]*?)<\/symbol>/.exec(readFileSync(resolve(import.meta.dirname,'src/icons.svg'),'utf8'));
if(!markSymbol) throw new Error('icons.svg has no #mark symbol');
const mark='<svg '+markSymbol[1]+'>'+markSymbol[2]+'</svg>';
const script='('+bootstrap.toString()+')('+takeSession.toString()+','+JSON.stringify(recoveryStyles)+','+recoveryBootstrapSource+','+JSON.stringify(mark)+');';
const hash=createHash('sha256').update(script).digest('base64');
const html='<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'sha256-'+hash+'\' blob:; style-src blob:; connect-src \'self\' https://us.i.posthog.com https://us-assets.i.posthog.com; img-src \'self\' blob: data:; manifest-src \'self\'; font-src data:; base-uri \'none\'; form-action \'none\'"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="icon" href="/favicon.ico"><link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180"><link rel="manifest" href="/manifest.webmanifest"><meta name="app-module" content="/app.mjs"><meta name="app-style" content="/app.css"><title>Faravan</title></head><body><div id="app" role="status">Opening Faravan…</div><noscript>Faravan needs JavaScript. On a computer, reopen Faravan from the tray or run faravan in a terminal. On another device, open Faravan on your computer, go to Settings &gt; Pairing, then pair this device again.</noscript><script>'+script+'</script></body></html>';
export default defineConfig({
  root:resolve(import.meta.dirname),
  esbuild:{jsx:'automatic',jsxImportSource:'preact'},
  plugins:[{name:'authenticated-page',generateBundle(){this.emitFile({type:'asset',fileName:'index.html',source:html});}}],
  // The app can fetch only /app.mjs and /app.css, so fonts must be inlined into the CSS as data: URLs.
  build:{outDir:resolve(import.meta.dirname,'../../public/v1'),emptyOutDir:true,cssCodeSplit:false,assetsInlineLimit:1<<20,
    lib:{entry:resolve(import.meta.dirname,'src/main.jsx'),formats:['es'],fileName:()=>'app.mjs',cssFileName:'app'},
    rollupOptions:{output:{inlineDynamicImports:true,assetFileNames:'[name][extname]'}}},
});
