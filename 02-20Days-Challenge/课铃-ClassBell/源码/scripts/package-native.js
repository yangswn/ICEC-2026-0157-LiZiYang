'use strict';

/**
 * Assemble the WebView2 + Node desktop app directory.
 * The output is the payload used by the NSIS installer.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'dist', 'ClassBell');
const desktop = path.join(root, 'desktop');
const lib = path.join(desktop, 'lib');
const nodeExe = process.env.CAMPUSPULSE_NODE || 'C:\\Program Files\\nodejs\\node.exe';

function copy(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

if (!fs.existsSync(path.join(desktop, 'ClassBell.exe'))) {
  throw new Error('desktop/ClassBell.exe is missing; compile the host first.');
}
if (!fs.existsSync(nodeExe)) {
  throw new Error('node.exe not found at ' + nodeExe);
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

copy(path.join(desktop, 'ClassBell.exe'), path.join(outDir, 'ClassBell.exe'));
copy(path.join(lib, 'Microsoft.Web.WebView2.Core.dll'), path.join(outDir, 'Microsoft.Web.WebView2.Core.dll'));
copy(path.join(lib, 'Microsoft.Web.WebView2.WinForms.dll'), path.join(outDir, 'Microsoft.Web.WebView2.WinForms.dll'));
copy(path.join(lib, 'WebView2Loader.dll'), path.join(outDir, 'WebView2Loader.dll'));

fs.cpSync(path.join(root, 'server'), path.join(outDir, 'server'), { recursive: true });
fs.cpSync(path.join(root, 'src', 'renderer'), path.join(outDir, 'src', 'renderer'), { recursive: true });
fs.cpSync(path.join(root, 'src', 'assets'), path.join(outDir, 'src', 'assets'), { recursive: true });

fs.mkdirSync(path.join(outDir, 'assets'), { recursive: true });
copy(path.join(root, 'build', 'icon.ico'), path.join(outDir, 'assets', 'icon.ico'));
copy(path.join(root, 'build', 'icon.png'), path.join(outDir, 'assets', 'icon.png'));
copy(path.join(root, 'src', 'assets', 'tray.png'), path.join(outDir, 'assets', 'tray.png'));

fs.mkdirSync(path.join(outDir, 'runtime'), { recursive: true });
copy(nodeExe, path.join(outDir, 'runtime', 'node.exe'));
const nodeLicense = path.join(path.dirname(nodeExe), 'LICENSE');
if (fs.existsSync(nodeLicense)) copy(nodeLicense, path.join(outDir, 'runtime', 'LICENSE-node.txt'));

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

const pkg = {
  name: 'classbell',
  productName: 'ClassBell',
  version: require(path.join(root, 'package.json')).version,
  description: '课铃 ClassBell - 课程作业自动识别与到期提醒工具',
  main: 'server/server.js',
  license: 'MIT',
  scripts: {
    start: 'node server/server.js --port=48765',
    test: 'node tests/run-all.js'
  }
};
fs.writeFileSync(path.join(outDir, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8');
// Ship the tests too, so `npm test` works from an installed copy instead of
// only from the development checkout.
if (fs.existsSync(path.join(root, 'tests'))) {
  copyDir(path.join(root, 'tests'), path.join(outDir, 'tests'));
}

for (const name of ['README.md', 'LICENSE']) {
  const src = path.join(root, name);
  if (fs.existsSync(src)) copy(src, path.join(outDir, name));
}

if (process.argv.includes('--with-test-data')) {
  const fixture = path.join(root, '.test-data', 'data.json');
  if (!fs.existsSync(fixture)) throw new Error('Run scripts/seed-test-data.js first.');
  const state = JSON.parse(fs.readFileSync(fixture, 'utf8'));
  state.settings.autoLaunch = false;
  state.settings.firstRun = false;
  state.settings.logMirrorDir = path.join(root, 'process_logs');
  fs.mkdirSync(path.join(outDir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(outDir, 'data', 'data.json'), JSON.stringify(state, null, 2), 'utf8');
}

console.log('assembled', outDir);
