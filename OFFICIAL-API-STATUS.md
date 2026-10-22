# 官方 API 接入核对（2026-10-22）

用户已确认：三公价格工具保留快麦通登录；丹姐表格在官方接口可满足时改为直接查询。

## 与昨天成功查询的区别

已核对丹姐原程序、2026-10-21 的采集记录及原对话。昨天成功生成表格使用的是登录状态下的 ERP 网页报表接口：

- `https://viperp.superboss.cc/kmrp/statistics/history/sale/finance/{sniff,page,summary}`
- 认证来自已登录的 Chrome ERP 页面；原程序通过 `chrome_query.py` 在该页面请求。
- 查询记录于 2026-10-21 14:58 完成，14 店 × 9 个月及月度、区间、店铺合计校验通过。

今天返回 401 的是开放平台网关 `https://gw.superboss.cc/router` 上的两个报表方法，不是上述昨天成功的接口。网页账号权限和开放平台应用权限不能相互推断。当前没有证据表明昨天的报表权限被收回；也不能把本次 401 扩大解释为所有官方 API 都不可用。

## 实测

现有授权可调用 `item.list.query` 和 `item.single.get`。商品总数为 10497；商品 7015-1 的 ERP SKU 销售价为 479，与快麦通淘宝资料目标价格口径不同。三公工具继续使用快麦通现有接口，不替换取价来源。

丹姐报表候选接口均使用现有授权、2026-01-01 单日、1 条分页进行只读验证：

- `erp.report.sale.sku.statistic.query`：success=false，code=401，msg=签名错误: 权限不足!
- `erp.report.afterSale.sku.statistic.query`：success=false，code=401，msg=签名错误: 权限不足!

同一签名方式调用商品接口成功；不能把商品权限推断为报表权限。

## 口径限制

- 原丹姐表格：订单按创建时间，退款按售后完成时间，14 家店铺。
- 官方 SKU 销售报表文档：timeType 仅列出 pay（付款）、consign（发货）；不能直接替代创建时间统计。
- 官方售后 SKU 报表：timeType=finish（解决），字段 refundCost 文档名称为退货金额；尚未证明与原 snapshot_refund_money 完全一致。
- 普通订单查询文档说明不含淘系及拼多多，不能据此声称覆盖原有 14 店。

当前未把丹姐表格切换到官方来源。需快麦开通报表权限，并确认创建时间统计接口及退款字段口径；完成小范围与原报表核对后再切换。未在安装包中加入密钥。

## 官方文档

https://open.kuaimai.com/docs/unpublish/报表/报表销量开放接口/
https://open.kuaimai.com/docs/unpublish/报表/报表售后数据开放接口/
https://open.kuaimai.com/docs/api/API文档/交易/订单查询非淘系拼多多/
