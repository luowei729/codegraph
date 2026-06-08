使用 codegraph MCP检索，请调用智能体并行工作
要求代码里每步都要中文注释功能的实现和实现的原因，为后期排查问题和开发做好基础
按照项目代码功能结构,功能区域划分规则，进行开发修改，不要擅自改变代码架构和功能划分结构。
你先规划架构，不明白的细节可以先和我提问确认，再写代码，你开发阶段可以打开 无头 chrome 访问主站页面调试验证。
每次写代码前先给"改动前总结"，写完后给"改动后总结"，每次更改变动要检查修改中文写入项目的README.md记录写入日期和时间，方便后期再开发修改的时候快速定位


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

### 0.9.11
- Initial release
- Semantic code intelligence via CodeGraph CLI
- Bilingual support (Chinese/English)
- Auto-install and auto-index
- Call graph visualization
- Impact analysis
- Real-time indexing