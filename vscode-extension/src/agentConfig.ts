/**
 * Agent Auto-Configuration Module
 *
 * Automatically configures CodeGraph MCP server into all detected AI agents
 * (Claude Code, Cursor, Codex, opencode, Gemini, Kiro, etc.) by running
 * `codegraph install --yes --target=all --location=global`.
 *
 * This module is called on every extension activation. The `codegraph install`
 * command is fully idempotent:
 * - Detects which agents are installed on the system
 * - Writes MCP server config for each detected agent
 * - Skips agents whose config is already present (returns "unchanged")
 * - `--yes` implies autoAllow=true, so no permission prompts in Claude Code
 *
 * Design: minimal invasion — this is a standalone module that only calls
 * the codegraph CLI as a subprocess. No imports from the main codegraph
 * project, easy to sync upstream.
 */

import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { t } from './i18n';

/**
 * Result of the agent configuration attempt.
 */
export interface AgentConfigResult {
  /** Whether the configuration was successful */
  success: boolean;
  /** Whether all agents were already configured (no changes needed) */
  alreadyConfigured: boolean;
  /** Human-readable summary of what happened */
  message: string;
}

/**
 * Configure CodeGraph into all detected AI agents.
 *
 * Runs `codegraph install --yes --target=all --location=global`
 * which is fully non-interactive and idempotent:
 * - Detects which agents are installed on the system
 * - Writes MCP server config for each detected agent
 * - Skips agents that are already configured (returns "unchanged")
 * - --yes implies autoAllow=true (no permission prompts in Claude Code)
 *
 * The installer detects agents by checking for config directories:
 * - Claude Code: ~/.claude/
 * - Cursor: ~/.cursor/
 * - Codex CLI: ~/.codex/
 * - opencode: ~/.config/opencode/
 * - Gemini: ~/.gemini/
 * - Kiro: ~/.kiro/
 * - etc.
 *
 * @param codegraphPath - Absolute path to the codegraph executable
 * @param env - Environment variables for the child process
 * @param silent - If true, suppress all user-facing notifications
 * @returns AgentConfigResult with success status and summary
 */
export async function configureAgents(
  codegraphPath: string,
  env: NodeJS.ProcessEnv,
  silent: boolean = false
): Promise<AgentConfigResult> {
  if (!silent) {
    vscode.window.showInformationMessage(t('agentConfig.configuring'));
  }

  try {
    const { exitCode, stdout } = await runCommand(
      codegraphPath,
      ['install', '--yes', '--target=all', '--location=global'],
      env
    );

    if (exitCode === 0) {
      // The installer prints "Unchanged" for agents that were already
      // configured. If ALL output lines contain "Unchanged" or
      // "skipped", no new configuration was written.
      const allUnchanged = parseAllUnchanged(stdout);

      if (allUnchanged && !silent) {
        vscode.window.showInformationMessage(t('agentConfig.alreadyConfigured'));
      } else if (!silent) {
        vscode.window.showInformationMessage(t('agentConfig.success'));
      }

      return {
        success: true,
        alreadyConfigured: allUnchanged,
        message: allUnchanged ? t('agentConfig.alreadyConfigured') : t('agentConfig.success'),
      };
    } else {
      console.warn(`[CodeGraph] agent config exited with code ${exitCode}`);
      if (!silent) {
        vscode.window.showWarningMessage(t('agentConfig.partial'));
      }
      return {
        success: false,
        alreadyConfigured: false,
        message: t('agentConfig.partial'),
      };
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn('[CodeGraph] agent configuration failed:', msg);
    // Don't show error to user — this is a best-effort operation
    return {
      success: false,
      alreadyConfigured: false,
      message: t('agentConfig.failed', msg),
    };
  }
}

/**
 * Parse installer stdout to determine if all agents were already configured.
 *
 * The installer outputs lines like:
 *   │ ✔ Claude Code: Unchanged ~/.claude/settings.json
 *   │ ✔ Codex CLI: Created ~/.codex/config.toml
 *
 * If every agent line says "Unchanged" or "skipped", no new config was written.
 */
function parseAllUnchanged(stdout: string): boolean {
  if (!stdout.trim()) return true;

  // Find lines that look like agent results (contain a colon after a name)
  const agentLines = stdout.split('\n').filter(line =>
    line.includes(':') && (
      line.includes('Unchanged') ||
      line.includes('Created') ||
      line.includes('Updated') ||
      line.includes('Removed') ||
      line.includes('skipped') ||
      line.includes('not-found')
    )
  );

  if (agentLines.length === 0) return true;

  // Check if ALL agent lines indicate no new changes
  return agentLines.every(line =>
    line.includes('Unchanged') || line.includes('skipped') || line.includes('not-found')
  );
}

/**
 * Run a codegraph CLI command and return its exit code + stdout.
 *
 * Captures stdout/stderr to prevent pipe buffer saturation
 * (same pattern as codegraphManager.runCliCommand).
 */
function runCommand(
  codegraphPath: string,
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(codegraphPath, args, {
      cwd: undefined,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    // Drain stdout to prevent pipe buffer saturation
    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('close', (code: number | null) => {
      if (stdout.trim()) {
        console.log(`[CodeGraph agent-config] stdout:\n${stdout.trim().substring(0, 1000)}`);
      }
      if (stderr.trim()) {
        console.warn(`[CodeGraph agent-config] stderr:\n${stderr.trim().substring(0, 500)}`);
      }
      resolve({ exitCode: code, stdout, stderr });
    });

    child.on('error', (err: Error) => {
      console.warn('[CodeGraph agent-config] spawn error:', err.message);
      resolve({ exitCode: -1, stdout: '', stderr: err.message });
    });
  });
}
