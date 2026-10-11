#!/bin/bash
# BTR Desktop macOS 原型安装脚本
#   ./install-mac.sh            安装或更新
#   ./install-mac.sh uninstall  还原官方客户端（用安装前的完整备份）
#   ./install-mac.sh status     查看状态
# 环境变量：BTR_APP=客户端路径  BTR_REPO=本地 BTR Desktop 仓库  BTR_REF=分支或标签（默认 main）
set -euo pipefail

APP="${BTR_APP:-/Applications/哔哩哔哩.app}"
DATA="${BTR_DATA:-$HOME/Library/Application Support/BTR-Mac}"
BACKUP="$DATA/backup/$(basename "$APP")"
REPO_URL="https://github.com/MrTangLuyao/Bilibili-thread-ripper-desktop"
HERE="$(cd "$(dirname "$0")" && pwd)"
PATCHER="$HERE/btr_mac.py"
ASAR="$APP/Contents/Resources/app.asar"
PLIST="$APP/Contents/Info.plist"

say() { printf '\033[1;35m[BTR]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[BTR] %s\033[0m\n' "$*" >&2; exit 1; }

check_app() {
  [ -f "$ASAR" ] || die "找不到客户端：${APP}（可用 BTR_APP=/path/to/哔哩哔哩.app 指定）"
  if pgrep -f "$APP/Contents/MacOS/" >/dev/null 2>&1; then die "请先完全退出哔哩哔哩客户端（⌘Q）再运行"; fi
}

check_writable() {
  local probe="$APP/Contents/Resources/.btr-write-test"
  if ! ( : > "$probe" ) 2>/dev/null; then
    die "没有权限修改 ${APP}。请到 系统设置 → 隐私与安全性 → App 管理，允许你正在用的终端，然后重开终端再运行。"
  fi
  rm -f "$probe"
}

asar_installed() { python3 -I "$PATCHER" status "$1" | python3 -I -c 'import json,sys;print("yes" if json.load(sys.stdin)["installed"] else "no")'; }

make_backup() {
  if [ -d "$BACKUP" ]; then
    local backup_version app_version
    backup_version=$(/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" "$BACKUP/Contents/Info.plist")
    app_version=$(/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" "$PLIST")
    if [ "$backup_version" = "$app_version" ]; then return; fi
    [ "$(asar_installed "$ASAR")" = "no" ] || die "客户端版本（${app_version}）和备份（${backup_version}）不一致，且当前客户端已含 BTR。请重新安装官方客户端后再运行。"
    say "官方客户端已更新到 ${app_version}，替换旧备份"
    rm -rf "$BACKUP"
  fi
  [ "$(asar_installed "$ASAR")" = "no" ] || die "当前客户端已含 BTR 但没有备份，请先重新安装官方客户端"
  codesign --verify --deep --strict "$APP" 2>/dev/null || say "注意：当前客户端签名校验未通过，备份仍会继续"
  say "备份官方客户端到 ${BACKUP}（约 400 MB，只做一次）"
  mkdir -p "$(dirname "$BACKUP")"
  ditto "$APP" "$BACKUP.tmp" && mv "$BACKUP.tmp" "$BACKUP"
}

fetch_bundle() {
  if [ -n "${BTR_REPO:-}" ]; then BUNDLE="$BTR_REPO/dist/desktop.js"; else
    local src="$DATA/src" ref="${BTR_REF:-main}"
    if [ -d "$src/.git" ]; then
      say "更新 BTR Desktop 源码（${ref}）"
      git -C "$src" fetch --depth 1 origin "$ref" -q && git -C "$src" checkout -q --force FETCH_HEAD
    else
      say "下载 BTR Desktop 源码（${ref}）"
      rm -rf "$src"; git clone -q --depth 1 --branch "$ref" "$REPO_URL" "$src"
    fi
    BUNDLE="$src/dist/desktop.js"
  fi
  [ -f "$BUNDLE" ] || die "找不到 $BUNDLE"
}

resign() {
  say "更新 ASAR 完整性记录并重新签名（本地签名）"
  local hash
  hash=$(python3 -I "$PATCHER" header-hash "$ASAR")
  /usr/libexec/PlistBuddy -c "Set :ElectronAsarIntegrity:Resources/app.asar:hash $hash" "$PLIST" 2>/dev/null || true
  codesign --force --deep --sign - "$APP" 2>/dev/null
  codesign --verify --deep "$APP" || die "签名校验失败，请运行 ./install-mac.sh uninstall 还原"
  xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
}

install() {
  check_app; check_writable; fetch_bundle; make_backup
  local tmp; mkdir -p "$DATA"; tmp="$(mktemp -d "$DATA/tmp.XXXXXX")"
  python3 -I "$PATCHER" patch "$BACKUP/Contents/Resources/app.asar" "$BUNDLE" "$tmp/app.asar"
  cp "$tmp/app.asar" "$ASAR.btr.tmp" && mv "$ASAR.btr.tmp" "$ASAR"
  rm -rf "$tmp"
  resign
  say "安装完成。打开客户端，在 设置 → 线程撕裂者 里调整；还原请运行 ./install-mac.sh uninstall"
}

uninstall() {
  check_app
  [ -d "$BACKUP" ] || die "没有找到备份，无法还原。可以从官网重新下载安装官方客户端。"
  check_writable
  say "用备份还原官方客户端（保留原始苹果签名）"
  local parent; parent="$(dirname "$APP")"
  ditto "$BACKUP" "$parent/.btr-restore.app"
  rm -rf "$APP" && mv "$parent/.btr-restore.app" "$APP"
  say "已还原。账号和设置未改动。备份留在 ${BACKUP}，可手动删除。"
}

status() {
  [ -f "$ASAR" ] || die "找不到客户端：$APP"
  python3 -I "$PATCHER" status "$ASAR"
  [ -d "$BACKUP" ] && say "备份：$BACKUP" || say "备份：无"
  codesign -dv "$APP" 2>&1 | grep -E "^(Signature|TeamIdentifier)" || true
}

case "${1:-install}" in
  install|update) install ;;
  uninstall|remove) uninstall ;;
  status) status ;;
  *) die "用法：$0 [install|uninstall|status]" ;;
esac
