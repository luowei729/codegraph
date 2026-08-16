/**
 * Agent Auto-Configuration Module
 *
 * 直接写入 MCP 配置到各 AI 代理的配置文件，不依赖 CLI 命令。
 *
 * 支持的代理及其配置格式：
 * - VS Code: JSON 格式 (用户级: 平台相关 Code/User/mcp.json；Insiders: Code - Insiders)
 * - Claude Code: JSON 格式 (~/.claude.json + ~/.claude/settings.json 权限)
 * - Cursor: JSON 格式 (~/.cursor/mcp.json)
 * - Codex CLI: TOML 格式 (~/.codex/config.toml)
 * - opencode: JSONC 格式 (~/.config/opencode/opencode.jsonc)
 * - Hermes Agent: YAML 格式 (~/.hermes/config.yaml)
 * - Gemini CLI: JSON 格式 (~/.gemini/settings.json)
 * - Antigravity IDE: JSON 格式 (~/.gemini/antigravity/mcp_config.json)
 * - Kiro: JSON 格式 (~/.kiro/config.json)
 * - Qoder: JSON 格式 (~/.config/QoderCN/SharedClientCache/mcp.json)
 * - Trae IDE: JSON 格式 (SOLO: ~/.trae-server/data/Machine/mcp.json；桌面版: 平台相关 Trae/User/mcp.json)
 * - Trae CN IDE: JSON 格式 (SOLO: ~/.trae-cn-server/data/Machine/mcp.json；桌面版: 平台相关 Trae CN/User/mcp.json)
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
  /** 配置函数：写入 MCP 配置。codegraphPath 为 codegraph CLI 的绝对路径（可能为空） */
  configure: (codegraphPath?: string) => { action: 'created' | 'updated' | 'unchanged'; success: boolean; error?: string };
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
 *
 * Fix#14: 解析失败返回 null 而非空对象。旧逻辑返回 {} 会让调用方误以为
 * "无配置"，随后 writeJsonConfig 整体覆盖写入——文件损坏（半写状态、
 * 手误编辑、非法编码）时会把用户配置永久替换成"只有 codegraph"，数据
 * 丢失。调用方收到 null 必须放弃写入。文件不存在或空白则返回 {}（新建
 * 场景安全）。
 */
function readJsonConfig(filePath: string): Record<string, any> | null {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, 'utf-8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`[CodeGraph] 无法解析配置文件 ${filePath}:`, err);
    return null;
  }
}

/**
 * 读取失败时的统一错误返回（数据保护：绝不覆盖损坏/不可解析的配置文件）。
 * 各 configure* 函数在 readJsonConfig/readJsoncConfig 返回 null 时使用。
 */
function configReadError(filePath: string): { action: 'created' | 'updated' | 'unchanged'; success: boolean; error?: string } {
  return {
    action: 'unchanged',
    success: false,
    error: `无法解析 ${filePath}（JSON/JSONC 语法错误）。已跳过写入以保护现有配置。`,
  };
}

/**
 * 剥离 JSONC（含注释/尾逗号的 JSON）中的注释与尾逗号，得到严格 JSON。
 *
 * 为什么需要？opencode 等代理的配置文件是 JSONC 格式（允许 // 行注释、
 * /* 块注释 *​/ 和尾逗号）。JSON.parse 遇到这些会抛错，导致旧逻辑读到空对象后
 * 用 JSON.stringify 整体覆盖写入，清空用户全部配置（数据丢失 bug）。
 *
 * 实现采用单遍状态机：只在字符串外处理注释/尾逗号，字符串内的字符原样保留，
 * 不会误伤 "a//b"、"a,}" 之类的字符串字面量。零依赖（.vsix 打包不含
 * node_modules，不能运行时 require jsonc-parser）。
 */
function stripJsonc(jsonc: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  while (i < jsonc.length) {
    const ch = jsonc[i];
    if (inString) {
      // 字符串内：原样输出，处理转义符，直到闭合引号
      out += ch;
      if (ch === '\\' && i + 1 < jsonc.length) {
        out += jsonc[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === '/' && jsonc[i + 1] === '/') {
      // 行注释：跳过到行尾（保留换行，维持行号对齐）
      while (i < jsonc.length && jsonc[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && jsonc[i + 1] === '*') {
      // 块注释：跳过到 */ 之后
      i += 2;
      while (i < jsonc.length && !(jsonc[i] === '*' && jsonc[i + 1] === '/')) i++;
      i = Math.min(i + 2, jsonc.length);
      continue;
    }
    if (ch === ',') {
      // 尾逗号检测：跳过空白后遇到 } 或 ] 则丢弃该逗号，否则原样输出
      let j = i + 1;
      while (j < jsonc.length && /\s/.test(jsonc[j])) j++;
      if (jsonc[j] === '}' || jsonc[j] === ']') {
        i++;
        continue;
      }
      out += ch;
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * 读取 JSONC 配置文件（opencode 等允许注释/尾逗号的 JSON 变体）。
 *
 * 解析策略：优先尝试严格 JSON.parse（无注释时最直接）；失败时剥离
 * 注释/尾逗号后再解析。两者都失败返回 null —— 调用方收到 null 必须
 * 放弃写入，绝不覆盖原文件，避免清空用户配置。
 */
function readJsoncConfig(filePath: string): Record<string, any> | null {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch {
    try {
      return JSON.parse(stripJsonc(raw));
    } catch (err) {
      console.warn(`[CodeGraph] 无法解析 JSONC 配置文件 ${filePath}:`, err);
      return null;
    }
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
 * 配置 Claude Code
 *
 * Fix#10: 权限列表（permissions.allow）补齐与 MCP 服务器配置解耦——
 * 旧逻辑只在 mcpServers 变更时补权限，导致"已配置 MCP 但缺权限"的存量用户
 * 永远补不上。现在两步各自独立幂等：MCP 配置有差异则更新，权限缺哪条补哪条，
 * action 取两者中更重的状态。
 */
function configureClaudeCode(): { action: 'created' | 'updated' | 'unchanged'; success: boolean; error?: string } {
  try {
    const homeDir = os.homedir();
    const mcpPath = path.join(homeDir, '.claude.json');
    const settingsPath = path.join(homeDir, '.claude', 'settings.json');
    
    // 1. 写入 MCP 服务器配置（幂等：无差异则不动）
    // Fix#14: 解析失败（文件损坏）返回 null 时放弃写入，保护用户配置
    const mcpConfig = readJsonConfig(mcpPath);
    if (mcpConfig === null) return configReadError(mcpPath);
    const existingMcp = mcpConfig.mcpServers?.codegraph;
    const mcpChanged = !deepEqual(existingMcp, MCP_SERVER_CONFIG);

    if (mcpChanged) {
      if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {};
      mcpConfig.mcpServers.codegraph = MCP_SERVER_CONFIG;
      writeJsonConfig(mcpPath, mcpConfig);
    }

    // 2. 无条件补齐权限列表（幂等：缺哪条补哪条，全在则跳过）
    // Fix#14: settings.json 损坏时跳过权限写入（MCP 配置已写入，可接受部分成功）
    const settings = readJsonConfig(settingsPath);
    if (settings === null) return configReadError(settingsPath);
    if (!settings.permissions) settings.permissions = {};
    if (!Array.isArray(settings.permissions.allow)) settings.permissions.allow = [];

    const beforePermissions = [...settings.permissions.allow];
    for (const perm of CODEGRAPH_PERMISSIONS) {
      if (!settings.permissions.allow.includes(perm)) {
        settings.permissions.allow.push(perm);
      }
    }

    const permsChanged = !deepEqual(beforePermissions, settings.permissions.allow);
    if (permsChanged) {
      writeJsonConfig(settingsPath, settings);
    }

    // 3. action 综合两步结果：优先 MCP 的 created/updated，否则看权限是否变更
    let action: 'created' | 'updated' | 'unchanged' = 'unchanged';
    if (mcpChanged) action = existingMcp ? 'updated' : 'created';
    else if (permsChanged) action = 'updated';

    return { action, success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { action: 'unchanged', success: false, error: msg };
  }
}

/**
 * 配置 Cursor
 */
function configureCursor(): { action: 'created' | 'updated' | 'unchanged'; success: boolean; error?: string } {
  try {
    const homeDir = os.homedir();
    const mcpPath = path.join(homeDir, '.cursor', 'mcp.json');
    
    // Fix#14: 解析失败（文件损坏）时放弃写入
    const config = readJsonConfig(mcpPath);
    if (config === null) return configReadError(mcpPath);
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
    return { action: 'unchanged', success: false, error: msg };
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
    return { action: 'unchanged', success: false, error: msg };
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

    // 使用 JSONC 专用读取：opencode 配置允许注释/尾逗号，严格 JSON.parse 会失败。
    // 解析失败返回 null 时必须放弃写入（否则整体覆盖会清空用户配置）。
    const config = readJsoncConfig(configPath);
    if (config === null) {
      return {
        action: 'unchanged',
        success: false,
        error: `无法解析 ${configPath}（JSONC 语法错误）。已跳过写入以保护现有配置。`,
      };
    }
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
    return { action: 'unchanged', success: false, error: msg };
  }
}

/**
 * 配置 Hermes Agent（YAML 格式）
 *
 * Fix#12: command 优先使用 codegraphPath（绝对路径）。与 VS Code 同理——
 * 扩展宿主的 PATH 可能不含 ~/.local/bin，裸命令 `codegraph` 会让 Hermes
 * spawn ENOENT。绝对路径含特殊字符（空格/反斜杠等）时用 JSON.stringify
 * 生成带引号的 YAML 双引号字符串（YAML 双引号转义规则与 JSON 一致）。
 */
function configureHermes(codegraphPath?: string): { action: 'created' | 'updated' | 'unchanged'; success: boolean; error?: string } {
  try {
    const homeDir = os.homedir();
    const hermesHome = process.env.HERMES_HOME || path.join(homeDir, '.hermes');
    const configPath = path.join(hermesHome, 'config.yaml');
    
    if (!fs.existsSync(hermesHome)) {
      fs.mkdirSync(hermesHome, { recursive: true });
    }
    
    const existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf-8') : '';

    // command 值：绝对路径时用 JSON.stringify 生成 YAML 双引号字符串（防空格/反斜杠问题）；
    // 未提供路径时保持裸命令 codegraph（与旧行为一致，保证幂等）。
    const commandValue = codegraphPath ? JSON.stringify(codegraphPath) : 'codegraph';

    // codegraph 子块（2 空格缩进，挂在 mcp_servers: 下）。
    // Fix#7: 不再无条件追加完整 mcp_servers 块，改为真正的 upsert：
    // 已有 codegraph 块则就地替换，避免非标准 command（如绝对路径）时产生重复 mcp_servers 块。
    const codegraphLines = [
      '  codegraph:',
      `    command: ${commandValue}`,
      '    args:',
      '      - serve',
      '      - --mcp',
      '    timeout: 120',
      '    connect_timeout: 60',
      '    enabled: true',
    ];
    const desiredBlock = codegraphLines.join('\n');

    const lines = existing.split('\n');
    let mcpServersIdx = -1; // 第一个顶层 mcp_servers: 行号
    let codegraphStart = -1; // 已有 codegraph: 块起始行号
    let codegraphEnd = -1; // 已有 codegraph: 块结束行号（不含）

    // 1) 定位第一个顶层 mcp_servers: 键，以及其下的 codegraph: 子块
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (mcpServersIdx === -1 && trimmed === 'mcp_servers:' && !lines[i].startsWith(' ')) {
        mcpServersIdx = i;
        continue;
      }
      // 在 mcp_servers: 之后寻找 2 空格缩进的 codegraph: 子键
      if (mcpServersIdx !== -1 && codegraphStart === -1 &&
          trimmed === 'codegraph:' && lines[i].startsWith('  ') && !lines[i].startsWith('   ')) {
        codegraphStart = i;
        codegraphEnd = i + 1;
        // 收集该块所有 4 空格缩进的子行。空行或同级/更浅缩进行均视为块结束--
        // 不跳过空行：否则会把块尾空行计入比较，导致内容相同却误判为 updated。
        while (codegraphEnd < lines.length) {
          const ln = lines[codegraphEnd];
          if (ln.trim() === '' || !ln.startsWith('    ')) break;
          codegraphEnd++;
        }
        break;
      }
    }

    // 2) 已有 codegraph 块：比较内容，相同则 unchanged，不同则就地替换
    if (codegraphStart !== -1) {
      const existingBlock = lines.slice(codegraphStart, codegraphEnd).join('\n');
      if (existingBlock === desiredBlock) {
        return { action: 'unchanged', success: true };
      }
      const newLines = [
        ...lines.slice(0, codegraphStart),
        ...codegraphLines,
        ...lines.slice(codegraphEnd),
      ];
      atomicWriteFileSync(configPath, newLines.join('\n'));
      return { action: 'updated', success: true };
    }

    // 3) 有 mcp_servers: 但无 codegraph：在其后插入 codegraph 子块
    if (mcpServersIdx !== -1) {
      const newLines = [
        ...lines.slice(0, mcpServersIdx + 1),
        ...codegraphLines,
        ...lines.slice(mcpServersIdx + 1),
      ];
      atomicWriteFileSync(configPath, newLines.join('\n'));
      return { action: 'created', success: true };
    }

    // 4) 无 mcp_servers: 追加完整块
    const fullBlock = ['mcp_servers:', ...codegraphLines].join('\n');
    const newContent = existing.trimEnd() + '\n\n' + fullBlock + '\n';
    atomicWriteFileSync(configPath, newContent);

    return { action: 'created', success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { action: 'unchanged', success: false, error: msg };
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
    
    // Fix#14: 解析失败（文件损坏）时放弃写入
    const config = readJsonConfig(settingsPath);
    if (config === null) return configReadError(settingsPath);
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
    return { action: 'unchanged', success: false, error: msg };
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
    
    // Fix#14: 解析失败（文件损坏）时放弃写入
    const config = readJsonConfig(mcpPath);
    if (config === null) return configReadError(mcpPath);
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
    return { action: 'unchanged', success: false, error: msg };
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
    
    // Fix#14: 解析失败（文件损坏）时放弃写入
    const config = readJsonConfig(configPath);
    if (config === null) return configReadError(configPath);
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
    return { action: 'unchanged', success: false, error: msg };
  }
}

/**
 * 配置 Qoder（JSON 格式）
 */
function configureQoder(): { action: 'created' | 'updated' | 'unchanged'; success: boolean; error?: string } {
  try {
    const homeDir = os.homedir();
    const mcpPath = path.join(homeDir, '.config', 'QoderCN', 'SharedClientCache', 'mcp.json');
    
    // Fix#14: 解析失败（文件损坏）时放弃写入
    const config = readJsonConfig(mcpPath);
    if (config === null) return configReadError(mcpPath);
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
    return { action: 'unchanged', success: false, error: msg };
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
    
    // Fix#13: kilo.jsonc 是 JSONC 格式（允许注释/尾逗号），必须用 readJsoncConfig。
    // 旧逻辑用 readJsonConfig（JSON.parse）读失败返回 {}，writeJsonConfig 整体
    // 覆盖写入会清空用户 Kilo Code 全部配置（与 opencode 的数据丢失 bug 同模式）。
    const config = readJsoncConfig(configPath);
    if (config === null) return configReadError(configPath);
    
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
    return { action: 'unchanged', success: false, error: msg };
  }
}

/**
 * 解析 Trae IDE 全局 MCP 配置文件路径
 *
 * Trae IDE 有两种发行形态，配置目录约定不同（实测本机为 SOLO/服务端形态）：
 * 1. SOLO/服务端形态：数据目录在 ~/.trae-server，MCP 配置位于
 *    data/Machine/mcp.json（Machine 级配置，对整台机器生效）。
 * 2. 标准桌面版：跟随 VS Code 的 userData 目录约定：
 *    - Windows: %APPDATA%\Trae\User\mcp.json
 *    - macOS:   ~/Library/Application Support/Trae/User/mcp.json
 *    - Linux:   ~/.config/Trae/User/mcp.json
 *
 * 解析顺序：优先返回已存在的 mcp.json；其次返回父目录已存在的候选
 * （确保写入用户实际安装的形态）；都不存在时返回 SOLO 形态路径
 * （writeJsonConfig 会递归创建目录）。
 */
function getTraeConfigPath(): string {
  const homeDir = os.homedir();
  // 候选路径：SOLO/服务端形态优先（实际运行的形态），其次标准桌面版
  const candidates: string[] = [
    path.join(homeDir, '.trae-server', 'data', 'Machine', 'mcp.json'),
  ];
  if (process.platform === 'win32') {
    candidates.push(path.join(process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming'), 'Trae', 'User', 'mcp.json'));
  } else if (process.platform === 'darwin') {
    candidates.push(path.join(homeDir, 'Library', 'Application Support', 'Trae', 'User', 'mcp.json'));
  } else {
    candidates.push(path.join(homeDir, '.config', 'Trae', 'User', 'mcp.json'));
  }

  // 1) 优先使用已存在的 mcp.json，避免写错位置
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  // 2) 其次使用父目录已存在的候选，确保写入用户实际安装的形态
  for (const c of candidates) {
    if (fs.existsSync(path.dirname(c))) return c;
  }
  // 3) 兜底：返回 SOLO 形态路径（writeJsonConfig 会递归创建目录）
  return candidates[0];
}

/**
 * 配置 Trae IDE（JSON 格式）
 *
 * Trae IDE 是基于 VS Code 的 AI IDE，通过 mcp.json 的 mcpServers 键注册 MCP Server，
 * 与 Cursor/Claude 的结构一致。配置路径由 getTraeConfigPath() 统一解析。
 * 复用 MCP_SERVER_CONFIG，配合 deepEqual 保证幂等。
 */
function configureTrae(): { action: 'created' | 'updated' | 'unchanged'; success: boolean; error?: string } {
  try {
    const mcpPath = getTraeConfigPath();
    // Fix#14: 解析失败（文件损坏）时放弃写入
    const config = readJsonConfig(mcpPath);
    if (config === null) return configReadError(mcpPath);
    const existing = config.mcpServers?.codegraph;

    // 与其他 JSON 代理共用 MCP_SERVER_CONFIG，deepEqual 保证重复运行不产生重复配置
    if (!deepEqual(existing, MCP_SERVER_CONFIG)) {
      if (!config.mcpServers) config.mcpServers = {};
      config.mcpServers.codegraph = MCP_SERVER_CONFIG;
      writeJsonConfig(mcpPath, config);

      return { action: existing ? 'updated' : 'created', success: true };
    }

    return { action: 'unchanged', success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { action: 'unchanged', success: false, error: msg };
  }
}

/**
 * 解析 Trae CN IDE 全局 MCP 配置文件路径
 *
 * Trae CN IDE 目录约定与 Trae IDE 对称：
 * 1. SOLO/服务端形态：数据目录在 ~/.trae-cn-server，MCP 配置位于
 *    data/Machine/mcp.json（Machine 级配置，对整台机器生效）。
 * 2. 标准桌面版：跟随 VS Code 的 userData 目录约定（目录名为 "Trae CN"）：
 *    - Windows: %APPDATA%\Trae CN\User\mcp.json
 *    - macOS:   ~/Library/Application Support/Trae CN/User/mcp.json
 *    - Linux:   ~/.config/Trae CN\User/mcp.json
 *
 * 解析顺序：优先返回已存在的 mcp.json；其次返回父目录已存在的候选
 * （确保写入用户实际安装的形态）；都不存在时返回 SOLO 形态路径
 * （writeJsonConfig 会递归创建目录）。
 */
function getTraeCnConfigPath(): string {
  const homeDir = os.homedir();
  // 候选路径：SOLO/服务端形态优先（与 Trae IDE 对称），其次标准桌面版
  const candidates: string[] = [
    path.join(homeDir, '.trae-cn-server', 'data', 'Machine', 'mcp.json'),
  ];
  if (process.platform === 'win32') {
    candidates.push(path.join(process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming'), 'Trae CN', 'User', 'mcp.json'));
  } else if (process.platform === 'darwin') {
    candidates.push(path.join(homeDir, 'Library', 'Application Support', 'Trae CN', 'User', 'mcp.json'));
  } else {
    candidates.push(path.join(homeDir, '.config', 'Trae CN', 'User', 'mcp.json'));
  }

  // 1) 优先使用已存在的 mcp.json，避免写错位置
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  // 2) 其次使用父目录已存在的候选，确保写入用户实际安装的形态
  for (const c of candidates) {
    if (fs.existsSync(path.dirname(c))) return c;
  }
  // 3) 兜底：返回 SOLO 形态路径（writeJsonConfig 会递归创建目录）
  return candidates[0];
}

/**
 * 配置 Trae CN IDE（JSON 格式）
 *
 * Trae CN IDE 与 Trae IDE 同为基于 VS Code 的 AI IDE，MCP 配置结构一致，
 * 均通过 mcp.json 的 mcpServers 键注册 MCP Server。配置路径由
 * getTraeCnConfigPath() 统一解析。复用 MCP_SERVER_CONFIG，配合 deepEqual 保证幂等。
 */
function configureTraeCn(): { action: 'created' | 'updated' | 'unchanged'; success: boolean; error?: string } {
  try {
    const mcpPath = getTraeCnConfigPath();
    // Fix#14: 解析失败（文件损坏）时放弃写入
    const config = readJsonConfig(mcpPath);
    if (config === null) return configReadError(mcpPath);
    const existing = config.mcpServers?.codegraph;

    // 与其他 JSON 代理共用 MCP_SERVER_CONFIG，deepEqual 保证重复运行不产生重复配置
    if (!deepEqual(existing, MCP_SERVER_CONFIG)) {
      if (!config.mcpServers) config.mcpServers = {};
      config.mcpServers.codegraph = MCP_SERVER_CONFIG;
      writeJsonConfig(mcpPath, config);

      return { action: existing ? 'updated' : 'created', success: true };
    }

    return { action: 'unchanged', success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { action: 'unchanged', success: false, error: msg };
  }
}

/**
 * 解析 VS Code 用户级 MCP 配置文件路径
 *
 * VS Code 1.99+ 原生支持 MCP，用户级（User scope）配置位于
 * {userData}/mcp.json，随 VS Code 的 userData 目录约定（与 Trae 桌面版一致）：
 * - Windows: %APPDATA%\Code\User\mcp.json（Insiders: Code - Insiders）
 * - macOS:   ~/Library/Application Support/Code/User/mcp.json
 * - Linux:   ~/.config/Code/User/mcp.json
 *
 * 支持两种运行形态：
 * 1. 远程（Remote-SSH / Dev Containers 等）：扩展跑在 vscode-server 中，
 *    userData 位于 ~/.vscode-server/data/User，用户级 mcp.json 即
 *    `MCP: Open Remote User Configuration` 打开的文件。codegraph CLI 在
 *    服务器上，MCP 服务器必须跑在远程，因此远程形态必须优先。
 * 2. 本机桌面版：稳定版 Code / Insiders "Code - Insiders"（按平台展开）。
 *
 * 解析顺序：优先返回已存在的 mcp.json；其次返回父目录已存在的候选
 * （确保写入用户实际使用的形态）；都不存在时返回远程路径（若 vscode-server
 * 存在）否则稳定版路径（writeJsonConfig 会递归创建目录）。
 */
function getVSCodeConfigPath(): string {
  const homeDir = os.homedir();
  const vscodeServerUserData = path.join(homeDir, '.vscode-server', 'data', 'User');

  // 0) 远程形态（Remote-SSH / Dev Containers）：vscode-server userData 存在即
  //    视为远程环境。codegraph CLI 与扩展同机，MCP 服务器必须跑在远程，
  //    用户级 mcp.json 即 ~/.vscode-server/data/User/mcp.json
  //    （MCP: Open Remote User Configuration 打开的文件）。无条件优先返回，
  //    避免服务器上残留的桌面版 mcp.json（本机目录约定）劫持解析。
  if (fs.existsSync(vscodeServerUserData)) {
    return path.join(vscodeServerUserData, 'mcp.json');
  }

  // 1) 本机桌面版形态：稳定版优先，Insiders 其次（按平台展开 userData 目录）
  const candidates: string[] = [];
  const appDirs: string[] = ['Code', 'Code - Insiders'];
  for (const app of appDirs) {
    if (process.platform === 'win32') {
      candidates.push(path.join(process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming'), app, 'User', 'mcp.json'));
    } else if (process.platform === 'darwin') {
      candidates.push(path.join(homeDir, 'Library', 'Application Support', app, 'User', 'mcp.json'));
    } else {
      candidates.push(path.join(homeDir, '.config', app, 'User', 'mcp.json'));
    }
  }

  // 1) 优先使用已存在的 mcp.json，避免写错位置
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  // 2) 其次使用父目录已存在的候选（User 目录已存在），确保写入用户实际使用的形态
  for (const c of candidates) {
    if (fs.existsSync(path.dirname(c))) return c;
  }
  // 3) 兜底：返回稳定版路径（writeJsonConfig 会递归创建目录）
  return candidates[0];
}

/**
 * 解析 VS Code Agent Host 用户级 MCP 配置文件路径
 *
 * Agent Host 是 VS Code 新的独立代理运行时（chat.agentHost.enabled），它
 * 不读 .vscode/mcp.json，只读 harness-agnostic 的配置文件：
 * - 用户级: ~/.copilot/mcp-config.json
 * - 工作区: .mcp.json
 *
 * 格式与 mcp.json 一致（顶层 `servers` 键），因此复用 MCP_SERVER_CONFIG。
 * 远程形态下 Agent Host 跑在服务器上，~/.copilot 目录亦位于服务器
 * （本机则是用户电脑）。
 */
function getVSCodeAgentHostConfigPath(): string {
  return path.join(os.homedir(), '.copilot', 'mcp-config.json');
}

/**
 * 配置 VS Code（JSON 格式）
 *
 * VS Code 1.99+ 原生 MCP 配置使用顶层 `servers` 键（区别于 Cursor/Claude 的
 * `mcpServers`），其中每个服务器使用 `type/command/args` 描述，与
 * MCP_SERVER_CONFIG 完全同构，因此直接复用该模板。
 *
 * command 使用 codegraphPath（绝对路径）而非裸 `codegraph`：
 * Remote-SSH / Agent Host 下 VS Code Server 进程的 PATH 不含 ~/.local/bin
 * （shell 配置只在交互/登录 shell 生效），裸命令会导致 spawn ENOENT。
 *
 * 写入两个位置（均用户级、幂等）：
 * 1. 主 mcp.json（getVSCodeConfigPath() 解析，远程 vscode-server userData
 *    或本机桌面版 userData）——供 VS Code 的 MCP 管理（MCP: List Servers /
 *    chat 工具发现）识别，VS Code 会自动转发给 Agent Host。
 * 2. ~/.copilot/mcp-config.json（Agent Host 用户级，目录存在时）——
 *    Agent Host 原生读取，不依赖 VS Code 转发。
 *
 * 配置后需重启 VS Code（或重载窗口）以让 Copilot Chat 发现该 MCP 服务器。
 */
function configureVSCode(codegraphPath?: string): { action: 'created' | 'updated' | 'unchanged'; success: boolean; error?: string } {
  try {
    // 绝对路径优先（修复 VS Code Server PATH 缺 ~/.local/bin 导致的 ENOENT），
    // 未提供时回退到裸命令 `codegraph`
    const serverConfig = codegraphPath
      ? { ...MCP_SERVER_CONFIG, command: codegraphPath }
      : MCP_SERVER_CONFIG;

    // 1) 主 mcp.json：VS Code 原生 MCP 配置
    const mcpPath = getVSCodeConfigPath();
    // Fix#14: 解析失败（文件损坏）时放弃写入
    const config = readJsonConfig(mcpPath);
    if (config === null) return configReadError(mcpPath);
    const existing = config.servers?.codegraph;

    // VS Code 用 `servers` 顶层键；值结构与 serverConfig 一致，deepEqual 保证幂等
    let action: 'created' | 'updated' | 'unchanged' = 'unchanged';
    if (!deepEqual(existing, serverConfig)) {
      if (!config.servers) config.servers = {};
      config.servers.codegraph = serverConfig;
      writeJsonConfig(mcpPath, config);
      action = existing ? 'updated' : 'created';
    }

    // 2) Agent Host 用户级 mcp-config.json（~/.copilot 目录存在时写入；
    //    Agent Host 原生读取，不依赖 VS Code 转发）
    const copilotDir = path.join(os.homedir(), '.copilot');
    if (fs.existsSync(copilotDir)) {
      const ahPath = getVSCodeAgentHostConfigPath();
      const ahConfig = readJsonConfig(ahPath);
      if (ahConfig === null) return configReadError(ahPath);
      const ahExisting = ahConfig.servers?.codegraph;
      if (!deepEqual(ahExisting, serverConfig)) {
        if (!ahConfig.servers) ahConfig.servers = {};
        ahConfig.servers.codegraph = serverConfig;
        writeJsonConfig(ahPath, ahConfig);
        if (action === 'unchanged') action = ahExisting ? 'updated' : 'created';
      }
    }

    return { action, success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { action: 'unchanged', success: false, error: msg };
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

function isTraeInstalled(): boolean {
  const homeDir = os.homedir();
  // Trae IDE 标记目录：SOLO/服务端形态用 ~/.trae 与 ~/.trae-server，桌面版用平台 userData 目录
  const markers: string[] = [
    path.join(homeDir, '.trae'),         // Trae 内置资源/运行时目录
    path.join(homeDir, '.trae-server'),  // Trae SOLO/服务端数据目录
  ];
  if (process.platform === 'win32') {
    markers.push(path.join(process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming'), 'Trae'));
  } else if (process.platform === 'darwin') {
    markers.push(path.join(homeDir, 'Library', 'Application Support', 'Trae'));
  } else {
    markers.push(path.join(homeDir, '.config', 'Trae'));
  }
  // 任一标记目录存在即视为已安装
  return markers.some(p => fs.existsSync(p));
}

function isTraeCnInstalled(): boolean {
  const homeDir = os.homedir();
  // Trae CN IDE 标记目录：与 Trae IDE 对称
  const markers: string[] = [
    path.join(homeDir, '.trae-cn'),         // Trae CN 内置资源/运行时目录
    path.join(homeDir, '.trae-cn-server'),  // Trae CN SOLO/服务端数据目录
  ];
  if (process.platform === 'win32') {
    markers.push(path.join(process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming'), 'Trae CN'));
  } else if (process.platform === 'darwin') {
    markers.push(path.join(homeDir, 'Library', 'Application Support', 'Trae CN'));
  } else {
    markers.push(path.join(homeDir, '.config', 'Trae CN'));
  }
  // 任一标记目录存在即视为已安装
  return markers.some(p => fs.existsSync(p));
}

function isVSCodeInstalled(): boolean {
  const homeDir = os.homedir();
  // VS Code 标记目录：
  // 1. 远程形态（Remote-SSH / Dev Containers）：vscode-server 的 userData 目录
  //    ~/.vscode-server/data/User —— 扩展运行于此形态时标准桌面版目录可能不存在
  // 2. Agent Host：~/.copilot（harness-agnostic 用户级配置目录）
  // 3. 本机桌面版：用户级 userData 目录（稳定版 Code 或 Insiders "Code - Insiders"）
  const markers: string[] = [
    path.join(homeDir, '.vscode-server', 'data', 'User'),
    path.join(homeDir, '.copilot'),
  ];
  for (const app of ['Code', 'Code - Insiders']) {
    if (process.platform === 'win32') {
      markers.push(path.join(process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming'), app));
    } else if (process.platform === 'darwin') {
      markers.push(path.join(homeDir, 'Library', 'Application Support', app));
    } else {
      markers.push(path.join(homeDir, '.config', app));
    }
  }
  // 任一标记目录存在即视为已安装
  return markers.some(p => fs.existsSync(p));
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
    {
      name: 'Trae IDE',
      isInstalled: isTraeInstalled,
      configure: configureTrae,
    },
    {
      name: 'Trae CN IDE',
      isInstalled: isTraeCnInstalled,
      configure: configureTraeCn,
    },
    {
      name: 'VS Code',
      isInstalled: isVSCodeInstalled,
      configure: configureVSCode,
    },
  ];
}

/**
 * 配置所有支持的 AI 代理
 *
 * 在扩展激活时作为后台任务调用。
 * 幂等 — 如果所有代理都已配置，立即返回。
 *
 * @param codegraphPath - codegraph CLI 的绝对路径（findCodeGraphCommand 的结果），
 *   传给 VS Code 等代理作为 MCP command，避免 VS Code Server PATH 不含
 *    ~/.local/bin 时 spawn ENOENT
 * @param _env - 保留参数（兼容性），不再使用
 * @param silent - 是否静默（不显示通知）
 * @returns AgentConfigResult 包含成功状态和摘要
 */
export async function configureAgents(
  codegraphPath: string,
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

    // 传入 codegraphPath（绝对路径）：VS Code 等代理用它作为 MCP command，
    // 避免 VS Code Server PATH 不含 ~/.local/bin 时 spawn ENOENT
    const result = agent.configure(codegraphPath);
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
