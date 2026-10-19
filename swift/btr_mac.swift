// BTR Desktop macOS patcher, Swift port of btr_mac.py.
//
//   btr_mac patch  <original app.asar> <desktop.js> <output app.asar> <install root>
//   btr_mac status <app.asar>
//   btr_mac header-hash <app.asar>
//
// Only Foundation and CryptoKit are used, so the Xcode command line tools are enough:
//   swiftc -O swift/btr_mac.swift -o btr_mac
// The payload files are read from <install root>/payload, the same directory btr_mac.py uses.

import CryptoKit
import Foundation

let bootstrapFile = "btr-desktop/bootstrap.cjs"
let preloadFile = "btr-desktop/preload.cjs"
let maintainFile = "btr-desktop/maintain.cjs"
let bundleFile = "btr-desktop/desktop.js"
let installedFile = "btr-desktop/installed.json"
let defaultBlockSize = 4 * 1024 * 1024

struct Failure: Error {
    let message: String
}

func sha(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

func readUInt32(_ data: Data, at offset: Int) -> Int {
    data.withUnsafeBytes { bytes in
        Int(UInt32(littleEndian: bytes.loadUnaligned(fromByteOffset: offset, as: UInt32.self)))
    }
}

func littleEndian(_ value: Int) -> Data {
    withUnsafeBytes(of: UInt32(value).littleEndian) { Data($0) }
}

func intValue(_ value: Any?) -> Int? {
    if let text = value as? String {
        return Int(text)
    }
    return (value as? NSNumber)?.intValue
}

// Strict UTF-8 decoding that keeps a leading BOM (String(data:encoding:) may drop it on Apple platforms).
func decodeUTF8(_ data: Data) -> String? {
    let text = String(decoding: data, as: UTF8.self)
    return Data(text.utf8) == data ? text : nil
}

func flag(_ value: Any?) -> Bool {
    (value as? Bool) ?? false
}

func orNull(_ value: Any?) -> Any {
    value ?? NSNull()
}

func parseObject(_ data: Data) throws -> [String: Any] {
    guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        throw Failure(message: "JSON 不是对象")
    }
    return object
}

func jsonText(_ object: Any) throws -> String {
    let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes])
    return String(decoding: data, as: UTF8.self)
}

// A JSON string literal, for embedding text in JavaScript source.
func jsonString(_ text: String) throws -> String {
    let data = try JSONSerialization.data(withJSONObject: [text], options: [.withoutEscapingSlashes])
    return String(String(decoding: data, as: UTF8.self).dropFirst().dropLast())
}

func integrity(_ body: Data, blockSize: Int) -> [String: Any] {
    let blocks = stride(from: 0, to: body.count, by: blockSize).map { start in
        sha(Data(body[start..<min(start + blockSize, body.count)]))
    }
    return ["algorithm": "SHA256", "hash": sha(body), "blockSize": blockSize, "blocks": blocks]
}

// Reader and writer for the asar archive format (header JSON followed by file bodies).
final class Asar {
    let data: Data
    let base: Int
    let headerBytes: Data
    var header: [String: Any]
    var edits: [String: Data] = [:]

    init(_ data: Data) throws {
        guard data.count >= 16, readUInt32(data, at: 0) == 4 else {
            throw Failure(message: "Invalid ASAR header")
        }
        let size = readUInt32(data, at: 12)
        guard 16 + size <= data.count else {
            throw Failure(message: "Invalid ASAR header")
        }
        self.data = data
        base = 8 + readUInt32(data, at: 4)
        headerBytes = Data(data[16..<(16 + size)])
        header = try parseObject(headerBytes)
    }

    func entry(_ name: String) -> [String: Any]? {
        var node = header
        for key in name.components(separatedBy: "/") {
            let files = node["files"] as? [String: Any]
            guard let child = files?[key] as? [String: Any] else {
                return nil
            }
            node = child
        }
        return node
    }

    func read(_ name: String) throws -> Data {
        if let edited = edits[name] {
            return edited
        }
        guard let node = entry(name), node["files"] == nil, !flag(node["unpacked"]), node["link"] == nil,
              let offset = intValue(node["offset"]), let size = intValue(node["size"]),
              base + offset + size <= data.count else {
            throw Failure(message: "Not an embedded file: \(name)")
        }
        // Copy into a fresh Data so that indices start at zero.
        return Data(data[(base + offset)..<(base + offset + size)])
    }

    func text(_ name: String) throws -> String {
        guard let text = decodeUTF8(try read(name)) else {
            throw Failure(message: "\(name) 不是 UTF-8 文本")
        }
        return text
    }

    func set(_ name: String, _ body: Data) {
        edits[name] = Data(body)
    }

    func pack() throws -> Data {
        var header = self.header
        for name in edits.keys.sorted() {
            try insertPlaceholder(&header, keys: name.components(separatedBy: "/")[...])
        }
        var offset = 0
        var bodies: [Data] = []
        try layout(&header, prefix: "", offset: &offset, bodies: &bodies)

        let raw = try JSONSerialization.data(withJSONObject: header, options: [.withoutEscapingSlashes])
        let padded = (raw.count + 4 + 3) / 4 * 4
        var out = littleEndian(4) + littleEndian(padded + 4) + littleEndian(padded) + littleEndian(raw.count)
        out.append(raw)
        out.append(Data(repeating: 0, count: padded - 4 - raw.count))
        for body in bodies {
            out.append(body)
        }
        return out
    }

    private func insertPlaceholder(_ node: inout [String: Any], keys: ArraySlice<String>) throws {
        guard let key = keys.first else {
            return
        }
        var files = node["files"] as? [String: Any] ?? [:]
        if keys.count == 1 {
            let placeholder: [String: Any] = ["size": 0, "offset": "0"]
            files[key] = placeholder
        } else {
            var child = files[key] as? [String: Any] ?? ["files": [String: Any]()]
            guard child["files"] != nil else {
                throw Failure(message: "ASAR file/directory conflict")
            }
            try insertPlaceholder(&child, keys: keys.dropFirst())
            files[key] = child
        }
        node["files"] = files
    }

    // Assigns offsets to every embedded file and refreshes integrity for files that were edited
    // or already carried integrity data, as the Python version does.
    private func layout(_ node: inout [String: Any], prefix: String, offset: inout Int, bodies: inout [Data]) throws {
        var files = node["files"] as? [String: Any] ?? [:]
        for name in files.keys.sorted() {
            var entry = files[name] as? [String: Any] ?? [:]
            let full = prefix.isEmpty ? name : prefix + "/" + name
            if entry["files"] != nil {
                try layout(&entry, prefix: full, offset: &offset, bodies: &bodies)
            } else if !flag(entry["unpacked"]) && entry["link"] == nil {
                let body = try read(full)
                entry["offset"] = String(offset)
                entry["size"] = body.count
                if entry["integrity"] != nil || edits[full] != nil {
                    let blockSize = intValue((entry["integrity"] as? [String: Any])?["blockSize"]) ?? defaultBlockSize
                    entry["integrity"] = integrity(body, blockSize: blockSize)
                }
                bodies.append(body)
                offset += body.count
            }
            files[name] = entry
        }
        node["files"] = files
    }
}

func inspect(_ archive: Asar) throws -> [String: Any] {
    let app = try parseObject(try archive.read("package.json"))
    guard app["name"] as? String == "bilibili" else {
        throw Failure(message: "目标不是官方 Bilibili 客户端")
    }
    var main = (app["main"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    if main.isEmpty {
        main = "index.js"
    }
    if main.hasPrefix("./") {
        main = String(main.dropFirst(2))
    }
    var entry: String?
    for name in [main, main + ".js", main + "/index.js"] {
        guard name.hasSuffix(".js") || name.hasSuffix(".cjs") else {
            continue
        }
        if let node = archive.entry(name), node["files"] == nil, !flag(node["unpacked"]), node["link"] == nil {
            entry = name
            break
        }
    }
    var installed: Any = NSNull()
    if archive.entry(installedFile) != nil {
        installed = try parseObject(try archive.read(installedFile))
    }
    return [
        "clientVersion": String(describing: app["version"] ?? "unknown"),
        "entry": orNull(entry),
        "installed": installed,
    ]
}

func bootstrapPrefix(_ entry: String) -> String {
    let depth = entry.filter { $0 == "/" }.count
    let relative = depth > 0 ? String(repeating: "../", count: depth) + bootstrapFile : "./" + bootstrapFile
    return "try{require(\"\(relative)\")}catch(error){console.error(\"BTR bootstrap:\",error&&error.message)}\n"
}

// Inserts the bootstrap require after a leading BOM and "use strict" directive, if present.
func withBootstrap(_ entry: String, _ text: String) throws -> String {
    let source = text as NSString
    let pattern = try NSRegularExpression(pattern: "^\u{FEFF}?(?:\\s*([\"'])use strict\\1[ \\t]*;?[ \\t]*(?:\\r?\\n)?)?")
    let head = pattern.firstMatch(in: text, range: NSRange(location: 0, length: source.length))
        .map { source.substring(with: $0.range) } ?? ""
    return head + bootstrapPrefix(entry) + source.substring(from: (head as NSString).length)
}

// Reads a payload file the way Python's text mode does: newlines become "\n".
func payload(_ name: String, installRoot: String) throws -> String {
    let text = try String(contentsOfFile: installRoot + "/payload/" + name, encoding: .utf8)
    return text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
}

func macVersion(_ installRoot: String) -> String? {
    guard let value = try? parseObject(Data(contentsOf: URL(fileURLWithPath: installRoot + "/mac-version.json"))),
          (value["schema"] as? NSNumber)?.intValue == 1,
          let version = value["version"] as? String,
          version.range(of: "\\A\\d+\\.\\d+\\.\\d+\\.\\d+\\z", options: .regularExpression) != nil else {
        return nil
    }
    return version
}

// LICENSE of the BTR Desktop checkout the bundle comes from (dist/desktop.js -> LICENSE).
func upstreamLicense(_ bundlePath: String) -> String? {
    let root = URL(fileURLWithPath: bundlePath).deletingLastPathComponent().deletingLastPathComponent()
    guard let text = try? String(contentsOf: root.appendingPathComponent("LICENSE"), encoding: .utf8) else {
        return nil
    }
    return text.trimmingCharacters(in: .whitespacesAndNewlines)
}

func bundleVersion(_ bundle: Data) throws -> String? {
    guard let text = decodeUTF8(bundle) else {
        throw Failure(message: "BTR 包不是 UTF-8 文本")
    }
    let source = text as NSString
    let pattern = try NSRegularExpression(pattern: "^globalThis\\.__BTR_DESKTOP_RELEASE__=(\\{.*?\\});")
    guard let match = pattern.firstMatch(in: text, range: NSRange(location: 0, length: source.length)) else {
        return nil
    }
    let release = try parseObject(Data(source.substring(with: match.range(at: 1)).utf8))
    return release["version"] as? String
}

func occurrences(of needle: String, in text: String) -> Int {
    text.components(separatedBy: needle).count - 1
}

func patch(originalPath: String, bundlePath: String, outputPath: String, installRoot: String) throws -> [String: Any] {
    let original = try Data(contentsOf: URL(fileURLWithPath: originalPath))
    let bundle = try Data(contentsOf: URL(fileURLWithPath: bundlePath))
    let archive = try Asar(original)
    let info = try inspect(archive)
    if let installed = info["installed"] as? [String: Any], !installed.isEmpty {
        throw Failure(message: "只能在原始 app.asar 上打补丁")
    }
    let clientVersion = info["clientVersion"] as? String ?? "unknown"
    guard let entryName = info["entry"] as? String else {
        throw Failure(message: "无法识别客户端 \(clientVersion) 的入口结构，没有修改官方文件")
    }
    let entryText = try archive.text(entryName)
    if entryText.contains(bootstrapFile) {
        throw Failure(message: "客户端已经包含 BTR 入口")
    }
    archive.set(entryName, Data(try withBootstrap(entryName, entryText).utf8))

    guard let bundleText = decodeUTF8(bundle) else {
        throw Failure(message: "BTR 包不是 UTF-8 文本")
    }
    let preload = try payload("preload.cjs", installRoot: installRoot)
    guard occurrences(of: "__BTR_BUNDLE__", in: preload) == 1,
          occurrences(of: "__BTR_MAC_INFO__", in: preload) == 1 else {
        throw Failure(message: "preload.cjs 的注入位置不对")
    }
    let btrVersion = try bundleVersion(bundle)
    let macVersionValue = macVersion(installRoot)
    let macInfo = try jsonText([
        "macVersion": orNull(macVersionValue),
        "btrVersion": orNull(btrVersion),
        "license": orNull(upstreamLicense(bundlePath)),
    ])
    let bundleLiteral = try jsonString(bundleText)
    let injectedPreload = preload
        .replacingOccurrences(of: "__BTR_MAC_INFO__", with: macInfo)
        .replacingOccurrences(of: "__BTR_BUNDLE__", with: bundleLiteral)

    archive.set(bootstrapFile, Data(try payload("bootstrap.cjs", installRoot: installRoot).utf8))
    archive.set(maintainFile, Data(try payload("maintain.cjs", installRoot: installRoot).utf8))
    archive.set(preloadFile, Data(injectedPreload.utf8))
    archive.set(bundleFile, bundle)
    let installedInfo: [String: Any] = [
        "schema": 1,
        "platform": "darwin",
        "version": orNull(btrVersion),
        "macVersion": orNull(macVersionValue),
        "clientVersion": clientVersion,
        "originalSha256": sha(original),
        "payloadSha256": sha(bundle),
        "installRoot": URL(fileURLWithPath: installRoot).standardizedFileURL.path,
    ]
    archive.set(installedFile, Data(try jsonText(installedInfo).utf8))

    let patched = try archive.pack()
    let verify = try Asar(patched)
    let verifiedBundle = try verify.read(bundleFile)
    let verifiedEntry = try verify.text(entryName)
    guard sha(verifiedBundle) == sha(bundle), verifiedEntry.contains(bootstrapFile) else {
        throw Failure(message: "补丁自检失败")
    }
    for name in (archive.header["files"] as? [String: Any] ?? [:]).keys where verify.entry(name) == nil {
        throw Failure(message: "补丁自检失败：丢失 \(name)")
    }
    try patched.write(to: URL(fileURLWithPath: outputPath))
    return [
        "state": "patched",
        "version": orNull(btrVersion),
        "macVersion": orNull(macVersionValue),
        "clientVersion": clientVersion,
        "entry": entryName,
        "headerHash": sha(verify.headerBytes),
    ]
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

let usage = """
Usage:
  btr_mac patch  <original app.asar> <desktop.js> <output app.asar> <install root>
  btr_mac status <app.asar>
  btr_mac header-hash <app.asar>

"""

let arguments = CommandLine.arguments
let action = arguments.count > 1 ? arguments[1] : ""

do {
    if action == "patch" && arguments.count == 6 {
        let result = try patch(originalPath: arguments[2], bundlePath: arguments[3], outputPath: arguments[4], installRoot: arguments[5])
        print(try jsonText(result))
    } else if action == "status" && arguments.count == 3 {
        let archive = try Asar(Data(contentsOf: URL(fileURLWithPath: arguments[2])))
        print(try jsonText(try inspect(archive)))
    } else if action == "header-hash" && arguments.count == 3 {
        let archive = try Asar(Data(contentsOf: URL(fileURLWithPath: arguments[2])))
        print(sha(archive.headerBytes))
    } else {
        FileHandle.standardError.write(Data(usage.utf8))
        exit(2)
    }
} catch let error as Failure {
    fail("错误：\(error.message)")
} catch {
    fail("错误：\(error.localizedDescription)")
}
