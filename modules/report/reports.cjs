const Decimal = require('decimal.js');
const ExcelJS = require('exceljs');
const config = require('./report-config.json');
const { centerWorkbook } = require('./workbook-style.cjs');
const { mapMonths, pacedRequest } = require('./report-speed.js');

const fields = ['order_pay_amount', 'snapshot_refund_money'];
const financeEndpoint = '/kmrp/statistics/history/sale/finance/';
const afterSaleEndpoint = '/kmrp/statistics/history/aftersale/';

// The refund report has a different page and time dimension from the finance report.
const afterSaleBase = {
  ...config.base,
  workOrderTimeQueryType: 'after_sale_platform_finish',
  userIdList: '',
  warehouseIdList: '',
  consignWarehouseIdList: '',
  returnWarehouseIdList: '',
  workOrderOriginProp: '',
  workOrderMatchedTradeProp: '',
  workOrderReturnExpressProp: '',
  workOrderStatusList: '10',
  workOrderStatusQueryType: 2,
  workOrderTypeList: '',
  workOrderTypeQueryType: 1,
  workReasonContainList: '',
  workOrderTagIdContainList: '',
  workOrderOnlineStatusList: '',
  tradeDataOriginSetting: JSON.stringify({
    tradeScalpingCondition: 0,
    tradeCancelCondition: 0,
    offlineTradeCondition: 0,
    tradeNonConsignCondition: 0,
    tradeOutStockCondition: 0,
    itemNotMatchCondition: 0,
    virtualItemCondition: 0,
    otherErpConsignCondition: 0,
    workOrderOnlineCloseCondition: 0,
  }),
  pageId: '100745',
  api_name: 'kmrp_statistics_history_aftersale_summary',
  pageNo: 1,
  pageSize: 50,
};

function money(value) {
  if (value === null || value === undefined || value === '') throw Error('报表金额缺失');
  const decimal = new Decimal(String(value).replaceAll(',', ''));
  if (!decimal.isFinite()) throw Error('报表金额无效');
  return decimal;
}

function reportTotals(monthly) {
  return Object.fromEntries(fields.map(field => [
    field,
    monthly.reduce((sum, row) => sum.plus(money(row[field])), new Decimal(0)).toFixed(2),
  ]));
}

function months(start, end) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(start)
    || !/^\d{4}-(0[1-9]|1[0-2])$/.test(end)
    || start > end) throw Error('请选择有效的起止月份');
  const out = [];
  let [year, month] = start.split('-').map(Number);
  while (`${year}-${String(month).padStart(2, '0')}` <= end) {
    const label = `${year}-${String(month).padStart(2, '0')}`;
    const startTime = Date.UTC(year, month - 1, 1) - 8 * 3600000;
    const endTime = Date.UTC(year, month, 1) - 8 * 3600000 - 1000;
    out.push({ label, startTime, endTime: Math.min(endTime, Date.now()) });
    if (out.length > 36) throw Error('单次最多查询 36 个月');
    if (++month === 13) { year += 1; month = 1; }
  }
  if (out.some(item => item.startTime > Date.now())) throw Error('不能查询未来月份');
  return out;
}

function apiSucceeded(response) {
  return response?.suc === true && response?.result === 1;
}

function apiError(response) {
  return response?.message || response?.msg || response?.errorMsg || '报表接口未返回成功状态';
}

function reportAmount(data, field) {
  const value = data?.amount?.[field];
  if ((value === null || value === undefined || value === '') && Number(data?.total) === 0) {
    return new Decimal(0);
  }
  return money(value);
}

function paymentMonth(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}))?$/.exec(String(value || '').trim());
  if (!match) return null;
  const [, year, month, day, hour = '00', minute = '00', second = '00'] = match;
  const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
  if (!Number.isFinite(date.getTime())
    || date.toISOString().slice(0, 19) !== `${year}-${month}-${day}T${hour}:${minute}:${second}`) return null;
  return `${year}-${month}`;
}

async function collectRefunds(monthJobs, request, progress, refundEndTime) {
  const requestedMonths = new Set(monthJobs.map(job => job.label));
  const knownShopIds = new Set(config.shops.map(shop => String(shop.id)));
  // Query platform completion through the cutoff, then group by payment month
  // locally to include after-sales completed after the requested payment months.
  const refundBody = {
    ...afterSaleBase,
    startTime: monthJobs[0].startTime,
    endTime: refundEndTime,
    userIdList: config.shops.map(shop => String(shop.id)).join(','),
  };
  const call = async (route, action, payload, apiName) => {
    progress(`退款 · ${action}`);
    const response = await request(`${afterSaleEndpoint}${route}`, { ...payload, api_name: apiName });
    if (!apiSucceeded(response)) throw Error(apiError(response));
    return response.data;
  };

  const summary = await call('summary', '读取售后总汇', refundBody,
    'kmrp_statistics_history_aftersale_summary');
  const rows = [];
  const workOrderIds = new Set();
  for (let pageNo = 1; ; pageNo += 1) {
    if (pageNo > 10000) throw Error('售后明细分页超过安全上限');
    const data = await call('page', `读取售后明细第 ${pageNo} 页`, {
      ...refundBody,
      pageNo,
      pageSize: 500,
    }, 'kmrp_statistics_history_aftersale_page');
    if (!Array.isArray(data?.list) || !data.page || typeof data.page.hasNext !== 'boolean') {
      throw Error('售后明细分页格式无效');
    }
    for (const row of data.list) {
      const id = String(row.work_order_id || '');
      if (!id || workOrderIds.has(id)) throw Error('售后明细存在空号或重复工单');
      const shopId = String(row.user_id || '');
      if (!knownShopIds.has(shopId)) throw Error('售后明细存在未知店铺');
      workOrderIds.add(id);
      rows.push(row);
    }
    if (data.page.hasNext !== true) break;
  }
  if (Number(summary?.total) !== rows.length) throw Error('售后明细条数与总汇不一致');
  const pageTotal = rows.reduce(
    (sum, row) => sum.plus(money(row.snapshot_refund_money)), new Decimal(0),
  );
  const summaryTotal = reportAmount(summary, 'snapshot_refund_money');
  if (!pageTotal.eq(summaryTotal)) throw Error('售后明细退款金额与总汇不一致');

  const byMonth = new Map(monthJobs.map(job => [job.label, { total: new Decimal(0), byShop: new Map() }]));
  const unassignedRefunds = [];
  for (const row of rows) {
    const label = paymentMonth(row.trade_pay_time);
    const amount = money(row.snapshot_refund_money);
    if (!label) {
      if (!amount.isZero()) unassignedRefunds.push({
        workOrderId: String(row.work_order_id),
        shopId: String(row.user_id),
        paymentTime: String(row.trade_pay_time || ''),
        amount: amount.toFixed(2),
      });
      continue;
    }
    if (!requestedMonths.has(label)) continue;
    const bucket = byMonth.get(label);
    const shopId = String(row.user_id);
    bucket.total = bucket.total.plus(amount);
    bucket.byShop.set(shopId, (bucket.byShop.get(shopId) || new Decimal(0)).plus(amount));
  }
  for (const bucket of byMonth.values()) {
    const shopTotal = [...bucket.byShop.values()].reduce((sum, value) => sum.plus(value), new Decimal(0));
    if (!shopTotal.eq(bucket.total)) throw Error('付款月份店铺退款合计不一致');
  }
  return { byMonth, fetchedRows: rows.length, summaryTotal, unassignedRefunds };
}

async function queryReport(start, end, rawRequest, progress = () => {}, options = {}) {
  const request = pacedRequest(rawRequest, {
    ...options,
    onRetry: (ms, attempt) => {
      progress(`快麦请求频繁，第 ${attempt} 次重试，等待 ${Math.ceil(ms / 1000)} 秒…`);
      options.onRetry?.(ms, attempt);
    },
  });

  const monthJobs = months(start, end);
  const refundEndTime = Number.isFinite(options.refundEndTime) ? options.refundEndTime : Date.now();
  const refundData = await collectRefunds(monthJobs, request, progress, refundEndTime);
  const parts = await mapMonths(monthJobs, async job => {
    const financeBody = { ...config.base, startTime: job.startTime, endTime: job.endTime, pageNo: 1 };
    const call = async (endpoint, route, action, payload, apiName) => {
      progress(`${job.label} · ${action}`);
      const response = await request(`${endpoint}${route}`, { ...payload, api_name: apiName });
      if (!apiSucceeded(response)) throw Error(apiError(response));
      return response.data;
    };

    const financeData = await call(financeEndpoint, 'page', '查询店铺', financeBody,
      'kmrp_statistics_history_sale_finance_page');
    const financeSummary = await call(financeEndpoint, 'summary', '核对汇总', financeBody,
      'kmrp_statistics_history_sale_finance_summary');
    if (!Array.isArray(financeData?.list) || financeData.page?.hasNext !== false) {
      throw Error('报表分页未完整返回，停止导出');
    }
    if (!financeSummary || Number(financeSummary.total) !== financeData.list.length) {
      throw Error('报表条数与汇总不一致');
    }

    const known = new Set(config.shops.map(shop => String(shop.id)));
    const financeById = new Map();
    for (const row of financeData.list) {
      const id = String(row.user_id);
      if (!known.has(id) || financeById.has(id)) throw Error('返回了未知或重复店铺');
      financeById.set(id, row);
    }
    for (const shop of config.shops.filter(item => !financeById.has(String(item.id)))) {
      const zero = await call(financeEndpoint, 'summary', '核对汇总', {
        ...financeBody,
        userIdList: String(shop.id),
      }, 'kmrp_statistics_history_sale_finance_summary');
      if (Number(zero?.total) !== 0) throw Error('缺失店铺存在记录，不能按零汇总');
    }

    const orderPayTotal = financeData.list.reduce(
      (sum, row) => sum.plus(money(row.order_pay_amount)), new Decimal(0),
    );
    if (!orderPayTotal.eq(money(financeSummary.amount?.order_pay_amount))) {
      throw Error('店铺已付金额与月度汇总不一致');
    }

    const refundMonth = refundData.byMonth.get(job.label);
    const refundTotal = refundMonth.total;

    const monthly = [{
      month: job.label,
      order_pay_amount: orderPayTotal.toFixed(2),
      snapshot_refund_money: refundTotal.toFixed(2),
    }];
    const rows = config.shops.map(shop => {
      const id = String(shop.id);
      const finance = financeById.get(id);
      return {
        month: job.label,
        title: shop.title,
        platform: shop.source,
        order_pay_amount: finance ? money(finance.order_pay_amount).toFixed(2) : '0.00',
        snapshot_refund_money: (refundMonth.byShop.get(id) || new Decimal(0)).toFixed(2),
      };
    });
    return { monthly, rows };
  }, options);

  const monthly = parts.flatMap(part => part.monthly);
  return {
    start,
    end,
    monthly,
    rows: parts.flatMap(part => part.rows),
    totals: reportTotals(monthly),
    queriedAt: new Date().toISOString(),
    shops: config.shops.length,
    unassignedRefunds: refundData.unassignedRefunds,
    unassignedRefundAmount: refundData.unassignedRefunds.reduce(
      (sum, row) => sum.plus(row.amount), new Decimal(0),
    ).toFixed(2),
  };
}

async function exportReport(data, file) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('月度汇总', { views: [{ state: 'frozen', xSplit: 1, ySplit: 5 }] });
  const last = data.monthly.length + 2;
  sheet.mergeCells(2, 1, 2, last);
  sheet.getCell(2, 1).value = `${data.start} 至 ${data.end} 金额汇总`;
  sheet.mergeCells(3, 1, 3, last);
  sheet.getCell(3, 1).value = `${data.shops} 家店铺 · 金额单位：元 · 查询时间：${new Date(data.queriedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}`;
  sheet.getRow(5).values = ['统计指标', ...data.monthly.map(item => item.month), '合计'];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    const row = 6 + index;
    sheet.getRow(row).values = [['订单买家已付金额', '退款金额'][index], ...data.monthly.map(item => Number(item[field]))];
    sheet.getCell(row, last).value = {
      formula: `SUM(B${row}:${sheet.getColumn(last - 1).letter}${row})`,
      result: Number(data.monthly.reduce((sum, item) => sum.plus(item[field]), new Decimal(0)).toFixed(2)),
    };
  }
  sheet.mergeCells(9, 1, 9, last);
  sheet.getCell(9, 1).value = '订单按创建时间；退款按付款时间归属，明细查询使用平台完成时间、按售后工单。当前月统计截至本次查询。';
  sheet.getColumn(1).width = 28;
  for (let column = 2; column <= last; column += 1) sheet.getColumn(column).width = 18;
  for (let row = 5; row <= 7; row += 1) {
    sheet.getRow(row).height = 32;
    for (let column = 1; column <= last; column += 1) {
      const cell = sheet.getCell(row, column);
      cell.font = { name: 'Microsoft YaHei', size: 11, color: { argb: row === 5 ? 'FFFFFFFF' : 'FF28313D' }, bold: row === 5 || column === 1 };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: row === 5 ? 'FF233F5B' : row === 7 ? 'FFF3F6FA' : 'FFFFFFFF' } };
      cell.border = { bottom: { style: 'thin', color: { argb: 'FFDCE2EA' } } };
      if (row > 5 && column > 1) cell.numFmt = '#,##0.00';
    }
  }
  const detail = workbook.addWorksheet('店铺月度明细');
  detail.addRow(['月份', '店铺', '平台', '订单买家已付金额', '退款金额']);
  for (const row of data.rows) detail.addRow([row.month, row.title, row.platform, Number(row.order_pay_amount), Number(row.snapshot_refund_money)]);
  for (const monthly of data.monthly) {
    const detailRows = data.rows.filter(row => row.month === monthly.month);
    if (detailRows.length !== data.shops) throw Error('导出店铺明细数量与月度汇总不一致');
    for (const field of fields) {
      const detailTotal = detailRows.reduce(
        (sum, row) => sum.plus(money(row[field])), new Decimal(0),
      );
      if (!detailTotal.eq(money(monthly[field]))) throw Error('导出店铺明细金额与月度汇总不一致');
    }
  }
  detail.columns.forEach(column => { column.width = 25; });
  if (data.unassignedRefunds?.length) {
    const unresolved = workbook.addWorksheet('待核对退款');
    unresolved.addRow(['售后工单号', '店铺', '原付款时间', '退款金额', '原因']);
    for (const row of data.unassignedRefunds) {
      const shop = config.shops.find(shop => String(shop.id) === row.shopId);
      unresolved.addRow([row.workOrderId, shop?.title || row.shopId, row.paymentTime,
        Number(row.amount), '付款时间缺失或无效，无法判断是否属于所选月份']);
    }
    unresolved.columns.forEach(column => { column.width = 28; });
    const amount = data.unassignedRefunds.reduce((sum, row) => sum.plus(row.amount), new Decimal(0));
    sheet.mergeCells(10, 1, 10, last);
    sheet.getCell(10, 1).value = `待核对：${data.unassignedRefunds.length} 笔退款合计 ${amount.toFixed(2)} 元缺少有效付款时间，月度汇总尚未包含这些金额，详见待核对退款。`;
    sheet.getCell(10, 1).font = { color: { argb: 'FFB45309' }, bold: true };
    sheet.getRow(10).height = 65;
  }
  centerWorkbook(workbook);
  await workbook.xlsx.writeFile(file);
  const check = new ExcelJS.Workbook();
  await check.xlsx.readFile(file);
  if (check.worksheets[1].rowCount !== data.rows.length + 1) throw Error('导出回读校验失败');
  if (data.unassignedRefunds?.length) {
    const unresolved = check.getWorksheet('待核对退款');
    if (unresolved?.rowCount !== data.unassignedRefunds.length + 1) throw Error('待核对退款回读校验失败');
    for (const [index, row] of data.unassignedRefunds.entries()) {
      if (unresolved.getCell(index + 2, 1).value !== row.workOrderId
        || !money(unresolved.getCell(index + 2, 4).value).eq(row.amount)) throw Error('待核对退款回读校验失败');
    }
  }
  for (const [index, monthly] of data.monthly.entries()) {
    for (const [fieldIndex, field] of fields.entries()) {
      const saved = check.worksheets[0].getCell(6 + fieldIndex, 2 + index).value;
      if (!money(saved).eq(money(monthly[field]))) throw Error('导出月度金额回读校验失败');
    }
  }
  for (const [index, row] of data.rows.entries()) {
    const saved = check.worksheets[1].getRow(index + 2);
    if (saved.getCell(1).value !== row.month || saved.getCell(2).value !== row.title) {
      throw Error('导出店铺明细回读校验失败');
    }
    for (const [fieldIndex, field] of fields.entries()) {
      if (!money(saved.getCell(4 + fieldIndex).value).eq(money(row[field]))) {
        throw Error('导出店铺金额回读校验失败');
      }
    }
  }
  for (const [fieldIndex, field] of fields.entries()) {
    const saved = check.worksheets[0].getCell(6 + fieldIndex, last).value;
    const expected = data.monthly.reduce((sum, row) => sum.plus(money(row[field])), new Decimal(0));
    if (saved?.formula !== `SUM(B${6 + fieldIndex}:${check.worksheets[0].getColumn(last - 1).letter}${6 + fieldIndex})`
      || !money(saved.result ?? 0).eq(expected)) throw Error('导出合计回读校验失败');
  }
}

module.exports = { months, queryReport, exportReport, reportTotals };
