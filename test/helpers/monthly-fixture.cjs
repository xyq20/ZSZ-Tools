const fs=require('node:fs/promises');const path=require('node:path');const ExcelJS=require('exceljs');
async function fixture(directory,{peerHeader='同期销量'}={}){
 const file=path.join(directory,'26年9月分级总表.xlsx');
 const critical=(await fs.readFile(path.join(__dirname,'../../business/monthly-python/target_skus.txt'),'utf8')).replace(/^\uFEFF/,'').split(/\r?\n/).map(s=>s.trim()).filter(s=>s&&s!=='货号');
 const aliases=Object.fromEntries(Object.entries(JSON.parse(await fs.readFile(path.join(__dirname,'../../business/monthly-python/sku_aliases.json'),'utf8'))).map(([key,value])=>[key.replace(/\s/g,'').toLowerCase(),value]));
 const book=new ExcelJS.Workbook(),sheet=book.addWorksheet('分级总表');
 for(const [cell,text] of [['E1','货号'],['F1','商品名称'],['G1','供应商'],['W1','8月实发'],['X1',peerHeader],['Y1','9月实发（9.15）'],['Z1','变化情况'],['AA1','发货前退货率（8.1-8.31）'],['AB1','发货后退货率（8.1-8.31）'],['AC1','退货率（8.1-8.31）']])sheet.getCell(cell).value=text;
 const rows=critical.map((sku,i)=>{const n=i+2;sheet.getCell('E'+n).value=sku;sheet.getCell('F'+n).value='商品'+i;sheet.getCell('G'+n).value='供应商';sheet.getCell('W'+n).value=31;sheet.getCell('Y'+n).value=45;for(const col of ['AA','AB','AC']){sheet.getCell(col+n).value=.1;sheet.getCell(col+n).numFmt='0.00%';}return {itemOuterId:aliases[sku.replace(/\s/g,'').toLowerCase()]||sku,title:'商品'+i,actualSysConsignCount:100+i,itemCount:100,rawRefundMoney:12,saleMoney:100};});
 sheet.columns.forEach(c=>c.width=18);
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l2sAAAAASUVORK5CYII=','base64');
 const image=book.addImage({buffer:png,extension:'png'});sheet.addImage(image,'A2:B3');
 book.addWorksheet('引用').getCell('A1').value={formula:"'分级总表'!Y2",result:45};
 await book.xlsx.writeFile(file);return {file,rows};
}


module.exports={fixture};
