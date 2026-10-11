#!/usr/bin/env python3
"""BTR Desktop macOS patcher.

Adds the BTR Desktop bundle (dist/desktop.js from the Windows repo) to the official
哔哩哔哩.app through an ordinary Electron preload, the same way the Windows build does.
Only the standard library is used, so the system python3 (3.9+) is enough.

  btr_mac.py patch  <original app.asar> <desktop.js> <output app.asar> <install root>
  btr_mac.py status <app.asar>
  btr_mac.py header-hash <app.asar>
"""
import hashlib
import json
import os
import re
import struct
import sys

BOOTSTRAP_FILE = "btr-desktop/bootstrap.cjs"
PRELOAD_FILE = "btr-desktop/preload.cjs"
MAINTAIN_FILE = "btr-desktop/maintain.cjs"
BUNDLE_FILE = "btr-desktop/desktop.js"
INSTALLED_FILE = "btr-desktop/installed.json"
PAYLOAD_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "payload")


def sha(data):
    return hashlib.sha256(data).hexdigest()


class Asar:
    def __init__(self, data):
        if len(data) < 16 or struct.unpack_from("<I", data, 0)[0] != 4:
            raise ValueError("Invalid ASAR header")
        self.data = data
        self.base = 8 + struct.unpack_from("<I", data, 4)[0]
        size = struct.unpack_from("<I", data, 12)[0]
        self.header_bytes = data[16:16 + size]
        self.header = json.loads(self.header_bytes.decode("utf-8"))
        self.edits = {}

    def entry(self, name):
        node = self.header
        for key in name.split("/"):
            node = (node or {}).get("files", {}).get(key)
            if node is None:
                return None
        return node

    def read(self, name):
        if name in self.edits:
            return self.edits[name]
        entry = self.entry(name)
        if not entry or "files" in entry or entry.get("unpacked") or entry.get("link"):
            raise ValueError("Not an embedded file: " + name)
        offset, size = int(entry["offset"]), int(entry["size"])
        if self.base + offset + size > len(self.data):
            raise ValueError("Invalid ASAR file bounds")
        return self.data[self.base + offset:self.base + offset + size]

    def text(self, name):
        return self.read(name).decode("utf-8")

    def set(self, name, data):
        if isinstance(data, str):
            data = data.encode("utf-8")
        self.edits[name] = data

    def pack(self):
        header = json.loads(json.dumps(self.header))
        for name in self.edits:
            keys = name.split("/")
            node = header
            for key in keys[:-1]:
                node = node.setdefault("files", {}).setdefault(key, {"files": {}})
                if "files" not in node:
                    raise ValueError("ASAR file/directory conflict")
            node.setdefault("files", {})[keys[-1]] = {"size": 0, "offset": "0"}
        bodies, offset = [], 0

        def walk(node, prefix):
            nonlocal offset
            for name, entry in node.get("files", {}).items():
                full = prefix + "/" + name if prefix else name
                if "files" in entry:
                    walk(entry, full)
                elif not entry.get("unpacked") and not entry.get("link"):
                    body = self.read(full)
                    entry["offset"], entry["size"] = str(offset), len(body)
                    if "integrity" in entry or full in self.edits:
                        block = entry.get("integrity", {}).get("blockSize", 4 * 1024 * 1024)
                        blocks = [sha(body[i:i + block]) for i in range(0, len(body), block)]
                        entry["integrity"] = {"algorithm": "SHA256", "hash": sha(body), "blockSize": block, "blocks": blocks}
                    bodies.append(body)
                    offset += len(body)

        walk(header, "")
        raw = json.dumps(header, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        padded = (len(raw) + 4 + 3) // 4 * 4
        prefix = struct.pack("<IIII", 4, padded + 4, padded, len(raw)) + raw + b"\0" * (padded - 4 - len(raw))
        return prefix + b"".join(bodies)


def inspect(archive):
    app = json.loads(archive.text("package.json"))
    if app.get("name") != "bilibili":
        raise ValueError("目标不是官方 Bilibili 客户端")
    main = (app.get("main") or "index.js").strip()
    if main.startswith("./"):
        main = main[2:]
    entry = None
    for name in (main, main + ".js", main + "/index.js"):
        node = archive.entry(name)
        if name.endswith((".js", ".cjs")) and node and "files" not in node and not node.get("unpacked") and not node.get("link"):
            entry = name
            break
    installed = json.loads(archive.text(INSTALLED_FILE)) if archive.entry(INSTALLED_FILE) else None
    return {"clientVersion": str(app.get("version", "unknown")), "entry": entry, "installed": installed}


def bootstrap_prefix(entry):
    depth = entry.count("/")
    rel = "../" * depth + BOOTSTRAP_FILE if depth else "./" + BOOTSTRAP_FILE
    return 'try{require(%s)}catch(error){console.error("BTR bootstrap:",error&&error.message)}\n' % json.dumps(rel)


def with_bootstrap(entry, text):
    import re
    head = re.match(r'^﻿?(?:\s*(["\'])use strict\1[ \t]*;?[ \t]*(?:\r?\n)?)?', text).group(0)
    return head + bootstrap_prefix(entry) + text[len(head):]


def payload(name):
    with open(os.path.join(PAYLOAD_DIR, name), encoding="utf-8") as file:
        return file.read()


def mac_version(install_root):
    """Version of this macOS port from mac-version.json, recorded so the client can offer updates."""
    try:
        with open(os.path.join(install_root, "mac-version.json"), encoding="utf-8") as file:
            value = json.load(file)
    except (OSError, ValueError):
        return None
    version = value.get("version") if isinstance(value, dict) and value.get("schema") == 1 else None
    return version if isinstance(version, str) and re.fullmatch(r"\d+\.\d+\.\d+\.\d+", version) else None


def bundle_version(bundle):
    match = re.match(r"globalThis\.__BTR_DESKTOP_RELEASE__=(\{.*?\});", bundle.decode("utf-8"))
    return json.loads(match.group(1)).get("version") if match else None


def patch(original_path, bundle_path, output_path, install_root):
    original = open(original_path, "rb").read()
    bundle = open(bundle_path, "rb").read()
    archive = Asar(original)
    info = inspect(archive)
    if info["installed"]:
        raise ValueError("只能在原始 app.asar 上打补丁")
    if not info["entry"]:
        raise ValueError("无法识别客户端 %s 的入口结构，没有修改官方文件" % info["clientVersion"])
    entry_text = archive.text(info["entry"])
    if BOOTSTRAP_FILE in entry_text:
        raise ValueError("客户端已经包含 BTR 入口")
    archive.set(info["entry"], with_bootstrap(info["entry"], entry_text))
    preload = payload("preload.cjs")
    if "__BTR_BUNDLE__" not in preload:
        raise ValueError("preload.cjs 缺少注入位置")
    archive.set(BOOTSTRAP_FILE, payload("bootstrap.cjs"))
    archive.set(MAINTAIN_FILE, payload("maintain.cjs"))
    archive.set(PRELOAD_FILE, preload.replace("__BTR_BUNDLE__", json.dumps(bundle.decode("utf-8"))))
    archive.set(BUNDLE_FILE, bundle)
    archive.set(INSTALLED_FILE, json.dumps({"schema": 1, "platform": "darwin", "version": bundle_version(bundle), "macVersion": mac_version(install_root), "clientVersion": info["clientVersion"], "originalSha256": sha(original), "payloadSha256": sha(bundle), "installRoot": os.path.abspath(install_root)}, ensure_ascii=False))
    patched = archive.pack()
    verify = Asar(patched)
    if sha(verify.read(BUNDLE_FILE)) != sha(bundle) or BOOTSTRAP_FILE not in verify.text(info["entry"]):
        raise ValueError("补丁自检失败")
    for name in archive.header.get("files", {}):
        if verify.entry(name) is None:
            raise ValueError("补丁自检失败：丢失 " + name)
    with open(output_path, "wb") as out:
        out.write(patched)
    return {"state": "patched", "version": bundle_version(bundle), "macVersion": mac_version(install_root), "clientVersion": info["clientVersion"], "entry": info["entry"], "headerHash": sha(verify.header_bytes)}


def main(argv):
    action = argv[1] if len(argv) > 1 else ""
    if action == "patch" and len(argv) == 6:
        result = patch(argv[2], argv[3], argv[4], argv[5])
    elif action == "status" and len(argv) == 3:
        archive = Asar(open(argv[2], "rb").read())
        result = inspect(archive)
    elif action == "header-hash" and len(argv) == 3:
        print(sha(Asar(open(argv[2], "rb").read()).header_bytes))
        return 0
    else:
        print(__doc__, file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except Exception as error:  # noqa: BLE001 - report as one line to the shell script
        print("错误：%s" % error, file=sys.stderr)
        sys.exit(1)
