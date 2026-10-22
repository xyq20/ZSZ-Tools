const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {EventEmitter}=require('node:events');
const {createLoginState}=require('../business/login-state.cjs');

function encryption(){
 const key=crypto.randomBytes(32);
 return {isEncryptionAvailable:()=>true,
  encryptString:s=>{const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv);const b=Buffer.concat([c.update(s,'utf8'),c.final()]);return Buffer.concat([iv,c.getAuthTag(),b]);},
  decryptString:b=>{const d=crypto.createDecipheriv('aes-256-gcm',key,b.subarray(0,12));d.setAuthTag(b.subarray(12,28));return Buffer.concat([d.update(b.subarray(28)),d.final()]).toString('utf8');}};
}
function partition(initial=[]){
 const cookies=new EventEmitter();cookies.values=initial;cookies.restored=[];
 cookies.get=async()=>cookies.values;
 cookies.set=async c=>{cookies.restored.push(c);cookies.values.push({...c,domain:c.domain||new URL(c.url).hostname,hostOnly:!c.domain,session:true});};
 cookies.flushStore=async()=>{};
 return {cookies};
}
const sessionCookie={name:'fixture-session',value:'private-login-value',domain:'.superboss.cc',path:'/',session:true,hostOnly:false,secure:true,httpOnly:true,sameSite:'no_restriction'};

test('separate login partitions survive restart without plaintext or extending cookie expiry',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'toolkit-login-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const crypt=encryption(),p=partition([sessionCookie,{...sessionCookie,name:'persistent',session:false},{...sessionCookie,domain:'.example.com'}]),r=partition([{...sessionCookie,value:'report-session'}]);
 const first=createLoginState({directory,sessions:{price:p,report:r},encryption:crypt});await first.restore();await first.flush();
 assert(!(await fs.readFile(path.join(directory,'price.bin'))).includes(Buffer.from(sessionCookie.value)));
 const p2=partition(),r2=partition();await createLoginState({directory,sessions:{price:p2,report:r2},encryption:crypt}).restore();
 assert.equal(p2.cookies.restored.length,1);assert.equal(p2.cookies.restored[0].value,sessionCookie.value);assert.equal(r2.cookies.restored[0].value,'report-session');
 assert.equal(p2.cookies.restored[0].httpOnly,true);assert.equal(p2.cookies.restored[0].secure,true);assert(!Object.hasOwn(p2.cookies.restored[0],'expirationDate'));
 const newer=partition([{...sessionCookie,value:'newer-login'}]);await createLoginState({directory,sessions:{price:newer},encryption:crypt}).restore();assert.equal(newer.cookies.restored.length,0);
 p.cookies.values=[];await first.flush();const loggedOut=partition();await createLoginState({directory,sessions:{price:loggedOut},encryption:crypt}).restore();assert.equal(loggedOut.cookies.restored.length,0);
});

test('unavailable encryption keeps the current session and never falls back to plaintext',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'toolkit-no-encryption-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));let failures=0;
 const p=partition([sessionCookie]);const store=createLoginState({directory,sessions:{price:p},encryption:{isEncryptionAvailable:()=>false},onError:()=>failures++});
 await store.restore();await store.flush();assert.equal(failures,1);assert.equal(p.cookies.values.length,1);assert.deepEqual(await fs.readdir(directory),[]);
});
