const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const archiver = require('archiver');
const { google } = require('googleapis');
const { runCommand, runYtdlp, fetchJSON, formatTime, parseVTT, parseVTTPrecise, getVideoDimensions, getVideoInfo, sanitizeCrop, FFMPEG_PATH, BIN_DIR, COOKIES_PATH, PYTHON_CMD, PYTHON_ARGS, IS_WIN } = require('../lib/utils');
const { detectFacesInClip, computeCropPosition, computeFaceCrop, isFaceDetectionReady } = require('../lib/face-detection');
const FACE_CROP_VIDEO_SCRIPT = path.join(__dirname, '..', 'lib', 'face_crop_video.py');
const BRAND_WATERMARK_PATH = path.join(__dirname, '..', 'brand.png');
const CUT_WORKERS = Math.max(1, parseInt(process.env.CUT_WORKERS || '3', 10));
const USE_FAST_COPY_CUT = process.env.USE_FAST_COPY_CUT !== 'false';
const CONVERT_WORKERS = Math.max(1, parseInt(process.env.CONVERT_WORKERS || '3', 10));
const USE_QSV_ENCODE = IS_WIN && process.env.USE_QSV_ENCODE !== 'false';

const DOWNLOADS_DIR = path.join(__dirname, '..', 'downloads');
const OUTPUT_DIR = path.join(__dirname, '..', 'output');
const HISTORY_DIR = path.join(__dirname, '..', 'history');
const PORT = parseInt(process.env.PORT || '3000', 10);
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');

// YouTube API paths
const CLIENT_SECRET_PATH = path.join(__dirname, '..', 'client_secret.json');
const TOKEN_PATH = path.join(__dirname, '..', 'token.json');
const YOUTUBE_SCOPES = ['https://www.googleapis.com/auth/youtube.readonly'];

fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.mkdirSync(HISTORY_DIR, { recursive: true });

// SSE and job storage
const sseClients = new Map();
const jobResults = new Map();
const jobProgressHistory = new Map();
const MAX_PROGRESS_HISTORY = 500;
const convertArtifacts = new Map();

function makeConvertArtifactKey(jobId, mode, ratio, clipIndex = '', selectedIndices = []) {
    const sel = Array.isArray(selectedIndices) ? selectedIndices.map(x => String(x)).sort().join(',') : '';
    return [jobId || '', mode || '', ratio || '', String(clipIndex ?? ''), sel].join('::');
}
const convertJobHistory = new Map();
const convertJobResults = new Map();

function getJobData(jobId) {
    const inMemory = jobResults.get(jobId);
    if (inMemory) return inMemory;
    try {
        const historyPath = path.join(HISTORY_DIR, jobId + '.json');
        if (fs.existsSync(historyPath)) {
            const historyEntry = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
            return { results: historyEntry.results || [], videoTitle: historyEntry.videoTitle || 'history' };
        }
    } catch (e) { }
    return null;
}

function sendProgress(jobId, data) {
    const entry = {
        ...data,
        _ts: Date.now()
    };
    const history = jobProgressHistory.get(jobId) || [];
    history.push(entry);
    if (history.length > MAX_PROGRESS_HISTORY) history.splice(0, history.length - MAX_PROGRESS_HISTORY);
    jobProgressHistory.set(jobId, history);

    const clients = sseClients.get(jobId) || [];
    clients.forEach(res => {
        try {
            res.write(`data: ${JSON.stringify(entry)}\n\n`);
            if (typeof res.flush === 'function') res.flush();
        } catch (e) {
            // Client gone — will be cleaned up via req.on('close')
        }
    });
}

function sendConvertStage(jobId, message, extra = {}) {
    if (!jobId) return;
    sendProgress(jobId, { step: 'convert_stage', message, ...extra });
}

function logConvertStage(jobId, message, extra = {}) {
    console.log(message);
    sendConvertStage(jobId, message, extra);
}

function pushConvertJobEvent(convertJobId, data) {
    if (!convertJobId) return;
    const entry = { ...data, _ts: Date.now() };
    const history = convertJobHistory.get(convertJobId) || [];
    history.push(entry);
    if (history.length > MAX_PROGRESS_HISTORY) history.splice(0, history.length - MAX_PROGRESS_HISTORY);
    convertJobHistory.set(convertJobId, history);
    convertJobResults.set(convertJobId, {
        ...(convertJobResults.get(convertJobId) || {}),
        lastEvent: entry
    });
}

function markConvertJobDone(convertJobId, payload) {
    convertJobResults.set(convertJobId, {
        ...(convertJobResults.get(convertJobId) || {}),
        status: 'done',
        ...payload
    });
    pushConvertJobEvent(convertJobId, { step: 'done', message: payload && payload.message ? payload.message : '✅ Convert selesai' });
}

function markConvertJobError(convertJobId, error) {
    const message = error && error.message ? error.message : String(error || 'Unknown error');
    convertJobResults.set(convertJobId, {
        ...(convertJobResults.get(convertJobId) || {}),
        status: 'error',
        error: message
    });
    pushConvertJobEvent(convertJobId, { step: 'error', message: `❌ Convert failed: ${message}`, error: message });
}

function normalizeEndExtendSeconds(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return 0;
    return Math.max(0, Math.min(90, Math.round(num * 2) / 2));
}

async function prepareClipSource(jobId, clip, endExtendSeconds, workDir) {
    const clipStartTime = Number(clip.start_time || 0);
    const clipEndTime = Math.max(clipStartTime, Number(clip.end_time || clipStartTime + Number(clip.duration || 0)));
    const baseDuration = Math.max(0.1, clipEndTime - clipStartTime);
    const extraSeconds = normalizeEndExtendSeconds(endExtendSeconds);
    const defaultVideoPath = path.join(OUTPUT_DIR, clip.filename);

    if (extraSeconds <= 0) {
        return { videoPath: defaultVideoPath, clipStartTime, clipEndTime, duration: baseDuration, extraSeconds: 0 };
    }

    const sourceVideoPath = path.join(DOWNLOADS_DIR, jobId, 'video.mp4');
    if (!fs.existsSync(sourceVideoPath)) {
        throw new Error('Sumber video asli sudah tidak tersedia untuk tambah akhir. Jalankan analyze ulang lalu coba lagi.');
    }

    const sourceInfo = await getVideoInfo(sourceVideoPath);
    const sourceDuration = Number(sourceInfo.duration || 0);
    const effectiveEndTime = sourceDuration > 0
        ? Math.min(sourceDuration, clipEndTime + extraSeconds)
        : (clipEndTime + extraSeconds);
    const effectiveDuration = Math.max(0.1, effectiveEndTime - clipStartTime);

    if (effectiveDuration <= baseDuration + 0.001) {
        return { videoPath: defaultVideoPath, clipStartTime, clipEndTime, duration: baseDuration, extraSeconds: 0 };
    }

    const parsed = path.parse(clip.filename || 'clip.mp4');
    const extendedPath = path.join(workDir, `${parsed.name}_extend_${String(extraSeconds).replace('.', '_')}s${parsed.ext || '.mp4'}`);
    await cutClipWithFallback(sourceVideoPath, extendedPath, clipStartTime, effectiveDuration, workDir);
    return { videoPath: extendedPath, clipStartTime, clipEndTime: effectiveEndTime, duration: effectiveDuration, extraSeconds };
}

async function cutClipWithFallback(videoPath, outputPath, startTime, duration, cwd) {
    const fastArgs = ['-y', '-ss', String(startTime), '-t', String(duration), '-i', videoPath, '-c', 'copy', '-movflags', '+faststart', '-avoid_negative_ts', 'make_zero', outputPath];
    const reencodeArgs = ['-y', '-ss', String(startTime), '-t', String(duration), '-i', videoPath, '-c:v', 'libx264', '-profile:v', 'high', '-level', '4.1', '-pix_fmt', 'yuv420p', '-preset', 'fast', '-crf', '20', '-c:a', 'aac', '-b:a', '192k', '-ar', '44100', '-movflags', '+faststart', '-avoid_negative_ts', 'make_zero', outputPath];
    if (USE_FAST_COPY_CUT) {
        try {
            await runCommand(FFMPEG_PATH, fastArgs, cwd);
            return 'copy';
        } catch (err) {
            await runCommandWithGpuFallback(reencodeArgs, cwd, 'cut-reencode');
            return 'reencode_fallback';
        }
    }
    await runCommandWithGpuFallback(reencodeArgs, cwd, 'cut-reencode');
    return 'reencode';
}

function toQsvArgs(args) {
    const src = Array.isArray(args) ? args.slice() : [];
    let replaced = false;
    const out = [];
    for (let i = 0; i < src.length; i++) {
        const t = src[i];
        if (t === '-c:v' && src[i + 1] === 'libx264') {
            out.push('-c:v', 'h264_qsv', '-global_quality', '23', '-look_ahead', '0');
            i += 1;
            replaced = true;
            continue;
        }
        if (t === '-preset' || t === '-crf' || t === '-profile:v' || t === '-level' || t === '-pix_fmt') {
            i += 1;
            continue;
        }
        out.push(t);
    }
    if (!replaced) return null;
    if (out.length > 1) out.splice(out.length - 1, 0, '-pix_fmt', 'nv12');
    return out;
}

async function runCommandWithGpuFallback(args, cwd, label = 'encode') {
    if (!USE_QSV_ENCODE) return runCommand(FFMPEG_PATH, args, cwd);
    const qsvArgs = toQsvArgs(args);
    if (!qsvArgs) return runCommand(FFMPEG_PATH, args, cwd);
    try {
        console.log(`⚡ QSV encode attempt: ${label}`);
        await runCommand(FFMPEG_PATH, qsvArgs, cwd);
    } catch (e) {
        console.log(`⚠️ QSV failed (${label}), fallback libx264`);
        await runCommand(FFMPEG_PATH, args, cwd);
    }
}

async function runWithConcurrency(items, workerCount, workerFn) {
    const queue = items.slice();
    const workers = Array.from({ length: Math.min(workerCount, queue.length) }, async () => {
        while (queue.length > 0) {
            const item = queue.shift();
            if (!item) break;
            await workerFn(item);
        }
    });
    await Promise.all(workers);
}

function backupCookiesState() {
    return fs.existsSync(COOKIES_PATH) ? fs.readFileSync(COOKIES_PATH, 'utf-8') : null;
}

function restoreCookiesState(original) {
    if (original == null) {
        try { if (fs.existsSync(COOKIES_PATH)) fs.unlinkSync(COOKIES_PATH); } catch (e) { }
        return;
    }
    fs.writeFileSync(COOKIES_PATH, original, 'utf-8');
}

function stripCodeFences(text) {
    if (!text) return '';
    return String(text)
        .replace(/```json\s*/gi, '')
        .replace(/```\s*/g, '')
        .trim();
}

function extractBalancedJSONArray(text) {
    const src = String(text || '');
    let start = -1;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '[') {
            if (start === -1) start = i;
            depth++;
        } else if (ch === ']') {
            if (depth > 0) depth--;
            if (start !== -1 && depth === 0) return src.slice(start, i + 1);
        }
    }
    return null;
}

function extractBalancedJSONObject(text) {
    const src = String(text || '');
    let start = -1;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') {
            if (start === -1) start = i;
            depth++;
        } else if (ch === '}') {
            if (depth > 0) depth--;
            if (start !== -1 && depth === 0) return src.slice(start, i + 1);
        }
    }
    return null;
}

function repairJsonLikeArray(text) {
    return String(text || '')
        .replace(/[“”]/g, '"')
        .replace(/[‘’]/g, "'")
        .replace(/,\s*([}\]])/g, '$1')
        .replace(/[\u0000-\u0019]+/g, ' ')
        .trim();
}

function parseClipsFromAIResponse(aiContent) {
    const raw = String(aiContent || '').trim();
    if (!raw) throw new Error('AI response kosong');

    const normalized = stripCodeFences(raw);
    const attempts = [];
    const seen = new Set();
    const pushAttempt = (value) => {
        const candidate = String(value || '').trim();
        if (!candidate || seen.has(candidate)) return;
        seen.add(candidate);
        attempts.push(candidate);
    };

    pushAttempt(raw);
    pushAttempt(normalized);

    const arrayExtracted = extractBalancedJSONArray(normalized);
    if (arrayExtracted) {
        pushAttempt(arrayExtracted);
        pushAttempt(repairJsonLikeArray(arrayExtracted));
    }

    const objectExtracted = extractBalancedJSONObject(normalized);
    if (objectExtracted) {
        pushAttempt(objectExtracted);
        pushAttempt(repairJsonLikeArray(objectExtracted));
    }

    const firstBracket = normalized.search(/[\[{]/);
    if (firstBracket >= 0) {
        const tail = normalized.slice(firstBracket);
        pushAttempt(tail);
        pushAttempt(repairJsonLikeArray(tail));
    }

    for (const candidate of attempts) {
        try {
            const parsed = JSON.parse(candidate);
            if (Array.isArray(parsed)) return parsed;
            if (parsed && typeof parsed === 'object') {
                if (Array.isArray(parsed.clips)) return parsed.clips;
                if (Array.isArray(parsed.data)) return parsed.data;
                if (Array.isArray(parsed.results)) return parsed.results;
                if (Array.isArray(parsed.segments)) return parsed.segments;
                if (Array.isArray(parsed.items)) return parsed.items;
            }
        } catch (e) { }
    }

    throw new Error(`Gagal parse AI response: ${raw.slice(0, 240)}`);
}

function buildClipsFromMetadata(videoInfo, videoDuration, minDur, maxDur, numClips, analysisStartOffset = 0) {
    const chapters = Array.isArray(videoInfo?.chapters) ? videoInfo.chapters.filter(ch => ch && Number.isFinite(Number(ch.start_time))) : [];
    const usable = chapters
        .map((ch, idx) => {
            const start = Math.max(analysisStartOffset, Number(ch.start_time || 0));
            const nextStart = idx + 1 < chapters.length ? Number(chapters[idx + 1].start_time || videoDuration) : videoDuration;
            const naturalEnd = Math.min(videoDuration, nextStart > start ? nextStart : start + maxDur);
            const end = Math.min(videoDuration, Math.max(start + minDur, Math.min(start + maxDur, naturalEnd)));
            return {
                start_time: Math.round(start * 100) / 100,
                end_time: Math.round(end * 100) / 100,
                hook_title: String(ch.title || `Clip ${idx + 1}`).trim(),
                topic: String(ch.title || `Topik ${idx + 1}`).trim(),
                caption: String(videoInfo?.description || '').trim().split(/\r?\n/).filter(Boolean).slice(0, 2).join(' '),
                reason: 'Clip dibuat dari metadata chapter karena transcript tidak tersedia.',
                type: 'story',
                evidence: [String(ch.title || '').trim()].filter(Boolean)
            };
        })
        .filter(clip => clip.end_time > clip.start_time && (clip.end_time - clip.start_time) >= Math.min(10, minDur));

    return usable.slice(0, numClips);
}

function dedupeAndSpreadClips(clips, minGapSeconds = 8) {
    const kept = [];
    for (const clip of clips) {
        const start = Number(clip.start_time || 0);
        const end = Number(clip.end_time || 0);
        const duration = Math.max(0, end - start);
        let duplicate = false;
        for (const prev of kept) {
            const pStart = Number(prev.start_time || 0);
            const pEnd = Number(prev.end_time || 0);
            const overlap = Math.max(0, Math.min(end, pEnd) - Math.max(start, pStart));
            const minDur = Math.max(0.001, Math.min(duration, pEnd - pStart));
            const overlapRatio = overlap / minDur;
            const contained = start >= pStart && end <= pEnd;
            const nearSameStart = Math.abs(start - pStart) < minGapSeconds;
            if (contained || overlapRatio >= 0.7 || nearSameStart) {
                duplicate = true;
                break;
            }
        }
        if (!duplicate) kept.push(clip);
    }
    return kept;
}

function looksLikeIntroText(text) {
    const s = String(text || '').toLowerCase();
    const introHints = [
        'halo teman', 'balik lagi', 'welcome back', 'selamat datang', 'di channel',
        'jangan lupa', 'subscribe', 'like dan subscribe', 'intro', 'opening',
        'di video kali ini', 'jadi hari ini kita', 'langsung aja', 'sebelum mulai',
        'cuplikan', 'sekilas', 'teaser', 'coming up'
    ];
    return introHints.some(h => s.includes(h));
}

function filterIntroishClips(clips, timestamps, minDur) {
    return clips.filter((clip) => {
        const start = Number(clip.start_time || 0);
        const early = start < Math.max(20, minDur * 0.6);
        if (!early) return true;
        const nearby = timestamps.filter(t => Math.abs(Number(t.time || 0) - start) <= 6).map(t => t.text || '').join(' ');
        if (!nearby) return true;
        return !looksLikeIntroText(nearby);
    });
}

function normalizeClipType(rawType, clip = {}) {
    const category = String(clip.category || '').trim().toLowerCase();
    if (category === 'pure comedy') return 'funny';
    if (category === 'sudden depth') return 'insight';
    if (category === 'relatable moment') return 'moment';
    const normalized = String(rawType || '').trim().toLowerCase();
    const topicText = [clip.topic, clip.hook_title, clip.reason, clip.category].filter(Boolean).join(' ').toLowerCase();


    if (['funny', 'humor', 'humour', 'joke', 'comedy', 'lucu', 'ngakak'].includes(normalized)) return 'funny';
    if (['fact', 'facts', 'fakta', 'info', 'informative', 'edukasi', 'education'].includes(normalized)) return 'fact';
    if (['story', 'cerita', 'storytelling', 'narative', 'narrative'].includes(normalized)) return 'story';
    if (['moment', 'momen', 'highlight', 'payoff', 'reveal', 'climax'].includes(normalized)) return 'moment';
    if (['insight', 'lesson', 'opinion', 'mindset', 'tip', 'tips'].includes(normalized)) return 'insight';
    if (['drama', 'conflict', 'konflik', 'argument', 'chaos'].includes(normalized)) return 'drama';

    if (/(lucu|ngakak|joke|becanda|kocak|humor)/.test(topicText)) return 'funny';
    if (/(fakta|ternyata|menurut|data|angka|bukti|rahasia|penjelasan)/.test(topicText)) return 'fact';
    if (/(cerita|kisah|pengalaman|awal mula|dulu|waktu itu|perjalanan)/.test(topicText)) return 'story';
    if (/(momen|kejadian|detik|reveal|akhirnya|langsung|punchline|twist)/.test(topicText)) return 'moment';
    if (/(pelajaran|insight|tips|mindset|cara|strategi)/.test(topicText)) return 'insight';
    if (/(drama|konflik|ribut|marah|debat|masalah)/.test(topicText)) return 'drama';

    return normalized || 'viral';
}

function diversifyClipsByType(clips, targetCount) {
    if (!Array.isArray(clips) || clips.length <= 1) return clips;

    const preferredTypes = ['funny', 'fact', 'story', 'moment', 'insight', 'drama'];
    const ranked = clips.map((clip, index) => ({ ...clip, _rank: index }));
    const buckets = new Map();
    const leftovers = [];

    for (const clip of ranked) {
        const key = preferredTypes.includes(clip.type) ? clip.type : 'other';
        if (key === 'other') {
            leftovers.push(clip);
            continue;
        }
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(clip);
    }

    const selected = [];
    const used = new Set();
    for (const type of preferredTypes) {
        const bucket = buckets.get(type);
        if (!bucket || bucket.length === 0) continue;
        const clip = bucket.shift();
        selected.push(clip);
        used.add(clip._rank);
        if (selected.length >= targetCount) break;
    }

    while (selected.length < targetCount) {
        let picked = false;
        for (const type of preferredTypes) {
            const bucket = buckets.get(type);
            if (!bucket || bucket.length === 0) continue;
            const clip = bucket.shift();
            if (used.has(clip._rank)) continue;
            selected.push(clip);
            used.add(clip._rank);
            picked = true;
            if (selected.length >= targetCount) break;
        }
        if (!picked) break;
    }

    for (const clip of [...ranked, ...leftovers]) {
        if (selected.length >= targetCount) break;
        if (used.has(clip._rank)) continue;
        selected.push(clip);
        used.add(clip._rank);
    }

    return selected.sort((a, b) => a._rank - b._rank).slice(0, targetCount).map(({ _rank, ...clip }) => clip);
}

function normalizeEvidenceList(rawEvidence) {
    if (Array.isArray(rawEvidence)) return rawEvidence.map((item) => String(item || '').trim()).filter(Boolean);
    if (typeof rawEvidence === 'string' && rawEvidence.trim()) return rawEvidence.split(/\n|\s*;\s*/).map((item) => item.trim()).filter(Boolean);
    return [];
}

function tokenizeEvidenceText(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/gi, ' ')
        .split(/\s+/)
        .filter((word) => word.length >= 3);
}

function scoreClipEvidence(clip, timestamps) {
    const evidence = normalizeEvidenceList(clip.evidence);
    const start = Number(clip.start_time || 0);
    const end = Number(clip.end_time || 0);
    const localText = (timestamps || [])
        .filter((t) => Number(t.time || 0) >= start - 2 && Number(t.time || 0) <= end + 2)
        .map((t) => String(t.text || '').toLowerCase())
        .join(' ');

    let score = 0;
    if (String(clip.topic || '').trim().length >= 8) score += 1;
    if (String(clip.reason || '').trim().length >= 40) score += 1;
    if (evidence.length >= 2) score += 2;
    else if (evidence.length === 1) score += 1;
    else score -= 2;

    let matchedEvidence = 0;
    for (const item of evidence) {
        const tokens = [...new Set(tokenizeEvidenceText(item))].slice(0, 8);
        if (tokens.length === 0) continue;
        const hitCount = tokens.filter((token) => localText.includes(token)).length;
        if (hitCount / tokens.length >= 0.35) matchedEvidence += 1;
    }

    if (evidence.length > 0) {
        const evidenceRatio = matchedEvidence / evidence.length;
        if (evidenceRatio >= 0.8) score += 4;
        else if (evidenceRatio >= 0.5) score += 2;
        else if (evidenceRatio > 0) score += 0;
        else score -= 3;
    }

    if (localText.length < 30) score -= 1;

    let quality = 'low';
    if (score >= 6) quality = 'high';
    else if (score >= 3) quality = 'medium';

    return {
        score,
        quality,
        matchedEvidence,
        evidenceCount: evidence.length,
        evidence
    };
}

function rankClipsByEvidence(clips, timestamps) {
    if (!Array.isArray(clips) || clips.length <= 1) return clips;
    return clips
        .map((clip, index) => {
            const evidenceMeta = scoreClipEvidence(clip, timestamps);
            return { ...clip, evidence_score: evidenceMeta.score, evidence_quality: evidenceMeta.quality, evidence_matches: evidenceMeta.matchedEvidence, evidence_count: evidenceMeta.evidenceCount, evidence: evidenceMeta.evidence, _rank: index };
        })
        .sort((a, b) => {
            if (b.evidence_score !== a.evidence_score) return b.evidence_score - a.evidence_score;
            return a._rank - b._rank;
        })
        .map(({ _rank, ...clip }) => clip);
}

function normalizeTranscriptText(text) {
    return String(text || '')
        .replace(/\[[^\]]+\]/g, ' ')
        .replace(/[#*_`]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function getClipTimestampEntries(timestamps, start, end, padSeconds = 0) {
    return (timestamps || []).filter((t) => Number(t.time || 0) >= start - padSeconds && Number(t.time || 0) <= end + padSeconds);
}

function compactWords(text, maxWords = 8, maxLen = 72) {
    const cleaned = normalizeTranscriptText(text);
    if (!cleaned) return '';
    const limited = cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned;
    return limited.split(/\s+/).filter(Boolean).slice(0, maxWords).join(' ');
}

function splitTranscriptSentences(text) {
    return normalizeTranscriptText(text)
        .split(/(?<=[.!?])\s+|\s*,\s*/)
        .map((item) => item.trim())
        .filter((item) => item.length >= 12);
}

function getClipTranscriptText(timestamps, start, end, padSeconds = 2) {
    return normalizeTranscriptText((timestamps || [])
        .filter((t) => Number(t.time || 0) >= start - padSeconds && Number(t.time || 0) <= end + padSeconds)
        .map((t) => t.text || '')
        .join(' '));
}

function compactTranscriptPhrase(text, maxLen = 88) {
    const cleaned = normalizeTranscriptText(text)
        .replace(/^(topik|caption|judul|hook)\s*[:\-]\s*/i, '')
        .replace(/^[-•]\s*/, '')
        .trim();
    if (!cleaned) return '';
    if (cleaned.length <= maxLen) return cleaned;
    const sliced = cleaned.slice(0, maxLen);
    const lastSpace = sliced.lastIndexOf(' ');
    return (lastSpace > 24 ? sliced.slice(0, lastSpace) : sliced).trim() + '...';
}

function normalizeLooseTokens(text) {
    return normalizeTranscriptText(text)
        .toLowerCase()
        .replace(/[^a-z0-9\s]/gi, ' ')
        .split(/\s+/)
        .filter((word) => word.length >= 3);
}

function stripFillerEdges(text) {
    const fillers = new Set([
        'jadi', 'nah', 'oke', 'ok', 'eh', 'em', 'emm', 'anu', 'apa', 'kayak', 'kaya',
        'gitu', 'gini', 'tuh', 'nih', 'sih', 'dong', 'deh', 'lah', 'kan', 'ya',
        'pokoknya', 'intinya', 'sebenernya', 'sebenarnya', 'benernya', 'jujur',
        'gue', 'gua'  // only trimmed at edges
    ]);
    const parts = String(text || '').split(/\s+/).filter(Boolean);
    function norm(word) {
        return String(word || '').toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, '');
    }
    while (parts.length && fillers.has(norm(parts[0]))) parts.shift();
    while (parts.length && fillers.has(norm(parts[parts.length - 1]))) parts.pop();
    return parts.join(' ').trim();
}

function isTextSupportedByClipTranscript(candidate, localText, evidenceList) {
    const cand = normalizeTranscriptText(candidate);
    if (!cand) return false;
    const local = String(localText || '').toLowerCase();
    const evidenceBlob = (evidenceList || []).map((t) => String(t || '')).join(' ').toLowerCase();

    const tokens = [...new Set(normalizeLooseTokens(cand))].slice(0, 10);
    if (tokens.length === 0) return true;
    const haystack = (local + ' ' + evidenceBlob).toLowerCase();
    const hits = tokens.filter((token) => haystack.includes(token)).length;

    if (tokens.length >= 5) return hits / tokens.length >= 0.45;
    return hits >= Math.max(2, Math.ceil(tokens.length * 0.6));
}

function scoreHookCandidate(text, clip = {}) {
    const s = normalizeTranscriptText(text);
    if (!s) return -999;

    const len = s.length;
    let score = 0;

    if (len >= 16 && len <= 70) score += 6;
    else if (len >= 10 && len <= 90) score += 3;
    else score -= 2;

    const lower = s.toLowerCase();
    const hasQuestion = lower.includes('?');
    const hasNegation = /(jangan|nggak|gak|ga|bukan|kok|ternyata)/.test(lower);
    const hasPunch = /(anjir|gila|parah|buset|serius|astaga|waduh)/.test(lower);
    const hasRelate = /(gue|gua|aku|kita|lu|kamu|orang-orang|semua orang)/.test(lower);

    if (hasQuestion) score += 2;
    if (hasNegation) score += 2;
    if (hasPunch) score += 2;
    if (hasRelate) score += 1;
    if (/\d/.test(lower)) score += 1;

    const category = String(clip.category || '').toLowerCase();
    if (category === 'pure comedy' && /(ketawa|lucu|ngakak|becanda|kocak)/.test(lower)) score += 3;
    if (category === 'sudden depth' && /(serius|jujur|capek|mental|hidup|takut|trauma|sedih)/.test(lower)) score += 3;
    if (category === 'relatable moment' && /(pernah|pasti|biasanya|sering|kayak gini|gini doang)/.test(lower)) score += 3;

    return score;
}

function formatHookText(text) {
    const cleaned = stripFillerEdges(compactTranscriptPhrase(text, 80));
    if (!cleaned) return '';
    if (cleaned.length <= 54) return cleaned.toUpperCase();
    return cleaned;
}

function pickBestTranscriptLineForHook(clip, timestamps) {
    const localText = getClipTranscriptText(timestamps, clip.start_time, clip.end_time, 1.5);
    const evidence = normalizeEvidenceList(clip.evidence).map((t) => compactTranscriptPhrase(t, 96)).filter(Boolean);
    const sentences = splitTranscriptSentences(localText).map((t) => compactTranscriptPhrase(t, 96)).filter(Boolean);

    const rawCandidates = [
        ...evidence,
        ...sentences,
        clip.topic,
        clip.hook_title,
        localText
    ];

    const seen = new Set();
    const candidates = [];
    for (const item of rawCandidates) {
        const cleaned = stripFillerEdges(compactTranscriptPhrase(item, 96));
        const key = cleaned.toLowerCase();
        if (!cleaned || seen.has(key)) continue;
        seen.add(key);
        if (cleaned.length < 10) continue;
        candidates.push(cleaned);
    }

    const supported = candidates.filter((c) => isTextSupportedByClipTranscript(c, localText, evidence));
    const pool = supported.length > 0 ? supported : candidates;
    if (pool.length === 0) return '';

    pool.sort((a, b) => scoreHookCandidate(b, clip) - scoreHookCandidate(a, clip));
    return pool[0];
}

function buildTopicDrivenHookTitle(clip, timestamps) {
    const localText = getClipTranscriptText(timestamps, clip.start_time, clip.end_time, 1.5);
    const evidence = normalizeEvidenceList(clip.evidence).map((t) => compactTranscriptPhrase(t, 96)).filter(Boolean);
    const topic = compactWords(stripFillerEdges(String(clip.topic || '')), 8, 60);
    const bestLine = pickBestTranscriptLineForHook(clip, timestamps);
    const category = String(clip.category || '').toLowerCase();

    const sourceLine = stripFillerEdges(compactTranscriptPhrase(bestLine || evidence[0] || localText, 88));
    const fragments = splitTranscriptSentences(sourceLine);
    const lead = compactWords(fragments[0] || sourceLine, 7, 54);

    const templates = [];
    if (topic) {
        if (category === 'pure comedy') {
            templates.push(`${topic} yang bikin ngakak`);
            templates.push(`${topic}, punchline-nya kena`);
        } else if (category === 'sudden depth') {
            templates.push(`${topic} yang malah nusuk`);
            templates.push(`${topic}, ending-nya serius`);
        } else if (category === 'relatable moment') {
            templates.push(`${topic} yang relate banget`);
            templates.push(`${topic}, kok bisa sama?`);
        } else {
            templates.push(`${topic} yang bikin mikir`);
            templates.push(`${topic}, kenapa bisa gini?`);
        }
    }
    if (lead && topic) templates.push(`${topic}: ${lead}`);
    if (lead) templates.push(lead);
    if (bestLine && topic && normalizeTranscriptText(bestLine).toLowerCase() !== normalizeTranscriptText(topic).toLowerCase()) {
        templates.push(`${topic}: ${compactWords(bestLine, 7, 52)}`);
    }

    const seen = new Set();
    const candidates = [];
    for (const item of templates) {
        const cleaned = stripFillerEdges(compactTranscriptPhrase(item, 72));
        const key = cleaned.toLowerCase();
        if (!cleaned || seen.has(key)) continue;
        seen.add(key);
        candidates.push(cleaned);
    }

    candidates.sort((a, b) => scoreHookCandidate(b, clip) - scoreHookCandidate(a, clip));
    return candidates[0] || '';
}

function buildGroundedHookTitle(clip, timestamps) {
    const localText = getClipTranscriptText(timestamps, clip.start_time, clip.end_time, 1.5);
    const evidence = normalizeEvidenceList(clip.evidence).map((t) => compactTranscriptPhrase(t, 120)).filter(Boolean);

    const raw = stripFillerEdges(String(clip.hook_title || ''));
    const candidate = compactTranscriptPhrase(raw, 80);
    const candidateLooksLiteral = candidate && localText && normalizeTranscriptText(localText).toLowerCase().includes(normalizeTranscriptText(candidate).toLowerCase());

    if (candidate && !candidateLooksLiteral && isTextSupportedByClipTranscript(candidate, localText, evidence)) {
        return formatHookText(candidate);
    }

    const topicDriven = buildTopicDrivenHookTitle(clip, timestamps);
    if (topicDriven) return formatHookText(topicDriven);

    const fallback = compactWords(clip.topic || candidate || localText, 8, 72);
    return formatHookText(fallback) || `Clip ${clip.clip_number || ''}`.trim();
}

function buildCaptionCtaLine(clip) {
    const category = String(clip.category || '').toLowerCase();
    if (category === 'pure comedy') return 'Yang ketawa ngaku. Komen bagian paling lucu versi kamu.';
    if (category === 'sudden depth') return 'Kena nggak? Komen satu kalimat yang paling nyangkut.';
    if (category === 'relatable moment') return 'Relate nggak? Cerita versi kamu di komen.';
    return 'Setuju nggak? Tulis pendapat kamu di komen.';
}

function buildGroundedCaption(clip, timestamps) {
    const localText = getClipTranscriptText(timestamps, clip.start_time, clip.end_time, 1.5);
    const evidence = normalizeEvidenceList(clip.evidence).map((t) => compactTranscriptPhrase(t, 160)).filter(Boolean);

    const raw = String(clip.caption || '').replace(/\r/g, '').trim();
    const rawLines = raw.split(/\n+/).map((l) => l.trim()).filter(Boolean);

    function stripHashtags(line) {
        return String(line || '').replace(/#\w+/g, '').replace(/\s+/g, ' ').trim();
    }

    function looksLikeCta(line) {
        const s = String(line || '').toLowerCase();
        return /(komen|comment|tulis|cerita|relate|setuju|follow|share|tag|drop)/.test(s);
    }

    if (rawLines.length > 0) {
        const kept = [];
        for (const line of rawLines) {
            if (!line) continue;
            kept.push(line);
            if (kept.length >= 4) break;
        }

        const contentLine = kept.map(stripHashtags).find((l) => l && !looksLikeCta(l)) || '';

        if (!contentLine || isTextSupportedByClipTranscript(contentLine, localText, evidence)) {
            return kept.join('\n');
        }
    }

    // Fallback (still grounded): use evidence + a light CTA
    const lines = [];
    evidence.slice(0, 2).forEach((item) => {
        const cleaned = stripFillerEdges(compactTranscriptPhrase(item, 140));
        if (cleaned) lines.push(cleaned);
    });
    if (lines.length === 0) {
        const sentence = stripFillerEdges(compactTranscriptPhrase(localText.split(/(?<=[.!?])\s+/)[0] || localText, 140));
        if (sentence) lines.push(sentence);
    }
    lines.push(buildCaptionCtaLine(clip));
    return lines.filter(Boolean).slice(0, 3).join('\n');
}

function extractClipKeywords(clip) {
    const stopWords = new Set(['yang', 'untuk', 'dengan', 'karena', 'bukan', 'adalah', 'dalam', 'paling', 'sangat', 'lebih', 'atau', 'dari', 'pada', 'jadi', 'kalau', 'tetapi', 'namun', 'video', 'clip', 'topik']);
    const source = [clip.topic, clip.hook_title, clip.reason, ...normalizeEvidenceList(clip.evidence)].join(' ').toLowerCase();
    return [...new Set(source.replace(/[^a-z0-9\s]/gi, ' ').split(/\s+/).filter((word) => word.length >= 4 && !stopWords.has(word)))].slice(0, 18);
}

function countKeywordHits(text, keywords) {
    const normalized = normalizeTranscriptText(text).toLowerCase();
    if (!normalized || !keywords.length) return 0;
    return keywords.filter((keyword) => normalized.includes(keyword)).length;
}

function snapClipToTopicBounds(clip, timestamps, minDur, maxDur, videoDuration) {
    const windowEntries = getClipTimestampEntries(timestamps, clip.start_time, clip.end_time, 8);
    if (windowEntries.length === 0) return clip;
    const keywords = extractClipKeywords(clip);
    const scored = windowEntries.map((entry, index) => ({ index, time: Number(entry.time || 0), text: String(entry.text || ''), hits: countKeywordHits(entry.text || '', keywords) }));
    let matched = scored.filter((entry) => entry.hits > 0);
    if (matched.length === 0) matched = scored.filter((entry) => entry.time >= clip.start_time - 1 && entry.time <= clip.end_time + 1);
    if (matched.length === 0) matched = [scored[0]];
    let startIdx = matched[0].index;
    let endIdx = matched[matched.length - 1].index;
    if (startIdx > 0 && windowEntries[startIdx].time - windowEntries[startIdx - 1].time <= 3.5) startIdx -= 1;
    if (endIdx < windowEntries.length - 1 && windowEntries[endIdx + 1].time - windowEntries[endIdx].time <= 3.5) endIdx += 1;
    let newStart = Math.max(0, Number(windowEntries[startIdx].time || clip.start_time));
    let nextAfterEnd = windowEntries[endIdx + 1] ? Number(windowEntries[endIdx + 1].time || 0) : 0;
    let newEnd = nextAfterEnd > newStart ? nextAfterEnd : Number(windowEntries[endIdx].time || clip.end_time) + 2;
    if (newEnd - newStart < minDur) newEnd = newStart + minDur;
    if (newEnd - newStart > maxDur) newEnd = newStart + maxDur;
    if (newEnd > videoDuration) newEnd = videoDuration;
    if (newEnd <= newStart) newEnd = Math.min(videoDuration, newStart + minDur);
    return { ...clip, start_time: newStart, end_time: newEnd };
}

function buildGroundedTopic(clip, timestamps) {
    const localText = getClipTranscriptText(timestamps, clip.start_time, clip.end_time, 1.5);
    const evidence = normalizeEvidenceList(clip.evidence);
    const sentences = splitTranscriptSentences(localText);
    const candidates = [...evidence, ...sentences, clip.topic, clip.hook_title].map((item) => compactTranscriptPhrase(item, 72)).filter(Boolean);
    const best = candidates[0] || localText || clip.topic || clip.hook_title;
    return compactWords(best, 8, 72) || `Topik ${clip.clip_number || ''}`.trim();
}

async function downloadVideoPrefer1080(youtubeUrl, jobDir, videoPath) {
    const baseArgs = [
        '--merge-output-format', 'mp4',
        '--write-auto-sub', '--sub-lang', 'id', '--sub-format', 'vtt',
        '-o', videoPath,
        '--no-playlist',
        ...(fs.existsSync(BIN_DIR) ? ['--ffmpeg-location', BIN_DIR] : []),
        youtubeUrl
    ];

    // Strategy 1: strict 1080p separate video + audio, prefer h264/mp4
    // Strategy 2: strict 1080p separate video + audio, no ext filter
    // Strategy 3: strict merged 1080p only
    const strategies = [
        {
            label: 'bestvideo[height=1080]+bestaudio prefer h264',
            args: ['-f', 'bestvideo[height=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height=1080]+bestaudio/best[height=1080]', '-S', 'codec:h264,ext:mp4', ...baseArgs]
        },
        {
            label: 'bestvideo[height=1080]+bestaudio no ext filter',
            args: ['-f', 'bestvideo[height=1080]+bestaudio/best[height=1080]', '-S', 'codec:h264', ...baseArgs]
        },
        {
            label: 'best merged 1080p only',
            args: ['-f', 'best[height=1080]', '-S', 'codec:h264,ext:mp4', ...baseArgs]
        }
    ];

    // pakai cookies kalau ada untuk akses format 1080p
    const hasCookies = fs.existsSync(COOKIES_PATH);
    let lastErr = null;
    for (const strategy of strategies) {
        // coba dengan cookies dulu kalau ada, lalu tanpa cookies
        const runOpts = [
            ...(hasCookies ? [{ preferNoCookies: false }] : []),
            { preferNoCookies: true }
        ];
        for (const opts of runOpts) {
            try {
                console.log(`⬇️ yt-dlp strategy: ${strategy.label} | cookies: ${!opts.preferNoCookies && hasCookies}`);
                const result = await runYtdlp(strategy.args, jobDir, opts);
                // cek resolusi hasil download
                try {
                    const dims = await getVideoDimensions(videoPath);
                    console.log(`⬇️ Downloaded: ${dims.width}x${dims.height}`);
                    if (dims.height === 1080) {
                        console.log('✅ Got 1080p, done.');
                        return result;
                    }
                    console.log(`⚠️ Got ${dims.height}p, rejecting because only 1080p is allowed...`);
                    lastErr = new Error(`Expected 1080p but got ${dims.height}p from strategy: ${strategy.label}`);
                    try { fs.unlinkSync(videoPath); } catch {}
                    break;
                } catch (probeErr) {
                    console.log('⚠️ Could not probe resolution, rejecting download because 1080p cannot be verified.');
                    try { fs.unlinkSync(videoPath); } catch {}
                    lastErr = new Error(`Could not verify 1080p download from strategy: ${strategy.label}`);
                    break;
                }
            } catch (err) {
                lastErr = err;
                console.log(`⚠️ yt-dlp failed: ${strategy.label} | ${err.message?.slice(0, 120)}`);
            }
        }
    }

    if (fs.existsSync(videoPath)) {
        try { fs.unlinkSync(videoPath); } catch {}
    }
    throw lastErr || new Error('1080p format not available for this video');
}

async function runAnalyzeJob({ jobId, youtubeUrl, baseUrl, apiKey, model, minDuration, maxDuration, clipCount, smartCrop, cookiesText, progressPrefix = '', progressJobId, progressBase = 0, progressSpan = 100 }) {
    const jobDir = path.join(DOWNLOADS_DIR, jobId);
    fs.mkdirSync(jobDir, { recursive: true });
    const cookiesBackup = backupCookiesState();
    if (typeof cookiesText === 'string' && cookiesText.trim()) fs.writeFileSync(COOKIES_PATH, cookiesText, 'utf-8');
    const startedAt = Date.now();
    const logPrefix = (progressPrefix || '').trim() || `[job ${jobId.slice(0, 6)}]`;
    const progressTarget = progressJobId || jobId;
    const pushProgress = (data) => {
        const mapped = { ...data };
        const isForwarded = progressTarget !== jobId;
        if (isForwarded && mapped.step === 'done') {
            mapped.step = 'bulk_item_done';
            delete mapped.results;
        }
        if (isForwarded && mapped.step === 'ai_done') {
            delete mapped.clips;
        }
        if (typeof mapped.progress === 'number' && mapped.progress >= 0) {
            mapped.progress = Math.max(0, Math.min(100, Math.round(progressBase + (mapped.progress / 100) * progressSpan)));
        }
        sendProgress(progressTarget, mapped);
    };
    console.log(`${logPrefix} ▶ Analyze start: ${youtubeUrl}`);
    console.log(`${logPrefix} 🍪 Cookies: ${cookiesText && cookiesText.trim() ? 'custom per-item loaded' : (fs.existsSync(COOKIES_PATH) ? 'using existing global cookies' : 'none')}`);
    try {
        const videoId = extractVideoId(youtubeUrl);
        const analysisStartOffset = parseYouTubeStartTime(youtubeUrl);
        console.log(`${logPrefix} 📋 Stage info start`);
        pushProgress({ step: 'info', message: `${progressPrefix}📋 Getting video information...`, progress: 5 });
        let videoInfo;
        if (videoId && isYouTubeConnected()) videoInfo = await getVideoInfoViaAPI(videoId);
        if (!videoInfo) { const r = await runYtdlp(['--dump-json', '--no-playlist', youtubeUrl], jobDir, { preferNoCookies: true }); videoInfo = JSON.parse(r.stdout); }
        const videoTitle = videoInfo.title || 'video';
        const videoDuration = videoInfo.duration || 0;
        console.log(`${logPrefix} 📋 Video info ready: ${videoTitle} | ${videoDuration}s`);
        if (analysisStartOffset > 0) console.log(`${logPrefix} ⏩ Analysis start offset from URL: ${analysisStartOffset}s`);
        pushProgress({ step: 'info_done', message: `${progressPrefix}📋 Video: "${videoTitle}" (${Math.floor(videoDuration / 60)}:${String(videoDuration % 60).padStart(2, '0')})`, progress: 10, videoTitle });

        console.log(`${logPrefix} ⬇️ Stage download start`);
        pushProgress({ step: 'download', message: `${progressPrefix}⬇️ Downloading video...`, progress: 15 });
        const videoPath = path.join(jobDir, 'video.mp4');
        await downloadVideoPrefer1080(youtubeUrl, jobDir, videoPath);
        try {
            const dlDims = await getVideoDimensions(videoPath);
            console.log(`${logPrefix} ⬇️ Download resolution: ${dlDims.width}x${dlDims.height}`);
            if (dlDims.height !== 1080) {
                throw new Error(`Downloaded source is ${dlDims.height}p, expected exactly 1080p`);
            }
        } catch (e) {
            console.log(`${logPrefix} ⬇️ Download resolution: unknown`);
        }
        console.log(`${logPrefix} ⬇️ Download complete: ${videoPath}`);
        pushProgress({ step: 'download_done', message: `${progressPrefix}✅ Video downloaded`, progress: 35 });

        console.log(`${logPrefix} 📝 Stage transcript start`);
        pushProgress({ step: 'subtitles', message: `${progressPrefix}📝 Fetching transcript...`, progress: 40 });
        let transcript = '';
        let transcriptSource = 'metadata_fallback';
        const existingDownloaded = readBestTranscriptFromDir(jobDir, true, true);
        if (existingDownloaded?.transcript) {
            transcript = existingDownloaded.transcript;
            transcriptSource = `downloaded_vtt:${existingDownloaded.source}`;
            console.log(`${logPrefix} 📝 Transcript hit from downloaded file: ${existingDownloaded.source}`);
        }
        if (!transcript.trim()) {
            try {
                console.log(`${logPrefix} 📝 Transcript retry via yt-dlp subtitle fetch...`);
                await runYtdlp(['--write-sub', '--write-auto-sub', '--sub-langs', 'id.*,en.*', '--sub-format', 'vtt', '--skip-download', '-o', path.join(jobDir, 'subs'), '--no-playlist', youtubeUrl], jobDir, { preferNoCookies: false });
                const ytDlpTranscript = readBestTranscriptFromDir(jobDir, true, true);
                if (ytDlpTranscript?.transcript) {
                    transcript = ytDlpTranscript.transcript;
                    transcriptSource = `yt-dlp:${ytDlpTranscript.source}${fs.existsSync(COOKIES_PATH) ? '+cookies' : ''}`;
                    console.log(`${logPrefix} 📝 Transcript loaded via yt-dlp: ${ytDlpTranscript.source}`);
                }
            } catch (e) { console.log(`${logPrefix} ⚠️ yt-dlp transcript fetch failed: ${e.message}`); }
        }
        if (!transcript.trim() && videoId) {
            try {
                console.log(`${logPrefix} 📝 Transcript fallback via direct fetch...`);
                const r = await fetchYouTubeTranscript(videoId);
                if (r?.content) {
                    fs.writeFileSync(path.join(jobDir, 'raw_captions.vtt'), r.content);
                    const parsed = parseTranscriptVtt(r.content, true);
                    if (parsed) {
                        transcript = parsed;
                        transcriptSource = `direct_fetch:${r.language || 'unknown'}`;
                        console.log(`${logPrefix} 📝 Transcript loaded via direct fetch (${r.language || 'unknown'})`);
                    }
                }
            } catch (e) { console.log(`${logPrefix} ⚠️ direct transcript fetch failed: ${e.message}`); }
        }
        if (!transcript.trim()) {
            console.log(`${logPrefix} 📝 Transcript fallback to metadata only`);
            transcript = `Title: ${videoInfo.title}\n`;
            if (videoInfo.description) transcript += `Description: ${videoInfo.description}\n`;
            if (videoInfo.chapters?.length > 0) {
                transcript += '\nChapters:\n';
                videoInfo.chapters.forEach(ch => { transcript += `${formatTime(ch.start_time)} - ${ch.title}\n`; });
            }
            if (videoInfo.tags) transcript += `\nTags: ${videoInfo.tags.join(', ')}`;
        }
        transcript = filterTranscriptFromOffset(transcript, analysisStartOffset);
        console.log(`${logPrefix} 📝 Transcript source final: ${transcriptSource}`);
        pushProgress({ step: 'subtitles_done', message: `${progressPrefix}✅ Transcript ready (${transcriptSource})`, progress: 50 });

        console.log(`${logPrefix} 🤖 Stage AI analysis start`);
        pushProgress({ step: 'ai', message: `${progressPrefix}🤖 AI sedang menganalisa konten video...`, progress: 55 });
        const selectedModel = model || 'google/gemini-2.0-flash-001';
        const minDur = minDuration || 30, maxDur = maxDuration || 90, numClips = Math.min(15, Math.max(1, clipCount || 10));
        const allTimestamps = [];
        transcript.split('\n').forEach(line => { const m = line.match(/^\[(\d+(?:\.\d+)?)s\]\s*(.*)/); if (m) allTimestamps.push({ time: parseFloat(m[1]), text: m[2] }); });
        const effectiveDuration = Math.max(0, videoDuration - analysisStartOffset);
        const aiSystemPrompt = [
            'PROMPT: AI SHORT VIDEO EDITOR (PODCAST COMEDY EDITION).',
            'Peranmu adalah Senior Social Media Manager dan AI Video Editor yang ahli mengubah podcast panjang menjadi short video viral.',
            'Kamu harus memakai transcript sebagai data RAG utama dan satu-satunya sumber kebenaran untuk menentukan topic, hook_title, caption, start_time, dan end_time.',
            'Jangan mengarang bebas, jangan menambah klaim di luar transcript, dan jangan memilih timestamp yang tidak didukung isi transcript.',
            'Hook title dan caption wajib lahir dari hasil analisa segmen: keduanya harus menangkap sudut paling kuat, konflik, kejutan, punchline, atau insight utama dari clip, bukan sekadar ringkasan generik.'
        ].join(' ');
        const aiPrompt = [
            transcriptSource === 'metadata_fallback'
                ? `Transcript lengkap tidak tersedia. Gunakan metadata video berikut untuk memilih maksimal ${numClips} segmen kandidat durasi ${minDur}-${maxDur} detik. Jika chapter tersedia, prioritaskan chapter itu. Jika metadata terlalu lemah, kembalikan array kosong [].`
                : `Analisis transcript podcast berikut dan pilih ${numClips} segmen terbaik untuk dijadikan short clip durasi ${minDur}-${maxDur} detik.`,
            '',
            'KONTEKS:',
            '- Tema utama konten adalah podcast comedy/hiburan, tetapi bisa mengandung momen serius, mendalam, atau relatable.',
            transcriptSource === 'metadata_fallback'
                ? '- Data di bawah ini hanya metadata video, bukan transcript penuh. Jadi pilih clip hanya dari chapter/title/description yang benar-benar ada.'
                : '- Transcript di bawah ini adalah DATA RAG. Gunakan transcript sebagai sumber bukti utama untuk semua keputusan.',
            transcriptSource === 'metadata_fallback'
                ? '- Jika metadata tidak cukup kuat untuk mendukung segmen, kembalikan array kosong [].'
                : '- Jika transcript tidak mendukung sebuah klaim, maka klaim itu tidak boleh dipakai.',
            '',
            'CATATAN PENTING:',
            `- Analisa HARUS dimulai dari detik ${analysisStartOffset}s jika ada offset URL.`,
            `- Abaikan seluruh isi sebelum detik ${analysisStartOffset}s.`,
            '- Timestamp pada transcript tetap timestamp ABSOLUT video asli.',
            '',
            `TRANSCRIPT VIDEO / DATA RAG (durasi efektif analisa: ${effectiveDuration} detik, source: ${transcriptSource}):`,
            transcript,
            '',
            'TUGAS UTAMA:',
            '- Identifikasi segmen yang benar-benar merupakan Gold Nuggets dari percakapan.',
            '- Untuk setiap segmen, tentukan topik, judul hook, caption, start_time, dan end_time hanya dari transcript yang relevan dengan segmen itu.',
            '- Start harus dimulai tepat saat setup cerita, awal kalimat penting, atau awal topik mulai dibahas.',
            '- End harus berhenti tepat setelah punchline, pesan serius, atau payoff selesai, dengan buffer natural sekitar 1 detik agar tidak terpotong kasar.',
            '',
            'KATEGORI KLIP:',
            '- Pure Comedy: setup + punchline lucu yang jelas.',
            '- Sudden Depth: transisi mendadak dari lucu ke serius/deep.',
            '- Relatable Moment: momen yang terasa dekat dengan pengalaman penonton.',
            '',
            'PRIORITAS ANALISIS:',
            '1. Akurasi transcript sebagai RAG source.',
            '2. Kejelasan topik dari awal sampai akhir clip.',
            '3. Setup -> payoff lengkap dalam satu clip.',
            '4. Potensi viral: lucu, mendadak deep, atau sangat relatable.',
            '5. Penonton tetap paham tanpa konteks panjang dari luar clip.',
            '',
            'BATASAN & PANDUAN:',
            '- Jangan memotong di tengah kalimat atau di tengah topik.',
            '- Jangan pilih intro, opening, sponsor, CTA, teaser, atau bagian pengantar yang belum masuk inti pembahasan.',
            '- Jika itu momen lucu, setup dan punchline harus sama-sama masuk.',
            '- Jika itu momen serius, tangkap transisi emosinya dan pastikan pesannya selesai tersampaikan.',
            '- Judul hook harus pendek, kuat, spesifik, dan terasa seperti alasan orang mau berhenti scroll.',
            '- Caption harus santai, enak dibaca, dan terasa seperti memperjelas atau memperkuat hook dari hasil analisa segmen, bukan mengulang kosong.',
            '- Semua output wajib bisa dilacak balik ke transcript segmen itu.',
            '',
            'ATURAN KHUSUS HOOK_TITLE & CAPTION:',
            '- Tentukan dulu angle utama clip: apa yang paling bikin orang penasaran, ngakak, kaget, tersentuh, atau merasa relate.',
            '- hook_title harus mewakili angle utama itu dalam 4-10 kata, idealnya 25-60 karakter.',
            '- hook_title harus terdengar natural untuk konten short-form, boleh conversational, tetapi tidak boleh clickbait palsu.',
            '- hook_title jangan menjadi kutipan transcript mentah atau penggalan kalimat verbatim; tulis ulang jadi parafrase hook yang tetap setia pada topik dan bukti clip.',
            '- Hindari judul generik seperti: "Momen Lucu", "Ini Kocak Banget", "Obrolan Seru", "Deep Banget", atau judul yang bisa dipakai di clip mana pun.',
            '- Pilih kata yang menunjukkan konflik, kejutan, kontras, punchline, atau insight paling tajam dari segmen.',

            '- caption harus memperluas hook_title dengan 1-3 kalimat singkat yang masih setia pada transcript.',
            '- Baris pertama caption harus memperkuat inti analisa segmen, bukan filler.',
            '- Caption boleh memakai gaya santai dan CTA ringan, tetapi CTA taruh di akhir dan jangan lebih kuat dari isi utama.',
            '- Jangan pakai kalimat template kosong seperti: "Siapa yang relate?", "Tag teman kamu", atau "Full lucu banget" jika tidak didukung konteks segmen.',
            '- Jika segmennya funny, tonjolkan setup atau punchline yang paling menjual. Jika segmennya deep/relatable, tonjolkan kalimat atau sudut yang paling nusuk.',
            '',
            'LANGKAH KERJA YANG HARUS DIIKUTI:',
            '1. Petakan blok-blok topik dari transcript.',
            '2. Cari 3-15 blok terbaik sesuai permintaan clipCount yang punya setup, isi, dan payoff paling kuat.',
            transcriptSource === 'metadata_fallback' ? '3. Jika ada chapters, pakai chapter sebagai dasar start_time/end_time kandidat.' : '3. Ambil bukti transcript untuk setiap blok sebelum menentukan metadata clip.',
            '4. Tentukan start_time dari awal setup/topik penting.',
            '5. Tentukan end_time saat punchline/pesan/topik selesai, lalu beri buffer natural singkat.',
            transcriptSource === 'metadata_fallback' ? '6. Bentuk topic, hook_title, dan caption dari chapter/title/description yang tersedia, jangan mengarang di luar metadata.' : '6. Bentuk topic, hook_title, dan caption dari transcript segmen itu, lalu poles jadi menarik berdasarkan angle hasil analisa, bukan dari kreativitas bebas.',

            '',
            'OUTPUT WAJIB:',
            '- Kembalikan JSON ARRAY SAJA. Tanpa markdown. Tanpa penjelasan tambahan.',
            '- Jangan tulis teks pembuka, teks penutup, komentar, atau penjelasan di luar JSON.',
            '- Urutkan dari segmen paling kuat ke segmen berikutnya.',
            '- Jika segmen tidak cukup kuat, lebih baik hasil lebih sedikit daripada memaksa clip lemah.',
            '',
            'FORMAT JSON:',
            '[',
            '  {',
            '    "clip_number": 1,',
            '    "start_time": 123.4,',
            '    "end_time": 178.9,',
            '    "category": "Pure Comedy|Sudden Depth|Relatable Moment",',
            '    "hook_title": "judul hook pendek dari transcript",',
            '    "topic": "inti topik clip dalam 3-8 kata",',
            '    "caption": "caption santai berbasis transcript",',
            '    "reason": "analisis kenapa segmen ini layak dipotong dan kenapa retention-nya kuat",',
            '    "type": "funny|moment|story|insight",',
            '    "evidence": ["kutipan/parafrase transcript 1", "kutipan/parafrase transcript 2"]',
            '  }',
            ']',
            '',
            'ATURAN FIELD:',
            '- category wajib pilih salah satu: Pure Comedy, Sudden Depth, Relatable Moment.',
            '- topic, hook_title, dan caption wajib berdasarkan transcript clip itu sendiri, tapi tulis ulang jadi hook/caption yang menarik dan spesifik terhadap angle segmen (jangan copy-paste verbatim).',
            '- hook_title harus menjadi hook paling kuat dari hasil analisa segmen, bukan label topik umum atau kutipan transcript mentah.',
            '- Jika transcript memberi fakta/topik, ubah jadi judul pendek yang terasa seperti alasan orang berhenti scroll, bukan kalimat transcript yang dipotong.',

            '- caption harus mendukung hook_title dan membantu penonton cepat paham kenapa clip ini menarik.',
            '- start_time dan end_time harus sesuai batas topik, bukan sekadar perkiraan kasar.',
            '- evidence harus berasal dari isi clip yang sama, bukan bagian lain video.',
            '- reason harus menjelaskan nilai naratif/retention segmen.',
            '- Semua start_time dan end_time wajib memakai DETIK ABSOLUT video asli.'
        ].join('\n');
        const targetAiUrl = normalizeOpenAICompatibleUrl(baseUrl);
        const aiHeaders = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` };
        if (/openrouter\.ai/i.test(targetAiUrl)) {
            aiHeaders['HTTP-Referer'] = 'http://localhost:3000';
            aiHeaders['X-Title'] = 'YouTube AI Cutter';
        }
        const aiResponse = await fetchJSON(targetAiUrl, {
            method: 'POST', headers: aiHeaders,
            body: JSON.stringify({
                model: selectedModel,
                messages: [{ role: 'system', content: aiSystemPrompt }, { role: 'user', content: aiPrompt }],
                temperature: 0,
                max_tokens: 8000,
                response_format: { type: 'json_array' }
            })
        });
        if (aiResponse.status !== 200) throw new Error(`AI API error: ${JSON.stringify(aiResponse.data)}`);
        console.log(`${logPrefix} 🤖 AI response received`);
        const aiContent = aiResponse?.data?.choices?.[0]?.message?.content;
        if (typeof aiContent !== 'string' || !aiContent.trim()) throw new Error('AI response tidak OpenAI-compatible: choices[0].message.content tidak ada');
        let clips = parseClipsFromAIResponse(aiContent);
        if ((!Array.isArray(clips) || clips.length === 0) && transcriptSource === 'metadata_fallback') {
            console.log(`${logPrefix} 🤖 AI parse empty on metadata fallback, building clips from metadata...`);
            clips = buildClipsFromMetadata(videoInfo, videoDuration, minDur, maxDur, numClips, analysisStartOffset);
        }
        if (!Array.isArray(clips) || clips.length === 0) throw new Error('AI tidak mengembalikan array clips yang valid');

        function parseTimeValue(val) {
            if (typeof val === 'number') return Math.max(0, Math.round(val * 100) / 100);
            const s = String(val).trim();
            if (/^\d+(?:\.\d+)?$/.test(s)) return Math.max(0, Math.round(parseFloat(s) * 100) / 100);
            const mm = s.match(/^(\d+):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?$/);
            if (!mm) return 0;
            const hasHours = mm[3] != null;
            const hours = hasHours ? parseInt(mm[1]) : 0;
            const mins = hasHours ? parseInt(mm[2]) : parseInt(mm[1]);
            const secs = hasHours ? parseInt(mm[3]) : parseInt(mm[2]);
            const frac = mm[4] ? parseInt(mm[4].padEnd(3, '0')) / 1000 : 0;
            return Math.round((hours * 3600 + mins * 60 + secs + frac) * 100) / 100;
        }

        clips = clips.map((clip, i) => {
            clip.clip_number = i + 1;
            clip.hook_title = String(clip.hook_title || clip.title || `Clip ${i + 1}`).trim();
            clip.topic = String(clip.topic || clip.angle || clip.theme || clip.hook_title || `Topik ${i + 1}`).trim();
            clip.caption = String(clip.caption || clip.summary || clip.description || '').trim();
            clip.reason = String(clip.reason || clip.why || clip.explanation || clip.rationale || `Segmen ini dipilih karena topiknya paling jelas, konteksnya utuh, dan payoff-nya kuat untuk short clip.`).trim();

            clip.evidence = normalizeEvidenceList(clip.evidence);
            clip.type = normalizeClipType(clip.type, clip);
            clip.start_time = Math.max(analysisStartOffset, Math.min(videoDuration, parseTimeValue(clip.start_time)));
            clip.end_time = Math.max(0, Math.min(videoDuration, parseTimeValue(clip.end_time)));
            if (clip.end_time <= clip.start_time) clip.end_time = clip.start_time + minDur;
            const dur = clip.end_time - clip.start_time;
            if (dur < minDur) clip.end_time = Math.min(videoDuration, clip.start_time + minDur);
            if (dur > maxDur) clip.end_time = clip.start_time + maxDur;
            if (allTimestamps.length > 0) {
                const nearest = allTimestamps.reduce((best, t) => Math.abs(t.time - clip.start_time) < Math.abs(best.time - clip.start_time) ? t : best);
                const originalDuration = clip.end_time - clip.start_time;
                if (Math.abs(nearest.time - clip.start_time) > 3) {
                    clip.start_time = nearest.time;
                    clip.end_time = Math.min(videoDuration, clip.start_time + originalDuration);
                }
                clip = snapClipToTopicBounds(clip, allTimestamps, minDur, maxDur, videoDuration);
            }
            clip.topic = buildGroundedTopic(clip, allTimestamps);
            clip.hook_title = buildGroundedHookTitle(clip, allTimestamps);
            clip.caption = buildGroundedCaption(clip, allTimestamps);
            const DEFAULT_TAGS = '#viral #fyp #foryou #foryoupage #viralvideos #trending';
            let tags = '';
            if (clip.hashtags && String(clip.hashtags).trim()) tags = String(clip.hashtags).split(/[\s,]+/).filter(t => t).map(t => t.startsWith('#') ? t : '#' + t).join(' ');
            if (!tags) {
                let autoTags = [];
                if (clip.type) autoTags.push('#' + clip.type);
                if (clip.topic) clip.topic.replace(/[^\w\s]/g, '').split(/\s+/).filter(w => w.length > 3).slice(0, 4).forEach(w => autoTags.push('#' + w.toLowerCase()));
                autoTags.push('#shorts');
                tags = [...new Set(autoTags)].join(' ');
            }
            const existingSet = new Set(tags.toLowerCase().split(/\s+/));
            const defaults = DEFAULT_TAGS.split(' ').filter(t => !existingSet.has(t.toLowerCase()));
            tags = (tags + ' ' + defaults.join(' ')).trim();
            if (tags && !clip.caption.includes('#')) clip.caption = clip.caption.trim() + '\n\n' + tags;
            clip.start_time = Math.round(clip.start_time * 100) / 100;
            clip.end_time = Math.round(clip.end_time * 100) / 100;
            return clip;
        });

        const beforeDedupe = clips.length;
        clips = dedupeAndSpreadClips(clips, Math.max(6, Math.round(minDur * 0.2)));
        if (clips.length !== beforeDedupe) {
            console.log(`${logPrefix} 🤖 Dedupe removed ${beforeDedupe - clips.length} overlapping/near-duplicate clips`);
        }
        const beforeIntroFilter = clips.length;
        clips = filterIntroishClips(clips, allTimestamps, minDur);
        if (clips.length !== beforeIntroFilter) {
            console.log(`${logPrefix} 🤖 Intro-filter removed ${beforeIntroFilter - clips.length} intro/teaser-like clips`);
        }
        clips = rankClipsByEvidence(clips, allTimestamps);
        const strongEvidenceCount = clips.filter((clip) => clip.evidence_quality === 'high').length;
        const weakEvidenceCount = clips.filter((clip) => clip.evidence_quality === 'low').length;
        const beforeDiversify = clips.length;
        clips = diversifyClipsByType(clips, Math.min(numClips, clips.length));
        clips = clips.map((clip, i) => ({ ...clip, clip_number: i + 1 }));

        console.log(`${logPrefix} 🤖 AI parsed ${clips.length} clips | evidence high: ${strongEvidenceCount} | low: ${weakEvidenceCount} | type balancing applied`);

        pushProgress({ step: 'ai_done', message: `${progressPrefix}🤖 AI menemukan ${clips.length} segment terbaik!`, progress: 65, clips });
        const safeTitle = videoTitle.replace(/[^a-zA-Z0-9_\-\s]/g, '').substring(0, 40).trim();
        const results = [];
        let completedCuts = 0;
        console.log(`${logPrefix} ✂️ Stage cutting start`);
        const cutItems = clips.map((clip, i) => ({ clip, index: i }));
        console.log(`${logPrefix} ✂️ Cut workers: ${Math.min(CUT_WORKERS, cutItems.length)} | mode: ${USE_FAST_COPY_CUT ? 'copy-with-fallback' : 'reencode'}`);
        await runWithConcurrency(cutItems, CUT_WORKERS, async ({ clip, index }) => {
            const clipNum = String(index + 1).padStart(2, '0');
            const clipDuration = clip.end_time - clip.start_time;
            const outputFilename = `${safeTitle}_clip${clipNum}_${jobId.substring(0, 6)}.mp4`;
            const outputPath = path.join(OUTPUT_DIR, outputFilename);
            console.log(`${logPrefix} ✂️ Cutting clip ${index + 1}/${clips.length} | ${clip.start_time}s -> ${clip.end_time}s`);
            const cutMode = await cutClipWithFallback(videoPath, outputPath, clip.start_time, clipDuration, jobDir);
            const stats = fs.statSync(outputPath);
            completedCuts += 1;
            const progressVal = 65 + Math.round((completedCuts / clips.length) * 30);
            pushProgress({ step: 'cutting', message: `${progressPrefix}✂️ Memotong clip ${completedCuts}/${clips.length}`, progress: progressVal, currentClip: completedCuts, totalClips: clips.length });
            console.log(`${logPrefix} ✅ Clip ${index + 1} ready (${cutMode}): ${outputFilename} | ${(stats.size / (1024 * 1024)).toFixed(2)} MB`);
            results[index] = { clip_number: index + 1, filename: outputFilename, downloadUrl: `/output/${outputFilename}`, fileSize: (stats.size / (1024 * 1024)).toFixed(2) + ' MB', hook_title: clip.hook_title, topic: clip.topic, caption: clip.caption, reason: clip.reason, type: clip.type || 'viral', evidence: clip.evidence, evidence_score: clip.evidence_score, evidence_quality: clip.evidence_quality, start_time: clip.start_time, end_time: clip.end_time, duration: Math.round(clipDuration), source_youtube_url: youtubeUrl };
        });

        pushProgress({ step: 'done', message: `${progressPrefix}🎉 Selesai! ${results.length} clip siap didownload.`, progress: 100, results });
        jobResults.set(jobId, { results, videoTitle: safeTitle, apiKey, model: selectedModel });
        setTimeout(() => jobResults.delete(jobId), 7200000);
        setTimeout(() => { try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch (e) { } }, 3600000);
        try {
            const thumbnail = videoInfo.thumbnail || (videoId ? `https://img.youtube.com/vi/${videoId}/mqdefault.jpg` : '');
            const historyEntry = { id: jobId, videoTitle: safeTitle, youtubeUrl, thumbnail, results, model: selectedModel, date: new Date().toISOString() };
            fs.writeFileSync(path.join(HISTORY_DIR, jobId + '.json'), JSON.stringify(historyEntry, null, 2), 'utf-8');
            console.log(`${logPrefix} 🕘 History saved: ${jobId}.json`);
        } catch (he) { console.error('[HISTORY] Save failed:', he.message); }
        console.log(`${logPrefix} ✅ Analyze done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
        return { results, safeTitle };
    } finally {
        restoreCookiesState(cookiesBackup);
        console.log(`${logPrefix} 🍪 Cookies state restored`);
    }
}

function getOAuthCallbackUrl() {
    return PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}/api/youtube/callback` : `http://localhost:${PORT}/api/youtube/callback`;
}

function getOAuth2Client() {
    if (!fs.existsSync(CLIENT_SECRET_PATH)) return null;
    try {
        const cred = JSON.parse(fs.readFileSync(CLIENT_SECRET_PATH, 'utf-8'));
        const c = cred.web || cred.installed;
        if (!c) return null;
        const client = new google.auth.OAuth2(c.client_id, c.client_secret, getOAuthCallbackUrl());
        if (fs.existsSync(TOKEN_PATH)) client.setCredentials(JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8')));
        return client;
    } catch { return null; }
}

function isYouTubeConnected() {
    const c = getOAuth2Client();
    return c && c.credentials && c.credentials.access_token;
}

function extractVideoId(url) {
    const patterns = [/(?:v=|\/)([0-9A-Za-z_-]{11})(?:[?&]|$)/, /youtu\.be\/([0-9A-Za-z_-]{11})/, /\/shorts\/([0-9A-Za-z_-]{11})/, /\/embed\/([0-9A-Za-z_-]{11})/];
    for (const p of patterns) { const m = url.match(p); if (m) return m[1]; }
    return null;
}

function parseYouTubeStartTime(url) {
    try {
        const u = new URL(url);
        const raw = u.searchParams.get('t') || u.searchParams.get('start') || '';
        if (!raw) return 0;
        if (/^\d+$/.test(raw)) return parseInt(raw, 10);
        const m = raw.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i);
        if (!m) return 0;
        return (parseInt(m[1] || '0', 10) * 3600) + (parseInt(m[2] || '0', 10) * 60) + parseInt(m[3] || '0', 10);
    } catch (e) {
        const m = String(url || '').match(/[?&]t=(\d+)|[?&]start=(\d+)/i);
        return m ? parseInt(m[1] || m[2] || '0', 10) : 0;
    }
}

function filterTranscriptFromOffset(transcript, startOffset) {
    if (!startOffset || !transcript) return transcript;
    const filtered = String(transcript)
        .split('\n')
        .filter(line => {
            const m = line.match(/^\[(\d+(?:\.\d+)?)s\]/);
            return !m || parseFloat(m[1]) >= startOffset;
        })
        .join('\n')
        .trim();
    return filtered || transcript;
}

function normalizeOpenAICompatibleUrl(rawUrl) {
    const input = String(rawUrl || '').trim();
    if (!input) throw new Error('OpenAI-compatible Base URL is required');
    let parsed;
    try {
        parsed = new URL(input);
    } catch (error) {
        throw new Error('Base URL tidak valid');
    }
    const pathName = parsed.pathname.replace(/\/+$/, '');
    if (/\/chat\/completions$/i.test(pathName)) return parsed.toString();
    if (/\/v1$/i.test(pathName)) {
        parsed.pathname = pathName + '/chat/completions';
        parsed.search = '';
        return parsed.toString();
    }
    if (!pathName || pathName === '/') {
        parsed.pathname = '/v1/chat/completions';
        parsed.search = '';
        return parsed.toString();
    }
    throw new Error('Base URL harus OpenAI-compatible. Pakai base root, /v1, atau /v1/chat/completions');
}

async function fetchYouTubeTranscript(videoId) {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8' } });
    if (!resp.ok) throw new Error(`YouTube returned ${resp.status}`);
    const html = await resp.text();
    const startToken = 'ytInitialPlayerResponse = ';
    const startIdx = html.indexOf(startToken);
    if (startIdx === -1) throw new Error('Could not find player response');
    const jsonStart = startIdx + startToken.length;
    let depth = 0, jsonEnd = jsonStart;
    for (let i = jsonStart; i < html.length && i < jsonStart + 500000; i++) {
        if (html[i] === '{') depth++; else if (html[i] === '}') depth--;
        if (depth === 0) { jsonEnd = i + 1; break; }
    }
    const pr = JSON.parse(html.substring(jsonStart, jsonEnd));
    const cc = pr?.captions?.playerCaptionsTracklistRenderer;
    if (!cc || !cc.captionTracks || cc.captionTracks.length === 0) throw new Error('No caption tracks');
    const tracks = cc.captionTracks;
    let track = tracks.find(t => t.languageCode === 'id') || tracks.find(t => t.languageCode === 'en') || tracks[0];
    const sep = track.baseUrl.includes('?') ? '&' : '?';
    const vttResp = await fetch(`${track.baseUrl}${sep}fmt=vtt`);
    if (vttResp.ok) {
        const vttContent = await vttResp.text();
        if (vttContent.includes('-->')) return { content: vttContent, language: track.languageCode };
    }
    const json3Resp = await fetch(`${track.baseUrl}${sep}fmt=json3`);
    if (!json3Resp.ok) throw new Error('Caption download failed');
    const json3 = JSON.parse(await json3Resp.text());
    let vttOutput = 'WEBVTT\n\n';
    if (json3.events) {
        for (const event of json3.events) {
            if (!event.segs) continue;
            const startMs = event.tStartMs || 0, durMs = event.dDurationMs || 3000, endMs = startMs + durMs;
            const text = event.segs.map(s => s.utf8 || '').join('').trim();
            if (!text || text === '\n') continue;
            const fmtTs = (ms) => { const s = Math.floor(ms / 1000); return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`; };
            vttOutput += `${fmtTs(startMs)} --> ${fmtTs(endMs)}\n${text}\n\n`;
        }
    }
    return { content: vttOutput, language: track.languageCode };
}

function parseTranscriptVtt(vttContent, precise = false) {
    const parsed = precise ? parseVTTPrecise(vttContent) : parseVTT(vttContent);
    return parsed.trim() && /^\[\d+(?:\.\d+)?s\]/m.test(parsed) ? parsed : '';
}

function readBestTranscriptFromDir(dirPath, precise = false, excludeRaw = false) {
    const files = fs.readdirSync(dirPath)
        .filter(f => f.endsWith('.vtt') && (!excludeRaw || !f.includes('raw_captions')))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    for (const file of files) {
        const fullPath = path.join(dirPath, file);
        const parsed = parseTranscriptVtt(fs.readFileSync(fullPath, 'utf-8'), precise);
        if (parsed) return { transcript: parsed, source: file };
    }
    return null;
}

async function getVideoInfoViaAPI(videoId) {
    const client = getOAuth2Client();
    if (!client || !client.credentials?.access_token) return null;
    try {
        const youtube = google.youtube({ version: 'v3', auth: client });
        const response = await youtube.videos.list({ part: ['snippet', 'contentDetails'], id: [videoId] });
        if (!response.data.items || response.data.items.length === 0) return null;
        const item = response.data.items[0];
        const match = item.contentDetails.duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
        return { title: item.snippet.title, duration: (parseInt(match?.[1] || 0) * 3600) + (parseInt(match?.[2] || 0) * 60) + parseInt(match?.[3] || 0), description: item.snippet.description, channelTitle: item.snippet.channelTitle, tags: item.snippet.tags };
    } catch (e) { return null; }
}

// === COOKIES ENDPOINTS ===
router.get('/api/cookies-status', (req, res) => {
    const exists = fs.existsSync(COOKIES_PATH);
    let size = 0, lines = 0;
    if (exists) { size = fs.statSync(COOKIES_PATH).size; lines = fs.readFileSync(COOKIES_PATH, 'utf8').split('\n').filter(l => l.trim() && !l.startsWith('#')).length; }
    res.json({ exists, size, cookieCount: lines });
});
router.post('/api/upload-cookies', (req, res) => {
    try {
        const t = req.body; if (!t || typeof t !== 'string' || t.length < 10) return res.status(400).json({ error: 'Invalid' });
        fs.writeFileSync(COOKIES_PATH, t, 'utf8');
        res.json({ success: true, cookieCount: t.split('\n').filter(l => l.trim() && !l.startsWith('#')).length });
    } catch (err) { res.status(500).json({ error: err.message }); }
});
router.delete('/api/delete-cookies', (req, res) => {
    try { if (fs.existsSync(COOKIES_PATH)) fs.unlinkSync(COOKIES_PATH); res.json({ success: true }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

// === YOUTUBE API ENDPOINTS ===
router.get('/api/youtube/status', (req, res) => {
    const hasCS = fs.existsSync(CLIENT_SECRET_PATH), hasT = fs.existsSync(TOKEN_PATH), conn = isYouTubeConnected();
    let status = 'not_configured';
    if (hasCS && !hasT) status = 'disconnected';
    if (hasCS && hasT && conn) status = 'connected';
    res.json({ status, hasClientSecret: hasCS, hasToken: hasT });
});
router.get('/api/youtube/auth', (req, res) => {
    const client = getOAuth2Client();
    if (!client) return res.status(400).json({ error: 'client_secret.json not found' });
    res.json({ authUrl: client.generateAuthUrl({ access_type: 'offline', scope: YOUTUBE_SCOPES, prompt: 'consent' }) });
});
router.get('/api/youtube/callback', async (req, res) => {
    const { code } = req.query;
    if (!code) return res.status(400).send('No authorization code');
    const client = getOAuth2Client();
    if (!client) return res.status(400).send('OAuth client not configured');
    try {
        const { tokens } = await client.getToken(code);
        client.setCredentials(tokens);
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
        res.redirect('/?youtube=connected');
    } catch (err) { res.redirect('/?youtube=error&message=' + encodeURIComponent(err.message)); }
});
router.delete('/api/youtube/disconnect', (req, res) => {
    if (fs.existsSync(TOKEN_PATH)) fs.unlinkSync(TOKEN_PATH);
    res.json({ success: true });
});

// === HISTORY ENDPOINTS ===
// List all history entries (sorted newest first)
router.get('/api/history', (req, res) => {
    try {
        const files = fs.readdirSync(HISTORY_DIR).filter(f => f.endsWith('.json'));
        const entries = files.map(f => {
            try {
                const data = JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, f), 'utf-8'));
                const id = f.replace('.json', '');
                return { id, title: data.videoTitle, youtubeUrl: data.youtubeUrl, thumbnail: data.thumbnail, clipCount: data.results ? data.results.length : 0, date: data.date, model: data.model };
            } catch (e) { return null; }
        }).filter(Boolean).sort((a, b) => new Date(b.date) - new Date(a.date));
        res.json({ success: true, entries });
    } catch (e) { res.json({ success: false, error: e.message }); }
});

// Get single history entry (full results) — also restore to jobResults for convert operations
router.get('/api/history/:id', (req, res) => {
    try {
        const filePath = path.join(HISTORY_DIR, req.params.id + '.json');
        if (!fs.existsSync(filePath)) return res.json({ success: false, error: 'Not found' });
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        // Restore jobResults so convert-ratio endpoints work
        if (data.id && data.results) {
            jobResults.set(data.id, { results: data.results, videoTitle: data.videoTitle || 'History' });
        }
        res.json({ success: true, ...data });
    } catch (e) { res.json({ success: false, error: e.message }); }
});

// Save history entry (called automatically after analysis completes)
router.post('/api/history', (req, res) => {
    try {
        const { jobId, videoTitle, youtubeUrl, thumbnail, results, model } = req.body;
        const id = jobId || uuidv4();
        const entry = { id, videoTitle: videoTitle || 'Unknown', youtubeUrl: youtubeUrl || '', thumbnail: thumbnail || '', results: results || [], model: model || '', date: new Date().toISOString() };
        fs.writeFileSync(path.join(HISTORY_DIR, id + '.json'), JSON.stringify(entry, null, 2), 'utf-8');
        res.json({ success: true, id });
    } catch (e) { res.json({ success: false, error: e.message }); }
});

// Delete history entry
router.delete('/api/history/:id', (req, res) => {
    try {
        const filePath = path.join(HISTORY_DIR, req.params.id + '.json');
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        res.json({ success: true });
    } catch (e) { res.json({ success: false, error: e.message }); }
});

// === SSE PROGRESS ===
router.get('/api/progress/:jobId', (req, res) => {
    const { jobId } = req.params;
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    res.write(`data: ${JSON.stringify({ step: 'connected', message: 'Connected' })}\n\n`);
    if (typeof res.flush === 'function') res.flush();

    const history = jobProgressHistory.get(jobId) || [];
    history.forEach(entry => {
        res.write(`data: ${JSON.stringify(entry)}\n\n`);
    });
    if (typeof res.flush === 'function') res.flush();

    if (!sseClients.has(jobId)) sseClients.set(jobId, []);
    sseClients.get(jobId).push(res);

    const heartbeat = setInterval(() => {
        try {
            res.write(': keepalive\n\n');
            if (typeof res.flush === 'function') res.flush();
        } catch (e) {
            clearInterval(heartbeat);
        }
    }, 15000);

    req.on('close', () => {
        clearInterval(heartbeat);
        const c = sseClients.get(jobId) || [];
        sseClients.set(jobId, c.filter(x => x !== res));
    });
});

router.get('/api/progress/:jobId/history', (req, res) => {
    const { jobId } = req.params;
    const history = jobProgressHistory.get(jobId) || [];
    res.json({ success: true, jobId, events: history });
});

router.get('/api/convert-artifact', (req, res) => {
    const { jobId, mode, ratio, clipIndex, selectedIndices } = req.query;
    const selected = typeof selectedIndices === 'string' && selectedIndices.trim()
        ? selectedIndices.split(',').map(x => x.trim()).filter(Boolean)
        : [];
    const key = makeConvertArtifactKey(jobId, mode, ratio, clipIndex, selected);
    const artifact = convertArtifacts.get(key);
    const history = jobId ? (jobProgressHistory.get(jobId) || []) : [];
    const latestMessage = history.length ? String(history[history.length - 1].message || '') : '';
    const packagingDone = history.some(evt => String(evt && evt.message || '').includes('Stage 3/3 Packaging done'));
    if (!artifact && latestMessage && latestMessage.includes('Stage 3/3 Packaging done')) {
        const maybeKey = makeConvertArtifactKey(jobId, mode, ratio, clipIndex, selected);
        const altKeys = [
            maybeKey,
            makeConvertArtifactKey(jobId, mode, ratio, clipIndex || '', []),
            makeConvertArtifactKey(jobId, mode, ratio, '', selected)
        ];
        for (const altKey of altKeys) {
            const altArtifact = convertArtifacts.get(altKey);
            if (altArtifact) return res.json({ success: true, artifact: altArtifact, packagingDone: true, latestMessage });
        }
    }
    if (!artifact) {
        return res.status(404).json({
            error: packagingDone ? 'Convert artifact missing after packaging done' : 'Convert artifact belum siap',
            pending: !packagingDone,
            packagingDone,
            latestMessage
        });
    }
    res.json({ success: true, artifact, packagingDone, latestMessage });
});


// === MAIN ANALYZE ENDPOINT ===
router.post('/api/analyze', async (req, res) => {
    const { youtubeUrl, baseUrl, apiKey, model, minDuration, maxDuration, clipCount, smartCrop } = req.body;
    if (!youtubeUrl || !baseUrl || !apiKey) return res.status(400).json({ error: 'YouTube URL, OpenAI-compatible Base URL, and API Key are required' });
    const jobId = uuidv4();
    res.json({ jobId });

    try {
        await runAnalyzeJob({ jobId, youtubeUrl, baseUrl, apiKey, model, minDuration, maxDuration, clipCount, smartCrop });
    } catch (error) {
        console.error('Job error:', error);
        sendProgress(jobId, { step: 'error', message: `❌ Error: ${error.message}`, progress: -1, error: error.message });
    }
});

router.post('/api/analyze-bulk', async (req, res) => {
    const { items, baseUrl, apiKey, model, minDuration, maxDuration, clipCount, smartCrop } = req.body;
    if (!baseUrl || !apiKey) return res.status(400).json({ error: 'OpenAI-compatible Base URL and API Key are required' });
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'Bulk items are required' });
    const batchJobId = uuidv4();
    res.json({ jobId: batchJobId });

    try {
        const total = items.length;
        const summaries = [];
        console.log(`📦 Bulk analyze start: ${total} items`);
        for (let i = 0; i < total; i++) {
            const item = items[i] || {};
            const youtubeUrl = String(item.youtubeUrl || '').trim();
            if (!youtubeUrl) continue;
            const childJobId = uuidv4();
            const prefix = `[${i + 1}/${total}] `;
            sendProgress(batchJobId, { step: 'bulk_item', message: `${prefix}Memulai analisa ${youtubeUrl}`, progress: Math.round((i / total) * 100) });
            try {
                const base = (i / total) * 100;
                const span = (1 / total) * 100;
                const result = await runAnalyzeJob({
                    jobId: childJobId,
                    youtubeUrl,
                    baseUrl,
                    apiKey,
                    model,
                    minDuration,
                    maxDuration,
                    clipCount,
                    smartCrop,
                    cookiesText: item.cookiesText || '',
                    progressPrefix: prefix,
                    progressJobId: batchJobId,
                    progressBase: base,
                    progressSpan: span
                });
                summaries.push({ jobId: childJobId, youtubeUrl, videoTitle: result.safeTitle, clipCount: result.results.length });
                console.log(`📦 Bulk item ${i + 1}/${total} done: ${result.safeTitle}`);
            } catch (error) {
                console.error(`Bulk item failed [${i + 1}/${total}]:`, error.message);
                summaries.push({ jobId: null, youtubeUrl, error: error.message, clipCount: 0 });
                sendProgress(batchJobId, { step: 'bulk_item_error', message: `${prefix}❌ ${error.message}`, progress: Math.round(((i + 1) / total) * 100) });
            }
        }
        console.log(`📦 Bulk analyze done: ${summaries.filter(s => !s.error).length}/${total} success`);
        sendProgress(batchJobId, { step: 'done', message: `🎉 Bulk selesai. ${summaries.filter(s => !s.error).length}/${total} video berhasil.`, progress: 100, results: summaries, bulk: true });
    } catch (error) {
        console.error('📦 Bulk analyze fatal error:', error && error.stack ? error.stack : error);
        sendProgress(batchJobId, { step: 'error', message: `❌ Error: ${error.message}`, progress: -1, error: error.message, bulk: true });
    }
});

// === DOWNLOAD ENDPOINTS ===
router.get('/api/download-zip/:jobId/:clipIndex', async (req, res) => {
    const job = jobResults.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const idx = parseInt(req.params.clipIndex);
    if (idx < 0 || idx >= job.results.length) return res.status(404).json({ error: 'Clip not found' });
    const clip = job.results[idx];
    const videoPath = path.join(OUTPUT_DIR, clip.filename);
    if (!fs.existsSync(videoPath)) return res.status(404).json({ error: 'File not found' });
    const clipNum = String(clip.clip_number).padStart(2, '0');
    try {
        // Buffer ZIP in memory for Content-Length (fixes IDM 0-byte issue)
        const archive = archiver('zip', { zlib: { level: 5 } });
        const chunks = [];
        archive.on('data', chunk => chunks.push(chunk));
        archive.file(videoPath, { name: clip.filename });
        archive.append(`Judul Hook:\n${clip.hook_title}\n\nCaption:\n${clip.caption}\n\nDurasi: ${clip.duration} detik (${formatTime(clip.start_time)} - ${formatTime(clip.end_time)})\n\nAlasan AI: ${clip.reason}\n`, { name: `clip${clipNum}_caption.txt` });
        await archive.finalize();
        const buffer = Buffer.concat(chunks);
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Length', buffer.length);
        res.setHeader('Content-Disposition', `attachment; filename="${job.videoTitle}_clip${clipNum}.zip"`);
        res.end(buffer);
    } catch (e) { if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

router.get('/api/download-all-zip/:jobId', async (req, res) => {
    const job = jobResults.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    try {
        const archive = archiver('zip', { zlib: { level: 5 } });
        const chunks = [];
        archive.on('data', chunk => chunks.push(chunk));
        job.results.forEach(clip => {
            const vp = path.join(OUTPUT_DIR, clip.filename);
            const cn = String(clip.clip_number).padStart(2, '0');
            if (fs.existsSync(vp)) archive.file(vp, { name: `clips/${clip.filename}` });
            archive.append(`Judul Hook:\n${clip.hook_title}\n\nCaption:\n${clip.caption}\n\nDurasi: ${clip.duration} detik\n\nAlasan AI: ${clip.reason}\n`, { name: `clips/clip${cn}_caption.txt` });
        });
        let summary = `=== ${job.videoTitle} — AI Clip Summary ===\n\n`;
        job.results.forEach(clip => { summary += `--- Clip ${String(clip.clip_number).padStart(2, '0')} ---\nJudul: ${clip.hook_title}\nDurasi: ${clip.duration}s\nFile: ${clip.filename}\n\n`; });
        archive.append(summary, { name: 'ringkasan_semua_clip.txt' });
        await archive.finalize();
        const buffer = Buffer.concat(chunks);
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Length', buffer.length);
        res.setHeader('Content-Disposition', `attachment; filename="${job.videoTitle}_all_clips.zip"`);
        res.end(buffer);
    } catch (e) { if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// === RATIO CONVERSION ===
const RATIO_DIMENSIONS = { '1:1': { w: 1080, h: 1080 }, '9:16': { w: 1080, h: 1920 }, '2:3': { w: 1080, h: 1620 } };

function buildSingleCropFilter(crop, targetW, targetH, srcW, srcH) {
    const c = sanitizeCrop(crop, srcW, srcH);
    return `crop=w=${c.w}:h=${c.h}:x=max(0\\,min(${c.x}\\,${srcW}-${c.w})):y=max(0\\,min(${c.y}\\,${srcH}-${c.h})),scale=${targetW}:${targetH}:flags=lanczos`;
}

function buildSafeModeFilter(targetW, targetH, srcW, srcH) {
    const srcAspect = srcW / srcH, targetAspect = targetW / targetH;
    let fgW, fgH;
    if (srcAspect > targetAspect) { fgW = targetW; fgH = Math.floor(targetW / srcAspect); } else { fgH = targetH; fgW = Math.floor(targetH * srcAspect); }
    fgW = Math.floor(fgW / 2) * 2; fgH = Math.floor(fgH / 2) * 2;
    return `[0:v]split=2[bg][fg];[bg]scale=${targetW}:${targetH}:force_original_aspect_ratio=increase,crop=${targetW}:${targetH},boxblur=40:10,format=yuv420p,setsar=1[blurred];[fg]scale=${fgW}:${fgH}:flags=lanczos,format=yuv420p,setsar=1[sharp];[blurred][sharp]overlay=${Math.floor((targetW - fgW) / 2)}:${Math.floor((targetH - fgH) / 2)},format=yuv420p[out]`;
}

function buildSplitScreenFilter(splitData, targetW, targetH, srcW, srcH, ratio) {
    const panelW = (ratio === '1:1') ? targetW / 2 : targetW;
    const panelH = (ratio === '1:1') ? targetH : targetH / 2;
    if (splitData && splitData.mid_x) {
        const midX = Math.max(2, Math.min(srcW - 2, Math.floor(splitData.mid_x / 2) * 2));
        const leftCrop = sanitizeCrop({ x: 0, y: 0, w: midX, h: srcH }, srcW, srcH);
        const rightCrop = sanitizeCrop({ x: midX, y: 0, w: srcW - midX, h: srcH }, srcW, srcH);
        const topExpr = `crop=w=${leftCrop.w}:h=${leftCrop.h}:x=${leftCrop.x}:y=${leftCrop.y}`;
        const bottomExpr = `crop=w=${rightCrop.w}:h=${rightCrop.h}:x=${rightCrop.x}:y=${rightCrop.y}`;
        if (ratio === '1:1') return `[0:v]split=2[a][b];[a]${topExpr},scale=${panelW}:${panelH}:force_original_aspect_ratio=increase,crop=${panelW}:${panelH}[left];[b]${bottomExpr},scale=${panelW}:${panelH}:force_original_aspect_ratio=increase,crop=${panelW}:${panelH}[right];[left][right]hstack=inputs=2`;
        return `[0:v]split=2[a][b];[a]${topExpr},scale=${panelW}:${panelH}:force_original_aspect_ratio=increase,crop=${panelW}:${panelH}[top];[b]${bottomExpr},scale=${panelW}:${panelH}:force_original_aspect_ratio=increase,crop=${panelW}:${panelH}[bottom];[top][bottom]vstack=inputs=2`;
    }
    const splitRegions = Array.isArray(splitData) ? splitData : [];
    const regions = splitRegions.map(r => {
        const pa = panelW / panelH; let sw = srcW, sh = srcH;
        if (sw / sh > pa) sw = Math.floor(sh * pa); else sh = Math.floor(sw / pa);
        return sanitizeCrop({ x: Math.floor((r.centerX || srcW / 2) - sw / 2), y: Math.floor((r.centerY || srcH / 2) - sh / 2), w: sw, h: sh }, srcW, srcH);
    });
    const r1 = regions[0] || sanitizeCrop({ x: 0, y: 0, w: srcW, h: srcH / 2 }, srcW, srcH), r2 = regions[1] || r1;
    const tc = `crop=w=${r1.w}:h=${r1.h}:x=max(0\\,min(${r1.x}\\,${srcW}-${r1.w})):y=max(0\\,min(${r1.y}\\,${srcH}-${r1.h}))`;
    const bc = `crop=w=${r2.w}:h=${r2.h}:x=max(0\\,min(${r2.x}\\,${srcW}-${r2.w})):y=max(0\\,min(${r2.y}\\,${srcH}-${r2.h}))`;
    if (ratio === '1:1') return `[0:v]split=2[a][b];[a]${tc},scale=${panelW}:${panelH}:flags=lanczos[left];[b]${bc},scale=${panelW}:${panelH}:flags=lanczos[right];[left][right]hstack=inputs=2`;
    return `[0:v]split=2[a][b];[a]${tc},scale=${panelW}:${panelH}:flags=lanczos[top];[b]${bc},scale=${panelW}:${panelH}:flags=lanczos[bottom];[top][bottom]vstack=inputs=2`;
}

function calculateCenterCrop(srcW, srcH, targetAspect) {
    let cropW, cropH, cropX, cropY;
    if (srcW / srcH > targetAspect) { cropH = srcH; cropW = Math.floor(srcH * targetAspect); cropX = Math.floor((srcW - cropW) / 2); cropY = 0; }
    else { cropW = srcW; cropH = Math.floor(srcW / targetAspect); cropX = 0; cropY = Math.floor((srcH - cropH) / 2); }
    return { x: cropX, y: cropY, w: Math.floor(cropW / 2) * 2, h: Math.floor(cropH / 2) * 2 };
}

async function renderFaceCropLikeApp(videoPath, outputPath, tmpDir, targetW, targetH, detectMode) {
    const cropRawPath = path.join(tmpDir, 'face_crop_like_app.mp4');
    await runCommand(PYTHON_CMD, [...PYTHON_ARGS, FACE_CROP_VIDEO_SCRIPT, videoPath, cropRawPath, String(targetW), String(targetH), '--detect-mode', detectMode], tmpDir);
    await runCommandWithGpuFallback(['-y', '-i', cropRawPath, '-i', videoPath, '-map', '0:v:0', '-map', '1:a?', '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-c:a', 'aac', '-b:a', '192k', outputPath], tmpDir, 'smart-crop-merge');
    try { fs.unlinkSync(cropRawPath); } catch { }
}

async function buildCaptionAss(videoPath, tmpDir, idx, targetDim, reqBody) {
    const captionProvider = reqBody.captionProvider === 'whisper' ? 'whisper' : 'elevenlabs';
    const canCaption = reqBody.autoCaption === true && (captionProvider === 'whisper' || !!reqBody.elevenLabsKey);
    if (!canCaption) return null;
    const { extractAudio, transcribeWithElevenLabs, transcribeWithWhisper, groupWordsIntoCaptions, generateCapcutASS } = require('./video-cropper-helpers');
    const audioPath = path.join(tmpDir, `audio_${idx}.wav`);
    await extractAudio(videoPath, audioPath);
    const result = captionProvider === 'whisper'
        ? await transcribeWithWhisper(audioPath, reqBody.whisperModel || 'base')
        : await transcribeWithElevenLabs(audioPath, reqBody.elevenLabsKey);
    const words = (result.words || []).filter(w => w.text && w.text.trim());
    if (words.length > 0) {
        const captions = groupWordsIntoCaptions(words);
        const assContent = generateCapcutASS(captions, targetDim.w, targetDim.h);
        const assPath = path.join(tmpDir, `captions_${idx}.ass`);
        fs.writeFileSync(assPath, assContent, 'utf-8');
        console.log(`✅ Caption clip ${idx + 1}:`, captions.length, 'lines');
        try { fs.unlinkSync(audioPath); } catch { }
        return assPath;
    }
    try { fs.unlinkSync(audioPath); } catch { }
    return null;
}

async function composeCropWatermarkCaption(inputVideoPath, outputVideoPath, tmpDir, targetW, assPath) {
    const wmWidth = Math.max(1, Math.round(targetW * 0.30));
    const margin = Math.max(12, Math.round(targetW * 0.03));
    const hasWatermark = fs.existsSync(BRAND_WATERMARK_PATH);

    const ffmpegArgs = ['-y', '-i', inputVideoPath];
    let filterComplex = '';
    let mapVideo = '';

    if (hasWatermark) {
        ffmpegArgs.push('-i', BRAND_WATERMARK_PATH);
        filterComplex = `[0:v]setsar=1[v0];[1:v]scale=${wmWidth}:-1,format=rgba,colorchannelmixer=aa=0.80[wm];[v0][wm]overlay=${margin}:${margin}[v1]`;
        mapVideo = '[v1]';
    } else {
        filterComplex = '[0:v]setsar=1[v1]';
        mapVideo = '[v1]';
    }

    if (assPath && fs.existsSync(assPath)) {
        const assPathEsc = assPath.replace(/\\/g, '/').replace(/:/g, '\\:');
        const fontsDir = path.join(__dirname, '..', 'assets', 'fonts');
        const fontsDirEsc = fontsDir.replace(/\\/g, '/').replace(/:/g, '\\:');
        filterComplex += `;${mapVideo}ass='${assPathEsc}':fontsdir='${fontsDirEsc}'[vout]`;
        mapVideo = '[vout]';
    }

    ffmpegArgs.push(
        '-filter_complex', filterComplex,
        '-map', mapVideo,
        '-map', '0:a?',
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '20',
        '-c:a', 'aac',
        '-b:a', '192k',
        outputVideoPath
    );

    await runCommandWithGpuFallback(ffmpegArgs, tmpDir, 'compose-filter-complex');
}

router.post('/api/convert-ratio', async (req, res) => {
    const { jobId, clipIndex, ratio } = req.body;
    logConvertStage(jobId, `🎬 [Single] Convert request received (${ratio})`);
    const job = getJobData(jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const idx = parseInt(clipIndex);
    if (!RATIO_DIMENSIONS[ratio]) return res.status(400).json({ error: 'Invalid ratio' });
    const clip = job.results[idx];
    const targetDim = RATIO_DIMENSIONS[ratio], ratioTag = ratio.replace(':', 'x');
    const outputFilename = clip.filename.replace('.mp4', `_${ratioTag}.mp4`);
    const outputPath = path.join(OUTPUT_DIR, outputFilename);
    const tmpDir = path.join(DOWNLOADS_DIR, `ratio_${jobId}_${idx}_${ratioTag}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
        const preparedClip = await prepareClipSource(jobId, clip, req.body.endExtendSeconds, tmpDir);
        const videoPath = preparedClip.videoPath;
        if (!fs.existsSync(videoPath)) return res.status(404).json({ error: 'File not found' });
        const dims = await getVideoDimensions(videoPath);
        const duration = preparedClip.duration || clip.duration || 30;
        const detectMode = req.body.detectMode || 'balanced';
        const totalStarted = Date.now();
        logConvertStage(jobId, `🎬 [Single] Stage 1/3 Prepare Smart Crop start (clip ${clip.clip_number})`);
        console.log(`⏱ Stage 1/3 Prepare Smart Crop start | clip=${clip.clip_number} | mode=${detectMode} | ratio=${ratio}`);
        const smartCropStarted = Date.now();
        if (req.body.smartCrop === true && isFaceDetectionReady()) {
            await renderFaceCropLikeApp(videoPath, outputPath, tmpDir, targetDim.w, targetDim.h, detectMode);
        } else {
        let segments;
        if (req.body.smartCrop === true && isFaceDetectionReady()) {
            const result = await computeFaceCrop(videoPath, 0, duration, tmpDir, targetDim.w, targetDim.h, dims.width, dims.height, detectMode);
            segments = Array.isArray(result?.segments) ? result.segments : ((result?.strategy) ? [{ start: 0, end: duration, ...result }] : [{ start: 0, end: duration, strategy: 'safe_mode', data: {} }]);
        } else { segments = [{ start: 0, end: duration, strategy: 'safe_mode', data: {} }]; }

        const segFiles = [];
        for (let si = 0; si < segments.length; si++) {
            const seg = segments[si], segFile = path.join(tmpDir, `seg_${si}.mp4`);
            segFiles.push(segFile);
            let ffmpegArgs;
            if (seg.strategy === 'split_screen') {
                const fc = buildSplitScreenFilter(seg.data.mid_x ? seg.data : seg.data.split_regions, targetDim.w, targetDim.h, dims.width, dims.height, ratio);
                ffmpegArgs = ['-y', '-ss', String(seg.start), '-to', String(seg.end), '-i', videoPath, '-filter_complex', fc + ',setsar=1[out]', '-map', '[out]', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-c:a', 'aac', '-b:a', '192k', segFile];
            } else if (seg.strategy === 'single_crop') {
                const crop = seg.data.crop_region || calculateCenterCrop(dims.width, dims.height, targetDim.w / targetDim.h);
                ffmpegArgs = ['-y', '-ss', String(seg.start), '-to', String(seg.end), '-i', videoPath, '-vf', buildSingleCropFilter(crop, targetDim.w, targetDim.h, dims.width, dims.height), '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-c:a', 'aac', '-b:a', '192k', segFile];
            } else {
                const fc = buildSafeModeFilter(targetDim.w, targetDim.h, dims.width, dims.height);
                ffmpegArgs = ['-y', '-ss', String(seg.start), '-to', String(seg.end), '-i', videoPath, '-filter_complex', fc, '-map', '[out]', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-c:a', 'aac', '-b:a', '192k', segFile];
            }
            await runCommandWithGpuFallback(ffmpegArgs, tmpDir, 'single-convert-segment');
        }
        if (segments.length > 1) { const cl = path.join(tmpDir, 'concat.txt'); fs.writeFileSync(cl, segFiles.map(f => `file '${f.replace(/\\\\/g, '/')}'`).join('\n')); await runCommand(FFMPEG_PATH, ['-y', '-f', 'concat', '-safe', '0', '-i', cl, '-c', 'copy', outputPath], tmpDir); }
        else fs.copyFileSync(segFiles[0], outputPath);
        }
        console.log(`⏱ Stage 1/3 Prepare Smart Crop done in ${((Date.now() - smartCropStarted) / 1000).toFixed(1)}s`);
        logConvertStage(jobId, `✅ [Single] Stage 1/3 Prepare Smart Crop done`);

        const composedPath = path.join(tmpDir, `composed_${Date.now()}.mp4`);

        // === AUTO CAPTION (ElevenLabs STT) ===
        const captionProvider = req.body.captionProvider === 'whisper' ? 'whisper' : 'elevenlabs';
        const canCaption = req.body.autoCaption === true && (captionProvider === 'whisper' || !!req.body.elevenLabsKey);
        logConvertStage(jobId, `🎙 [Single] Stage 2/3 Finalize ${canCaption ? `start (${captionProvider})` : 'skip'}`);
        console.log(`⏱ Stage 2/3 Finalize ${canCaption ? `start (${captionProvider})` : 'skip'}`);
        const captionStarted = Date.now();
        let assPath = null;
        if (canCaption) {
            console.log('🎙 Auto-captioning clip', clip.clip_number, 'with', captionProvider, '...');
            try { assPath = await buildCaptionAss(outputPath, tmpDir, idx, targetDim, req.body); }
            catch (e) { console.log('⚠️ Caption failed (continuing without):', e.message); }
        }
        await composeCropWatermarkCaption(outputPath, composedPath, tmpDir, targetDim.w, assPath);
        fs.copyFileSync(composedPath, outputPath);
        console.log('🏷+🎙 Compose done (crop+watermark+caption in single encode)');
        console.log(`⏱ Stage 2/3 Finalize done in ${((Date.now() - captionStarted) / 1000).toFixed(1)}s`);
        logConvertStage(jobId, `✅ [Single] Stage 2/3 Finalize done`);

        const clipNum = String(clip.clip_number).padStart(2, '0');
        logConvertStage(jobId, `📦 [Single] Stage 3/3 Packaging start`);
        console.log('⏱ Stage 3/3 Packaging start');
        const outputStarted = Date.now();
        // Buffer ZIP for Content-Length (IDM fix)
        const archive = archiver('zip', { zlib: { level: 5 } });
        const chunks = [];
        archive.on('data', chunk => chunks.push(chunk));
        archive.file(outputPath, { name: outputFilename });
        archive.append(`Judul Hook:\n${clip.hook_title}\n\nCaption:\n${clip.caption}\n\nRasio: ${ratio}\n`, { name: `clip${clipNum}_caption.txt` });
        await archive.finalize();
        const buffer = Buffer.concat(chunks);
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Length', buffer.length);
        const zipFilename = `${job.videoTitle}_clip${clipNum}_${ratioTag}.zip`;
        convertArtifacts.set(makeConvertArtifactKey(jobId, 'single', ratio, idx, []), {
            mode: 'single',
            ratio,
            clipIndex: idx,
            zipFilename,
            zipBase64: buffer.toString('base64'),
            videoUrl: `/output/${outputFilename}`,
            filename: outputFilename,
            title: clip.hook_title || '',
            caption: clip.caption || ''
        });
        res.setHeader('Content-Disposition', `attachment; filename="${zipFilename}"`);
        res.setHeader('X-Video-Url', `/output/${outputFilename}`);
        res.setHeader('Access-Control-Expose-Headers', 'X-Video-Url');
        res.end(buffer);
        console.log(`⏱ Stage 3/3 Packaging done in ${((Date.now() - outputStarted) / 1000).toFixed(1)}s`);
        console.log(`⏱ Total convert time ${((Date.now() - totalStarted) / 1000).toFixed(1)}s`);
        logConvertStage(jobId, `✅ [Single] Stage 3/3 Packaging done`);
        setTimeout(() => {
            try { convertArtifacts.delete(makeConvertArtifactKey(jobId, 'single', ratio, idx, [])); } catch { }
            try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { }
        }, 10000);

    } catch (error) {
        console.error('❌ convert-ratio failed:', error && error.stack ? error.stack : error);
        logConvertStage(jobId, `❌ [Single] Convert failed: ${error.message}`);
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { }
        if (!res.headersSent) res.status(500).json({ error: error.message });
    }
});

router.post('/api/convert-ratio-all', async (req, res) => {
    const { jobId, ratio } = req.body;
    logConvertStage(jobId, `🎬 [All] Convert request received (${ratio})`);
    const job = getJobData(jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (!RATIO_DIMENSIONS[ratio]) return res.status(400).json({ error: 'Invalid ratio' });
    const targetDim = RATIO_DIMENSIONS[ratio], ratioTag = ratio.replace(':', 'x');
    const tmpDir = path.join(DOWNLOADS_DIR, `ratio_all_${jobId}_${ratioTag}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
        const selectedIndices = Array.isArray(req.body.selectedIndices) && req.body.selectedIndices.length
            ? req.body.selectedIndices.map(x => parseInt(x, 10)).filter(x => Number.isInteger(x) && x >= 0 && x < job.results.length)
            : null;
        const clipEndExtendMap = req.body.clipEndExtendMap && typeof req.body.clipEndExtendMap === 'object' ? req.body.clipEndExtendMap : {};
        const sourceResults = selectedIndices
            ? selectedIndices.map(i => ({ clip: job.results[i], originalIndex: i })).filter(entry => !!entry.clip)
            : job.results.map((clip, i) => ({ clip, originalIndex: i }));
        const convertedFiles = [];
        logConvertStage(jobId, `🎬 convert-ratio-all mode: staged-parallel | ratio=${ratio} | workers=${CONVERT_WORKERS} | clips=${sourceResults.length}`);
        logConvertStage(jobId, `🎬 [All] Stage 1/3 Prepare Smart Crop start (${sourceResults.length} clips)`);

        const stage1Prepared = await Promise.all(sourceResults.map((entry, idx) => (async () => {
            const clip = entry.clip;
            const outputFilename = clip.filename.replace('.mp4', `_${ratioTag}.mp4`);
            const outputPath = path.join(OUTPUT_DIR, outputFilename);
            const basePath = path.join(tmpDir, `base_${idx}.mp4`);
            const clipTmpDir = path.join(tmpDir, `clip_${idx}`);
            fs.mkdirSync(clipTmpDir, { recursive: true });
            try {
                logConvertStage(jobId, `🎬 [prepare ${idx + 1}/${sourceResults.length}] start | clip=${clip.clip_number}`);
                const preparedClip = await prepareClipSource(jobId, clip, clipEndExtendMap[String(entry.originalIndex)], clipTmpDir);
                const videoPath = preparedClip.videoPath;
                if (!fs.existsSync(videoPath)) return null;
                const dims = await getVideoDimensions(videoPath);
                const duration = preparedClip.duration || clip.duration || 30;
                const detectMode = req.body.detectMode || 'balanced';
                logConvertStage(jobId, `⚡️ QSV encode attempt: smart-crop-merge`);

                if (req.body.smartCrop === true && isFaceDetectionReady()) {
                    await renderFaceCropLikeApp(videoPath, basePath, clipTmpDir, targetDim.w, targetDim.h, detectMode);
                } else if (false && req.body.smartCrop === true && isFaceDetectionReady()) {
                    const result = await computeFaceCrop(videoPath, 0, duration, clipTmpDir, targetDim.w, targetDim.h, dims.width, dims.height, detectMode);
                    let segments = Array.isArray(result?.segments) ? result.segments : ((result?.strategy) ? [{ start: 0, end: duration, ...result }] : [{ start: 0, end: duration, strategy: 'safe_mode', data: {} }]);
                    for (let si = 0; si < segments.length; si++) {
                        const seg = segments[si], segFile = path.join(clipTmpDir, `seg_${si}.mp4`);
                        segFiles.push(segFile);
                        let ffmpegArgs;
                        if (seg.strategy === 'split_screen') {
                            const fc = buildSplitScreenFilter(seg.data.mid_x ? seg.data : seg.data.split_regions, targetDim.w, targetDim.h, dims.width, dims.height, ratio);
                            ffmpegArgs = ['-y', '-ss', String(seg.start), '-to', String(seg.end), '-i', videoPath, '-filter_complex', fc + ',setsar=1[out]', '-map', '[out]', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-c:a', 'aac', '-b:a', '192k', segFile];
                        } else if (seg.strategy === 'single_crop') {
                            const crop = seg.data.crop_region || calculateCenterCrop(dims.width, dims.height, targetDim.w / targetDim.h);
                            ffmpegArgs = ['-y', '-ss', String(seg.start), '-to', String(seg.end), '-i', videoPath, '-vf', buildSingleCropFilter(crop, targetDim.w, targetDim.h, dims.width, dims.height), '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-c:a', 'aac', '-b:a', '192k', segFile];
                        } else {
                            const fc = buildSafeModeFilter(targetDim.w, targetDim.h, dims.width, dims.height);
                            ffmpegArgs = ['-y', '-ss', String(seg.start), '-to', String(seg.end), '-i', videoPath, '-filter_complex', fc, '-map', '[out]', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-c:a', 'aac', '-b:a', '192k', segFile];
                        }
                        await runCommandWithGpuFallback(ffmpegArgs, clipTmpDir, 'legacy-segment');
                    }
                    if (segments.length > 1) { const cl = path.join(clipTmpDir, 'concat.txt'); fs.writeFileSync(cl, segFiles.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n')); await runCommand(FFMPEG_PATH, ['-y', '-f', 'concat', '-safe', '0', '-i', cl, '-c', 'copy', outputPath], clipTmpDir); }
                    else fs.copyFileSync(segFiles[0], outputPath);
                } else {
                    const fc = buildSafeModeFilter(targetDim.w, targetDim.h, dims.width, dims.height);
                    await runCommandWithGpuFallback(['-y', '-i', videoPath, '-filter_complex', fc, '-map', '[out]', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-c:a', 'aac', '-b:a', '192k', basePath], tmpDir, 'all-safe-mode');
                }

                logConvertStage(jobId, `✅ [All] Smart crop ready ${idx + 1}/${sourceResults.length} (clip ${clip.clip_number})`);
                logConvertStage(jobId, `🎬 [prepare ${idx + 1}/${sourceResults.length}] done`);
                return { idx, clip, outputPath, outputFilename, basePath };
            } catch (e) { console.error(`❌ Failed clip ${idx + 1}:`, e.message); return null; }
        })()));

        const filteredStage1 = stage1Prepared.filter(Boolean);
        logConvertStage(jobId, `✅ [All] Stage 1/3 Prepare Smart Crop done (${filteredStage1.length}/${sourceResults.length})`);
        logConvertStage(jobId, `🎬 [All] Stage 2/3 Finalize start (watermark + caption)`);

        await runWithConcurrency(filteredStage1, CONVERT_WORKERS, async ({ idx, clip, outputPath, outputFilename, basePath }) => {
            const clipWorkDir = path.join(tmpDir, `final_${idx}`);
            fs.mkdirSync(clipWorkDir, { recursive: true });
            try {
                logConvertStage(jobId, `🎬 [finalize ${idx + 1}/${sourceResults.length}] start | clip=${clip.clip_number}`);
                logConvertStage(jobId, `🏷 [All] Finalizing ${idx + 1}/${sourceResults.length} (watermark + caption)`);
                fs.copyFileSync(basePath, outputPath);
                let assPath = null;
                try {
                    assPath = await buildCaptionAss(outputPath, clipWorkDir, idx, targetDim, req.body);
                    if (assPath && fs.existsSync(assPath)) {
                        const assContent = fs.readFileSync(assPath, 'utf-8');
                        const captionLineCount = (assContent.match(/Dialogue:/g) || []).length;
                        logConvertStage(jobId, `✅ Caption clip ${idx + 1}: ${captionLineCount} lines`);
                    }
                } catch (e) { console.log(`⚠️ Caption clip ${idx + 1} failed:`, e.message); }
                const composedPath = path.join(clipWorkDir, `composed_${idx}.mp4`);
                await composeCropWatermarkCaption(outputPath, composedPath, clipWorkDir, targetDim.w, assPath);
                fs.copyFileSync(composedPath, outputPath);
                logConvertStage(jobId, `✅ [All] Finalize done ${idx + 1}/${sourceResults.length} (clip ${clip.clip_number})`);
                convertedFiles.push({ outputPath, outputFilename, clip });
                logConvertStage(jobId, `🎬 [finalize ${idx + 1}/${sourceResults.length}] done`);
            } catch (e) {
                console.error(`❌ Failed finalize clip ${idx + 1}:`, e.message);
            }
        });

        if (convertedFiles.length === 0) throw new Error('No clips converted');
        convertedFiles.sort((a, b) => (a.clip.clip_number || 0) - (b.clip.clip_number || 0));
        logConvertStage(jobId, `✅ [All] Stage 2/3 Finalize done`);
        logConvertStage(jobId, `📦 [All] Stage 3/3 Packaging start`);
        // Buffer ZIP for Content-Length (IDM fix)
        const archive = archiver('zip', { zlib: { level: 5 } });
        const chunks = [];
        archive.on('data', chunk => chunks.push(chunk));
        convertedFiles.forEach(({ outputPath: op, outputFilename: of, clip }) => {
            if (fs.existsSync(op)) archive.file(op, { name: `clips_${ratioTag}/${of}` });
            archive.append(`Judul Hook:\n${clip.hook_title}\n\nCaption:\n${clip.caption}\n`, { name: `clips_${ratioTag}/clip${String(clip.clip_number).padStart(2, '0')}_caption.txt` });
        });
        await archive.finalize();
        const buffer = Buffer.concat(chunks);
        const artifactSelectedIndices = selectedIndices || sourceResults.map(({ originalIndex }) => originalIndex);
        const zipFilename = `${job.videoTitle}_all_${ratioTag}.zip`;
        convertArtifacts.set(makeConvertArtifactKey(jobId, 'all', ratio, '', artifactSelectedIndices), {
            mode: 'all',
            ratio,
            selectedIndices: artifactSelectedIndices,
            zipFilename,
            zipBase64: buffer.toString('base64'),
            clips: sourceResults.map(({ clip, originalIndex }) => Object.assign({}, clip, { originalIndex }))
        });
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Length', buffer.length);
        res.setHeader('Content-Disposition', `attachment; filename="${zipFilename}"`);
        res.end(buffer);
        logConvertStage(jobId, `✅ [All] Stage 3/3 Packaging done`);
        setTimeout(() => {
            try { convertArtifacts.delete(makeConvertArtifactKey(jobId, 'all', ratio, '', artifactSelectedIndices)); } catch { }
            try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { }
        }, 10000);
    } catch (error) {
        console.error('❌ bulk convert failed:', error && error.stack ? error.stack : error);
        logConvertStage(jobId, `❌ [All] Convert failed: ${error.message}`);
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { }
        if (!res.headersSent) res.status(500).json({ error: error.message });
    }
});

module.exports = router;
