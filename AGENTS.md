# 钊叔工具箱

先读 integration/README.md。界面、登录会话、IPC、更新器归本仓库。业务源码归integration/tools.json 中登记的独立项目；不直接修改 modules 下的导入副本或 tools.json 中列出的 Python 导入文件。应修改来源、测试，再通过 tools:sync 导入。

共享盘文件默认只读。测试使用临时合成文件，或经明确授权的本机副本。发布包不含工作簿、登录状态或历史接口响应。
