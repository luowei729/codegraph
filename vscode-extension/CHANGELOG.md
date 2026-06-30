# CodeGraph for VSCode - 开发改动记录

> 以下记录按时间倒序排列，记录 VS Code 扩展的开发历程。
> 上游项目文件（`.gitignore`、`README.md`、`package-lock.json`）未做任何修改。

---

### 0.9.20 (2026-06-30)
- **新增功能**: 支持 Qoder AI 代理的 MCP 自动配置
  - **配置路径**: `~/.config/QoderCN/SharedClientCache/mcp.json`
  - **实现**: 新增 `src/installer/targets/qoder.ts` 模块
  - **功能**: 
    - 自动检测 Qoder 是否已安装
    - 自动写入 CodeGraph MCP 服务器配置
    - 支持幂等安装（重复运行不会产生重复配置）
    - 支持卸载（移除 CodeGraph 配置）
  - **变更文件**:
    - `src/installer/targets/qoder.ts` — 新增 Qoder target 实现
    - `src/installer/targets/registry.ts` — 注册 qoderTarget
    - `src/installer/targets/types.ts` — 添加 'qoder' 到 TargetId 联合类型
    - `package.json` — 版本升级到 0.9.20

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
