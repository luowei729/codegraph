/**
 * Agent Auto-Configuration Module
 *
 * 直接写入 MCP 配置到各 AI 代理的配置文件，不依赖 CLI 命令。
 *
 * 支持的代理及其配置格式：
 * - Claude Code: JSON 格式 (~/.claude.json + ~/.claude/settings.json 权限)
 * - Cursor: JSON 格式 (~/.cursor/mcp.json)
 * - Codex CLI: TOML 格式 (~/.codex/config.toml)
 * - opencode: JSONC 格式 (~/.config/opencode/opencode.jsonc)
 * - Hermes Agent: YAML 格式 (~/.hermes/config.yaml)
 * - Gemini CLI: JSON 格式 (~/.gemini/settings.json)
 * - Antigravity IDE: JSON 格式 (~/.gemini/antigravity/mcp_config.json)
 * - Kiro: JSON 格式 (~/.kiro/config.json)
 * - Qoder: JSON 格式 (~/.config/QoderCN/SharedClientCache/mcp.json)
 *
 * 设计原则：
 * - 幂等性：重复运行不会产生重复配置
 * - 最小侵入：只添加/更新 codegraph 配置，保留其他配置
 * - 原子写入：防止文件损坏
 * - 自动检测：检测代理是否已安装
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { t } from './i18n';

/**
 * 代理配置结果
 */
export interface AgentConfigResult {
  /** 是否成功 */
  success: boolean;
  /** 是否所有代理都已配置（无需更改） */
  alreadyConfigured: boolean;
  /** 人类可读的摘要 */
  message: string;
}

/**
 * MCP 服务器配置模板（JSON 格式）
 */
const MCP_SERVER_CONFIG = {
  type: 'stdio',
  command: 'codegraph',
  args: ['serve', '--mcp'],
};

/**
 * Claude Code 权限列表
 */
const CODEGRAPH_PERMISSIONS = [
  'mcp__codegraph__codegraph_explore',
  'mcp__codegraph__codegraph_search',
  'mcp__codegraph__codegraph_node',
  'mcp__codegraph__codegraph_callers',
  'mcp__codegraph__codegraph_callees',
  'mcp__codegraph__codegraph_impact',
  'mcp__codegraph__codegraph_files',
  'mcp__codegraph__codegraph_status',
];

/**
 * opencode MCP 服务器配置
 */
const OPENCODE_MCP_CONFIG = {
  type: 'local',
  command: ['codegraph', 'serve', '--mcp'],
  enabled: true,
};

/**
 * 代理配置定义
 */
interface AgentConfig {
  /** 代理名称 */
  name: string;
  /** 检测函数：检查代理是否已安装 */
  isInstalled: () => boolean;
  /** 配置函数：写入 MCP 配置 */
  configure: () => { action: 'created' | 'updated' | 'unchanged'; success: boolean; error?: string };
}

/**
 * 深度比较两个对象是否相等
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao).sort();
  const bk = Object.keys(bo).sort();
  
  if (ak.length !== bk.length) return false;
  if (!ak.every((k, i) => k === bk[i])) return false;
  return ak.every((k) => deepEqual(ao[k], bo[k]));
}

/**
 * 读取 JSON 配置文件
 */
function readJsonConfig(filePath: string): Record<string, any> {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    console.warn(`[CodeGraph] 无法解析配置文件 ${filePath}:`, err);
    return {};
  }
}

/**
 * 原子写入 JSON 配置文件
 */
function writeJsonConfig(filePath: string, data: Record<string, any>): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  
  const tmpPath = filePath + '.tmp.' + process.pid;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * 原子写入文本文件
 */
function atomicWriteFileSync(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  
  const tmpPath = filePath + '.tmp.' + process.pid;
  try {
    fs.writeFileSync(tmpPath, content);
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * 构建 TOML 配置块
 */
function buildTomlTable(header: string, data: Record<string, any>): string {
  const lines: string[] = [`[${header}]`];
  
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value)) {
      lines.push(`${key} = [${value.map(v => `"${v}"`).join(', ')}]`);
    } else if (typeof value === 'string') {
      lines.push(`${key} = "${value}"`);
    } else {
      lines.push(`${key} = ${value}`);
    }
  }
  
  return lines.join('\n');
}

/**
 * 检查 TOML 文件是否包含指定的表
 */
function tomlHasTable(content: string, header: string): boolean {
  return content.includes(`[${header}]`);
}

/**
 * 向 TOML 文件中添加或更新表
 */
function upsertTomlTable(content: string, header: string, tableBlock: string): { content: string; action: 'created' | 'updated' | 'unchanged' } {
  if (tomlHasTable(content, header)) {
    const lines = content.split('\n');
    let inTargetTable = false;
    const existingLines: string[] = [];
    
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === `[${header}]`) {
        inTargetTable = true;
        continue;
      }
      if (inTargetTable) {
        if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
          break;
        }
        if (trimmed && !trimmed.startsWith('#')) {
          existingLines.push(trimmed);
        }
      }
    }
    
    const existingBlock = `[${header}]\n${existingLines.join('\n')}`;
    if (existingBlock === tableBlock) {
      return { content, action: 'unchanged' };
    }
    
    // 移除旧表，然后添加新表
    const newLines: string[] = [];
    inTargetTable = false;
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === `[${header}]`) {
        inTargetTable = true;
        continue;
      }
      if (inTargetTable) {
        if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
          inTargetTable = false;
          newLines.push(line);
        }
        continue;
      }
      newLines.push(line);
    }
    
    const newContent = newLines.join('\n').trimEnd() + '\n\n' + tableBlock + '\n';
    return { content: newContent, action: 'updated' };
  }
  
  const newContent = content.trimEnd() + '\n\n' + tableBlock + '\n';
  return { content: newContent, action: 'created' };
}

/**
 * 构建 YAML MCP 服务器配置块
 */
function buildYamlMcpBlock(): string[] {
  return [
    'mcp_servers:',
    '  codegraph:',
    '    command: codegraph',
    '    args:',
    '      - serve',
    '      - --mcp',
    '    timeout: 120',
    '    connect_timeout: 60',
    '    enabled: true',
  ];
}

/**
 * 配置 Claude Code
 */
function configureClaudeCode(): { action: 'created' | 'updated' | 'unchanged'; success: boolean; error?: string } {
  try {
    const homeDir = os.homedir();
    const mcpPath = path.join(homeDir, '.claude.json');
    const settingsPath = path.join(homeDir, '.claude', 'settings.json');
    
    // 1. 写入 MCP 服务器配置
    const mcpConfig = readJsonConfig(mcpPath);
    const existingMcp = mcpConfig.mcpServers?.codegraph;
    
    if (!deepEqual(existingMcp, MCP_SERVER_CONFIG)) {
      if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {};
      mcpConfig.mcpServers.codegraph = MCP_SERVER_CONFIG;
      writeJsonConfig(mcpPath, mcpConfig);
      
      const mcpAction = existingMcp ? 'updated' : 'created';
      
      // 2. 写入权限配置
      const settings = readJsonConfig(settingsPath);
      if (!settings.permissions) settings.permissions = {};
      if (!Array.isArray(settings.permissions.allow)) settings.permissions.allow = [];
      
      const beforePermissions = [...settings.permissions.allow];
      for (const perm of CODEGRAPH_PERMISSIONS) {
        if (!settings.permissions.allow.includes(perm)) {
          settings.permissions.allow.push(perm);
        }
      }
      
      if (!deepEqual(beforePermissions, settings.permissions.allow)) {
        writeJsonConfig(settingsPath, settings);
      }
      
      return { action: mcpAction, success: true };
    }
    
    return { action: 'unchanged', success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { action: 'created', success: false, error: msg };
  }
}

/**
 * 配置 Cursor
 */
function configureCursor(): { action: 'created' | 'updated' | 'unchanged'; success: boolean; error?: string } {
  try {
    const homeDir = os.homedir();
    const mcpPath = path.join(homeDir, '.cursor', 'mcp.json');
    
    const config = readJsonConfig(mcpPath);
    const existing = config.mcpServers?.codegraph;
    
    if (!deepEqual(existing, MCP_SERVER_CONFIG)) {
      if (!config.mcpServers) config.mcpServers = {};
      config.mcpServers.codegraph = MCP_SERVER_CONFIG;
      writeJsonConfig(mcpPath, config);
      
      return { action: existing ? 'updated' : 'created', success: true };
    }
    
    return { action: 'unchanged', success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { action: 'created', success: false, error: msg };
  }
}

/**
 * 配置 Codex CLI（TOML 格式）
 */
function configureCodex(): { action: 'created' | 'updated' | 'unchanged'; success: boolean; error?: string } {
  try {
    const homeDir = os.homedir();
    const configDir = path.join(homeDir, '.codex');
    const tomlPath = path.join(configDir, 'config.toml');
    const tomlHeader = 'mcp_servers.codegraph';
    
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    
    const existing = fs.existsSync(tomlPath) ? fs.readFileSync(tomlPath, 'utf-8') : '';
    
    const tableBlock = buildTomlTable(tomlHeader, {
      command: MCP_SERVER_CONFIG.command,
      args: MCP_SERVER_CONFIG.args,
    });
    
    const { content: newContent, action } = upsertTomlTable(existing, tomlHeader, tableBlock);
    
    if (action !== 'unchanged') {
      atomicWriteFileSync(tomlPath, newContent);
    }
    
    return { action, success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { action: 'created', success: false, error: msg };
  }
}

/**
 * 配置 opencode（JSONC 格式）
 */
function configureOpencode(): { action: 'created' | 'updated' | 'unchanged'; success: boolean; error?: string } {
  try {
    const homeDir = os.homedir();
    const configDir = path.join(homeDir, '.config', 'opencode');
    const jsoncPath = path.join(configDir, 'opencode.jsonc');
    const jsonPath = path.join(configDir, 'opencode.json');
    
    // 优先使用 .jsonc，其次 .json
    const configPath = fs.existsSync(jsoncPath) ? jsoncPath : 
                       fs.existsSync(jsonPath) ? jsonPath : jsoncPath;
    
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    
    const config = readJsonConfig(configPath);
    const existing = config.mcp?.codegraph;
    
    if (!deepEqual(existing, OPENCODE_MCP_CONFIG)) {
      if (!config.mcp) config.mcp = {};
      config.mcp.codegraph = OPENCODE_MCP_CONFIG;
      
      // 添加 $schema（如果不存在）
      if (!config.$schema) {
        config.$schema = 'https://opencode.ai/config.json';
      }
      
      writeJsonConfig(configPath, config);
      
      return { action: existing ? 'updated' : 'created', success: true };
    }
    
    return { action: 'unchanged', success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { action: 'created', success: false, error: msg };
  }
}

/**
 * 配置 Hermes Agent（YAML 格式）
 */
function configureHermes(): { action: 'created' | 'updated' | 'unchanged'; success: boolean; error?: string } {
  try {
    const homeDir = os.homedir();
    const hermesHome = process.env.HERMES_HOME || path.join(homeDir, '.hermes');
    const configPath = path.join(hermesHome, 'config.yaml');
    
    if (!fs.existsSync(hermesHome)) {
      fs.mkdirSync(hermesHome, { recursive: true });
    }
    
    const existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf-8') : '';
    const mcpBlock = buildYamlMcpBlock().join('\n');
    
    // 检查是否已配置
    if (existing.includes('mcp_servers:') && existing.includes('codegraph:')) {
      // 检查内容是否相同
      const lines = existing.split('\n');
      let inMcpServers = false;
      let inCodegraph = false;
      const existingBlock: string[] = [];
      
      for (const line of lines) {
        if (line.trim() === 'mcp_servers:') {
          inMcpServers = true;
          continue;
        }
        if (inMcpServers && line.trim() === 'codegraph:') {
          inCodegraph = true;
          continue;
        }
        if (inCodegraph) {
          if (line.trim() && !line.startsWith(' ') && !line.startsWith('\t')) {
            break;
          }
          existingBlock.push(line);
        }
      }
      
      // 如果已存在相同配置，返回 unchanged
      if (existingBlock.some(l => l.includes('command: codegraph'))) {
        return { action: 'unchanged', success: true };
      }
    }
    
    // 追加 MCP 配置
    const newContent = existing.trimEnd() + '\n\n' + mcpBlock + '\n';
    atomicWriteFileSync(configPath, newContent);
    
    return { action: 'created', success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { action: 'created', success: false, error: msg };
  }
}

/**
 * 配置 Gemini CLI（JSON 格式）
 */
function configureGemini(): { action: 'created' | 'updated' | 'unchanged'; success: boolean; error?: string } {
  try {
    const homeDir = os.homedir();
    const configDir = path.join(homeDir, '.gemini');
    const settingsPath = path.join(configDir, 'settings.json');
    
    const config = readJsonConfig(settingsPath);
    const existing = config.mcpServers?.codegraph;
    
    if (!deepEqual(existing, MCP_SERVER_CONFIG)) {
      if (!config.mcpServers) config.mcpServers = {};
      config.mcpServers.codegraph = MCP_SERVER_CONFIG;
      writeJsonConfig(settingsPath, config);
      
      return { action: existing ? 'updated' : 'created', success: true };
    }
    
    return { action: 'unchanged', success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { action: 'created', success: false, error: msg };
  }
}

/**
 * 配置 Antigravity IDE（JSON 格式）
 */
function configureAntigravity(): { action: 'created' | 'updated' | 'unchanged'; success: boolean; error?: string } {
  try {
    const homeDir = os.homedir();
    const configDir = path.join(homeDir, '.gemini', 'antigravity');
    const mcpPath = path.join(configDir, 'mcp_config.json');
    
    const config = readJsonConfig(mcpPath);
    const existing = config.mcpServers?.codegraph;
    
    if (!deepEqual(existing, MCP_SERVER_CONFIG)) {
      if (!config.mcpServers) config.mcpServers = {};
      config.mcpServers.codegraph = MCP_SERVER_CONFIG;
      writeJsonConfig(mcpPath, config);
      
      return { action: existing ? 'updated' : 'created', success: true };
    }
    
    return { action: 'unchanged', success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { action: 'created', success: false, error: msg };
  }
}

/**
 * 配置 Kiro（JSON 格式）
 */
function configureKiro(): { action: 'created' | 'updated' | 'unchanged'; success: boolean; error?: string } {
  try {
    const homeDir = os.homedir();
    const configDir = path.join(homeDir, '.kiro');
    const configPath = path.join(configDir, 'config.json');
    
    const config = readJsonConfig(configPath);
    const existing = config.mcpServers?.codegraph;
    
    if (!deepEqual(existing, MCP_SERVER_CONFIG)) {
      if (!config.mcpServers) config.mcpServers = {};
      config.mcpServers.codegraph = MCP_SERVER_CONFIG;
      writeJsonConfig(configPath, config);
      
      return { action: existing ? 'updated' : 'created', success: true };
    }
    
    return { action: 'unchanged', success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { action: 'created', success: false, error: msg };
  }
}

/**
 * 配置 Qoder（JSON 格式）
 */
function configureQoder(): { action: 'created' | 'updated' | 'unchanged'; success: boolean; error?: string } {
  try {
    const homeDir = os.homedir();
    const mcpPath = path.join(homeDir, '.config', 'QoderCN', 'SharedClientCache', 'mcp.json');
    
    const config = readJsonConfig(mcpPath);
    const existing = config.mcpServers?.codegraph;
    
    if (!deepEqual(existing, MCP_SERVER_CONFIG)) {
      if (!config.mcpServers) config.mcpServers = {};
      config.mcpServers.codegraph = MCP_SERVER_CONFIG;
      writeJsonConfig(mcpPath, config);
      
      return { action: existing ? 'updated' : 'created', success: true };
    }
    
    return { action: 'unchanged', success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { action: 'created', success: false, error: msg };
  }
}

/**
 * 配置 Kilo Code（JSONC 格式）
 * Kilo Code 使用 `mcp` 键而不是 `mcpServers`
 * command 是数组格式
 * 配置路径: ~/.config/kilo/kilo.jsonc (全局)
 * 或项目级: kilo.jsonc / .kilo/kilo.jsonc
 */
function configureKiloCode(): { action: 'created' | 'updated' | 'unchanged'; success: boolean; error?: string } {
  try {
    const homeDir = os.homedir();
    const configPath = path.join(homeDir, '.config', 'kilo', 'kilo.jsonc');
    
    const config = readJsonConfig(configPath);
    
    // Kilo Code 使用 `mcp` 键，command 是数组格式
    const kiloMcpConfig = {
      type: 'local',
      command: ['codegraph', 'serve', '--mcp'],
      enabled: true
    };
    
    const existing = config.mcp?.codegraph;
    
    if (!deepEqual(existing, kiloMcpConfig)) {
      if (!config.mcp) config.mcp = {};
      config.mcp.codegraph = kiloMcpConfig;
      
      writeJsonConfig(configPath, config);
      
      return { action: existing ? 'updated' : 'created', success: true };
    }
    
    return { action: 'unchanged', success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { action: 'created', success: false, error: msg };
  }
}

/**
 * 检测代理是否已安装
 */
function isClaudeCodeInstalled(): boolean {
  const homeDir = os.homedir();
  return fs.existsSync(path.join(homeDir, '.claude')) || 
         fs.existsSync(path.join(homeDir, '.claude.json'));
}

function isCursorInstalled(): boolean {
  const homeDir = os.homedir();
  return fs.existsSync(path.join(homeDir, '.cursor'));
}

function isCodexInstalled(): boolean {
  const homeDir = os.homedir();
  return fs.existsSync(path.join(homeDir, '.codex'));
}

function isOpencodeInstalled(): boolean {
  const homeDir = os.homedir();
  const configDir = process.platform === 'win32'
    ? path.join(process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming'), 'opencode')
    : path.join(homeDir, '.config', 'opencode');
  return fs.existsSync(configDir);
}

function isHermesInstalled(): boolean {
  const homeDir = os.homedir();
  const hermesHome = process.env.HERMES_HOME || path.join(homeDir, '.hermes');
  return fs.existsSync(hermesHome);
}

function isGeminiInstalled(): boolean {
  const homeDir = os.homedir();
  return fs.existsSync(path.join(homeDir, '.gemini'));
}

function isAntigravityInstalled(): boolean {
  const homeDir = os.homedir();
  return fs.existsSync(path.join(homeDir, '.gemini', 'antigravity'));
}

function isKiroInstalled(): boolean {
  const homeDir = os.homedir();
  return fs.existsSync(path.join(homeDir, '.kiro'));
}

function isQoderInstalled(): boolean {
  const homeDir = os.homedir();
  return fs.existsSync(path.join(homeDir, '.config', 'QoderCN'));
}

function isKiloCodeInstalled(): boolean {
  const homeDir = os.homedir();
  // Kilo Code 配置路径: ~/.config/kilo/
  return fs.existsSync(path.join(homeDir, '.config', 'kilo'));
}

/**
 * 获取所有支持的代理配置
 */
function getAgentConfigs(): AgentConfig[] {
  return [
    {
      name: 'Claude Code',
      isInstalled: isClaudeCodeInstalled,
      configure: configureClaudeCode,
    },
    {
      name: 'Cursor',
      isInstalled: isCursorInstalled,
      configure: configureCursor,
    },
    {
      name: 'Codex CLI',
      isInstalled: isCodexInstalled,
      configure: configureCodex,
    },
    {
      name: 'opencode',
      isInstalled: isOpencodeInstalled,
      configure: configureOpencode,
    },
    {
      name: 'Hermes Agent',
      isInstalled: isHermesInstalled,
      configure: configureHermes,
    },
    {
      name: 'Gemini CLI',
      isInstalled: isGeminiInstalled,
      configure: configureGemini,
    },
    {
      name: 'Antigravity IDE',
      isInstalled: isAntigravityInstalled,
      configure: configureAntigravity,
    },
    {
      name: 'Kiro',
      isInstalled: isKiroInstalled,
      configure: configureKiro,
    },
    {
      name: 'Qoder',
      isInstalled: isQoderInstalled,
      configure: configureQoder,
    },
    {
      name: 'Kilo Code',
      isInstalled: isKiloCodeInstalled,
      configure: configureKiloCode,
    },
  ];
}

/**
 * 配置所有支持的 AI 代理
 *
 * 在扩展激活时作为后台任务调用。
 * 幂等 — 如果所有代理都已配置，立即返回。
 *
 * @param _codegraphPath - 保留参数（兼容性），不再使用
 * @param _env - 保留参数（兼容性），不再使用
 * @param silent - 是否静默（不显示通知）
 * @returns AgentConfigResult 包含成功状态和摘要
 */
export async function configureAgents(
  _codegraphPath: string,
  _env: NodeJS.ProcessEnv,
  silent: boolean = false
): Promise<AgentConfigResult> {
  if (!silent) {
    vscode.window.showInformationMessage(t('agentConfig.configuring'));
  }

  const agents = getAgentConfigs();
  const results: Array<{ name: string; action: string; success: boolean; error?: string }> = [];
  let allUnchanged = true;

  // 配置每个代理
  for (const agent of agents) {
    // 只配置已安装的代理
    if (!agent.isInstalled()) {
      console.log(`[CodeGraph] ${agent.name}: 未安装，跳过`);
      continue;
    }

    const result = agent.configure();
    results.push({
      name: agent.name,
      action: result.action,
      success: result.success,
      error: result.error,
    });
    
    if (result.action !== 'unchanged') {
      allUnchanged = false;
    }
    
    // 日志输出
    if (result.success) {
      console.log(`[CodeGraph] ${agent.name}: ${result.action}`);
    } else {
      console.error(`[CodeGraph] ${agent.name}: 失败 - ${result.error}`);
    }
  }

  // 如果没有检测到任何代理
  if (results.length === 0) {
    const message = t('agentConfig.noAgents');
    if (!silent) {
      vscode.window.showInformationMessage(message);
    }
    return {
      success: true,
      alreadyConfigured: true,
      message,
    };
  }

  // 生成摘要消息
  const successCount = results.filter(r => r.success).length;
  const totalCount = results.length;
  
  if (allUnchanged && successCount === totalCount) {
    const message = t('agentConfig.alreadyConfigured');
    if (!silent) {
      vscode.window.showInformationMessage(message);
    }
    return {
      success: true,
      alreadyConfigured: true,
      message,
    };
  }

  const failedAgents = results.filter(r => !r.success);
  if (failedAgents.length > 0) {
    const failedNames = failedAgents.map(r => r.name).join(', ');
    const message = t('agentConfig.partial') + ` (${failedNames})`;
    if (!silent) {
      vscode.window.showWarningMessage(message);
    }
    return {
      success: false,
      alreadyConfigured: false,
      message,
    };
  }

  const configuredAgents = results.filter(r => r.action !== 'unchanged').map(r => r.name).join(', ');
  const message = t('agentConfig.success') + ` (${configuredAgents})`;
  if (!silent) {
    vscode.window.showInformationMessage(message);
  }
  return {
    success: true,
    alreadyConfigured: false,
    message,
  };
}
