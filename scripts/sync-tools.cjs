// Explicit allowlist imports only; never scans or copies workbooks, cookies or outputs.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function inside(base,rel){const p=path.resolve(base,rel);if(!p.startsWith(base+path.sep))throw Error('非法文件路径: '+rel);return p;}
function main(args=process.argv.slice(2)){
 const config=JSON.parse(fs.readFileSync(path.join(root,'integration/tools.json')));
 const lockPath=path.join(root,'integration/tools.lock.json');
 const lock=fs.existsSync(lockPath)?JSON.parse(fs.readFileSync(lockPath)):{schemaVersion:1,tools:{}};
 const verify=args.includes('--verify'),apply=args.includes('--apply');
 const names=args.filter(x=>!x.startsWith('--'));
 for(const arg of args.filter(x=>x.startsWith('--')))if(!['--verify','--apply'].includes(arg))throw Error('未知选项 '+arg);
 if(verify&&apply)throw Error('不能同时校验和导入');
 const ids=names.length?names:Object.keys(config.tools),plans=[];
 for(const id of ids){
  const tool=config.tools[id];if(!tool)throw Error('未知工具 '+id);
  const old=lock.tools[id];const files={};const writes=[];
  const source=path.resolve(root,tool.source);
  for(const [src,dest] of Object.entries(tool.files)){
   const target=inside(root,dest);const current=fs.existsSync(target)?hash(fs.readFileSync(target)):null;
   if(verify){if(!old?.files[src]||old.files[src].target!==dest||old.files[src].sha256!==current)throw Error('集成副本校验失败: '+dest);continue;}
   const sourceFile=inside(source,src);const content=fs.readFileSync(sourceFile),sha256=hash(content);
   if(old?.files[src]&&current!==old.files[src].sha256)throw Error('集成副本被手动修改，先处理差异: '+dest);
   if(!old&&current!==null&&current!==sha256)throw Error('首次导入发现内容冲突: '+dest);
   files[src]={target:dest,sha256};if(current!==sha256)writes.push({target,content});
  }
  if(verify){if(Object.keys(old.files).length!==Object.keys(tool.files).length)throw Error('清单文件数不匹配: '+id);console.log(id+': 集成副本完整');continue;}
  let commit=null,dirty=true;
  try {commit=execFileSync('git',['rev-parse','HEAD'],{cwd:source,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();dirty=!!execFileSync('git',['status','--porcelain','--',...Object.keys(tool.files)],{cwd:source,encoding:'utf8'}).trim();}catch{}
  console.log(`${id}: ${writes.length} 个文件变化；来源 ${commit||'尚未提交'}${dirty?'（包含未提交源码，以文件哈希记录）':''}`);
  plans.push({id,writes,record:{source:tool.source,commit,dirty,files}});
 }
 if(!verify&&apply){
  // All tools preflight successfully before the first write. Write each file by rename.
  for(const plan of plans){for(const {target,content} of plan.writes){fs.mkdirSync(path.dirname(target),{recursive:true});const temp=target+'.import-tmp';fs.writeFileSync(temp,content);fs.renameSync(temp,target);}lock.tools[plan.id]=plan.record;}
  const temp=lockPath+'.tmp';fs.writeFileSync(temp,JSON.stringify(lock,null,2)+'\n');fs.renameSync(temp,lockPath);
  console.log('已导入。请运行 npm test 并审阅 git diff；尚未发布安装包。');
 }else if(!verify)console.log('以上仅预览。确认导入请添加 --apply。');
}
if(require.main===module){try{main();}catch(e){console.error(e.message);process.exitCode=1;}}
module.exports={main};
