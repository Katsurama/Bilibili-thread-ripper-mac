# 项目约定

- 改动了会装进客户端的东西（`install-mac.sh`、`btr_mac.py`、`payload/`、`desktop/`）时，在同一次改动里把 `mac-version.json` 的 `version` 升一级。客户端读 main 分支上的这个文件来判断有没有更新，版本号不变，用户就收不到这次修改。
  - 格式是 `年.月.日.序号`（例如 `2026.10.11.16`），必须比当前的大：同一天就把序号加一，换了一天就换成当天日期。
  - 只改 README、截图等文档时不用升版本号。
- 改了 `desktop/src/` 或 `desktop/shared/` 后运行 `node desktop/tools/build.cjs`，把 `desktop/dist/` 一起提交：用户装的是 `dist/` 里的文件。测试会检查 `dist/` 是不是最新的。
