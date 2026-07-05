# Global Hashtag After Convert Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `Global Hashtags` field to the convert completion flow so the latest convert result can merge + dedupe hashtags before save-to-table, Repliz handoff, Zernio handoff, and download metadata use.

**Architecture:** Keep this feature frontend-only and scoped to the latest convert result state. Store the raw hashtag input next to `_cvtLastClipData`, normalize/merge at action time through shared helpers, and ensure every downstream action reads the same final caption/hashtag output. Reset state whenever a new convert result replaces the old one so nothing leaks across jobs.

**Tech Stack:** Vanilla JavaScript, existing convert completion modal in `public/index.html`, existing convert/share/handoff flows in `public/app.js`, browser DOM state, existing table/Repliz/Zernio integrations.

---

## File map

- **Modify:** `public/index.html`
  - Add `Global Hashtags` input and helper text to `convertCompleteModal`.
- **Modify:** `public/app.js`
  - Add latest-result-only hashtag state.
  - Add normalize/merge helpers.
  - Reset state when a new convert result is created.
  - Apply merged caption/hashtag in save-to-table, Repliz handoff, Zernio handoff, and any download metadata path using latest convert state.
- **Verify:** `routes/video-share.js`, `routes/zernio.js`
  - No feature logic change expected, but verify payload consumption remains compatible after frontend sends merged caption/hashtag strings.

---

### Task 1: Add Global Hashtags UI to convert completion modal

**Files:**
- Modify: `public/index.html:1505-1538` (convert completion modal action area)
- Test: browser/manual modal visibility check

- [ ] **Step 1: Read the current convert completion modal block**

Confirm the target section in `public/index.html` contains:
- `#convertCompleteModal`
- `#convertCompleteInfo`
- `#convertDownloadLink`
- `#convertSaveTableBtn`
- `sendConvertToRepliz()` button

Expected shape near target area:

```html
<div id="convertCompleteModal" ...>
  ...
  <div id="convertPreviewWrap" ...></div>
  <div style="display:flex;gap:10px;...">
    <a id="convertDownloadLink" ...>⬇ Download</a>
    <button id="convertSaveTableBtn" ...>🗂 Simpan Semua ke Tabel</button>
    <button onclick="sendConvertToRepliz()" ...>📲 Schedule to Repliz</button>
  </div>
  <div id="convertSaveTableHint" ...></div>
  <button onclick="closeConvertCompleteModal()" ...>Close</button>
</div>
```

- [ ] **Step 2: Insert `Global Hashtags` field into the completion modal**

Add this block between the action buttons/hint area and the Close button:

```html
<div style="margin-bottom:12px;padding:12px 14px;background:rgba(255,255,255,0.04);border:1px solid var(--border-subtle);border-radius:12px">
  <label for="convertGlobalHashtags" style="display:block;font-size:0.78rem;font-weight:700;color:var(--text-primary);margin-bottom:6px">Global Hashtags</label>
  <input id="convertGlobalHashtags" type="text" placeholder="#fyp #viral #podcast"
    style="width:100%;padding:10px 12px;background:rgba(10,12,20,0.8);border:1px solid var(--border-subtle);border-radius:10px;color:var(--text-primary);font-size:0.82rem;font-family:var(--font);box-sizing:border-box">
  <div style="font-size:0.72rem;color:var(--text-muted);margin-top:6px">Berlaku ke semua hasil convert terakhir sebelum save / schedule / download.</div>
</div>
```

Requirements:
- input id must be exactly `convertGlobalHashtags`
- keep inline style pattern consistent with surrounding modal code
- field must be visible for both single and all flows

- [ ] **Step 3: Keep visual scope tight**

Do not add:
- per-clip editors
- extra buttons
- extra persistence toggles
- localStorage-backed remembered hashtag settings

Expected outcome: one field only, scoped to latest convert result.

- [ ] **Step 4: Record verification command for later**

Manual verification target later:
- open convert flow
- complete one convert
- confirm `Global Hashtags` field appears in completion modal

No separate shell command needed for HTML; syntax/DOM validation will be covered by app JS checks and manual review.

---

### Task 2: Add latest-result hashtag state and merge helpers

**Files:**
- Modify: `public/app.js:607-760` (convert modal state area)
- Test: helper-level reasoning + syntax check

- [ ] **Step 1: Add latest-result hashtag state near convert modal state**

Near the existing convert modal state:

```js
var _cvtClipIndex = 0, _cvtRatio = '9:16', _cvtMode = 'single';
var _cvtLastVideoUrl = '', _cvtLastClipData = null;
```

add:

```js
var _cvtGlobalHashtagsRaw = '';
```

State rule:
- holds raw input only for latest convert result
- resets when a new convert result is created
- does not persist to `localStorage`

- [ ] **Step 2: Add DOM accessor + raw state sync helpers**

Add these helpers near other convert helpers:

```js
function getConvertGlobalHashtagsInput() {
    return document.getElementById('convertGlobalHashtags');
}

function getConvertGlobalHashtagsRaw() {
    var input = getConvertGlobalHashtagsInput();
    if (input) _cvtGlobalHashtagsRaw = String(input.value || '').trim();
    return String(_cvtGlobalHashtagsRaw || '').trim();
}

function setConvertGlobalHashtagsRaw(value) {
    _cvtGlobalHashtagsRaw = String(value || '').trim();
    var input = getConvertGlobalHashtagsInput();
    if (input) input.value = _cvtGlobalHashtagsRaw;
}
```

- [ ] **Step 3: Add hashtag normalization helper**

Add a helper that accepts messy text and returns normalized hashtag tokens:

```js
function normalizeHashtagTokens(input) {
    return [...new Set(
        String(input || '')
            .replace(/[\r\n,]+/g, ' ')
            .split(/\s+/)
            .map(function (token) {
                token = String(token || '').trim();
                if (!token) return '';
                token = token.replace(/^#+/, '').replace(/[^\w.-]+/g, '');
                if (!token) return '';
                return '#' + token;
            })
            .filter(Boolean)
            .map(function (token) { return token.toLowerCase(); })
    )];
}
```

Then immediately adapt it so dedupe is case-insensitive but output preserves first-seen casing style by replacing the final implementation with:

```js
function normalizeHashtagTokens(input) {
    var rawTokens = String(input || '')
        .replace(/[\r\n,]+/g, ' ')
        .split(/\s+/)
        .map(function (token) {
            token = String(token || '').trim();
            if (!token) return '';
            token = token.replace(/^#+/, '').replace(/[^\w.-]+/g, '');
            if (!token) return '';
            return '#' + token;
        })
        .filter(Boolean);

    var seen = new Set();
    var result = [];
    rawTokens.forEach(function (token) {
        var key = token.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        result.push(token);
    });
    return result;
}
```

- [ ] **Step 4: Add caption merge helper using old-order-first rule**

Add these helpers:

```js
function splitCaptionAndHashtags(caption) {
    var text = String(caption || '').replace(/\r/g, '').trim();
    if (!text) return { body: '', hashtags: [] };

    var matches = text.match(/#(?:[\w.-]+)/g) || [];
    var hashtagKeys = new Set(matches.map(function (tag) { return tag.toLowerCase(); }));
    var body = text
        .split(/\n+/)
        .map(function (line) {
            var cleaned = line.replace(/#(?:[\w.-]+)/g, '').replace(/\s+/g, ' ').trim();
            return cleaned;
        })
        .filter(Boolean)
        .join('\n');

    var orderedTags = [];
    matches.forEach(function (tag) {
        var key = tag.toLowerCase();
        if (!hashtagKeys.has(key)) return;
        hashtagKeys.delete(key);
        orderedTags.push(tag);
    });

    return { body: body, hashtags: orderedTags };
}

function mergeCaptionWithGlobalHashtags(caption, globalInput) {
    var parsed = splitCaptionAndHashtags(caption);
    var existingTags = parsed.hashtags || [];
    var newTags = normalizeHashtagTokens(globalInput);
    if (!newTags.length) return String(caption || '').trim();

    var seen = new Set();
    var merged = [];
    existingTags.concat(newTags).forEach(function (tag) {
        var key = String(tag || '').toLowerCase();
        if (!key || seen.has(key)) return;
        seen.add(key);
        merged.push(tag);
    });

    var body = String(parsed.body || '').trim();
    return body ? (body + '\n\n' + merged.join(' ')).trim() : merged.join(' ');
}
```

Behavior target:
- empty global input → original caption unchanged
- old hashtags stay first
- new unique hashtags append after old ones
- duplicate hashtags removed case-insensitively

- [ ] **Step 5: Add convert-result-level helper for final caption**

Add this helper so action paths reuse one logic source:

```js
function getConvertFinalCaption(baseCaption) {
    var globalInput = getConvertGlobalHashtagsRaw();
    return mergeCaptionWithGlobalHashtags(baseCaption || '', globalInput);
}
```

Optional companion helper for raw hashtag-only field:

```js
function getConvertFinalHashtagText(baseHashtagText) {
    var merged = mergeCaptionWithGlobalHashtags(baseHashtagText || '', getConvertGlobalHashtagsRaw());
    return merged;
}
```

But if this second helper adds confusion, skip it and reuse `getConvertFinalCaption()` only.

- [ ] **Step 6: Reset hashtag state when a new convert result is produced**

In the convert completion flow inside `confirmConvertModal()`, before setting new `_cvtLastClipData`, reset:

```js
setConvertGlobalHashtagsRaw('');
```

Also ensure `closeConvertCompleteModal()` does **not** clear it, because the same latest result should keep its hashtag input while the result remains active.

- [ ] **Step 7: Run syntax check for helper insertion**

Run:

```powershell
node --check "public/app.js"
```

Expected: no output.

---

### Task 3: Apply merged caption to latest convert actions

**Files:**
- Modify: `public/app.js:654-703`, `public/app.js:768-860`, `public/app.js:1953-2048`
- Test: manual handoff + state reset behavior

- [ ] **Step 1: Make save-to-table use merged caption/hashtags**

Inside `saveConvertedClipsToTable()`, before calling `/api/video-share/batch-from-convert`, build an adjusted clips payload instead of sending `_cvtLastClipData.clips` raw.

Implementation target:

```js
var preparedClips = (_cvtLastClipData.clips || []).map(function (clip) {
    var next = Object.assign({}, clip);
    next.caption = getConvertFinalCaption(clip.caption || '');
    return next;
});
```

Then send:

```js
clips: preparedClips
```

Do not mutate original clip objects in place.

- [ ] **Step 2: Make single-convert Repliz handoff use merged caption**

In the single-convert path where `_cvtLastClipData` is created, preserve the original caption as-is.

Then in `sendConvertToRepliz()`, before autofilling Repliz form, compute:

```js
var finalCaption = getConvertFinalCaption(_cvtLastClipData && _cvtLastClipData.caption || '');
```

and use that for:

```js
document.getElementById('replizPostDesc').value = finalCaption;
```

Keep title/media behavior unchanged.

- [ ] **Step 3: Make table-origin Repliz draft consumption merge if latest convert state exists**

In `consumeTableShareDraftToRepliz()`, when filling the Repliz caption field, use:

```js
var captionForDraft = draft.caption || '';
if (_cvtLastClipData) captionForDraft = getConvertFinalCaption(captionForDraft);
if (captionForDraft) document.getElementById('replizPostDesc').value = captionForDraft;
```

Rule:
- use merge helper safely
- if global hashtag state empty, behavior remains unchanged

- [ ] **Step 4: Make table-origin and convert-origin Zernio handoff use merged caption**

In `consumeTableShareDraftToZernio()`, when filling `#zernioCaption`, change to:

```js
var captionForDraft = draft.caption || '';
if (_cvtLastClipData) captionForDraft = getConvertFinalCaption(captionForDraft);
if (captionForDraft) document.getElementById('zernioCaption').value = captionForDraft;
```

If there is also a direct convert → Zernio path elsewhere in the file, update it to use `getConvertFinalCaption(...)` too.

- [ ] **Step 5: Update convert-result metadata used in modal-driven flows**

Where `_cvtLastClipData` is used for downstream completion actions, add a helper to build a computed version:

```js
function getConvertActionPayload() {
    if (!_cvtLastClipData) return null;
    return Object.assign({}, _cvtLastClipData, {
        caption: getConvertFinalCaption(_cvtLastClipData.caption || '')
    });
}
```

Then use this helper inside action flows that currently read `_cvtLastClipData.caption` directly.

- [ ] **Step 6: Keep empty-input behavior fully backward compatible**

Check that if `convertGlobalHashtags` is empty:
- save-to-table payload is identical to old behavior
- Repliz caption fill is unchanged
- Zernio caption fill is unchanged
- no alerts or warnings appear

Expected: no-op.

---

### Task 4: Apply merged caption to download metadata and result replacement lifecycle

**Files:**
- Modify: `public/app.js` convert completion area and any download-metadata helper paths
- Test: manual convert lifecycle reasoning + syntax check

- [ ] **Step 1: Identify where latest convert metadata is used for download-facing text**

Search in `public/app.js` for places using:
- `_cvtLastClipData.caption`
- `_cvtLastClipData.title`
- `convertDownloadLink`
- any caption text exported from convert-complete flow

Goal: confirm whether there is a current metadata text path beyond save/Repliz/Zernio. If there is one, route it through `getConvertFinalCaption(...)`. If not, document that current download effect is limited to latest action payloads and modal state.

- [ ] **Step 2: Ensure hashtag input resets only on new result, not on modal close**

Behavior to enforce:
- when a new convert result is assigned, call `setConvertGlobalHashtagsRaw('')`
- when `closeConvertCompleteModal()` runs, do **not** clear `_cvtGlobalHashtagsRaw`
- reopening actions for the same latest result should preserve the current input while that result remains active

- [ ] **Step 3: Ensure new convert result replaces old hashtag state cleanly**

In both branches inside `confirmConvertModal()`:
- `_cvtMode === 'all'`
- single clip convert branch

reset hashtag state **before** storing the new `_cvtLastClipData` so old hashtags never bleed into the new result.

- [ ] **Step 4: Add one defensive fallback around merge helper usage**

Where action flows call merge helpers, wrap with minimal safe fallback pattern:

```js
var finalCaption = baseCaption || '';
try {
    finalCaption = getConvertFinalCaption(baseCaption || '');
} catch (e) { }
```

Use this only at action boundaries if needed. Do not over-wrap every helper unless a syntax/runtime risk is real.

- [ ] **Step 5: Run syntax check after lifecycle wiring**

Run:

```powershell
node --check "public/app.js"
```

Expected: no output.

---

### Task 5: Final verification and regression check

**Files:**
- Verify: `public/index.html`, `public/app.js`, `routes/video-share.js`, `routes/zernio.js`, `server.js`

- [ ] **Step 1: Run syntax verification**

Run:

```powershell
node --check "public/app.js"; if ($?) { node --check "routes/video-share.js" }; if ($?) { node --check "routes/zernio.js" }; if ($?) { node --check "server.js" }
```

Expected: no output.

- [ ] **Step 2: Run diagnostics on the modified frontend file**

Run:

```powershell
# via tooling
lsp_diagnostics("D:\ocprojek\gabungan\public\app.js", "all")
```

Expected: no diagnostics.

- [ ] **Step 3: Manual browser verification checklist**

Verify all of these manually:

1. **Single convert / Repliz**
   - Convert one clip
   - In completion modal, enter `#podcast #fyp #shorts`
   - Trigger Repliz handoff
   - Expected: Repliz caption contains old hashtags first, then new unique ones

2. **Single convert / Zernio**
   - Same setup
   - Trigger Zernio handoff
   - Expected: Zernio caption contains merged + deduped hashtags

3. **Convert all / save to table**
   - Convert all
   - Enter global hashtags
   - Save to table
   - Expected: rows sent from frontend use merged captions

4. **Duplicate removal**
   - Use caption already containing `#viral #podcast`
   - Enter `#podcast #fyp #viral`
   - Expected final order: `#viral #podcast #fyp`

5. **Reset behavior**
   - Enter hashtags on one result
   - Complete a new convert result
   - Expected: field resets empty for the new result

6. **Empty input regression**
   - Leave field blank
   - Run save / Repliz / Zernio
   - Expected: all old behavior still works

- [ ] **Step 4: Optional targeted readback after implementation**

Read back and confirm:
- `public/index.html` contains `#convertGlobalHashtags`
- `public/app.js` contains:
  - `_cvtGlobalHashtagsRaw`
  - `normalizeHashtagTokens(...)`
  - `mergeCaptionWithGlobalHashtags(...)`
  - latest-result reset logic
  - action-path integration into save/Repliz/Zernio

- [ ] **Step 5: Commit**

Only if explicitly requested in the active session:

```bash
git add public/index.html public/app.js docs/superpowers/specs/2026-06-14-global-hashtag-after-convert-design.md docs/superpowers/plans/2026-06-14-global-hashtag-after-convert.md
git commit -m "feat: add global hashtags after convert"
```

If git commit was not requested, skip this step.

---

## Self-review

- **Spec coverage:** plan covers modal input, latest-result-only state, merge+dedupe helper behavior, save-to-table, Repliz, Zernio, download-facing metadata usage, reset/no-leak behavior, and empty-input regression checks.
- **Placeholder scan:** no TBD/TODO placeholders left; each task contains exact file targets, concrete helper names, commands, and behavior checks.
- **Type consistency:** plan consistently uses `convertGlobalHashtags`, `_cvtGlobalHashtagsRaw`, `getConvertFinalCaption(...)`, and existing `_cvtLastClipData` state without introducing conflicting names.

Plan complete and saved to `docs/superpowers/plans/2026-06-14-global-hashtag-after-convert.md`. Two execution options:

1. **Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
