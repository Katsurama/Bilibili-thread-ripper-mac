"use strict";
const fs = require("node:fs"), path = require("node:path");
const { sha } = require("./asar.cjs");
const root = path.resolve(__dirname, "..");
const shared = ["range-core.js", "live-core.js", "cdn-resolver.js", "idm-downloader.js", "runtime-notices.js", "notification-view.js"];
const own = ["settings.js", "transport.js", "client.js", "updates.js", "settings-view.js", "player-settings.js"];
// The live hook reads __BTR_DESKTOP__, which settings.js creates. Keep it after settings
// initialization while retaining the shared modules it depends on before it.
const files = [
  ...shared.map(x => `shared/${x}`),
  "src/settings.js",
  "shared/live-hook.js",
  ...own.slice(1).map(x => `src/${x}`)
];
const config = JSON.parse(fs.readFileSync(path.join(root, "desktop.json")));
if (config.version !== `${config.baseVersion}-d${config.adapterRevision}`) throw Error("Version must equal baseVersion + -d + adapterRevision");
const prefix = `globalThis.__BTR_DESKTOP_RELEASE__=${JSON.stringify({ version: config.version, adapterRevision: config.adapterRevision })};\n`;
const bundle = prefix + files.map(file => `\n/* ${file} */\n${fs.readFileSync(path.join(root, file), "utf8")}\n`).join("");
fs.mkdirSync(path.join(root, "dist"), { recursive: true });
fs.writeFileSync(path.join(root, "dist", "desktop.js"), bundle);
fs.writeFileSync(path.join(root, "dist", "payload.json"), JSON.stringify({ version: config.version, adapterRevision: config.adapterRevision, sha256: sha(bundle), files: Object.fromEntries(files.map(file => [file, sha(fs.readFileSync(path.join(root, file)))])) }, null, 2));
console.log(`Built BTR Desktop ${config.version}, adapter ${config.adapterRevision}, ${Buffer.byteLength(bundle)} bytes`);
