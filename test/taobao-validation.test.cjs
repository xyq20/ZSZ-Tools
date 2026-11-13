const {test}=require('node:test');
const assert=require('node:assert/strict');
const {validateChoices}=require((require('node:fs').existsSync(require('node:path').join(__dirname,'../scripts/validate-choices.js'))?'../scripts/':'../modules/taobao/scripts/')+'validate-choices');
const {runPreparedBatch}=require((require('node:fs').existsSync(require('node:path').join(__dirname,'../scripts/validate-choices.js'))?'../scripts/':'../modules/taobao/scripts/')+'run-prepared-batch');
const item={file:'商品 1.mp4',caption:'当季穿搭',product_id:'123',topic_title:'穿搭'};
test('reject an invalid batch before any remote page access',async()=>{
 for(const choices of [null,[],[item,item],Array(101).fill(item),[{...item,caption:'字'.repeat(31)}],[{...item,product_id:'123\"'}],[{...item,topic_title:''}]]){
  assert.throws(()=>validateChoices(choices));
  await assert.rejects(runPreparedBatch({frames(){assert.fail('must not touch page');}},choices));
 }
});
test('valid choices and thirty Unicode characters are accepted',()=>{
 assert.equal(validateChoices([item]).length,1);
 assert.equal(validateChoices([{...item,caption:'🧶'.repeat(30)}]).length,1);
});

test('multi-product lists reject duplicates, malformed IDs and platform overflow',()=>{
 const products=[{id:'123',title:'商品一'},{id:'456',title:'商品二'}];
 assert.equal(validateChoices([{...item,products}]).length,1);
 for(const invalid of [[products[0],products[0]],[{id:'123\"',title:'商品'}],[],Array.from({length:7},(_,i)=>({id:String(123+i),title:'商品'}))])assert.throws(()=>validateChoices([{...item,products:invalid}]));
});
