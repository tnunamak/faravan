import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {renderCask} from '../packaging/homebrew-tap/render.mjs';
const template=await readFile(new URL('../packaging/homebrew-tap/Casks/faravan.rb.in',import.meta.url),'utf8');
const valid={version:'0.1.0',sha256:'a'.repeat(64),url:'https://downloads.example.org/Faravan-0.1.0.zip',homepage:'https://example.org/faravan'};
test('cask pins reviewed binary bytes, supplies CLI and never removes quarantine or enables autostart',()=>{
 const cask=renderCask(template,valid);
 assert.match(cask,/version "0.1.0"/);assert.match(cask,/sha256 "a{64}"/);
 assert.match(cask,/app "Faravan.app"/);assert.match(cask,/binary/);
 assert.match(cask,/zap launchctl: "com.faravan.agent"/);assert.doesNotMatch(cask,/uninstall launchctl:/,'upgrades preserve the login choice');assert.doesNotMatch(cask,/@VERSION@|no_check|auto_updates|depends_on "(?:node|go)"|xattr|spctl|postflight/);
});
test('refuse mutable versions, absent checksums, unsafe URLs and Ruby interpolation',()=>{
 for(const patch of [{version:'latest'},{sha256:'TODO'},{url:'https://example.org/#{system(1)}'},{url:'https://example.org/app.zip?token=secret'},{url:'https://user:password@example.org/app.zip'},{homepage:'http://example.org'}])assert.throws(()=>renderCask(template,{...valid,...patch}));
});
// The private repositories are named from parts so this file does not carry their names into the public tree.
const PRIVATE=[['faravan'],['faravan','mirror']].map(parts=>'tnunamak/'+parts.join('-'));
const percentEncodedFirstLetter=repo=>{const [owner,name]=repo.split('/');return `${owner}/%${name.charCodeAt(0).toString(16)}${name.slice(1)}`;};
test('refuse downloads and homepages that name a private repository, however they are written',()=>{
 for(const repo of PRIVATE) {
  for(const url of [`https://github.com/${repo}/releases/download/v1/app.zip`,`https://github.com/${repo.toUpperCase()}/releases/download/v1/app.zip`,
    `https://github.com/${repo}.git`,`https://github.com/${repo}`,`https://www.github.com/${repo}/archive/v1.zip`,
    `https://raw.githubusercontent.com/${repo}/main/LICENSE`,`https://codeload.github.com/${repo}/zip/refs/tags/v1`,
    `https://github.com//${repo}/releases/download/v1/app.zip`,`https://github.com/${percentEncodedFirstLetter(repo)}`]) {
   assert.throws(()=>renderCask(template,{...valid,url}),/private repository/,url);
   assert.throws(()=>renderCask(template,{...valid,homepage:url}),/private repository/,'homepage '+url);
  }
 }
 assert.throws(()=>renderCask(template,{...valid,url:'https://api.github.com/repos/tnunamak/faravan/zipball/v1'}),/private repository/,'the API host stays refused');
});
test('allow downloads and homepages in the public repository, and in repositories that only share its prefix',()=>{
 for(const repo of ['tnunamak/faravan','TNUNAMAK/Faravan','tnunamak/faravan-tools',PRIVATE[1]+'s','other/'+PRIVATE[0].split('/')[1]]) {
  const cask=renderCask(template,{...valid,url:`https://github.com/${repo}/releases/download/v1/Faravan-0.1.0.zip`,homepage:`https://github.com/${repo}`});
  assert.match(cask,new RegExp(`https://github\\.com/${repo.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}/releases/download/v1/Faravan-0\\.1\\.0\\.zip`));
 }
});
