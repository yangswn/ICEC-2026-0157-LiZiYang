'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const preview = path.join(root, '.preview');
fs.mkdirSync(preview, { recursive: true });

function copy(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

copy(path.join(root, 'src', 'renderer', 'styles.css'), path.join(preview, 'styles.css'));
copy(path.join(root, 'src', 'renderer', 'app.js'), path.join(preview, 'app.js'));
copy(path.join(root, 'src', 'assets', 'icon.png'), path.join(preview, 'assets', 'icon.png'));
copy(path.join(root, 'src', 'renderer', 'preview-login.html'), path.join(preview, 'preview-login.html'));
copy(path.join(root, 'src', 'renderer', 'preview-login.css'), path.join(preview, 'preview-login.css'));

let html = fs.readFileSync(path.join(root, 'src', 'renderer', 'index.html'), 'utf8');
html = html.replace('<script src="app.js"></script>', '<script src="mock-api.js"></script>\n  <script src="app.js"></script>');
html = html.replace(/<webview[^>]*><\/webview>/, '<iframe class="cx-preview-frame" src="preview-login.html" title="学习通登录界面预览"></iframe>');
html = html.replace('<div class="webview-loading" id="cx-loading">', '<div class="webview-loading" id="cx-loading" hidden>');
html = html.replaceAll('../assets/', 'assets/');
html = html.replace('</head>', '  <style>.cx-preview-frame{width:100%;height:100%;border:0;display:block;background:#fff}</style>\n</head>');
fs.writeFileSync(path.join(preview, 'index.html'), html, 'utf8');
console.log('preview ready:', path.join(preview, 'index.html'));
