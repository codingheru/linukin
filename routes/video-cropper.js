const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const { runCommand, fetchJSON, FFMPEG_PATH, FFPROBE_PATH, even, parseVTTToCaptions } = require('../lib/utils');
const { detectFacesInClip } = require('../lib/face-detection');
const { generateCapcutASS } = require('./video-cropper-helpers');

const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
const PROCESSED_DIR = path.join(__dirname, '..', 'processed');
const OUTPUT_DIR = path.join(__dirname, '..', 'output');
const DOWNLOADS_DIR = path.join(__dirname, '..', 'downloads');
const CROPPER_HISTORY_DIR = path.join(__dirname, '..', 'history', 'cropper');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(PROCESSED_DIR, { recursive: true });
fs.mkdirSync(CROPPER_HISTORY_DIR, { recursive: true });

const upload = multer({ dest: UPLOADS_DIR });

function normalizeEndExtendSeconds(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return 0;
    return Math.max(0, Math.min(90, Math.round(num * 2) / 2));
}

async function getMediaDuration(filePath, cwd) {
    const probeResult = await runCommand(FFPROBE_PATH, ['-v', 'quiet', '-print_format', 'json', '-show_format', filePath], cwd || UPLOADS_DIR);
    const probeData = JSON.parse(probeResult.stdout || '{}');
    return parseFloat((probeData.format && probeData.format.duration) || '0') || 0;
}

async function prepareCropperInputClip({ filename, jobId, clipStartTime, clipEndTime, endExtendSeconds, inputPath }) {
    const baseClipPath = path.join(OUTPUT_DIR, filename);
    const extraSeconds = normalizeEndExtendSeconds(endExtendSeconds);
    if (extraSeconds <= 0) {
        fs.copyFileSync(baseClipPath, inputPath);
        return { effectiveClipEndTime: Number(clipEndTime || 0) };
    }

    const sourceVideoPath = path.join(DOWNLOADS_DIR, jobId || '', 'video.mp4');
    if (!jobId || !fs.existsSync(sourceVideoPath)) {
        throw new Error('Sumber video asli sudah tidak tersedia untuk tambah akhir. Jalankan analyze ulang lalu coba lagi.');
    }

    const clipStart = Math.max(0, Number(clipStartTime || 0));
    const baseEnd = Math.max(clipStart, Number(clipEndTime || clipStart));
    const sourceDuration = await getMediaDuration(sourceVideoPath, DOWNLOADS_DIR);
    const effectiveClipEndTime = sourceDuration > 0 ? Math.min(sourceDuration, baseEnd) : baseEnd;
    const duration = Math.max(0.1, effectiveClipEndTime - clipStart);

    await runCommand(FFMPEG_PATH, ['-y', '-ss', String(clipStart), '-t', String(duration), '-i', sourceVideoPath, '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-c:a', 'aac', '-b:a', '192k', inputPath], UPLOADS_DIR);
    return { effectiveClipEndTime };
}

// === LOAD CLIP FROM YOUTUBE CUTTER ===
router.post('/api/cropper/load-clip', async (req, res) => {
    const { filename, autoDetect, jobId, clipStartTime, clipEndTime, detectMode, endExtendSeconds } = req.body;
    if (!filename) return res.status(400).json({ error: 'Missing filename' });

    const srcPath = path.join(OUTPUT_DIR, filename);
    if (!fs.existsSync(srcPath)) return res.status(404).json({ error: 'Clip file not found' });

    const fileId = uuidv4();
    const ext = path.extname(filename) || '.mp4';
    const inputPath = path.join(UPLOADS_DIR, `${fileId}${ext}`);

    try {
        const preparedClip = await prepareCropperInputClip({ filename, jobId, clipStartTime, clipEndTime, endExtendSeconds, inputPath });
        const probeResult = await runCommand(FFPROBE_PATH, ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', inputPath], UPLOADS_DIR);
        const probeData = JSON.parse(probeResult.stdout);
        const vs = probeData.streams.find(s => s.codec_type === 'video');
        const width = parseInt(vs.width), height = parseInt(vs.height);
        const duration = parseFloat(probeData.format.duration);
        const fps = vs.avg_frame_rate ? eval(vs.avg_frame_rate) : 30;

        // Extract frames
        const framesDir = path.join(UPLOADS_DIR, fileId);
        fs.mkdirSync(framesDir, { recursive: true });
        await runCommand(FFMPEG_PATH, ['-i', inputPath, '-vf', "select='not(mod(n\\,10))'", '-vsync', 'vfr', '-q:v', '4', path.join(framesDir, 'frame_%04d.jpg')], UPLOADS_DIR);
        const frames = fs.readdirSync(framesDir).filter(f => f.endsWith('.jpg')).sort();
        const frameUrls = frames.map(f => `/uploads/${fileId}/${f}`);

        const result = { file_id: fileId, filename, width, height, duration, frames: frameUrls, fps };

        // Smart detection for auto-config (face → motion → body per frame)
        if (autoDetect) {
            try {
                const { detectFacesInFiles, initFaceDetection, normalizeDetectMode } = require('../lib/face-detection');
                await initFaceDetection();
                const mode = normalizeDetectMode(detectMode);
                const framePaths = frames.map(f => path.join(framesDir, f));
                const rawFaceResults = detectFacesInFiles(framePaths, mode);
                const stats = { face: rawFaceResults.filter(faces => faces.length > 0).length, none: rawFaceResults.filter(faces => faces.length === 0).length };
                // Post-process: stabilize configs using dominant face count + gap filling
                const autoConfigs = stabilizeAutoConfigs(rawFaceResults, width, height);
                console.log(`🎯 Smart detect [${mode}]: face=${stats.face} none=${stats.none} (${frames.length} frames)`);
                result.auto_configs = autoConfigs;
                result.detect_mode = mode;
            } catch (e) { console.log('Face detection not available:', e.message); }
        }

        // Extract YouTube captions for this clip's time range
        if (jobId && clipStartTime != null && clipEndTime != null) {
            const jobDir = path.join(DOWNLOADS_DIR, jobId);
            const vttPath = path.join(jobDir, 'raw_captions.vtt');
            const effectiveClipEndTime = preparedClip.effectiveClipEndTime;
            if (fs.existsSync(vttPath)) {
                try {
                    const vttContent = fs.readFileSync(vttPath, 'utf-8');
                    const captions = parseVTTToCaptions(vttContent, parseFloat(clipStartTime), parseFloat(effectiveClipEndTime));
                    if (captions.length > 0) result.captions = captions;
                } catch (e) { console.log('Caption extraction error:', e.message); }
            }
            // Also check for yt-dlp downloaded VTT files
            if (!result.captions && fs.existsSync(jobDir)) {
                const vttFiles = fs.readdirSync(jobDir).filter(f => f.endsWith('.vtt') && !f.includes('raw_captions'));
                for (const vf of vttFiles) {
                    try {
                        const vttContent = fs.readFileSync(path.join(jobDir, vf), 'utf-8');
                        const captions = parseVTTToCaptions(vttContent, parseFloat(clipStartTime), parseFloat(effectiveClipEndTime));
                        if (captions.length > 0) { result.captions = captions; break; }
                    } catch (e) { }
                }
            }
        }

        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// === UPLOAD VIDEO ===
router.post('/api/cropper/upload', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const fileId = uuidv4();
    const ext = path.extname(req.file.originalname) || '.mp4';
    const inputPath = path.join(UPLOADS_DIR, `${fileId}${ext}`);
    fs.renameSync(req.file.path, inputPath);
    const autoDetect = req.body.auto_detect === 'true';
    const detectMode = req.body.detect_mode;

    try {
        const probeResult = await runCommand(FFPROBE_PATH, ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', inputPath], UPLOADS_DIR);
        const probeData = JSON.parse(probeResult.stdout);
        const vs = probeData.streams.find(s => s.codec_type === 'video');
        const width = parseInt(vs.width), height = parseInt(vs.height);
        const duration = parseFloat(probeData.format.duration);
        const fps = vs.avg_frame_rate ? eval(vs.avg_frame_rate) : 30;

        // Extract frames
        const framesDir = path.join(UPLOADS_DIR, fileId);
        fs.mkdirSync(framesDir, { recursive: true });
        await runCommand(FFMPEG_PATH, ['-i', inputPath, '-vf', "select='not(mod(n\\,10))'", '-vsync', 'vfr', '-q:v', '4', path.join(framesDir, 'frame_%04d.jpg')], UPLOADS_DIR);
        const frames = fs.readdirSync(framesDir).filter(f => f.endsWith('.jpg')).sort();
        const frameUrls = frames.map(f => `/uploads/${fileId}/${f}`);

        const result = { file_id: fileId, filename: req.file.originalname, width, height, duration, frames: frameUrls, fps };

        // Smart detection for auto-config (face → motion → body per frame)
        if (autoDetect) {
            const { detectFacesInFiles, initFaceDetection, normalizeDetectMode } = require('../lib/face-detection');
            await initFaceDetection();
            const mode = normalizeDetectMode(detectMode);
            const framePaths = frames.map(f => path.join(framesDir, f));
            const rawFaceResults = detectFacesInFiles(framePaths, mode);
            const stats = { face: rawFaceResults.filter(faces => faces.length > 0).length, none: rawFaceResults.filter(faces => faces.length === 0).length };
            const autoConfigs = stabilizeAutoConfigs(rawFaceResults, width, height);
            console.log(`🎯 Smart detect [${mode}]: face=${stats.face} none=${stats.none} (${frames.length} frames)`);
            result.auto_configs = autoConfigs;
            result.detect_mode = mode;
        }

        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ============================================================
// STABILIZE AUTO CONFIGS — scene-level consistency
// Uses sliding window to propagate max face count within a scene.
// If nearby frames detect 2 faces, all frames in that scene
// should also be 2 faces (prevents flickering between single/split)
// ============================================================
function stabilizeAutoConfigs(rawFaceResults, vidW, vidH) {
    const autoConfigs = {};
    const total = rawFaceResults.length;
    if (total === 0) return autoConfigs;

    // Stats
    const countMap = { 0: 0, 1: 0, 2: 0 };
    rawFaceResults.forEach(faces => {
        countMap[Math.min(faces.length, 2)]++;
    });
    console.log(`   🧮 Face stats: 0=${countMap[0]} 1=${countMap[1]} 2=${countMap[2]} / ${total} frames`);

    // Step 1: Fill 0-face frames from nearest neighbor
    const filledFaces = rawFaceResults.map((faces, i) => {
        if (faces.length > 0) return faces;
        for (let d = 1; d < total; d++) {
            if (i - d >= 0 && rawFaceResults[i - d].length > 0) return rawFaceResults[i - d];
            if (i + d < total && rawFaceResults[i + d].length > 0) return rawFaceResults[i + d];
        }
        return [];
    });

    // Step 2: Scene-level consistency — only fill GAPS between 2-face scenes
    // Only upgrade 1-face → 2-face if 2-face exists on BOTH sides (prevents scene boundary bleed)
    const WINDOW = 3;
    const stableFaces = filledFaces.map((faces, i) => {
        if (faces.length >= 2) return faces;  // already 2+, keep

        // Check for 2-face frames on LEFT and RIGHT separately
        let hasLeft = false, hasRight = false;
        for (let d = 1; d <= WINDOW; d++) {
            if (i - d >= 0 && filledFaces[i - d].length >= 2) hasLeft = true;
            if (i + d < total && filledFaces[i + d].length >= 2) hasRight = true;
        }

        if (!hasLeft || !hasRight) return faces;  // only one side → scene boundary, don't upgrade

        // Both sides have 2-face → we're inside a 2-face scene gap, upgrade
        for (let d = 1; d < total; d++) {
            if (i - d >= 0 && filledFaces[i - d].length >= 2) return filledFaces[i - d];
            if (i + d < total && filledFaces[i + d].length >= 2) return filledFaces[i + d];
        }
        return faces;
    });

    // Step 3: Build configs
    for (let i = 0; i < total; i++) {
        autoConfigs[i] = buildAutoConfig(stableFaces[i], vidW, vidH);
    }

    // Log mode distribution
    const modes = { single: 0, split: 0, free: 0 };
    for (let i = 0; i < total; i++) modes[autoConfigs[i].mode]++;
    console.log(`   📊 Crop modes: single=${modes.single} split=${modes.split} free=${modes.free}`);

    return autoConfigs;
}

function buildAutoConfig(faces, vidW, vidH) {
    // Single: 9:16 crop | Split: 9:8 crop per half (each half = 1080x960 in output)
    const singleAR = 9 / 16;
    const splitAR = 9 / 8;
    const videoAR = vidW / vidH;

    // Compute normalized crop size for given aspect ratio
    function cropSize(targetAR) {
        if (videoAR > targetAR) return { w: targetAR / videoAR, h: 1.0 };
        return { w: 1.0, h: videoAR / targetAR };
    }

    const singleCrop = cropSize(singleAR);
    const splitCrop = cropSize(splitAR);

    if (faces.length === 0 || faces.length > 2) return { mode: 'free', crop1: { x: 0, y: 0, w: 1, h: 1 } };
    if (faces.length === 1) {
        const f = faces[0];
        const faceCx = (f.x + f.width / 2) / vidW;
        const cropX = Math.max(0, Math.min(faceCx - singleCrop.w / 2, 1 - singleCrop.w));
        return { mode: 'single', crop1: { x: Math.round(cropX * 10000) / 10000, y: 0, w: singleCrop.w, h: singleCrop.h } };
    }
    return {
        mode: 'split',
        crop1: { x: 0, y: 0, w: 0.5, h: 1 },
        crop2: { x: 0.5, y: 0, w: 0.5, h: 1 }
    };
}


// === CAPCUT-STYLE ASS SUBTITLE GENERATOR ===
// generateCapcutASS and formatASSTime are imported from video-cropper-helpers.js

// === CROPPER RELOAD (for history) ===
// Check if original upload still exists and return frame URLs + metadata
router.post('/api/cropper/reload', async (req, res) => {
    const { file_id } = req.body;
    if (!file_id) return res.json({ success: false, error: 'Missing file_id' });
    try {
        // Check frames directory still exists
        const framesDir = path.join(UPLOADS_DIR, file_id);
        if (!fs.existsSync(framesDir)) return res.json({ success: false, error: 'Upload not found' });
        const frames = fs.readdirSync(framesDir).filter(f => f.endsWith('.jpg')).sort();
        if (frames.length === 0) return res.json({ success: false, error: 'No frames found' });
        const frameUrls = frames.map(f => `/uploads/${file_id}/${f}`);

        // Find original video to get metadata
        let inputPath = '';
        let filename = file_id;
        for (const f of fs.readdirSync(UPLOADS_DIR)) {
            if (f.startsWith(file_id) && f.includes('.') && !fs.statSync(path.join(UPLOADS_DIR, f)).isDirectory()) {
                inputPath = path.join(UPLOADS_DIR, f); filename = f; break;
            }
        }
        if (!inputPath) return res.json({ success: false, error: 'Source video missing' });

        const { runCommand, FFPROBE_PATH } = require('../lib/utils');
        const probeResult = await runCommand(FFPROBE_PATH, ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', inputPath], UPLOADS_DIR);
        const probeData = JSON.parse(probeResult.stdout);
        const vs = probeData.streams.find(s => s.codec_type === 'video');
        const width = parseInt(vs.width), height = parseInt(vs.height);
        const duration = parseFloat(probeData.format.duration);
        const fps = vs.avg_frame_rate ? eval(vs.avg_frame_rate) : 30;

        res.json({ success: true, file_id, filename, width, height, duration, frames: frameUrls, fps });
    } catch (e) { res.json({ success: false, error: e.message }); }
});

// Save history after upload (lightweight, no config yet)
router.post('/api/cropper/history-save', (req, res) => {
    try {
        const { file_id, filename, duration, thumbnail } = req.body;
        if (!file_id) return res.json({ success: false });
        const filePath = path.join(CROPPER_HISTORY_DIR, file_id + '.json');
        // Don't overwrite if already has export data
        if (fs.existsSync(filePath)) {
            const existing = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            if (existing.video_url) return res.json({ success: true, id: file_id });
        }
        const entry = { id: file_id, filename: filename || file_id, duration: duration || 0, thumbnail: thumbnail || '', config: {}, video_url: '', date: new Date().toISOString() };
        fs.writeFileSync(filePath, JSON.stringify(entry, null, 2), 'utf-8');
        console.log('[CROPPER HISTORY] Saved on upload:', file_id);
        res.json({ success: true, id: file_id });
    } catch (e) { res.json({ success: false, error: e.message }); }
});

// === CROPPER HISTORY ENDPOINTS ===
router.get('/api/cropper/history', (req, res) => {
    try {
        const files = fs.readdirSync(CROPPER_HISTORY_DIR).filter(f => f.endsWith('.json'));
        const entries = files.map(f => {
            try {
                const d = JSON.parse(fs.readFileSync(path.join(CROPPER_HISTORY_DIR, f), 'utf-8'));
                return { id: d.id, filename: d.filename, duration: d.duration, video_url: d.video_url, thumbnail: d.thumbnail, date: d.date };
            } catch (e) { return null; }
        }).filter(Boolean).sort((a, b) => new Date(b.date) - new Date(a.date));
        res.json({ success: true, entries });
    } catch (e) { res.json({ success: false, error: e.message }); }
});

router.get('/api/cropper/history/:id', (req, res) => {
    try {
        const filePath = path.join(CROPPER_HISTORY_DIR, req.params.id + '.json');
        if (!fs.existsSync(filePath)) return res.json({ success: false, error: 'Not found' });
        res.json({ success: true, ...JSON.parse(fs.readFileSync(filePath, 'utf-8')) });
    } catch (e) { res.json({ success: false, error: e.message }); }
});

router.delete('/api/cropper/history/:id', (req, res) => {
    try {
        const filePath = path.join(CROPPER_HISTORY_DIR, req.params.id + '.json');
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        res.json({ success: true });
    } catch (e) { res.json({ success: false, error: e.message }); }
});

// === PROCESS VIDEO ===
router.post('/api/cropper/process', async (req, res) => {
    const { file_id, config, captions, watermark } = req.body;
    if (!file_id || !config) return res.json({ success: false, error: 'Missing file_id or config' });

    let inputPath = '';
    for (const f of fs.readdirSync(UPLOADS_DIR)) {
        if (f.startsWith(file_id) && f.includes('.') && !fs.statSync(path.join(UPLOADS_DIR, f)).isDirectory()) {
            inputPath = path.join(UPLOADS_DIR, f); break;
        }
    }
    if (!inputPath) return res.json({ success: false, error: 'Input file not found' });

    try {
        const probeResult = await runCommand(FFPROBE_PATH, ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', inputPath], UPLOADS_DIR);
        const probeData = JSON.parse(probeResult.stdout);
        const vs = probeData.streams.find(s => s.codec_type === 'video');
        const vid_w = parseInt(vs.width), vid_h = parseInt(vs.height);
        const duration = parseFloat(probeData.format.duration);
        const vid_fps = vs.avg_frame_rate ? eval(vs.avg_frame_rate) : 30;

        const outputFilename = `out_${file_id}.mp4`;
        const outputPath = path.join(PROCESSED_DIR, outputFilename);
        const segDur = 10.0 / vid_fps;
        const sortedIdxs = Object.keys(config).map(Number).sort((a, b) => a - b);

        // FACE TRACKING: resample at ~2 second intervals with responsive smoothing
        // This gives ~30-50 segments per video (not 900 tiny ones, not 1-2 giant static ones)
        const CHUNK_FRAMES = Math.max(1, Math.round(2.0 / segDur)); // ~2 seconds per chunk
        const ALPHA = 0.35; // responsive smoothing (higher = follows face better)

        // Step 1: Collect raw positions per mode
        function getRawPositions(idxs, getPos) {
            return idxs.map(idx => getPos(config[String(idx)]));
        }

        // Step 2: Smooth with simple forward EMA (responsive, no dead zone)
        function emaSmooth(rawVals) {
            if (rawVals.length <= 1) return rawVals.slice();
            const out = [rawVals[0]];
            for (let i = 1; i < rawVals.length; i++) {
                out.push(out[i - 1] + ALPHA * (rawVals[i] - out[i - 1]));
            }
            return out;
        }

        // Step 3: Resample at CHUNK_FRAMES intervals (pick value at chunk boundary)
        // This creates longer segments while preserving motion
        const mergedChunks = [];

        // Group sortedIdxs into chunks of CHUNK_FRAMES
        for (let chunkStart = 0; chunkStart < sortedIdxs.length; chunkStart += CHUNK_FRAMES) {
            const chunkEnd = Math.min(chunkStart + CHUNK_FRAMES, sortedIdxs.length);
            const startIdx = sortedIdxs[chunkStart];
            const endIdx = sortedIdxs[chunkEnd - 1];
            const tStart = Math.round(startIdx * segDur * 1000) / 1000;
            const tEnd = Math.round(Math.min((endIdx + 1) * segDur, duration) * 1000) / 1000;

            // Use the MIDDLE frame's config for this chunk's crop position
            const midFrame = sortedIdxs[Math.floor((chunkStart + chunkEnd) / 2)];
            const cfg = config[String(midFrame)];
            mergedChunks.push({ tStart, tEnd, cfg });
        }

        // Step 4: Apply EMA smoothing across chunk positions
        // Single mode
        const singleChunks = mergedChunks.filter(c => c.cfg.mode === 'single');
        if (singleChunks.length > 1) {
            const rawX = singleChunks.map(c => c.cfg.crop1.x * vid_w);
            const rawY = singleChunks.map(c => c.cfg.crop1.y * vid_h);
            const sx = emaSmooth(rawX), sy = emaSmooth(rawY);
            singleChunks.forEach((c, i) => { c._cx = even(sx[i]); c._cy = even(sy[i]); });
        }
        // Split mode
        const splitChunks = mergedChunks.filter(c => c.cfg.mode === 'split' && c.cfg.crop2);
        if (splitChunks.length > 1) {
            const r1x = splitChunks.map(c => c.cfg.crop1.x * vid_w);
            const r1y = splitChunks.map(c => c.cfg.crop1.y * vid_h);
            const r2x = splitChunks.map(c => c.cfg.crop2.x * vid_w);
            const r2y = splitChunks.map(c => c.cfg.crop2.y * vid_h);
            const s1x = emaSmooth(r1x), s1y = emaSmooth(r1y);
            const s2x = emaSmooth(r2x), s2y = emaSmooth(r2y);
            splitChunks.forEach((c, i) => {
                c._cx = even(s1x[i]); c._cy = even(s1y[i]);
                c._cx2 = even(s2x[i]); c._cy2 = even(s2y[i]);
            });
        }

        console.log(`📐 Resampled ${sortedIdxs.length} frames → ${mergedChunks.length} chunks (${CHUNK_FRAMES} frames/chunk, ~${(CHUNK_FRAMES * segDur).toFixed(1)}s each)`);

        // Build filter from merged chunks (dramatically fewer segments = no stutter)
        const filterParts = [], audioParts = [];
        for (let i = 0; i < mergedChunks.length; i++) {
            const ch = mergedChunks[i];
            const cfg = ch.cfg;
            const c1 = cfg.crop1;
            let cw = even(c1.w * vid_w), chh = even(c1.h * vid_h);
            let cx = ch._cx != null ? ch._cx : even(c1.x * vid_w);
            let cy = ch._cy != null ? ch._cy : even(c1.y * vid_h);
            cx = Math.max(0, Math.min(cx, vid_w - cw));
            cy = Math.max(0, Math.min(cy, vid_h - chh));
            cw = Math.max(2, Math.min(cw, vid_w - cx));
            chh = Math.max(2, Math.min(chh, vid_h - cy));

            if (cfg.mode === 'single') {
                filterParts.push(`[0:v]trim=start=${ch.tStart}:end=${ch.tEnd},setpts=PTS-STARTPTS,crop=${cw}:${chh}:${cx}:${cy},scale=1080:1920,setsar=1[v${i}]`);
            } else if (cfg.mode === 'split' && cfg.crop2) {
                const c2 = cfg.crop2;
                let cw2 = even(c2.w * vid_w), ch2 = even(c2.h * vid_h);
                let cx2 = ch._cx2 != null ? ch._cx2 : even(c2.x * vid_w);
                let cy2 = ch._cy2 != null ? ch._cy2 : even(c2.y * vid_h);
                cx2 = Math.max(0, Math.min(cx2, vid_w - cw2));
                cy2 = Math.max(0, Math.min(cy2, vid_h - ch2));
                cw2 = Math.max(2, Math.min(cw2, vid_w - cx2));
                ch2 = Math.max(2, Math.min(ch2, vid_h - cy2));

                let f = `[0:v]trim=start=${ch.tStart}:end=${ch.tEnd},setpts=PTS-STARTPTS,split=2[s${i}a][s${i}b];`;
                f += `[s${i}a]crop=${cw}:${chh}:${cx}:${cy},scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960:(iw-1080)/2:(ih-960)/2,setsar=1[v${i}a];`;
                f += `[s${i}b]crop=${cw2}:${ch2}:${cx2}:${cy2},scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960:(iw-1080)/2:(ih-960)/2,setsar=1[v${i}b];`;
                f += `[v${i}a][v${i}b]vstack=inputs=2,scale=1080:1920,setsar=1[v${i}]`;
                filterParts.push(f);
            } else {
                // free mode: blurred background
                const blurW = Math.min(even(vid_h * 9 / 16), vid_w);
                const blurX = even((vid_w - blurW) / 2);
                const scaledH = even(1080 * vid_h / vid_w);
                const overlayY = even((1920 - scaledH) / 2);
                let f = `[0:v]trim=start=${ch.tStart}:end=${ch.tEnd},setpts=PTS-STARTPTS,split=2[bg${i}][fg${i}];`;
                f += `[bg${i}]crop=${blurW}:${vid_h}:${blurX}:0,scale=1080:1920,setsar=1,boxblur=30:5[bg_b${i}];`;
                f += `[fg${i}]scale=1080:${scaledH},setsar=1[fg_s${i}];`;
                f += `[bg_b${i}][fg_s${i}]overlay=0:${overlayY},setsar=1[v${i}]`;
                filterParts.push(f);
            }
            audioParts.push(`[0:a]atrim=start=${ch.tStart}:end=${ch.tEnd},asetpts=PTS-STARTPTS[a${i}]`);
        }

        // Build concat
        const n = mergedChunks.length;

        // Check if video has audio stream
        const hasAudio = probeData.streams.some(s => s.codec_type === 'audio');

        let fullFilter = filterParts.join(';');
        if (hasAudio) {
            fullFilter += ';' + audioParts.join(';');
        }
        fullFilter += ';';

        if (hasAudio) {
            const concatV = Array.from({ length: n }, (_, i) => `[v${i}][a${i}]`).join('');
            fullFilter += `${concatV}concat=n=${n}:v=1:a=1[vconcat][aout]`;
        } else {
            const concatV = Array.from({ length: n }, (_, i) => `[v${i}]`).join('');
            fullFilter += `${concatV}concat=n=${n}:v=1:a=0[vconcat]`;
        }

        if (captions && captions.length > 0) {
            // Generate CapCut-style ASS subtitles with word-by-word karaoke animation
            const assPath = path.join(PROCESSED_DIR, `subs_${file_id}.ass`);
            const assContent = generateCapcutASS(captions, 1080, 1920);
            fs.writeFileSync(assPath, assContent, 'utf-8');
            // Use just filename (cwd is PROCESSED_DIR) to avoid Windows path escaping
            const assFilename = `subs_${file_id}.ass`;
            const captionOut = (watermark && watermark.data) ? '[vcap]' : '[vout]';
            fullFilter += `;[vconcat]ass=filename=${assFilename}${captionOut}`;
        } else {
            if (watermark && watermark.data) {
                fullFilter += `;[vconcat]null[vcap]`;
            }
            // else: vconcat is used directly as vout via mapping below
        }

        // Watermark overlay filter
        if (watermark && watermark.data) {
            const wmSize = Math.max(5, Math.min(50, watermark.size || 20));
            const wmOpacity = Math.max(10, Math.min(100, watermark.opacity || 80));
            const wmW = Math.round(1080 * wmSize / 100); // scale to percentage of output width
            const margin = Math.round(1080 * 0.03); // 3% margin from edge
            const opacityVal = (wmOpacity / 100).toFixed(2);
            // Scale watermark, set opacity, overlay at top-left with margin
            fullFilter += `;[1:v]scale=${wmW}:-1,format=rgba,colorchannelmixer=aa=${opacityVal}[wmscaled]`;
            fullFilter += `;[vcap][wmscaled]overlay=${margin}:${margin}[vout]`;
        }

        // Determine final video output label
        const hasWatermark = watermark && watermark.data;
        const hasCaptions = captions && captions.length > 0;
        const finalVideoLabel = (hasCaptions || hasWatermark) ? '[vout]' : '[vconcat]';

        // Watermark: save image and apply overlay
        let wmPath = '';
        let wmFilename = '';
        if (watermark && watermark.data) {
            wmFilename = `wm_${file_id}.png`;
            wmPath = path.join(PROCESSED_DIR, wmFilename);
            const wmBase64 = watermark.data.replace(/^data:image\/\w+;base64,/, '');
            fs.writeFileSync(wmPath, Buffer.from(wmBase64, 'base64'));
        }

        const filterPath = path.join(PROCESSED_DIR, `filter_${file_id}.txt`);
        fs.writeFileSync(filterPath, fullFilter, 'utf-8');
        console.log('[FFMPEG FILTER]', fullFilter.substring(0, 500));

        // Build FFmpeg args
        const ffArgs = ['-i', inputPath];
        if (wmPath) ffArgs.push('-i', wmFilename); // watermark input (relative, cwd = PROCESSED_DIR)
        ffArgs.push('-filter_complex_script', `filter_${file_id}.txt`);
        ffArgs.push('-map', finalVideoLabel);
        if (hasAudio) ffArgs.push('-map', '[aout]', '-c:a', 'aac', '-b:a', '192k');
        ffArgs.push('-c:v', 'libx264', '-preset', 'fast', '-movflags', '+faststart', '-y', outputPath);
        console.log('[FFMPEG CMD]', ffArgs.join(' '));

        const result = require('child_process').spawnSync(FFMPEG_PATH, ffArgs, { maxBuffer: 50 * 1024 * 1024, cwd: PROCESSED_DIR });

        try { fs.unlinkSync(filterPath); } catch (e) { }
        try { const ap = path.join(PROCESSED_DIR, `subs_${file_id}.ass`); if (fs.existsSync(ap)) fs.unlinkSync(ap); } catch (e) { }
        try { if (wmPath && fs.existsSync(wmPath)) fs.unlinkSync(wmPath); } catch (e) { }

        if (result.status !== 0) {
            const stderrFull = (result.stderr || '').toString().trim();
            console.error('[FFMPEG STDERR]', stderrFull.slice(-2000));
            const err = stderrFull.split('\n').slice(-8).join('\n');
            return res.json({ success: false, error: `FFmpeg error:\n${err}` });
        }
        res.json({ success: true, video_url: `/processed/${outputFilename}` });

        // Auto-save to cropper history
        try {
            // Get thumbnail: first frame from the uploads folder
            const framesDir = path.join(UPLOADS_DIR, file_id);
            let thumbnail = '';
            if (fs.existsSync(framesDir)) {
                const firstFrame = fs.readdirSync(framesDir).filter(f => f.endsWith('.jpg')).sort()[0];
                if (firstFrame) thumbnail = `/uploads/${file_id}/${firstFrame}`;
            }
            // Get filename from original input file
            let origFilename = '';
            for (const f of fs.readdirSync(UPLOADS_DIR)) {
                if (f.startsWith(file_id) && f.includes('.') && !fs.statSync(path.join(UPLOADS_DIR, f)).isDirectory()) { origFilename = f; break; }
            }
            const historyEntry = { id: file_id, filename: origFilename, duration, config, video_url: `/processed/${outputFilename}`, thumbnail, date: new Date().toISOString() };
            fs.writeFileSync(path.join(CROPPER_HISTORY_DIR, file_id + '.json'), JSON.stringify(historyEntry, null, 2), 'utf-8');
            console.log('[CROPPER HISTORY] Saved:', file_id);
        } catch (he) { console.error('[CROPPER HISTORY] Save failed:', he.message); }
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

// === ELEVENLABS SPEECH-TO-TEXT TRANSCRIBE ===
// Extract audio from video using FFmpeg
async function extractAudio(videoPath, outputPath) {
    await runCommand(FFMPEG_PATH, [
        '-y', '-i', videoPath,
        '-vn', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1',
        outputPath
    ], path.dirname(videoPath));
    return outputPath;
}

// Transcribe audio using ElevenLabs Speech-to-Text API
async function transcribeWithElevenLabs(audioPath, apiKey) {
    const FormData = require('form-data');
    const formData = new FormData();
    formData.append('file', fs.createReadStream(audioPath));
    formData.append('model_id', 'scribe_v1');
    formData.append('timestamps_granularity', 'word');
    formData.append('tag_audio_events', 'false');

    const https = require('https');
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: 'api.elevenlabs.io',
            path: '/v1/speech-to-text',
            method: 'POST',
            headers: {
                'xi-api-key': apiKey,
                ...formData.getHeaders()
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (res.statusCode !== 200) {
                        reject(new Error(json.detail?.message || json.detail || `ElevenLabs API error ${res.statusCode}`));
                        return;
                    }
                    resolve(json);
                } catch (e) {
                    reject(new Error('Invalid response from ElevenLabs'));
                }
            });
        });
        req.on('error', reject);
        formData.pipe(req);
    });
}

// Group words into readable subtitle lines (2-4 words per line)
function groupWordsIntoCaptions(words) {
    if (!words || words.length === 0) return [];
    const OFFSET = 0.05; // sync offset
    const MIN_DUR = 0.5;
    const MAX_DUR = 3.0;
    const MAX_WORDS = 4;
    const MIN_WORDS = 2;

    const captions = [];
    let i = 0;
    while (i < words.length) {
        const groupStart = (words[i].start || 0) + OFFSET;
        let groupEnd = (words[i].end || groupStart + 0.3) + OFFSET;
        const groupWords = [{ text: words[i].text, start: groupStart, end: groupEnd }];
        let j = i + 1;

        while (j < words.length && groupWords.length < MAX_WORDS) {
            const wStart = (words[j].start || 0) + OFFSET;
            const wEnd = (words[j].end || wStart + 0.3) + OFFSET;
            const potentialDur = wEnd - groupStart;

            // Stop if adding this word would exceed max duration
            if (potentialDur > MAX_DUR && groupWords.length >= MIN_WORDS) break;

            groupWords.push({ text: words[j].text, start: wStart, end: wEnd });
            groupEnd = wEnd;
            j++;
        }

        // Ensure minimum duration
        if (groupEnd - groupStart < MIN_DUR) groupEnd = groupStart + MIN_DUR;

        captions.push({
            start: Math.round(groupStart * 100) / 100,
            end: Math.round(groupEnd * 100) / 100,
            text: groupWords.map(w => w.text).join(' '),
            words: groupWords // keep word-level timing for karaoke
        });
        i = j;
    }
    return captions;
}

router.post('/api/cropper/transcribe', async (req, res) => {
    const { file_id, elevenlabs_key } = req.body;
    if (!file_id) return res.json({ success: false, error: 'No file_id provided' });
    if (!elevenlabs_key) return res.json({ success: false, error: 'No ElevenLabs API key provided' });

    // Find the video file
    let inputPath = '';
    for (const f of fs.readdirSync(UPLOADS_DIR)) {
        if (f.startsWith(file_id) && f.includes('.') && !fs.statSync(path.join(UPLOADS_DIR, f)).isDirectory()) {
            inputPath = path.join(UPLOADS_DIR, f); break;
        }
    }
    if (!inputPath) return res.json({ success: false, error: 'Video file not found' });

    const audioPath = path.join(UPLOADS_DIR, `${file_id}_audio.wav`);
    try {
        // Step 1: Extract audio
        await extractAudio(inputPath, audioPath);

        // Step 2: Transcribe with ElevenLabs
        const result = await transcribeWithElevenLabs(audioPath, elevenlabs_key);

        // Step 3: Extract word-level timestamps
        let words = [];
        if (result.words && result.words.length > 0) {
            words = result.words.filter(w => w.text && w.text.trim());
        } else if (result.text) {
            // Fallback: no word-level timestamps, create simple caption
            return res.json({
                success: true,
                captions: [{ start: 0, end: 10, text: result.text }]
            });
        }

        // Step 4: Group into readable captions
        const captions = groupWordsIntoCaptions(words);

        res.json({ success: true, captions });
    } catch (e) {
        res.json({ success: false, error: e.message });
    } finally {
        // Cleanup audio file
        try { if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath); } catch (e) { }
    }
});

module.exports = router;
