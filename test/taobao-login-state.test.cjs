const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {createTaobaoLoginState} = require('../business/taobao-login-state.cjs');
const cookie = {name:'test-login',value:'private-session',domain:'.taobao.com',path:'/',expires:-1,secure:true,httpOnly:true,sameSite:'None'};
function encryption() {
 const key=crypto.randomBytes(32);
 return {isEncryptionAvailable:()=>true,
 encryptString(text){const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv);const data=Buffer.concat([c.update(text),c.final()]);return Buffer.concat([iv,c.getAuthTag(),data]);},
 decryptString(bytes){const c=crypto.createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));c.setAuthTag(bytes.subarray(12,28));return Buffer.concat([c.update(bytes.subarray(28)),c.final()]).toString();}};
}
function context(initial=[]){return {values:initial,added:[],async cookies(){return this.values;},async addCookies(cookies){this.added.push(...cookies);this.values.push(...cookies);}};}
test('Taobao session cookies survive restart encrypted, with current cookies and logout respected',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'tb-login-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'state.bin'),crypt=encryption(),first=context([cookie,{...cookie,name:'persistent',expires:2000000000},{...cookie,domain:'.example.com'}]);
 const state=createTaobaoLoginState({context:first,file,encryption:crypt});await state.flush();
 assert(!(await fs.readFile(file)).includes(Buffer.from(cookie.value)));
 const second=context();await createTaobaoLoginState({context:second,file,encryption:crypt}).restore();assert.deepEqual(second.added,[cookie]);
 const current=context([{...cookie,value:'newer'}]);await createTaobaoLoginState({context:current,file,encryption:crypt}).restore();assert.equal(current.added.length,0);
 first.values=[];await state.save();const logout=context();await createTaobaoLoginState({context:logout,file,encryption:crypt}).restore();assert.equal(logout.added.length,0);
});
test('Taobao encryption errors never write plaintext and report a recoverable failure',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'tb-login-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));let errors=0;
 const state=createTaobaoLoginState({context:context([cookie]),file:path.join(dir,'state.bin'),encryption:{isEncryptionAvailable:()=>false},onError:()=>errors++});
 await state.flush();assert.equal(errors,1);assert.deepEqual(await fs.readdir(dir),[]);
});
