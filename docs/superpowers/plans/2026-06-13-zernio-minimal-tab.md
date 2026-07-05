# Zernio Minimal Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new `Zernio` tab to `public/index.html` that lets users save a Zernio API key, test the connection, load one account, and create a post as draft, schedule, or publish-now using a media URL.

**Architecture:** Reuse the existing Repliz visual system but keep Zernio isolated as its own tab and backend proxy route. Frontend stays in `public/app.js`, backend gets a new focused `routes/zernio.js` module mounted from `server.js`, and the browser never talks to Zernio directly.

**Tech Stack:** Express, native `fetch` in browser, native `https` in Node, existing app CSS/classes in `public/index.html`, localStorage for frontend-only credential persistence.

---

## File Structure

### Existing files to modify
- `public/index.html`
  - Add new nav button `tabBtnZernio`
  - Add new content panel `tabZernio`
  - Reuse existing visual classes like `yt-container`, `rz-glass-card`, `rz-section-title`, `rz-form-input`, `rz-form-textarea`, `rz-btn`
- `public/app.js`
  - Extend `switchTab(...)` mapping to support `zernio`
  - Add Zernio state, credential restore, account loading, action switching, submit flow, and status rendering
- `server.js`
  - Mount new `routes/zernio.js` module

### New files to create
- `routes/zernio.js`
  - Owns Zernio backend proxy logic
  - Exposes `GET /api/zernio/accounts`
  - Exposes `POST /api/zernio/posts`
  - Handles bearer auth injection, request normalization, timeout/error handling, and response normalization

### Verification files / commands
- No existing automated test suite was discovered for this area, so verification is command-driven:
  - `node --check public/app.js`
  - `node --check routes/zernio.js`
  - `node --check server.js`
  - `lsp_diagnostics` for `public/app.js`, `public/index.html`, `routes/zernio.js`, `server.js`

---

### Task 1: Add backend Zernio proxy route

**Files:**
- Create: `routes/zernio.js`
- Modify: `server.js:188-194`
- Test: manual endpoint checks via browser or `Invoke-WebRequest`

- [ ] **Step 1: Write the route module skeleton**

Create `routes/zernio.js` with exact starting structure:

```js
const express = require('express');
const https = require('https');
const { URL } = require('url');

const router = express.Router();
const ZERNIO_API_BASE = 'https://zernio.com/api/v1';
const ZERNIO_TIMEOUT_MS = 60000;

function getApiKey(req) {
  const fromHeader = String(req.headers['x-zernio-api-key'] || '').trim();
  const fromBody = String((req.body && req.body.apiKey) || '').trim();
  return fromHeader || fromBody;
}

function requireApiKey(req) {
  const apiKey = getApiKey(req);
  if (!apiKey) {
    const err = new Error('Zernio API key wajib diisi');
    err.statusCode = 400;
    throw err;
  }
  return apiKey;
}

function normalizeErrorMessage(statusCode, bodyText) {
  const preview = String(bodyText || '').replace(/\s+/g, ' ').trim().slice(0, 220);
  if (statusCode === 401 || statusCode === 403) return 'API key tidak valid atau akses ditolak';
  if (statusCode === 404) return 'Endpoint Zernio tidak ditemukan';
  return `Zernio API error (${statusCode}): ${preview || 'Unknown error'}`;
}

function requestZernio(pathname, { method = 'GET', apiKey, body = null } = {}) {
  const url = new URL(pathname, ZERNIO_API_BASE);
  const payload = body ? JSON.stringify(body) : null;

  return new Promise((resolve, reject) => {
    const req = https.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method,
      headers: Object.assign({
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json'
      }, payload ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      } : {})
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        const statusCode = Number(res.statusCode || 0);
        if (statusCode < 200 || statusCode >= 300) {
          const error = new Error(normalizeErrorMessage(statusCode, data));
          error.statusCode = statusCode >= 400 && statusCode < 600 ? statusCode : 502;
          return reject(error);
        }
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch (err) {
          const parseError = new Error('Response Zernio bukan JSON valid');
          parseError.statusCode = 502;
          reject(parseError);
        }
      });
    });

    req.setTimeout(ZERNIO_TIMEOUT_MS, () => {
      req.destroy(new Error('Zernio API timeout (60s)'));
    });

    req.on('error', (err) => {
      const error = new Error(err.message || 'Zernio request failed');
      error.statusCode = err.message && err.message.includes('timeout') ? 504 : 502;
      reject(error);
    });

    if (payload) req.write(payload);
    req.end();
  });
}

module.exports = router;
```

- [ ] **Step 2: Add failing/manual endpoint placeholders**

Append temporary handlers that deliberately return not-implemented, so route wiring can be proven before full logic:

```js
router.get('/api/zernio/accounts', async (req, res) => {
  res.status(501).json({ status: 'error', error: 'not implemented yet' });
});

router.post('/api/zernio/posts', async (req, res) => {
  res.status(501).json({ status: 'error', error: 'not implemented yet' });
});
```

- [ ] **Step 3: Mount route in server**

Modify `server.js` route section to include the new module:

```js
const youtubeCutterRoutes = require('./routes/youtube-cutter');
const videoCropperRoutes = require('./routes/video-cropper');
const zernioRoutes = require('./routes/zernio');
app.use(youtubeCutterRoutes);
app.use(videoCropperRoutes);
app.use('/', require('./routes/video-share'));
app.use(zernioRoutes);
```

- [ ] **Step 4: Run syntax verification**

Run:

```powershell
node --check "routes/zernio.js"; if ($?) { node --check "server.js" }
```

Expected: no output

- [ ] **Step 5: Commit**

```bash
git add routes/zernio.js server.js
git commit -m "feat: add zernio proxy skeleton"
```

---

### Task 2: Implement account loading endpoint

**Files:**
- Modify: `routes/zernio.js`
- Test: `GET /api/zernio/accounts`

- [ ] **Step 1: Replace placeholder with real account loader**

Replace the temporary `GET /api/zernio/accounts` handler with:

```js
function normalizeAccountsResponse(data) {
  const list = Array.isArray(data.accounts) ? data.accounts
    : Array.isArray(data.data) ? data.data
    : Array.isArray(data.docs) ? data.docs
    : Array.isArray(data.results) ? data.results
    : [];

  return list.map((item) => ({
    id: item.id || item._id || item.account_id || '',
    name: item.name || item.username || item.handle || 'Untitled Account',
    platform: String(item.platform || item.type || item.channel || '').toLowerCase(),
    raw: item
  })).filter((item) => item.id);
}

router.get('/api/zernio/accounts', async (req, res) => {
  try {
    const apiKey = requireApiKey(req);
    const upstream = await requestZernio('/accounts', { method: 'GET', apiKey });
    const accounts = normalizeAccountsResponse(upstream);
    res.json({ status: 'ok', accounts });
  } catch (error) {
    console.error('[ZERNIO ACCOUNTS]', error.message);
    res.status(error.statusCode || 500).json({ status: 'error', error: error.message });
  }
});
```

- [ ] **Step 2: Run syntax verification**

Run:

```powershell
node --check "routes/zernio.js"
```

Expected: no output

- [ ] **Step 3: Run diagnostics**

Run `lsp_diagnostics` on `routes/zernio.js`

Expected: no errors

- [ ] **Step 4: Manual endpoint smoke test**

Run after server restart with a real key substituted:

```powershell
Invoke-WebRequest -UseBasicParsing -Headers @{ 'x-zernio-api-key' = 'PASTE_REAL_KEY' } -Uri "http://localhost:3000/api/zernio/accounts" | Select-Object -ExpandProperty Content
```

Expected: JSON with shape like:

```json
{"status":"ok","accounts":[{"id":"...","name":"...","platform":"..."}]}
```

If invalid key used, expected error JSON should include `API key tidak valid atau akses ditolak`.

- [ ] **Step 5: Commit**

```bash
git add routes/zernio.js
git commit -m "feat: load zernio accounts"
```

---

### Task 3: Implement Zernio post creation endpoint

**Files:**
- Modify: `routes/zernio.js`
- Test: `POST /api/zernio/posts`

- [ ] **Step 1: Add payload builder helpers**

Insert these helpers above the `POST /api/zernio/posts` handler:

```js
function normalizeAction(action) {
  const value = String(action || '').trim().toLowerCase();
  if (value === 'draft') return 'draft';
  if (value === 'schedule') return 'schedule';
  if (value === 'publish_now' || value === 'publish-now' || value === 'publish now') return 'publish_now';
  return '';
}

function buildPostPayload(input) {
  const action = normalizeAction(input.action);
  const accountId = String(input.accountId || '').trim();
  const title = String(input.title || '').trim();
  const caption = String(input.caption || '').trim();
  const mediaUrl = String(input.mediaUrl || '').trim();
  const scheduledAt = String(input.scheduledAt || '').trim();

  if (!accountId) {
    const err = new Error('Account wajib dipilih');
    err.statusCode = 400;
    throw err;
  }
  if (!mediaUrl) {
    const err = new Error('Media URL wajib diisi');
    err.statusCode = 400;
    throw err;
  }
  if (!action) {
    const err = new Error('Action harus draft, schedule, atau publish_now');
    err.statusCode = 400;
    throw err;
  }
  if (action === 'schedule' && !scheduledAt) {
    const err = new Error('Waktu schedule wajib diisi');
    err.statusCode = 400;
    throw err;
  }

  const body = {
    account_id: accountId,
    title,
    caption,
    media_urls: [mediaUrl]
  };

  if (action === 'schedule') {
    body.schedule_at = new Date(scheduledAt).toISOString();
  }

  return { action, body };
}

function getPostEndpoint(action) {
  if (action === 'draft') return '/posts/draft';
  if (action === 'schedule') return '/posts/schedule';
  return '/posts/publish-now';
}
```

- [ ] **Step 2: Replace placeholder post handler**

Replace the temporary `POST /api/zernio/posts` handler with:

```js
router.post('/api/zernio/posts', async (req, res) => {
  try {
    const apiKey = requireApiKey(req);
    const built = buildPostPayload(req.body || {});
    const upstream = await requestZernio(getPostEndpoint(built.action), {
      method: 'POST',
      apiKey,
      body: built.body
    });

    res.json({
      status: 'ok',
      action: built.action,
      result: upstream
    });
  } catch (error) {
    console.error('[ZERNIO POSTS]', error.message);
    res.status(error.statusCode || 500).json({ status: 'error', error: error.message });
  }
});
```

- [ ] **Step 3: Run syntax verification**

Run:

```powershell
node --check "routes/zernio.js"
```

Expected: no output

- [ ] **Step 4: Manual draft endpoint test**

Run with real values substituted:

```powershell
Invoke-WebRequest -UseBasicParsing -Method POST -Uri "http://localhost:3000/api/zernio/posts" -ContentType "application/json" -Body '{"apiKey":"PASTE_REAL_KEY","accountId":"PASTE_ACCOUNT_ID","title":"Test draft","caption":"Test caption","mediaUrl":"https://example.com/video.mp4","action":"draft"}' | Select-Object -ExpandProperty Content
```

Expected: JSON with `"status":"ok"` and `"action":"draft"`

- [ ] **Step 5: Manual schedule endpoint test**

Run with a future datetime:

```powershell
Invoke-WebRequest -UseBasicParsing -Method POST -Uri "http://localhost:3000/api/zernio/posts" -ContentType "application/json" -Body '{"apiKey":"PASTE_REAL_KEY","accountId":"PASTE_ACCOUNT_ID","title":"Test schedule","caption":"Test caption","mediaUrl":"https://example.com/video.mp4","action":"schedule","scheduledAt":"2026-06-14T10:30"}' | Select-Object -ExpandProperty Content
```

Expected: JSON with `"status":"ok"` and `"action":"schedule"`

- [ ] **Step 6: Commit**

```bash
git add routes/zernio.js
git commit -m "feat: create zernio posts via proxy"
```

---

### Task 4: Add Zernio tab markup to frontend

**Files:**
- Modify: `public/index.html`
- Test: browser load + tab switching

- [ ] **Step 1: Add nav button**

In the main nav near `tabBtnRepliz`, add:

```html
<button class="tab-btn" id="tabBtnZernio" onclick="switchTab('zernio')">
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M12 2v20" />
    <path d="M17 5H9a4 4 0 0 0 0 8h6a4 4 0 0 1 0 8H7" />
  </svg>
  Zernio
</button>
```

- [ ] **Step 2: Add tab panel markup after Repliz section**

Add this full section before the convert modal script area:

```html
<div id="tabZernio" class="tab-content">
  <div class="yt-container" style="max-width:960px">
    <div class="rz-glass-card" style="margin-bottom:20px">
      <div class="rz-section-title">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
        Zernio API Key
      </div>
      <p style="font-size:12px;color:var(--text-muted);margin-bottom:16px">Masukkan API key Zernio. Dipakai untuk load account dan create post draft/schedule/publish now.</p>
      <div class="form-group" style="margin:0">
        <label class="rz-form-label">API Key</label>
        <input type="password" id="zernioApiKey" placeholder="Enter your Zernio API key" class="rz-form-input">
      </div>
      <div style="display:flex;gap:10px;margin-top:14px;flex-wrap:wrap">
        <button class="rz-btn rz-btn-primary" onclick="zernioSaveCredentials()" id="zernioSaveBtn">Save API Key</button>
        <button class="rz-btn rz-btn-secondary" onclick="zernioTestConnection()" id="zernioTestBtn">Test Connection</button>
      </div>
      <div id="zernioConnectionStatus" style="margin-top:10px;font-size:0.78rem;text-align:center;color:var(--text-muted)"></div>
    </div>

    <div class="rz-glass-card">
      <div class="rz-section-title">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
        </svg>
        Zernio Composer
      </div>
      <div class="form-group">
        <label class="rz-form-label">Account</label>
        <select id="zernioAccountSelect" class="rz-form-input">
          <option value="">Load accounts first</option>
        </select>
      </div>
      <div class="form-group">
        <label class="rz-form-label">Title</label>
        <input type="text" id="zernioPostTitle" placeholder="Enter your post title..." class="rz-form-input">
      </div>
      <div class="form-group">
        <label class="rz-form-label">Caption</label>
        <textarea id="zernioPostCaption" rows="5" placeholder="Write your post caption..." class="rz-form-textarea"></textarea>
      </div>
      <div class="form-group">
        <label class="rz-form-label">Media URL</label>
        <input type="url" id="zernioMediaUrl" placeholder="https://example.com/video.mp4" class="rz-form-input">
        <div class="rz-form-hint">Zernio v1 pakai direct media URL, bukan upload file.</div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
        <div class="form-group">
          <label class="rz-form-label">Action</label>
          <select id="zernioActionSelect" class="rz-form-input" onchange="zernioOnActionChange()">
            <option value="draft">Draft</option>
            <option value="schedule">Schedule</option>
            <option value="publish_now">Publish Now</option>
          </select>
        </div>
        <div class="form-group hidden" id="zernioScheduleGroup">
          <label class="rz-form-label">Schedule Time</label>
          <input type="datetime-local" id="zernioScheduleAt" class="rz-form-input">
        </div>
      </div>
      <button class="rz-btn rz-btn-primary rz-btn-lg" onclick="zernioCreatePost()" id="zernioCreateBtn" style="width:100%;margin-top:8px">Create Zernio Post</button>
      <div id="zernioPostStatus" style="margin-top:12px;font-size:0.82rem;color:var(--text-muted)"></div>
    </div>
  </div>
</div>
```

- [ ] **Step 3: Read back the new section to verify IDs**

Read `public/index.html` around the inserted nav and tab block.
Expected IDs to exist exactly once:
- `tabBtnZernio`
- `tabZernio`
- `zernioApiKey`
- `zernioAccountSelect`
- `zernioActionSelect`
- `zernioScheduleGroup`
- `zernioCreateBtn`

- [ ] **Step 4: Commit**

```bash
git add public/index.html
git commit -m "feat: add zernio tab markup"
```

---

### Task 5: Add frontend Zernio state, credential restore, and tab switching

**Files:**
- Modify: `public/app.js`
- Test: browser tab switching + persisted API key

- [ ] **Step 1: Extend tab mapping**

Change the `switchTab(...)` maps at top of `public/app.js` to:

```js
var tabMap = { cutter: 'tabCutter', bulk: 'tabBulk', cropper: 'tabCropper', repliz: 'tabRepliz', zernio: 'tabZernio' };
var btnMap = { cutter: 'tabBtnCutter', bulk: 'tabBtnBulk', cropper: 'tabBtnCropper', repliz: 'tabBtnRepliz', zernio: 'tabBtnZernio' };
```

- [ ] **Step 2: Add Zernio state and helper functions**

Insert this block before the Repliz section comment:

```js
// ============================================
//  TAB 4: ZERNIO
// ============================================
var _zernioAccounts = [];
var _zernioSelectedAction = 'draft';

function zernioGetApiKey() {
    return (localStorage.getItem('zernio_api_key') || '').trim();
}

function zernioSetStatus(message, type) {
    var el = document.getElementById('zernioPostStatus');
    if (!el) return;
    var color = type === 'error' ? '#ef4444' : type === 'success' ? 'var(--accent-green)' : 'var(--text-muted)';
    el.innerHTML = '<span style="color:' + color + '">' + message + '</span>';
}

function zernioSetConnectionStatus(message, type) {
    var el = document.getElementById('zernioConnectionStatus');
    if (!el) return;
    var color = type === 'error' ? '#ef4444' : type === 'success' ? 'var(--accent-green)' : 'var(--text-muted)';
    el.innerHTML = '<span style="color:' + color + '">' + message + '</span>';
}

function zernioSaveCredentials() {
    var input = document.getElementById('zernioApiKey');
    var apiKey = input ? input.value.trim() : '';
    if (!apiKey) {
        alert('Masukkan API key Zernio');
        return;
    }
    localStorage.setItem('zernio_api_key', apiKey);
    zernioSetConnectionStatus('✅ API key tersimpan', 'success');
}

function zernioRestoreCredentials() {
    var input = document.getElementById('zernioApiKey');
    var apiKey = zernioGetApiKey();
    if (input && apiKey) input.value = apiKey;
    if (apiKey) zernioSetConnectionStatus('● API key tersimpan', 'success');
}

function zernioRenderAccounts(accounts) {
    var select = document.getElementById('zernioAccountSelect');
    if (!select) return;
    var list = Array.isArray(accounts) ? accounts : [];
    if (!list.length) {
        select.innerHTML = '<option value="">No accounts found</option>';
        return;
    }
    select.innerHTML = '<option value="">Choose one account</option>' + list.map(function (item) {
        var label = item.platform ? (item.name + ' (' + item.platform + ')') : item.name;
        return '<option value="' + item.id + '">' + label + '</option>';
    }).join('');
}

function zernioOnActionChange() {
    var select = document.getElementById('zernioActionSelect');
    var group = document.getElementById('zernioScheduleGroup');
    _zernioSelectedAction = select ? (select.value || 'draft') : 'draft';
    if (group) group.classList.toggle('hidden', _zernioSelectedAction !== 'schedule');
}

zernioRestoreCredentials();
```

- [ ] **Step 3: Run syntax verification**

Run:

```powershell
node --check "public/app.js"
```

Expected: no output

- [ ] **Step 4: Browser smoke test**

Expected behavior after reload:
- Clicking `Zernio` tab shows its panel
- Saving API key persists after page reload
- Schedule field only appears when action = `schedule`

- [ ] **Step 5: Commit**

```bash
git add public/app.js
git commit -m "feat: add zernio frontend state"
```

---

### Task 6: Implement frontend connection test and account loading

**Files:**
- Modify: `public/app.js`
- Test: Zernio tab test-connection flow

- [ ] **Step 1: Add connection fetch helper and loader**

Append these functions inside the Zernio section:

```js
async function zernioFetch(path, opts) {
    var apiKey = zernioGetApiKey();
    if (!apiKey) throw new Error('API key Zernio belum disimpan');
    var options = Object.assign({}, opts || {});
    options.headers = Object.assign({}, options.headers || {}, {
        'x-zernio-api-key': apiKey
    });
    var resp = await fetch(path, options);
    var data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Zernio request failed');
    return data;
}

async function zernioLoadAccounts() {
    var data = await zernioFetch('/api/zernio/accounts');
    _zernioAccounts = data.accounts || [];
    zernioRenderAccounts(_zernioAccounts);
    return _zernioAccounts;
}

async function zernioTestConnection() {
    var btn = document.getElementById('zernioTestBtn');
    if (btn) {
        btn.disabled = true;
        btn.textContent = '⏳ Testing...';
    }
    zernioSetConnectionStatus('Testing connection...', 'info');
    try {
        var accounts = await zernioLoadAccounts();
        zernioSetConnectionStatus('✅ Connected! Found ' + accounts.length + ' account(s)', 'success');
    } catch (e) {
        zernioSetConnectionStatus('❌ ' + e.message, 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = 'Test Connection';
        }
    }
}
```

- [ ] **Step 2: Run syntax verification**

Run:

```powershell
node --check "public/app.js"
```

Expected: no output

- [ ] **Step 3: Run diagnostics**

Run `lsp_diagnostics` on `public/app.js`

Expected: no errors

- [ ] **Step 4: Browser smoke test**

Expected behavior:
- click `Save API Key`
- click `Test Connection`
- status updates to success or clear auth error
- account dropdown populates with one or more options if API key valid

- [ ] **Step 5: Commit**

```bash
git add public/app.js
git commit -m "feat: load zernio accounts in ui"
```

---

### Task 7: Implement frontend post submit flow

**Files:**
- Modify: `public/app.js`
- Test: draft / schedule / publish-now submit

- [ ] **Step 1: Add submit handler**

Append this function in the Zernio section:

```js
async function zernioCreatePost() {
    var accountId = document.getElementById('zernioAccountSelect').value;
    var title = document.getElementById('zernioPostTitle').value.trim();
    var caption = document.getElementById('zernioPostCaption').value.trim();
    var mediaUrl = document.getElementById('zernioMediaUrl').value.trim();
    var scheduledAt = document.getElementById('zernioScheduleAt').value;
    var action = document.getElementById('zernioActionSelect').value || 'draft';
    var btn = document.getElementById('zernioCreateBtn');

    if (!zernioGetApiKey()) {
        alert('Simpan API key Zernio terlebih dahulu');
        return;
    }
    if (!accountId) {
        alert('Pilih 1 account Zernio');
        return;
    }
    if (!mediaUrl) {
        alert('Media URL wajib diisi');
        return;
    }
    if (action === 'schedule' && !scheduledAt) {
        alert('Waktu schedule wajib diisi');
        return;
    }

    btn.disabled = true;
    btn.textContent = action === 'draft' ? 'Creating Draft...' : action === 'schedule' ? 'Scheduling...' : 'Publishing...';
    zernioSetStatus('Mengirim request ke Zernio...', 'info');

    try {
        var resp = await fetch('/api/zernio/posts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                apiKey: zernioGetApiKey(),
                accountId: accountId,
                title: title,
                caption: caption,
                mediaUrl: mediaUrl,
                action: action,
                scheduledAt: scheduledAt
            })
        });
        var data = await resp.json();
        if (!resp.ok) throw new Error(data.error || 'Gagal create post');

        zernioSetStatus('✅ Success: action `' + data.action + '` berhasil dikirim ke Zernio', 'success');
        document.getElementById('zernioPostTitle').value = '';
        document.getElementById('zernioPostCaption').value = '';
        document.getElementById('zernioMediaUrl').value = '';
        document.getElementById('zernioScheduleAt').value = '';
        document.getElementById('zernioActionSelect').value = 'draft';
        zernioOnActionChange();
    } catch (e) {
        zernioSetStatus('❌ ' + e.message, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Create Zernio Post';
    }
}
```

- [ ] **Step 2: Run syntax verification**

Run:

```powershell
node --check "public/app.js"
```

Expected: no output

- [ ] **Step 3: Manual draft submit test**

Expected in browser:
- choose account
- fill media URL
- action `Draft`
- click submit
- success status appears

- [ ] **Step 4: Manual schedule submit test**

Expected in browser:
- choose action `Schedule`
- datetime field appears
- submit with future time
- success status appears

- [ ] **Step 5: Manual publish-now submit test**

Expected in browser:
- choose action `Publish Now`
- datetime field hidden
- submit succeeds or returns clear upstream error

- [ ] **Step 6: Commit**

```bash
git add public/app.js
git commit -m "feat: submit zernio posts from ui"
```

---

### Task 8: Full verification and regression check

**Files:**
- Verify: `public/index.html`, `public/app.js`, `routes/zernio.js`, `server.js`

- [ ] **Step 1: Run all syntax checks**

Run:

```powershell
node --check "public/app.js"; if ($?) { node --check "routes/zernio.js" }; if ($?) { node --check "server.js" }
```

Expected: no output

- [ ] **Step 2: Run diagnostics**

Run `lsp_diagnostics` for:
- `D:\ocprojek\gabungan\public\app.js`
- `D:\ocprojek\gabungan\public\index.html`
- `D:\ocprojek\gabungan\routes\zernio.js`
- `D:\ocprojek\gabungan\server.js`

Expected: no errors

- [ ] **Step 3: Regression smoke test Repliz tab**

In browser, verify:
- `Repliz` tab still opens
- `Test Connection` button still exists
- create form still shows media upload zone
- no JS error when switching `Cutter → Repliz → Zernio → Repliz`

- [ ] **Step 4: Regression smoke test table-share draft bridge**

Expected:
- loading `index.html` with `repliz_table_share_draft` in localStorage still routes to Repliz flow
- Zernio additions do not break `consumeTableShareDraftToRepliz()`

- [ ] **Step 5: Final commit**

```bash
git add public/index.html public/app.js routes/zernio.js server.js
git commit -m "feat: add zernio posting tab"
```

---

## Self-review

### Spec coverage check
- New Zernio tab in `index.html` → Task 4
- Separate tab approach, reusing existing visual system → Tasks 4 and 8
- Single account selector → Tasks 4, 6, 7
- Save API key + test connection → Tasks 5 and 6
- Draft / schedule / publish now in one form → Tasks 3, 4, 7
- Backend proxy route(s) → Tasks 1, 2, 3
- No Repliz regressions → Task 8

No spec gaps found.

### Placeholder scan
- No `TBD`, `TODO`, or “implement later” placeholders remain.
- Every code-changing step contains concrete code.
- Every verification step contains concrete commands or exact browser behaviors.

### Type / naming consistency
- Frontend IDs and function names are consistent across tasks:
  - `tabBtnZernio`, `tabZernio`
  - `zernioApiKey`, `zernioAccountSelect`, `zernioActionSelect`, `zernioScheduleGroup`, `zernioCreateBtn`
  - `zernioSaveCredentials`, `zernioTestConnection`, `zernioLoadAccounts`, `zernioOnActionChange`, `zernioCreatePost`
- Backend endpoints consistent across tasks:
  - `GET /api/zernio/accounts`
  - `POST /api/zernio/posts`

## Notes before implementation
- If Zernio docs use a different accounts endpoint or post payload shape, keep frontend contract unchanged and adjust only `routes/zernio.js`.
- If `public/index.html` LSP diagnostics are unavailable due local HTML tooling, syntax/readback verification still required.
- Commit steps are listed because the planning skill requires atomic checkpoints, but only execute commits if explicitly allowed in the working session.
