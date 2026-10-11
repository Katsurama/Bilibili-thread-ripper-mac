# BTR Desktop for macOS（非官方移植）

把 [Bilibili 线程撕裂者桌面版](https://github.com/MrTangLuyao/Bilibili-thread-ripper-desktop) 装进 **macOS 官方哔哩哔哩客户端**。

> [!WARNING]
> 这是社区做的**非官方**移植原型，不是原作者发布的版本。原作者明确表示不会做 macOS 版，请不要把这里的问题报到原仓库。

## 它做了什么

原版只支持 Windows。macOS 的官方客户端同样是 Electron 应用，结构和 Windows 版基本一致，所以可以用同样的方式接入：

- 安装时从原仓库下载 BTR Desktop 的 `dist/desktop.js`（下载内核和设置界面），**这里不包含也不修改原作者的代码**
- 在客户端的 `app.asar` 里加一个普通的 Electron preload，把 BTR 注入播放页面，播放器、字幕、弹幕都保持客户端原样（注入的代码在 [payload/](payload)）
- 修改后用本地签名（ad-hoc）重新签名客户端
- 安装前把整个官方客户端完整备份一份，可以一键还原

只用系统自带的 `python3`、`git` 和 `codesign`，不需要安装 Node.js。

## 准备

- 官方哔哩哔哩 macOS 客户端，放在“应用程序”文件夹里（`/Applications` 或 `~/Applications`）。装在别处可以用 `BTR_APP=/path/to/哔哩哔哩.app` 指定
- 命令行开发者工具（提供 `git` 和 `python3`）。没装过的话，第一次运行 `git` 时系统会弹窗提示安装，也可以先运行 `xcode-select --install`
- 给“终端”打开 **系统设置 → 隐私与安全性 → App 管理** 权限，然后重开终端。安装、更新、卸载都要修改 `/Applications` 里的客户端，客户端里的更新和卸载按钮也是交给系统自带的“终端”来完成的

## 安装

1. **完全退出客户端**（⌘Q）
2. 在终端运行（第一次安装和以后更新都用这两行）：

   ```bash
   [ -d ~/btr-mac ] || git clone https://github.com/luitao666-arch/Bilibili-thread-ripper-mac.git ~/btr-mac
   bash ~/btr-mac/install-mac.sh
   ```

   安装脚本每次都会先拉取本仓库和 BTR Desktop 的最新代码，再安装。

3. **从程序坞或启动台**打开客户端，在 **设置 → 线程撕裂者** 里调整 CDN 和线程数

第一次安装会把官方客户端备份到 `~/Library/Application Support/BTR-Mac/backup/`（约 400 MB），卸载时用它还原。

## 更新和卸载

在客户端 **设置 → 线程撕裂者** 里：

- **检查 BTR 更新**：同时检查原仓库的 BTR 新版本和本仓库的 macOS 移植新版本，有更新时点 **更新到 …** 并确认
- **卸载 BTR**：确认后用安装前的备份还原官方客户端

确认后会先打开“终端”，然后客户端自动关闭；终端等客户端退出后完成更新或卸载，成功就重新打开客户端，失败时窗口停留并显示错误。终端需要“App 管理”权限（见上面的安装说明）。日志同时记在 `~/Library/Application Support/BTR-Mac/maintain.log`。

也可以在终端里操作：

```bash
bash ~/btr-mac/install-mac.sh            # 安装或更新（和 update 一样）
bash ~/btr-mac/install-mac.sh update     # 更新
bash ~/btr-mac/install-mac.sh uninstall  # 还原官方客户端
bash ~/btr-mac/install-mac.sh status     # 查看状态
```

还原会用安装前的完整备份恢复官方客户端（包括苹果原签名），账号和设置不受影响。还原成功后会清理 BTR 留下的文件：`~/Library/Application Support/BTR-Mac` 里的备份、BTR 源码和日志都会删除，以后再安装时会重新备份。

卸载后只剩安装脚本本身。不再需要的话可以删除：

```bash
rm -rf ~/btr-mac
```

## 常见问题

**设置里没有“线程撕裂者”**

先确认 BTR 装上了：`bash ~/btr-mac/install-mac.sh status` 里 `installed` 不是 `null`。装上了还看不到，通常是客户端正在运行安装包自带的旧界面，还没装上官方热更新（BTR 的设置页需要新界面）。在客户端 **设置 → 关于哔哩哔哩** 里点 **检查更新**，或者重新打开几次客户端，等它提示“重启升级”后升级即可。

**更新后设置被恢复默认，或者提示“重启升级”后卡住**

旧版本（2026.10.11.8 之前）的安装脚本有这个问题。卡住时强制退出（⌥⌘Esc），从程序坞重新打开；然后 ⌘Q 退出客户端，在终端运行一次 `bash ~/btr-mac/install-mac.sh update` 更新到最新版。之后在客户端里更新就不会再这样。

**客户端里点了更新，但客户端一直没有重新打开**

2026.10.11.4 之前的版本有这个问题，请按上一条在终端里更新一次。新版本会弹出“终端”窗口显示进度；失败时窗口会停留并显示错误，日志在 `~/Library/Application Support/BTR-Mac/maintain.log`。

**官方客户端更新后 BTR 不见了**

重新下载官方安装包覆盖安装会替换掉 BTR，在终端再运行一次安装命令即可。

**怎么确认 BTR 在工作**

在 **设置 → 线程撕裂者** 打开 Debug，播放视频时会出现“已收到客户端播放地址”等提示。

## 和 Windows 版的区别

| | Windows 版（原版） | macOS 版（本仓库） |
|---|---|---|
| 安装 | PowerShell 一行命令 | 终端两行命令（`git clone` + 安装脚本） |
| 客户端内更新 / 卸载按钮 | 支持 | 支持（在“终端”里运行安装脚本，完成后重新打开客户端） |
| 官方覆盖安装后的守护提醒 | 支持 | 不支持，需要手动重新运行安装 |
| 签名 | 不涉及 | 改用本地签名 |

## 已测试

| macOS | 客户端 | BTR Desktop | 结果 |
|---|---|---|---|
| macOS 27.2（Apple M4） | 1.17.3，热更新到 1.19.0 | 2026.10.7.2-d1 | 设置页正常，视频可以播放；Debug 显示“已收到客户端播放地址”，BTR 已接入播放器；客户端内更新、卸载正常 |

欢迎在 Issues 里补充其他版本的测试结果（`bash ~/btr-mac/install-mac.sh status` 可以看到客户端和 BTR 的版本）。

## 注意事项

- 本地签名后，macOS 不再认为这是哔哩哔哩官方签名的应用。备份里保留了原版，随时可以还原。
- 更新会 `git pull` 本仓库，并从原仓库拉取最新的 `dist/desktop.js`。
- 官方客户端会根据 `Resources/app-update.yml` 判断自己是否被重新安装，判断为重装就会恢复默认设置并重新下载热更新。安装、更新和卸载时脚本会同步这条记录（`~/Library/Application Support/bilibili/resource/.appInfo`），避免设置被重置。

## 致谢与许可

- BTR 下载内核与界面：[MrTangLuyao/Bilibili-thread-ripper-desktop](https://github.com/MrTangLuyao/Bilibili-thread-ripper-desktop)，作者 LouieTang，MIT 许可证
- `btr_mac.py` 的 ASAR 读写和注入方式移植自原仓库的 `tools/asar.cjs` 与 `tools/client-package.cjs`

本仓库同样以 [MIT 许可证](LICENSE) 发布。
