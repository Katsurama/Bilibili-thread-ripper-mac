"use strict";
const fs = require("node:fs"), path = require("node:path");
const { sha } = require("./asar.cjs");
const root = path.resolve(__dirname, "..");
const shared = ["range-core.js", "cdn-resolver.js", "idm-downloader.js", "runtime-notices.js", "notification-view.js"];
const own = ["settings.js", "transport.js", "client.js", "updates.js", "settings-view.js", "player-settings.js"];
const files = [...shared.map(x => `shared/${x}`), ...own.map(x => `src/${x}`)];
// The live player runs in live.bilibili.com frames, apart from the client pages: bootstrap.cjs
// puts this second bundle into them. live-core.js and live-hook.js are the browser version's.
const liveFiles = ["shared/range-core.js", "shared/live-core.js", "shared/live-hook.js", "src/live-ui.js"];
const config = JSON.parse(fs.readFileSync(path.join(root, "desktop.json")));
if (config.version !== `${config.baseVersion}-d${config.adapterRevision}`) throw Error("Version must equal baseVersion + -d + adapterRevision");
const prefix = `globalThis.__BTR_DESKTOP_RELEASE__=${JSON.stringify({ version: config.version, adapterRevision: config.adapterRevision })};\n`;
const join = list => list.map(file => `\n/* ${file} */\n${fs.readFileSync(path.join(root, file), "utf8")}\n`).join("");
const bundle = prefix + join(files);
// A frame can be offered the live bundle more than once (dom-ready, then a reload of the same
// document); only the first run counts.
const live = `(function () {\nif (globalThis.__BTR_LIVE_BUNDLE__) return;\nObject.defineProperty(globalThis, "__BTR_LIVE_BUNDLE__", { value: ${JSON.stringify(config.version)} });\n${join(liveFiles).split("__BTR_VERSION__").join(config.version)}\n})();\n`;
fs.mkdirSync(path.join(root, "dist"), { recursive: true });
fs.writeFileSync(path.join(root, "dist", "desktop.js"), bundle);
fs.writeFileSync(path.join(root, "dist", "live.js"), live);
const hashes = list => Object.fromEntries(list.map(file => [file, sha(fs.readFileSync(path.join(root, file)))]));
fs.writeFileSync(path.join(root, "dist", "payload.json"), JSON.stringify({ version: config.version, adapterRevision: config.adapterRevision, sha256: sha(bundle), files: hashes(files), liveSha256: sha(live), liveFiles: hashes(liveFiles) }, null, 2));
console.log(`Built BTR Desktop ${config.version}, adapter ${config.adapterRevision}, ${Buffer.byteLength(bundle)} bytes; live ${Buffer.byteLength(live)} bytes`);
