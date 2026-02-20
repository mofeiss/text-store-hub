// ============================================================
// Helpers
// ============================================================

function parseCookies(request) {
  var header = request.headers.get('Cookie') || '';
  var cookies = {};
  header.split(';').forEach(function (pair) {
    var parts = pair.trim().split('=');
    if (parts.length >= 2) cookies[parts[0]] = parts.slice(1).join('=');
  });
  return cookies;
}

async function computeAuthToken(password) {
  var data = new TextEncoder().encode(password + ':text-store-auth-salt');
  var hash = await crypto.subtle.digest('SHA-256', data);
  var bytes = Array.from(new Uint8Array(hash));
  return bytes.map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
}

async function authenticate(request, env) {
  var cookies = parseCookies(request);
  var token = cookies.auth_token;
  if (!token) return false;
  var expected = await computeAuthToken(env.ADMIN_PASSWORD);
  return token === expected;
}

async function handleLogin(request, env) {
  var body = await request.json();
  if (body.password !== env.ADMIN_PASSWORD) {
    return jsonResponse({ error: '密码错误' }, 401);
  }
  var token = await computeAuthToken(env.ADMIN_PASSWORD);
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': 'auth_token=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000',
    },
  });
}

function handleLogout() {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': 'auth_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
    },
  });
}

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    var r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function jsonResponse(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function errorResponse(message, status) {
  return new Response(message, { status: status || 400 });
}

function encodeContent(text) {
  return btoa(unescape(encodeURIComponent(text)));
}

function decodeContent(base64) {
  return decodeURIComponent(escape(atob(base64)));
}

// ============================================================
// Public File Access: GET /f/{filename}
// ============================================================

async function handlePublicFile(pathname, env) {
  var filename = decodeURIComponent(pathname.slice(3)); // strip "/f/"
  if (!filename) return errorResponse('Not Found', 404);

  var metaJson = await env.TEXT_STORE_KV.get('meta:index');
  var metadata = metaJson ? JSON.parse(metaJson) : [];
  var file = metadata.find(function (f) { return f.filename === filename; });
  if (!file) return errorResponse('Not Found', 404);

  var content = await env.TEXT_STORE_KV.get('content:' + file.id);
  return new Response(content || '', {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

// ============================================================
// API Router
// ============================================================

async function handleApi(pathname, method, request, env) {
  // GET /api/files
  if (pathname === '/api/files' && method === 'GET') {
    return handleListFiles(env);
  }
  // POST /api/files
  if (pathname === '/api/files' && method === 'POST') {
    return handleCreateFile(request, env);
  }
  // GET/PUT/DELETE /api/files/{id}
  if (pathname.startsWith('/api/files/')) {
    var id = pathname.slice(11); // strip "/api/files/"
    if (method === 'GET') return handleGetFile(id, env);
    if (method === 'PUT') return handleUpdateFile(id, request, env);
    if (method === 'DELETE') return handleDeleteFile(id, env);
  }
  // GET /api/export
  if (pathname === '/api/export' && method === 'GET') {
    return handleExport(env);
  }
  // POST /api/import
  if (pathname === '/api/import' && method === 'POST') {
    return handleImport(request, env);
  }

  return errorResponse('Not Found', 404);
}

// ============================================================
// File CRUD
// ============================================================

async function handleListFiles(env) {
  var metaJson = await env.TEXT_STORE_KV.get('meta:index');
  var metadata = metaJson ? JSON.parse(metaJson) : [];
  return jsonResponse(metadata);
}

async function handleCreateFile(request, env) {
  var body = await request.json();
  var metaJson = await env.TEXT_STORE_KV.get('meta:index');
  var metadata = metaJson ? JSON.parse(metaJson) : [];

  var filename = (body.filename || '未命名文件.txt').trim();
  // Check uniqueness
  if (metadata.some(function (f) { return f.filename === filename; })) {
    return errorResponse('文件名 "' + filename + '" 已被使用', 409);
  }

  var id = generateUUID();
  var content = body.content || '';
  var now = new Date().toISOString();
  var size = new TextEncoder().encode(content).length;

  var fileMeta = {
    id: id,
    filename: filename,
    title: (body.title || filename).trim(),
    contentType: 'text/plain',
    size: size,
    createdAt: now,
    updatedAt: now,
  };

  metadata.push(fileMeta);
  await env.TEXT_STORE_KV.put('meta:index', JSON.stringify(metadata));
  await env.TEXT_STORE_KV.put('content:' + id, content);

  // Return with content for the frontend
  var result = Object.assign({}, fileMeta, { content: content });
  return jsonResponse(result, 201);
}

async function handleGetFile(id, env) {
  var metaJson = await env.TEXT_STORE_KV.get('meta:index');
  var metadata = metaJson ? JSON.parse(metaJson) : [];
  var file = metadata.find(function (f) { return f.id === id; });
  if (!file) return errorResponse('Not Found', 404);

  var content = await env.TEXT_STORE_KV.get('content:' + id);
  var result = Object.assign({}, file, { content: content || '' });
  return jsonResponse(result);
}

async function handleUpdateFile(id, request, env) {
  var body = await request.json();
  var metaJson = await env.TEXT_STORE_KV.get('meta:index');
  var metadata = metaJson ? JSON.parse(metaJson) : [];
  var index = metadata.findIndex(function (f) { return f.id === id; });
  if (index < 0) return errorResponse('Not Found', 404);

  var filename = (body.filename || metadata[index].filename).trim();
  // Check uniqueness (excluding self)
  if (metadata.some(function (f) { return f.filename === filename && f.id !== id; })) {
    return errorResponse('文件名 "' + filename + '" 已被使用', 409);
  }

  var content = body.content !== undefined ? body.content : '';
  var size = new TextEncoder().encode(content).length;

  metadata[index].filename = filename;
  metadata[index].title = (body.title || filename).trim();
  metadata[index].size = size;
  metadata[index].updatedAt = new Date().toISOString();

  await env.TEXT_STORE_KV.put('meta:index', JSON.stringify(metadata));
  await env.TEXT_STORE_KV.put('content:' + id, content);

  var result = Object.assign({}, metadata[index], { content: content });
  return jsonResponse(result);
}

async function handleDeleteFile(id, env) {
  var metaJson = await env.TEXT_STORE_KV.get('meta:index');
  var metadata = metaJson ? JSON.parse(metaJson) : [];
  var newMeta = metadata.filter(function (f) { return f.id !== id; });

  await env.TEXT_STORE_KV.put('meta:index', JSON.stringify(newMeta));
  await env.TEXT_STORE_KV.delete('content:' + id);

  return jsonResponse({ ok: true });
}

// ============================================================
// Export / Import
// ============================================================

async function handleExport(env) {
  var metaJson = await env.TEXT_STORE_KV.get('meta:index');
  var metadata = metaJson ? JSON.parse(metaJson) : [];

  var files = [];
  for (var i = 0; i < metadata.length; i++) {
    var m = metadata[i];
    var content = await env.TEXT_STORE_KV.get('content:' + m.id);
    files.push({
      id: m.id,
      filename: m.filename,
      title: m.title,
      contentType: m.contentType,
      content: encodeContent(content || ''),
      encoding: 'base64',
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    });
  }

  var data = {
    version: '1.0',
    exportedAt: new Date().toISOString(),
    files: files,
  };

  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="text-store-export-' + Date.now() + '.json"',
    },
  });
}

async function handleImport(request, env) {
  var data = await request.json();
  if (!data.version || !data.files || !Array.isArray(data.files)) {
    return errorResponse('文件格式不正确', 400);
  }

  var metaJson = await env.TEXT_STORE_KV.get('meta:index');
  var metadata = metaJson ? JSON.parse(metaJson) : [];

  var imported = 0, skipped = 0, failed = 0;

  for (var i = 0; i < data.files.length; i++) {
    var f = data.files[i];
    try {
      var content = f.content || '';
      if (f.encoding === 'base64') {
        content = decodeContent(content);
      }

      var fname = f.filename || f.title || '未命名文件.txt';
      if (metadata.some(function (ef) { return ef.filename === fname; })) {
        skipped++;
        continue;
      }

      var id = f.id || generateUUID();
      // Ensure id uniqueness
      if (metadata.some(function (ef) { return ef.id === id; })) {
        id = generateUUID();
      }

      var now = new Date().toISOString();
      var size = new TextEncoder().encode(content).length;

      metadata.push({
        id: id,
        filename: fname,
        title: f.title || fname,
        contentType: f.contentType || 'text/plain',
        size: size,
        createdAt: f.createdAt || now,
        updatedAt: f.updatedAt || now,
      });

      await env.TEXT_STORE_KV.put('content:' + id, content);
      imported++;
    } catch (e) {
      failed++;
    }
  }

  await env.TEXT_STORE_KV.put('meta:index', JSON.stringify(metadata));

  return jsonResponse({ imported: imported, skipped: skipped, failed: failed });
}

// ============================================================
// Login HTML
// ============================================================

function getLoginHTML() {
  return `<!doctype html>
<html lang="zh-CN" data-theme="dark">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>TEXT-STORE-HUB - 登录</title>
    <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 36 36'%3E%3Cpath fill='%2377B255' d='M36 32c0 2.209-1.791 4-4 4H4c-2.209 0-4-1.791-4-4V4c0-2.209 1.791-4 4-4h28c2.209 0 4 1.791 4 4v28z'/%3E%3Ccircle fill='%23FFF' cx='18' cy='18' r='3'/%3E%3Cpath fill='%23FFF' d='M20 4c0-1.104-.896-2-2-2s-2 .896-2 2v8c0 1.104.896 2 2 2s2-.896 2-2V4zm0 20c0-1.104-.896-2-2-2s-2 .896-2 2v8c0 1.104.896 2 2 2s2-.896 2-2v-8zM4 16c-1.104 0-2 .896-2 2s.896 2 2 2h8c1.104 0 2-.896 2-2s-.896-2-2-2H4zm20 0c-1.104 0-2 .896-2 2s.896 2 2 2h8c1.104 0 2-.896 2-2s-.896-2-2-2h-8zm-8.829-2.243c.391.391.391 1.024 0 1.414-.39.391-1.024.391-1.414 0L6.272 7.687c-.391-.391-.391-1.024 0-1.415s1.024-.391 1.415 0l7.484 7.485zm14.557 14.556c.392.391.391 1.024 0 1.414-.39.391-1.023.392-1.414 0l-7.485-7.485c-.391-.391-.391-1.023 0-1.414s1.024-.391 1.414 0l7.485 7.485zm-15.971-7.485c.391-.391 1.024-.391 1.414 0 .391.391.391 1.024 0 1.414l-7.485 7.486c-.391.391-1.024.391-1.415 0s-.391-1.024 0-1.415l7.486-7.485zM28.313 6.272c.391-.392 1.024-.391 1.414 0 .391.39.392 1.023 0 1.414l-7.485 7.485c-.391.391-1.023.391-1.414 0s-.391-1.023 0-1.414l7.485-7.485z'/%3E%3C/svg%3E">
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
    <style>
      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
      body {
        font-family: "DM Sans", system-ui, sans-serif;
        background: #0d1117;
        color: #e6edf3;
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 20px;
        -webkit-font-smoothing: antialiased;
      }
      .login-card {
        background: #161b22;
        border: 1px solid #30363d;
        border-radius: 12px;
        padding: 40px 32px;
        width: 100%;
        max-width: 380px;
        box-shadow: 0 8px 24px rgba(0,0,0,0.5);
      }
      .login-header { text-align: center; margin-bottom: 32px; }
      .login-logo {
        font-family: "JetBrains Mono", monospace;
        font-weight: 600; font-size: 16px; letter-spacing: -0.3px;
        display: flex; align-items: center; justify-content: center; gap: 8px;
      }
      .status-dot {
        width: 8px; height: 8px; border-radius: 50%;
        background: #3fb950;
        box-shadow: 0 0 6px rgba(63, 185, 80, 0.4);
        animation: pulse 2.5s ease-in-out infinite;
      }
      @keyframes pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.6; }
      }
      .login-subtitle { color: #8b949e; font-size: 14px; margin-top: 8px; }
      .form-group { margin-bottom: 20px; }
      .form-label { display: block; font-size: 12px; font-weight: 500; color: #8b949e; margin-bottom: 6px; }
      .form-input {
        width: 100%; height: 40px; padding: 0 14px;
        background: #0d1117; border: 1px solid #30363d; border-radius: 8px;
        color: #e6edf3; font-family: "JetBrains Mono", monospace;
        font-size: 14px; outline: none;
        transition: border-color 0.15s ease;
      }
      .form-input:focus { border-color: #58a6ff; }
      .form-input::placeholder { color: #6e7681; }
      .btn-login {
        width: 100%; height: 40px;
        background: #58a6ff; border: none; border-radius: 8px;
        color: #fff; font-family: "DM Sans", system-ui, sans-serif;
        font-size: 14px; font-weight: 600; cursor: pointer;
        transition: opacity 0.15s ease;
      }
      .btn-login:hover { opacity: 0.9; }
      .btn-login:disabled { opacity: 0.5; cursor: not-allowed; }
      .error-msg { color: #f85149; font-size: 13px; text-align: center; margin-top: 12px; min-height: 20px; }
    </style>
  </head>
  <body>
    <div class="login-card">
      <div class="login-header">
        <div class="login-logo">
          <span>TEXT-STORE-HUB</span>
          <span class="status-dot"></span>
        </div>
        <div class="login-subtitle">输入管理员密码以继续</div>
      </div>
      <form id="loginForm">
        <div class="form-group">
          <label class="form-label">密码</label>
          <input type="password" class="form-input" id="passwordInput" placeholder="请输入密码" autofocus />
        </div>
        <button type="submit" class="btn-login" id="btnLogin">登录</button>
        <div class="error-msg" id="errorMsg"></div>
      </form>
    </div>
    <script>
      document.getElementById('loginForm').addEventListener('submit', function(e) {
        e.preventDefault();
        var btn = document.getElementById('btnLogin');
        var errMsg = document.getElementById('errorMsg');
        var password = document.getElementById('passwordInput').value;
        if (!password) { errMsg.textContent = '请输入密码'; return; }
        btn.disabled = true;
        btn.textContent = '登录中...';
        errMsg.textContent = '';
        fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: password }),
        }).then(function(res) {
          if (res.ok) {
            window.location.reload();
          } else {
            return res.json().then(function(data) {
              errMsg.textContent = data.error || '登录失败';
            });
          }
        }).catch(function() {
          errMsg.textContent = '网络错误';
        }).finally(function() {
          btn.disabled = false;
          btn.textContent = '登录';
        });
      });
    </script>
  </body>
</html>`;
}

// ============================================================
// Admin HTML
// ============================================================

function getAdminHTML() {
  return `<!doctype html>
<html lang="zh-CN" data-theme="dark">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>TEXT-STORE-HUB</title>
    <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 36 36'%3E%3Cpath fill='%2377B255' d='M36 32c0 2.209-1.791 4-4 4H4c-2.209 0-4-1.791-4-4V4c0-2.209 1.791-4 4-4h28c2.209 0 4 1.791 4 4v28z'/%3E%3Ccircle fill='%23FFF' cx='18' cy='18' r='3'/%3E%3Cpath fill='%23FFF' d='M20 4c0-1.104-.896-2-2-2s-2 .896-2 2v8c0 1.104.896 2 2 2s2-.896 2-2V4zm0 20c0-1.104-.896-2-2-2s-2 .896-2 2v8c0 1.104.896 2 2 2s2-.896 2-2v-8zM4 16c-1.104 0-2 .896-2 2s.896 2 2 2h8c1.104 0 2-.896 2-2s-.896-2-2-2H4zm20 0c-1.104 0-2 .896-2 2s.896 2 2 2h8c1.104 0 2-.896 2-2s-.896-2-2-2h-8zm-8.829-2.243c.391.391.391 1.024 0 1.414-.39.391-1.024.391-1.414 0L6.272 7.687c-.391-.391-.391-1.024 0-1.415s1.024-.391 1.415 0l7.484 7.485zm14.557 14.556c.392.391.391 1.024 0 1.414-.39.391-1.023.392-1.414 0l-7.485-7.485c-.391-.391-.391-1.023 0-1.414s1.024-.391 1.414 0l7.485 7.485zm-15.971-7.485c.391-.391 1.024-.391 1.414 0 .391.391.391 1.024 0 1.414l-7.485 7.486c-.391.391-1.024.391-1.415 0s-.391-1.024 0-1.415l7.486-7.485zM28.313 6.272c.391-.392 1.024-.391 1.414 0 .391.39.392 1.023 0 1.414l-7.485 7.485c-.391.391-1.023.391-1.414 0s-.391-1.023 0-1.414l7.485-7.485z'/%3E%3C/svg%3E">
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,400&family=JetBrains+Mono:wght@300;400;500;600&display=swap"
      rel="stylesheet"
    />
    <script src="https://unpkg.com/lucide@latest"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/ace/1.32.6/ace.js"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/js-yaml/4.1.0/js-yaml.min.js"></script>
    <style>
      :root {
        --font-ui: "DM Sans", system-ui, sans-serif;
        --font-mono: "JetBrains Mono", "Fira Code", "Cascadia Code", monospace;
        --sidebar-width: 320px;
        --header-height: auto;
        --radius-sm: 4px;
        --radius-md: 8px;
        --radius-lg: 12px;
        --transition: 0.2s ease;
        --transition-fast: 0.12s ease;
      }

      [data-theme="dark"] {
        --bg-root: #0d1117;
        --bg-surface: #161b22;
        --bg-elevated: #1c2128;
        --bg-overlay: #21262d;
        --bg-input: #0d1117;
        --border: #30363d;
        --border-muted: #21262d;
        --text-primary: #e6edf3;
        --text-secondary: #8b949e;
        --text-tertiary: #6e7681;
        --accent: #58a6ff;
        --accent-muted: rgba(88, 166, 255, 0.15);
        --accent-hover: rgba(88, 166, 255, 0.08);
        --success: #3fb950;
        --success-muted: rgba(63, 185, 80, 0.15);
        --warning: #d29922;
        --warning-muted: rgba(210, 153, 34, 0.15);
        --danger: #f85149;
        --danger-muted: rgba(248, 81, 73, 0.15);
        --scrollbar-thumb: #30363d;
        --scrollbar-track: transparent;
        --shadow: 0 1px 3px rgba(0, 0, 0, 0.4), 0 1px 2px rgba(0, 0, 0, 0.3);
        --shadow-lg: 0 8px 24px rgba(0, 0, 0, 0.5);
        --backdrop: rgba(0, 0, 0, 0.6);
      }

      [data-theme="light"] {
        --bg-root: #f6f8fa;
        --bg-surface: #ffffff;
        --bg-elevated: #ffffff;
        --bg-overlay: #f6f8fa;
        --bg-input: #ffffff;
        --border: #d0d7de;
        --border-muted: #e8ecf0;
        --text-primary: #24292f;
        --text-secondary: #57606a;
        --text-tertiary: #8c959f;
        --accent: #0969da;
        --accent-muted: rgba(9, 105, 218, 0.1);
        --accent-hover: rgba(9, 105, 218, 0.05);
        --success: #1a7f37;
        --success-muted: rgba(26, 127, 55, 0.1);
        --warning: #9a6700;
        --warning-muted: rgba(154, 103, 0, 0.1);
        --danger: #cf222e;
        --danger-muted: rgba(207, 34, 46, 0.1);
        --scrollbar-thumb: #d0d7de;
        --scrollbar-track: transparent;
        --shadow: 0 1px 3px rgba(0, 0, 0, 0.08), 0 1px 2px rgba(0, 0, 0, 0.06);
        --backdrop: rgba(0, 0, 0, 0.3);
      }

      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
      html, body { height: 100%; overflow: hidden; overscroll-behavior: none; }
      body {
        font-family: var(--font-ui);
        background: var(--bg-root);
        color: var(--text-primary);
        line-height: 1.5;
        -webkit-font-smoothing: antialiased;
        -moz-osx-font-smoothing: grayscale;
      }

      ::-webkit-scrollbar { width: 6px; height: 6px; }
      ::-webkit-scrollbar-track { background: var(--scrollbar-track); }
      ::-webkit-scrollbar-thumb { background: var(--scrollbar-thumb); border-radius: 3px; }
      ::-webkit-scrollbar-thumb:hover { background: var(--text-tertiary); }

      .app-shell { display: flex; flex-direction: column; height: 100vh; height: 100dvh; }
      .app-header {
        height: var(--header-height);
        background: var(--bg-surface);
        border-bottom: 1px solid var(--border);
        display: flex; align-items: center;
        padding: 10px 16px; gap: 8px;
        flex-shrink: 0; z-index: 100;
      }
      .app-body { display: flex; flex: 1; min-height: 0; }

      .header-row-1 { display: flex; align-items: center; gap: 8px; width: 100%; }
      .header-left { display: flex; align-items: center; gap: 10px; min-width: 0; flex: 1; }

      .btn-menu {
        display: none; background: none; border: none;
        color: var(--text-secondary); cursor: pointer;
        padding: 6px; border-radius: var(--radius-sm);
        transition: background var(--transition-fast), color var(--transition-fast);
        flex-shrink: 0;
      }
      .btn-menu:hover { background: var(--accent-hover); color: var(--text-primary); }

      .app-logo {
        font-family: var(--font-mono); font-weight: 600; font-size: 15px;
        letter-spacing: -0.3px; color: var(--text-primary);
        white-space: nowrap; user-select: none;
      }
      .status-dot {
        width: 8px; height: 8px; border-radius: 50%;
        background: var(--success); flex-shrink: 0;
        box-shadow: 0 0 6px rgba(63, 185, 80, 0.4);
        animation: pulse-dot 2.5s ease-in-out infinite;
      }
      @keyframes pulse-dot {
        0%, 100% { opacity: 1; box-shadow: 0 0 6px rgba(63, 185, 80, 0.4); }
        50% { opacity: 0.6; box-shadow: 0 0 2px rgba(63, 185, 80, 0.2); }
      }

      .header-spacer { flex: 1; }
      .header-right { display: flex; align-items: center; gap: 4px; }

      .btn-icon {
        display: inline-flex; align-items: center; justify-content: center;
        width: 34px; height: 34px; border: none; background: none;
        color: var(--text-secondary); border-radius: var(--radius-sm);
        cursor: pointer;
        transition: background var(--transition-fast), color var(--transition-fast);
        flex-shrink: 0;
      }
      .btn-icon:hover { background: var(--accent-hover); color: var(--text-primary); }
      .btn-icon svg { width: 18px; height: 18px; }

      .btn {
        display: inline-flex; align-items: center; justify-content: center;
        gap: 6px; height: 34px; padding: 0 14px;
        border: 1px solid var(--border); background: var(--bg-elevated);
        color: var(--text-primary); border-radius: var(--radius-md);
        cursor: pointer; font-family: var(--font-ui);
        font-size: 13px; font-weight: 500;
        transition: background var(--transition-fast), border-color var(--transition-fast), transform var(--transition-fast);
        white-space: nowrap; user-select: none;
      }
      .btn:hover { background: var(--bg-overlay); border-color: var(--text-tertiary); }
      .btn:active { transform: scale(0.97); }
      .btn svg { width: 15px; height: 15px; flex-shrink: 0; }
      .btn-primary { background: var(--accent); border-color: var(--accent); color: #ffffff; }
      .btn-primary:hover { opacity: 0.9; background: var(--accent); border-color: var(--accent); }
      .btn-danger { color: var(--danger); border-color: var(--danger-muted); background: var(--danger-muted); }
      .btn-danger:hover { background: var(--danger); border-color: var(--danger); color: #ffffff; }
      .btn-ghost { border: none; background: none; color: var(--text-secondary); }
      .btn-ghost:hover { background: var(--accent-hover); color: var(--text-primary); }
      .btn-block { width: 100%; }
      .btn:disabled, .btn-icon:disabled { opacity: 0.4; cursor: not-allowed; pointer-events: none; }

      .sidebar {
        width: var(--sidebar-width); background: var(--bg-surface);
        border-right: 1px solid var(--border);
        display: flex; flex-direction: column; flex-shrink: 0;
        overflow: hidden; transition: transform var(--transition);
      }
      .sidebar-header { padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; flex-shrink: 0; }
      .search-box { position: relative; }
      .search-box svg { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); width: 15px; height: 15px; color: var(--text-tertiary); pointer-events: none; }
      .search-input {
        width: 100%; height: 34px; padding: 0 10px 0 32px;
        border: 1px solid var(--border); border-radius: var(--radius-md);
        background: var(--bg-input); color: var(--text-primary);
        font-family: var(--font-ui); font-size: 13px; outline: none;
        transition: border-color var(--transition-fast);
      }
      .search-input::placeholder { color: var(--text-tertiary); }
      .search-input:focus { border-color: var(--accent); }

      .btn-new-file {
        height: 36px; border: 1px dashed var(--border); border-radius: var(--radius-md);
        background: none; color: var(--text-secondary);
        font-family: var(--font-ui); font-size: 13px; font-weight: 500;
        cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 6px;
        transition: background var(--transition-fast), color var(--transition-fast), border-color var(--transition-fast);
        width: 100%;
      }
      .btn-new-file:hover { background: var(--accent-muted); border-color: var(--accent); color: var(--accent); }
      .btn-new-file svg { width: 15px; height: 15px; }

      .file-list { flex: 1; overflow-y: auto; padding: 4px 14px 12px; }
      .file-item {
        padding: 10px 12px; border-radius: var(--radius-md); cursor: pointer;
        transition: background var(--transition-fast);
        display: flex; flex-direction: column; gap: 4px;
        margin: 5px 0; position: relative;
      }
      .file-item:hover { background: var(--accent-hover); }
      .file-item.active { background: var(--accent-muted); }
      .file-item.active::before {
        content: ""; position: absolute; left: 0; top: 8px; bottom: 8px;
        width: 3px; border-radius: 0 2px 2px 0; background: var(--accent);
      }
      .file-item-title {
        font-family: var(--font-mono); font-size: 13px; font-weight: 500;
        color: var(--text-primary); display: flex; align-items: center; gap: 6px;
      }
      .file-item-title-text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 1; }
      .file-item-title .unsaved-mark { color: var(--warning); font-size: 18px; line-height: 1; flex-shrink: 0; }
      .file-item-meta { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-tertiary); }
      .file-item-meta .filename-tag {
        font-family: var(--font-mono); font-size: 11px;
        background: var(--accent-muted); color: var(--accent);
        padding: 1px 6px; border-radius: 3px;
      }
      .file-item-actions {
        display: flex; align-items: center; gap: 2px; flex-shrink: 0;
        opacity: 0; transition: opacity var(--transition-fast);
      }
      .file-item:hover .file-item-actions, .file-item.active .file-item-actions { opacity: 1; }
      .file-item-btn {
        display: inline-flex; align-items: center; justify-content: center;
        width: 28px; height: 28px; border: none; background: none;
        color: var(--text-tertiary); border-radius: var(--radius-sm);
        cursor: pointer; padding: 0;
        transition: background var(--transition-fast), color var(--transition-fast);
      }
      .file-item-btn:hover { background: var(--bg-overlay); color: var(--text-primary); }
      .file-item-btn[data-action="delete"]:hover { color: var(--danger); background: var(--danger-muted); }
      .file-item-btn svg { width: 14px; height: 14px; }

      .file-list-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 48px 16px; text-align: center; color: var(--text-tertiary); }
      .file-list-empty svg { width: 40px; height: 40px; margin-bottom: 12px; opacity: 0.4; }
      .file-list-empty p { font-size: 13px; }
      .file-divider { height: 0; border: none; border-top: 1px dashed var(--border-muted); margin: 0 6px; }

      .editor-panel { flex: 1; display: flex; flex-direction: column; min-width: 0; background: var(--bg-surface); }
      .editor-empty {
        flex: 1; display: flex; flex-direction: column; align-items: center;
        justify-content: center; gap: 12px; color: var(--text-tertiary); user-select: none;
      }
      .editor-empty svg { width: 56px; height: 56px; opacity: 0.2; }
      .editor-empty p { font-size: 14px; }
      .editor-empty .hint {
        font-size: 12px; font-family: var(--font-mono);
        background: var(--bg-elevated); padding: 4px 10px;
        border-radius: var(--radius-sm); border: 1px solid var(--border-muted);
      }

      .editor-content { flex: 1; display: flex; flex-direction: column; min-height: 0; animation: editorFadeIn 0.25s ease; }
      @keyframes editorFadeIn { from { opacity: 0; } to { opacity: 1; } }

      .file-info { padding: 16px 20px; background: var(--bg-surface); border-bottom: 1px solid var(--border); display: flex; flex-direction: column; gap: 10px; flex-shrink: 0; }
      .info-row { display: flex; align-items: center; gap: 10px; }
      .info-label { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; font-weight: 500; color: var(--text-tertiary); white-space: nowrap; flex-shrink: 0; }
      .info-label svg { width: 13px; height: 13px; }
      .info-value-readonly {
        font-family: var(--font-mono); font-size: 12px; color: var(--text-secondary);
        background: var(--bg-overlay); padding: 5px 10px; border-radius: var(--radius-sm);
        flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;
        white-space: nowrap; border: 1px solid var(--border-muted); user-select: all;
      }
      .info-input {
        flex: 1; min-width: 0; height: 30px; padding: 0 10px;
        border: 1px solid var(--border); border-radius: var(--radius-sm);
        background: var(--bg-input); color: var(--text-primary);
        font-family: var(--font-mono); font-size: 13px; outline: none;
        transition: border-color var(--transition-fast);
      }
      .info-input:focus { border-color: var(--accent); }
      .info-row-split { display: flex; gap: 16px; }
      .info-group { display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0; }

      .btn-copy-url {
        display: inline-flex; align-items: center; justify-content: center;
        width: 30px; height: 30px; border: 1px solid var(--border);
        border-radius: var(--radius-sm); background: var(--bg-elevated);
        color: var(--text-secondary); cursor: pointer; flex-shrink: 0;
        transition: background var(--transition-fast), color var(--transition-fast), border-color var(--transition-fast);
      }
      .btn-copy-url:hover { border-color: var(--accent); color: var(--accent); background: var(--accent-muted); }
      .btn-copy-url.copied { border-color: var(--success); color: var(--success); background: var(--success-muted); }
      .btn-copy-url svg { width: 14px; height: 14px; }

      .editor-stats {
        display: flex; align-items: center; gap: 16px;
        padding: 8px 20px; background: var(--bg-surface);
        border-bottom: 1px solid var(--border-muted);
        font-size: 12px; color: var(--text-tertiary); flex-shrink: 0;
      }
      .editor-stats .stat-item { display: flex; align-items: center; gap: 5px; font-family: var(--font-mono); font-size: 11px; }
      .editor-stats .stat-item svg { width: 13px; height: 13px; }
      .editor-stats .unsaved-badge { display: flex; align-items: center; gap: 4px; color: var(--warning); font-weight: 500; }
      .editor-stats .unsaved-badge .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--warning); }
      .stat-spacer { flex: 1; }

      .editor-area { flex: 1; min-height: 0; padding: 0; position: relative; }
      #aceEditor { width: 100%; height: 100%; font-size: 14px; line-height: 1.7; }

      .editor-actions {
        display: flex; align-items: center; gap: 8px;
        padding: 12px 20px; background: var(--bg-surface);
        border-top: 1px solid var(--border); flex-shrink: 0;
      }
      .editor-actions .action-spacer { flex: 1; }

      .sidebar-overlay {
        display: none; position: fixed; inset: 0;
        background: var(--backdrop); z-index: 199;
        opacity: 0; transition: opacity var(--transition);
      }
      .sidebar-overlay.visible { opacity: 1; }

      .btn-back {
        display: none; background: none; border: none;
        color: var(--text-secondary); cursor: pointer; padding: 6px;
        border-radius: var(--radius-sm); flex-shrink: 0;
        transition: background var(--transition-fast), color var(--transition-fast);
      }
      .btn-back:hover { background: var(--accent-hover); color: var(--text-primary); }
      .mobile-file-title {
        display: none; font-family: var(--font-mono);
        font-size: 13px; font-weight: 500; color: var(--text-primary);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0;
      }

      .toast-container {
        position: fixed; top: 12px; right: 12px; z-index: 9999;
        display: flex; flex-direction: column; align-items: flex-end;
        gap: 6px; pointer-events: none;
      }
      .toast {
        display: inline-flex; align-items: center; gap: 6px;
        padding: 6px 12px; border-radius: var(--radius-md);
        background: var(--bg-elevated); border: 1px solid var(--border);
        color: var(--text-primary); font-size: 12px;
        box-shadow: var(--shadow-lg); pointer-events: auto;
        animation: toastIn 0.3s ease; white-space: nowrap;
      }
      .toast.toast-out { animation: toastOut 0.25s ease forwards; }
      .toast svg { width: 14px; height: 14px; flex-shrink: 0; }
      .toast.toast-success svg { color: var(--success); }
      .toast.toast-error svg { color: var(--danger); }
      .toast.toast-warning svg { color: var(--warning); }
      .toast.toast-info svg { color: var(--accent); }
      @keyframes toastIn { from { opacity: 0; transform: translateX(40px); } to { opacity: 1; transform: translateX(0); } }
      @keyframes toastOut { from { opacity: 1; transform: translateX(0); } to { opacity: 0; transform: translateX(40px); } }

      .modal-backdrop {
        position: fixed; inset: 0; background: var(--backdrop); z-index: 1000;
        display: flex; align-items: center; justify-content: center; padding: 20px;
        opacity: 0; visibility: hidden;
        transition: opacity var(--transition), visibility var(--transition);
      }
      .modal-backdrop.visible { opacity: 1; visibility: visible; }
      .modal {
        background: var(--bg-elevated); border: 1px solid var(--border);
        border-radius: var(--radius-lg); box-shadow: var(--shadow-lg);
        width: 100%; max-width: 420px; padding: 24px;
        transform: scale(0.95) translateY(8px);
        transition: transform var(--transition);
      }
      .modal-backdrop.visible .modal { transform: scale(1) translateY(0); }
      .modal-title { font-size: 16px; font-weight: 600; margin-bottom: 8px; }
      .modal-body { font-size: 14px; color: var(--text-secondary); margin-bottom: 20px; line-height: 1.6; }
      .modal-body .file-name { font-family: var(--font-mono); color: var(--text-primary); background: var(--bg-overlay); padding: 1px 6px; border-radius: var(--radius-sm); }
      .modal-actions { display: flex; gap: 8px; justify-content: flex-end; }

      .import-result { display: flex; flex-direction: column; gap: 6px; font-family: var(--font-mono); font-size: 13px; }
      .import-result .result-success { color: var(--success); }
      .import-result .result-warning { color: var(--warning); }
      .import-result .result-error { color: var(--danger); }

      @media (max-width: 767px) {
        .app-header { flex-wrap: wrap; }
        .header-row-1 { display: flex; align-items: center; gap: 8px; width: 100%; }
        .header-left { flex: 1; min-width: 0; }
        .header-spacer { display: none; }
        .header-right { flex-shrink: 0; }
        .btn-menu { display: none; }
        .btn-back { display: none; }
        .mobile-file-title { display: none; }

        body.mobile-editing .btn-back { display: inline-flex; }
        body.mobile-editing .app-logo { display: none; }
        body.mobile-editing .status-dot { display: none; }
        body.mobile-editing .mobile-file-title { display: block; }

        .sidebar {
          position: fixed; top: 0; left: 0; bottom: 0;
          width: calc(100vw - 60px); max-width: 340px; z-index: 200;
          transform: translateX(-100%); box-shadow: var(--shadow-lg); transition: none;
        }
        .sidebar.open { transform: translateX(0); transition: transform var(--transition); }
        .sidebar-overlay.active { display: block; }
        .file-item { padding: 12px; }
        .file-item-actions { opacity: 1; }

        body:not(.mobile-editing) .editor-panel { display: none; }
        body:not(.mobile-editing) .sidebar {
          position: static; width: 100%; max-width: none;
          transform: none; border-right: none;
        }

        .info-input { font-size: 16px; }
        .editor-actions { flex-wrap: wrap; }
        .editor-actions .btn { flex: 1; min-width: 80px; }
        .editor-actions .action-spacer { display: none; }
        .file-info { padding: 12px 14px; }
        .editor-stats { padding: 8px 14px; flex-wrap: wrap; gap: 10px; }
        .editor-actions { padding: 10px 14px; }
        .info-label { font-size: 11px; min-width: 52px; }
        .info-row-split { flex-direction: column; gap: 10px; }
        .info-row-split .info-group { width: 100%; }
      }

      .visually-hidden { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0,0,0,0); border: 0; }
      .hidden { display: none !important; }
    </style>
  </head>
  <body>
    <div class="toast-container" id="toastContainer"></div>

    <div class="modal-backdrop" id="modalBackdrop">
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-title" id="modalTitle"></div>
        <div class="modal-body" id="modalBody"></div>
        <div class="modal-actions" id="modalActions"></div>
      </div>
    </div>

    <div class="sidebar-overlay" id="sidebarOverlay"></div>

    <div class="app-shell">
      <header class="app-header" role="banner">
        <div class="header-row-1">
          <div class="header-left">
            <button class="btn-menu" id="btnMenu" aria-label="打开菜单">
              <i data-lucide="menu" style="width:20px;height:20px"></i>
            </button>
            <button class="btn-back" id="btnBack" aria-label="返回列表">
              <i data-lucide="arrow-left" style="width:20px;height:20px"></i>
            </button>
            <span class="app-logo">TEXT-STORE-HUB</span>
            <span class="mobile-file-title" id="mobileFileTitle"></span>
            <span class="status-dot" title="服务在线"></span>
          </div>
          <div class="header-right">
            <button class="btn-icon" id="btnExport" title="导出数据" aria-label="导出数据">
              <i data-lucide="download"></i>
            </button>
            <button class="btn-icon" id="btnImport" title="导入数据" aria-label="导入数据">
              <i data-lucide="upload"></i>
            </button>
            <button class="btn-icon" id="btnTheme" title="切换主题" aria-label="切换主题">
              <i data-lucide="moon" id="themeIcon"></i>
            </button>
            <button class="btn-icon" id="btnLogout" title="退出登录" aria-label="退出登录">
              <i data-lucide="log-out"></i>
            </button>
          </div>
        </div>
      </header>

      <div class="app-body">
        <aside class="sidebar" id="sidebar" role="navigation" aria-label="文件列表">
          <div class="sidebar-header">
            <div class="search-box">
              <i data-lucide="search"></i>
              <input type="text" class="search-input" id="searchInput" placeholder="搜索文件..." aria-label="搜索文件" />
            </div>
            <button class="btn-new-file" id="btnNewFile">
              <i data-lucide="plus"></i> 新建文件
            </button>
          </div>
          <div class="file-list" id="fileList" role="list"></div>
        </aside>

        <main class="editor-panel" id="editorPanel">
          <div class="editor-empty" id="editorEmpty">
            <i data-lucide="file-text"></i>
            <p>选择文件开始编辑</p>
            <span class="hint">Ctrl+S / Cmd+S 保存</span>
          </div>
          <div class="editor-content hidden" id="editorContent">
            <div class="file-info">
              <div class="info-row" style="display:none">
                <span class="info-label">KV Key</span>
                <span class="info-value-readonly" id="fileIdDisplay"></span>
              </div>
              <div class="info-row info-row-split">
                <div class="info-group">
                  <span class="info-label"><i data-lucide="tag"></i>标题</span>
                  <input type="text" class="info-input" id="titleInput" placeholder="文件描述（必填）" aria-label="文件标题" />
                </div>
                <div class="info-group">
                  <span class="info-label"><i data-lucide="file-text"></i>文件名</span>
                  <input type="text" class="info-input" id="filenameInput" placeholder="example.yaml" aria-label="文件名" />
                  <button class="btn-copy-url" id="btnCopyUrl" title="复制访问链接" aria-label="复制访问链接">
                    <i data-lucide="copy"></i>
                  </button>
                </div>
              </div>
            </div>

            <div class="editor-stats">
              <div class="stat-item"><i data-lucide="file-text"></i><span id="lineCount">0 行</span></div>
              <div class="stat-item"><i data-lucide="edit-3"></i><span id="charCount">0 字符</span></div>
              <div class="stat-spacer"></div>
              <button class="btn btn-ghost" id="btnFormat" title="格式化内容" style="height:24px;padding:0 8px;font-size:11px">
                <i data-lucide="align-left"></i> 格式化
              </button>
              <div class="unsaved-badge hidden" id="unsavedBadge">
                <span class="dot"></span><span>未保存</span>
              </div>
            </div>

            <div class="editor-area"><div id="aceEditor"></div></div>

            <div class="editor-actions">
              <button class="btn" id="btnRefresh"><i data-lucide="refresh-cw"></i> 刷新</button>
              <span class="action-spacer"></span>
              <button class="btn btn-primary" id="btnSave"><i data-lucide="save"></i> 保存</button>
              <button class="btn btn-danger" id="btnDelete"><i data-lucide="trash-2"></i> 删除</button>
            </div>
          </div>
        </main>
      </div>
    </div>

    <input type="file" id="importFileInput" accept=".json" class="visually-hidden" />

    <script>
      /* ============================================================
         Application State
         ============================================================ */
      var state = {
        files: [],
        selectedFileId: null,
        originalContent: null,
        originalFilename: null,
        originalTitle: null,
        isDirty: false,
        isMobileEditing: false,
        sidebarOpen: false,
      };

      /* ============================================================
         DOM References
         ============================================================ */
      var $ = function(sel) { return document.querySelector(sel); };
      var dom = {
        toastContainer: $('#toastContainer'),
        modalBackdrop: $('#modalBackdrop'),
        modalTitle: $('#modalTitle'),
        modalBody: $('#modalBody'),
        modalActions: $('#modalActions'),
        sidebarOverlay: $('#sidebarOverlay'),
        sidebar: $('#sidebar'),
        searchInput: $('#searchInput'),
        fileList: $('#fileList'),
        editorPanel: $('#editorPanel'),
        editorEmpty: $('#editorEmpty'),
        editorContent: $('#editorContent'),
        fileIdDisplay: $('#fileIdDisplay'),
        filenameInput: $('#filenameInput'),
        titleInput: $('#titleInput'),
        lineCount: $('#lineCount'),
        charCount: $('#charCount'),
        unsavedBadge: $('#unsavedBadge'),
        mobileFileTitle: $('#mobileFileTitle'),
        btnMenu: $('#btnMenu'),
        btnBack: $('#btnBack'),
        btnNewFile: $('#btnNewFile'),
        btnCopyUrl: $('#btnCopyUrl'),
        btnRefresh: $('#btnRefresh'),
        btnSave: $('#btnSave'),
        btnDelete: $('#btnDelete'),
        btnExport: $('#btnExport'),
        btnImport: $('#btnImport'),
        btnTheme: $('#btnTheme'),
        btnFormat: $('#btnFormat'),
        btnLogout: $('#btnLogout'),
        themeIcon: $('#themeIcon'),
        importFileInput: $('#importFileInput'),
      };

      /* ============================================================
         Ace Editor
         ============================================================ */
      var aceEditor;

      function initAceEditor() {
        aceEditor = ace.edit('aceEditor');
        aceEditor.setOptions({
          fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
          fontSize: 14,
          showPrintMargin: false,
          tabSize: 2,
          useSoftTabs: true,
          wrap: true,
          showGutter: true,
          highlightActiveLine: true,
          scrollPastEnd: 0.3,
        });
        aceEditor.renderer.setScrollMargin(12, 12, 0, 0);
        aceEditor.renderer.setPadding(16);
        aceEditor.commands.addCommand({
          name: 'save',
          bindKey: { win: 'Ctrl-S', mac: 'Cmd-S' },
          exec: function() { if (state.selectedFileId) saveFile(); },
        });
        applyAceTheme();
      }

      function applyAceTheme() {
        var theme = document.documentElement.getAttribute('data-theme');
        aceEditor.setTheme(theme === 'dark' ? 'ace/theme/one_dark' : 'ace/theme/chrome');
      }

      function detectAceMode(filename) {
        if (!filename) return 'ace/mode/text';
        var ext = filename.split('.').pop().toLowerCase();
        var modeMap = {
          json: 'ace/mode/json', yaml: 'ace/mode/yaml', yml: 'ace/mode/yaml',
          js: 'ace/mode/javascript', ts: 'ace/mode/typescript',
          html: 'ace/mode/html', css: 'ace/mode/css', xml: 'ace/mode/xml',
          md: 'ace/mode/markdown', sh: 'ace/mode/sh', bash: 'ace/mode/sh',
          conf: 'ace/mode/text', txt: 'ace/mode/text',
          toml: 'ace/mode/toml', ini: 'ace/mode/ini', py: 'ace/mode/python',
        };
        return modeMap[ext] || 'ace/mode/text';
      }

      function getEditorValue() { return aceEditor ? aceEditor.getValue() : ''; }

      function setEditorValue(val, filename) {
        if (!aceEditor) return;
        aceEditor.setValue(val, -1);
        aceEditor.session.setMode(detectAceMode(filename));
        aceEditor.clearSelection();
      }

      function formatContent() {
        if (!aceEditor || !state.selectedFileId) return;
        var text = getEditorValue();
        var filename = dom.filenameInput.value || '';
        var ext = filename.split('.').pop().toLowerCase();
        try {
          if (ext === 'json') {
            var formatted = JSON.stringify(JSON.parse(text), null, 2);
            aceEditor.setValue(formatted, -1);
            aceEditor.clearSelection();
            showToast('JSON 格式化完成', 'success');
          } else if (ext === 'yaml' || ext === 'yml') {
            var hasComments = /^[^"']*#/m.test(text);
            if (hasComments && !confirm('YAML 格式化会丢失所有注释内容，是否继续？')) return;
            var formatted = jsyaml.dump(jsyaml.load(text), { indent: 2, lineWidth: -1, noRefs: true });
            aceEditor.setValue(formatted, -1);
            aceEditor.clearSelection();
            showToast('YAML 格式化完成', 'success');
          } else {
            showToast('仅支持 JSON 和 YAML 格式化', 'warning');
          }
        } catch (e) {
          showToast('格式化失败: ' + e.message, 'error');
        }
      }

      /* ============================================================
         Theme
         ============================================================ */
      function initTheme() {
        var saved = localStorage.getItem('text-store-theme') || 'dark';
        document.documentElement.setAttribute('data-theme', saved);
        updateThemeIcon(saved);
      }

      function toggleTheme() {
        var current = document.documentElement.getAttribute('data-theme');
        var next = current === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        localStorage.setItem('text-store-theme', next);
        updateThemeIcon(next);
        if (aceEditor) applyAceTheme();
        lucide.createIcons();
      }

      function updateThemeIcon(theme) {
        dom.themeIcon.setAttribute('data-lucide', theme === 'dark' ? 'moon' : 'sun');
        lucide.createIcons();
      }

      /* ============================================================
         Toast
         ============================================================ */
      function showToast(message, type) {
        type = type || 'info';
        var iconMap = { success: 'check-circle-2', error: 'x-circle', warning: 'alert-triangle', info: 'info' };
        var toast = document.createElement('div');
        toast.className = 'toast toast-' + type;
        toast.innerHTML = '<i data-lucide="' + (iconMap[type] || 'info') + '"></i><span>' + message + '</span>';
        dom.toastContainer.appendChild(toast);
        lucide.createIcons({ nodes: [toast] });
        setTimeout(function() {
          toast.classList.add('toast-out');
          toast.addEventListener('animationend', function() { toast.remove(); });
        }, 2800);
      }

      /* ============================================================
         Modal
         ============================================================ */
      function showModal(opts) {
        dom.modalTitle.textContent = opts.title;
        if (typeof opts.body === 'string') {
          dom.modalBody.innerHTML = opts.body;
        } else {
          dom.modalBody.textContent = '';
          dom.modalBody.appendChild(opts.body);
        }
        dom.modalActions.textContent = '';
        opts.actions.forEach(function(a) {
          var btn = document.createElement('button');
          btn.className = 'btn ' + (a.className || '');
          btn.textContent = a.label;
          btn.addEventListener('click', function() { hideModal(); if (a.onClick) a.onClick(); });
          dom.modalActions.appendChild(btn);
        });
        dom.modalBackdrop.classList.add('visible');
      }

      function hideModal() { dom.modalBackdrop.classList.remove('visible'); }

      /* ============================================================
         Utilities
         ============================================================ */
      function timeAgo(dateStr) {
        var now = Date.now();
        var diff = now - new Date(dateStr).getTime();
        var seconds = Math.floor(diff / 1000);
        var minutes = Math.floor(seconds / 60);
        var hours = Math.floor(minutes / 60);
        var days = Math.floor(hours / 24);
        if (seconds < 60) return '刚刚';
        if (minutes < 60) return minutes + ' 分钟前';
        if (hours < 24) return hours + ' 小时前';
        if (days < 7) return days + ' 天前';
        if (days < 30) return Math.floor(days / 7) + ' 周前';
        return Math.floor(days / 30) + ' 个月前';
      }

      function formatSize(bytes) {
        if (!bytes && bytes !== 0) return '0 B';
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
      }

      function isMobile() { return window.innerWidth < 768; }

      /* ============================================================
         API Request
         ============================================================ */
      function apiRequest(method, path, body) {
        var options = { method: method, headers: {} };
        if (body) {
          options.headers['Content-Type'] = 'application/json';
          options.body = JSON.stringify(body);
        }
        return fetch(path, options).then(function(response) {
          if (!response.ok) {
            return response.text().then(function(err) {
              throw new Error(err || 'HTTP ' + response.status);
            });
          }
          return response.text().then(function(text) {
            return text ? JSON.parse(text) : null;
          });
        });
      }

      /* ============================================================
         File List
         ============================================================ */
      function loadFiles() {
        return apiRequest('GET', '/api/files').then(function(data) {
          state.files = data || [];
          renderFileList();
        }).catch(function(e) {
          showToast('加载文件列表失败: ' + e.message, 'error');
        });
      }

      function renderFileList(filter) {
        var query = (filter || '').toLowerCase().trim();
        var files = state.files.slice().sort(function(a, b) {
          return new Date(b.updatedAt) - new Date(a.updatedAt);
        });

        if (query) {
          files = files.filter(function(f) {
            return f.filename.toLowerCase().indexOf(query) >= 0 ||
                   (f.title && f.title.toLowerCase().indexOf(query) >= 0);
          });
        }

        if (files.length === 0) {
          dom.fileList.innerHTML =
            '<div class="file-list-empty">' +
              '<i data-lucide="search"></i>' +
              '<p>' + (query ? '没有匹配的文件' : '暂无文件') + '</p>' +
            '</div>';
          lucide.createIcons({ nodes: [dom.fileList] });
          return;
        }

        dom.fileList.innerHTML = files.map(function(f, index) {
          var isActive = f.id === state.selectedFileId;
          var isDirty = isActive && state.isDirty;
          var divider = index < files.length - 1 ? '<hr class="file-divider">' : '';
          return '<div class="file-item ' + (isActive ? 'active' : '') + '" data-id="' + f.id + '" role="listitem" tabindex="0">' +
            '<div class="file-item-title">' +
              '<span class="file-item-title-text">' + (f.title || f.filename) + '</span>' +
              (isDirty ? '<span class="unsaved-mark">*</span>' : '') +
              '<div class="file-item-actions">' +
                '<button class="file-item-btn" data-action="copy" data-filename="' + f.filename + '" title="复制访问链接"><i data-lucide="copy"></i></button>' +
                '<button class="file-item-btn" data-action="delete" data-file-id="' + f.id + '" title="删除文件"><i data-lucide="trash-2"></i></button>' +
              '</div>' +
            '</div>' +
            '<div class="file-item-meta">' +
              '<span>' + timeAgo(f.updatedAt) + '</span>' +
              '<span>' + formatSize(f.size) + '</span>' +
              '<span class="filename-tag">/' + f.filename + '</span>' +
            '</div>' +
          '</div>' + divider;
        }).join('');

        lucide.createIcons({ nodes: [dom.fileList] });
      }

      /* ============================================================
         File Selection & Editor
         ============================================================ */
      function selectFile(fileId) {
        if (state.isDirty && state.selectedFileId) {
          showModal({
            title: '未保存的更改',
            body: '当前文件有未保存的更改，是否放弃？',
            actions: [
              { label: '取消', className: 'btn-ghost' },
              { label: '放弃更改', className: 'btn-danger', onClick: function() { forceSelectFile(fileId); } },
            ],
          });
          return;
        }
        forceSelectFile(fileId);
      }

      function forceSelectFile(fileId) {
        return apiRequest('GET', '/api/files/' + fileId).then(function(file) {
          var idx = state.files.findIndex(function(f) { return f.id === fileId; });
          if (idx >= 0) {
            state.files[idx] = Object.assign({}, state.files[idx], {
              filename: file.filename, title: file.title,
              size: file.size, updatedAt: file.updatedAt,
            });
          }

          state.selectedFileId = fileId;
          state.originalContent = file.content || '';
          state.originalFilename = file.filename;
          state.originalTitle = file.title;
          state.isDirty = false;

          dom.editorEmpty.classList.add('hidden');
          dom.editorContent.classList.remove('hidden');

          dom.fileIdDisplay.textContent = file.id;
          dom.filenameInput.value = file.filename;
          dom.titleInput.value = file.title || '';
          setEditorValue(file.content || '', file.filename);
          dom.mobileFileTitle.textContent = file.title || file.filename;

          updateStats();
          updateUnsavedBadge();
          renderFileList(dom.searchInput.value);

          if (isMobile()) enterMobileEditing();
          closeSidebar();

          // Resize ace editor after DOM update
          requestAnimationFrame(function() { if (aceEditor) aceEditor.resize(); });
        }).catch(function(e) {
          showToast('加载文件失败: ' + e.message, 'error');
        });
      }

      function deselectFile() {
        state.selectedFileId = null;
        state.isDirty = false;
        dom.editorEmpty.classList.remove('hidden');
        dom.editorContent.classList.add('hidden');
        renderFileList(dom.searchInput.value);
      }

      /* ============================================================
         Stats & Dirty Tracking
         ============================================================ */
      function updateStats() {
        var text = getEditorValue();
        var lines = text ? text.split('\\n').length : 0;
        var chars = text.length;
        dom.lineCount.textContent = lines + ' 行';
        dom.charCount.textContent = chars.toLocaleString() + ' 字符';
      }

      function checkDirty() {
        if (!state.selectedFileId) return;
        var contentChanged = getEditorValue() !== state.originalContent;
        var filenameChanged = dom.filenameInput.value !== state.originalFilename;
        var titleChanged = dom.titleInput.value !== (state.originalTitle || '');
        state.isDirty = contentChanged || filenameChanged || titleChanged;
        updateUnsavedBadge();
        renderFileList(dom.searchInput.value);
      }

      function updateUnsavedBadge() {
        if (state.isDirty) {
          dom.unsavedBadge.classList.remove('hidden');
        } else {
          dom.unsavedBadge.classList.add('hidden');
        }
      }

      /* ============================================================
         File Operations
         ============================================================ */
      function createNewFile() {
        dom.btnNewFile.disabled = true;
        apiRequest('POST', '/api/files', {
          filename: '未命名文件.txt',
          title: '新建文件',
          content: '',
        }).then(function(newFile) {
          state.files.unshift(newFile);
          renderFileList();
          showToast('文件已创建', 'success');
          return forceSelectFile(newFile.id);
        }).catch(function(e) {
          showToast('创建失败: ' + e.message, 'error');
        }).finally(function() {
          dom.btnNewFile.disabled = false;
        });
      }

      function saveFile() {
        if (!state.selectedFileId) return;
        var newFilename = dom.filenameInput.value.trim();
        var newTitle = dom.titleInput.value.trim();
        var content = getEditorValue();

        dom.btnSave.disabled = true;
        apiRequest('PUT', '/api/files/' + state.selectedFileId, {
          filename: newFilename || '未命名文件.txt',
          title: newTitle || newFilename || '未命名文件.txt',
          content: content,
        }).then(function(updated) {
          var idx = state.files.findIndex(function(f) { return f.id === state.selectedFileId; });
          if (idx >= 0) state.files[idx] = Object.assign({}, state.files[idx], {
            filename: updated.filename, title: updated.title,
            size: updated.size, updatedAt: updated.updatedAt,
          });

          state.originalContent = content;
          state.originalFilename = updated.filename;
          state.originalTitle = updated.title;
          state.isDirty = false;

          dom.filenameInput.value = updated.filename;
          dom.titleInput.value = updated.title;
          updateUnsavedBadge();
          renderFileList(dom.searchInput.value);
          dom.mobileFileTitle.textContent = updated.title || updated.filename;
          showToast('文件已保存', 'success');
        }).catch(function(e) {
          showToast('保存失败: ' + e.message, 'error');
        }).finally(function() {
          dom.btnSave.disabled = false;
        });
      }

      function refreshFile() {
        if (!state.selectedFileId) return;
        if (state.isDirty) {
          showModal({
            title: '刷新确认',
            body: '当前有未保存的更改，刷新将丢失所有更改。',
            actions: [
              { label: '取消', className: 'btn-ghost' },
              { label: '刷新', className: 'btn-primary', onClick: function() {
                forceSelectFile(state.selectedFileId).then(function() {
                  showToast('内容已刷新', 'info');
                });
              }},
            ],
          });
          return;
        }
        forceSelectFile(state.selectedFileId).then(function() {
          showToast('内容已刷新', 'info');
        });
      }

      function deleteFile() {
        var file = state.files.find(function(f) { return f.id === state.selectedFileId; });
        if (!file) return;
        showModal({
          title: '确认删除',
          body: '确定要删除文件 <span class="file-name">' + (file.title || file.filename) + '</span> 吗？此操作不可撤销。',
          actions: [
            { label: '取消', className: 'btn-ghost' },
            { label: '删除', className: 'btn-danger', onClick: function() {
              apiRequest('DELETE', '/api/files/' + file.id).then(function() {
                state.files = state.files.filter(function(f) { return f.id !== file.id; });
                deselectFile();
                if (isMobile()) forceExitMobileEditing();
                showToast('文件已删除', 'success');
              }).catch(function(e) {
                showToast('删除失败: ' + e.message, 'error');
              });
            }},
          ],
        });
      }

      function deleteFileById(fileId) {
        var file = state.files.find(function(f) { return f.id === fileId; });
        if (!file) return;
        showModal({
          title: '确认删除',
          body: '确定要删除文件 <span class="file-name">' + (file.title || file.filename) + '</span> 吗？此操作不可撤销。',
          actions: [
            { label: '取消', className: 'btn-ghost' },
            { label: '删除', className: 'btn-danger', onClick: function() {
              apiRequest('DELETE', '/api/files/' + fileId).then(function() {
                state.files = state.files.filter(function(f) { return f.id !== fileId; });
                if (state.selectedFileId === fileId) {
                  deselectFile();
                  if (isMobile()) forceExitMobileEditing();
                }
                renderFileList(dom.searchInput.value);
                showToast('文件已删除', 'success');
              }).catch(function(e) {
                showToast('删除失败: ' + e.message, 'error');
              });
            }},
          ],
        });
      }

      /* ============================================================
         Import / Export
         ============================================================ */
      function exportData() {
        window.location.href = '/api/export';
      }

      function importData() {
        dom.importFileInput.click();
      }

      function handleImportFile(event) {
        var file = event.target.files[0];
        if (!file) return;
        var reader = new FileReader();
        reader.onload = function(e) {
          try {
            var jsonData = JSON.parse(e.target.result);
            apiRequest('POST', '/api/import', jsonData).then(function(result) {
              return loadFiles().then(function() {
                var resultEl = document.createElement('div');
                resultEl.className = 'import-result';
                var parts = [];
                if (result.imported > 0) parts.push('<div class="result-success">+ 成功导入 ' + result.imported + ' 个文件</div>');
                if (result.skipped > 0) parts.push('<div class="result-warning">! 跳过 ' + result.skipped + ' 个文件（文件名冲突）</div>');
                if (result.failed > 0) parts.push('<div class="result-error">x 失败 ' + result.failed + ' 个文件（解码错误）</div>');
                resultEl.innerHTML = parts.join('');
                showModal({
                  title: '导入完成',
                  body: resultEl,
                  actions: [{ label: '确定', className: 'btn-primary' }],
                });
              });
            }).catch(function(e) {
              showToast('导入失败: ' + e.message, 'error');
            });
          } catch (err) {
            showToast('JSON 解析失败', 'error');
          }
        };
        reader.readAsText(file);
        event.target.value = '';
      }

      /* ============================================================
         Copy URL
         ============================================================ */
      function copyFileUrl(filename) {
        if (!filename) {
          filename = dom.filenameInput ? dom.filenameInput.value.trim() : '';
        }
        if (!filename) { showToast('文件名为空', 'warning'); return; }
        var url = window.location.origin + '/f/' + filename;
        navigator.clipboard.writeText(url).then(function() {
          if (dom.btnCopyUrl) {
            dom.btnCopyUrl.classList.add('copied');
            setTimeout(function() { dom.btnCopyUrl.classList.remove('copied'); }, 1500);
          }
          showToast('访问链接已复制', 'success');
        }).catch(function() {
          showToast('复制失败', 'error');
        });
      }

      /* ============================================================
         Mobile Sidebar
         ============================================================ */
      function openSidebar() {
        state.sidebarOpen = true;
        dom.sidebar.classList.add('open');
        dom.sidebarOverlay.classList.add('active');
        requestAnimationFrame(function() { dom.sidebarOverlay.classList.add('visible'); });
      }

      function closeSidebar() {
        state.sidebarOpen = false;
        dom.sidebar.classList.remove('open');
        dom.sidebarOverlay.classList.remove('visible');
        setTimeout(function() { dom.sidebarOverlay.classList.remove('active'); }, 200);
      }

      function enterMobileEditing() {
        state.isMobileEditing = true;
        document.body.classList.add('mobile-editing');
        requestAnimationFrame(function() { if (aceEditor) aceEditor.resize(); });
      }

      function exitMobileEditing() {
        if (state.isDirty) {
          showModal({
            title: '未保存的更改',
            body: '当前文件有未保存的更改，是否放弃？',
            actions: [
              { label: '取消', className: 'btn-ghost' },
              { label: '放弃更改', className: 'btn-danger', onClick: function() {
                state.isDirty = false;
                forceExitMobileEditing();
              }},
            ],
          });
          return;
        }
        forceExitMobileEditing();
      }

      function forceExitMobileEditing() {
        state.isMobileEditing = false;
        document.body.classList.remove('mobile-editing');
        deselectFile();
      }

      /* ============================================================
         Event Binding
         ============================================================ */
      function bindEvents() {
        dom.btnMenu.addEventListener('click', function() {
          if (state.sidebarOpen) closeSidebar(); else openSidebar();
        });
        dom.btnBack.addEventListener('click', exitMobileEditing);
        dom.btnTheme.addEventListener('click', toggleTheme);
        dom.btnExport.addEventListener('click', exportData);
        dom.btnImport.addEventListener('click', importData);
        dom.btnLogout.addEventListener('click', function() {
          fetch('/api/logout', { method: 'POST' }).then(function() {
            window.location.reload();
          });
        });
        dom.importFileInput.addEventListener('change', handleImportFile);
        dom.sidebarOverlay.addEventListener('click', closeSidebar);

        dom.searchInput.addEventListener('input', function() {
          renderFileList(dom.searchInput.value);
        });

        dom.btnNewFile.addEventListener('click', createNewFile);

        dom.fileList.addEventListener('click', function(e) {
          var actionBtn = e.target.closest('.file-item-btn');
          if (actionBtn) {
            e.stopPropagation();
            var action = actionBtn.dataset.action;
            if (action === 'copy') copyFileUrl(actionBtn.dataset.filename);
            else if (action === 'delete') deleteFileById(actionBtn.dataset.fileId);
            return;
          }
          var item = e.target.closest('.file-item');
          if (item) selectFile(item.dataset.id);
        });

        dom.fileList.addEventListener('keydown', function(e) {
          if (e.key === 'Enter') {
            var item = e.target.closest('.file-item');
            if (item) selectFile(item.dataset.id);
          }
        });

        aceEditor.on('change', function() { updateStats(); checkDirty(); });
        dom.titleInput.addEventListener('input', checkDirty);
        dom.filenameInput.addEventListener('input', function() {
          checkDirty();
          if (aceEditor) aceEditor.session.setMode(detectAceMode(dom.filenameInput.value));
        });

        dom.btnSave.addEventListener('click', saveFile);
        dom.btnRefresh.addEventListener('click', refreshFile);
        dom.btnDelete.addEventListener('click', deleteFile);
        dom.btnCopyUrl.addEventListener('click', function() { copyFileUrl(); });
        dom.btnFormat.addEventListener('click', formatContent);

        document.addEventListener('keydown', function(e) {
          if ((e.ctrlKey || e.metaKey) && e.key === 's') {
            e.preventDefault();
            if (state.selectedFileId) saveFile();
          }
        });

        window.addEventListener('beforeunload', function(e) {
          if (state.isDirty) { e.preventDefault(); e.returnValue = ''; }
        });

        dom.modalBackdrop.addEventListener('click', function(e) {
          if (e.target === dom.modalBackdrop) hideModal();
        });

        var mobileQuery = window.matchMedia('(max-width: 767px)');
        mobileQuery.addEventListener('change', function(e) {
          if (!e.matches && state.isMobileEditing) {
            document.body.classList.remove('mobile-editing');
            state.isMobileEditing = false;
          }
          if (!e.matches && state.sidebarOpen) closeSidebar();
        });
      }

      /* ============================================================
         Initialize
         ============================================================ */
      function init() {
        initTheme();
        initAceEditor();
        bindEvents();
        lucide.createIcons();

        loadFiles().then(function() {
          if (!isMobile() && state.files.length > 0) {
            var sorted = state.files.slice().sort(function(a, b) {
              return new Date(b.updatedAt) - new Date(a.updatedAt);
            });
            forceSelectFile(sorted[0].id);
          }
        });
      }

      document.addEventListener('DOMContentLoaded', init);
    </script>
  </body>
</html>`;
}

// ============================================================
// Main Handler
// ============================================================

export default {
  async fetch(request, env) {
    var url = new URL(request.url);
    var pathname = url.pathname;
    var method = request.method;

    // CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        },
      });
    }

    // Public file access - no auth
    if (pathname.startsWith('/f/')) {
      return handlePublicFile(pathname, env);
    }

    // Login/logout - no auth needed
    if (pathname === '/api/login' && method === 'POST') {
      return handleLogin(request, env);
    }
    if (pathname === '/api/logout' && method === 'POST') {
      return handleLogout();
    }

    // API routes - need auth
    if (pathname.startsWith('/api/')) {
      if (!(await authenticate(request, env))) {
        return errorResponse('Unauthorized', 401);
      }
      return handleApi(pathname, method, request, env);
    }

    // Admin page
    if (pathname === '/' || pathname === '') {
      if (!(await authenticate(request, env))) {
        return new Response(getLoginHTML(), {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }
      return new Response(getAdminHTML(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    return errorResponse('Not Found', 404);
  },
};
