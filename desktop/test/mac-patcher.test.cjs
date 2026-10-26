"use strict";
// btr_mac.py rewrites every user's app.asar, and users install the committed desktop/dist:
// both are checked here.
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), { execFileSync } = require("node:child_process");
const repo = path.resolve(__dirname, "../..");

// The ASAR layout btr_mac.py reads: two pickle size fields, the JSON header, then the file bodies.
function makeAsar(files) {
  const header = { files: {} }, bodies = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const body = Buffer.from(text);
    header.files[name] = { size: body.length, offset: String(offset) };
    bodies.push(body); offset += body.length;
  }
  const raw = Buffer.from(JSON.stringify(header)), padded = Math.ceil((raw.length + 4) / 4) * 4;
  const prefix = Buffer.alloc(16 + padded - 4);
  prefix.writeUInt32LE(4, 0); prefix.writeUInt32LE(padded + 4, 4); prefix.writeUInt32LE(padded, 8); prefix.writeUInt32LE(raw.length, 12);
  raw.copy(prefix, 16);
  return Buffer.concat([prefix, ...bodies]);
}
function readAsar(data) {
  const base = 8 + data.readUInt32LE(4), header = JSON.parse(data.subarray(16, 16 + data.readUInt32LE(12)));
  const entry = name => name.split("/").reduce((node, key) => node?.files?.[key], header);
  const read = name => { const e = entry(name); return e && data.subarray(base + Number(e.offset), base + Number(e.offset) + e.size).toString("utf8"); };
  return { entry, read };
}
const patcher = (...args) => execFileSync("python3", ["-I", path.join(repo, "btr_mac.py"), ...args], { encoding: "utf8" });

test("btr_mac.py patches a client app.asar: entry after use strict, files kept, preload carries the bundle", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "btr-patch-"));
  const index = '"use strict";\nrequire("./main");\n';
  fs.writeFileSync(path.join(dir, "app.asar"), makeAsar({ "package.json": JSON.stringify({ name: "bilibili", version: "1.17.3", main: "index.js" }), "index.js": index, "main.js": "module.exports = 1;\n" }));
  const result = JSON.parse(patcher("patch", path.join(dir, "app.asar"), path.join(repo, "desktop/dist/desktop.js"), path.join(dir, "out.asar"), repo));
  assert.equal(result.macVersion, JSON.parse(fs.readFileSync(path.join(repo, "mac-version.json"))).version);

  const out = readAsar(fs.readFileSync(path.join(dir, "out.asar")));
  const lines = out.read("index.js").split("\n");
  assert.equal(lines[0], '"use strict";');
  assert.match(lines[1], /^try\{require\("\.\/btr-desktop\/bootstrap\.cjs"\)\}/);
  assert.equal(lines.slice(2).join("\n"), index.slice('"use strict";\n'.length));
  assert.equal(out.read("main.js"), "module.exports = 1;\n");
  for (const name of ["bootstrap.cjs", "maintain.cjs"]) assert.equal(out.read(`btr-desktop/${name}`), fs.readFileSync(path.join(repo, "payload", name), "utf8"));
  assert.equal(out.read("btr-desktop/live.js"), fs.readFileSync(path.join(repo, "desktop/dist/live.js"), "utf8"));
  const preload = out.read("btr-desktop/preload.cjs");
  assert.equal(JSON.parse(preload.match(/^const code = (.*);$/m)[1]), fs.readFileSync(path.join(repo, "desktop/dist/desktop.js"), "utf8"));
  assert.ok(!preload.includes("__BTR_BUNDLE__") && !preload.includes("__BTR_MAC_INFO__"));
  assert.equal(out.entry("btr-desktop/desktop.js"), undefined);

  assert.ok(JSON.parse(patcher("status", path.join(dir, "out.asar"))).installed);
  assert.throws(() => execFileSync("python3", ["-I", path.join(repo, "btr_mac.py"), "patch", path.join(dir, "out.asar"), path.join(repo, "desktop/dist/desktop.js"), path.join(dir, "again.asar"), repo], { stdio: "pipe" }));
  fs.rmSync(dir, { recursive: true });
});

test("desktop/dist is what tools/build.cjs makes from the sources", () => {
  const { outputs } = require("../tools/build.cjs").build();
  for (const [name, text] of Object.entries(outputs))
    assert.equal(fs.readFileSync(path.join(__dirname, "../dist", name), "utf8"), text, `dist/${name} is out of date: run node desktop/tools/build.cjs`);
});
