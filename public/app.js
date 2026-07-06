// ============================================
// VIDEO TOOLS — Unified Frontend Logic
// ============================================

// === TAB SWITCHING ===
function switchTab(tab) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
    var tabMap = { cutter: 'tabCutter', bulk: 'tabBulk', cropper: 'tabCropper', zernio: 'tabZernio', repliz: 'tabRepliz' };
    var btnMap = { cutter: 'tabBtnCutter', bulk: 'tabBtnBulk', cropper: 'tabBtnCropper', zernio: 'tabBtnZernio', repliz: 'tabBtnRepliz' };
    if (tabMap[tab]) document.getElementById(tabMap[tab]).classList.add('active');
    if (btnMap[tab]) document.getElementById(btnMap[tab]).classList.add('active');
}

// ============================================
//  TAB 1: YOUTUBE AI CUTTER
// ============================================
const form = document.getElementById('analyzeForm');
const submitBtn = document.getElementById('submitBtn');
const formCard = document.getElementById('formCard');
const progressCard = document.getElementById('progressCard');
const resultCard = document.getElementById('resultCard');
const errorCard = document.getElementById('errorCard');
const progressBar = document.getElementById('progressBar');
const progressPercent = document.getElementById('progressPercent');
const progressLog = document.getElementById('progressLog');
const progressSubtitle = document.getElementById('progressSubtitle');
const clipGallery = document.getElementById('clipGallery');
let allResults = [], currentJobId = '', currentView = 'list';
let selectedClipIndices = new Set();

// Sliders
const clipCountSlider = document.getElementById('clipCount');
const clipCountLabel = document.getElementById('clipCountLabel');
clipCountSlider.addEventListener('input', () => clipCountLabel.textContent = clipCountSlider.value + ' clip');
const minSlider = document.getElementById('minDuration'), maxSlider = document.getElementById('maxDuration');
const minValue = document.getElementById('minValue'), maxValue = document.getElementById('maxValue');
const durationLabel = document.getElementById('durationLabel');
minSlider.addEventListener('input', () => { let mi = parseInt(minSlider.value), ma = parseInt(maxSlider.value); if (mi > ma) { maxSlider.value = mi; ma = mi; } minValue.textContent = mi + 's'; maxValue.textContent = ma + 's'; durationLabel.textContent = `${mi}s — ${ma}s`; });
maxSlider.addEventListener('input', () => { let mi = parseInt(minSlider.value), ma = parseInt(maxSlider.value); if (ma < mi) { minSlider.value = ma; mi = ma; } minValue.textContent = mi + 's'; maxValue.textContent = ma + 's'; durationLabel.textContent = `${mi}s — ${ma}s`; });

function toggleApiKey() { const i = document.getElementById('apiKey'); i.type = i.type === 'password' ? 'text' : 'password'; }
function setView(v) { currentView = v; const g = document.getElementById('clipGallery'); g.classList.remove('view-list', 'view-grid'); g.classList.add('view-' + v); document.getElementById('listViewBtn').classList.toggle('active', v === 'list'); document.getElementById('gridViewBtn').classList.toggle('active', v === 'grid'); localStorage.setItem('clip_view', v); }
const savedView = localStorage.getItem('clip_view'); if (savedView) currentView = savedView;

function downloadAll() { if (!currentJobId) return; window.location.href = `/api/download-all-zip/${currentJobId}`; }
function downloadClip(i) { if (!currentJobId) return; window.location.href = `/api/download-zip/${currentJobId}/${i}`; }

// Show convert modal instead of direct convert
function convertRatio(clipIndex, ratio, btn) {
    showConvertModal(clipIndex, ratio, 'single');
}
function convertAllRatio(ratio, btn) {
    if (!currentJobId || !allResults.length) return;
    if (getSelectedClipIndices().length === 0) { alert('Pilih clip yang ingin di-convert terlebih dahulu.'); return; }
    showConvertModal(-1, ratio, 'all');
}

function resetForm() { formCard.classList.remove('hidden'); progressCard.classList.add('hidden'); resultCard.classList.add('hidden'); errorCard.classList.add('hidden'); submitBtn.disabled = false; submitBtn.classList.remove('btn-loading'); progressLog.innerHTML = ''; progressBar.style.width = '0%'; progressPercent.textContent = '0%'; clipGallery.innerHTML = ''; allResults = []; currentJobId = ''; selectedClipIndices.clear(); }
function formatTime(s) { return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0'); }
function extractYouTubeVideoId(url) {
    try {
        var parsed = new URL(String(url || '').trim(), window.location.origin);
        if (parsed.hostname === 'youtu.be') return parsed.pathname.replace(/^\//, '').split('/')[0] || '';
        if (parsed.pathname.indexOf('/shorts/') === 0) return parsed.pathname.split('/')[2] || '';
        return parsed.searchParams.get('v') || '';
    } catch (e) {
        var text = String(url || '').trim();
        var match = text.match(/(?:youtu\.be\/|v=|\/shorts\/)([A-Za-z0-9_-]{6,})/);
        return match ? match[1] : '';
    }
}
function buildYouTubeEmbedUrl(clip) {
    var videoId = extractYouTubeVideoId(clip && clip.source_youtube_url);
    if (!videoId) return '';
    var start = Math.max(0, Math.floor(Number(clip.start_time || 0)));
    var end = Math.max(start + 1, Math.ceil(getClipEffectiveEndTime(clip)));
    return 'https://www.youtube.com/embed/' + videoId + '?start=' + start + '&end=' + end + '&rel=0&modestbranding=1&playsinline=1&autoplay=1';
}
function clampClipEndExtendSeconds(value) {
    var n = Number(value);
    if (!Number.isFinite(n)) return 0;
    n = Math.round(n * 2) / 2;
    return Math.max(0, Math.min(90, n));
}
function getClipEndExtendSeconds(clip) { return clip ? clampClipEndExtendSeconds(clip.end_extend_seconds || 0) : 0; }
function getClipEffectiveEndTime(clip) { return Number(clip.end_time || 0) + getClipEndExtendSeconds(clip); }
function getClipEffectiveDuration(clip) { return Math.max(0, getClipEffectiveEndTime(clip) - Number(clip.start_time || 0)); }
function normalizeClipForUI(clip) {
    return Object.assign({}, clip, {
        end_extend_seconds: getClipEndExtendSeconds(clip)
    });
}
function updateClipEndExtend(i, value) {
    if (!allResults || !allResults[i]) return;
    allResults[i].end_extend_seconds = clampClipEndExtendSeconds(value);
    showResults(allResults, true);
}
function buildClipEndExtendMap(indices) {
    var map = {};
    (indices || []).forEach(function (idx) {
        var clip = allResults[idx];
        var extra = getClipEndExtendSeconds(clip);
        if (clip && extra > 0) map[idx] = extra;
    });
    return map;
}
function copyCaptionBtn(btn) {
    var wrap = btn.closest('.clip-caption-wrap');
    var el = wrap ? wrap.querySelector('.clip-caption') : null;
    if (!el) return;
    var text = el.innerText || el.textContent;
    navigator.clipboard.writeText(text).then(function () {
        var orig = btn.textContent; btn.textContent = '✅ Copied!';
        setTimeout(function () { btn.textContent = orig; }, 2000);
    }).catch(function () {
        // Fallback for insecure context
        var ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
        var orig = btn.textContent; btn.textContent = '✅ Copied!';
        setTimeout(function () { btn.textContent = orig; }, 2000);
    });
}
function addLog(msg, type = 'info') { const t = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); const e = document.createElement('div'); e.className = `log-entry ${type === 'done' ? 'log-done' : ''} ${type === 'error' ? 'log-error' : ''}`; e.innerHTML = `<span class="log-time">${t}</span><span class="log-msg">${msg}</span>`; progressLog.appendChild(e); progressLog.scrollTop = progressLog.scrollHeight; }
function clearProgressLog() { progressLog.innerHTML = ''; }
function applyProgressEventToUI(m, options) {
    options = options || {};
    if (typeof m.progress === 'number' && m.progress >= 0) {
        progressBar.style.width = m.progress + '%';
        progressPercent.textContent = m.progress + '%';
    }
    if (m.message) {
        progressSubtitle.textContent = m.message;
        if (!options.skipLog) {
            const step = typeof m.step === 'string' ? m.step : '';
            addLog(m.message, step.includes('done') ? 'done' : (step === 'error' ? 'error' : 'info'));
        }
    }
    if (m.step === 'done' && m.results) {
        showResults(m.results);
        return 'done';
    }
    if (m.step === 'error') {
        if (!options.skipLog && m.message) addLog(m.message, 'error');
        showError(m.error || m.message);
        return 'error';
    }
    return 'continue';
}
function startProgressFallback(jobId, es) {
    let seenCount = 0;
    let pollTimer = null;
    let stopped = false;
    async function poll() {
        if (stopped) return;
        try {
            const resp = await fetch(`/api/progress/${jobId}/history`, { cache: 'no-store' });
            const data = await resp.json();
            if (!resp.ok || !data.success || !Array.isArray(data.events)) return;
            for (let i = seenCount; i < data.events.length; i++) {
                const status = applyProgressEventToUI(data.events[i]);
                seenCount = i + 1;
                if (status === 'done' || status === 'error') {
                    stop();
                    return;
                }
            }
        } catch (err) {
            console.error('Progress polling error:', err);
        }
    }
    function stop() {
        stopped = true;
        if (pollTimer) clearInterval(pollTimer);
        if (es) {
            try { es.close(); } catch (e) { }
        }
    }
    poll();
    pollTimer = setInterval(poll, 1000);
    return { stop, syncCount: function (count) { if (count > seenCount) seenCount = count; } };
}
function copyCaption(el, t) { navigator.clipboard.writeText(t).then(() => { el.classList.add('copied'); setTimeout(() => el.classList.remove('copied'), 2000); }); }
function toggleVideo(btn, i) {
    const w = document.getElementById(`clip-video-${i}`);
    if (!w) return;
    if (w.classList.contains('visible')) {
        w.classList.remove('visible');
        btn.innerHTML = '▶ Preview';
        return;
    }
    w.classList.add('visible');
    btn.innerHTML = '▲ Hide';
    const frame = w.querySelector('iframe');
    if (frame && (!frame.src || frame.src === window.location.href)) {
        frame.src = frame.dataset.src;
        return;
    }
    const v = w.querySelector('video');
    if (v && (!v.src || v.src === window.location.href)) v.src = v.dataset.src;
}
function getSelectedClipIndices() { return Array.from(selectedClipIndices).sort((a, b) => a - b); }
function updateSelectedClipsUI() {
    const total = allResults.length;
    const selected = getSelectedClipIndices().length;
    const totalLabel = document.getElementById('totalClipsLabel');
    if (totalLabel) totalLabel.textContent = `${selected}/${total} clips dipilih`;
    const toggle = document.getElementById('selectAllClipsToggle');
    if (toggle) toggle.checked = total > 0 && selected === total;
}
function toggleClipSelection(i, checked) {
    if (checked) selectedClipIndices.add(i); else selectedClipIndices.delete(i);
    updateSelectedClipsUI();
}
function toggleSelectAllClips(checked) {
    selectedClipIndices.clear();
    if (checked) allResults.forEach((_, i) => selectedClipIndices.add(i));
    showResults(allResults, true);
}

const TYPE_CONFIG = {
    funny: { emoji: '😂', label: 'Funny', cls: 'tag-funny' },
    fact: { emoji: '📚', label: 'Fact', cls: 'tag-fact' },
    story: { emoji: '📖', label: 'Story', cls: 'tag-story' },
    moment: { emoji: '🎯', label: 'Moment', cls: 'tag-moment' },
    insight: { emoji: '💡', label: 'Insight', cls: 'tag-insight' },
    drama: { emoji: '⚡', label: 'Drama', cls: 'tag-drama' },
    comedy: { emoji: '😂', label: 'Comedy', cls: 'tag-funny' },
    inspirational: { emoji: '✨', label: 'Inspirasi', cls: 'tag-insight' },
    informative: { emoji: '📚', label: 'Info', cls: 'tag-fact' },
    viral: { emoji: '🔥', label: 'Viral', cls: 'tag-viral' }
};
const EVIDENCE_CONFIG = {
    high: { emoji: '🟢', label: 'Evidence kuat', cls: 'evidence-high' },
    medium: { emoji: '🟡', label: 'Evidence sedang', cls: 'evidence-medium' },
    low: { emoji: '🔴', label: 'Evidence lemah', cls: 'evidence-low' }
};
function buildClipCard(clip, i) {
    var ti = TYPE_CONFIG[clip.type] || TYPE_CONFIG.viral;
    var evidence = EVIDENCE_CONFIG[clip.evidence_quality] || EVIDENCE_CONFIG.medium;
    var checked = selectedClipIndices.has(i) ? 'checked' : '';
    var extraEnd = getClipEndExtendSeconds(clip);
    var effectiveEnd = getClipEffectiveEndTime(clip);
    var effectiveDuration = getClipEffectiveDuration(clip);
    var displayDuration = Math.round(effectiveDuration);
    var embedUrl = buildYouTubeEmbedUrl(clip);
    var previewHtml = embedUrl
        ? '<iframe data-src="' + embedUrl + '" title="YouTube preview clip ' + clip.clip_number + '" loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen style="width:100%;aspect-ratio:16/9;border:0;border-radius:12px;background:#000"></iframe>'
        : '<video controls preload="none" data-src="' + clip.downloadUrl + '"></video>';
    return '<div class="clip-card" style="animation-delay:' + (i * 0.06) + 's">' +
        '<div class="clip-card-header">' +
        '<div style="display:flex;align-items:center;gap:10px"><input type="checkbox" ' + checked + ' onchange="toggleClipSelection(' + i + ', this.checked)" style="width:18px;height:18px;accent-color:var(--accent-primary);cursor:pointer"><div class="clip-number">' + clip.clip_number + '</div></div>' +
        '<div class="clip-badge-stack">' +
        '<span class="clip-type-badge ' + ti.cls + '">' + ti.emoji + ' ' + ti.label + '</span>' +
        '<span class="clip-evidence-badge ' + evidence.cls + '" title="Skor evidence: ' + (clip.evidence_score == null ? '-' : clip.evidence_score) + '">' + evidence.emoji + ' ' + evidence.label + '</span>' +
        '</div>' +
        '<a class="clip-download-btn" href="#" onclick="downloadClip(' + i + ');return false;" title="Download">\u2b07</a>' +
        '</div>' +
        '<div class="clip-body">' +
        '<h3 class="clip-title">\ud83c\udfac ' + clip.hook_title + '</h3>' +
        (clip.topic ? '<div class="clip-topic">Topik: ' + clip.topic + '</div>' : '') +
        '<div class="clip-meta">' +
        '<span class="clip-meta-tag meta-green">\u25b6 ' + formatTime(clip.start_time) + ' \u2192 ' + formatTime(effectiveEnd) + '</span>' +
        '<span class="clip-meta-tag meta-green">' + displayDuration + 's</span>' +
        '<span class="clip-meta-tag meta-green">' + clip.fileSize + '</span>' +
        (extraEnd > 0 ? '<span class="clip-meta-tag meta-green">+ ' + extraEnd + 's akhir</span>' : '') +
        '</div>' +
        '<div class="clip-caption-wrap"><div class="clip-caption">' + clip.caption.replace(/\n/g, '<br>') + '</div>' +
        '<button class="clip-copy-btn" onclick="copyCaptionBtn(this)">\ud83d\udccb Copy</button></div>' +
        '<div class="clip-reason">\ud83d\udca1 ' + clip.reason + '</div>' +
        '<div style="margin-top:12px;padding:12px;border:1px solid rgba(255,255,255,0.08);border-radius:12px;background:rgba(255,255,255,0.03)">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">' +
        '<div><div style="font-size:0.82rem;font-weight:700;color:var(--text-primary)">Tambah akhir (detik)</div><div style="font-size:0.72rem;color:var(--text-muted);margin-top:2px">Hanya dipakai saat Edit/Convert clip ini.</div></div>' +
        '<div style="display:flex;align-items:center;gap:8px"><input type="number" min="0" max="90" step="0.5" value="' + extraEnd + '" onchange="updateClipEndExtend(' + i + ', this.value)" style="width:80px;padding:8px 10px;background:rgba(10,12,20,0.85);border:1px solid var(--border-subtle);border-radius:10px;color:var(--text-primary);font-size:0.82rem;font-family:var(--font);box-sizing:border-box"><span style="font-size:0.78rem;color:var(--text-muted)">detik</span></div>' +
        '</div>' +
        '</div>' +
        '</div>' +
        '<div class="clip-ratio-bar"><span class="ratio-label">Ratio \u2192</span>' +
        '<div class="ratio-group"><span class="ratio-group-label">1:1</span><button class="ratio-btn" onclick="convertRatio(' + i + ',\x271:1\x27,this)">Convert</button><button class="ratio-btn ratio-edit" onclick="showSmartCropModal(' + i + ',\x271:1\x27)">\u270f\ufe0f Edit</button></div>' +
        '<div class="ratio-group"><span class="ratio-group-label">9:16</span><button class="ratio-btn" onclick="convertRatio(' + i + ',\x279:16\x27,this)">Convert</button><button class="ratio-btn ratio-edit" onclick="showSmartCropModal(' + i + ',\x279:16\x27)">\u270f\ufe0f Edit</button></div>' +
        '<div class="ratio-group"><span class="ratio-group-label">2:3</span><button class="ratio-btn" onclick="convertRatio(' + i + ',\x272:3\x27,this)">Convert</button><button class="ratio-btn ratio-edit" onclick="showSmartCropModal(' + i + ',\x272:3\x27)">\u270f\ufe0f Edit</button></div>' +
        '</div>' +
        '<button class="clip-video-toggle" onclick="toggleVideo(this,' + i + ')">\u25b6 Preview</button>' +
        '<div class="clip-video-wrapper" id="clip-video-' + i + '">' + previewHtml + '</div>' +
        '</div>';
}

form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const youtubeUrl = document.getElementById('youtubeUrl').value.trim(), baseUrl = document.getElementById('baseUrl').value.trim(), apiKey = document.getElementById('apiKey').value.trim();
    const model = getSelectedModel(), clipCount = parseInt(clipCountSlider.value), minDur = parseInt(minSlider.value), maxDur = parseInt(maxSlider.value);
    const smartCrop = false;
    if (!youtubeUrl || !baseUrl || !apiKey) { alert('Masukkan YouTube URL, OpenAI-Compatible Base URL, dan API Key'); return; }
    clearProgressLog();
    progressBar.style.width = '0%';
    progressPercent.textContent = '0%';
    progressSubtitle.textContent = 'Memulai analisa...';
    submitBtn.disabled = true; submitBtn.classList.add('btn-loading'); submitBtn.textContent = '⏳ Memproses...';
    try {
        const r = await fetch('/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ youtubeUrl, baseUrl, apiKey, model, clipCount, minDuration: minDur, maxDuration: maxDur, smartCrop }) });
        const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Error');
        currentJobId = d.jobId; formCard.classList.add('hidden'); progressCard.classList.remove('hidden'); addLog('🚀 Job dimulai...');
        let sseEventCount = 0;
        const es = new EventSource(`/api/progress/${currentJobId}`);
        const progressFallback = startProgressFallback(currentJobId, es);
        es.onmessage = (ev) => {
            let m;
            try {
                m = JSON.parse(ev.data);
            } catch (parseErr) {
                console.error('Progress parse error:', parseErr, ev.data);
                addLog('⚠️ Progress event invalid', 'error');
                return;
            }
            sseEventCount += 1;
            progressFallback.syncCount(sseEventCount);
            const status = applyProgressEventToUI(m);
            if (status === 'done' || status === 'error') {
                progressFallback.stop();
            }
        };
        es.onerror = (err) => {
            console.error('SSE connection error:', err);
            addLog('⚠️ Connection lost', 'error');
        };
    } catch (err) { showError(err.message); }
});

function showResults(results, preserveSelection) { allResults = results.map(normalizeClipForUI); if (!preserveSelection) { selectedClipIndices = new Set(allResults.map((_, i) => i)); } progressCard.classList.add('hidden'); resultCard.classList.remove('hidden'); document.getElementById('resultTitle').textContent = `${allResults.length} Clip Siap! 🎉`; document.getElementById('resultSubtitle').textContent = 'AI telah memilih segment terbaik'; const g = document.getElementById('clipGallery'); g.classList.remove('view-list', 'view-grid'); g.classList.add('view-' + currentView); clipGallery.innerHTML = allResults.map((c, i) => buildClipCard(c, i)).join(''); updateSelectedClipsUI(); }
function showError(msg) { progressCard.classList.add('hidden'); errorCard.classList.remove('hidden'); document.getElementById('errorMessage').textContent = msg; }

// Persist settings
const baseUrlInput = document.getElementById('baseUrl'); const savedBaseUrl = localStorage.getItem('ai_base_url'); if (savedBaseUrl) baseUrlInput.value = savedBaseUrl; else baseUrlInput.value = 'https://openrouter.ai/api/v1/chat/completions';
baseUrlInput.addEventListener('change', () => localStorage.setItem('ai_base_url', baseUrlInput.value));
const apiKeyInput = document.getElementById('apiKey'); const savedKey = localStorage.getItem('ai_api_key') || localStorage.getItem('openrouter_api_key'); if (savedKey) apiKeyInput.value = savedKey;
apiKeyInput.addEventListener('change', () => localStorage.setItem('ai_api_key', apiKeyInput.value));
const modelSelect = document.getElementById('model'), customModelInput = document.getElementById('customModel');
const savedModel = localStorage.getItem('selected_model'), savedCustom = localStorage.getItem('custom_model_id');
if (savedCustom) customModelInput.value = savedCustom; if (savedModel === '__custom__') { modelSelect.value = '__custom__'; customModelInput.classList.remove('hidden'); } else if (savedModel) modelSelect.value = savedModel;
modelSelect.addEventListener('change', () => localStorage.setItem('selected_model', modelSelect.value));
customModelInput.addEventListener('input', () => localStorage.setItem('custom_model_id', customModelInput.value));
function toggleCustomModel() { const c = modelSelect.value === '__custom__'; customModelInput.classList.toggle('hidden', !c); if (c) customModelInput.focus(); }
function getSelectedModel() { return modelSelect.value === '__custom__' ? (customModelInput.value.trim() || 'google/gemini-2.0-flash-001') : modelSelect.value; }

// YouTube API
async function checkYouTubeStatus() { try { const r = await fetch('/api/youtube/status'); const d = await r.json(); const dot = document.getElementById('ytDot'), txt = document.getElementById('ytStatusText'), cb = document.getElementById('btnYtConnect'), db = document.getElementById('btnYtDisconnect'); if (d.status === 'connected') { dot.className = 'yt-status-dot connected'; txt.textContent = '✅ Connected'; cb.classList.add('hidden'); db.classList.remove('hidden'); } else if (d.status === 'disconnected') { dot.className = 'yt-status-dot disconnected'; txt.textContent = 'client_secret.json found — klik Connect'; cb.classList.remove('hidden'); db.classList.add('hidden'); } else { dot.className = 'yt-status-dot'; txt.textContent = 'Not configured'; cb.classList.add('hidden'); db.classList.add('hidden'); } } catch (e) { } }
async function connectYouTube() { try { const r = await fetch('/api/youtube/auth'); const d = await r.json(); if (d.authUrl) window.open(d.authUrl, '_blank'); } catch (e) { alert('Error: ' + e.message); } }
async function disconnectYouTube() { if (!confirm('Disconnect YouTube API?')) return; try { await fetch('/api/youtube/disconnect', { method: 'DELETE' }); checkYouTubeStatus(); } catch (e) { } }
checkYouTubeStatus();
const urlParams = new URLSearchParams(window.location.search);
if (urlParams.get('youtube') === 'connected') { checkYouTubeStatus(); window.history.replaceState({}, '', '/'); }

// Cookies
async function checkCookiesStatus() { try { const r = await fetch('/api/cookies-status'); const d = await r.json(); const dot = document.getElementById('cookiesDot'), txt = document.getElementById('cookiesText'), db = document.getElementById('btnDeleteCookies'); if (d.exists) { dot.className = 'cookies-dot active'; txt.textContent = `🍪 ${d.cookieCount} entries`; db.classList.remove('hidden'); } else { dot.className = 'cookies-dot inactive'; txt.textContent = 'Belum ada cookies'; db.classList.add('hidden'); } } catch (e) { } }
async function uploadCookies(inp) { const f = inp.files[0]; if (!f) return; const t = await f.text(); try { const r = await fetch('/api/upload-cookies', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: t }); const d = await r.json(); if (d.success) checkCookiesStatus(); else alert('Gagal: ' + (d.error || '')); } catch (e) { alert('Error: ' + e.message); } inp.value = ''; }
async function deleteCookies() { if (!confirm('Hapus cookies.txt?')) return; try { await fetch('/api/delete-cookies', { method: 'DELETE' }); checkCookiesStatus(); } catch (e) { } }
checkCookiesStatus();

// ============================================
//  TAB BULK YOUTUBE
// ============================================
var bulkItemsWrap = document.getElementById('bulkItems');
var bulkForm = document.getElementById('bulkAnalyzeForm');
var bulkClipCountSlider = document.getElementById('bulkClipCount');
var bulkClipCountLabel = document.getElementById('bulkClipCountLabel');
var bulkMinDuration = document.getElementById('bulkMinDuration');
var bulkMaxDuration = document.getElementById('bulkMaxDuration');
var bulkMinValue = document.getElementById('bulkMinValue');
var bulkMaxValue = document.getElementById('bulkMaxValue');
var bulkDurationLabel = document.getElementById('bulkDurationLabel');
var BULK_DRAFT_KEY = 'bulk_youtube_last_draft_v1';

function bulkApplyCookieStatus(item) {
    if (!item) return;
    var hasCookies = !!(item.querySelector('.bulk-cookies-text').value || '').trim();
    var dot = item.querySelector('.bulk-cookies-dot');
    var label = item.querySelector('.bulk-cookies-label');
    var del = item.querySelector('.btn-cookie-delete');
    if (dot) dot.className = hasCookies ? 'cookies-dot active bulk-cookies-dot' : 'cookies-dot inactive bulk-cookies-dot';
    if (label) label.textContent = hasCookies ? '🍪 cookies.txt loaded' : 'Belum ada cookies';
    if (del) del.classList.toggle('hidden', !hasCookies);
}

function bulkCollectDraft() {
    return {
        clipCount: parseInt((bulkClipCountSlider && bulkClipCountSlider.value) || '10'),
        minDuration: parseInt((bulkMinDuration && bulkMinDuration.value) || '30'),
        maxDuration: parseInt((bulkMaxDuration && bulkMaxDuration.value) || '90'),
        items: Array.from(document.querySelectorAll('#bulkItems .bulk-item')).map(function (item) {
            return {
                youtubeUrl: (item.querySelector('.bulk-youtube-url').value || '').trim(),
                cookiesText: (item.querySelector('.bulk-cookies-text').value || '').trim()
            };
        }).filter(function (it) { return it.youtubeUrl || it.cookiesText; })
    };
}

function bulkSaveDraft() {
    try { localStorage.setItem(BULK_DRAFT_KEY, JSON.stringify(bulkCollectDraft())); } catch (e) { }
}

function bulkLoadDraft() {
    try {
        var raw = localStorage.getItem(BULK_DRAFT_KEY);
        if (!raw) return false;
        var draft = JSON.parse(raw);
        if (bulkClipCountSlider && draft.clipCount) bulkClipCountSlider.value = String(draft.clipCount);
        if (bulkMinDuration && draft.minDuration) bulkMinDuration.value = String(draft.minDuration);
        if (bulkMaxDuration && draft.maxDuration) bulkMaxDuration.value = String(draft.maxDuration);
        if (bulkItemsWrap) {
            bulkItemsWrap.innerHTML = '';
            var items = Array.isArray(draft.items) ? draft.items : [];
            if (items.length === 0) { bulkAddItem(); bulkAddItem(); }
            else items.forEach(function (it) { bulkAddItem(it.youtubeUrl || '', it.cookiesText || ''); });
        }
        return true;
    } catch (e) {
        return false;
    }
}

function bulkItemTemplate(idx) {
    return '<div class="bulk-item" data-idx="' + idx + '" style="padding:14px;border:1px solid rgba(255,255,255,0.08);border-radius:12px;margin-bottom:12px;background:rgba(255,255,255,0.03)">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px"><strong>Item ' + (idx + 1) + '</strong><button type="button" onclick="bulkRemoveItem(this)" style="background:none;border:none;color:#ff8a8a;cursor:pointer">Hapus</button></div>' +
        '<input type="url" class="bulk-youtube-url" placeholder="https://www.youtube.com/watch?v=..." style="width:100%;margin-bottom:10px" required>' +
        '<input type="hidden" class="bulk-cookies-text" value="">' +
        '<div class="cookies-section" style="margin-top:6px">' +
        '<div class="cookies-status"><span class="cookies-dot inactive bulk-cookies-dot"></span><span class="bulk-cookies-label">Belum ada cookies</span></div>' +
        '<div class="cookies-actions">' +
        '<input type="file" accept=".txt" style="display:none" onchange="bulkLoadCookiesFile(this)">' +
        '<button type="button" class="btn-cookie-upload" onclick="this.previousElementSibling.click()">Upload cookies.txt</button>' +
        '<button type="button" class="btn-cookie-delete hidden" onclick="bulkClearCookies(this)">Hapus</button>' +
        '</div>' +
        '</div>' +
        '</div>';
}

function bulkAddItem(url, cookiesText) {
    if (!bulkItemsWrap) return;
    var idx = bulkItemsWrap.children.length;
    bulkItemsWrap.insertAdjacentHTML('beforeend', bulkItemTemplate(idx));
    var item = bulkItemsWrap.lastElementChild;
    if (url) item.querySelector('.bulk-youtube-url').value = url;
    if (cookiesText) item.querySelector('.bulk-cookies-text').value = cookiesText;
    bulkApplyCookieStatus(item);
    bulkSaveDraft();
}

function bulkRemoveItem(btn) {
    var item = btn.closest('.bulk-item');
    if (item) item.remove();
    bulkSaveDraft();
}

async function bulkLoadCookiesFile(input) {
    var file = input.files[0];
    if (!file) return;
    var text = await file.text();
    var item = input.closest('.bulk-item');
    if (item) {
        item.querySelector('.bulk-cookies-text').value = text;
        bulkApplyCookieStatus(item);
        bulkSaveDraft();
    }
    input.value = '';
}

function bulkClearCookies(btn) {
    var item = btn.closest('.bulk-item');
    if (!item) return;
    item.querySelector('.bulk-cookies-text').value = '';
    bulkApplyCookieStatus(item);
    bulkSaveDraft();
}

function bulkLog(msg, type) {
    var el = document.getElementById('bulkProgressLog');
    if (!el) return;
    var t = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    var row = document.createElement('div');
    row.className = `log-entry ${type === 'done' ? 'log-done' : ''} ${type === 'error' ? 'log-error' : ''}`;
    row.innerHTML = `<span class="log-time">${t}</span><span class="log-msg">${msg}</span>`;
    el.appendChild(row);
    el.scrollTop = el.scrollHeight;
}

if (bulkItemsWrap && bulkItemsWrap.children.length === 0 && !bulkLoadDraft()) { bulkAddItem(); bulkAddItem(); }

if (bulkClipCountSlider) {
    bulkClipCountSlider.addEventListener('input', function () {
        if (bulkClipCountLabel) bulkClipCountLabel.textContent = bulkClipCountSlider.value + ' clip';
        bulkSaveDraft();
    });
}

function syncBulkDurationLabels() {
    if (!bulkMinDuration || !bulkMaxDuration) return;
    var min = parseInt(bulkMinDuration.value || '30');
    var max = parseInt(bulkMaxDuration.value || '90');
    if (min > max) {
        bulkMaxDuration.value = min;
        max = min;
    }
    if (bulkMinValue) bulkMinValue.textContent = min + 's';
    if (bulkMaxValue) bulkMaxValue.textContent = max + 's';
    if (bulkDurationLabel) bulkDurationLabel.textContent = min + 's — ' + max + 's';
    bulkSaveDraft();
}

if (bulkMinDuration) bulkMinDuration.addEventListener('input', syncBulkDurationLabels);
if (bulkMaxDuration) bulkMaxDuration.addEventListener('input', function () {
    var min = parseInt(bulkMinDuration.value || '30');
    var max = parseInt(bulkMaxDuration.value || '90');
    if (max < min) bulkMinDuration.value = max;
    syncBulkDurationLabels();
});
syncBulkDurationLabels();
if (bulkItemsWrap) {
    bulkItemsWrap.addEventListener('input', function (e) {
        if (e.target && (e.target.classList.contains('bulk-youtube-url') || e.target.classList.contains('bulk-cookies-text'))) bulkSaveDraft();
    });
}

if (bulkForm) bulkForm.addEventListener('submit', async function (e) {
    e.preventDefault();
    bulkSaveDraft();
    var baseUrl = document.getElementById('baseUrl').value.trim();
    var apiKey = document.getElementById('apiKey').value.trim();
    if (!baseUrl || !apiKey) return alert('Masukkan OpenAI-Compatible Base URL dan API Key');
    var items = Array.from(document.querySelectorAll('#bulkItems .bulk-item')).map(function (item) {
        return {
            youtubeUrl: item.querySelector('.bulk-youtube-url').value.trim(),
            cookiesText: item.querySelector('.bulk-cookies-text').value.trim()
        };
    }).filter(function (item) { return item.youtubeUrl; });
    if (!items.length) return alert('Masukkan minimal satu URL YouTube');

    document.getElementById('bulkFormCard').classList.add('hidden');
    document.getElementById('bulkProgressCard').classList.remove('hidden');
    document.getElementById('bulkResultCard').classList.add('hidden');
    document.getElementById('bulkProgressLog').innerHTML = '';

    try {
        var r = await fetch('/api/analyze-bulk', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                items: items,
                baseUrl: baseUrl,
                apiKey: apiKey,
                model: getSelectedModel(),
                clipCount: parseInt(document.getElementById('bulkClipCount').value || '10'),
                minDuration: parseInt(document.getElementById('bulkMinDuration').value || '30'),
                maxDuration: parseInt(document.getElementById('bulkMaxDuration').value || '90'),
                smartCrop: false
            })
        });
        var data = await r.json();
        if (!r.ok) throw new Error(data.error || 'Bulk analyze gagal');
        var es = new EventSource('/api/progress/' + data.jobId);
        es.onmessage = function (ev) {
            var m = JSON.parse(ev.data);
            if (m.progress >= 0) {
                document.getElementById('bulkProgressBar').style.width = m.progress + '%';
                document.getElementById('bulkProgressPercent').textContent = m.progress + '%';
            }
            if (m.message) {
                document.getElementById('bulkProgressSubtitle').textContent = m.message;
                bulkLog(m.message, m.step && m.step.indexOf('error') >= 0 ? 'error' : (m.step === 'done' ? 'done' : 'info'));
            }
            if (m.step === 'connected') {
                document.getElementById('bulkProgressSubtitle').textContent = 'Menunggu proses bulk dimulai...';
            }
            if (m.step === 'done') {
                es.close();
                document.getElementById('bulkProgressCard').classList.add('hidden');
                document.getElementById('bulkResultCard').classList.remove('hidden');
                document.getElementById('bulkResultList').innerHTML = (m.results || []).map(function (item, idx) {
                    return '<div style="padding:14px;border:1px solid rgba(255,255,255,0.08);border-radius:12px;background:rgba(255,255,255,0.03)">' +
                        '<div style="font-weight:700;margin-bottom:6px">Item ' + (idx + 1) + '</div>' +
                        '<div style="font-size:0.85rem;opacity:0.85;margin-bottom:4px">' + item.youtubeUrl + '</div>' +
                        (item.error ? '<div style="color:#ff8a8a">❌ ' + item.error + '</div>' : '<div>✅ ' + item.videoTitle + ' — ' + item.clipCount + ' clip</div><div style="opacity:0.75">Masuk ke History</div>') +
                        '</div>';
                }).join('');
            }
            if (m.step === 'error') {
                es.close();
                bulkLog(m.error || m.message, 'error');
            }
        };
    } catch (err) {
        alert(err.message);
        document.getElementById('bulkFormCard').classList.remove('hidden');
        document.getElementById('bulkProgressCard').classList.add('hidden');
    }
});

// ============================================
// HISTORY PANEL — YouTube AI Cutter
// ============================================
function openHistoryPanel() {
    document.getElementById('historyPanel').style.display = 'block';
    document.getElementById('historyOverlay').style.display = 'block';
    loadHistory();
}
function closeHistoryPanel() {
    document.getElementById('historyPanel').style.display = 'none';
    document.getElementById('historyOverlay').style.display = 'none';
}

async function loadHistory() {
    const list = document.getElementById('historyList');
    list.innerHTML = '<div style="text-align:center;padding:30px;color:rgba(255,255,255,0.5);">⏳ Memuat history...</div>';
    try {
        const r = await fetch('/api/history');
        const d = await r.json();
        if (!d.success || !d.entries || d.entries.length === 0) {
            list.innerHTML = '<div style="text-align:center;padding:40px 20px;color:rgba(255,255,255,0.4);"><div style="font-size:2.5rem;margin-bottom:10px;">📂</div><p style="margin:0;">Belum ada history</p></div>';
            return;
        }
        list.innerHTML = d.entries.map(e => {
            const dt = new Date(e.date).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
            const thumb = e.thumbnail ? `<img src="${e.thumbnail}" style="width:100%;height:80px;object-fit:cover;border-radius:6px 6px 0 0;display:block;" onerror="this.style.display='none'">` : `<div style="height:5px;background:linear-gradient(90deg,var(--accent-blue,#4f8ef7),var(--accent-cyan,#19d4e3));border-radius:6px 6px 0 0;"></div>`;
            return `<div style="background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);border-radius:10px;overflow:hidden;">
                ${thumb}
                <div style="padding:12px;">
                    <div style="font-size:0.9rem;font-weight:600;color:#fff;margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${e.title}">${e.title}</div>
                    <div style="font-size:0.75rem;color:rgba(255,255,255,0.45);margin-bottom:10px;">🎬 ${e.clipCount} clips &nbsp;·&nbsp; 📅 ${dt}</div>
                    <div style="display:flex;gap:8px;">
                        <button onclick="loadHistoryEntry('${e.id}')" style="flex:1;background:linear-gradient(90deg,var(--accent-blue,#4f8ef7),var(--accent-cyan,#19d4e3));border:none;color:#fff;padding:7px;border-radius:7px;cursor:pointer;font-size:0.82rem;font-weight:600;">📂 Buka</button>
                        <button onclick="deleteHistoryEntry('${e.id}', this)" style="background:rgba(255,80,80,0.15);border:1px solid rgba(255,80,80,0.3);color:#ff6b6b;padding:7px 12px;border-radius:7px;cursor:pointer;font-size:0.82rem;">🗑</button>
                    </div>
                </div>
            </div>`;
        }).join('');
    } catch (e) {
        list.innerHTML = '<div style="text-align:center;padding:30px;color:rgba(255,100,100,0.7);">❌ Gagal memuat history</div>';
    }
}

async function loadHistoryEntry(id) {
    try {
        const r = await fetch(`/api/history/${id}`);
        const d = await r.json();
        if (!d.success || !d.results) { alert('Gagal memuat data history'); return; }
        closeHistoryPanel();
        // Restore YouTube URL if available
        if (d.youtubeUrl) document.getElementById('youtubeUrl').value = d.youtubeUrl;
        // Set jobId and show results
        currentJobId = d.id;
        showResults(d.results);
        // Scroll to results
        document.getElementById('resultCard').scrollIntoView({ behavior: 'smooth' });
    } catch (e) { alert('Error: ' + e.message); }
}

async function deleteHistoryEntry(id, btn) {
    if (!confirm('Hapus history ini?')) return;
    btn.textContent = '⏳';
    try {
        await fetch(`/api/history/${id}`, { method: 'DELETE' });
        loadHistory(); // Refresh the list
    } catch (e) { btn.textContent = '🗑'; alert('Gagal menghapus'); }
}

// === COMPUTE CROP BOX FOR A TARGET RATIO ===
// Returns {x, y, w, h} in 0-1 normalized coords that gives the target aspect ratio
function computeRatioCrop(videoW, videoH, ratioStr) {
    var parts = ratioStr.split(':');
    var rw = parseInt(parts[0]), rh = parseInt(parts[1]);
    var targetAR = rw / rh; // e.g. 9/16 = 0.5625
    var videoAR = videoW / videoH;

    var cropW, cropH;
    if (targetAR < videoAR) {
        // Target is taller than video aspect → height is full, width is narrower
        cropH = 1;
        cropW = (targetAR / videoAR);
    } else {
        // Target is wider than video aspect → width is full, height is shorter
        cropW = 1;
        cropH = (videoAR / targetAR);
    }
    // Center it
    var x = (1 - cropW) / 2;
    var y = (1 - cropH) / 2;
    return { x: x, y: y, w: cropW, h: cropH };
}

// === CONVERT MODAL ===
var _cvtClipIndex = 0, _cvtRatio = '9:16', _cvtMode = 'single';
var _cvtLastVideoUrl = '', _cvtLastClipData = null, _cvtGlobalHashtagsRaw = '';

function getConvertGlobalHashtagsInput() {
    return document.getElementById('convertGlobalHashtags');
}

function getConvertGlobalHashtagsRaw() {
    return String(_cvtGlobalHashtagsRaw || '');
}

function setConvertGlobalHashtagsRaw(value) {
    _cvtGlobalHashtagsRaw = String(value || '');
    var input = getConvertGlobalHashtagsInput();
    if (input && input.value !== _cvtGlobalHashtagsRaw) input.value = _cvtGlobalHashtagsRaw;
}

function normalizeHashtagTokens(input) {
    return [...new Set(String(input || '')
        .replace(/[\r\n,]+/g, ' ')
        .split(/\s+/)
        .map(function (token) {
            token = String(token || '').trim();
            if (!token) return '';
            token = token.replace(/^#+/, '').replace(/[^\w.-]+/g, '' );
            return token ? ('#' + token.toLowerCase()) : '';
        })
        .filter(Boolean))];
}

function splitCaptionAndHashtags(caption) {
    var text = String(caption || '').replace(/\r/g, '').trim();
    if (!text) return { body: '', hashtags: [] };
    var tokens = text.split(/\s+/);
    var tailTags = [];
    while (tokens.length) {
        var token = tokens[tokens.length - 1];
        if (!/^#/.test(token)) break;
        tailTags.unshift(tokens.pop());
    }
    return {
        body: tokens.join(' ').trim(),
        hashtags: normalizeHashtagTokens(tailTags.join(' '))
    };
}

function mergeCaptionWithGlobalHashtags(caption, globalInput) {
    var parsed = splitCaptionAndHashtags(caption);
    var extraTags = normalizeHashtagTokens(globalInput);
    if (!extraTags.length) return String(caption || '').trim();

    var existing = parsed.hashtags.slice();
    var existingSet = new Set(existing.map(function (tag) { return tag.toLowerCase(); }));
    extraTags.forEach(function (tag) {
        var key = tag.toLowerCase();
        if (!existingSet.has(key)) {
            existing.push(tag);
            existingSet.add(key);
        }
    });

    if (!parsed.body) return existing.join(' ').trim();
    return parsed.body + '\n\n' + existing.join(' ');
}

function getConvertFinalCaption(baseCaption) {
    return mergeCaptionWithGlobalHashtags(baseCaption, getConvertGlobalHashtagsRaw());
}

function getConvertCurrentCaption() {
    if (!_cvtLastClipData) return getConvertFinalCaption('');
    return getConvertFinalCaption(_cvtLastClipData.caption || '');
}

function getConvertCurrentActionData() {
    return {
        title: _cvtLastClipData && _cvtLastClipData.title ? _cvtLastClipData.title : '',
        caption: getConvertCurrentCaption()
    };
}

function applyGlobalHashtagsToClip(clip) {
    if (!clip || typeof clip !== 'object') return clip;
    return Object.assign({}, clip, {
        caption: getConvertFinalCaption(clip.caption || '')
    });
}

function bindConvertGlobalHashtagsInput() {
    var input = getConvertGlobalHashtagsInput();
    if (!input || input.dataset.bound === '1') return;
    input.addEventListener('input', function () {
        setConvertGlobalHashtagsRaw(input.value || '');
    });
    input.dataset.bound = '1';
}

function getTableShareLocalMediaMap() {
    try {
        var raw = localStorage.getItem('table_share_local_media_map');
        var parsed = raw ? JSON.parse(raw) : {};
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (e) {
        return {};
    }
}

function setTableShareLocalMedia(link, localMediaUrl) {
    var normalizedLink = String(link || '').trim();
    var normalizedLocalUrl = String(localMediaUrl || '').trim();
    if (!normalizedLink || !normalizedLocalUrl) return;
    var map = getTableShareLocalMediaMap();
    map[normalizedLink] = normalizedLocalUrl;
    try {
        localStorage.setItem('table_share_local_media_map', JSON.stringify(map));
    } catch (e) { }
}

function getTableShareLocalMedia(link) {
    var normalizedLink = String(link || '').trim();
    if (!normalizedLink) return '';
    var map = getTableShareLocalMediaMap();
    return String(map[normalizedLink] || '').trim();
}

function updateConvertCompleteActions() {
    var hashtagInput = getConvertGlobalHashtagsInput();
    if (hashtagInput && hashtagInput.value !== getConvertGlobalHashtagsRaw()) {
        hashtagInput.value = getConvertGlobalHashtagsRaw();
    }

    var saveBtn = document.getElementById('convertSaveTableBtn');
    var hint = document.getElementById('convertSaveTableHint');
    if (!saveBtn || !hint) return;

    var canSaveAll = !!(_cvtLastClipData && _cvtLastClipData.mode === 'all' && Array.isArray(_cvtLastClipData.clips) && _cvtLastClipData.clips.length);
    saveBtn.style.display = canSaveAll ? 'flex' : 'none';
    saveBtn.disabled = false;
    saveBtn.textContent = '🗂 Simpan Semua ke Tabel';
    hint.style.display = canSaveAll ? 'block' : 'none';
    hint.textContent = canSaveAll
        ? (_cvtLastClipData.clips.length + ' clip MP4 akan diupload ke Catbox lalu disimpan ke tabel dengan status pending.')
        : '';
}

async function saveConvertedClipsToTable() {
    if (!_cvtLastClipData || _cvtLastClipData.mode !== 'all' || !Array.isArray(_cvtLastClipData.clips) || !_cvtLastClipData.clips.length) {
        alert('Data clip convert belum tersedia untuk disimpan ke tabel');
        return;
    }

    var saveBtn = document.getElementById('convertSaveTableBtn');
    var hint = document.getElementById('convertSaveTableHint');
    if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.textContent = '⏳ Menyimpan...';
    }
    if (hint) {
        hint.style.display = 'block';
        hint.textContent = 'Sedang upload clip ke Catbox dan menyimpan data ke tabel...';
    }

    try {
        var tableClips = (_cvtLastClipData.clips || []).map(applyGlobalHashtagsToClip);
        var resp = await fetch('/api/video-share/batch-from-convert', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jobId: currentJobId,
                ratio: _cvtLastClipData.ratio,
                selectedIndices: _cvtLastClipData.selectedIndices || [],
                clips: tableClips
            })
        });
        var data = await resp.json();
        if (!resp.ok) throw new Error(data.error || 'Gagal simpan ke tabel');
        if (_cvtLastClipData && Array.isArray(data.rows) && data.rows.length) {
            _cvtLastClipData.savedRows = data.rows;
            data.rows.forEach(function (row) {
                if (row && row.link && row.localMediaUrl) {
                    setTableShareLocalMedia(row.link, row.localMediaUrl);
                }
            });
        }
        if (hint) hint.textContent = (data.saved || 0) + ' clip berhasil disimpan ke tabel share video.';
        if (saveBtn) saveBtn.textContent = '✅ Tersimpan ke Tabel';
        rzBulkShowToast((data.saved || 0) + ' clip masuk tabel share video', 'success');
    } catch (e) {
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.textContent = '🗂 Simpan Semua ke Tabel';
        }
        if (hint) hint.textContent = 'Gagal simpan ke tabel: ' + e.message;
        alert('Gagal simpan ke tabel: ' + e.message);
    }
}

function showConvertModal(clipIndex, ratio, mode) {
    _cvtClipIndex = clipIndex; _cvtRatio = ratio; _cvtMode = mode;
    var extraText = '';
    if (clipIndex >= 0 && allResults[clipIndex]) {
        var extra = getClipEndExtendSeconds(allResults[clipIndex]);
        if (extra > 0) extraText = ' · + ' + extra + 's akhir';
    }
    document.getElementById('convertModalRatio').textContent = 'Rasio: ' + ratio + (mode === 'all' ? ' (semua clip terpilih)' : '') + extraText;
    document.getElementById('convertSmartCrop').checked = true;
    document.getElementById('convertDetectMode').value = 'balanced';
    document.getElementById('convertAutoCaption').checked = true;
    document.getElementById('convertCaptionProvider').value = localStorage.getItem('caption_provider') || 'elevenlabs';
    // Restore saved ElevenLabs key
    var savedKey = localStorage.getItem('elevenlabs_api_key');
    if (savedKey) document.getElementById('convertElevenLabsKey').value = savedKey;
    onConvertCaptionProviderChange();
    document.getElementById('convertModal').style.display = 'flex';
}
function closeConvertModal() { document.getElementById('convertModal').style.display = 'none'; }

function onConvertCaptionProviderChange() {
    var autoCaption = document.getElementById('convertAutoCaption').checked;
    var provider = document.getElementById('convertCaptionProvider').value || 'elevenlabs';
    localStorage.setItem('caption_provider', provider);
    document.getElementById('convertCaptionProviderGroup').classList.toggle('hidden', !autoCaption);
    document.getElementById('convertElevenLabsGroup').classList.toggle('hidden', !autoCaption || provider !== 'elevenlabs');
    document.getElementById('convertWhisperGroup').classList.toggle('hidden', !autoCaption || provider !== 'whisper');
}

// Also keep showSmartCropModal as alias for Edit button
function showSmartCropModal(clipIndex, ratio) { showConvertModal(clipIndex, ratio, 'edit'); }
function closeSmartCropModal() { closeConvertModal(); }

async function parseApiErrorResponse(resp, fallbackMessage) {
    var text = '';
    try { text = await resp.text(); } catch (e) { }
    var contentType = (resp.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('application/json')) {
        try {
            var data = JSON.parse(text || '{}');
            return data.error || data.message || fallbackMessage;
        } catch (e) { }
    }
    if (text && text.trim().startsWith('<!DOCTYPE')) {
        return fallbackMessage + ' (server returned HTML, not JSON)';
    }
    return (text || fallbackMessage || 'Request failed').slice(0, 300);
}

async function confirmConvertModal() {

    var smartCrop = document.getElementById('convertSmartCrop').checked;
    var detectMode = document.getElementById('convertDetectMode').value || 'balanced';
    var autoCaption = document.getElementById('convertAutoCaption').checked;
    var captionProvider = document.getElementById('convertCaptionProvider').value || 'elevenlabs';
    var elevenLabsKey = document.getElementById('convertElevenLabsKey').value.trim();
    var whisperModel = document.getElementById('convertWhisperModel').value || 'base';

    // Save ElevenLabs key to localStorage
    if (elevenLabsKey) localStorage.setItem('elevenlabs_api_key', elevenLabsKey);

    // If mode is 'edit', go to cropper editor (old Edit button behavior)
    if (_cvtMode === 'edit') {
        closeConvertModal();
        editInCropper(_cvtClipIndex, _cvtRatio, smartCrop);
        return;
    }

    // Check autoCaption requires API key
    if (autoCaption && captionProvider === 'elevenlabs' && !elevenLabsKey) {
        alert('Masukkan ElevenLabs API Key untuk Auto Caption!');
        showConvertModal(_cvtClipIndex, _cvtRatio, _cvtMode);
        return;
    }

    // Show full-screen loading overlay
    var loadingOverlay = document.createElement('div');
    loadingOverlay.id = 'convertLoadingOverlay';
    loadingOverlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:9999;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:16px;color:#fff';
    loadingOverlay.innerHTML = '<div style="width:48px;height:48px;border:4px solid rgba(255,255,255,0.15);border-top:4px solid var(--accent-primary);border-radius:50%;animation:spin 0.8s linear infinite"></div>' +
        '<p style="font-size:1.1rem;font-weight:700" id="convertLoadingText">🎬 Converting...</p>' +
        '<p style="font-size:0.82rem;color:rgba(255,255,255,0.5)" id="convertLoadingDetail">Smart crop + caption processing</p>' +
        '<div id="convertStageLog" style="width:min(760px,90vw);max-height:220px;overflow:auto;padding:12px 14px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);border-radius:10px;font-size:0.82rem;line-height:1.45"></div>' +
        '<div id="convertLoadingError" style="display:none;width:min(760px,90vw);padding:12px 14px;background:rgba(255,80,80,0.12);border:1px solid rgba(255,80,80,0.35);border-radius:10px;font-size:0.85rem;line-height:1.45;color:#ffd3d3"></div>' +
        '<div id="convertLoadingActions" style="display:none;width:min(760px,90vw);justify-content:flex-end;gap:10px">' +
        '<button type="button" id="convertDismissBtn" style="padding:10px 16px;border-radius:999px;border:1px solid rgba(255,255,255,0.16);background:rgba(255,255,255,0.06);color:#fff;cursor:pointer">Tutup</button>' +
        '<button type="button" id="convertKeepOpenBtn" style="padding:10px 16px;border-radius:999px;border:1px solid rgba(167,139,250,0.35);background:rgba(167,139,250,0.18);color:#fff;cursor:pointer">Tetap lihat log</button>' +
        '</div>' +
        '<style>@keyframes spin{to{transform:rotate(360deg)}}</style>';
    document.body.appendChild(loadingOverlay);

    var convertStageES = null;
    var convertStagePoller = null;
    var convertStageSeen = new Set();
    var convertRequestFailed = false;
    var convertDismissRequested = false;
    function appendConvertStage(msg) {
        var logEl = document.getElementById('convertStageLog');
        if (!logEl || !msg) return;
        var t = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        var row = document.createElement('div');
        row.style.padding = '4px 0';
        row.textContent = t + '  ' + msg;
        logEl.appendChild(row);
        logEl.scrollTop = logEl.scrollHeight;
    }
    function applyConvertStageEvent(m) {
        if (!m || !m.message) return;
        var key = [m._ts || '', m.step || '', m.message].join('|');
        if (convertStageSeen.has(key)) return;
        convertStageSeen.add(key);
        if (m.step === 'convert_stage' || String(m.step || '').startsWith('convert_') || m.step === 'error') {
            appendConvertStage(m.message);
            var detailEl = document.getElementById('convertLoadingDetail');
            if (detailEl) detailEl.textContent = m.message;
        }
    }
    function setConvertOverlayError(message) {
        convertRequestFailed = true;
        var statusEl = document.getElementById('convertLoadingText');
        var detailEl = document.getElementById('convertLoadingDetail');
        var errEl = document.getElementById('convertLoadingError');
        var actionsEl = document.getElementById('convertLoadingActions');
        var dismissBtn = document.getElementById('convertDismissBtn');
        var keepBtn = document.getElementById('convertKeepOpenBtn');
        if (statusEl) statusEl.textContent = '⚠️ Convert request gagal';
        if (detailEl) detailEl.textContent = 'Backend mungkin masih lanjut. Cek log terakhir di bawah.';
        if (errEl) {
            errEl.style.display = 'block';
            errEl.textContent = message;
        }
        if (actionsEl) actionsEl.style.display = 'flex';
        if (dismissBtn) dismissBtn.onclick = function () {
            convertDismissRequested = true;
            if (convertStageES) { try { convertStageES.close(); } catch (e) { } }
            if (convertStagePoller) clearInterval(convertStagePoller);
            var ov2 = document.getElementById('convertLoadingOverlay');
            if (ov2) ov2.remove();
        };
        if (keepBtn) keepBtn.onclick = function () {
            if (errEl) errEl.textContent = message + ' — log tetap dipantau.';
        };
    }
    async function pollConvertStageHistory() {
        if (!currentJobId) return;
        try {
            var resp = await fetch('/api/progress/' + currentJobId + '/history', { cache: 'no-store' });
            if (!resp.ok) return;
            var data = await resp.json();
            var events = Array.isArray(data && data.events) ? data.events : [];
            events.forEach(applyConvertStageEvent);
        } catch (err) {
            console.error('Convert history polling error:', err);
        }
    }

    if (currentJobId) {
        try {
            convertStageES = new EventSource('/api/progress/' + currentJobId);
            convertStageES.onmessage = function (ev) {
                var m;
                try {
                    m = JSON.parse(ev.data || '{}');
                } catch (e) {
                    console.error('Convert progress parse error:', e, ev.data);
                    return;
                }
                applyConvertStageEvent(m);
            };
            convertStageES.onerror = function (err) {
                console.error('Convert SSE connection error:', err);
                appendConvertStage('⚠️ Progress connection interrupted');
            };
        } catch (e) {
            console.error('Convert SSE init error:', e);
        }
        pollConvertStageHistory();
        convertStagePoller = setInterval(pollConvertStageHistory, 1200);
    }

    try {
        var statusEl = document.getElementById('convertLoadingText');
        var detailEl = document.getElementById('convertLoadingDetail');

        if (_cvtMode === 'all') {
            // Convert all clips
            var selectedIndices = getSelectedClipIndices();
            var selectedClips = selectedIndices.map(function (idx) {
                var clip = allResults[idx] || {};
                return Object.assign({}, clip, { originalIndex: idx });
            });
            if (statusEl) statusEl.textContent = '🎬 Converting ' + selectedIndices.length + ' clips...';
            if (detailEl) detailEl.textContent = (smartCrop ? ('Smart Crop · ' + detectMode) : 'Safe Mode') + (autoCaption ? (' + Caption(' + captionProvider + ')') : '');

            var r = await fetch('/api/convert-ratio-all', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jobId: currentJobId, ratio: _cvtRatio, selectedIndices: selectedIndices, clipEndExtendMap: buildClipEndExtendMap(selectedIndices), smartCrop: smartCrop, detectMode: detectMode, autoCaption: autoCaption, captionProvider: captionProvider, elevenLabsKey: elevenLabsKey, whisperModel: whisperModel })
            });
            if (!r.ok) { throw new Error(await parseApiErrorResponse(r, 'Failed to convert selected clips')); }
            var videoUrl = r.headers.get('X-Video-Url') || '';
            var blob = await r.blob();
            var url = URL.createObjectURL(blob);
            _cvtLastVideoUrl = url;
            _cvtLastClipData = {
                title: 'All Clips (' + _cvtRatio + ')',
                caption: '',
                isZip: true,
                filename: 'all_clips_' + _cvtRatio.replace(':', 'x') + '.zip',
                videoUrl: videoUrl,
                mode: 'all',
                ratio: _cvtRatio,
                selectedIndices: selectedIndices,
                clips: selectedClips
            };
            setConvertGlobalHashtagsRaw('');
        } else {
            // Convert single clip
            var clipIdx = _cvtClipIndex;
            var clip = allResults[clipIdx];
            if (statusEl) statusEl.textContent = '🎬 Converting clip ' + clip.clip_number + '...';
            if (detailEl) detailEl.textContent = (smartCrop ? ('Smart Crop · ' + detectMode) : 'Safe Mode') + (autoCaption ? (' + Caption(' + captionProvider + ')') : '');

            var r = await fetch('/api/convert-ratio', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jobId: currentJobId, clipIndex: clipIdx, ratio: _cvtRatio, endExtendSeconds: getClipEndExtendSeconds(clip), smartCrop: smartCrop, detectMode: detectMode, autoCaption: autoCaption, captionProvider: captionProvider, elevenLabsKey: elevenLabsKey, whisperModel: whisperModel })
            });
            if (!r.ok) { throw new Error(await parseApiErrorResponse(r, 'Failed to convert clip')); }
            var videoUrl = r.headers.get('X-Video-Url') || '';
            var blob = await r.blob();
            var url = URL.createObjectURL(blob);
            _cvtLastVideoUrl = url;
            _cvtLastClipData = { title: clip.hook_title || '', caption: clip.caption || '', isZip: true, filename: 'clip_' + _cvtRatio.replace(':', 'x') + '.zip', videoUrl: videoUrl, mode: 'single', ratio: _cvtRatio, clipIndex: clipIdx };
            setConvertGlobalHashtagsRaw('');
        }

        // Show completion modal
        var infoText = (smartCrop ? ('🧠 Smart Crop · ' + detectMode) : '📐 Safe Mode') + (autoCaption ? (' + 🎙 Caption(' + captionProvider + ')') : '') + ' · ' + _cvtRatio;
        document.getElementById('convertCompleteInfo').textContent = infoText;
        var dlLink = document.getElementById('convertDownloadLink');
        dlLink.href = _cvtLastVideoUrl;
        dlLink.download = _cvtLastClipData.filename;
        dlLink.textContent = '⬇ Download';

        // Hide video preview for zip files
        document.getElementById('convertPreviewWrap').style.display = 'none';
        bindConvertGlobalHashtagsInput();
        updateConvertCompleteActions();

        document.getElementById('convertCompleteModal').style.display = 'flex';

    } catch (e) {
        appendConvertStage('❌ Request gagal: ' + e.message);
        setConvertOverlayError('Convert error: ' + e.message);
    } finally {
        if (convertStageES) {
            try { convertStageES.close(); } catch (e) { }
        }
        if (convertStagePoller) clearInterval(convertStagePoller);
        var ov = document.getElementById('convertLoadingOverlay');
        if (ov && !convertRequestFailed && !convertDismissRequested) ov.remove();
    }
}

function closeConvertCompleteModal() {
    document.getElementById('convertCompleteModal').style.display = 'none';
    var hint = document.getElementById('convertSaveTableHint');
    var saveBtn = document.getElementById('convertSaveTableBtn');
    if (hint) {
        hint.style.display = 'none';
        hint.textContent = '';
    }
    if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.textContent = '🗂 Simpan Semua ke Tabel';
    }
}

async function sendConvertToRepliz() {
    closeConvertCompleteModal();

    // Check Repliz credentials
    var auth = replizGetAuth();
    if (!auth) {
        alert('Set Repliz API keys di tab Repliz terlebih dahulu!');
        switchTab('repliz');
        return;
    }

    try {
        // Fetch the actual video file (not the ZIP) using the server video URL
        var videoUrl = _cvtLastClipData.videoUrl;
        if (!videoUrl) {
            alert('Video URL tidak tersedia untuk Repliz');
            return;
        }
        var resp = await fetch(videoUrl);
        var blob = await resp.blob();
        var videoName = videoUrl.split('/').pop() || 'converted_video.mp4';
        var file = new File([blob], videoName, { type: 'video/mp4' });

        // Switch to Repliz tab → Create Post
        switchTab('repliz');
        var actionData = getConvertCurrentActionData();
        setTimeout(function () {
            var createBtn = document.querySelectorAll('.rz-subtab')[2];
            if (createBtn) replizSwitchSection('create', createBtn);

            // Auto-select Video type
            var typeOpts = document.querySelectorAll('.rz-type-option');
            typeOpts.forEach(function (el) {
                if (el.dataset.type === 'video') replizSelectType(el);
            });

            // Auto-fill title and caption
            if (actionData.title) document.getElementById('replizPostTitle').value = actionData.title;
            if (actionData.caption) document.getElementById('replizPostDesc').value = actionData.caption;

            // Upload the video file
            rzUploadFile(file);
        }, 200);
    } catch (e) {
        alert('Failed to send to Repliz: ' + e.message);
    }
}

function confirmSmartCropModal() { confirmConvertModal(); }

// === EDIT IN CROPPER (from YouTube Cutter) ===
async function editInCropper(clipIndex, ratio, smartCrop) {
    if (!allResults || !allResults[clipIndex]) return;
    var clip = allResults[clipIndex];
    var filename = clip.filename;
    ratio = ratio || '9:16'; // default ratio
    smartCrop = !!smartCrop;
    var detectMode = document.getElementById('convertDetectMode').value || document.getElementById('cropperDetectMode').value || 'balanced';
    // Show loading
    var loadingOverlay = document.createElement('div');
    loadingOverlay.id = 'editLoadingOverlay';
    loadingOverlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.8);z-index:9999;display:flex;align-items:center;justify-content:center;color:#fff;font-size:1.2rem;flex-direction:column;gap:1rem';
    loadingOverlay.innerHTML = '<div class="logo-icon" style="animation:pulse 1s infinite"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg></div><p>⏳ Loading clip into Video Cropper...</p>';
    document.body.appendChild(loadingOverlay);
    try {
        var r = await fetch('/api/cropper/load-clip', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: filename, autoDetect: smartCrop, detectMode: detectMode, jobId: currentJobId, clipStartTime: clip.start_time, clipEndTime: getClipEffectiveEndTime(clip), endExtendSeconds: getClipEndExtendSeconds(clip) }) });
        var data = await r.json();
        if (data.error) throw new Error(data.error);
        // Compute proper crop box for the target ratio (fallback)
        var ratioCrop = computeRatioCrop(data.width, data.height, ratio);
        // Initialize configs: use auto_configs from face detection if available
        var configs = {};
        if (smartCrop && data.auto_configs) {
            // Smart Crop enabled: use InsightFace auto-detected configs per frame
            for (var i = 0; i < data.frames.length; i++) {
                if (data.auto_configs[i]) {
                    configs[i] = data.auto_configs[i];
                    configs[i].frame_url = data.frames[i];
                } else {
                    configs[i] = { mode: 'single', crop1: { x: ratioCrop.x, y: ratioCrop.y, w: ratioCrop.w, h: ratioCrop.h }, frame_url: data.frames[i] };
                }
            }
        } else {
            // No Smart Crop: use static ratio-sized crop for all frames
            for (var i = 0; i < data.frames.length; i++) {
                configs[i] = { mode: 'single', crop1: { x: ratioCrop.x, y: ratioCrop.y, w: ratioCrop.w, h: ratioCrop.h }, frame_url: data.frames[i] };
            }
        }
        cropperData = { file_id: data.file_id, filename: data.filename, width: data.width, height: data.height, duration: data.duration, frames: data.frames, fps: data.fps, configs: configs, captions: [], clipTitle: clip.hook_title || '', clipCaption: clip.caption || '' };

        // Auto-save to cropper history (so reload skips frame extraction)
        fetch('/api/cropper/history-save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file_id: data.file_id, filename: data.filename, duration: data.duration, thumbnail: data.frames[0] || '' })
        }).catch(function () { });

        cropperCurrentFrame = 0;
        document.getElementById('cropperVideoInfo').textContent = data.filename + ' — ' + data.width + '×' + data.height + ' — ' + Math.round(data.duration) + 's';
        document.getElementById('applyTo').value = data.frames.length - 1;
        document.getElementById('applyTo').max = data.frames.length - 1;
        document.getElementById('applyFrom').max = data.frames.length - 1;
        // Show caption section + sync ElevenLabs key
        document.getElementById('captionSection').classList.remove('hidden');
        var savedKey = localStorage.getItem('elevenlabs_key');
        var editorKey = document.getElementById('elevenLabsKey');
        if (savedKey && editorKey) editorKey.value = savedKey;
        // Switch to cropper tab and show editor
        document.getElementById('cropperLanding').classList.add('hidden');
        document.getElementById('cropperEditor').classList.remove('hidden');
        document.getElementById('cropperResult').classList.add('hidden');
        switchTab('cropper');
        cropperRenderFrame();

    } catch (e) {
        alert('Error loading clip: ' + e.message);
    } finally {
        var ov = document.getElementById('editLoadingOverlay');
        if (ov) ov.remove();
    }
}

// ============================================
//  TAB 2: VIDEO CROPPER
// ============================================
let cropperData = null; // {file_id, filename, width, height, duration, frames, fps, configs, captions}
let cropperCurrentFrame = 0;

// Auto-caption toggle shows/hides AI settings
document.getElementById('cropperAutoCaption').addEventListener('change', function () { document.getElementById('cropperAiSettings').classList.toggle('hidden', !this.checked); });

// Sync ElevenLabs key between landing and editor via localStorage
var elKeyLanding = document.getElementById('cropperElevenLabsKey');
var elKeyEditor = document.getElementById('elevenLabsKey');
if (elKeyLanding) elKeyLanding.addEventListener('change', function () { localStorage.setItem('elevenlabs_key', this.value); if (elKeyEditor) elKeyEditor.value = this.value; });
if (elKeyEditor) elKeyEditor.addEventListener('change', function () { localStorage.setItem('elevenlabs_key', this.value); if (elKeyLanding) elKeyLanding.value = this.value; });
var savedElKey = localStorage.getItem('elevenlabs_key');
if (savedElKey) { if (elKeyLanding) elKeyLanding.value = savedElKey; if (elKeyEditor) elKeyEditor.value = savedElKey; }

// File input handler
document.getElementById('cropperFileInput').addEventListener('change', async function (e) {
    const file = e.target.files[0]; if (!file) return;
    await cropperUpload(file);
});

// Drag & drop
const dropZone = document.getElementById('cropperDropZone');
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', async (e) => { e.preventDefault(); dropZone.classList.remove('dragover'); const file = e.dataTransfer.files[0]; if (file) await cropperUpload(file); });

async function cropperUpload(file) {
    const autoDetect = document.getElementById('cropperAutoDetect').checked;
    const detectMode = document.getElementById('cropperDetectMode').value || 'balanced';
    const fd = new FormData();
    fd.append('file', file);
    fd.append('auto_detect', autoDetect ? 'true' : 'false');
    fd.append('detect_mode', detectMode);

    // Show full-screen loading overlay
    var loadingOverlay = document.createElement('div');
    loadingOverlay.id = 'cropperLoadingOverlay';
    loadingOverlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:9999;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:20px;color:#fff';
    loadingOverlay.innerHTML = '<div style="width:48px;height:48px;border:4px solid rgba(255,255,255,0.15);border-top:4px solid var(--accent-blue);border-radius:50%;animation:spin 0.8s linear infinite"></div>' +
        '<p style="font-size:1.1rem;font-weight:700">📦 Mengimpor video...</p>' +
        '<p id="cropperLoadingStatus" style="font-size:0.85rem;color:rgba(255,255,255,0.5)">Mengekstrak frame, mohon tunggu</p>' +
        '<style>@keyframes spin{to{transform:rotate(360deg)}}</style>';
    document.body.appendChild(loadingOverlay);

    try {
        // Update status
        var statusEl = document.getElementById('cropperLoadingStatus');
        if (statusEl) statusEl.textContent = 'Mengunggah video ke server...';

        const r = await fetch('/api/cropper/upload', { method: 'POST', body: fd });

        if (statusEl) statusEl.textContent = 'Mengekstrak frame & mendeteksi wajah (' + detectMode + ')...';

        const data = await r.json();
        if (data.error) throw new Error(data.error);

        if (statusEl) statusEl.textContent = 'Menyiapkan editor...';

        // Initialize cropper state
        const configs = {};
        for (let i = 0; i < data.frames.length; i++) {
            if (data.auto_configs && data.auto_configs[i]) { configs[i] = { ...data.auto_configs[i], frame_url: data.frames[i] }; }
            else { configs[i] = { mode: 'free', crop1: { x: 0, y: 0, w: 1, h: 1 }, frame_url: data.frames[i] }; }
        }

        cropperData = { file_id: data.file_id, filename: data.filename, width: data.width, height: data.height, duration: data.duration, frames: data.frames, fps: data.fps, configs, captions: [] };

        // Auto-save to cropper history on upload
        fetch('/api/cropper/history-save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file_id: data.file_id, filename: data.filename, duration: data.duration, thumbnail: data.frames[0] || '' })
        }).catch(function () { });
        cropperCurrentFrame = 0;

        document.getElementById('cropperVideoInfo').textContent = `${data.filename} — ${data.width}×${data.height} — ${Math.round(data.duration)}s — ${Math.round(data.fps)}fps`;
        document.getElementById('applyTo').value = data.frames.length - 1;
        document.getElementById('applyTo').max = data.frames.length - 1;
        document.getElementById('applyFrom').max = data.frames.length - 1;

        // Show caption section if auto-caption enabled, sync ElevenLabs key
        if (document.getElementById('cropperAutoCaption').checked) {
            document.getElementById('captionSection').classList.remove('hidden');
            var landingKey = document.getElementById('cropperElevenLabsKey');
            var editorKey = document.getElementById('elevenLabsKey');
            if (landingKey && editorKey && landingKey.value) editorKey.value = landingKey.value;
        }

        document.getElementById('cropperLanding').classList.add('hidden');
        document.getElementById('cropperEditor').classList.remove('hidden');
        cropperRenderFrame();
    } catch (e) {
        alert('Upload error: ' + e.message);
    } finally {
        var ov = document.getElementById('cropperLoadingOverlay');
        if (ov) ov.remove();
    }
}

function cropperRenderFrame() {
    if (!cropperData) return;
    const cfg = cropperData.configs[cropperCurrentFrame];
    document.getElementById('cropperFrameImg').src = cropperData.frames[cropperCurrentFrame];
    document.getElementById('cropperFrameLabel').textContent = `${cropperCurrentFrame + 1} / ${cropperData.frames.length}`;

    // Update mode buttons (new class: mode-opt-btn)
    document.querySelectorAll('.mode-opt-btn').forEach(b => {
        const m = b.dataset.mode;
        b.classList.remove('active', 'blue', 'cyan', 'purple');
        if (m === cfg.mode) {
            b.classList.add('active');
            if (m === 'single') b.classList.add('blue');
            else if (m === 'split') b.classList.add('cyan');
            else b.classList.add('purple');
        }
    });

    // Update filmstrip
    renderFilmstrip();

    // Render crop overlay
    renderCropOverlay();
}

// Multi-frame selection state
let cropperSelectedFrames = new Set(); // selected frame indices
let cropperAnchorFrame = 0; // for Shift+click range

function renderFilmstrip() {
    const strip = document.getElementById('cropperFilmstrip');
    if (!strip || !cropperData) return;
    strip.innerHTML = cropperData.frames.map((url, i) => {
        const isActive = i === cropperCurrentFrame;
        const isSelected = cropperSelectedFrames.has(i);
        let cls = 'filmstrip-frame';
        if (isActive) cls += ' active';
        if (isSelected) cls += ' fs-selected';
        const cfg = cropperData.configs[i];
        let dotColor = '', dotTitle = '';
        if (cfg && cfg.mode === 'single') { dotColor = 'var(--accent-blue)'; dotTitle = 'Single'; }
        else if (cfg && cfg.mode === 'split') { dotColor = 'var(--accent-cyan)'; dotTitle = 'Split'; }
        else if (cfg && cfg.mode === 'free') { dotColor = 'var(--accent-purple)'; dotTitle = 'Free'; }
        const dotHtml = dotColor ? '<span class="frame-mode-dot" style="background:' + dotColor + '" title="' + dotTitle + '"></span>' : '';
        const selBadge = isSelected ? '<span class="fs-sel-badge">✓</span>' : '';
        return '<div class="' + cls + '" data-idx="' + i + '"><img src="' + url + '" alt=""><span class="frame-num">' + (i + 1) + '</span>' + dotHtml + selBadge + '</div>';
    }).join('');

    // Attach click handlers (supports Shift + Ctrl)
    strip.querySelectorAll('.filmstrip-frame').forEach(el => {
        el.addEventListener('click', function (e) {
            const i = parseInt(this.dataset.idx);
            if (e.shiftKey) {
                // Range select from anchor to i
                const lo = Math.min(cropperAnchorFrame, i), hi = Math.max(cropperAnchorFrame, i);
                for (let f = lo; f <= hi; f++) cropperSelectedFrames.add(f);
            } else if (e.ctrlKey || e.metaKey) {
                // Toggle single
                if (cropperSelectedFrames.has(i)) cropperSelectedFrames.delete(i);
                else { cropperSelectedFrames.add(i); cropperAnchorFrame = i; }
            } else {
                // Normal click — navigate, clear selection
                cropperSelectedFrames.clear();
                cropperAnchorFrame = i;
                cropperCurrentFrame = i;
                cropperRenderFrame();
                return;
            }
            cropperCurrentFrame = i;
            cropperRenderFrame();
        });
    });

    // Scroll active into view
    const activeEl = strip.querySelector('.filmstrip-frame.active');
    if (activeEl) activeEl.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });

    // Update selection toolbar
    updateSelectionToolbar();
}

function updateSelectionToolbar() {
    let tb = document.getElementById('fsSelToolbar');
    const count = cropperSelectedFrames.size;
    if (count === 0) { if (tb) tb.style.display = 'none'; return; }
    if (!tb) {
        tb = document.createElement('div');
        tb.id = 'fsSelToolbar';
        tb.style.cssText = 'position:sticky;bottom:0;background:rgba(20,24,40,0.97);border-top:1px solid rgba(255,255,255,0.1);padding:8px 12px;display:flex;align-items:center;gap:10px;z-index:10;flex-wrap:wrap;';
        document.getElementById('cropperFilmstrip').parentElement.appendChild(tb);
    }
    tb.style.display = 'flex';
    tb.innerHTML = '<span style="color:rgba(255,255,255,0.7);font-size:0.8rem;flex:none;">✅ <b>' + count + '</b> frame dipilih</span>' +
        '<button onclick="applyModeToSelected(\'single\')" style="background:#4f8ef7;border:none;color:#fff;padding:4px 10px;border-radius:6px;cursor:pointer;font-size:0.78rem;">Single</button>' +
        '<button onclick="applyModeToSelected(\'split\')" style="background:#19d4e3;border:none;color:#000;padding:4px 10px;border-radius:6px;cursor:pointer;font-size:0.78rem;">Split</button>' +
        '<button onclick="applyModeToSelected(\'free\')" style="background:#a855f7;border:none;color:#fff;padding:4px 10px;border-radius:6px;cursor:pointer;font-size:0.78rem;">Free</button>' +
        '<button onclick="cropperClearSelection()" style="background:rgba(255,255,255,0.08);border:none;color:rgba(255,255,255,0.6);padding:4px 10px;border-radius:6px;cursor:pointer;font-size:0.78rem;margin-left:auto;">✕ Clear</button>';
}

function applyModeToSelected(mode) {
    if (!cropperData || cropperSelectedFrames.size === 0) return;
    cropperSelectedFrames.forEach(idx => {
        const cfg = cropperData.configs[idx];
        cfg.mode = mode;
        if (mode === 'single') {
            var ratio916 = computeRatioCrop(cropperData.width, cropperData.height, '9:16');
            cfg.crop1 = { x: ratio916.x, y: ratio916.y, w: ratio916.w, h: ratio916.h };
            delete cfg.crop2;
        } else if (mode === 'split') {
            var splitAR = 9 / 8;
            var vAR = cropperData.width / cropperData.height;
            var sw, sh;
            if (vAR > splitAR) { sh = 1.0; sw = splitAR / vAR; }
            else { sw = 1.0; sh = vAR / splitAR; }
            cfg.crop1 = { x: Math.max(0, 0.5 - sw * 0.7), y: (1 - sh) / 2, w: sw, h: sh };
            cfg.crop2 = { x: Math.min(1 - sw, 0.5 - sw * 0.3), y: (1 - sh) / 2, w: sw, h: sh };
        } else if (mode === 'free') {
            cfg.crop1 = { x: 0, y: 0, w: 1, h: 1 };
            delete cfg.crop2;
        }
    });
    cropperClearSelection();
    cropperRenderFrame();
}

function cropperClearSelection() {
    cropperSelectedFrames.clear();
    const tb = document.getElementById('fsSelToolbar');
    if (tb) tb.style.display = 'none';
    renderFilmstrip();
}


// Helper: compute a 9:16 crop box (normalized) centered on the frame
function compute916CropBox(videoW, videoH, centerX, centerY) {
    // Target 9:16 aspect in video-pixel space
    var targetAR = 9 / 16;
    var videoAR = videoW / videoH;
    var cropW, cropH;
    if (videoAR > targetAR) {
        // Wide video: height fills, width is fraction
        cropH = 1.0;
        cropW = (targetAR / videoAR);
    } else {
        // Tall video: width fills, height is fraction
        cropW = 1.0;
        cropH = (videoAR / targetAR);
    }
    // Center the box
    var cx = (typeof centerX === 'number') ? centerX : 0.5;
    var cy = (typeof centerY === 'number') ? centerY : 0.5;
    var x = Math.max(0, Math.min(1 - cropW, cx - cropW / 2));
    var y = Math.max(0, Math.min(1 - cropH, cy - cropH / 2));
    return { x: x, y: y, w: cropW, h: cropH };
}
function renderCropOverlay() {
    const overlay = document.getElementById('cropperOverlay');
    overlay.innerHTML = '';
    if (!cropperData) return;
    const cfg = cropperData.configs[cropperCurrentFrame];
    if (cfg.mode === 'free') {
        // Show full purple overlay for free mode (shows entire frame)
        const box1 = createCropBox({ x: 0, y: 0, w: 1, h: 1 }, 'Free Crop', 'purple');
        overlay.appendChild(box1);
    } else if (cfg.mode === 'single') {
        const box1 = createCropBox(cfg.crop1, 'Crop 1', 'blue');
        overlay.appendChild(box1);
    } else if (cfg.mode === 'split') {
        const box1 = createCropBox(cfg.crop1, 'Crop 1', 'blue');
        overlay.appendChild(box1);
        if (cfg.crop2) {
            const box2 = createCropBox(cfg.crop2, 'Crop 2', 'cyan');
            overlay.appendChild(box2);
        }
    }
}

function createCropBox(box, label, variant) {
    const el = document.createElement('div');
    el.className = 'crop-box' + (variant === 'cyan' ? ' variant-cyan' : variant === 'purple' ? ' variant-purple' : '');
    el.style.left = (box.x * 100) + '%';
    el.style.top = (box.y * 100) + '%';
    el.style.width = (box.w * 100) + '%';
    el.style.height = (box.h * 100) + '%';
    el.innerHTML = `<span class="crop-box-label">${label}</span>`;

    // Drag functionality (mouse + touch)
    let startX, startY, origX, origY;
    el.style.touchAction = 'none'; // prevent scroll while dragging

    function onDragStart(clientX, clientY) {
        startX = clientX; startY = clientY;
        origX = box.x; origY = box.y;
    }

    function onDragMove(clientX, clientY) {
        const viewer = document.getElementById('cropperOverlay').parentElement;
        const rect = viewer.getBoundingClientRect();
        const dx = (clientX - startX) / rect.width;
        const dy = (clientY - startY) / rect.height;
        box.x = Math.max(0, Math.min(1 - box.w, origX + dx));
        box.y = Math.max(0, Math.min(1 - box.h, origY + dy));
        el.style.left = (box.x * 100) + '%';
        el.style.top = (box.y * 100) + '%';
    }

    // Mouse events
    el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        onDragStart(e.clientX, e.clientY);
        const onMove = (ev) => onDragMove(ev.clientX, ev.clientY);
        const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });

    // Touch events
    el.addEventListener('touchstart', (e) => {
        e.preventDefault();
        var t = e.touches[0];
        onDragStart(t.clientX, t.clientY);
        const onMove = (ev) => { ev.preventDefault(); var tt = ev.touches[0]; onDragMove(tt.clientX, tt.clientY); };
        const onUp = () => { document.removeEventListener('touchmove', onMove); document.removeEventListener('touchend', onUp); };
        document.addEventListener('touchmove', onMove, { passive: false });
        document.addEventListener('touchend', onUp);
    }, { passive: false });
    return el;
}

// ============================================
// CROPPER HISTORY
// ============================================
function openCropperHistory() {
    document.getElementById('cropperHistoryPanel').style.display = 'block';
    document.getElementById('cropperHistoryOverlay').style.display = 'block';
    loadCropperHistory();
}
function closeCropperHistory() {
    document.getElementById('cropperHistoryPanel').style.display = 'none';
    document.getElementById('cropperHistoryOverlay').style.display = 'none';
}

async function loadCropperHistory() {
    const list = document.getElementById('cropperHistoryList');
    list.innerHTML = '<div style="text-align:center;padding:30px;color:rgba(255,255,255,0.5);">⏳ Memuat...</div>';
    try {
        const r = await fetch('/api/cropper/history');
        const d = await r.json();
        if (!d.success || !d.entries || d.entries.length === 0) {
            list.innerHTML = '<div style="text-align:center;padding:40px 20px;color:rgba(255,255,255,0.4);"><div style="font-size:2.5rem;margin-bottom:10px;">🎬</div><p style="margin:0;">Belum ada history</p></div>';
            return;
        }
        function fmtDur(s) { return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0'); }
        list.innerHTML = d.entries.map(e => {
            const dt = new Date(e.date).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
            const thumb = e.thumbnail
                ? `<img src="${e.thumbnail}" style="width:100%;height:80px;object-fit:cover;border-radius:6px 6px 0 0;display:block;" onerror="this.style.display='none'">`
                : `<div style="height:5px;background:linear-gradient(90deg,#19d4e3,#a855f7);border-radius:6px 6px 0 0;"></div>`;
            return `<div style="background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);border-radius:10px;overflow:hidden;">
                ${thumb}
                <div style="padding:12px;">
                    <div style="font-size:0.88rem;font-weight:600;color:#fff;margin-bottom:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${e.filename}">${e.filename || e.id}</div>
                    <div style="font-size:0.75rem;color:rgba(255,255,255,0.45);margin-bottom:10px;">⏱ ${fmtDur(e.duration || 0)} &nbsp;·&nbsp; 📅 ${dt}</div>
                    <div style="display:flex;gap:8px;">
                        <button onclick="loadCropperHistoryEntry('${e.id}')" style="flex:1;background:linear-gradient(90deg,#19d4e3,#a855f7);border:none;color:#fff;padding:7px;border-radius:7px;cursor:pointer;font-size:0.82rem;font-weight:600;">📂 Buka</button>
                        ${e.video_url ? `<a href="${e.video_url}" download style="background:rgba(25,212,227,0.15);border:1px solid rgba(25,212,227,0.3);color:#19d4e3;padding:7px 11px;border-radius:7px;cursor:pointer;font-size:0.82rem;text-decoration:none;">⬇</a>` : ''}
                        <button onclick="deleteCropperHistoryEntry('${e.id}',this)" style="background:rgba(255,80,80,0.15);border:1px solid rgba(255,80,80,0.3);color:#ff6b6b;padding:7px 11px;border-radius:7px;cursor:pointer;font-size:0.82rem;">🗑</button>
                    </div>
                </div>
            </div>`;
        }).join('');
    } catch (e) {
        list.innerHTML = '<div style="text-align:center;padding:30px;color:rgba(255,100,100,0.7);">❌ Gagal memuat history</div>';
    }
}

async function loadCropperHistoryEntry(id) {
    try {
        const r = await fetch(`/api/cropper/history/${id}`);
        const d = await r.json();
        if (!d.success) { alert('Gagal memuat data'); return; }
        closeCropperHistory();
        // Reload frames from server
        const fr = await fetch('/api/cropper/reload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file_id: d.id }) });
        const fd = await fr.json();
        if (!fd.success) {
            alert('File asli tidak ditemukan. Silakan upload ulang video yang sama.');
            return;
        }
        // Restore configs from history or create defaults
        const savedConfig = d.config || {};
        const configs = {};
        for (let i = 0; i < fd.frames.length; i++) {
            if (savedConfig[i]) { configs[i] = { ...savedConfig[i], frame_url: fd.frames[i] }; }
            else { configs[i] = { mode: 'free', crop1: { x: 0, y: 0, w: 1, h: 1 }, frame_url: fd.frames[i] }; }
        }
        cropperData = { file_id: d.id, filename: d.filename || fd.filename, width: fd.width, height: fd.height, duration: fd.duration, frames: fd.frames, fps: fd.fps, configs: configs, captions: [] };
        cropperCurrentFrame = 0;
        // Set up editor UI
        document.getElementById('cropperVideoInfo').textContent = `${cropperData.filename} — ${fd.width}×${fd.height} — ${Math.round(fd.duration)}s — ${Math.round(fd.fps)}fps`;
        document.getElementById('applyTo').value = fd.frames.length - 1;
        document.getElementById('applyTo').max = fd.frames.length - 1;
        document.getElementById('applyFrom').max = fd.frames.length - 1;
        // Show caption section + restore ElevenLabs key
        document.getElementById('captionSection').classList.remove('hidden');
        var savedKey = localStorage.getItem('elevenlabs_key');
        var editorKey = document.getElementById('elevenLabsKey');
        if (savedKey && editorKey) editorKey.value = savedKey;
        // Show editor, hide landing
        document.getElementById('cropperLanding').classList.add('hidden');
        document.getElementById('cropperEditor').classList.remove('hidden');
        cropperRenderFrame();
    } catch (e) { alert('Error: ' + e.message); }
}

async function deleteCropperHistoryEntry(id, btn) {
    if (!confirm('Hapus history ini?')) return;
    btn.textContent = '⏳';
    try {
        await fetch(`/api/cropper/history/${id}`, { method: 'DELETE' });
        loadCropperHistory();
    } catch (e) { btn.textContent = '🗑'; alert('Gagal menghapus'); }
}

function cropperPrevFrame() { if (cropperCurrentFrame > 0) { cropperCurrentFrame--; cropperRenderFrame(); } }
function cropperNextFrame() { if (cropperData && cropperCurrentFrame < cropperData.frames.length - 1) { cropperCurrentFrame++; cropperRenderFrame(); } }

function setCropMode(mode) {
    if (!cropperData) return;
    const cfg = cropperData.configs[cropperCurrentFrame];
    cfg.mode = mode;
    if (mode === 'single') {
        var ratio916 = computeRatioCrop(cropperData.width, cropperData.height, '9:16');
        cfg.crop1 = { x: ratio916.x, y: ratio916.y, w: ratio916.w, h: ratio916.h };
    } else if (mode === 'split') {
        var splitAR = 9 / 8;
        var vAR = cropperData.width / cropperData.height;
        var sw, sh;
        if (vAR > splitAR) { sh = 1.0; sw = splitAR / vAR; }
        else { sw = 1.0; sh = vAR / splitAR; }
        cfg.crop1 = { x: Math.max(0, 0.5 - sw * 0.7), y: (1 - sh) / 2, w: sw, h: sh };
        cfg.crop2 = { x: Math.min(1 - sw, 0.5 - sw * 0.3), y: (1 - sh) / 2, w: sw, h: sh };
    } else if (mode === 'free') {
        cfg.crop1 = { x: 0, y: 0, w: 1, h: 1 };
        delete cfg.crop2;
    }
    cropperRenderFrame();
}

function cropperApplyRange() {
    if (!cropperData) return;
    const from = parseInt(document.getElementById('applyFrom').value) - 1;
    const to = parseInt(document.getElementById('applyTo').value) - 1;
    const src = cropperData.configs[cropperCurrentFrame];
    for (let i = from; i <= to && i < cropperData.frames.length; i++) {
        if (i < 0) continue;
        if (i === cropperCurrentFrame) continue;
        cropperData.configs[i] = { ...JSON.parse(JSON.stringify(src)), frame_url: cropperData.frames[i] };
    }
}

// Transcription
async function cropperTranscribe() {
    if (!cropperData) return;
    const apiKey = document.getElementById('elevenLabsKey').value.trim();
    if (!apiKey) { alert('Masukkan ElevenLabs API Key'); return; }
    const btn = document.getElementById('btnTranscribe');
    btn.disabled = true; btn.textContent = '⏳ Transcribing...';
    try {
        const r = await fetch('/api/cropper/transcribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file_id: cropperData.file_id, elevenlabs_key: apiKey }) });
        const d = await r.json();
        if (!d.success) throw new Error(d.error || 'Transcription failed');
        cropperData.captions = d.captions || [];
        renderCaptions();
    } catch (e) {
        alert('Transcribe error: ' + e.message);
    } finally {
        btn.disabled = false; btn.textContent = '🎙 Transcribe (ElevenLabs)';
    }
}

function renderCaptions() {
    const list = document.getElementById('captionList');
    if (!cropperData || cropperData.captions.length === 0) { list.innerHTML = '<p style="color:var(--text-muted);font-size:0.8rem">No captions yet</p>'; return; }
    list.innerHTML = cropperData.captions.map((c, i) => `
    <div class="caption-item">
      <span class="caption-time">${c.start.toFixed(1)}s → ${c.end.toFixed(1)}s</span>
      <div class="caption-text"><input type="text" value="${c.text.replace(/"/g, '&quot;')}" onchange="updateCaption(${i}, this.value)"></div>
      <span class="caption-delete" onclick="deleteCaption(${i})">🗑</span>
    </div>
  `).join('');
}

function updateCaption(i, text) { if (cropperData) { cropperData.captions[i].text = text; cropperData.captions[i].words = []; } }
function deleteCaption(i) { if (cropperData) { cropperData.captions.splice(i, 1); renderCaptions(); } }

// === WATERMARK ===
var watermarkData = null; // base64 image data

function toggleWatermarkPanel() {
    var panel = document.getElementById('watermarkPanel');
    var enabled = document.getElementById('watermarkEnabled').checked;
    if (enabled) panel.classList.remove('hidden');
    else panel.classList.add('hidden');
}

function loadWatermark(e) {
    var file = e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function (ev) {
        watermarkData = ev.target.result;
        document.getElementById('watermarkPreviewWrap').classList.remove('hidden');
        document.getElementById('watermarkPreviewLogo').src = watermarkData;
        updateWatermarkPreview();
        // Draw current video frame as background
        if (cropperData && cropperData.frames && cropperData.frames.length > 0) {
            var canvas = document.getElementById('watermarkPreviewCanvas');
            var ctx = canvas.getContext('2d');
            canvas.width = 140;
            canvas.height = 248;
            var img = new Image();
            img.onload = function () {
                // Cover-fill: crop to fit 9:16 aspect
                var srcAspect = img.width / img.height;
                var dstAspect = 140 / 248;
                var sx = 0, sy = 0, sw = img.width, sh = img.height;
                if (srcAspect > dstAspect) {
                    sw = img.height * dstAspect;
                    sx = (img.width - sw) / 2;
                } else {
                    sh = img.width / dstAspect;
                    sy = (img.height - sh) / 2;
                }
                ctx.drawImage(img, sx, sy, sw, sh, 0, 0, 140, 248);
            };
            img.src = cropperData.frames[cropperCurrentFrame || 0];
        }
    };
    reader.readAsDataURL(file);
}

function updateWatermarkPreview() {
    var size = parseInt(document.getElementById('watermarkSize').value);
    var opacity = parseInt(document.getElementById('watermarkOpacity').value);
    document.getElementById('watermarkSizeVal').textContent = size + '%';
    document.getElementById('watermarkOpacityVal').textContent = opacity + '%';
    var logo = document.getElementById('watermarkPreviewLogo');
    if (logo.src) {
        logo.style.width = size + '%';
        logo.style.height = 'auto';
        logo.style.opacity = (opacity / 100).toFixed(2);
    }
}

// Reset cropper and go back to landing to crop a new video
function cropperNewVideo() {
    cropperData = null;
    cropperCurrentFrame = 0;
    watermarkData = null;
    document.getElementById('cropperEditor').classList.add('hidden');
    document.getElementById('cropperLanding').classList.remove('hidden');
    document.getElementById('cropperResult').classList.add('hidden');
    document.getElementById('captionSection').classList.add('hidden');
    document.getElementById('cropperOverlay').innerHTML = '';
    document.getElementById('captionList').innerHTML = '';
    var pw = document.getElementById('cropperPreviewWrap');
    if (pw) pw.style.display = 'none';
    var pv = document.getElementById('cropperPreviewVideo');
    if (pv) { pv.pause(); pv.src = ''; }
    // Reset watermark
    document.getElementById('watermarkEnabled').checked = false;
    document.getElementById('watermarkPanel').classList.add('hidden');
    document.getElementById('watermarkPreviewWrap').classList.add('hidden');
    document.getElementById('watermarkPreviewLogo').src = '';
    document.getElementById('watermarkSize').value = 20;
    document.getElementById('watermarkOpacity').value = 80;
}

// Export
async function cropperExport() {
    if (!cropperData) return;
    const btn = document.getElementById('btnExport');
    btn.disabled = true; btn.textContent = '⏳ Processing...';
    try {
        const configPayload = {};
        for (const [k, v] of Object.entries(cropperData.configs)) {
            configPayload[k] = { mode: v.mode, crop1: v.crop1 };
            if (v.crop2) configPayload[k].crop2 = v.crop2;
        }
        const captionsEnabled = document.getElementById('captionEnabled') && document.getElementById('captionEnabled').checked;
        const captionsToSend = captionsEnabled ? cropperData.captions : [];

        // Watermark data
        var wmEnabled = document.getElementById('watermarkEnabled') && document.getElementById('watermarkEnabled').checked;
        var watermark = null;
        if (wmEnabled && watermarkData) {
            watermark = {
                data: watermarkData,
                size: parseInt(document.getElementById('watermarkSize').value),
                opacity: parseInt(document.getElementById('watermarkOpacity').value)
            };
        }

        const r = await fetch('/api/cropper/process', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file_id: cropperData.file_id, config: configPayload, captions: captionsToSend, watermark: watermark }) });
        const d = await r.json();
        if (!d.success) throw new Error(d.error || 'Processing failed');
        document.getElementById('cropperResult').classList.remove('hidden');
        const link = document.getElementById('cropperDownloadLink');
        link.href = d.video_url; link.textContent = '⬇ Download: ' + d.video_url.split('/').pop();
        // Show video preview
        var previewWrap = document.getElementById('cropperPreviewWrap');
        var previewVideo = document.getElementById('cropperPreviewVideo');
        if (previewWrap && previewVideo) {
            previewVideo.src = d.video_url;
            previewWrap.style.display = 'block';
            previewVideo.load();
        }
    } catch (e) {
        alert('Export error: ' + e.message);
    } finally {
        btn.disabled = false; btn.textContent = '🎬 Export Video';
    }
}

// === CROPPER → REPLIZ: Send video to Create Post ===
async function cropperSendToRepliz() {
    // Check credentials
    var auth = replizGetAuth();
    if (!auth) {
        alert('Set Repliz API keys di tab Repliz terlebih dahulu!');
        switchTab('repliz');
        return;
    }

    // Fetch the processed video blob from local server
    var videoUrl = document.getElementById('cropperDownloadLink').href;
    var fileName = videoUrl.split('/').pop() || 'cropped_video.mp4';

    try {
        var resp = await fetch(videoUrl);
        var blob = await resp.blob();
        var file = new File([blob], fileName, { type: 'video/mp4' });

        // Get title/caption from cropperData
        var clipTitle = (cropperData && cropperData.clipTitle) || '';
        var clipCaption = (cropperData && cropperData.clipCaption) || '';

        // Switch to Repliz tab → Create Post
        switchTab('repliz');
        setTimeout(function () {
            // Open Create Post sub-tab
            var createBtn = document.querySelectorAll('.rz-subtab')[2];
            if (createBtn) replizSwitchSection('create', createBtn);

            // Auto-select Video type
            var videoChip = document.querySelector('.rz-type-chip[data-type="video"]');
            if (videoChip) replizSelectType(videoChip);

            // Auto-fill title and caption
            if (clipTitle) document.getElementById('replizPostTitle').value = clipTitle;
            if (clipCaption) document.getElementById('replizPostDesc').value = clipCaption;

            // Trigger upload
            rzUploadFile(file);
        }, 200);
    } catch (e) {
        alert('Failed to prepare video: ' + e.message);
    }
}

// ============================================
//  TAB 3: ZERNIO
// ============================================
var _zernioAccounts = [];
var _zernioSelectedAction = 'draft';
var _zernioSelectedAccountIds = [];

function zernioGetApiKey() {
    return (localStorage.getItem('zernio_api_key') || '').trim();
}

function zernioSetStatus(message, type, targetId) {
    var el = document.getElementById(targetId || 'zernioSubmitStatus');
    if (!el) return;
    var color = 'var(--text-muted)';
    if (type === 'success') color = 'var(--accent-green)';
    if (type === 'error') color = '#ef4444';
    if (type === 'warn') color = '#f59e0b';
    el.innerHTML = '<span style="color:' + color + '">' + message + '</span>';
}

async function zernioFetch(path, opts) {
    var apiKey = zernioGetApiKey();
    if (!apiKey) throw new Error('Zernio API key wajib diisi');
    var options = Object.assign({}, opts || {});
    options.headers = Object.assign({}, options.headers || {}, { 'x-zernio-api-key': apiKey });
    var resp = await fetch(path, options);
    var data = await resp.json().catch(function () { return {}; });
    if (!resp.ok) throw new Error(data.error || ('HTTP ' + resp.status));
    return data;
}

function zernioSaveCredentials() {
    var input = document.getElementById('zernioApiKey');
    var apiKey = input ? input.value.trim() : '';
    if (!apiKey) {
        alert('Masukkan Zernio API key');
        return;
    }
    localStorage.setItem('zernio_api_key', apiKey);
    zernioSetStatus('✅ API key tersimpan lokal', 'success', 'zernioConnectionStatus');
}

function zernioUpdateAccountCount() {
    var countEl = document.getElementById('zernioAccountCount');
    if (!countEl) return;
    countEl.textContent = _zernioSelectedAccountIds.length + ' account dipilih';
}

function zernioGetSelectedAccounts() {
    return _zernioAccounts.filter(function (account) {
        return _zernioSelectedAccountIds.indexOf(account.id) !== -1;
    });
}

function zernioToggleAccountSelection(accountId, checked) {
    var normalizedId = String(accountId || '').trim();
    if (!normalizedId) return;
    _zernioSelectedAccountIds = _zernioSelectedAccountIds.filter(function (id) { return id !== normalizedId; });
    if (checked) _zernioSelectedAccountIds.push(normalizedId);
    zernioUpdateAccountCount();
}

function zernioSelectAllAccounts() {
    _zernioSelectedAccountIds = _zernioAccounts.map(function (account) { return account.id; });
    zernioRenderAccounts(_zernioAccounts);
}

function zernioClearSelectedAccounts() {
    _zernioSelectedAccountIds = [];
    zernioRenderAccounts(_zernioAccounts);
}

function zernioRenderAccounts(accounts) {
    var list = document.getElementById('zernioAccountChecklist');
    if (!list) return;
    if (!accounts.length) {
        list.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:12px;text-align:center">Account tidak ditemukan</div>';
        _zernioSelectedAccountIds = [];
        zernioUpdateAccountCount();
        return;
    }

    var validIds = accounts.map(function (account) { return account.id; });
    _zernioSelectedAccountIds = _zernioSelectedAccountIds.filter(function (id) { return validIds.indexOf(id) !== -1; });

    list.innerHTML = accounts.map(function (account) {
        var checked = _zernioSelectedAccountIds.indexOf(account.id) !== -1 ? ' checked' : '';
        var label = (account.name || 'Untitled Account');
        var meta = (account.platform || 'unknown') + ' • ' + account.id;
        return '<label style="display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border:1px solid rgba(255,255,255,0.07);border-radius:10px;background:rgba(255,255,255,0.03);cursor:pointer">' +
            '<input type="checkbox" value="' + rzEsc(account.id) + '" onchange="zernioToggleAccountSelection(this.value, this.checked)" style="margin-top:2px;accent-color:var(--accent-primary)"' + checked + '>' +
            '<div style="min-width:0">' +
            '<div style="font-size:12px;font-weight:700;color:var(--text-primary)">' + rzEscText(label) + '</div>' +
            '<div style="font-size:11px;color:var(--text-muted);margin-top:2px;word-break:break-all">' + rzEscText(meta) + '</div>' +
            '</div>' +
            '</label>';
    }).join('');

    zernioUpdateAccountCount();
}

async function zernioLoadAccounts() {
    var data = await zernioFetch('/api/zernio/accounts');
    _zernioAccounts = Array.isArray(data.accounts) ? data.accounts : [];
    zernioRenderAccounts(_zernioAccounts);
    return _zernioAccounts;
}

async function zernioTestConnection(options) {
    var opts = options || {};
    var btn = document.getElementById('zernioTestBtn');
    if (btn) {
        btn.disabled = true;
        btn.textContent = '⏳ Testing...';
    }
    zernioSetStatus('Testing connection...', 'warn', 'zernioConnectionStatus');
    try {
        var accounts = await zernioLoadAccounts();
        if (opts.autoSelectAll && accounts.length) zernioSelectAllAccounts();
        zernioSetStatus('✅ Connected! Found ' + accounts.length + ' account(s)', 'success', 'zernioConnectionStatus');
        return accounts;
    } catch (e) {
        zernioSetStatus('❌ ' + e.message, 'error', 'zernioConnectionStatus');
        throw e;
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = '🔗 Test Connection';
        }
    }
}

function zernioOnActionChange() {
    var actionEl = document.getElementById('zernioAction');
    _zernioSelectedAction = actionEl ? actionEl.value : 'draft';
    var scheduleGroup = document.getElementById('zernioScheduleGroup');
    if (scheduleGroup) scheduleGroup.classList.toggle('hidden', _zernioSelectedAction !== 'schedule');
}

async function zernioCreatePost() {
    var title = (document.getElementById('zernioTitle').value || '').trim();
    var caption = (document.getElementById('zernioCaption').value || '').trim();
    var mediaUrl = (document.getElementById('zernioMediaUrl').value || '').trim();
    var scheduledAt = (document.getElementById('zernioScheduledAt').value || '').trim();
    var submitBtn = document.getElementById('zernioSubmitBtn');
    var selectedAccounts = zernioGetSelectedAccounts();
    var accountIds = selectedAccounts.map(function (item) { return item.id; });

    if (!zernioGetApiKey()) {
        alert('Simpan Zernio API key dulu');
        return;
    }
    if (!accountIds.length) {
        alert('Pilih minimal 1 account Zernio');
        return;
    }
    if (!mediaUrl) {
        alert('Media URL wajib diisi');
        return;
    }
    if (_zernioSelectedAction === 'schedule' && !scheduledAt) {
        alert('Waktu schedule wajib diisi');
        return;
    }

    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = '⏳ Submitting...';
    }
    zernioSetStatus('Upload media ke Zernio lalu kirim post ke ' + accountIds.length + ' account...', 'warn');

    try {
        var data = await zernioFetch('/api/zernio/posts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ accountIds: accountIds, title: title, caption: caption, mediaUrl: mediaUrl, action: _zernioSelectedAction, scheduledAt: scheduledAt })
        });
        var publishResult = await markTableShareRowPublishedIfNeeded();
        zernioSetStatus(buildPostSuccessWithTableStatus('✅ Post berhasil dikirim ke ' + (data.accountCount || accountIds.length) + ' account sebagai ' + data.action, publishResult), 'success');
    } catch (e) {
        zernioSetStatus('❌ ' + e.message, 'error');
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = '🚀 Submit to Zernio';
        }
    }
}

(function () {
    var apiKey = zernioGetApiKey();
    var input = document.getElementById('zernioApiKey');
    if (input && apiKey) input.value = apiKey;
    if (apiKey) zernioSetStatus('● API key tersimpan', 'success', 'zernioConnectionStatus');
    zernioOnActionChange();
})();

// ============================================
//  TAB 4: REPLIZ DASHBOARD
// ============================================
var _replizAccounts = [];
var REPLIZ_API = '/public';

function replizGetAuth() {
    var ak = localStorage.getItem('repliz_access_key') || '';
    var sk = localStorage.getItem('repliz_secret_key') || '';
    if (!ak || !sk) return '';
    return btoa(ak + ':' + sk);
}

function replizHeaders() {
    var auth = replizGetAuth();
    var h = { 'Content-Type': 'application/json' };
    if (auth) h['Authorization'] = 'Basic ' + auth;
    return h;
}

var _tableSharePublishDraft = null;

function setActiveTableShareDraft(provider, draft) {
    if (!draft || draft.source !== 'table-share' || !draft.link) {
        _tableSharePublishDraft = null;
        return;
    }
    _tableSharePublishDraft = {
        provider: provider || '',
        source: 'table-share',
        link: String(draft.link || '').trim(),
        mediaUrl: String(draft.mediaUrl || '').trim(),
        localMediaUrl: String(draft.localMediaUrl || '').trim(),
        title: String(draft.title || '').trim(),
        caption: String(draft.caption || '').trim()
    };
}

function clearActiveTableShareDraft() {
    _tableSharePublishDraft = null;
}

async function markTableShareRowPublishedIfNeeded() {
    if (!_tableSharePublishDraft || _tableSharePublishDraft.source !== 'table-share' || !_tableSharePublishDraft.link) {
        return { attempted: false, ok: false, warning: '' };
    }

    var link = _tableSharePublishDraft.link;
    clearActiveTableShareDraft();

    try {
        var resp = await fetch('/api/video-share/status', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ link: link, status: 'publish' })
        });
        var data = await resp.json().catch(function () { return {}; });
        if (!resp.ok) throw new Error(data.error || ('HTTP ' + resp.status));
        return { attempted: true, ok: true, warning: '' };
    } catch (e) {
        return { attempted: true, ok: false, warning: e.message || 'Gagal update status tabel' };
    }
}

function buildPostSuccessWithTableStatus(baseMessage, publishResult) {
    if (!publishResult || !publishResult.attempted) return baseMessage;
    if (publishResult.ok) return baseMessage + ' · status tabel → publish';
    return baseMessage + ' · warning: post sukses tapi status tabel gagal diupdate (' + publishResult.warning + ')';
}

async function consumeTableShareDraftToRepliz() {
    var raw = localStorage.getItem('repliz_table_share_draft');
    if (!raw) return;

    try {
        var draft = JSON.parse(raw || '{}');
        localStorage.removeItem('repliz_table_share_draft');
        var preferredMediaUrl = String(draft.localMediaUrl || draft.mediaUrl || '').trim();
        if (!preferredMediaUrl) return;
        draft.mediaUrl = preferredMediaUrl;

        setActiveTableShareDraft('repliz', draft);
        var auth = replizGetAuth();
        switchTab('repliz');
        setTimeout(async function () {
            try {
                var createBtn = document.querySelectorAll('.rz-subtab')[2];
                if (createBtn) replizSwitchSection('create', createBtn);

                var videoChip = document.querySelector('.rz-type-chip[data-type="video"]');
                if (videoChip) replizSelectType(videoChip);

                if (draft.title) document.getElementById('replizPostTitle').value = draft.title;
                if (draft.caption) document.getElementById('replizPostDesc').value = draft.caption;

                if (!auth) {
                    clearActiveTableShareDraft();
                    alert('Set Repliz API keys di tab Repliz terlebih dahulu!');
                    return;
                }

                var resp = await fetch(draft.mediaUrl);
                if (!resp.ok) throw new Error('Gagal ambil media source (' + resp.status + ')');
                var blob = await resp.blob();
                var videoName = (draft.mediaUrl.split('/').pop() || 'table_share_video.mp4').split('?')[0];
                var file = new File([blob], videoName, { type: blob.type || 'video/mp4' });
                rzUploadFile(file);
            } catch (e) {
                clearActiveTableShareDraft();
                alert('Gagal prepare draft Repliz: ' + e.message);
            }
        }, 250);
    } catch (e) {
        localStorage.removeItem('repliz_table_share_draft');
    }
}

function zernioGetDefaultScheduledAtValue() {
    var d = new Date(Date.now() + 10 * 60 * 1000);
    return d.getFullYear() + '-' +
        String(d.getMonth() + 1).padStart(2, '0') + '-' +
        String(d.getDate()).padStart(2, '0') + 'T' +
        String(d.getHours()).padStart(2, '0') + ':' +
        String(d.getMinutes()).padStart(2, '0');
}

async function consumeTableShareDraftToZernio() {
    var raw = localStorage.getItem('zernio_table_share_draft');
    if (!raw) return;

    try {
        var draft = JSON.parse(raw || '{}');
        localStorage.removeItem('zernio_table_share_draft');
        var preferredMediaUrl = String(draft.localMediaUrl || draft.mediaUrl || '').trim();
        if (!preferredMediaUrl) return;
        draft.mediaUrl = preferredMediaUrl;

        setActiveTableShareDraft('zernio', draft);
        switchTab('zernio');
        setTimeout(async function () {
            try {
                if (draft.title) document.getElementById('zernioTitle').value = draft.title;
                if (draft.caption) document.getElementById('zernioCaption').value = draft.caption;
                document.getElementById('zernioMediaUrl').value = draft.mediaUrl || '';

                var actionEl = document.getElementById('zernioAction');
                var scheduledAtEl = document.getElementById('zernioScheduledAt');
                if (actionEl) actionEl.value = 'schedule';
                if (scheduledAtEl && !scheduledAtEl.value) scheduledAtEl.value = zernioGetDefaultScheduledAtValue();
                zernioOnActionChange();

                if (!zernioGetApiKey()) {
                    zernioSetStatus('● Draft dari tabel siap. Simpan API key lalu klik Test Connection.', 'warn', 'zernioSubmitStatus');
                    zernioSetStatus('● API key belum ada', 'warn', 'zernioConnectionStatus');
                    return;
                }

                zernioSetStatus('● Draft dari tabel siap. Sedang test connection dan memilih account...', 'warn', 'zernioSubmitStatus');
                var accounts = await zernioTestConnection({ autoSelectAll: true });
                zernioSetStatus('✅ Draft siap. Semua account otomatis dipilih, action default = schedule.', 'success', 'zernioSubmitStatus');
            } catch (e) {
                zernioSetStatus('❌ ' + e.message, 'error', 'zernioConnectionStatus');
                zernioSetStatus('● Draft Zernio terisi, tapi auto test/select gagal. Lanjut manual.', 'warn', 'zernioSubmitStatus');
            }
        }, 200);
    } catch (e) {
        localStorage.removeItem('zernio_table_share_draft');
    }
}

async function replizFetch(path, opts) {
    var auth = replizGetAuth();
    if (!auth) throw new Error('API credentials not configured. Save your keys first.');
    var url = REPLIZ_API + path;
    var controller = new AbortController();
    var timeoutId = setTimeout(function () { controller.abort(); }, 60000); // 60s timeout
    try {
        var r = await fetch(url, Object.assign({ headers: replizHeaders(), signal: controller.signal }, opts || {}));
        clearTimeout(timeoutId);
        if (r.status === 401) throw new Error('Authentication failed — check your Access Key and Secret Key');
        if (r.status === 504) throw new Error('Repliz API timeout — server lambat atau down, coba lagi nanti');
        return r.json();
    } catch (e) {
        clearTimeout(timeoutId);
        if (e.name === 'AbortError') throw new Error('Repliz API timeout (60s) — server tidak merespons, coba lagi nanti');
        throw e;
    }
}

// Restore saved credentials to input fields
(function () {
    var ak = localStorage.getItem('repliz_access_key') || '';
    var sk = localStorage.getItem('repliz_secret_key') || '';
    var akEl = document.getElementById('replizAccessKey');
    var skEl = document.getElementById('replizSecretKey');
    if (akEl && ak) akEl.value = ak;
    if (skEl && sk) skEl.value = sk;
    if (ak && sk) {
        var status = document.getElementById('replizConnectionStatus');
        if (status) status.innerHTML = '<span style="color:var(--accent-green)">● Credentials saved</span>';
    }
})();

function replizSaveCredentials() {
    var ak = document.getElementById('replizAccessKey').value.trim();
    var sk = document.getElementById('replizSecretKey').value.trim();
    if (!ak || !sk) { alert('Masukkan Access Key dan Secret Key'); return; }
    localStorage.setItem('repliz_access_key', ak);
    localStorage.setItem('repliz_secret_key', sk);
    var status = document.getElementById('replizConnectionStatus');
    status.innerHTML = '<span style="color:var(--accent-green)">✅ Credentials saved!</span>';
    setTimeout(function () { status.innerHTML = '<span style="color:var(--accent-green)">● Credentials saved</span>'; }, 2000);
}

async function replizTestConnection() {
    var auth = replizGetAuth();
    if (!auth) { alert('Save credentials terlebih dahulu'); return; }
    var btn = document.getElementById('replizTestBtn');
    var status = document.getElementById('replizConnectionStatus');
    btn.disabled = true; btn.textContent = '⏳ Testing...';
    status.innerHTML = '<span style="color:var(--text-muted)">Testing connection...</span>';
    try {
        var data = await replizFetch('/account?page=1&limit=1');
        if (data.statusCode && data.statusCode >= 400) throw new Error(data.message || 'Failed');
        status.innerHTML = '<span style="color:var(--accent-green)">✅ Connected! Found ' + (data.totalDocs || 0) + ' account(s)</span>';
        replizLoadAccounts();
    } catch (e) {
        status.innerHTML = '<span style="color:#ef4444">❌ ' + e.message + '</span>';
    } finally {
        btn.disabled = false; btn.textContent = '🔗 Test Connection';
    }
}

// Sub-tab switching
function replizSwitchSection(section, btn) {
    document.querySelectorAll('.repliz-section').forEach(s => s.classList.add('hidden'));
    document.querySelectorAll('.rz-subtab').forEach(b => b.classList.remove('active'));
    var sMap = { accounts: 'replizAccounts', schedules: 'replizSchedules', create: 'replizCreate', queue: 'replizQueue', bulk: 'replizBulk' };
    if (sMap[section]) document.getElementById(sMap[section]).classList.remove('hidden');
    if (btn) btn.classList.add('active');
    if (section === 'accounts') replizLoadAccounts();
    if (section === 'schedules') replizLoadSchedules();
    if (section === 'queue') replizLoadQueue();
    if (section === 'bulk') rzBulkInit();
}

// Type selector
var _replizSelectedType = 'video';
function replizSelectType(el) {
    document.querySelectorAll('.rz-type-option').forEach(o => o.classList.remove('selected'));
    el.classList.add('selected');
    _replizSelectedType = el.dataset.type;
    var TYPE_PLATFORMS = {
        text: 'Facebook, Threads',
        image: 'Facebook, Instagram, Threads, TikTok, LinkedIn',
        video: 'Facebook, Instagram, Threads, TikTok, YouTube, LinkedIn',
        reel: 'Facebook',
        album: 'Facebook, Instagram, Threads, TikTok, LinkedIn',
        story: 'Facebook, Instagram'
    };
    var hint = document.getElementById('replizTypeHint');
    if (hint) hint.textContent = 'Supported: ' + (TYPE_PLATFORMS[_replizSelectedType] || 'All platforms');
}

// --- ACCOUNTS ---
var PLATFORM_ICONS = {
    threads: '🧵', instagram: '📷', tiktok: '🎵', facebook: '📘',
    youtube: '▶️', linkedin: '💼', twitter: '🐦', x: '𝕏'
};
var PLATFORM_LABELS = {
    threads: 'Threads', instagram: 'Instagram', tiktok: 'TikTok',
    facebook: 'Facebook', youtube: 'YouTube', linkedin: 'LinkedIn'
};

async function replizLoadAccounts() {
    try {
        var data = await replizFetch('/account?page=1&limit=50');
        _replizAccounts = data.docs || [];
        var el = document.getElementById('replizAccountsList');
        var emptyEl = document.getElementById('replizAccountsEmpty');

        // Update stats
        var statEl = document.getElementById('rzStatAccounts');
        if (statEl) statEl.textContent = data.totalDocs || _replizAccounts.length;

        if (_replizAccounts.length === 0) { el.innerHTML = ''; emptyEl.classList.remove('hidden'); return; }
        emptyEl.classList.add('hidden');

        el.innerHTML = _replizAccounts.map(function (a) {
            var pType = a.type || 'unknown';
            var label = PLATFORM_LABELS[pType] || pType;
            return '<div class="rz-account-card">' +
                '<img class="rz-account-avatar" src="' + (a.picture || 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="%238b5cf6"><circle cx="12" cy="8" r="4"/><path d="M20 21a8 8 0 0 0-16 0"/></svg>')) + '" onerror="this.src=\'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="%238b5cf6"><circle cx="12" cy="8" r="4"/><path d="M20 21a8 8 0 0 0-16 0"/></svg>') + '\'">' +
                '<div style="flex:1;min-width:0">' +
                '<div style="font-weight:700;font-size:13px;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + (a.name || a.username) + '</div>' +
                '<div style="font-size:11px;color:var(--text-muted);margin-top:2px">@' + (a.username || '') + '</div>' +
                '<div style="margin-top:6px"><span class="rz-platform-badge rz-platform-' + pType + '">' + (PLATFORM_ICONS[pType] || '📱') + ' ' + label + '</span></div>' +
                '</div>' +
                '<div style="text-align:right">' +
                (a.isConnected !== false ? '<span style="color:#22c55e;font-size:10px;font-weight:700">● ONLINE</span>' : '<span style="color:var(--text-muted);font-size:10px;font-weight:700">● OFFLINE</span>') +
                '</div></div>';
        }).join('');

        // Update account checklist in Create form
        var checklistEl = document.getElementById('replizPostAccounts');
        if (checklistEl) {
            checklistEl.innerHTML = _replizAccounts.map(function (a) {
                var pType = a.type || 'unknown';
                return '<label class="rz-account-check-item" data-id="' + a._id + '">' +
                    '<input type="checkbox" value="' + a._id + '" onchange="this.parentElement.classList.toggle(\'checked\', this.checked)">' +
                    '<span class="rz-platform-badge rz-platform-' + pType + '" style="flex-shrink:0">' + (PLATFORM_ICONS[pType] || '📱') + '</span>' +
                    '<span style="font-size:12px;font-weight:600;color:var(--text-primary);flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + (a.name || a.username) + '</span>' +
                    '<span style="font-size:10px;color:var(--text-muted)">' + (PLATFORM_LABELS[pType] || pType) + '</span>' +
                    '</label>';
            }).join('');
        }

        // Load stats
        replizLoadStats();
    } catch (e) { console.log('Failed to load accounts:', e); }
}

async function replizLoadStats() {
    try {
        var data = await replizFetch('/schedule?page=1&limit=100');
        var docs = data.docs || [];
        var statTotal = document.getElementById('rzStatTotal');
        var statSuccess = document.getElementById('rzStatSuccess');
        var statPending = document.getElementById('rzStatPending');
        if (statTotal) statTotal.textContent = data.totalDocs || docs.length;
        if (statSuccess) statSuccess.textContent = docs.filter(function (s) { return s.status === 'success'; }).length;
        if (statPending) statPending.textContent = docs.filter(function (s) { return s.status === 'pending'; }).length;
    } catch (e) { /* ignore */ }
}

// --- SCHEDULES ---
function getTypeEmoji(type) {
    var map = { video: '🎬', image: '🖼️', text: '📝', reel: '🎞️', album: '📸', story: '📱', link: '🔗' };
    return map[type] || '📄';
}

async function replizLoadSchedules(page) {
    page = page || 1;
    try {
        var data = await replizFetch('/schedule?page=' + page + '&limit=10');
        var docs = data.docs || [];
        var el = document.getElementById('replizSchedulesList');
        var emptyEl = document.getElementById('replizSchedulesEmpty');
        if (docs.length === 0) { el.innerHTML = ''; emptyEl.classList.remove('hidden'); return; }
        emptyEl.classList.add('hidden');

        el.innerHTML = docs.map(function (s) {
            var statusCls = s.status === 'success' ? 'rz-status-success' : s.status === 'failed' ? 'rz-status-failed' : 'rz-status-pending';
            var thumb = (s.medias && s.medias[0] && s.medias[0].thumbnail)
                ? '<img class="rz-schedule-thumb" src="' + s.medias[0].thumbnail + '" onerror="this.style.display=\'none\'">'
                : '<div class="rz-schedule-thumb-placeholder">' + getTypeEmoji(s.type) + '</div>';
            var dt = s.scheduleAt ? new Date(s.scheduleAt).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' }) : '-';
            var accountName = '';
            if (s.accountId) {
                var acc = _replizAccounts.find(function (a) { return a._id === s.accountId; });
                if (acc) accountName = (PLATFORM_ICONS[acc.type] || '') + ' ' + (acc.name || acc.username);
            }
            return '<div class="rz-schedule-item">' +
                thumb +
                '<div style="flex:1;min-width:0">' +
                '<div style="font-weight:700;font-size:13px;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + (s.title || s.description || 'Untitled Post') + '</div>' +
                '<div style="font-size:11px;color:var(--text-muted);margin-top:3px">' + dt + '</div>' +
                (accountName ? '<div style="font-size:11px;color:var(--text-muted);margin-top:2px">' + accountName + '</div>' : '') +
                '</div>' +
                '<div style="display:flex;align-items:center;gap:10px;flex-shrink:0">' +
                '<span class="rz-status-badge ' + statusCls + '">' + (s.status || 'pending') + '</span>' +
                '<span style="font-size:11px;color:var(--text-muted)">' + getTypeEmoji(s.type) + ' ' + (s.type || '') + '</span>' +
                '<button class="rz-delete-btn" onclick="replizDeleteSchedule(\'' + s._id + '\')" title="Delete">' +
                '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>' +
                '</button></div></div>';
        }).join('');

        // Paging
        var pagingEl = document.getElementById('replizSchedulesPaging');
        pagingEl.innerHTML = '';
        if (data.totalPages > 1) {
            for (var p = 1; p <= Math.min(data.totalPages, 10); p++) {
                pagingEl.innerHTML += '<button class="rz-page-btn' + (p === page ? ' active' : '') + '" onclick="replizLoadSchedules(' + p + ')">' + p + '</button>';
            }
        }
    } catch (e) { console.log('Failed to load schedules:', e); }
}

async function replizDeleteSchedule(id) {
    if (!confirm('Delete this schedule?')) return;
    try {
        await replizFetch('/schedule/' + id, { method: 'DELETE' });
        replizLoadSchedules();
    } catch (e) { alert('Delete failed: ' + e.message); }
}

// --- CREATE POST ---
function rzToggleAllAccounts() {
    var checkboxes = document.querySelectorAll('#replizPostAccounts input[type="checkbox"]');
    var allChecked = Array.from(checkboxes).every(function (cb) { return cb.checked; });
    checkboxes.forEach(function (cb) {
        cb.checked = !allChecked;
        cb.parentElement.classList.toggle('checked', cb.checked);
    });
}

async function replizCreatePost() {
    var checkboxes = document.querySelectorAll('#replizPostAccounts input[type="checkbox"]:checked');
    var selectedIds = Array.from(checkboxes).map(function (cb) { return cb.value; });
    var type = _replizSelectedType;
    var title = document.getElementById('replizPostTitle').value.trim();
    var desc = document.getElementById('replizPostDesc').value.trim();
    var mediaUrl = document.getElementById('replizPostMedia').value.trim();
    var thumbUrl = document.getElementById('replizPostThumb').value.trim();
    var dateVal = document.getElementById('replizPostDate').value;
    if (selectedIds.length === 0) { alert('Pilih minimal 1 account'); return; }
    if (!desc && !title) { alert('Masukkan title atau description'); return; }
    var btn = document.getElementById('replizCreateBtn');
    btn.disabled = true;

    var successCount = 0;
    var failCount = 0;
    for (var i = 0; i < selectedIds.length; i++) {
        btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> Scheduling ' + (i + 1) + '/' + selectedIds.length + '...';
        try {
            var body = { title: title, description: desc, type: type, medias: [], accountId: selectedIds[i] };
            if (dateVal) body.scheduleAt = new Date(dateVal).toISOString();
            else body.scheduleAt = new Date(Date.now() + 60000).toISOString();
            if (type !== 'text' && mediaUrl) {
                var media = { type: type === 'image' || type === 'album' ? 'image' : 'video', url: mediaUrl };
                if (thumbUrl) media.thumbnail = thumbUrl;
                body.medias.push(media);
            }
            var data = await replizFetch('/schedule', { method: 'POST', body: JSON.stringify(body) });
            if (data.statusCode && data.statusCode >= 400) { failCount++; } else { successCount++; }
        } catch (e) { failCount++; }
    }
    var msg = '✅ ' + successCount + ' post(s) scheduled';
    if (failCount > 0) msg += ', ❌ ' + failCount + ' failed';
    var publishResult = { attempted: false, ok: false, warning: '' };
    if (successCount > 0) {
        publishResult = await markTableShareRowPublishedIfNeeded();
    } else {
        clearActiveTableShareDraft();
    }
    alert(buildPostSuccessWithTableStatus(msg, publishResult));
    if (successCount > 0) {
        document.getElementById('replizPostTitle').value = '';
        document.getElementById('replizPostDesc').value = '';
        rzRemoveMedia();
        // Uncheck all
        document.querySelectorAll('#replizPostAccounts input[type="checkbox"]').forEach(function (cb) {
            cb.checked = false; cb.parentElement.classList.remove('checked');
        });
        replizSwitchSection('schedules', document.querySelectorAll('.rz-subtab')[1]);
    }
    btn.disabled = false;
    btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg> Schedule Post';
}

// --- BULK SCHEDULE ---
var _rzBulkItems = [];   // [{file, title, caption, mediaUrl, thumbUrl, status}]
var _rzBulkType = 'video';

function rzBulkInit() {
    // Populate account checklist from already-loaded accounts
    var checklistEl = document.getElementById('rzBulkPostAccounts');
    if (!checklistEl) return;
    if (_replizAccounts && _replizAccounts.length > 0) {
        checklistEl.innerHTML = _replizAccounts.map(function (a) {
            var pType = a.type || 'unknown';
            return '<label class="rz-account-check-item" data-id="' + a._id + '">' +
                '<input type="checkbox" value="' + a._id + '" onchange="this.parentElement.classList.toggle(\'checked\', this.checked)">' +
                '<span class="rz-platform-badge rz-platform-' + pType + '" style="flex-shrink:0">' + (PLATFORM_ICONS[pType] || '📱') + '</span>' +
                '<span style="font-size:12px;font-weight:600;color:var(--text-primary);flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + (a.name || a.username) + '</span>' +
                '<span style="font-size:10px;color:var(--text-muted)">' + (PLATFORM_LABELS[pType] || pType) + '</span>' +
                '</label>';
        }).join('');
    } else {
        // Try loading accounts first
        replizLoadAccounts().then(function () { rzBulkInit(); });
    }
}

function rzBulkAttachFile(idx) {
    var input = document.getElementById('rzBulkAttachInput_' + idx);
    if (input) input.click();
}

function rzBulkHandleAttach(idx, input) {
    var file = input.files[0];
    if (!file) return;
    _rzBulkItems[idx].file = file;
    _rzBulkItems[idx].needsFile = false;
    _rzBulkItems[idx].filename = file.name;
    _rzBulkItems[idx].size = file.size;
    input.value = '';
    rzBulkRenderList();
    rzBulkCheckFolderBar();
    rzBulkTriggerAutoSave();
}

// Tampilkan/sembunyikan folder bar berdasarkan apakah masih ada item needsFile
function rzBulkCheckFolderBar() {
    var bar = document.getElementById('rzBulkFolderBar');
    if (!bar) return;
    var hasNeedsFile = _rzBulkItems.some(function (item) { return item.needsFile; });
    bar.style.display = hasNeedsFile ? '' : 'none';
    if (!hasNeedsFile) document.getElementById('rzBulkScanStatus').textContent = '';
}

// Scan folder lokal, auto-match by filename, fetch dan attach sebagai File object
async function rzBulkScanFolder() {
    var folderPath = document.getElementById('rzBulkFolderPath').value.trim();
    if (!folderPath) { rzBulkShowToast('Masukkan path folder terlebih dahulu', 'warn'); return; }

    var btn = document.getElementById('rzBulkScanBtn');
    var statusEl = document.getElementById('rzBulkScanStatus');
    btn.disabled = true;
    btn.textContent = 'Scanning...';
    statusEl.textContent = '⏳ Membaca folder...';
    statusEl.style.color = 'var(--text-muted)';

    try {
        var res = await fetch('/api/scan-folder?path=' + encodeURIComponent(folderPath));
        var data = await res.json();
        if (data.error) throw new Error(data.error);

        var serverFiles = data.files || [];  // [{name, fullPath, size, ext}]
        statusEl.textContent = '📦 ' + serverFiles.length + ' file ditemukan — sedang matching...';

        var matched = 0, failed = 0;
        var needsItems = _rzBulkItems.map(function (item, idx) {
            return item.needsFile ? { idx: idx, filename: item.filename } : null;
        }).filter(Boolean);

        for (var i = 0; i < needsItems.length; i++) {
            var need = needsItems[i];
            // Cari file di folder yang namanya cocok (exact match dulu, lalu tanpa ekstensi)
            var match = serverFiles.find(function (f) { return f.name === need.filename; });
            if (!match) {
                var needBase = need.filename.replace(/\.[^.]+$/, '').toLowerCase();
                match = serverFiles.find(function (f) {
                    return f.name.replace(/\.[^.]+$/, '').toLowerCase() === needBase;
                });
            }
            if (!match) { failed++; continue; }

            statusEl.textContent = '⏳ Fetching ' + (i + 1) + '/' + needsItems.length + ': ' + match.name;
            try {
                // Fetch file dari server via /api/local-file
                var fileRes = await fetch('/api/local-file?path=' + encodeURIComponent(match.fullPath));
                if (!fileRes.ok) throw new Error('HTTP ' + fileRes.status);
                var blob = await fileRes.blob();
                var file = new File([blob], match.name, { type: blob.type || 'video/mp4' });

                var item = _rzBulkItems[need.idx];
                item.file = file;
                item.needsFile = false;
                item.filename = file.name;
                item.size = file.size;
                matched++;
            } catch (e) {
                failed++;
            }
        }

        rzBulkRenderList();
        rzBulkCheckFolderBar();
        rzBulkTriggerAutoSave();

        if (matched > 0 && failed === 0) {
            statusEl.textContent = '✅ Semua ' + matched + ' file berhasil di-attach!';
            statusEl.style.color = '#22c55e';
            rzBulkShowToast(matched + ' file berhasil di-attach dari folder');
        } else if (matched > 0) {
            statusEl.textContent = '✅ ' + matched + ' berhasil, ⚠️ ' + failed + ' tidak ditemukan di folder ini';
            statusEl.style.color = '#f59e0b';
        } else {
            statusEl.textContent = '❌ Tidak ada file yang cocok di folder ini';
            statusEl.style.color = '#ef4444';
            rzBulkShowToast('Tidak ada file yang cocok', 'warn');
        }
    } catch (e) {
        statusEl.textContent = '❌ Error: ' + e.message;
        statusEl.style.color = '#ef4444';
    } finally {
        btn.disabled = false;
        btn.textContent = 'Scan & Match';
    }
}

function rzBulkSelectType(el) {
    document.querySelectorAll('#rzBulkTypeSelector .rz-type-option').forEach(o => o.classList.remove('selected'));
    el.classList.add('selected');
    _rzBulkType = el.dataset.type;
}

function rzBulkToggleAllAccounts() {
    var cbs = document.querySelectorAll('#rzBulkPostAccounts input[type="checkbox"]');
    var anyUnchecked = Array.from(cbs).some(cb => !cb.checked);
    cbs.forEach(function (cb) {
        cb.checked = anyUnchecked;
        cb.parentElement.classList.toggle('checked', anyUnchecked);
    });
}

function rzBulkHandleDrop(e) {
    e.preventDefault();
    document.getElementById('rzBulkDropZone').classList.remove('drag-over');
    var allFiles = Array.from(e.dataTransfer.files);
    var txtFiles = allFiles.filter(f => f.name.endsWith('.txt') || f.type === 'text/plain');
    var mediaFiles = allFiles.filter(f => f.type.startsWith('video/') || f.type.startsWith('image/'));
    if (txtFiles.length) rzBulkProcessTxtFiles(txtFiles);
    if (mediaFiles.length) rzBulkAddFiles(mediaFiles);
}

function rzBulkHandleFileSelect(input) {
    rzBulkAddFiles(Array.from(input.files));
    input.value = '';
}

function rzBulkHandleTxtSelect(input) {
    rzBulkProcessTxtFiles(Array.from(input.files));
    input.value = '';
}

// Parse satu file txt → { title, caption }
// Format: "Judul Hook:\n...\n\nCaption:\n..."
function rzParseCaptionTxt(text) {
    var title = '', caption = '';

    // Extract Judul Hook
    var titleMatch = text.match(/Judul Hook:\s*\n([\s\S]*?)(?:\n\n|\nCaption:)/i);
    if (titleMatch) title = titleMatch[1].trim();

    // Extract Caption — ambil semua mulai "Caption:" sampai "Durasi:" atau "Alasan AI:" atau EOF
    var captionMatch = text.match(/Caption:\s*\n([\s\S]*?)(?:\n\nDurasi:|\n\nAlasan AI:|$)/i);
    if (captionMatch) caption = captionMatch[1].trim();

    return { title: title, caption: caption };
}

// Ekstrak nomor clip dari nama file, e.g. "clip01_caption.txt" → "01", "clip_02.mp4" → "02"
function rzExtractClipNum(filename) {
    var m = filename.match(/clip[_-]?(\d+)/i);
    return m ? m[1].replace(/^0+/, '') : null; // hapus leading zero: "01" → "1"
}

// Proses array File txt — auto-match ke item yang ada, atau apply global
function rzBulkProcessTxtFiles(txtFiles) {
    var promises = txtFiles.map(function (file) {
        return new Promise(function (resolve) {
            var reader = new FileReader();
            reader.onload = function (e) { resolve({ name: file.name, text: e.target.result }); };
            reader.onerror = function () { resolve(null); };
            reader.readAsText(file);
        });
    });

    Promise.all(promises).then(function (results) {
        var matched = 0, applied = 0;
        results.forEach(function (r) {
            if (!r) return;
            var parsed = rzParseCaptionTxt(r.text);
            if (!parsed.title && !parsed.caption) return;

            var clipNum = rzExtractClipNum(r.name);

            if (clipNum !== null) {
                // Cari item yang clip number-nya cocok
                var found = false;
                _rzBulkItems.forEach(function (item) {
                    var itemNum = rzExtractClipNum(item.file.name);
                    if (itemNum === clipNum) {
                        if (parsed.title) item.title = parsed.title;
                        if (parsed.caption) item.caption = parsed.caption;
                        found = true;
                        matched++;
                    }
                });
                if (!found) {
                    // Tidak ada match — coba apply ke index (clip01 → index 0)
                    var idx = parseInt(clipNum, 10) - 1;
                    if (idx >= 0 && idx < _rzBulkItems.length) {
                        if (parsed.title) _rzBulkItems[idx].title = parsed.title;
                        if (parsed.caption) _rzBulkItems[idx].caption = parsed.caption;
                        matched++;
                    }
                }
            } else {
                // Tidak ada nomor — apply ke semua yang kosong (global caption file)
                _rzBulkItems.forEach(function (item) {
                    if (!item.title && parsed.title) item.title = parsed.title;
                    if (!item.caption && parsed.caption) item.caption = parsed.caption;
                    applied++;
                });
            }
        });

        rzBulkRenderList();
        var total = matched + applied;
        if (total > 0) {
            rzBulkShowToast('Caption berhasil di-import ke ' + total + ' item');
        } else if (_rzBulkItems.length === 0) {
            rzBulkShowToast('Tambahkan file video dulu sebelum import TXT', 'warn');
        } else {
            rzBulkShowToast('Tidak ada caption yang bisa di-match dari file TXT', 'warn');
        }
    });
}

function rzBulkShowToast(msg, type) {
    var existing = document.getElementById('rzBulkToast');
    if (existing) existing.remove();
    var toast = document.createElement('div');
    toast.id = 'rzBulkToast';
    toast.textContent = msg;
    toast.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);' +
        'background:' + (type === 'warn' ? 'rgba(245,158,11,0.95)' : 'rgba(34,197,94,0.95)') + ';' +
        'color:#fff;padding:10px 20px;border-radius:10px;font-size:13px;font-weight:600;' +
        'z-index:99999;box-shadow:0 4px 20px rgba(0,0,0,0.4);pointer-events:none';
    document.body.appendChild(toast);
    setTimeout(function () { if (toast.parentNode) toast.remove(); }, 3000);
}

function rzBulkAddFiles(files) {
    // Default scheduleAt = 10 min from now, formatted for datetime-local input
    function defaultDT() {
        var d = new Date(Date.now() + 10 * 60 * 1000);
        return d.getFullYear() + '-' +
            String(d.getMonth() + 1).padStart(2, '0') + '-' +
            String(d.getDate()).padStart(2, '0') + 'T' +
            String(d.getHours()).padStart(2, '0') + ':' +
            String(d.getMinutes()).padStart(2, '0');
    }
    files.forEach(function (file) {
        _rzBulkItems.push({ file: file, filename: file.name, size: file.size, title: '', caption: '', scheduleAt: defaultDT(), mediaUrl: '', thumbUrl: '', status: 'pending', needsFile: false });
    });
    rzBulkRenderList();
    rzBulkTriggerAutoSave();
}

function rzBulkRenderList() {
    var el = document.getElementById('rzBulkList');
    var countEl = document.getElementById('rzBulkCount');
    countEl.textContent = _rzBulkItems.length + ' file' + (_rzBulkItems.length !== 1 ? 's' : '');

    if (_rzBulkItems.length === 0) { el.innerHTML = ''; return; }

    el.innerHTML = _rzBulkItems.map(function (item, idx) {
        var displayName = item.file ? item.file.name : (item.filename || 'Unknown file');
        var sizeMB = item.file ? (item.file.size / 1048576).toFixed(1) : (item.size ? (item.size / 1048576).toFixed(1) : '?');
        var statusIcon = item.status === 'done' ? '✅' : item.status === 'error' ? '❌' : item.status === 'uploading' ? '⏳' : item.needsFile ? '⚠️' : '📄';
        var needsFileRow = item.needsFile
            ? '<div style="display:flex;align-items:center;gap:8px;margin-top:2px;padding:6px 8px;background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.2);border-radius:8px">' +
              '<span style="font-size:11px;color:#f59e0b;flex:1">File belum dipilih — pilih file yang cocok</span>' +
              '<button onclick="rzBulkAttachFile(' + idx + ')" class="rz-btn rz-btn-secondary rz-btn-sm" style="padding:3px 8px;font-size:10px;flex-shrink:0">📁 Pilih File</button>' +
              '<input type="file" id="rzBulkAttachInput_' + idx + '" accept="video/*,image/*" style="display:none" onchange="rzBulkHandleAttach(' + idx + ',this)">' +
              '</div>'
            : '';
        return '<div class="rz-glass-card" style="padding:12px;display:flex;gap:12px;align-items:flex-start" id="rzBulkItem_' + idx + '">' +
            '<div style="flex-shrink:0;font-size:20px;line-height:1.4">' + statusIcon + '</div>' +
            '<div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:5px">' +
            '<div style="font-size:12px;font-weight:700;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + rzEscText(displayName) + ' <span style="font-weight:400;color:var(--text-muted)">(' + sizeMB + ' MB)</span></div>' +
            needsFileRow +
            '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">' +
            '<input type="text" placeholder="Title (optional)" value="' + rzEsc(item.title) + '" oninput="_rzBulkItems[' + idx + '].title=this.value;rzBulkTriggerAutoSave()" class="rz-form-input" style="font-size:11px;padding:5px 8px">' +
            '<div style="display:flex;flex-direction:column;gap:2px">' +
            '<label style="font-size:10px;color:var(--text-muted);font-weight:600">Schedule Date &amp; Time</label>' +
            '<input type="datetime-local" value="' + rzEsc(item.scheduleAt) + '" oninput="_rzBulkItems[' + idx + '].scheduleAt=this.value;rzBulkTriggerAutoSave()" class="rz-form-input" style="font-size:11px;padding:5px 8px">' +
            '</div>' +
            '</div>' +
            '<textarea placeholder="Caption (optional — overrides global)" rows="2" oninput="_rzBulkItems[' + idx + '].caption=this.value;rzBulkTriggerAutoSave()" class="rz-form-textarea" style="font-size:11px;padding:5px 8px;resize:vertical">' + rzEscText(item.caption) + '</textarea>' +
            '</div>' +
            '<button onclick="rzBulkRemoveItem(' + idx + ')" class="rz-btn rz-btn-secondary rz-btn-sm" style="padding:4px 8px;flex-shrink:0" title="Remove">' +
            '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
            '</button></div>';
    }).join('');
}

function rzEsc(str) { return (str || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function rzEscText(str) { return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function rzBulkRemoveItem(idx) {
    _rzBulkItems.splice(idx, 1);
    rzBulkRenderList();
    rzBulkTriggerAutoSave();
}

function rzBulkUpdateItemStatus(idx, status) {
    _rzBulkItems[idx].status = status;
    var el = document.getElementById('rzBulkItem_' + idx);
    if (!el) return;
    var icons = { done: '✅', error: '❌', uploading: '⏳', pending: '📄' };
    el.querySelector('div:first-child').textContent = icons[status] || '📄';
}

function rzBulkLog(msg, type) {
    var log = document.getElementById('rzBulkLog');
    var items = document.getElementById('rzBulkLogItems');
    log.style.display = '';
    var colors = { ok: '#22c55e', err: '#ef4444', info: 'var(--text-muted)' };
    items.insertAdjacentHTML('beforeend',
        '<div style="font-size:11px;color:' + (colors[type] || 'var(--text-secondary)') + ';padding:3px 0;border-bottom:1px solid rgba(255,255,255,0.04)">' + msg + '</div>');
    items.scrollTop = items.scrollHeight;
}

async function rzBulkSubmit() {
    if (_rzBulkItems.length === 0) { alert('Tambahkan minimal 1 file terlebih dahulu'); return; }

    var checkboxes = document.querySelectorAll('#rzBulkPostAccounts input[type="checkbox"]:checked');
    var selectedIds = Array.from(checkboxes).map(cb => cb.value);
    if (selectedIds.length === 0) { alert('Pilih minimal 1 akun tujuan'); return; }

    // Validate semua item sudah ada filenya
    var needsFile = _rzBulkItems.findIndex(function (item) { return item.needsFile || !item.file; });
    if (needsFile !== -1) {
        alert('File #' + (needsFile + 1) + ' (' + (_rzBulkItems[needsFile].filename || '?') + ') belum dipilih. Klik tombol "Pilih File" untuk melampirkan file yang sesuai.');
        return;
    }

    // Validate all items have a scheduleAt
    var missing = _rzBulkItems.findIndex(function (item) { return !item.scheduleAt; });
    if (missing !== -1) { alert('File #' + (missing + 1) + ' (' + _rzBulkItems[missing].file.name + ') belum diisi tanggal jadwal.'); return; }

    var globalCaption = document.getElementById('rzBulkGlobalCaption').value.trim();

    var btn = document.getElementById('rzBulkSubmitBtn');
    btn.disabled = true;
    document.getElementById('rzBulkLog').style.display = 'none';
    document.getElementById('rzBulkLogItems').innerHTML = '';

    var successTotal = 0, failTotal = 0;

    for (var i = 0; i < _rzBulkItems.length; i++) {
        var item = _rzBulkItems[i];
        var schedAt = new Date(item.scheduleAt).toISOString();
        rzBulkLog('[' + (i + 1) + '/' + _rzBulkItems.length + '] ' + item.file.name + ' → uploading...', 'info');
        rzBulkUpdateItemStatus(i, 'uploading');
        btn.textContent = 'Processing ' + (i + 1) + '/' + _rzBulkItems.length + '...';

        // Upload file to server
        try {
            var fd = new FormData();
            fd.append('file', item.file);
            var upRes = await fetch('/repliz-upload', { method: 'POST', body: fd });
            var upData = await upRes.json();
            if (!upData.url) throw new Error(upData.message || 'Upload gagal');
            item.mediaUrl = upData.url;
            if (upData.thumbnail) item.thumbUrl = upData.thumbnail;
            rzBulkLog('  Upload OK → ' + upData.url.split('/').pop(), 'info');

            // Auto-capture thumbnail from video
            if (!item.thumbUrl && item.file.type.startsWith('video/')) {
                rzBulkLog('  Capturing thumbnail...', 'info');
                var thumbUrl = await rzCaptureThumbFromFile(item.file);
                if (thumbUrl) {
                    item.thumbUrl = thumbUrl;
                    rzBulkLog('  Thumbnail OK', 'info');
                } else {
                    rzBulkLog('  Thumbnail capture gagal (akan dilewati)', 'info');
                }
            }
        } catch (e) {
            rzBulkLog('  Upload GAGAL: ' + e.message, 'err');
            rzBulkUpdateItemStatus(i, 'error');
            failTotal += selectedIds.length;
            continue;
        }

        // Schedule to each selected account
        var caption = item.caption.trim() || globalCaption;
        var title = item.title.trim();
        var itemSuccess = 0, itemFail = 0;
        for (var j = 0; j < selectedIds.length; j++) {
            try {
                var body = {
                    title: title,
                    description: caption,
                    type: _rzBulkType,
                    medias: [],
                    accountId: selectedIds[j],
                    scheduleAt: schedAt
                };
                if (_rzBulkType !== 'text' && item.mediaUrl) {
                    var media = { type: _rzBulkType === 'image' ? 'image' : 'video', url: item.mediaUrl };
                    if (item.thumbUrl) media.thumbnail = item.thumbUrl;
                    body.medias.push(media);
                }
                var res = await replizFetch('/schedule', { method: 'POST', body: JSON.stringify(body) });
                if (res.statusCode && res.statusCode >= 400) throw new Error(res.message || 'API error');
                itemSuccess++;
                successTotal++;
            } catch (e) {
                itemFail++;
                failTotal++;
                rzBulkLog('  Account ' + selectedIds[j] + ' GAGAL: ' + e.message, 'err');
            }
        }

        rzBulkUpdateItemStatus(i, itemFail === selectedIds.length ? 'error' : 'done');
        rzBulkLog('  Scheduled: ✅ ' + itemSuccess + ' akun, ❌ ' + itemFail + ' akun — ' + new Date(schedAt).toLocaleString('id-ID'), itemFail > 0 ? 'err' : 'ok');
    }

    btn.disabled = false;
    btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg> Bulk Schedule All';
    rzBulkLog('=== Selesai: ' + successTotal + ' berhasil, ' + failTotal + ' gagal ===', successTotal > 0 ? 'ok' : 'err');
    replizLoadStats();
}

// --- BULK DRAFTS ---
var _rzBulkCurrentDraftId = null;  // ID draft yang sedang aktif
var _rzBulkAutoSaveTimer = null;

// Kumpulkan state saat ini jadi objek draft
function rzBulkCollectDraft(name) {
    var checkboxes = document.querySelectorAll('#rzBulkPostAccounts input[type="checkbox"]:checked');
    var selectedIds = Array.from(checkboxes).map(cb => cb.value);
    return {
        id: _rzBulkCurrentDraftId || null,
        name: name || ('Draft ' + new Date().toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' })),
        type: _rzBulkType,
        globalCaption: (document.getElementById('rzBulkGlobalCaption') || {}).value || '',
        selectedAccountIds: selectedIds,
        items: _rzBulkItems.map(function (item) {
            return {
                filename: item.file ? item.file.name : (item.filename || ''),
                size: item.file ? item.file.size : (item.size || 0),
                title: item.title || '',
                caption: item.caption || '',
                scheduleAt: item.scheduleAt || ''
            };
        })
    };
}

// Auto-save (debounced 2s) setiap kali list berubah
function rzBulkTriggerAutoSave() {
    if (_rzBulkItems.length === 0) return;
    clearTimeout(_rzBulkAutoSaveTimer);
    _rzBulkAutoSaveTimer = setTimeout(function () { rzBulkSaveDraft(true); }, 2000);
}

// Simpan draft — silent=true untuk auto-save (tanpa toast nama)
async function rzBulkSaveDraft(silent) {
    if (_rzBulkItems.length === 0 && !silent) { rzBulkShowToast('Tidak ada item untuk disimpan', 'warn'); return; }
    if (_rzBulkItems.length === 0) return;

    var draft = rzBulkCollectDraft();
    if (_rzBulkCurrentDraftId) draft.id = _rzBulkCurrentDraftId;

    try {
        var res = await fetch('/api/bulk-drafts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(draft)
        });
        var data = await res.json();
        if (data.id) _rzBulkCurrentDraftId = data.id;
        if (!silent) rzBulkShowToast('Draft disimpan ✓');
    } catch (e) {
        if (!silent) rzBulkShowToast('Gagal simpan draft', 'warn');
    }
}

// Buka panel drafts
async function rzBulkOpenDraftPanel() {
    document.getElementById('bulkDraftPanel').style.display = '';
    document.getElementById('bulkDraftOverlay').style.display = '';
    await rzBulkLoadDrafts();
}

function rzBulkCloseDraftPanel() {
    document.getElementById('bulkDraftPanel').style.display = 'none';
    document.getElementById('bulkDraftOverlay').style.display = 'none';
}

async function rzBulkLoadDrafts() {
    var listEl = document.getElementById('bulkDraftList');
    listEl.innerHTML = '<div style="color:var(--text-muted);text-align:center;padding:20px;font-size:12px">⏳ Memuat drafts...</div>';
    try {
        var res = await fetch('/api/bulk-drafts');
        var drafts = await res.json();
        if (!drafts.length) {
            listEl.innerHTML = '<div style="color:var(--text-muted);text-align:center;padding:32px 0;font-size:13px">📂 Belum ada draft</div>';
            return;
        }
        listEl.innerHTML = drafts.map(function (d) {
            var dt = d.updatedAt ? new Date(d.updatedAt).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' }) : '-';
            return '<div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:12px;padding:12px 14px">' +
                '<div style="font-weight:700;font-size:13px;color:var(--text-primary);margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + rzEscText(d.name) + '</div>' +
                '<div style="font-size:11px;color:var(--text-muted);margin-bottom:10px">📦 ' + d.itemCount + ' file &nbsp;·&nbsp; 🕐 ' + dt + '</div>' +
                '<div style="display:flex;gap:8px">' +
                '<button onclick="rzBulkLoadDraft(\'' + d.id + '\')" class="rz-btn rz-btn-primary rz-btn-sm" style="flex:1;justify-content:center">📂 Load</button>' +
                '<button onclick="rzBulkDownloadDraft(\'' + d.id + '\')" class="rz-btn rz-btn-secondary rz-btn-sm" title="Download JSON">⬇</button>' +
                '<button onclick="rzBulkDeleteDraft(\'' + d.id + '\', this)" class="rz-btn rz-btn-secondary rz-btn-sm" style="color:#ef4444" title="Hapus">🗑</button>' +
                '</div></div>';
        }).join('');
    } catch (e) {
        listEl.innerHTML = '<div style="color:#ef4444;text-align:center;padding:20px;font-size:12px">❌ Gagal memuat drafts</div>';
    }
}

async function rzBulkLoadDraft(id) {
    try {
        var res = await fetch('/api/bulk-drafts/' + id);
        var draft = await res.json();
        if (draft.error) { alert('Draft tidak ditemukan'); return; }

        // Reset state
        _rzBulkItems = [];
        _rzBulkCurrentDraftId = draft.id;

        // Restore type
        if (draft.type) {
            _rzBulkType = draft.type;
            document.querySelectorAll('#rzBulkTypeSelector .rz-type-option').forEach(function (o) {
                o.classList.toggle('selected', o.dataset.type === draft.type);
            });
        }

        // Restore global caption
        var gcEl = document.getElementById('rzBulkGlobalCaption');
        if (gcEl && draft.globalCaption) gcEl.value = draft.globalCaption;

        // Restore items sebagai placeholder (file belum attach)
        (draft.items || []).forEach(function (item) {
            _rzBulkItems.push({
                file: null,               // belum ada — placeholder
                filename: item.filename,  // simpan nama untuk tampilan & match
                size: item.size || 0,
                title: item.title || '',
                caption: item.caption || '',
                scheduleAt: item.scheduleAt || '',
                mediaUrl: '',
                thumbUrl: '',
                status: 'pending',
                needsFile: true           // tandai perlu re-attach
            });
        });

        rzBulkRenderList();
        rzBulkCheckFolderBar();
        rzBulkCloseDraftPanel();

        // Restore selected accounts
        if (draft.selectedAccountIds && draft.selectedAccountIds.length) {
            setTimeout(function () {
                document.querySelectorAll('#rzBulkPostAccounts input[type="checkbox"]').forEach(function (cb) {
                    var checked = draft.selectedAccountIds.includes(cb.value);
                    cb.checked = checked;
                    cb.parentElement.classList.toggle('checked', checked);
                });
            }, 200);
        }

        rzBulkShowToast('Draft "' + draft.name + '" berhasil di-load');
    } catch (e) {
        alert('Gagal load draft: ' + e.message);
    }
}

async function rzBulkDeleteDraft(id, btn) {
    if (!confirm('Hapus draft ini?')) return;
    btn.textContent = '⏳';
    try {
        await fetch('/api/bulk-drafts/' + id, { method: 'DELETE' });
        if (id === _rzBulkCurrentDraftId) _rzBulkCurrentDraftId = null;
        rzBulkLoadDrafts();
    } catch (e) { rzBulkLoadDrafts(); }
}

async function rzBulkDownloadDraft(id) {
    var res = await fetch('/api/bulk-drafts/' + id);
    var draft = await res.json();
    var blob = new Blob([JSON.stringify(draft, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (draft.name || 'bulk-draft') + '.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
}

// --- QUEUE ---
async function replizLoadQueue(page) {
    page = page || 1;
    try {
        var data = await replizFetch('/queue?page=' + page + '&limit=10');
        var docs = data.docs || [];
        var el = document.getElementById('replizQueueList');
        var emptyEl = document.getElementById('replizQueueEmpty');
        if (docs.length === 0) { el.innerHTML = ''; emptyEl.classList.remove('hidden'); return; }
        emptyEl.classList.add('hidden');

        el.innerHTML = docs.map(function (q) {
            var statusCls = q.status === 'resolved' ? 'rz-status-success' : q.status === 'ignored' ? 'rz-status-failed' : 'rz-status-pending';
            var ownerPic = (q.comment && q.comment.owner && q.comment.owner.picture)
                ? '<img class="rz-queue-owner-pic" src="' + q.comment.owner.picture + '">'
                : '<div style="width:36px;height:36px;border-radius:50%;background:rgba(139,92,246,0.1);display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0">💬</div>';
            var ownerName = (q.comment && q.comment.owner) ? q.comment.owner.name : 'Unknown';
            var commentText = (q.comment) ? q.comment.text : '';
            var contentTitle = (q.content) ? (q.content.title || q.content.description || '').substring(0, 50) : '';
            var replies = '';
            if (q.comment && q.comment.replies && q.comment.replies.length > 0) {
                replies = '<div class="rz-queue-replies">' +
                    q.comment.replies.map(function (r) { return '<div class="rz-queue-reply"><strong>' + (r.owner ? r.owner.name : '') + ':</strong> ' + (r.text || '') + '</div>'; }).join('') +
                    '</div>';
            }
            return '<div class="rz-queue-item">' +
                '<div style="display:flex;align-items:flex-start;gap:12px">' +
                ownerPic +
                '<div style="flex:1;min-width:0">' +
                '<div style="display:flex;justify-content:space-between;align-items:center">' +
                '<span style="font-weight:700;font-size:13px;color:var(--text-primary)">' + ownerName + '</span>' +
                '<span class="rz-status-badge ' + statusCls + '">' + (q.status || 'pending') + '</span>' +
                '</div>' +
                '<div style="font-size:13px;color:var(--text-secondary);margin-top:4px;line-height:1.5">' + commentText + '</div>' +
                (contentTitle ? '<div style="font-size:11px;color:var(--text-muted);margin-top:6px">📌 ' + contentTitle + '</div>' : '') +
                replies +
                '</div></div></div>';
        }).join('');

        // Paging
        var pagingEl = document.getElementById('replizQueuePaging');
        pagingEl.innerHTML = '';
        if (data.totalPages > 1) {
            for (var p = 1; p <= Math.min(data.totalPages, 10); p++) {
                pagingEl.innerHTML += '<button class="rz-page-btn' + (p === page ? ' active' : '') + '" onclick="replizLoadQueue(' + p + ')">' + p + '</button>';
            }
        }
    } catch (e) { console.log('Failed to load queue:', e); }
}

// ============================================
//  REPLIZ MEDIA UPLOAD
// ============================================
function rzFormatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
}

function rzHandleFileSelect(input) {
    if (input.files && input.files[0]) rzUploadFile(input.files[0]);
}

function rzUploadFile(file) {
    var validTypes = ['video/', 'image/'];
    if (!validTypes.some(function (t) { return file.type.startsWith(t); })) {
        alert('Unsupported file type. Please upload a video or image.'); return;
    }
    if (file.size > 500 * 1024 * 1024) {
        alert('File too large. Maximum 500MB.'); return;
    }

    // Show progress
    document.getElementById('rzUploadZone').style.display = 'none';
    document.getElementById('rzUploadProgress').classList.remove('hidden');
    document.getElementById('rzUploadFileName').textContent = file.name;

    var fd = new FormData();
    fd.append('file', file);

    var xhr = new XMLHttpRequest();
    xhr.open('POST', '/repliz-upload', true);

    xhr.upload.onprogress = function (e) {
        if (e.lengthComputable) {
            var pct = Math.round((e.loaded / e.total) * 100);
            document.getElementById('rzUploadPercent').textContent = pct + '%';
            document.getElementById('rzUploadBar').style.width = pct + '%';
            if (pct >= 100) {
                document.getElementById('rzUploadFileName').textContent = 'Publishing to public URL...';
                document.getElementById('rzUploadPercent').textContent = '⏳';
            }
        }
    };

    xhr.onload = function () {
        document.getElementById('rzUploadProgress').classList.add('hidden');
        if (xhr.status === 200) {
            var data = JSON.parse(xhr.responseText);
            document.getElementById('replizPostMedia').value = data.url;
            rzShowPreview(file, data);
        } else {
            alert('Upload failed');
            document.getElementById('rzUploadZone').style.display = '';
        }
    };

    xhr.onerror = function () {
        alert('Upload error');
        document.getElementById('rzUploadProgress').classList.add('hidden');
        document.getElementById('rzUploadZone').style.display = '';
    };

    xhr.send(fd);
}

function rzShowPreview(file, data) {
    document.getElementById('rzMediaPreview').classList.remove('hidden');
    document.getElementById('rzPreviewName').textContent = file.name;
    document.getElementById('rzPreviewSize').textContent = rzFormatSize(file.size);

    var isVideo = file.type.startsWith('video/');
    var videoEl = document.getElementById('rzVideoPreview');
    var imgEl = document.getElementById('rzImagePreview');
    var thumbSection = document.getElementById('rzThumbSection');

    if (isVideo) {
        videoEl.style.display = 'block';
        imgEl.style.display = 'none';
        videoEl.src = URL.createObjectURL(file);
        thumbSection.style.display = 'block';

        // Auto-capture thumbnail at 1 second
        videoEl.onloadeddata = function () {
            videoEl.currentTime = Math.min(1, videoEl.duration * 0.1);
        };
        videoEl.onseeked = function () {
            if (!document.getElementById('replizPostThumb').value) {
                rzCaptureThumbnail();
            }
        };
    } else {
        videoEl.style.display = 'none';
        imgEl.style.display = 'block';
        imgEl.src = URL.createObjectURL(file);
        thumbSection.style.display = 'none';
        // For images, use the media URL as thumbnail too
        document.getElementById('replizPostThumb').value = data.url;
    }
}

function rzCaptureThumbnail() {
    var video = document.getElementById('rzVideoPreview');
    if (!video.videoWidth) { alert('Video not loaded yet'); return; }

    var canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    var ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    var dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    document.getElementById('rzThumbPreview').src = dataUrl;
    document.getElementById('rzThumbStatus').textContent = 'Uploading thumbnail...';

    // Upload thumbnail to server
    fetch('/repliz-upload-thumb', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: dataUrl })
    })
        .then(function (r) { return r.json(); })
        .then(function (data) {
            document.getElementById('replizPostThumb').value = data.url;
            var time = Math.round(video.currentTime * 10) / 10;
            document.getElementById('rzThumbStatus').textContent = 'Captured at ' + time + 's — ' + data.filename;
        })
        .catch(function () {
            document.getElementById('rzThumbStatus').textContent = 'Upload failed, captured locally';
        });
}

function rzRemoveMedia() {
    document.getElementById('rzUploadZone').style.display = '';
    document.getElementById('rzMediaPreview').classList.add('hidden');
    document.getElementById('replizPostMedia').value = '';
    document.getElementById('replizPostThumb').value = '';
    document.getElementById('rzFileInput').value = '';
    var video = document.getElementById('rzVideoPreview');
    if (video.src) { URL.revokeObjectURL(video.src); video.src = ''; }
    var img = document.getElementById('rzImagePreview');
    if (img.src) { URL.revokeObjectURL(img.src); img.src = ''; }
    document.getElementById('rzThumbSection').style.display = 'none';
}

// Capture thumbnail from a File object using an off-screen video + canvas
// Returns a Promise that resolves with the public thumb URL (or null on failure)
function rzCaptureThumbFromFile(file) {
    return new Promise(function (resolve) {
        if (!file.type.startsWith('video/')) { resolve(null); return; }

        var video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        var objectUrl = URL.createObjectURL(file);
        video.src = objectUrl;

        video.onloadeddata = function () {
            video.currentTime = Math.min(1, video.duration * 0.1);
        };

        video.onseeked = function () {
            try {
                var canvas = document.createElement('canvas');
                canvas.width = video.videoWidth || 640;
                canvas.height = video.videoHeight || 360;
                canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
                var dataUrl = canvas.toDataURL('image/jpeg', 0.85);
                URL.revokeObjectURL(objectUrl);

                // Upload to server
                fetch('/repliz-upload-thumb', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ data: dataUrl })
                })
                    .then(function (r) { return r.json(); })
                    .then(function (data) { resolve(data.url || null); })
                    .catch(function () { resolve(null); });
            } catch (e) {
                URL.revokeObjectURL(objectUrl);
                resolve(null);
            }
        };

        video.onerror = function () {
            URL.revokeObjectURL(objectUrl);
            resolve(null);
        };

        // Timeout fallback — 15 seconds
        setTimeout(function () {
            URL.revokeObjectURL(objectUrl);
            resolve(null);
        }, 15000);
    });
}

// Drag & drop
(function () {
    var zone = document.getElementById('rzUploadZone');
    if (!zone) return;
    zone.addEventListener('dragover', function (e) { e.preventDefault(); zone.classList.add('dragover'); });
    zone.addEventListener('dragleave', function () { zone.classList.remove('dragover'); });
    zone.addEventListener('drop', function (e) {
        e.preventDefault(); zone.classList.remove('dragover');
        if (e.dataTransfer.files.length) rzUploadFile(e.dataTransfer.files[0]);
    });
})();

consumeTableShareDraftToRepliz();
consumeTableShareDraftToZernio();
