# Auto Publish Table Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically change `tabel share video` row status from `pending` to `publish` after a successful submit to Repliz or Zernio, but only for flows that originated from table action buttons.

**Architecture:** Reuse the existing table handoff mechanism through `localStorage` drafts and the existing backend `PATCH /api/video-share/status` endpoint. Extend the draft payload with the row `link`, keep a small runtime marker in `public/app.js`, and call the status-update helper only after provider submit success. If table status update fails, surface a warning without downgrading the posting success.

**Tech Stack:** Express, vanilla JavaScript, existing Google Apps Script-backed table API, browser `localStorage`, existing Repliz and Zernio frontend flows.

---

## File map

- **Modify:** `public/tabel-share-video.html`
  - Add `link` into both Repliz and Zernio draft payloads sent to `index.html`.
- **Modify:** `public/app.js`
  - Add runtime helper/state for “draft came from table”.
  - Update Repliz draft consumer and Zernio draft consumer to persist `link`.
  - Add helper to call `PATCH /api/video-share/status` with `status: 'publish'`.
  - Hook helper into Repliz success path and Zernio success path.
  - Reset runtime marker after use so manual submits do not update old rows.
- **Verify only:** `routes/video-share.js`
  - Confirm `PATCH /api/video-share/status` already accepts `{ link, status }` and allowed value `publish`.

---

### Task 1: Verify backend status endpoint contract

**Files:**
- Modify: none expected
- Verify: `routes/video-share.js`

- [ ] **Step 1: Read the existing status update endpoint contract**

Read and confirm in `routes/video-share.js` that the existing route:
- path is `PATCH /api/video-share/status`
- accepts `link`
- accepts `status`
- allows `publish`
- forwards to Apps Script action `update_status`

Expected relevant shape:

```js
router.patch('/api/video-share/status', async (req, res) => {
  const { link, status } = req.body || {};
  const normalizedStatus = String(status || '').trim().toLowerCase();
  if (!link) return res.status(400).json({ status: 'error', error: 'link wajib diisi' });
  if (!['pending', 'upload', 'publish'].includes(normalizedStatus)) {
    return res.status(400).json({ status: 'error', error: 'status harus pending, upload, atau publish' });
  }
  // forward to Apps Script
});
```

- [ ] **Step 2: Confirm no backend code change is needed**

Decision gate:
- If route already matches the contract above, do not edit `routes/video-share.js`.
- If route differs, make the smallest change needed so `publish` updates by `link` work.

Expected outcome: no backend code change, only verification note.

- [ ] **Step 3: Record verification command for later**

Run later during final verification:

```powershell
node --check "routes/video-share.js"
```

Expected: no output.

---

### Task 2: Extend table handoff payloads with row link

**Files:**
- Modify: `public/tabel-share-video.html:124-166`
- Test: manual handoff via browser flow

- [ ] **Step 1: Update Repliz draft payload to include `link`**

Change the `queueRowToRepliz(encodedRow)` payload written to `localStorage`.

Current target shape:

```js
localStorage.setItem('repliz_table_share_draft', JSON.stringify({
  mediaUrl: row.link || '',
  title: row.title || '',
  caption: row.caption || ''
}));
```

Replace with:

```js
localStorage.setItem('repliz_table_share_draft', JSON.stringify({
  source: 'table-share',
  link: row.link || '',
  mediaUrl: row.link || '',
  title: row.title || '',
  caption: row.caption || ''
}));
```

- [ ] **Step 2: Update Zernio draft payload to include `link`**

Change the `queueRowToZernio(encodedRow)` payload written to `localStorage`.

Current target shape:

```js
localStorage.setItem('zernio_table_share_draft', JSON.stringify({
  mediaUrl: row.link || '',
  title: row.title || '',
  caption: row.caption || ''
}));
```

Replace with:

```js
localStorage.setItem('zernio_table_share_draft', JSON.stringify({
  source: 'table-share',
  link: row.link || '',
  mediaUrl: row.link || '',
  title: row.title || '',
  caption: row.caption || ''
}));
```

- [ ] **Step 3: Keep row action renderer unchanged except payload data richness**

Do not redesign buttons. Keep this structure intact:

```js
return `
  <div class="table-share-row-actions">
    <button type="button" class="table-share-action-btn" onclick="queueRowToRepliz('${payload}')" ${!row.link ? 'disabled' : ''}>Repliz</button>
    <button type="button" class="table-share-action-btn" onclick="queueRowToZernio('${payload}')" ${!row.link ? 'disabled' : ''}>Zernio</button>
  </div>
`;
```

Only ensure the stored draft includes `source` and `link`.

- [ ] **Step 4: Manual reasoning check**

Confirm that this change does not affect:
- button labels
- table loading
- manual refresh behavior
- row rendering

Expected: handoff remains same visually, payload richer internally.

---

### Task 3: Add shared table-status publish helper in app.js

**Files:**
- Modify: `public/app.js` near other share/handoff helpers
- Test: manual call path from both provider flows

- [ ] **Step 1: Add small runtime state for active table-origin draft**

Near other top-level provider state, add one small marker object:

```js
var _tableSharePublishDraft = null;
```

Accepted runtime shape:

```js
{
  source: 'table-share',
  provider: 'repliz' | 'zernio',
  link: 'https://files.catbox.moe/...',
  mediaUrl: 'https://files.catbox.moe/...',
  title: '...',
  caption: '...'
}
```

- [ ] **Step 2: Add helper to store/reset active draft marker**

Add these helpers in `public/app.js`:

```js
function setActiveTableShareDraft(provider, draft) {
    if (!draft || draft.source !== 'table-share' || !draft.link) {
        _tableSharePublishDraft = null;
        return;
    }
    _tableSharePublishDraft = {
        source: 'table-share',
        provider: provider,
        link: String(draft.link || '').trim(),
        mediaUrl: String(draft.mediaUrl || '').trim(),
        title: String(draft.title || '').trim(),
        caption: String(draft.caption || '').trim()
    };
}

function clearActiveTableShareDraft() {
    _tableSharePublishDraft = null;
}
```

- [ ] **Step 3: Add helper to update table row status to publish**

Add this helper in `public/app.js`:

```js
async function markTableShareRowPublishedIfNeeded() {
    if (!_tableSharePublishDraft || _tableSharePublishDraft.source !== 'table-share' || !_tableSharePublishDraft.link) {
        return { skipped: true };
    }

    const link = _tableSharePublishDraft.link;

    try {
        const resp = await fetch('/api/video-share/status', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ link: link, status: 'publish' })
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || 'Gagal update status tabel');
        clearActiveTableShareDraft();
        return { skipped: false, ok: true };
    } catch (err) {
        return { skipped: false, ok: false, error: err.message || 'Gagal update status tabel' };
    }
}
```

Design rule:
- do not throw from this helper
- posting success must remain non-blocking

- [ ] **Step 4: Add small success-message merger helper**

Add a small helper so Repliz and Zernio can reuse it:

```js
function buildPostSuccessWithTableStatus(baseMessage, publishResult) {
    if (!publishResult || publishResult.skipped) return baseMessage;
    if (publishResult.ok) return baseMessage + ' Status tabel juga diubah ke publish.';
    return baseMessage + ' ⚠️ Status tabel gagal diubah ke publish: ' + publishResult.error;
}
```

- [ ] **Step 5: Run syntax check after helper insertion**

Run:

```powershell
node --check "public/app.js"
```

Expected: no output.

---

### Task 4: Wire Repliz draft consumer and success path

**Files:**
- Modify: `public/app.js` in `consumeTableShareDraftToRepliz()` and Repliz submit success path
- Test: table → Repliz handoff and submit

- [ ] **Step 1: Extend Repliz draft consumer to persist source-table marker**

Find `consumeTableShareDraftToRepliz()` and keep current behavior of filling form/upload prep. After parsing draft, add:

```js
setActiveTableShareDraft('repliz', draft);
```

If the draft is invalid or missing `link`, explicitly clear marker:

```js
clearActiveTableShareDraft();
```

- [ ] **Step 2: Ensure non-table Repliz flows clear stale marker**

At safe points where Repliz submit may be triggered outside table handoff, clear stale marker if the current flow clearly is not from table. For example, before manual file submit paths or when no consumed table draft exists.

Minimum acceptable rule:
- when page loads and there is no `repliz_table_share_draft`, do not auto-set marker
- only `consumeTableShareDraftToRepliz()` may create the marker for Repliz

- [ ] **Step 3: Hook success path after Repliz submit success**

In the existing Repliz success handler, after the main posting API has already succeeded, call:

```js
const publishResult = await markTableShareRowPublishedIfNeeded();
```

Then merge the success message:

```js
const successMessage = buildPostSuccessWithTableStatus('✅ Post berhasil dikirim ke Repliz.', publishResult);
```

Use the app’s existing Repliz success UI channel (toast, status text, or success block already used by that flow). Do not invent a new panel.

- [ ] **Step 4: Preserve failure semantics**

If Repliz post itself fails:
- do not call `markTableShareRowPublishedIfNeeded()`
- keep existing Repliz error behavior unchanged

- [ ] **Step 5: Manual regression checklist**

Confirm mentally from code:
- table handoff still auto-fills Repliz form
- upload still starts as before
- only success path gains extra PATCH call

---

### Task 5: Wire Zernio draft consumer and success path

**Files:**
- Modify: `public/app.js` in `consumeTableShareDraftToZernio()` and `zernioCreatePost()`
- Test: table → Zernio handoff and submit

- [ ] **Step 1: Extend Zernio draft consumer to persist source-table marker**

In `consumeTableShareDraftToZernio()`, after parsing and validating draft, add:

```js
setActiveTableShareDraft('zernio', draft);
```

If draft missing `link`, clear marker:

```js
clearActiveTableShareDraft();
```

Keep existing behavior intact:
- switch to Zernio tab
- fill title/caption/media URL
- default action to `schedule`
- auto test connection when API key exists
- auto select all accounts when configured

- [ ] **Step 2: Hook Zernio success path after successful submit**

In `zernioCreatePost()`, after `zernioFetch('/api/zernio/posts', ...)` succeeds, add:

```js
var publishResult = await markTableShareRowPublishedIfNeeded();
```

Replace current success line:

```js
zernioSetStatus('✅ Post berhasil dikirim ke ' + (data.accountCount || accountIds.length) + ' account sebagai ' + data.action, 'success');
```

with:

```js
var baseMessage = '✅ Post berhasil dikirim ke ' + (data.accountCount || accountIds.length) + ' account sebagai ' + data.action + '.';
zernioSetStatus(buildPostSuccessWithTableStatus(baseMessage, publishResult), publishResult && publishResult.ok === false ? 'warn' : 'success');
```

If your status helper only supports `success`, `warn`, `error`, ensure warning rendering remains readable.

- [ ] **Step 3: Preserve current failure semantics**

If `zernioFetch('/api/zernio/posts', ...)` throws:
- keep existing `❌ ...` behavior
- do not update table status

- [ ] **Step 4: Keep non-table manual submits untouched**

When user manually opens Zernio tab and submits without coming from table:
- `markTableShareRowPublishedIfNeeded()` should return `{ skipped: true }`
- success message should remain normal without table suffix

- [ ] **Step 5: Run syntax check after Zernio wiring**

Run:

```powershell
node --check "public/app.js"
```

Expected: no output.

---

### Task 6: Final verification and regression pass

**Files:**
- Modify: none unless fixes needed
- Verify: `public/tabel-share-video.html`, `public/app.js`, `routes/video-share.js`, `server.js`

- [ ] **Step 1: Run syntax verification**

Run:

```powershell
node --check "public/app.js"; if ($?) { node --check "routes/video-share.js" }; if ($?) { node --check "server.js" }
```

Expected: no output.

- [ ] **Step 2: Run diagnostics**

Run diagnostics on changed JS files.

Expected:
- `public/app.js` → no diagnostics
- `routes/video-share.js` → no diagnostics

- [ ] **Step 3: Manually inspect final draft payloads in table page**

Confirm `public/tabel-share-video.html` stores drafts with:

```js
{
  source: 'table-share',
  link: row.link || '',
  mediaUrl: row.link || '',
  title: row.title || '',
  caption: row.caption || ''
}
```

for both Repliz and Zernio.

- [ ] **Step 4: Manual browser verification checklist**

Check these flows in browser:

1. Table → Repliz
   - click `Repliz`
   - form fills
   - submit succeeds
   - table status PATCH runs
   - success message includes either publish success or warning

2. Table → Zernio
   - click `Zernio`
   - draft fills
   - default schedule remains
   - submit succeeds
   - table status PATCH runs
   - success message includes either publish success or warning

3. Manual non-table Repliz
   - open Repliz directly
   - submit normally
   - no table status update attempted

4. Manual non-table Zernio
   - open Zernio directly
   - submit normally
   - no table status update attempted

- [ ] **Step 5: Commit**

Only if the user explicitly asks for git operations, stage the intended files and commit with a message like:

```bash
git add public/tabel-share-video.html public/app.js
git commit -m "feat: auto-publish table status after post success"
```

If user did not request commit, skip this step.

---

## Self-review checklist

- **Spec coverage:**
  - Repliz success → covered in Task 4
  - Zernio success → covered in Task 5
  - table-origin only → covered in Tasks 2, 3, 4, 5
  - reuse existing PATCH route → covered in Tasks 1 and 3
  - non-blocking if table update fails → covered in Tasks 3, 4, 5
  - no auto-refresh / no new controls → preserved in Tasks 2, 4, 5

- **Placeholder scan:**
  - No TBD/TODO placeholders left
  - Concrete payloads, helper names, and commands included

- **Type consistency:**
  - `link` used consistently as row identity
  - helper names consistent: `setActiveTableShareDraft`, `clearActiveTableShareDraft`, `markTableShareRowPublishedIfNeeded`, `buildPostSuccessWithTableStatus`
  - provider names consistent: `repliz`, `zernio`

Plan complete and saved to `docs/superpowers/plans/2026-06-14-auto-publish-table-status.md`. Two execution options:

1. **Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

2. **Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
