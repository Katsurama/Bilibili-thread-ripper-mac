# BTR Desktop for macOS（非官方移植）

把 [Bilibili 线程撕裂者桌面版](https://github.com/MrTangLuyao/Bilibili-thread-ripper-desktop) 装进 **macOS 官方哔哩哔哩客户端**。

> [!WARNING]
> 这是社区做的**非官方**移植原型，不是原作者发布的版本。原作者明确表示不会做 macOS 版，请不要把这里的问题报到原仓库。

## 它做了什么

原版只支持 Windows。macOS 的官方客户端同样是 Electron 应用，结构和 Windows 版基本一致，所以可以用同样的方式接入：

- 安装时从原仓库下载 BTR Desktop 的 `dist/desktop.js`（下载内核和设置界面），**这里不包含也不修改原作者的代码**
- 在客户端的 `app.asar` 里加一个普通的 Electron preload，把 BTR 注入播放页面，播放器、字幕、弹幕都保持客户端原样
- 修改后用本地签名（ad-hoc）重新签名客户端
- 安装前把整个官方客户端完整备份一份，可以一键还原

只用系统自带的 `python3`、`git` 和 `codesign`，不需要安装 Node.js。

## 安装

1. 安装官方哔哩哔哩 macOS 客户端，放在“应用程序”文件夹里
2. **完全退出客户端**（⌘Q）
3. 在终端运行：

   ```bash
   git clone https://github.com/luitao666-arch/Bilibili-thread-ripper-mac.git ~/btr-mac
   bash ~/btr-mac/install-mac.sh
   ```

4. 打开客户端，在 **设置 → 线程撕裂者** 里调整 CDN 和线程数

> [!TIP]
> 如果提示没有权限修改客户端：打开 **系统设置 → 隐私与安全性 → App 管理**，允许你正在用的终端，然后重开终端再运行。

第一次安装会把官方客户端备份到 `~/Library/Application Support/BTR-Mac/backup/`（约 400 MB）。

## 更新

BTR 有新版本，或者官方客户端更新后 BTR 不见了，都重新运行一次：

```bash
git -C ~/btr-mac pull
bash ~/btr-mac/install-mac.sh
```

## 还原

```bash
bash ~/btr-mac/install-mac.sh uninstall
```

用安装前的完整备份恢复官方客户端（包括苹果原签名），账号和设置不受影响。还原后备份仍保留，可以手动删除 `~/Library/Application Support/BTR-Mac`。

查看当前状态：

```bash
bash ~/btr-mac/install-mac.sh status
```

## 和 Windows 版的区别

| | Windows 版（原版） | macOS 版（本仓库） |
|---|---|---|
| 安装 | PowerShell 一行命令 | `git clone` + shell 脚本 |
| 客户端内更新 / 卸载按钮 | 支持 | 不支持，按钮会提示到终端运行脚本 |
| 官方覆盖安装后的守护提醒 | 支持 | 不支持，需要手动重新运行安装 |
| 签名 | 不涉及 | 改用本地签名 |

## 已测试

| macOS | 客户端 | BTR Desktop | 结果 |
|---|---|---|---|
| macOS 27.2（Apple M4） | 1.17.3 | 2026.10.7.2-d1 | 设置页正常，视频可以播放；Debug 显示“已收到客户端播放地址”，BTR 已接入播放器 |

想确认 BTR 是否在工作：在 **设置 → 线程撕裂者** 打开 Debug，播放视频时会出现“已收到客户端播放地址”等提示。

欢迎在 Issues 里补充其他版本的测试结果。

## 注意事项

- 本地签名后，macOS 不再认为这是哔哩哔哩官方签名的应用。备份里保留了原版，随时可以还原。
- 需要授予终端“App 管理”权限才能修改 `/Applications` 里的应用。
- 官方客户端自动更新可能覆盖掉 BTR，重新运行安装脚本即可。

## 致谢与许可

- BTR 下载内核与界面：[MrTangLuyao/Bilibili-thread-ripper-desktop](https://github.com/MrTangLuyao/Bilibili-thread-ripper-desktop)，作者 LouieTang，MIT 许可证
- `btr_mac.py` 的 ASAR 读写和注入方式移植自原仓库的 `tools/asar.cjs` 与 `tools/client-package.cjs`

本仓库同样以 [MIT 许可证](LICENSE) 发布。
