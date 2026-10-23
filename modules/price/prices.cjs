const fs=require('node:fs/promises');
const crypto=require('node:crypto');
const JSZip=require('jszip');
const {XMLParser}=require('fast-xml-parser');
const Decimal=require('decimal.js');
const parser=new XMLParser({ignoreAttributes:false,parseTagValue:false,trimValues:false});
const list=x=>x===undefined?[]:Array.isArray(x)?x:[x];
const norm=x=>String(x??'').replace(/\s/g,'').toLowerCase();
const aliases={'7060--1':'7060-1','，7091-1':'7091-1','dg-106鞋子':'DG-106'};
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function amount(v){try{const d=new Decimal(String(v));return d.isFinite()&&d.gt(0)&&d.lte(1e9)?d.toFixed():null;}catch{return null;}}
const needsPrice=row=>!row.formula&&String(row.price??'').trim()==='';
function text(x){if(x===undefined)return '';if(typeof x!=='object')return String(x);if(x['#text']!==undefined)return String(x['#text']);return list(x.r).map(r=>text(r.t)).join('');}
async function readBook(file){
 const bytes=await fs.readFile(file);const zip=await JSZip.loadAsync(bytes);const xml=async p=>parser.parse(await zip.file(p).async('string'));
 const shared=zip.file('xl/sharedStrings.xml')?list((await xml('xl/sharedStrings.xml')).sst.si).map(x=>x.t!==undefined?text(x.t):text(x)):[];
 const rels=Object.fromEntries(list((await xml('xl/_rels/workbook.xml.rels')).Relationships.Relationship).map(x=>[x['@_Id'],x['@_Target']]));
 const candidates=[];
 for(const sheet of list((await xml('xl/workbook.xml')).workbook.sheets.sheet)){
  const target=rels[sheet['@_r:id']];const path=target.startsWith('/')?target.slice(1):require('node:path').posix.normalize('xl/'+target);
  const root=await xml(path);const rows=list(root.worksheet.sheetData.row);
  const cellValue=c=>!c?'':c['@_t']==='s'?shared[Number(c.v)]??'':c['@_t']==='inlineStr'?text(c.is?.t??c.is):text(c.v);
  for(const row of rows.filter(r=>Number(r['@_r'])<=30)){
   const cells=list(row.c);const cols=label=>cells.filter(c=>cellValue(c).trim()===label).map(c=>c['@_r'].replace(/\d/g,''));
   if(!cols('货号').length||!cols('价格').length)continue;
   if(cols('价格').length!==1)throw Error('货号或价格表头不唯一');
   const codeCol=cols('货号')[0],priceCol=cols('价格')[0],nameCol=cols('商品名称')[0];
   candidates.push({path,sheet:sheet['@_name'],rows:rows.filter(r=>Number(r['@_r'])>Number(row['@_r'])).map(r=>{
    const cells=Object.fromEntries(list(r.c).map(c=>[c['@_r'].replace(/\d/g,''),c]));const pc=cells[priceCol];
    return {row:Number(r['@_r']),code:cellValue(cells[codeCol]).trim(),name:cellValue(cells[nameCol]),price:cellValue(pc),formula:pc?.f!==undefined,ref:priceCol+r['@_r']};
   }).filter(r=>r.code)});
  }
 }
 if(candidates.length!==1)throw Error('无法唯一定位含“货号”和“价格”的工作表');
 if(!candidates[0].rows.length)throw Error('工作簿没有可查询的货号');
 return {...candidates[0],file,hash:hash(bytes)};
}
function choose(item){
 const d=item.detail;if(!d?.id)return {reason:'暂无已保存淘宝资料'};
 if(String(d.baseItemId)!==String(item.baseItemId))throw Error('淘宝资料商品 ID 不一致，已停止');
 if(!Array.isArray(d.skuList)||!d.skuList.length)return {reason:'淘宝资料没有 SKU'};
 const values=[];
 for(const sku of d.skuList){
  if(sku.baseItemId!=null&&String(sku.baseItemId)!==String(item.baseItemId))throw Error('SKU 商品 ID 不一致');
  const p=amount(sku.skuPrice);if(!p)return {reason:'SKU 价格含零、空值或无效金额'};
  const shown=(sku.skuFieldDescriptorList||[]).filter(x=>x.name==='skuPrice');
  if(shown.length>1||shown.length===1&&amount(shown[0].defaultValue)!==p)return {reason:'SKU 价格与显示字段不一致'};
  values.push(p);
 }
 if(new Set(values).size!==1)return {reason:'SKU 价格不一致：'+[...new Set(values)].join(' / ')};
 return {price:values[0],reason:'淘宝 SKU 价格全部一致'+(d.skuFix?'；规格未匹配标记不影响取价':'')};
}
function match(table,items){return table.rows.map(row=>{
 const original=row.price??'';
 if(row.formula)return {...row,original,price:'',status:'公式保留',reason:'价格单元格含公式，跳过查询并保留'};
 if(!needsPrice(row))return {...row,original,price:'',status:'已有价格',reason:'价格单元格已有内容，跳过查询并保留'};
 const keys=[norm(row.code),norm(aliases[norm(row.code)]||row.code)];const matched=items.filter(x=>keys.includes(norm(x.outerId)));
 let result=matched.length===1?choose(matched[0]):{reason:matched.length?'同货号对应多个商品':'未找到精确货号'};
 return {...row,...result,original,price:result.price??'',status:result.price?'待填入':'待核对'};
});}
async function queryPrices(table,request,progress){
 const pending=table.rows.filter(needsPrice);
 progress(`待补价格 ${pending.length} 行，已跳过已有内容或公式 ${table.rows.length-pending.length} 行`);
 if(!pending.length)return match(table,[]);
 const codes=[...new Set(pending.flatMap(r=>[r.code,r.code.replace(/\s/g,''),aliases[norm(r.code)]]).filter(Boolean))];const items=new Map();
 for(let off=0;off<codes.length;off+=50){let expected=null,received=[];
  for(let pageNo=1;pageNo<=100;pageNo++){
   const r=await request('/item/base/page.json',{pageNo,pageSize:200,outerIds:codes.slice(off,off+50),outerIdBlur:0,companyNames:[],shopNames:[],api_name:'item_base_page'});
   const d=r.data;if(!d||!Array.isArray(d.records)||!Number.isInteger(d.total)||d.total<0)throw Error('商品列表结构异常');
   if(expected!==null&&expected!==d.total)throw Error('分页期间商品数量变化，请重新查询');expected=d.total;received.push(...d.records);
   if(received.length===expected)break;
   if(received.length>expected||!d.records.length||pageNo===100)throw Error('商品分页不完整');
  }
  if(new Set(received.map(x=>String(x.baseItemId))).size!==received.length)throw Error('商品分页存在重复记录');
  for(const item of received){if(!item.baseItemId||typeof item.outerId!=='string')throw Error('商品标识异常');const old=items.get(String(item.baseItemId));if(old&&norm(old.outerId)!==norm(item.outerId))throw Error('商品货号冲突');items.set(String(item.baseItemId),item);}
  progress(`货号查询 ${Math.min(off+50,codes.length)}/${codes.length}`);
 }
 let i=0;for(const item of items.values()){item.detail=(await request('/tb/detailV2.json?'+new URLSearchParams({baseItemId:item.baseItemId,api_name:'tb_detailV2'}))).data;progress(`SKU 价格核对 ${++i}/${items.size}`);}
 return match(table,[...items.values()]);
}
async function writePrices(table,results){
 const bytes=await fs.readFile(table.file);if(hash(bytes)!==table.hash)throw Error('工作簿在查询后已修改，请重新选择并查询');
 const updates=results.filter(r=>r.status==='待填入');if(!updates.length)throw Error('没有可写入的价格');
 const sourceRows=new Map(table.rows.map(row=>[row.ref,row]));
 if(updates.some(r=>!sourceRows.has(r.ref)||!needsPrice(sourceRows.get(r.ref))||!amount(r.price)))throw Error('只允许回填原本为空且不含公式的价格单元格');
 const zip=await JSZip.loadAsync(bytes);let xml=await zip.file(table.path).async('string');
 for(const r of updates){const ref=r.ref;const pattern=new RegExp('<c\\b(?=[^>]*\\br="'+ref+'")([^>]*)(?:\\/>|>[\\s\\S]*?<\\/c>)');const found=xml.match(pattern);
  if(found){if(/<f\b/.test(found[0]))throw Error('公式单元格不可覆盖');const attrs=found[1].replace(/\s+t="[^"]*"/g,'');xml=xml.replace(pattern,`<c${attrs}><v>${r.price}</v></c>`);}
  else {const rowPattern=new RegExp('(<row\\b(?=[^>]*\\br="'+r.row+'")[^>]*>)([\\s\\S]*?)(<\\/row>)');let changed=false;
   xml=xml.replace(rowPattern,(_,open,body,end)=>{changed=true;const col=s=>s.replace(/\d/g,'').split('').reduce((n,c)=>n*26+c.charCodeAt(0)-64,0);const needle=col(ref);let inserted=false;body=body.replace(/<c\b[^>]*\br="([A-Z]+\d+)"[^>]*(?:\/>|>[\s\S]*?<\/c>)/g,(cell,address)=>{if(!inserted&&col(address)>needle){inserted=true;return `<c r="${ref}"><v>${r.price}</v></c>`+cell;}return cell;});return open+body+(inserted?'':`<c r="${ref}"><v>${r.price}</v></c>`)+end;});if(!changed)throw Error('无法定位价格行');}
 }
 zip.file(table.path,xml);const backup=table.file+'.'+Date.now()+'.backup.xlsx',tmp=table.file+'.'+Date.now()+'.tmp.xlsx';
 await fs.writeFile(backup,bytes,{flag:'wx'});
 try{await fs.writeFile(tmp,await zip.generateAsync({type:'nodebuffer'}),{flag:'wx'});const reread=await readBook(tmp);for(const r of results){const got=reread.rows.find(x=>x.ref===r.ref);const expected=r.status==='待填入'?r.price:r.original;if(!got||got.price!==expected||got.formula!==r.formula)throw Error('写入回读校验失败');}
 if(hash(await fs.readFile(table.file))!==table.hash)throw Error('保存前发现原文件被修改');await fs.rename(tmp,table.file);return {backup,count:updates.length};}finally{await fs.unlink(tmp).catch(()=>{});}
}
module.exports={readBook,queryPrices,writePrices,match,choose,norm,amount,needsPrice};
