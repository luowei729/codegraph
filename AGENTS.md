- 使用 codegraph MCP检索 和 semantic_search向量索引 来检索
- 请调用智能体和Worktree并行工作 确保阅读过项目所有md
- 维护项目的所有md文档，有些文档内容可能过时要分辨
- 要求代码里每步都要中文注释功能的实现和实现的原因，为后期排查问题和开发做好基础
- 按照项目代码功能结构,功能区域划分规则，进行开发修改，不要擅自改变代码架构和功能划分结构。
- 你先规划架构，不明白的细节可以先和我提问确认，再写代码，你开发阶段可以打开 无头 chrome 访问主站页面调试验证。
- 每次写代码前先给"改动前总结"，写完后给"改动后总结
- 每次更改变动要按照格式中文写入项目对应根目录下的AGENTS.md CHANGELOG.md DEPLOY_CREDENTIALS.md PROJECT_PLAN.md记录写入北京时间和日期，方便后期再开发修改的时候快速定位
- 把在本项目需要长期记住的开发提示，写到本文件的下方，记录写入北京时间和日期
- 最小化侵入，不用改原始项目 后期好同步源作者代码 只在 vscode-extension/ 目录里面修改

---
开发提示如下：
- [2000-06-22 18:59:00] 演示条目
- [2026-08-02 03:59:57] vscode-extension 新增 Trae IDE 自动 MCP 配置。Trae 有两种发行形态：SOLO/服务端用 `~/.trae-server/data/Machine/mcp.json`（本机实跑形态），标准桌面版用平台相关 `Trae/User/mcp.json`。新增 `getTraeConfigPath()` 自动解析路径、`configureTrae()` 写 mcpServers.codegraph、`isTraeInstalled()` 检测 `~/.trae`/`~/.trae-server`/平台桌面目录。仅改 vscode-extension/，未动上游 src/。版本 0.9.22 -> 0.9.23。
- [2026-08-02 04:26:01] vscode-extension 代码审查修复 7 个 bug（0.9.24）。Fix#4 mcpClient close 处理器补 else 兜底，防 ready 前 code=0 退出致 start() 永久挂起；Fix#7 configureHermes 改 upsert 就地替换 codegraph 块，防非标准 command 时追加重复 mcp_servers YAML；Fix#2 getSymbolAtCursor 修复限定名（PascalCase 接收者返完整限定名、光标在接收者返裸词、变量接收者返末段）；Fix#1 promptInitialize 改用 i18n 死键 prompt.initQuestion；Fix#3 parseFilePaths 去掉过激过滤（保留 Makefile 等无扩展名根文件）；Fix#5 configureAgentsManual 去重复通知；Fix#6 onCrash 加 signal 参数修复信号名丢失。注意：commands.ts/agentConfig.ts 含 em-dash（U+2014）与行尾空格，编辑时需精确匹配。
- [2026-08-02 05:13:07] vscode-extension 新增 Trae CN IDE（国内版）自动 MCP 配置（0.9.25）。本机实测 Trae CN 与国际版目录完全对称：`.trae-cn`+`.trae-cn-server`，SOLO 配置路径 `~/.trae-cn-server/data/Machine/mcp.json`（CSDN 文章说的 `~/.trae-cn/mcp.json` 不准确，该目录是运行时资源不放 mcp 配置）。桌面版三平台 `Trae CN/User/mcp.json`（godot-mcp README 确认）。新增 `getTraeCnConfigPath()`/`configureTraeCn()`/`isTraeCnInstalled()`，与国际版独立配置可共存。i18n noAgents 文案加 Trae CN。仅改 vscode-extension/，未动上游 src/。版本 0.9.24 -> 0.9.25。
