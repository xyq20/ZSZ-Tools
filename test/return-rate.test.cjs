const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {createReturnRateTool, validateOptions} = require('../business/return-rate.cjs');

const options = {
  month:'2020-10', minimum:100, selectionGroup:'钊叔制', companyId:'123',
  excluded:'AA、AA,卷尺\n含 空格',
};

test('return rate inputs use the latest completed Beijing month and exact codes', () => {
  const now=new Date('2020-10-31T16:01:00Z');
  assert.deepEqual(validateOptions(options, now).excludedCodes, ['AA','卷尺','含 空格']);
  assert.throws(() => validateOptions({...options, month:'2020-11'}, now), /已结束/);
  assert.throws(() => validateOptions({...options, minimum:0.5}, now), /正整数/);
  assert.throws(() => validateOptions({...options, companyId:'bad'}, now), /公司编号/);
});

test('return rate imports local configuration and reports progress only after save is selected', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'toolkit-return-rate-test-'));
  try {
    const input = path.join(root,'api.json'), output = path.join(root,'data.xlsx');
    const config = {appKey:'fixture-key', appSecret:'fixture-secret', session:'fixture-session'};
    await fs.writeFile(input,JSON.stringify({...config,company_id:'123'}));
    let saves=0, launched=0, revealed;
    const events=[];
    const tool = createReturnRateTool({
      app:{isPackaged:false,getPath:()=>root}, win:{},
      dialog:{
        showOpenDialog:async()=>({canceled:false,filePaths:[input]}),
        showSaveDialog:async()=> ++saves===1 ? {canceled:true} : {canceled:false,filePath:output},
      },
      shell:{showItemInFolder:file=>{revealed=file;}},
      safeStorage:{
        isEncryptionAvailable:()=>true,
        encryptString:raw=>Buffer.from(raw).reverse(),
        decryptString:raw=>Buffer.from(raw).reverse().toString(),
      },
      progress:(message,event)=>events.push({message,event}),
      runner:async(paths,job,notify)=>{
        launched++;
        assert.match(paths.bridge,/return-rate-python[\\/]bridge\.py$/);
        assert.deepEqual(job.officialConfig,config);
        assert.deepEqual(job.excludedCodes,['AA','卷尺','含 空格']);
        notify({completed:0,total:10,message:'读取店铺'});
        await fs.writeFile(job.output,'report');
        notify({completed:10,total:10,message:'已导出'});
        return {file:await fs.realpath(job.output),count:1,sales:100,before:5,after:15};
      },
    });
    assert.equal((await tool.status()).configured,false);
    const state = await tool.importConfig();
    assert.deepEqual(state,{configured:true,source:'已导入本机配置',companyId:'123',fixedExcludedCodes:['卷尺','AA','NGBL-A','ML1002','LF55','ML1003']});
    assert.equal(await tool.start(options),null);
    assert.equal(launched,0);
    const result=await tool.start(options);
    assert.deepEqual(events.map(x=>x.event.completed),[0,10]);
    assert.equal(result.sales,100);
    assert.equal(result.officialConfig,undefined);
    await tool.reveal();
    assert.equal(revealed,result.file);
  } finally {
    await fs.rm(root,{recursive:true,force:true});
  }
});
