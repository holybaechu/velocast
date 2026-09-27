import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  delimiter,
  dirname,
  join,
  relative,
  resolve,
} from "node:path";

// Windows system components are supplied by Windows. Redistributable runtimes
// such as VCRUNTIME/MSVCP must be copied even when installed in System32.
const systemDlls = new Set(
  `advapi32 avicap32 avrt bcrypt bcryptprimitives cfgmgr32 comctl32 comdlg32 credui crypt32 cryptui d2d1 d3d9 d3d11 d3d12 d3dcompiler_47 dbghelp dcomp dhcpcsvc dnsapi dwmapi dwrite dxgi esent fontsub gdi32 hid imm32 iphlpapi kernel32 kernelbase mf mfplat mfreadwrite mfuuid mmdevapi msimg32 msvcrt ncrypt ndfapi netapi32 normaliz ntdll ole32 oleacc oleaut32 pdh powrprof propsys psapi rpcrt4 secur32 setupapi shell32 shlwapi ucrtbase uiautomationcore urlmon user32 userenv usp10 uxtheme version wevtapi winhttp wininet winmm wintrust winusb wtsapi32 ws2_32`
    .split(" ")
    .map((name) => `${name}.dll`),
);
const sha256 = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

export function withDllSearchPath(dllDirs, environment = process.env) {
  const next = { ...environment };
  const pathKeys = Object.keys(next).filter(
    (key) => key.toLowerCase() === "path",
  );
  const pathKey =
    pathKeys[0] ?? (process.platform === "win32" ? "Path" : "PATH");
  const inherited = next[pathKey] ?? "";
  for (const key of pathKeys) delete next[key];
  next[pathKey] = [...dllDirs, inherited].filter(Boolean).join(delimiter);
  return next;
}

export function peArchitecture(file) {
  const bytes = readFileSync(file);
  if (bytes.length < 64 || bytes.toString("ascii", 0, 2) !== "MZ")
    throw new Error(`runtime.invalid_pe: ${file}`);
  const offset = bytes.readUInt32LE(0x3c);
  if (offset + 6 > bytes.length || bytes.readUInt32LE(offset) !== 0x00004550)
    throw new Error(`runtime.invalid_pe: ${file}`);
  const machine = bytes.readUInt16LE(offset + 4);
  return machine === 0x8664 ? "x64" : machine === 0xaa64 ? "arm64" : "unknown";
}

export function collectDependencies(roots, { searchDirs, readImports }) {
  const files = new Map();
  const graph = [];
  const indexes = searchDirs.map(
    (directory) =>
      new Map(
        readdirSync(directory, { withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map((entry) => [
            entry.name.toLowerCase(),
            join(directory, entry.name),
          ]),
      ),
  );
  const add = (path) => {
    const name = basename(path).toLowerCase();
    const previous = files.get(name);
    if (previous && sha256(previous) !== sha256(path))
      throw new Error(`runtime.dependency_conflict: ${name}`);
    if (!previous) files.set(name, path);
  };
  roots.forEach(add);
  const visited = new Set();
  while (visited.size < files.size) {
    const [name, file] = [...files].find(([key]) => !visited.has(key));
    visited.add(name);
    const imports = readImports(file);
    for (const imported of imports) {
      const dependency = imported.toLowerCase();
      if (dependency.includes("cef"))
        throw new Error(`runtime.cef_dependency: ${name} imports ${imported}`);
      if (systemDlls.has(dependency) || /^(api|ext)-ms-win-/.test(dependency))
        continue;
      const resolved =
        files.get(dependency) ??
        indexes.map((index) => index.get(dependency)).find(Boolean);
      if (!resolved)
        throw new Error(`runtime.dependency_missing: ${name} -> ${imported}`);
      add(resolved);
    }
    graph.push({ file: basename(file), imports });
  }
  return { files: [...files.values()], graph };
}

export function inventoryFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(`runtime.symlink_unsupported: ${path}`);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile())
        files.push({
          path: relative(root, path).replaceAll("\\", "/"),
          size: statSync(path).size,
          sha256: sha256(path),
        });
    }
  };
  visit(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export function packageElectronRuntime(options) {
  if ((options.platform ?? process.platform) !== "win32")
    throw new Error(
      "runtime.native_runner_required: this candidate packager currently targets Windows",
    );
  const output = resolve(options.output);
  if (existsSync(output)) throw new Error(`runtime.output_exists: ${output}`);
  const roots = [options.renderer, options.ffmpeg, options.ffprobe].map(
    (path) => resolve(path),
  );
  for (const file of roots)
    if (!statSync(file).isFile())
      throw new Error(`runtime.input_missing: ${file}`);
  const expectedNames = ["velocast-renderer.exe", "ffmpeg.exe", "ffprobe.exe"];
  roots.forEach((file, index) => {
    if (basename(file).toLowerCase() !== expectedNames[index])
      throw new Error(`runtime.input_name: expected ${expectedNames[index]}`);
  });
  const electron = resolve(options.electron);
  const host = resolve(options.host);
  for (const file of [
    join(electron, "electron.exe"),
    join(electron, "LICENSE"),
    join(electron, "LICENSES.chromium.html"),
    join(host, "main.cjs"),
  ])
    if (!statSync(file).isFile())
      throw new Error(`runtime.input_missing: ${file}`);
  const dependencySet = collectDependencies(roots, {
    searchDirs: [
      ...new Set([...roots.map(dirname), ...(options.dllDirs ?? [])]),
    ],
    readImports: options.readImports,
  });
  const arch = options.arch ?? process.arch;
  for (const file of [...dependencySet.files, join(electron, "electron.exe")]) {
    if (peArchitecture(file) !== arch)
      throw new Error(`runtime.architecture_mismatch: ${file} is not ${arch}`);
  }
  const capabilities = options.probeCapabilities(roots[0]);
  if (
    capabilities.defaultBrowserHost !== "electron" ||
    capabilities.electronHostProtocolVersion !== 1 ||
    JSON.stringify(capabilities.browserHosts) !== '["electron"]'
  )
    throw new Error(
      "runtime.not_electron_only: build the Electron renderer with the standard Cargo profile",
    );
  mkdirSync(output, { recursive: true });
  for (const file of dependencySet.files)
    cpSync(file, join(output, basename(file)), {
      force: false,
      errorOnExist: true,
    });
  cpSync(electron, join(output, "electron"), {
    recursive: true,
    force: false,
    errorOnExist: true,
  });
  mkdirSync(join(output, "electron-host"));
  for (const entry of readdirSync(host, { withFileTypes: true })) {
    if (
      entry.isFile() &&
      (entry.name.endsWith(".cjs") || entry.name === "package.json")
    )
      cpSync(
        join(host, entry.name),
        join(output, "electron-host", entry.name),
        { force: false, errorOnExist: true },
      );
  }
  if (options.licenses)
    cpSync(resolve(options.licenses), join(output, "native-licenses"), {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
  const files = inventoryFiles(output);
  if (
    files.some((file) =>
      /(^|\/)libcef\.(dll|so)$|Chromium Embedded Framework|(^|\/)cef[-_]/i.test(
        file.path,
      ),
    )
  )
    throw new Error(
      "runtime.cef_files: candidate unexpectedly includes CEF files",
    );
  const manifest = {
    schema: "velocast-electron-runtime-v1",
    status:
      process.env.VELOCAST_RELEASE_MODE === "1"
        ? "prepared-release-candidate"
        : "unsigned-local-candidate",
    browserHost: "electron",
    platform: "win32",
    arch,
    sourceCommit: options.sourceCommit,
    renderer: "velocast-renderer.exe",
    electron: "electron/electron.exe",
    hostScript: "electron-host/main.cjs",
    ffmpeg: "ffmpeg.exe",
    ffprobe: "ffprobe.exe",
    rendererCapabilities: capabilities,
    electronVersion: readFileSync(join(electron, "version"), "utf8").trim(),
    dependencyGraph: dependencySet.graph,
    files,
  };
  // Publish the discovery marker only after every input and copied file passed.
  writeFileSync(
    join(output, "electron-runtime.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    { flag: "wx" },
  );
  return manifest;
}

export function findDumpbin() {
  if (process.env.DUMPBIN) return process.env.DUMPBIN;
  return (
    execFileSync(
      "C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe",
      [
        "-latest",
        "-products",
        "*",
        "-find",
        "VC\\Tools\\MSVC\\**\\bin\\Hostx64\\x64\\dumpbin.exe",
      ],
      { encoding: "utf8", windowsHide: true },
    )
      .split(/\r?\n/)
      .find(Boolean)
      ?.trim() ?? "dumpbin.exe"
  );
}

export function windowsImports(dumpbin, file) {
  const output = execFileSync(dumpbin, ["/NOLOGO", "/DEPENDENTS", file], {
    encoding: "utf8",
    windowsHide: true,
  });
  return [
    ...new Set(
      [...output.matchAll(/^\s+([A-Za-z0-9_.+-]+\.dll)\s*$/gim)].map(
        (match) => match[1],
      ),
    ),
  ].sort();
}
