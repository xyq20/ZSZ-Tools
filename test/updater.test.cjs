const {test}=require('node:test');
const assert=require('node:assert/strict');
const {evaluateManifest,newer}=require('../updater.cjs');
const asset=name=>({name,browser_download_url:'https://github.com/xyq20/ZSZ-Tools/releases/download/v0.2.1/'+encodeURIComponent(name)});
const release=()=>({tag_name:'v0.2.1',draft:false,prerelease:false,body:'新增合计与中文界面',assets:[asset('钊叔工具箱-0.2.1-mac-arm64.dmg'),asset('钊叔工具箱-0.2.1-win-x64.exe'),asset('钊叔工具箱-0.2.1-win-x64.exe.blockmap')]});
test('GitHub latest release selects the installer for this system and chip',()=>{
 for(const [platform,arch,suffix] of [['darwin','arm64','mac-arm64.dmg'],['win32','x64','win-x64.exe']]){const r=evaluateManifest(release(),'0.2.0',platform,arch);assert.equal(r.status,'available');assert.equal(r.latest,'0.2.1');assert.equal(r.notes,'新增合计与中文界面');assert(decodeURIComponent(r.download).endsWith(suffix));}
 assert.equal(evaluateManifest(release(),'0.2.1','darwin','arm64').status,'current');
 assert.equal(evaluateManifest(release(),'0.2.0','darwin','x64').status,'unsupported');
 assert(newer('0.2.10','0.2.9'));assert(!newer('0.2.9','0.2.10'));
});
test('GitHub update rejects incomplete or unrelated installer metadata',()=>{
 const r=release();r.draft=true;assert.throws(()=>evaluateManifest(r,'0.2.0','darwin','arm64'));
 r.draft=false;r.assets[0].browser_download_url='https://example.com/test.dmg';assert.throws(()=>evaluateManifest(r,'0.2.0','darwin','arm64'),/发布仓库/);
 r.assets[0].browser_download_url='http://github.com/xyq20/ZSZ-Tools/releases/download/v0.2.1/test.dmg';assert.throws(()=>evaluateManifest(r,'0.2.0','darwin','arm64'),/HTTPS/);
});
