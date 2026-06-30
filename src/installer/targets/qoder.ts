/**
 * Qoder target.
 *
 *   - MCP server entry to `~/.config/QoderCN/SharedClientCache/mcp.json`
 *     (global only — Qoder stores all config in a shared cache directory).
 *   - Same `{mcpServers: {...}}` shape as Claude and Cursor.
 *
 * ## Qoder 配置说明
 *
 * Qoder 是一个 AI 代理平台，使用 MCP 协议连接外部工具服务器。
 * 配置文件位于 `~/.config/QoderCN/SharedClientCache/mcp.json`，
 * 格式与 Cursor 的 mcp.json 相同：
 *
 * ```json
 * {
 *   "mcpServers": {
 *     "codegraph": {
 *       "command": "codegraph",
 *       "args": ["serve", "--mcp"]
 *     }
 *   }
 * }
 * ```
 *
 * Qoder 不支持项目本地配置，只有全局配置。
 * 没有自动权限/自动允许概念 — autoAllow 选项被忽略。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  AgentTarget,
  DetectionResult,
  InstallOptions,
  Location,
  WriteResult,
} from './types';
import {
  getMcpServerConfig,
  jsonDeepEqual,
  readJsonFile,
  writeJsonFile,
} from './shared';

/**
 * Qoder MCP 配置文件路径。
 * 
 * 为什么选择这个路径？
 * - Qoder 将所有配置存储在 ~/.config/QoderCN/ 目录下
 * - SharedCache 子目录用于存储共享的 MCP 服务器配置
 * - 这个路径在 Qoder 的官方文档中指定
 */
function mcpJsonPath(): string {
  return path.join(os.homedir(), '.config', 'QoderCN', 'SharedClientCache', 'mcp.json');
}

/**
 * Qoder Target 实现。
 *
 * 功能：
 * - 检测 Qoder 是否已安装（通过检查配置目录是否存在）
 * - 自动写入 CodeGraph MCP 服务器配置
 * - 支持幂等安装（重复运行不会产生重复配置）
 * - 支持卸载（移除 CodeGraph 配置）
 */
class QoderTarget implements AgentTarget {
  readonly id = 'qoder' as const;
  readonly displayName = 'Qoder';
  readonly docsUrl = 'https://qoder.com';

  /**
   * Qoder 只支持全局配置，不支持项目本地配置。
   *
   * 原因：Qoder 的配置目录结构是固定的，不支持按项目分离配置。
   */
  supportsLocation(loc: Location): boolean {
    return loc === 'global';
  }

  /**
   * 检测 Qoder 是否已安装并已配置 CodeGraph。
   *
   * 检测逻辑：
   * 1. 检查 ~/.config/QoderCN/ 目录是否存在
   * 2. 读取 mcp.json 检查是否已有 codegraph 配置
   *
   * @param loc - 安装位置（Qoder 只支持 global）
   * @returns 检测结果，包含是否已安装和是否已配置
   */
  detect(loc: Location): DetectionResult {
    // Qoder 只支持全局配置
    if (loc !== 'global') {
      return { installed: false, alreadyConfigured: false };
    }

    const mcpPath = mcpJsonPath();
    const config = readJsonFile(mcpPath);
    const alreadyConfigured = !!config.mcpServers?.codegraph;

    // 检测 Qoder 是否已安装：检查配置目录是否存在
    const configDir = path.join(os.homedir(), '.config', 'QoderCN');
    const installed = fs.existsSync(configDir);

    return { installed, alreadyConfigured, configPath: mcpPath };
  }

  /**
   * 安装 CodeGraph MCP 配置到 Qoder。
   *
   * 安装过程：
   * 1. 读取现有的 mcp.json（如果存在）
   * 2. 添加或更新 codegraph 配置
   * 3. 写入文件（原子写入，防止损坏）
   *
   * @param loc - 安装位置（Qoder 只支持 global）
   * @param opts - 安装选项（autoAllow 对 Qoder 无效）
   * @returns 写入结果
   */
  install(loc: Location, _opts: InstallOptions): WriteResult {
    const files: WriteResult['files'] = [];

    // Qoder 只支持全局配置
    if (loc !== 'global') {
      return {
        files: [{ path: mcpJsonPath(), action: 'not-found' }],
        notes: ['Qoder 只支持全局配置（--location=global）'],
      };
    }

    files.push(writeMcpEntry());

    return {
      files,
      notes: ['重启 Qoder 以使 MCP 配置生效'],
    };
  }

  /**
   * 卸载 CodeGraph MCP 配置。
   *
   * 卸载过程：
   * 1. 读取 mcp.json
   * 2. 移除 codegraph 配置
   * 3. 如果 mcpServers 为空，移除整个键
   * 4. 写入更新后的配置
   *
   * @param loc - 安装位置
   * @returns 写入结果
   */
  uninstall(loc: Location): WriteResult {
    if (loc !== 'global') {
      return { files: [] };
    }

    const mcpPath = mcpJsonPath();
    const config = readJsonFile(mcpPath);

    if (config.mcpServers?.codegraph) {
      delete config.mcpServers.codegraph;
      // 如果 mcpServers 为空，移除整个键以保持配置文件整洁
      if (Object.keys(config.mcpServers).length === 0) {
        delete config.mcpServers;
      }
      writeJsonFile(mcpPath, config);
      return { files: [{ path: mcpPath, action: 'removed' }] };
    }

    return { files: [{ path: mcpPath, action: 'not-found' }] };
  }

  /**
   * 打印 Qoder 的 MCP 配置片段。
   *
   * 用于 `codegraph install --print-config qoder` 命令，
   * 显示用户需要手动添加的配置内容。
   *
   * @param loc - 安装位置
   * @returns 格式化的配置片段
   */
  printConfig(loc: Location): string {
    if (loc !== 'global') {
      return '# Qoder 只支持全局配置\n';
    }

    const target = mcpJsonPath();
    const snippet = JSON.stringify(
      { mcpServers: { codegraph: getMcpServerConfig() } },
      null,
      2
    );
    return `# 添加到 ${target}\n\n${snippet}\n`;
  }

  /**
   * 返回此目标写入的文件路径列表。
   *
   * 用于 `codegraph install --print-config` 的路径显示。
   *
   * @param loc - 安装位置
   * @returns 文件路径数组
   */
  describePaths(loc: Location): string[] {
    if (loc !== 'global') {
      return [];
    }
    return [mcpJsonPath()];
  }
}

/**
 * 写入 MCP 服务器配置到 Qoder 的 mcp.json。
 *
 * 实现幂等性：
 * - 如果配置已存在且相同，返回 'unchanged'
 * - 如果配置已存在但不同，返回 'updated'
 * - 如果配置不存在，返回 'created'
 *
 * @returns 写入结果（单个文件）
 */
function writeMcpEntry(): WriteResult['files'][number] {
  const file = mcpJsonPath();
  const existing = readJsonFile(file);
  const before = existing.mcpServers?.codegraph;
  const after = getMcpServerConfig();

  // 检查配置是否已存在且相同（幂等性检查）
  if (jsonDeepEqual(before, after)) {
    return { path: file, action: 'unchanged' };
  }

  // 确定操作类型：更新或创建
  const action: 'created' | 'updated' = before
    ? 'updated'
    : fs.existsSync(file)
      ? 'updated'
      : 'created';

  // 添加或更新 codegraph 配置
  if (!existing.mcpServers) {
    existing.mcpServers = {};
  }
  existing.mcpServers.codegraph = after;

  // 原子写入，防止文件损坏
  writeJsonFile(file, existing);

  return { path: file, action };
}

/** 导出 Qoder 目标实例 */
export const qoderTarget: AgentTarget = new QoderTarget();
