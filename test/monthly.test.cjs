const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const ExcelJS=require('exceljs');
const JSZip=require('jszip');
const {runtimePaths,runPython,queryDataset,exportPreview}=require('../business/monthly.cjs');

test('monthly ERP pagination uses independent form queries and rejects incomplete datasets',async()=>{
 const query={label:'实发',payload:{pageSize:'2',asTypes:'5'}};let calls=0;
 const result=await queryDataset(query,async(route,body)=>{assert.equal(route,'/report/sale/dimensions/list');assert.equal(body.asTypes,'5');assert.equal(body.pageNo,String(++calls));return {result:1,data:{list:calls<3?[{id:calls*2},{id:calls*2+1}]:[]}};},()=>{});
 assert.equal(calls,3);assert.equal(result.data.list.length,4);
 await assert.rejects(queryDataset(query,async()=>({result:1,data:{total:2,list:[]}}),()=>{}),/分页不完整/);
 await assert.rejects(queryDataset(query,async()=>({result:901,data:{list:[]}}),()=>{}),/未成功/);
});

const {fixture}=require('./helpers/monthly-fixture.cjs');

test('bundled monthly bridge previews without changing the master, preserves media, and commits with backup',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'toolkit-monthly-'));
 const paths=runtimePaths({isPackaged:false});
 const run=job=>runPython(paths,job);
 const {file,rows}=await fixture(directory),before=await fs.readFile(file);
 const plan=await run({action:'inspect',workbook:file,runDate:'2026-10-22'});
 assert.deepEqual(plan.cycle.actualWindow,['2026-10-01','2026-10-14']);assert.deepEqual(plan.cycle.returnWindow,['2026-09-01','2026-09-30']);
 assert.deepEqual(plan.queries.map(q=>q.payload.asTypes),['','5','1,2,7,8,10','5,1,2,7,8,10']);
 const inputs={};for(const key of ['actual','before','after','overall']){inputs[key]=path.join(directory,key+'.json');await fs.writeFile(inputs[key],JSON.stringify({data:{list:rows}}));}
 const preview=await run({action:'prepare',workbook:plan.workbook,sourceHash:plan.sourceHash,runDate:'2026-10-22',directory,inputs});
 assert.equal(preview.summary.canSave,true);assert.equal(preview.summary.insertedMonthColumn,true);assert.equal(preview.summary.criticalFailures,0);assert.equal(preview.rows.length,rows.length);assert.deepEqual(await fs.readFile(file),before);
 const report=path.join(directory,'核对.xlsx');await exportPreview(preview,report);const reportBook=new ExcelJS.Workbook();await reportBook.xlsx.readFile(report);assert.equal(reportBook.worksheets.length,3);assert.equal(reportBook.worksheets[0].getCell('A1').value,'Excel行号');assert.equal(reportBook.worksheets[0].getCell('A1').alignment.horizontal,'center');assert.equal(reportBook.worksheets[0].getCell('I2').value,.12);assert.equal(reportBook.worksheets[0].getCell('I2').numFmt,'0.00%');
 const saved=await run({action:'commit',receipt:preview.receipt});assert.equal(path.basename(saved.workbook),'26年10月分级总表.xlsx');assert.deepEqual(await fs.readFile(saved.backup),before);
 const oldZip=await JSZip.loadAsync(before),newZip=await JSZip.loadAsync(await fs.readFile(saved.workbook));
 for(const name of Object.keys(oldZip.files).filter(name=>name.startsWith('xl/media/')&&!oldZip.files[name].dir))assert.deepEqual(await oldZip.file(name).async('nodebuffer'),await newZip.file(name).async('nodebuffer'));
 const afterPlan=await run({action:'inspect',workbook:saved.workbook,runDate:'2026-10-22'});
 const again=await run({action:'prepare',workbook:afterPlan.workbook,sourceHash:afterPlan.sourceHash,runDate:'2026-10-22',directory,inputs});assert.equal(again.summary.insertedMonthColumn,false);
 await fs.appendFile(saved.workbook,'changed');await assert.rejects(run({action:'commit',receipt:again.receipt}),/已被修改/);await fs.unlink(again.candidate);
 await fs.rm(directory,{recursive:true,force:true});
});

test('monthly bridge blocks saving when critical SKUs are missing',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'toolkit-monthly-block-'));const {file}=await fixture(directory),before=await fs.readFile(file);const run=job=>runPython(runtimePaths({isPackaged:false}),job);
 const plan=await run({action:'inspect',workbook:file,runDate:'2026-10-22'}),inputs={};
 for(const key of ['actual','before','after','overall']){inputs[key]=path.join(directory,key+'.json');await fs.writeFile(inputs[key],JSON.stringify({data:{list:[]}}));}
 const preview=await run({action:'prepare',workbook:plan.workbook,sourceHash:plan.sourceHash,runDate:'2026-10-22',directory,inputs});assert.equal(preview.summary.canSave,false);assert(preview.summary.criticalFailures>0);assert.equal(preview.receipt,undefined);assert.deepEqual(await fs.readFile(file),before);
 await fs.rm(directory,{recursive:true,force:true});
});
