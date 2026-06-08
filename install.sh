#!/bin/sh
#
# CodeGraph standalone installer.
#
# Downloads a self-contained bundle (a vendored Node runtime + the app) from
# GitHub Releases. No Node.js, no build tools, no npm required — ideal for a
# fresh Linux VPS over SSH.
#
#   curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | sh
#
# Upgrade:   run `codegraph upgrade` (or just re-run the same command).
# Uninstall: curl -fsSL .../install.sh | sh -s -- --uninstall
#
# Environment:
#   CODEGRAPH_VERSION      release tag to install (default: latest)
#   CODEGRAPH_INSTALL_DIR  bundle location   (default: ~/.codegraph)
#   CODEGRAPH_BIN_DIR      symlink location  (default: ~/.local/bin)
set -eu

REPO="colbymchenry/codegraph"
INSTALL_DIR="${CODEGRAPH_INSTALL_DIR:-$HOME/.codegraph}"
BIN_DIR="${CODEGRAPH_BIN_DIR:-$HOME/.local/bin}"

if [ "${1:-}" = "--uninstall" ]; then
  rm -f "$BIN_DIR/codegraph"
  rm -rf "$INSTALL_DIR"
  echo "CodeGraph uninstalled (removed $INSTALL_DIR and $BIN_DIR/codegraph)."
  exit 0
fi

# 1. Detect platform → target triple matching the release archives.
os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Darwin) os="darwin" ;;
  Linux)  os="linux" ;;
  *) echo "codegraph: unsupported OS '$os'." >&2; exit 1 ;;
esac
case "$arch" in
  arm64|aarch64) arch="arm64" ;;
  x86_64|amd64)  arch="x64" ;;
  *) echo "codegraph: unsupported architecture '$arch'." >&2; exit 1 ;;
esac
target="${os}-${arch}"

# 2. Resolve the version (latest release unless pinned).
#
# Resolve "latest" from the releases/latest *web* redirect, not the GitHub API:
# the unauthenticated API is rate-limited to 60 requests/hour per IP and returns
# 403 once exhausted — routine on shared/cloud hosts and CI (issue #325). The
# redirect (github.com/<repo>/releases/latest -> .../releases/tag/vX.Y.Z) has no
# such limit. Fall back to the API if the redirect can't be read.
version="${CODEGRAPH_VERSION:-}"
if [ -z "$version" ]; then
  version="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest" \
    | sed -n 's#.*/releases/tag/##p')"
fi
if [ -z "$version" ]; then
  version="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
    | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n1)"
fi
[ -n "$version" ] || { echo "codegraph: could not resolve latest version; set CODEGRAPH_VERSION (e.g. CODEGRAPH_VERSION=v0.9.4)." >&2; exit 1; }
# Release tags are vX.Y.Z; accept a bare X.Y.Z in CODEGRAPH_VERSION too.
case "$version" in v*) ;; *) version="v$version" ;; esac

# 3. Download + extract the bundle.
url="https://github.com/$REPO/releases/download/$version/codegraph-${target}.tar.gz"
echo "Installing CodeGraph $version ($target)..."
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL "$url" -o "$tmp/cg.tar.gz" || { echo "codegraph: download failed: $url" >&2; exit 1; }

dest="$INSTALL_DIR/versions/$version"
rm -rf "$dest"
mkdir -p "$dest"
# Archives contain a top-level codegraph-<target>/ dir; strip it.
tar -xzf "$tmp/cg.tar.gz" -C "$dest" --strip-components=1

# 4. Symlink the launcher onto PATH and mark the current version.
mkdir -p "$BIN_DIR"
ln -sf "$dest/bin/codegraph" "$BIN_DIR/codegraph"
ln -sfn "$dest" "$INSTALL_DIR/current"

echo "Installed to $dest"
echo "Linked     $BIN_DIR/codegraph"

# 5. 自动将 BIN_DIR 添加到 PATH（写入 shell 配置文件）
# 这样 codegraph 命令可以在终端、VS Code、Cursor、Claude Code 等环境中被找到
case ":$PATH:" in
  *":$BIN_DIR:"*)
    echo "$BIN_DIR 已在 PATH 中"
    ;;
  *)
    echo ""
    echo "$BIN_DIR 不在 PATH 中，正在自动添加..."
    
    # 检测当前使用的 shell 并写入对应的配置文件
    current_shell="$(basename "${SHELL:-/bin/sh}")"
    added=false
    
    # 函数：检查并添加 PATH 到配置文件
    add_path_to_file() {
      local file="$1"
      local export_line="export PATH=\"$BIN_DIR:\$PATH\""
      
      if [ -f "$file" ]; then
        # 检查是否已经存在
        if grep -qF "$BIN_DIR" "$file" 2>/dev/null; then
          echo "  已在 $file 中配置"
          return 0
        fi
        # 添加 PATH
        echo "" >> "$file"
        echo "# CodeGraph - added by install.sh on $(date '+%Y-%m-%d %H:%M:%S')" >> "$file"
        echo "$export_line" >> "$file"
        echo "  已添加到 $file"
        return 0
      fi
      return 1
    }
    
    # 根据 shell 类型写入配置文件
    case "$current_shell" in
      zsh)
        add_path_to_file "$HOME/.zshrc" && added=true
        add_path_to_file "$HOME/.zprofile" && added=true
        ;;
      bash)
        add_path_to_file "$HOME/.bashrc" && added=true
        add_path_to_file "$HOME/.bash_profile" && added=true
        add_path_to_file "$HOME/.profile" && added=true
        ;;
      *)
        # 通用配置
        add_path_to_file "$HOME/.profile" && added=true
        add_path_to_file "$HOME/.bashrc" && added=true
        ;;
    esac
    
    if [ "$added" = true ]; then
      echo ""
      echo "✓ PATH 已自动配置。请执行以下操作之一使配置生效："
      echo "  - 重新打开终端"
      echo "  - 或运行: source ~/.bashrc (或 ~/.zshrc)"
      echo "  - 或重启 VS Code / Cursor / Claude Code"
    else
      echo ""
      echo "⚠ 无法自动配置 PATH，请手动添加："
      echo "  export PATH=\"$BIN_DIR:\$PATH\""
    fi
    ;;
esac

echo ""
echo "Done. Run: codegraph --help"
