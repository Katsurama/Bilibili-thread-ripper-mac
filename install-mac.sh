#!/bin/bash
# BTR Desktop macOS 安装脚本
#   ./install-mac.sh            拉取本仓库的最新版本后安装（已经装过就是更新）
#   ./install-mac.sh update     同上
#   ./install-mac.sh uninstall  还原官方客户端（用安装前的完整备份）
#   ./install-mac.sh status     查看状态
# 客户端设置页里的“安装更新 / 卸载 BTR”会以 --from-app <客户端进程号> 在后台调用本脚本：
# 等客户端退出后，在“终端”里运行同一个操作（输出同时记到 ~/Library/Application Support/BTR-Mac/maintain.log），
# 成功后重新打开客户端，失败时终端窗口停留显示错误。
# 环境变量：BTR_APP=客户端路径  BTR_REPO=本地 BTR Desktop 仓库（用它的 dist/desktop.js，默认用本仓库 desktop/dist 里的）
set -euo pipefail

# 找客户端：BTR_APP 指定的路径 → 两个“应用程序”文件夹里的 哔哩哔哩.app → Spotlight 按 bundle id 找。
find_app() {
  local candidate
  if [ -n "${BTR_APP:-}" ]; then printf '%s' "$BTR_APP"; return; fi
  for candidate in "/Applications/哔哩哔哩.app" "$HOME/Applications/哔哩哔哩.app"; do
    if [ -d "$candidate" ]; then printf '%s' "$candidate"; return; fi
  done
  while IFS= read -r candidate; do
    case "$candidate" in
      */.btr-restore.app) ;;
      /Applications/*.app|"$HOME"/Applications/*.app) printf '%s' "$candidate"; return ;;
    esac
  done < <(mdfind "kMDItemCFBundleIdentifier == 'com.bilibili.bilibiliPC'" 2>/dev/null)
  printf '%s' "/Applications/哔哩哔哩.app"
}
APP="$(find_app)"
DATA="${BTR_DATA:-$HOME/Library/Application Support/BTR-Mac}"
BACKUP="$DATA/backup/$(basename "$APP")"
SELF_URL="https://github.com/Katsurama/Bilibili-thread-ripper-mac.git"
HERE="$(cd "$(dirname "$0")" && pwd)"
PATCHER="$HERE/btr_mac.py"
ASAR="$APP/Contents/Resources/app.asar"
PLIST="$APP/Contents/Info.plist"
LOG="$DATA/maintain.log"
CLIENT_RESOURCE="${BTR_CLIENT_RESOURCE:-$HOME/Library/Application Support/bilibili/resource}"

ACTION="${1:-install}"; [ $# -gt 0 ] && shift
FROM_APP=""; PULLED=""
while [ $# -gt 0 ]; do
  case "$1" in
    --from-app) FROM_APP="${2:-}"; shift 2 ;;
    --pulled) PULLED=1; shift ;;
    *) printf '未知参数：%s\n' "$1" >&2; exit 2 ;;
  esac
done

notify() { [ -n "$FROM_APP" ] && osascript -e "display notification \"$1\" with title \"BTR Desktop for macOS\"" >/dev/null 2>&1 || true; }
# 用 open 打开的应用会继承当前的环境变量。客户端算 .appInfo 时用的时区名称跟着 LANG 变（日语环境是
# “日本標準時”），带着终端的 LANG 打开会和从 Dock 打开算出不同的值，被当成重新安装。所以去掉语言环境再打开。
CLEAN_LOCALE="env -u LANG -u LC_ALL -u LC_CTYPE -u LC_MESSAGES -u LC_COLLATE -u LC_NUMERIC -u LC_TIME -u LC_MONETARY"
relaunch() { [ -n "$FROM_APP" ] && [ -d "$APP" ] && $CLEAN_LOCALE open "$APP" >/dev/null 2>&1 || true; }
relaunch_after_action() { [ -z "$FROM_APP" ] && relaunch; }
say() { printf '\033[1;35m[BTR]\033[0m %s\n' "$*"; }
die() {
  printf '\033[1;31m[BTR] %s\033[0m\n' "$*" >&2
  if [ -n "$FROM_APP" ]; then notify "$1"; relaunch; fi
  exit 1
}

# 从客户端里调用时：立刻把操作交给“终端”，由终端等客户端退出后再做。
# 客户端启动的后台进程在客户端退出后几秒内会被系统悄无声息地结束（日志停在半路、客户端也不会被重新打开），
# 所以这里必须在客户端退出之前就完成交接；客户端会等本脚本退出后才关闭自己。
# 修改 /Applications 需要的“App 管理”权限用户也是给终端授的，终端里还能看到进度和错误。
if [ -n "$FROM_APP" ]; then
  mkdir -p "$DATA"; exec >>"$LOG" 2>&1
  printf '\n===== %s %s（客户端发起）=====\n' "$(date '+%F %T')" "$ACTION"
  case "$FROM_APP" in *[!0-9]*|"") die "无效的客户端进程号" ;; esac
  command="$DATA/run-in-terminal.command"
  {
    printf '#!/bin/bash\n'
    # 终端里是全新的环境，把客户端路径和用户指定的设置带过去。
    printf 'export BTR_APP=%q\n' "$APP"
    for name in BTR_DATA BTR_REPO; do
      [ -n "${!name:-}" ] && printf 'export %s=%q\n' "$name" "${!name}"
    done
    printf 'echo "等待哔哩哔哩客户端退出…"\n'
    printf 'for _ in $(seq 1 120); do kill -0 %q 2>/dev/null || break; sleep 0.5; done\n' "$FROM_APP"
    printf 'for _ in $(seq 1 40); do pgrep -f %q >/dev/null 2>&1 || break; sleep 0.5; done\n' "$APP/Contents/"
    printf 'printf "\\n===== %%s %%s（终端）=====\\n" "$(date "+%%F %%T")" %q >> %q\n' "$ACTION" "$LOG"
    printf '/bin/bash %q %q 2>&1 | tee -a %q\n' "$HERE/install-mac.sh" "$ACTION" "$LOG"
    printf 'if [ "${PIPESTATUS[0]}" -eq 0 ]; then %s open %q; exit 0; fi\n' "$CLEAN_LOCALE" "$APP"
    printf 'echo; read -r -p "BTR 操作失败，客户端没有重新打开。按回车关闭这个窗口" _\n'
  } > "$command"
  chmod +x "$command"
  say "在终端里继续：$command"
  open -a Terminal "$command" || die "无法打开终端，请手动运行 install-mac.sh $ACTION"
  exit 0
fi

check_app() {
  [ -f "$ASAR" ] || die "找不到哔哩哔哩客户端（${APP}）。请先从官网安装客户端；装在别处的话，用 BTR_APP=/path/to/哔哩哔哩.app 指定"
  # 卸载时会删除并替换 $APP，所以必须确认它真的是哔哩哔哩客户端，不能是 BTR_APP 指错的别的应用。
  case "$APP" in /*.app) ;; *) die "客户端路径不对：${APP}" ;; esac
  [ "$(/usr/libexec/PlistBuddy -c "Print CFBundleIdentifier" "$PLIST" 2>/dev/null)" = "com.bilibili.bilibiliPC" ] \
    || die "${APP} 不是哔哩哔哩客户端，没有做任何修改"
  if pgrep -f "$APP/Contents/MacOS/" >/dev/null 2>&1; then die "请先完全退出哔哩哔哩客户端（⌘Q）再运行"; fi
}

# BTR 的数据目录里会删除 src、backup 等子目录，所以只接受默认位置，或者带着 BTR 标记文件的目录。
# BTR_DATA 被指到别的已有目录（比如 ~/Documents）时直接停止，不会删到用户自己的文件。
DATA_MARKER=".btr-mac-data"
ensure_data_dir() {
  if [ "$DATA" != "$HOME/Library/Application Support/BTR-Mac" ] && [ -d "$DATA" ] \
    && [ ! -f "$DATA/$DATA_MARKER" ] && [ -n "$(ls -A "$DATA" 2>/dev/null)" ]; then
    die "BTR_DATA（${DATA}）不是 BTR 的数据目录，里面已经有别的文件。请换一个空目录"
  fi
  mkdir -p "$DATA" && : > "$DATA/$DATA_MARKER"
}

# 修改 /Applications 里的应用需要“App 管理”权限。
check_writable() {
  local probe="$APP/Contents/Resources/.btr-write-test"
  if ( : > "$probe" ) 2>/dev/null; then rm -f "$probe"; return; fi
  die "没有权限修改 ${APP}。请到 系统设置 → 隐私与安全性 → App 管理，允许你正在用的终端，然后重开终端再运行。"
}

# 官方客户端启动时用 Resources/app-update.yml 的 ctime 算 md5，和 resource/.appInfo 比对；
# 不一致就当作重新安装：删掉 .version，设置恢复默认，重新下载热更新并提示重启。
# 我们改动客户端会改变这个 ctime（内容不变），所以改动前如果两者一致，改动后替它写回新值。
# 函数都接收客户端路径，卸载时可以在还原副本挪回原位之前就算好新值，客户端不会看到不一致的状态。
APPINFO_SYNC=""
appinfo_file() {
  local dir="$CLIENT_RESOURCE"
  [ -d "${1:-$APP}/Contents/MacOS/versions" ] && dir="${1:-$APP}/Contents/MacOS/versions"
  printf '%s/.appInfo' "$dir"
}
# 以 Node 模式运行 $APP 当前那份客户端自带的 Electron，计算参数里那份客户端的值。
# 不能执行刚从备份复制出来的客户端：系统安全策略会拒绝运行它，连带脚本中断、还原做到一半。
# 10 秒超时，避免卡住时整个脚本停在这里。
# Date 的 toString() 里的时区名称跟着语言环境变（中文环境是“日本标准时间”，客户端自己算时是
# “Japan Standard Time”），所以固定用 C 语言环境，和客户端算出的值一致。
appinfo_hash() {
  local app="${1:-$APP}" exe
  exe=$(/usr/libexec/PlistBuddy -c "Print CFBundleExecutable" "$PLIST") || return 1
  LC_ALL=C LANG=C ELECTRON_RUN_AS_NODE=1 /usr/bin/perl -e 'alarm shift; exec @ARGV or exit 127' 10 "$APP/Contents/MacOS/$exe" -e 'const s=require("fs").statSync(process.argv[1]).ctime.toString();process.stdout.write(require("crypto").createHash("md5").update(s).digest("hex"))' "$app/Contents/Resources/app-update.yml" </dev/null 2>/dev/null
}
# 参数 force：不比对，只要 .appInfo 存在就同步（卸载时用：当前客户端是我们改过的，不一致也是我们造成的）。
remember_appinfo() {
  local file current
  file="$(appinfo_file)"
  [ -f "$file" ] && [ -f "$APP/Contents/Resources/app-update.yml" ] || return 0
  if [ "${1:-}" = force ]; then APPINFO_SYNC=1; return 0; fi
  current="$(appinfo_hash || true)"
  if [ -n "$current" ] && [ "$(cat "$file")" = "$current" ]; then APPINFO_SYNC=1
  else say "注意：客户端版本记录与当前客户端不一致（可能还没启动过），不做同步"; fi
}
sync_appinfo() {
  [ -n "$APPINFO_SYNC" ] || return 0
  local app="${1:-$APP}" hash; hash="$(appinfo_hash "$app" || true)"
  if [[ "$hash" =~ ^[0-9a-f]{32}$ ]]; then
    printf '%s' "$hash" > "$(appinfo_file "$app")" && say "已保留官方客户端的热更新状态和设置"
  else
    say "注意：无法更新客户端版本记录，下次启动客户端可能会恢复默认设置"
  fi
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
  # 上次备份中断留下的半成品要先删掉：ditto 会合并进已有目录，旧文件会混进备份。
  rm -rf "$BACKUP.tmp"
  ditto "$APP" "$BACKUP.tmp" && mv "$BACKUP.tmp" "$BACKUP"
}

# BTR 的代码随本仓库一起发布（desktop/dist），只装在 Mac 上测过的这一份。
fetch_bundle() {
  BUNDLE="${BTR_REPO:+$BTR_REPO/dist/desktop.js}"
  BUNDLE="${BUNDLE:-$HERE/desktop/dist/desktop.js}"
  [ -f "$BUNDLE" ] || die "找不到 ${BUNDLE}，请按 README 重新下载本仓库"
}

resign() {
  say "更新 ASAR 完整性记录并重新签名（本地签名）"
  local hash
  hash=$(python3 -I "$PATCHER" header-hash "$ASAR")
  /usr/libexec/PlistBuddy -c "Set :ElectronAsarIntegrity:Resources/app.asar:hash $hash" "$PLIST" 2>/dev/null || true
  # 失败时不能让 set -e 悄悄退出：app.asar 已经换掉，签名不对的客户端打不开，必须告诉用户怎么还原。
  codesign --force --deep --sign - "$APP" || die "重新签名失败，请运行 install-mac.sh uninstall 还原"
  codesign --verify --deep "$APP" || die "签名校验失败，请运行 install-mac.sh uninstall 还原"
  xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
}

install() {
  check_app; ensure_data_dir; check_writable; fetch_bundle; remember_appinfo; make_backup
  local tmp; tmp="$(mktemp -d "$DATA/tmp.XXXXXX")"
  python3 -I "$PATCHER" patch "$BACKUP/Contents/Resources/app.asar" "$BUNDLE" "$tmp/app.asar" "$HERE"
  cp "$tmp/app.asar" "$ASAR.btr.tmp" && mv "$ASAR.btr.tmp" "$ASAR"
  rm -rf "$tmp"
  resign
  sync_appinfo
  say "安装完成。打开客户端，在 设置 → BTR Desktop for macOS 里调整；还原请运行 install-mac.sh uninstall"
  notify "BTR 已更新，正在重新打开客户端"
  relaunch_after_action
}

# 先更新本仓库（安装脚本和注入代码），再用新脚本完成安装。安装和更新都这样，
# 免得本地仓库是旧的时候装进去旧代码。
update() {
  # 本仓库换过 GitHub 用户名。旧地址靠 GitHub 的跳转才能用，旧用户名被别人注册后就会失效，
  # 所以把还指向旧地址的副本改到现在的地址。拉取之后的新脚本也会再跑一次，保证改过来。
  if [ -d "$HERE/.git" ]; then
    case "$(git -C "$HERE" remote get-url origin 2>/dev/null || true)" in
      "$SELF_URL"|"${SELF_URL%.git}") ;;
      https://github.com/*/Bilibili-thread-ripper-mac|https://github.com/*/Bilibili-thread-ripper-mac.git)
        git -C "$HERE" remote set-url origin "$SELF_URL" && say "已把本仓库的下载地址改为 ${SELF_URL}" ;;
    esac
  fi
  if [ -z "$PULLED" ] && [ -d "$HERE/.git" ]; then
    say "更新 macOS 安装脚本"
    git -C "$HERE" pull --ff-only -q || say "注意：安装脚本更新失败，继续使用当前版本"
    exec /bin/bash "$HERE/install-mac.sh" "$ACTION" --pulled
  fi
  install
}

uninstall() {
  check_app
  ensure_data_dir
  # 当前客户端已经不含 BTR（比如重新装过官方客户端，可能比备份新）时不能用备份覆盖它，只清理 BTR 的文件。
  if [ "$(asar_installed "$ASAR")" = "no" ]; then
    clean_client_cache
    cleanup_data
    say "当前客户端不含 BTR，没有改动客户端，只清理了备份和 BTR 的数据"
    notify "BTR 已卸载，正在重新打开官方客户端"
    relaunch_after_action
    return
  fi
  [ -d "$BACKUP" ] || die "没有找到备份，无法还原。可以从官网重新下载安装官方客户端。"
  check_writable
  remember_appinfo force
  say "用备份还原官方客户端（保留原始苹果签名）"
  local restore; restore="$(dirname "$APP")/.btr-restore.app"
  rm -rf "$restore"
  ditto "$BACKUP" "$restore"
  # 备份带着下载时的隔离标记，新复制出来的应用第一次执行会被系统检查；和安装时一样去掉它。
  # 去标记会改 ctime，所以必须在计算版本记录之前做。改名不会改变里面文件的 ctime。
  xattr -dr com.apple.quarantine "$restore" 2>/dev/null || true
  sync_appinfo "$restore"
  rm -rf "$APP" && mv "$restore" "$APP"
  # 还原后的客户端就是备份本身的副本，确认它已就位且不含 BTR 后，清理 BTR 留下的文件；下次安装会重新备份。
  if [ -f "$ASAR" ] && [ "$(asar_installed "$ASAR")" = "no" ]; then
    clean_client_cache
    cleanup_data
    say "已还原官方客户端，并清理了备份和 BTR 的数据。账号和设置未改动。"
    say "安装脚本还在 ${HERE}，不再需要的话请自己删除这个文件夹"
  else
    say "已还原，但没能确认还原结果，备份保留在 ${BACKUP}"
  fi
  notify "BTR 已卸载，正在重新打开官方客户端"
  relaunch_after_action
}

# 客户端判定“重新安装”时，会把当时的 app.asar 复制进自己的缓存目录并从那里运行。
# 如果那时装着 BTR，缓存里就是带 BTR 的副本，只还原 /Applications 的话卸载后 BTR 仍会被加载。
# 同版本的换成备份里的官方 app.asar（就是官方客户端自己会放进去的那份），版本对不上的删掉让客户端重新获取。
clean_client_cache() {
  local file official="$BACKUP/Contents/Resources/app.asar" version official_version
  [ -d "$CLIENT_RESOURCE" ] || return 0
  official_version="$(asar_version "$official" || true)"
  for file in "$CLIENT_RESOURCE"/*.asar; do
    [ -f "$file" ] && [ "$(asar_installed "$file" 2>/dev/null || true)" = "yes" ] || continue
    version="$(asar_version "$file" || true)"
    if [ -n "$version" ] && [ "$version" = "$official_version" ] \
      && cp "$official" "$file.btr.tmp" && mv "$file.btr.tmp" "$file"; then
      say "客户端缓存里带 BTR 的副本已换回官方版本：$(basename "$file")"
    else
      rm -f "$file.btr.tmp" "$file" && say "删除了客户端缓存里带 BTR 的副本：$(basename "$file")"
    fi
  done
}
asar_version() { python3 -I "$PATCHER" status "$1" | python3 -I -c 'import json,sys;print(json.load(sys.stdin)["clientVersion"])'; }

# 安装脚本所在的文件夹不自动删除：里面可能有用户自己的文件，删不删由用户决定。

# 只删除 BTR 自己创建的东西，不整个删除 $DATA；ensure_data_dir 已经确认 $DATA 是 BTR 的数据目录。
# 从客户端发起时终端正在运行 run-in-terminal.command 并往 maintain.log 写；删掉文件不影响已经打开的它们。
cleanup_data() {
  rm -rf "$DATA/backup" "$DATA/src" "$DATA"/tmp.* "$DATA/run-in-terminal.command" "$DATA/maintain.log" "$DATA/$DATA_MARKER"
  rm -rf "$(dirname "$APP")/.btr-restore.app" "$ASAR.btr.tmp"
  rmdir "$DATA" 2>/dev/null || true
}

status() {
  [ -f "$ASAR" ] || die "找不到客户端：$APP"
  python3 -I "$PATCHER" status "$ASAR"
  [ -d "$BACKUP" ] && say "备份：$BACKUP" || say "备份：无"
  codesign -dv "$APP" 2>&1 | grep -E "^(Signature|TeamIdentifier)" || true
}

case "$ACTION" in
  install|update) update ;;
  uninstall|remove) uninstall ;;
  status) status ;;
  *) die "用法：$0 [install|update|uninstall|status]" ;;
esac
