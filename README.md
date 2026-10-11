<div align="center">

<img src="https://raw.githubusercontent.com/MrTangLuyao/Bilibili-thread-ripper/main/icons/icon-128.png" width="112" alt="线程撕裂者图标">

# BTR Desktop for macOS

**Bilibili 线程撕裂者桌面版的 macOS 移植，适用于官方哔哩哔哩 macOS 客户端**

把线程撕裂者带到官方 macOS 客户端里，原本的播放器、字幕、弹幕和快捷键都保留

已在 macOS 27.2（Apple M4）、官方客户端 **1.19.0**、BTR Desktop **2026.10.7.2-d1** 实测

[![平台](https://img.shields.io/badge/%E5%B9%B3%E5%8F%B0-macOS-555555?style=flat-square&logo=apple)](#-安装) [![原项目](https://img.shields.io/badge/%E5%8E%9F%E9%A1%B9%E7%9B%AE-BTR%20Desktop-0078d4?style=flat-square)](https://github.com/MrTangLuyao/Bilibili-thread-ripper-desktop) [![网页版](https://img.shields.io/badge/%E7%BD%91%E9%A1%B5%E7%89%88-%E6%B2%B9%E7%8C%B4%E8%84%9A%E6%9C%AC-fb7299?style=flat-square)](https://github.com/MrTangLuyao/Bilibili-thread-ripper) [![许可证](https://img.shields.io/github/license/luitao666-arch/Bilibili-thread-ripper-mac?label=%E8%AE%B8%E5%8F%AF%E8%AF%81&style=flat-square&color=3b82f6)](LICENSE)

[**安装**](#-安装) · [设置](#️-设置) · [更新](#-更新) · [卸载](#-卸载) · [常见问题](#-常见问题) · [原项目](https://github.com/MrTangLuyao/Bilibili-thread-ripper-desktop)

</div>

> [!WARNING]
> 这是社区做的**非官方**移植，不是原作者发布的版本。原作者明确表示不会做 macOS 版，**请不要把这里的问题报到原仓库**，有问题请在本仓库的 Issues 里反馈。

> [!NOTE]
> 和原版一样，桌面版工作在类似网页版“兼容模式”的方式下：只接管视频下载，播放仍由客户端自己负责，所以效果可能不如网页版，但相比原生依旧提升明显。

## ✨ 它能做什么

- **原生客户端不变**：播放器、字幕、弹幕和快捷键都保留，BTR 只接管视频下载
- **不包含原作者的代码**：安装时从原仓库下载 BTR Desktop 的下载内核和设置界面（`dist/desktop.js`），这里只负责把它装进 macOS 客户端（注入代码在 [payload/](payload)）
- **客户端里更新和卸载**：发现新版本会提示，确认后在“终端”里完成，结束后自动重新打开客户端
- **随时一键还原**：安装前完整备份官方客户端，卸载时原样还原，不动账号和数据
- **只用系统自带工具**：`python3`、`git` 和 `codesign`，不需要安装 Node.js

## 📦 安装

**准备**

- 官方哔哩哔哩 macOS 客户端，放在“应用程序”文件夹里（`/Applications` 或 `~/Applications`）
- 命令行开发者工具（提供 `git` 和 `python3`）。没装过的话，第一次运行 `git` 时系统会弹窗提示安装，也可以先运行 `xcode-select --install`
- 给“终端”打开 **系统设置 → 隐私与安全性 → App 管理** 权限，然后重开终端。安装、更新、卸载都要修改客户端，客户端里的更新和卸载按钮也是交给系统自带的“终端”来完成的

**安装**

1. **完全退出客户端**（⌘Q）
2. 在“终端”里运行下面两行（第一次安装和以后手动更新都用它们）：

   ```bash
   [ -d ~/btr-mac ] || git clone https://github.com/luitao666-arch/Bilibili-thread-ripper-mac.git ~/btr-mac
   bash ~/btr-mac/install-mac.sh
   ```

3. **从程序坞或启动台**打开客户端，在 **设置 → 线程撕裂者** 里调整

脚本每次都会先拉取本仓库和 BTR Desktop 的最新代码再安装，内容可以直接查看 [install-mac.sh](install-mac.sh)。第一次安装会把官方客户端备份到 `~/Library/Application Support/BTR-Mac/backup/`（约 400 MB），卸载时用它还原。

> [!TIP]
> 客户端没装在“应用程序”文件夹也没关系：脚本会用 Spotlight 找；还找不到的话，用 `BTR_APP=/path/to/哔哩哔哩.app bash ~/btr-mac/install-mac.sh` 指定。

> [!IMPORTANT]
> 装着 BTR 的时候请保留 `~/btr-mac`：客户端里的更新和卸载按钮会用到里面的脚本。

## ⚙️ 设置

设置界面和原版完全相同，有两个入口，两边的设置同步：

| 入口 | 可以调整 |
| --- | --- |
| **设置** 第一项“线程撕裂者” | CDN、线程数、错误提示和 Debug，以及检查更新、卸载 |
| 播放器 **齿轮 → 更多播放设置** | CDN 和线程数 |

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| CDN 模式 | 大陆 CDN | 也可以选海外或自定义 |
| 线程数 | 8 | 一般推荐 8 到 32，不够流畅再往上加 |
| 显示错误 | 关 | 红色错误提示默认不显示，需要排查时打开 |

自定义 CDN、坏节点自动停用等功能的说明请看 [原项目的设置说明](https://github.com/MrTangLuyao/Bilibili-thread-ripper-desktop#️-设置)。

想确认 BTR 在工作：在 **设置 → 线程撕裂者** 打开 Debug，播放视频时会出现“已收到客户端播放地址”等提示。

## 🔄 更新

在 **设置 → 线程撕裂者** 点 **检查 BTR 更新**。它同时检查原仓库的 BTR 新版本和本仓库的 macOS 移植新版本，有更新时点 **更新到 …** 并确认：会先打开“终端”，然后客户端自动关闭，终端里完成更新后重新打开客户端；失败时终端窗口停留并显示错误。

也可以 ⌘Q 退出客户端后在终端更新：

```bash
bash ~/btr-mac/install-mac.sh update
```

更新会保留客户端的设置和热更新状态，不会清空账号和官方客户端数据。

### 官方客户端更新以后

官方客户端平时的热更新不会去掉 BTR。如果重新下载官方安装包覆盖安装，BTR 会被覆盖，⌘Q 退出客户端后再运行一次安装命令即可（macOS 版没有原版那样的后台监视提醒）。

## 🧹 卸载

在 **设置 → 线程撕裂者** 点红色的 **卸载 BTR** 并确认，或者 ⌘Q 退出客户端后在终端运行：

```bash
bash ~/btr-mac/install-mac.sh uninstall
```

卸载会用安装前的完整备份恢复官方客户端（包括苹果原签名），不删除账号、缓存和个人设置，然后清理 BTR 留下的东西：

- `~/Library/Application Support/BTR-Mac` 里的备份、BTR 源码和日志
- 客户端缓存（`~/Library/Application Support/bilibili/resource`）里带 BTR 的客户端副本，换回官方版本

卸载只删除 BTR 自己创建的文件：删除前会确认客户端确实是哔哩哔哩、数据目录确实是 BTR 的，不会动到别的应用和你自己的文件。安装脚本所在的 `~/btr-mac` 不会自动删除，不再需要的话自己删除即可：

```bash
rm -rf ~/btr-mac
```

## ❓ 常见问题

**设置里没有“线程撕裂者”**

先确认 BTR 装上了：`bash ~/btr-mac/install-mac.sh status` 里 `installed` 不是 `null`。装上了还看不到，通常是客户端正在运行安装包自带的旧界面，还没装上官方热更新（BTR 的设置页需要新界面）。在客户端 **设置 → 关于哔哩哔哩** 里点 **检查更新**，或者重新打开几次客户端，等它提示“重启升级”后升级即可。

**更新后设置被恢复默认，或者提示“重启升级”后卡住**

旧版本（2026.10.11.8 之前）的安装脚本有这个问题。卡住时强制退出（⌥⌘Esc），从程序坞重新打开；然后 ⌘Q 退出客户端，在终端运行一次 `bash ~/btr-mac/install-mac.sh update` 更新到最新版。之后在客户端里更新就不会再这样。

**客户端里点了更新，但客户端一直没有重新打开**

2026.10.11.4 之前的版本有这个问题，请按上一条在终端里更新一次。新版本会弹出“终端”窗口显示进度；失败时窗口会停留并显示错误，日志在 `~/Library/Application Support/BTR-Mac/maintain.log`。

**提示没有权限修改客户端**

打开 **系统设置 → 隐私与安全性 → App 管理**，允许“终端”（以及你正在用的其他终端），然后重开终端再运行。

## 🆚 和 Windows 版的区别

| | Windows 版（原版） | macOS 版（本仓库） |
| --- | --- | --- |
| 安装 | PowerShell 一行命令 | 终端两行命令（`git clone` + 安装脚本） |
| 客户端内更新 / 卸载 | 独立的更新、卸载窗口 | 在“终端”里运行安装脚本，完成后重新打开客户端 |
| 官方覆盖安装后的提醒 | 后台监视程序弹窗 | 没有，需要手动再运行一次安装 |
| 签名 | 不涉及 | 改用本地签名（ad-hoc） |

## ⚠️ 注意事项

- 本地签名后，macOS 不再认为这是哔哩哔哩官方签名的应用。备份里保留了原版，随时可以还原。
- 官方客户端会根据 `Resources/app-update.yml` 判断自己是否被重新安装，判断为重装就会恢复默认设置并重新下载热更新。安装、更新和卸载时脚本会同步这条记录（`~/Library/Application Support/bilibili/resource/.appInfo`），避免设置被重置。
- 欢迎在 Issues 里补充其他 macOS / 客户端版本的测试结果（`bash ~/btr-mac/install-mac.sh status` 可以看到客户端和 BTR 的版本）。

## 📄 致谢与许可

- BTR 下载内核与界面：[MrTangLuyao/Bilibili-thread-ripper-desktop](https://github.com/MrTangLuyao/Bilibili-thread-ripper-desktop)，作者 LouieTang，MIT 许可证；图标同样来自原项目
- `btr_mac.py` 的 ASAR 读写和注入方式移植自原仓库的 `tools/asar.cjs` 与 `tools/client-package.cjs`

本仓库同样以 [MIT 开源协议](LICENSE) 发布。
