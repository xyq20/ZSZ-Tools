# 独立开发与工具箱集成

源码目录位于同一个父目录“电商自动化”。双姐保持 `1.快麦excel导入脚本`，丹姐为 `4.丹姐表格`，三公为 `5.批量导入价格（三公）`，工具箱为 `钊叔工具箱`。

## 目录职责

- `app/`：桌面界面。
- `main.cjs`、`preload.cjs`、`business/`：桌面接入、登录、IPC、公共导出样式。双姐 `bridge.py` 属于工具箱接入层。
- `modules/report/`、`modules/price/`：丹姐、三公业务模块的固定导入副本。business 中旧入口仅转发，避免破坏现有调用。
- `business/monthly-python/`：双姐固定导入核心与工具箱桥接程序；文件级来源见清单。
- `integration/tools.json`：明确列出允许导入的源码文件和相对路径。
- `integration/tools.lock.json`：记录来源提交、是否含未提交改动及每个文件的 SHA-256。
- `scripts/`：同步、环境准备、打包相关脚本。
- `dist/`：生成的安装包，不提交 Git。

## 修改并集成一个工具

1. 在对应独立项目修改业务源码，运行该项目的测试。丹姐和三公执行 `npm install`（首次）及 `npm test`；双姐使用其项目现有 Python 测试流程。
2. 审阅并提交独立项目代码。未提交源码也能试验性导入，清单会明确记录 dirty=true 与哈希，不能宣称来自纯净提交。
3. 在工具箱运行 `npm run tools:sync -- report` 查看差异；`price` 是三公，`monthly` 是双姐。不加名称检查全部。
4. 确认后执行 `npm run tools:sync -- report --apply`。
5. 运行 `npm test` 和 `npm run tools:verify`，审阅 `git diff`，再提交工具箱。
6. 按原发布流程构建 Windows/Mac 安装包并发布。同步源码不等于已发布，不自动上传 GitHub。

同步是单向、文件白名单方式，不复制工作簿、登录信息或采集结果。不在工具箱里手动改导入副本；发生冲突时同步会停止。需要回退时，回退工具箱集成副本和 lock 清单到同一提交。

开发时可以通过同步未提交代码进行快速联调；当前不使用动态软链接，避免未验证源码悄悄进入运行程序。发布校验只依赖内置副本及 lock，构建机器不需要旁边的源项目。新增文件必须明确修改允许清单；删除文件也应审阅清单、删除对应副本后重新验证。

## 重型工具

当前四个工具的业务模块都内置，双姐由独立 Python 进程运行。将来大模型等大体积依赖可以另做扩展包，必须再实现下载、校验、版本兼容和回退。目前没有启用远程扩展包或动态下载执行代码。

## 独立入口说明

丹姐与三公独立目录中，根目录的 JS 业务模块是桌面版的维护入口。旧浏览器/Python 命令行脚本作为历史工作流保留，未重写为同一个实现；修改旧脚本不会自动改变桌面版，详见各项目 README-集成.md。

## 淘宝素材上传（谭）

业务源码保留在 `Documents/ChatGPT/淘宝素材上传（谭）`，来源和文件白名单登记为 `taobao`。修改来源后运行 `npm run tools:sync -- taobao --apply`，再运行 `npm test` 和 `npm run tools:verify`。业务逻辑测试也以白名单导入，分别验证源项目和实际集成副本。

工具箱的 `business/taobao.cjs` 管理独立 Chrome/Edge 会话、文件选择、IPC、密钥加密和发布确认。用户数据保存在 `team-toolkit/taobao`，不在 Git 或打包文件清单中。Chromium 不随包下载；用户需已安装 Chrome 或 Edge。Windows 使用 Control 快捷键，Mac 使用 Meta。

## 生意参谋数据抓取（董卓）

来源是 `../3.生意参谋数据抓取`，登记为 `sycm`，10 个运行文件白名单导入 `business/sycm-python`。修改来源后执行 `npm run tools:sync -- sycm --apply`。`SYCM_DATA_DIR` 指定每次任务的本机副本目录，`SYCM_AUTH_DIR` 指定工具箱专属登录目录；未设置时原独立脚本行为不变。工具箱会通过 Playwright 管理独立 Chrome/Edge 进程，不占用独立项目的固定调试端口，也不终止其浏览器。

首次准备：`npm run prepare:runtimes`，然后分别执行 `npm run prepare:sycm -- mac-arm64`、`npm run prepare:sycm -- win-x64`。后者通过构建机 Python/pip 安装目标平台 wheel，自动写入 Windows 嵌入式 Python 的 `python312._pth`，内含 Playwright、openpyxl、Pillow 和 tzdata。Windows 构建机可通过 `SYCM_BUILD_PYTHON` 指定有 pip 的构建用 Python；最终用户无需安装 Python，只需 Chrome 或 Edge。不能混用 Mac 与 Windows 二进制依赖。

新一轮建立独立本机副本并保留原文件名（支持自动年月改名），全量刷新选定范围。`last-task.json` 保存上轮目录和筛选，重启工具箱后仍可继续；续跑复用该目录和 `round_<mode>.json`，不重新复制原表。Python 校验日期、范围和工作簿摘要；非完整结束明确显示部分完成。Windows 使用 msvcrt 字节锁，Mac 使用 flock。

发布资源只包含 Python 源码及私有运行时，不含原项目工作簿、登录信息和历史数据。运行结果位于用户数据目录 `team-toolkit/sycm/runs`，登录信息位于 `team-toolkit/sycm/auth`。

## 淘宝商品提醒（谭）

来源登记为 `taobao-reminders`。通过 `npm run tools:sync -- taobao-reminders --apply` 同步千牛网页接口和飞书发送业务核心，打包复用生意参谋的 Playwright/Python 运行环境。独立项目的 macOS 后台入口由原项目维护。

工具箱定时在应用进程内按北京时间运行，首次启用前需扫码、保存 Webhook、小谭的飞书用户 ID 和巡检时间。「立即运行」打开可见浏览器巡检，每次发结果并 @小谭，包括查无到期商品的情况。预览只展示消息。设置、网页登录和去重记录位于本机的 `team-toolkit/taobao-reminders`。装有原独立巡检的 Mac 手动运行时沿用其登录、Webhook 和去重记录，页面保存的飞书用户 ID 与时间也供独立后台进程读取。

内部打包时设置 `TOOLKIT_INTERNAL_TAOBAO_STATE_DIR` 为含 `webhook` 和 `recipient-id` 的本机配置目录。两项作为应用资源内置，扫码登录后即可手动运行。已有本机配置优先。普通打包不设置该变量，安装包不会内置这两项。

## 自动库存填写（三公）

业务源码位于 `Documents/ChatGPT/自动库存填写`，来源登记为 `taobao-stock`。库存匹配、Excel 黄色库存解析、任务状态、报告和安全执行引擎从该项目按文件白名单同步到 `business/taobao-stock`；Electron 接入和面板由工具箱维护。运行时复用工具箱内置 Python、Playwright 与 openpyxl。

每位同事在本机首次打开二店登录窗口，手动登录“中古Remake商店”并完成验证。独立浏览器档案、店铺绑定、Excel 快照、可恢复任务及简洁报告保存在该用户的 `team-toolkit/taobao-stock` 目录。安装包不包含这些数据。员工选择 Excel 并启动后，系统逐条核验匹配和库存，上下架结果按已验证的千牛网页内部接口回读，接口并非淘宝官方开放 API。

修改库存业务逻辑时编辑独立来源项目，运行 `python3 -m unittest discover -s tests -q`，再执行 `npm run tools:sync -- taobao-stock --apply`、`npm test` 和 `npm run tools:verify`。不手动编辑同步副本；更新工具箱运行包还需按本地安装规则构建并验收。

## 千牛搜推素材（小林）

独立源码登记为 `taobao-soutu`，通过 `npm run tools:sync -- taobao-soutu --apply` 同步。工具箱负责目录选择、浏览器会话、核对面板和发布确认。源项目与桌面版复用批处理、结果回查、重复提交拦截和整款归档逻辑。

同事打开「小林 → 千牛搜推素材」，用 Chrome 或 Edge 登录目标千牛店铺，选择共享盘「搜推素材」根目录，勾选并核对本批分组，再确认发布。标题无法唯一匹配同名多链接时，工具箱将候选主图和最多三张分组照片压缩后提交 DeepSeek 官方 API。模型无法确认或接口不可用时，填写实际核对过的商品 ID。已确认的整款移入「已上」。安全验证和待确认记录会暂停提交。共享目录同一时间只允许一个批次发布。

会话及发布记录位于该电脑本机的 `team-toolkit/taobao-soutu`。两项淘宝工具共用该电脑上加密保存的 DeepSeek 密钥，可在任一工具的模型配置处保存。安装包只含代码及运行依赖。

## 退货率报表（双姐）

独立源码位于 `Documents/ChatGPT/退货率（双姐）`，登记为 `return-rate`。修改来源后先运行 Python 单元测试，再执行 `npm run tools:sync -- return-rate --apply`。工具箱的 `business/return-rate-python/bridge.py` 通过 stdin 接收本机配置，通过 JSON 行回传进度与结果。打包复用已有的 Python、Playwright 和 openpyxl 运行环境。

常规在每月 15 日导出上一自然月的付款订单。在「双姐 → 退货率报表」默认选中上月，补跑时可改为其他已结束的月份。输入本次需要排除的商家编码并选择 Excel 保存位置。选款分组默认「钊叔制」，销量门槛默认 100 件。编码确定后分别统计全部淘宝和非淘宝店铺，再与全店统计逐款核对。进度表示已完成的处理步骤。

本机已有库存监控台配置时可直接使用。也可通过「快麦连接设置」导入含 `appKey`、`appSecret`、`session` 的 JSON，并填写 ERP 公司编号。导入凭据加密写入本机用户数据目录。Chrome 登录由独立会话管理，macOS 可复用已存在的 ERP 独立 Chrome 档案。应用资源只含桥接代码与白名单内的业务源码。

## 库存规则批量上传（谭）

独立源码位于 `Documents/ChatGPT/上传库存规则批量点击（谭）`，登记为 `erp-stock-rules`。通过 `npm run tools:sync -- erp-stock-rules --apply` 导入业务脚本及桥接程序，复用内置 Python 和 Playwright。

打开「谭 → 库存规则批量上传」，读取快麦全部规则后勾选目标。用优先级和创建时间区分同名规则。预览会打开并取消每个确认框。上传时先核对快麦规则清单，再逐条点击「上传库存」与「确定」。每条收到快麦「操作成功」提示才标记为已受理。结果待核实时，先在快麦检查对应规则，再开始下一批。

工具箱自动保存本机上次的勾选。重新读取规则时按名称、优先级和创建时间恢复仍可唯一匹配且启用了手动上传的规则。

预检和上传逐条更新进度。上传进度只计入快麦明确受理的规则，等待任务上限重试和意外中止时保留已受理条数。检测到会话变化会停止本批。补传前请查看本批结果，重新读取规则并按需要选择待补传的规则。

快麦明确返回任务上限（20030013）时，工具箱等待 3 分钟，从当次失败的规则继续。已受理规则保留，等待期间可停止重试。每次继续前重新核对快麦会话和规则清单。

工具优先复用本机快麦专用 Chrome 档案。新建档案时可尝试复用工具箱已有的快麦会话，登录过期或出现验证码时在独立窗口完成登录。规则清单 CSV 位于本机 `team-toolkit/erp-stock-rules`，安装包只含程序文件。

勾选规则后可按秒、分钟或小时启用整批循环，默认间隔为 30 分钟。首轮等待一个间隔，此后按固定的轮次开始时间执行，每轮包含全部勾选规则。上一轮未完成或电脑休眠、工具箱关闭时，错过的轮次跳过。两轮之间可调整间隔；按下停止时，正在执行的一轮会处理完毕。登录会话或规则清单变化以及上传结果不明会停止循环，需人工核对后重新启用。
