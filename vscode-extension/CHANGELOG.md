# CodeGraph for VSCode - 开发改动记录

> 以下记录按时间倒序排列，记录 VS Code 扩展的开发历程。
> 上游项目文件（`.gitignore`、`README.md`、`package-lock.json`）未做任何修改。

---

### 0.9.32 (2026-08-17)
- 修复「建立索引」在文件监视禁用环境下永久挂起（严重）
  - 根因：`codegraph init` 索引完成后调用 `offerWatchFallback`，在 git 仓库且文件监视被禁用（WSL2 `/mnt/*` 项目、`CODEGRAPH_NO_WATCH=1`）时弹出 `clack.select` 交互选择（"如何保持索引新鲜？"）。扩展以管道 stdin（非 TTY）spawn 子进程，clack.select 在非 TTY 下**永久挂起**等待按键（实测 8s+ 不返回、进程不退出），「建立索引」永久卡死
  - 修复：`runCliCommand` 改用管道 stdin，spawn 3 秒后注入回车（`\r`）并关闭 stdin（`end()` 模拟 EOF）--回车让 clack.select 接受默认推荐项（安装 git hooks），EOF 让流程走完后进程正常退出。仅注入回车不够：clack 的 keypress 监听会保持事件循环活跃，进程完成输出后仍不退出
  - 端到端实测：init 3s 干净退出、git hooks（post-commit/post-merge/post-checkout）正确安装、`sync` 等无交互命令不受回车+EOF 影响
  - 同时为 `runCliCommand` 增加 120s 总超时兜底（SIGKILL + reject），任何 CLI 子进程异常（挂起、损坏、死锁）不再让 UI 永久卡死
- **变更文件**:
  - `src/codegraphManager.ts` - `runCliCommand` 管道 stdin + 3s 注入回车/EOF + 120s 超时 + settle 去重
  - `package.json` - 版本 0.9.31 -> 0.9.32

---
- 交叉重新审查修复 3 个数据保护/进程生命周期 bug（0.9.30 修复的完整性补充）
  - **`configureKiloCode` 数据丢失（与 opencode 同模式）**: `kilo.jsonc` 是 JSONC 格式，旧逻辑用 `readJsonConfig`（JSON.parse）解析失败返回 `{}`，覆盖写入清空用户 Kilo Code 配置。改用 `readJsoncConfig` + null 保护
  - **通用损坏保护**: `readJsonConfig` 解析失败从返回 `{}` 改为返回 `null`（文件不存在/空白仍返回 `{}` 以支持新建），全部 12 处代理配置调用点（Claude/Cursor/Gemini/Antigravity/Kiro/Qoder/Trae/Trae CN/VS Code）在 null 时放弃写入——文件损坏（半写状态、手误）不再被整体覆盖，用户数据得以保留
  - **`McpClient.stop()` SIGKILL 兜底失效**: `proc.killed` 是"kill() 已被调用"标志（SIGTERM 后立即变 true）而非"进程已死"，子进程忽略 SIGTERM 时 5s 后的 SIGKILL 兜底永不触发，留下孤儿进程。改用 `exitCode === null && signalCode === null` 判断进程存活
  - 语义修正: 所有 configure 函数失败路径的 action 从误导性的 `'created'` 统一为 `'unchanged'`
- **变更文件**:
  - `src/agentConfig.ts` - readJsonConfig 返回 null + configReadError 助手、configureKiloCode 换 readJsoncConfig、12 处调用点 null 保护、catch action 统一
  - `src/mcpClient.ts` - stop() 存活判断改 exitCode/signalCode
  - `package.json` - 版本 0.9.30 -> 0.9.31

---
- 全面修复代码审查发现的 12 个 bug
  - **数据保护（严重）**: `configureOpencode` 解析 opencode.jsonc 失败时不再整体覆盖写入（旧逻辑用 JSON.parse 读 JSONC 失败→读到空对象→JSON.stringify 清空用户全部配置）。新增零依赖 `stripJsonc`（状态机剥离注释/尾逗号，字符串内字符不误伤）与 `readJsoncConfig`；解析失败返回 null 并放弃写入
  - **重试失效（高）**: 状态栏「重试连接」永久失效。`startCodeGraph` 拆分为公开入口（重置 retryCount）+ 内部 `doStartCodeGraph`（自动重试递归不重置）；重试边界 `< maxRetries` 改为 `<= maxRetries`，与 2s/4s/8s 注释一致
  - `findCodeGraphCommand` Windows 下 `where` 多行输出取第一行（旧逻辑多行整体传给 existsSync 恒 false，误判未安装触发多余自动安装）
  - 同名符号（不同文件重载/重名）在搜索/调用者/被调用者/影响分析 QuickPick 中用索引映射匹配，修复选中第二条也打开错误文件
  - MCP initialize 握手上报真实扩展版本号（从 `context.extension.packageJSON` 读取，替代硬编码 0.9.9）
  - MCP 进程崩溃后同步重置 `codegraph:ready` 上下文，命令面板 4 个命令不再残留显示
  - 自动安装（standalone installer / npm）增加 120s 超时，网络挂起不再卡死「正在安装」
  - 删除 `No ${displayName.toLowerCase()} found` 死代码（displayName 为中文、服务端输出英文，恒 false）
  - TreeView 错误节点不再使用固定 id（`tree-error`），避免多个错误节点 id 冲突
  - `configureClaudeCode` 权限列表补齐与 MCP 配置解耦（旧逻辑只在 mcpServers 变更时补权限），缺权限的存量用户现在也能补上
  - TreeView「搜索结果」根节点接入 `codegraph.searchSymbol` 命令（旧逻辑永远为空，死功能）
  - `configureHermes` 的 command 使用 codegraphPath 绝对路径（与 VS Code 同理，避免 Hermes spawn ENOENT）
- **变更文件**:
  - `src/agentConfig.ts` - stripJsonc/readJsoncConfig 新增、configureOpencode 数据保护、configureClaudeCode 权限幂等、configureHermes 绝对路径
  - `src/codegraphManager.ts` - startCodeGraph 拆分、handleStartError 边界、onCrash 上下文重置、where 多行、安装超时
  - `src/mcpClient.ts` - clientVersion 参数化
  - `src/commands.ts` - 索引映射匹配、删除死代码
  - `src/treeProvider.ts` - 错误节点 id 可选、search-root 接入搜索命令
  - `package.json` - 版本 0.9.29 -> 0.9.30

---

### 0.9.29 (2026-08-16)
- 修复 VS Code Chat MCP 服务器启动失败（spawn codegraph ENOENT）
  - 根因：VS Code Server 进程（Remote-SSH / Agent Host）的 PATH 不含 `~/.local/bin`（shell 配置仅在交互/登录 shell 生效），而 MCP 配置中的 command 为裸命令 `codegraph`，导致 spawn 找不到可执行文件
  - `configureVSCode` 改用 `codegraphPath`（`findCodeGraphCommand` 解析的绝对路径）作为 command 写入 mcp.json 与 `~/.copilot/mcp-config.json`，不依赖 PATH
  - `AgentConfig.configure` 接口增加可选 `codegraphPath` 参数；`configureAgents` 把绝对路径传入各代理（其它代理仍用裸命令，仅 VS Code 使用绝对路径）
- **变更文件**:
  - `src/agentConfig.ts` - `configureVSCode` 使用绝对路径、`AgentConfig` 接口与 `configureAgents` 透传 `codegraphPath`
  - `package.json` - 版本 0.9.28 -> 0.9.29

---

### 0.9.28 (2026-08-16)
- 修复 Remote-SSH / Agent Host 环境下 VS Code MCP 自动配置不生效
  - 根因：扩展在远程 Extension Host（vscode-server）运行时，`os.homedir()` 返回服务器路径，旧逻辑把配置写入 `~/.config/Code/User/mcp.json`（本机桌面版目录），而 VS Code Server 实际读取远程 userData；且 Agent Host 只读 `~/.copilot/mcp-config.json` 与 `.mcp.json`，不读 `.vscode/mcp.json`
  - `getVSCodeConfigPath()` 优先解析远程 vscode-server userData（`~/.vscode-server/data/User/mcp.json`，即 `MCP: Open Remote User Configuration` 的文件），保留本机桌面版兜底
  - 新增 `getVSCodeAgentHostConfigPath()`（`~/.copilot/mcp-config.json`），`configureVSCode()` 同时写入 Agent Host 用户级配置（`~/.copilot` 目录存在时）
  - `isVSCodeInstalled()` 增加 `~/.vscode-server/data/User` 与 `~/.copilot` 检测
  - 配置后需重启 VS Code 或重载窗口生效
- **变更文件**:
  - `src/agentConfig.ts` - 重构 `getVSCodeConfigPath`/`configureVSCode`/`isVSCodeInstalled`，新增 `getVSCodeAgentHostConfigPath`
  - `src/i18n.ts` - `agentConfig.success` 文案补充"重载窗口"
  - `package.json` - 版本 0.9.27 -> 0.9.28

---

### 0.9.27 (2026-08-16)
- 新增 VS Code 原生 MCP 自动配置支持（用户级，对所有项目生效）
  - 配置路径（自动解析两种发行形态）:
    - 稳定版: 平台相关 `Code/User/mcp.json`（Linux: `~/.config/Code/User/mcp.json`；macOS: `~/Library/Application Support/Code/User/mcp.json`；Windows: `%APPDATA%\Code\User\mcp.json`）
    - Insiders: 平台相关 `Code - Insiders/User/mcp.json`
  - 使用 VS Code 1.99+ 原生的 `servers` 顶层键（区别于 Cursor/Claude 的 `mcpServers`），复用 `MCP_SERVER_CONFIG`
  - 安装检测: 各平台 userData 目录（`Code` 或 `Code - Insiders`）任一存在
  - 配置后重启 VS Code 即可在 Copilot Chat 中使用 codegraph 工具
- **支持的代理 (13个)**: VS Code、Claude Code、Cursor、Codex CLI、opencode、Hermes Agent、Gemini CLI、Antigravity IDE、Kiro、Qoder、Kilo Code、Trae IDE、Trae CN IDE
- **变更文件**:
  - `src/agentConfig.ts` - 新增 `getVSCodeConfigPath`/`configureVSCode`/`isVSCodeInstalled` 并注册
  - `src/i18n.ts` - `agentConfig.noAgents`/`agentConfig.configuring` 文案补充 VS Code
  - `package.json` - 版本 0.9.26 -> 0.9.27

---

### 0.9.26 (2026-08-02)
- 变更记录与代码注释文案精简
  - 去除地区性/非正式表述，适配扩展商店审核要求
  - 涉及 `agentConfig.ts` 中 Trae CN 相关注释、`CHANGELOG.md`
  - 保留 "Trae CN" 产品名，仅清理描述性地区文案
- **变更文件**:
  - `src/agentConfig.ts` - Trae CN 相关注释文案精简
  - `CHANGELOG.md` - 0.9.25 条目精简
  - `package.json` - 版本 0.9.25 -> 0.9.26

---

### 0.9.25 (2026-08-02)
- 新增 Trae CN IDE MCP 自动配置支持
  - 配置路径（自动解析两种发行形态）:
    - SOLO/服务端形态: `~/.trae-cn-server/data/Machine/mcp.json`
    - 桌面版: 平台相关 `Trae CN/User/mcp.json`（Linux / macOS / Windows）
  - 使用 `mcpServers` 键，复用 `MCP_SERVER_CONFIG`，与 Trae IDE 独立配置、可共存
  - 安装检测: `~/.trae-cn`、`~/.trae-cn-server` 或平台 `Trae CN` 目录
- **支持的代理 (12个)**: Claude Code、Cursor、Codex CLI、opencode、Hermes Agent、Gemini CLI、Antigravity IDE、Kiro、Qoder、Kilo Code、Trae IDE、Trae CN IDE
- **变更文件**:
  - `src/agentConfig.ts` - 新增 `getTraeCnConfigPath`/`configureTraeCn`/`isTraeCnInstalled` 并注册
  - `src/i18n.ts` - `agentConfig.noAgents` 文案补充
  - `package.json` - 版本 0.9.24 -> 0.9.25

---

### 0.9.24 (2026-08-02)
- **代码审查修复 7 个 bug**（3 major + 4 minor，经双子代理交叉验证）
  - **Fix#4 (major)** `McpClient` 的 `close` 处理器补 `else` 兜底：进程在握手完成前以 `code=0` 干净退出时，原三个分支均不命中，挂起的 `initialize` 请求永不 reject，`start()` 无超时兜底导致永久挂起。现补 `else { rejectPending(...) }`，由 `start()` reject 走重试逻辑，避免误报崩溃。
  - **Fix#7 (major)** `configureHermes` 改为真正 upsert：旧实现对非标准 `command`（如绝对路径）的不变性检查失败后无条件追加，产生重复/畸形 `mcp_servers:` YAML 块且每次累积。现改为定位并就地替换 codegraph 块，保留同级其他服务器，幂等。
  - **Fix#2 (major)** `getSymbolAtCursor` 修复限定名逻辑：旧实现一律返回限定名末段，丢弃类名限定（与 Bug #9 文档意图矛盾），且光标在接收者 `obj` 上时误返回 `method`。现：光标在非末段返回光标裸词；接收者为 PascalCase（如 `Class.method`）时返回完整限定名（CodeGraph `matchesSymbol` 支持按 `Class::method` 后缀精确消歧）；接收者像变量则返回裸名聚合所有同名重载。
  - **Fix#1 (minor)** `promptInitialize` 改用现成 i18n 键 `prompt.initQuestion`，去掉硬编码中文 `' 是否立即建立索引？'`（原为未使用的死键），英文用户不再看到中英混杂文案。
  - **Fix#3 (minor)** `parseFilePaths` 去掉 `includes('/')||includes('.')` 过激过滤，该启发式会滤掉根目录无扩展名文件（`Makefile`/`Dockerfile`/`LICENSE`）。flat 格式下每个 `- ` 行都是真实路径，仅排除空串即可。
  - **Fix#5 (minor)** `configureAgentsManual` 去重复通知：`silent=false` 时 `configureAgents` 已自行显示「已配置」消息，移除外层重复的 `showInformationMessage`。
  - **Fix#6 (minor)** `onCrash` 增加 `signal` 参数：被信号终止时 `code` 为 null，原传 `null` 导致用户看到「code null」丢失真实信号（如 SIGKILL）。现传入 signal，文案显示「signal SIGKILL」。`connect.crashed` i18n 文案相应调整为通用 `{0}`。
- **变更文件**:
  - `vscode-extension/src/mcpClient.ts` - Fix#4 (else 兜底) + Fix#6 (onCrash 签名/调用)
  - `vscode-extension/src/agentConfig.ts` - Fix#7 (configureHermes upsert，移除未用的 buildYamlMcpBlock)
  - `vscode-extension/src/commands.ts` - Fix#2 (getSymbolAtCursor 限定名)
  - `vscode-extension/src/codegraphManager.ts` - Fix#1 (promptInitialize i18n) + Fix#5 (去重复通知) + Fix#6 (onCrash handler)
  - `vscode-extension/src/treeProvider.ts` - Fix#3 (parseFilePaths 过滤)
  - `vscode-extension/src/i18n.ts` - Fix#6 (connect.crashed 文案)
  - `vscode-extension/package.json` - 版本 0.9.23 -> 0.9.24

---

### 0.9.23 (2026-08-02)
- 新增 Trae IDE MCP 自动配置支持
  - 配置路径（自动解析两种发行形态）:
    - SOLO/服务端形态: `~/.trae-server/data/Machine/mcp.json`（实测本机形态）
    - 标准桌面版: 平台相关 `Trae/User/mcp.json`（Linux: `~/.config/Trae/User/mcp.json`；macOS: `~/Library/Application Support/Trae/User/mcp.json`；Windows: `%APPDATA%\Trae\User\mcp.json`）
  - 使用 `mcpServers` 键（与 Cursor/Claude 一致），复用 `MCP_SERVER_CONFIG`
  - 安装检测: 标记目录 `~/.trae`、`~/.trae-server` 或平台桌面版 `Trae` 目录
- **支持的代理 (11个)**:
  - Claude Code、Cursor、Codex CLI、opencode、Hermes Agent
  - Gemini CLI、Antigravity IDE、Kiro、Qoder、Kilo Code、Trae IDE
- **变更文件**:
  - `vscode-extension/src/agentConfig.ts` - 新增 `getTraeConfigPath`/`configureTrae`/`isTraeInstalled`，注册到 `getAgentConfigs`
  - `vscode-extension/src/i18n.ts` - `agentConfig.noAgents` 文案加入 Trae
  - `vscode-extension/package.json` - 版本 0.9.22 -> 0.9.23

---

### 0.9.22 (2026-06-30)
- 正式支持 Kilo Code MCP 自动配置
  - 配置路径: `~/.config/kilo/kilo.jsonc` (全局)
  - 项目级: `kilo.jsonc` 或 `.kilo/kilo.jsonc`
  - 使用 `mcp` 键（不是 `mcpServers`），command 为数组格式

---

### 0.9.21 (2026-06-30)
- 新增 Kilo Code 支持
  - 配置路径: `~/.config/kilo/kilo.jsonc` (全局)
  - 项目级: `kilo.jsonc` 或 `.kilo/kilo.jsonc`
  - 使用 `mcp` 键（不是 `mcpServers`）
  - command 为数组格式
- **支持的代理 (10个)**:
  - Claude Code、Cursor、Codex CLI、opencode、Hermes Agent
  - Gemini CLI、Antigravity IDE、Kiro、Qoder、Kilo Code

---

### 0.9.20 (2026-06-30)
- **重大改进**: 完整实现所有官方支持的 AI 代理 MCP 自动配置
  - **支持的代理 (9个)**:
    - **Claude Code**: JSON (~/.claude.json + ~/.claude/settings.json 权限)
    - **Cursor**: JSON (~/.cursor/mcp.json)
    - **Codex CLI**: TOML (~/.codex/config.toml)
    - **opencode**: JSONC (~/.config/opencode/opencode.jsonc)
    - **Hermes Agent**: YAML (~/.hermes/config.yaml)
    - **Gemini CLI**: JSON (~/.gemini/settings.json)
    - **Antigravity IDE**: JSON (~/.gemini/antigravity/mcp_config.json)
    - **Kiro**: JSON (~/.kiro/config.json)
    - **Qoder**: JSON (~/.config/QoderCN/SharedClientCache/mcp.json)
  - **特性**:
    - 自动检测已安装的代理
    - 幂等性：重复运行不会产生重复配置
    - 最小侵入：只添加/更新 codegraph 配置，保留其他配置
    - 原子写入：防止文件损坏
    - Claude Code 自动添加工具权限
  - **变更文件**:
    - `vscode-extension/src/agentConfig.ts` — 完全重写，直接写入配置文件
    - `vscode-extension/src/i18n.ts` — 添加新翻译键
    - `vscode-extension/package.json` — 版本 0.9.20

---

## Changelog

### 0.9.17 (2026-06-08)
- **修复**: MCP 服务启动报错 `Executable not found in $PATH: "codegraph"`
  - **根因**: VS Code 扩展宿主进程继承的 PATH 可能不包含 `~/.local/bin`（codegraph 独立安装器的默认安装位置），导致 `spawn('codegraph', ...)` 找不到可执行文件
  - **修复方案**:
    1. 新增 `buildSpawnEnv()` 方法：在 spawn 子进程前主动将 `~/.local/bin`、`~/.codegraph/bin`、`/usr/local/bin` 加入 PATH 环境变量
    2. `findCodeGraphCommand()` 使用增强后的 PATH 执行 `which codegraph`
    3. `McpClient` 构造函数新增 `env` 参数，spawn 时使用增强后的环境变量
    4. `runCliCommand()` 也使用增强后的环境变量
  - **影响范围**: 所有 spawn codegraph 子进程的地方（MCP 服务启动、CLI 命令执行）
- **修复**: `install.sh` 自动将 `~/.local/bin` 写入 shell 配置文件（`.bashrc`/`.zshrc`/`.profile` 等），不再仅打印提示

### 0.9.16 (2026-06-08)
- 修复: MCP 服务启动报错 `Executable not found in $PATH: "codegraph"`
  - 原因: `/root/.local/bin` 未加入系统 PATH，导致 IDE 的 MCP 客户端找不到 `codegraph` 可执行文件
  - 修复方案:
    1. 在 `~/.bashrc` 中添加 `export PATH="$HOME/.local/bin:$PATH"`
    2. 将 `.cursor/mcp.json` 中的 `"command": "codegraph"` 改为绝对路径 `"/root/.local/bin/codegraph"`
    3. 重新编译 `vscode-extension/out/` 确保代码最新
  - 验证: MCP 服务可通过绝对路径正常启动并返回 initialize 响应

  ## 修改记录

### 2026-06-08 17:05 修复 VS Code 插件 MCP 报错 `Executable not found in $PATH: "codegraph"`

**问题根因**: 
- VS Code 扩展宿主进程继承的 PATH 可能不包含 `~/.local/bin`（codegraph 独立安装器的默认安装位置）
- `install.sh` 只打印提示但不自动配置 PATH，导致 `codegraph` 命令在 IDE 环境中不可见

**修复内容**:
1. **`install.sh`**: 自动将 `~/.local/bin` 写入 shell 配置文件（`.bashrc`/`.zshrc`/`.profile` 等）
2. **VS Code 扩展 v0.9.17**:
   - 新增 `buildSpawnEnv()` 方法，在 spawn 子进程前主动将常见安装目录加入 PATH
   - `McpClient` 支持传入自定义环境变量
   - `findCodeGraphCommand()` 和 `runCliCommand()` 均使用增强后的 PATH

**验证**: 重新打包 `codegraph-vscode-plugin-0.9.17.vsix`，安装后 MCP 服务可正常启动

### 0.9.11
- Initial release
- Semantic code intelligence via CodeGraph CLI
- Bilingual support (Chinese/English)
- Auto-install and auto-index
- Call graph visualization
- Impact analysis
- Real-time indexing


### 2026-06-08 07:52

**改动内容：** 修复删除索引时弹窗报错"服务进程意外退出"

**Bug 描述：**
- 建立索引后 → 点击「删除索引」→ 弹窗报错："CodeGraph 服务进程意外退出（代码 null）"

**根本原因：**
`deleteIndex()` 调用 `this.client?.stop()` 时，`stop()` 向子进程发送 `SIGTERM` 信号。
子进程收到信号后退出，触发 `close` 事件（`signal='SIGTERM'`, `code=null`）。
`close` 事件处理器将信号终止视为异常崩溃，调用 `onCrash` 回调 →
Manager 显示错误弹窗："服务进程意外退出"。

但这是**有意终止**，不是异常崩溃。`close` 事件处理器无法区分两者。

**修复方案：**
- 在 `McpClient` 中新增 `intentionalStop` 标志
- `stop()` 调用时设置 `intentionalStop = true`
- `close` 事件处理器检查此标志：如果为 true，跳过 `onCrash` 回调，不显示错误弹窗
- 处理完成后重置标志，不影响下次启动

**变更文件：**
- `vscode-extension/src/mcpClient.ts` — 新增 `intentionalStop` 标志；`stop()` 中设置标志；`close` 事件处理器中检查标志
- `vscode-extension/package.json` — version 改为 `0.9.16`

**验证：**
- TypeScript 编译通过，0 错误 0 警告
- 打包成功: `codegraph-vscode-plugin-0.9.16.vsix` (84 KB)

---

### 2026-06-08 07:43

**改动内容：** 修复新项目建立索引卡住的问题

**Bug 描述：**
- 新项目打开 → 弹窗提示「建立索引」→ 点击后卡住
- Developer: Reload Window 后索引才能建立成功

**根本原因：**
`runCliCommand()` 使用 `spawn()` 运行 `codegraph init -i` 时，只监听了 `stderr`，没有消费 `stdout`。
CodeGraph 的 `init` 命令使用 clack（交互式终端 UI）输出进度条到 stdout，
当 OS 管道缓冲区（Linux 默认 64KB）被 stdout 数据填满后，
子进程的 `write()` 调用被阻塞，进程挂起 → `close` 事件永远不触发 →
`runCliCommand()` 的 Promise 永远不 resolve → `initialize()` 卡住。

Reload Window 后成功是因为：`.codegraph/` 已由第一次 init 创建（在管道填满前已完成），
所以 `activate()` 走 `isInit=true` 路径直接启动 MCP 服务器，跳过了 init 命令。

**修复方案：**
- 在 `runCliCommand()` 中添加 `child.stdout.on('data', ...)` 消费 stdout 数据
- 同时将进度输出记录到控制台（截断防刷屏），方便调试

**变更文件：**
- `vscode-extension/src/codegraphManager.ts` — `runCliCommand()` 新增 stdout 消费
- `vscode-extension/package.json` — version 改为 `0.9.15`

**验证：**
- TypeScript 编译通过，0 错误 0 警告
- 打包成功: `codegraph-vscode-plugin-0.9.15.vsix` (83 KB)

---

### 2026-06-08 07:03

**改动内容：** 完全隔离扩展代码 — 还原上游文件 + 迁移开发日志

**变更：**
1. **还原上游文件** — `.gitignore`、`README.md`、`package-lock.json` 还原为上游原始版本，`AGENTS.md` 删除
2. **迁移开发日志** — 从根目录 `README.md` 迁移到 `vscode-extension/CHANGELOG.md`
3. **扩展 .gitignore** — 将扩展构建产物忽略规则从根 `.gitignore` 移到 `vscode-extension/.gitignore`

**变更文件：**
- `.gitignore` — 还原为上游原始版本（无修改）
- `README.md` — 还原为上游原始版本（无修改）
- `package-lock.json` — 还原为上游原始版本（无修改）
- `AGENTS.md` — 删除
- `vscode-extension/CHANGELOG.md` — 新建开发改动记录文件
- `vscode-extension/.gitignore` — 新建扩展专属忽略规则

**验证：**
- 上游 4 个文件零改动，`git diff` 无差异
- 打包成功: `codegraph-vscode-plugin-0.9.14.vsix`

---

### 2026-06-08 06:43

**改动内容：** 修复 Marketplace 详情页不显示 GitHub 仓库链接

**变更：**
1. **repository URL** — `package.json` 中 `repository.url` 必须以 `.git` 结尾，Marketplace 才能识别并显示在 Resources 区域
2. **版本号** — 从 `0.9.12` 升级到 `0.9.13`

**变更文件：**
- `vscode-extension/package.json` — repository.url 添加 `.git` 后缀；version 改为 `0.9.13`

**验证：**
- 打包成功: `codegraph-vscode-plugin-0.9.13.vsix` (78 KB, 33 files)

---

### 2026-06-08 06:37

**改动内容：** 添加 GitHub 仓库链接 + 版本号升级 + URL 统一

**变更：**
1. **GitHub 仓库** — `package.json` 新增 `repository`、`bugs`、`homepage` 字段，指向 `https://github.com/luowei729/codegraph`
2. **版本号** — 从 `0.9.11` 升级到 `0.9.12`
3. **URL 统一** — 代码和文档中所有 `colbymchenry/codegraph` 引用更新为 `luowei729/codegraph`

**变更文件：**
- `vscode-extension/package.json` — 新增 repository/bugs/homepage；version 改为 `0.9.12`
- `vscode-extension/README.md` — GitHub/Issues/CLI 链接更新为 luowei729/codegraph
- `vscode-extension/src/codegraphManager.ts` — 安装脚本 URL 从 colbymchenry 更新为 luowei729（9 处）

**验证：**
- TypeScript 编译通过，0 错误 0 警告
- 打包成功: `codegraph-vscode-plugin-0.9.12.vsix` (78 KB, 33 files)

---

### 2026-06-08 06:32

**改动内容：** 添加插件自述文件 + 版本号升级

**变更：**
1. **README.md** — 新建 `vscode-extension/README.md` 插件自述文件（英文），Marketplace 页面将显示此文件
2. **版本号** — 从 `0.9.10` 升级到 `0.9.11`

**变更文件：**
- `vscode-extension/README.md` — 新建插件自述文件（~180 行）
- `vscode-extension/package.json` — version 从 `0.9.10` 改为 `0.9.11`

**验证：**
- 打包成功: `codegraph-vscode-plugin-0.9.11.vsix` (77 KB, 33 files)

---

### 2026-06-08 06:25

**改动内容：** 应用市场显示名称更新

**变更：**
1. **displayName** — 从 "CodeGraph for VS Code" 改为 "CodeGraph for VSCode"
2. **Activity Bar title** — 同步更新为 "CodeGraph for VSCode"

**变更文件：**
- `vscode-extension/package.json` — displayName 和 viewsContainers.activitybar.title 改为 "CodeGraph for VSCode"

**验证：**
- 打包成功: `codegraph-vscode-plugin-0.9.10.vsix` (75 KB, 32 files)

---

### 2026-06-08 06:00

**改动内容：** 修复 Marketplace 发布限制 — SVG 图标转 PNG

**变更：**
1. **Marketplace 图标** — VS Code Marketplace 不允许 SVG 格式扩展图标，使用 `sharp` 将 `logo.svg` 转为 `logo.png`（256x256）
2. **publisher** — 从 `colbymchenry` 改为 `videostack`
3. **name** — 从 `codegraph-vscode` 改为 `codegraph-for-vscode`

**变更文件：**
- `vscode-extension/logo.png` — 新建 PNG 图标（256x256）
- `vscode-extension/package.json` — 添加 `"icon": "logo.png"`；publisher/name 更新

**验证：**
- 打包成功: `codegraph-for-vscode-0.9.10.vsix` (76 KB, 33 files)

---

### 2026-06-08 05:40

**改动内容：** UI 优化 — Activity Bar 悬停名称、图标、刷新按钮双语化

**变更：**
1. **Activity Bar 悬停名称** — title 改为 "CodeGraph for VS Code"
2. **Activity Bar 图标** — 使用自定义 `logo.svg`
3. **刷新按钮** — 使用 VS Code 内置 codicon `$(refresh)` 图标
4. **双语 NLS 支持** — 新增 `package.nls.json`（英文）、`package.nls.zh-cn.json`（简体中文）、`package.nls.zh-tw.json`（繁体中文）

**变更文件：**
- `vscode-extension/resources/icon.svg` — 使用用户自定义 logo.svg
- `vscode-extension/package.json` — title 和 NLS 占位符更新
- `vscode-extension/package.nls.json` / `package.nls.zh-cn.json` / `package.nls.zh-tw.json` — 新建

**验证：**
- TypeScript 编译通过，0 错误 0 警告

---

### 2026-06-08 04:55

**改动内容：** 插件功能增强 — displayName、索引按钮、双语支持、自动安装

**新增功能：**
1. **displayName** 改为 "CodeGraph for VS Code"
2. **侧边栏按钮** — 新增「建立索引」和「删除索引」按钮
3. **双语支持 (zh/en)** — 新增 `i18n.ts` 模块
4. **自动安装 CodeGraph** — 独立安装脚本 + npm 降级
5. **删除索引** — 新增 `codegraph.deleteIndex` 命令
6. **跨平台支持** — 新增 Windows/macOS/Linux 常见安装路径检测

**变更文件：**
- `vscode-extension/src/i18n.ts` — 新增双语 i18n 模块（~480 行）
- `vscode-extension/src/codegraphManager.ts` — 新增 buildIndex/deleteIndex/autoInstall 等方法
- `vscode-extension/src/commands.ts` — 注册新命令
- `vscode-extension/src/treeProvider.ts` — 新增 installing 状态节点
- `vscode-extension/src/extension.ts` — 错误提示改用 t() 函数
- `vscode-extension/package.json` — 新增命令和菜单项

**验证：**
- TypeScript 编译通过，0 错误 0 警告

---

### 2026-06-08 12:30

**改动内容：** 第二轮审查修复 — 10 个 bug（A-J）

**修复问题：**

🔴 致命 Bug：
- **Bug A** - `parseFilePaths()` 无法解析 tree 格式输出 → 改用 `format: 'flat'`
- **Bug B** - FTS5 裸 `*` 返回 0 结果 → 改用空字符串

🟠 严重 Bug：
- **Bug C** - `extractMcpText()` 不区分 isError → 返回 `{ text, isError }`
- **Bug D** - close 事件不处理信号终止 → 新增 signal 检查
- **Bug E** - start() 无并发保护 → 新增 startPromise guard

🟡 中等问题：
- **Bug F** - `require('path')` 每次调用加载模块 → 顶层 import
- **Bug G** - 每次创建新 OutputChannel → 缓存实例

🔵 小问题：
- **Bug H** - stopAndRestart() 意图不清 → 显式 null 检查
- **Bug I** - parseFilePaths() 跳过 `-` 行 → 重写匹配逻辑
- **Bug J** - activate() 无 try-catch → 添加全局异常处理

**验证：**
- TypeScript 编译通过，0 错误 0 警告

---

### 2026-06-08 12:15

**改动内容：** 修复 VS Code 扩展全部严重 bug 和逻辑缺陷（10+ 项修复）

**修复问题：**

🔴 致命 Bug：
1. **Bug #1** - MCP 响应格式不匹配 → 添加文本解析器
2. **Bug #2** - 缺少 initialized 通知 → 新增 sendNotification()
3. **Bug #3** - SIGKILL 定时器引用 null → 保存局部变量
4. **Bug #4** - 进程崩溃无人监控 → 添加 onCrash 回调

🟠 严重 Bug：
5. **Bug #5** - codegraph:enabled 上下文未设置 → activate() 中立即设置
6. **Bug #6** - 图标语法错误 → 改用 SVG 文件路径

🟡 中等问题：
7. **Bug #7** - TreeView 无数据加载 → 新增 fetchFilesRoot/fetchSymbolsRoot
8. **Bug #10** - reindex 断开重连 → 改用 codegraph sync
9. **Bug #8** - findCodeGraphCommand 声明 async 但用 execSync → 改为同步

🔵 小问题：
10. **Bug #9** - getSymbolAtCursor 只取单词 → 匹配限定名

**验证：**
- TypeScript 编译通过，0 错误 0 警告

---

### 2026-06-08 04:05

**改动内容：** 修复 VS Code 扩展代码缺陷和完善功能

**修复问题：**
1. `stop()` 中 setTimeout 无取消机制
2. `sendRequest()` 写操作缺少 try-catch
3. `showStatusMenu()` 图标无法渲染
4. `openNodeLocation()` 未处理相对路径
5. `openNodeLocation()` 缺少 manager 参数
6. 缺少 onDidSaveTextDocument 监听

**验证：**
- TypeScript 编译通过，无错误无警告

---

### 2026-06-08 03:45

**改动内容：** 新增 VS Code 扩展 (`vscode-extension/`)

**改动原因：**
- 为 CodeGraph 增加 VS Code 插件功能
- 通过 MCP stdio 协议与 CodeGraph 子进程通信

**改动范围：**
- 新建目录 `vscode-extension/`，包含完整的 VS Code 扩展实现
- `package.json` / `tsconfig.json` / `extension.ts` / `mcpClient.ts` / `codegraphManager.ts` / `treeProvider.ts` / `commands.ts`

**设计要点：**
- 不破坏现有代码结构，所有新文件在独立目录中
- 4 状态 FSM（uninitialized → indexing → ready → error）
- 三级自动降级策略
- 指数退避重试机制（最多 3 次）
- 自动检测 `.codegraph/` 目录

**兼容性：**
- 不影响现有 CLI、MCP 服务器或核心库
- 对 fork 用户完全透明（可选功能）
