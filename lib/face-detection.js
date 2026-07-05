const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { runCommand, FFMPEG_PATH, FFPROBE_PATH, PYTHON_CMD, PYTHON_ARGS } = require('./utils');

let faceDetectionReady = false;
const DETECT_SCRIPT = path.join(__dirname, 'mediapipe_detect.py');
const CACHE_DIR = path.join(__dirname, '..', 'history', 'face-detect-cache');
const DETECT_CACHE_VERSION = 'v4-aggressive-split-window';
fs.mkdirSync(CACHE_DIR, { recursive: true });

function normalizeDetectMode(mode) {
    return ['fast', 'balanced', 'accurate'].includes(mode) ? mode : 'balanced';
}

function getPreviewIndices(total, detectMode) {
    if (total <= 0) return [];
    const mode = normalizeDetectMode(detectMode);
    if (mode === 'accurate') return Array.from({ length: total }, (_, i) => i);
    if (mode === 'balanced') {
        const out = [];
        for (let i = 0; i < total; i += 4) out.push(i);
        if (out[out.length - 1] !== total - 1) out.push(total - 1);
        return [...new Set(out)];
    }
    if (total <= 36) return Array.from({ length: total }, (_, i) => i);
    const out = [];
    for (let i = 0; i < 36; i++) out.push(Math.round((i * (total - 1)) / 35));
    return [...new Set(out)];
}

function fillMissingFaceResults(results) {
    const filled = results.slice();
    for (let i = 0; i < filled.length; i++) {
        if (filled[i]) continue;
        let nearest = null;
        for (let d = 1; d < filled.length; d++) {
            if (i - d >= 0 && filled[i - d]) {
                nearest = filled[i - d];
                break;
            }
            if (i + d < filled.length && filled[i + d]) {
                nearest = filled[i + d];
                break;
            }
        }
        filled[i] = nearest ? nearest.map(face => ({ ...face })) : [];
    }
    return filled.map(item => item || []);
}

function sha1(value) {
    return crypto.createHash('sha1').update(value).digest('hex');
}

function getFileStamp(filePath) {
    try {
        const stat = fs.statSync(filePath);
        return `${filePath}|${stat.size}|${stat.mtimeMs}`;
    } catch (e) {
        return `${filePath}|missing`;
    }
}

function getCachePath(parts) {
    return path.join(CACHE_DIR, sha1(JSON.stringify(parts)) + '.json');
}

function readCache(cachePath) {
    try {
        if (!fs.existsSync(cachePath)) return null;
        return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    } catch (e) {
        return null;
    }
}

function writeCache(cachePath, value) {
    try {
        fs.writeFileSync(cachePath, JSON.stringify(value), 'utf8');
    } catch (e) {
        console.log('⚠️ Face cache write failed:', e.message);
    }
}

async function getVideoMeta(videoPath) {
    const result = await runCommand(
        FFPROBE_PATH,
        ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', videoPath],
        path.dirname(videoPath)
    );
    const data = JSON.parse(result.stdout);
    const vs = data.streams.find(s => s.codec_type === 'video') || {};
    return {
        width: parseInt(vs.width || 0),
        height: parseInt(vs.height || 0),
        fps: vs.avg_frame_rate ? eval(vs.avg_frame_rate) : 30,
        duration: parseFloat(data.format?.duration || 0)
    };
}

function getClipSamplingConfig(detectMode, durationSeconds, fps) {
    const mode = normalizeDetectMode(detectMode);
    const duration = Math.max(0.1, Number(durationSeconds) || 0.1);
    const sourceFps = Math.max(1, Number(fps) || 30);
    if (mode === 'accurate') {
        return { mode, label: 'every frame', filter: "select='not(mod(n\\,1))'", logValue: 'stride=1' };
    }
    if (mode === 'balanced') {
        return { mode, label: 'every 4th frame', filter: "select='not(mod(n\\,4))'", logValue: 'stride=4' };
    }
    const sampleFps = Math.max(0.3, Math.min(sourceFps, 36 / duration));
    return { mode, label: 'max 36 frames', filter: `fps=${sampleFps.toFixed(3)}`, logValue: `fps=${sampleFps.toFixed(3)}` };
}

async function initFaceDetection() {
    if (faceDetectionReady) return true;
    try {
        const testResult = execFileSync(
            PYTHON_CMD,
            [...PYTHON_ARGS, '-c', 'import insightface; from insightface.app import FaceAnalysis; print("ok")'],
            { encoding: 'utf8', timeout: 120000 }
        );
        if (testResult.trim() === 'ok') {
            faceDetectionReady = true;
            console.log('🎯 Smart detection ready — Python InsightFace / ArcFace');
            console.log('   📐 model: buffalo_s, det_size: 512, detection-only, providers: CUDA/CPU auto-fallback');
            console.log('   🧩 crop logic:', DETECT_CACHE_VERSION);
            return true;
        }
    } catch (e) {
        console.log('⚠️ Face detection init failed:', e.message);
        console.log('   ℹ️ Startup check can be slow on first run (model warm-up / Python cold start).');
    }
    faceDetectionReady = false;
    return false;
}

function mapFaces(data) {
    return (data.faces || []).map(f => ({
        x: f.x,
        y: f.y,
        width: f.w,
        height: f.h,
        centerX: Math.round(f.x + f.w / 2),
        centerY: Math.round(f.y + f.h / 2),
        probability: f.score,
        keypoints: f.keypoints || []
    }));
}

function detectFacesInsightFace(imagePath) {
    try {
        const result = execFileSync(PYTHON_CMD, [...PYTHON_ARGS, DETECT_SCRIPT, imagePath], {
            encoding: 'utf8',
            timeout: 30000,
            stdio: ['pipe', 'pipe', 'pipe']
        });
        const lines = result.trim().split('\n');
        const lastLine = lines[lines.length - 1];
        return mapFaces(JSON.parse(lastLine));
    } catch (e) {
        if (e.stdout) {
            try {
                const lines = e.stdout.trim().split('\n');
                const lastLine = lines[lines.length - 1];
                return mapFaces(JSON.parse(lastLine));
            } catch (pe) { }
        }
        return [];
    }
}

function detectFacesBatch(imagePaths) {
    try {
        const tmpFile = path.join(require('os').tmpdir(), 'if_batch_' + Date.now() + '.json');
        fs.writeFileSync(tmpFile, JSON.stringify(imagePaths));
        let stdout = '';
        try {
            stdout = execFileSync(PYTHON_CMD, [...PYTHON_ARGS, DETECT_SCRIPT, '--batch', tmpFile], {
                encoding: 'utf8',
                timeout: 300000,
                stdio: ['pipe', 'pipe', 'pipe']
            });
        } catch (e) {
            stdout = e.stdout || '';
        }
        try { fs.unlinkSync(tmpFile); } catch (e) { }
        const lines = stdout.trim().split('\n');
        const lastLine = lines[lines.length - 1];
        const results = JSON.parse(lastLine);
        return results.map(r => ({ path: r.path, faces: mapFaces(r) }));
    } catch (e) {
        return imagePaths.map(p => ({ path: p, faces: [] }));
    }
}

async function detectFacesInImage(canvas) {
    if (!faceDetectionReady) return [];
    const tmpPath = path.join(require('os').tmpdir(), 'if_frame_' + Date.now() + '.jpg');
    try {
        fs.writeFileSync(tmpPath, canvas.toBuffer('image/jpeg', { quality: 0.92 }));
        return detectFacesInsightFace(tmpPath);
    } finally {
        try { fs.unlinkSync(tmpPath); } catch (e) { }
    }
}

async function smartDetectForConfig(canvas) {
    const faces = await detectFacesInImage(canvas);
    if (faces.length > 0) return { faces, source: 'face' };
    return { faces: [], source: 'none' };
}

function detectFacesInFiles(imagePaths, detectMode = 'balanced') {
    if (!faceDetectionReady || !Array.isArray(imagePaths) || imagePaths.length === 0) return [];
    const mode = normalizeDetectMode(detectMode);
    const indices = getPreviewIndices(imagePaths.length, mode);
    const selectedPaths = indices.map(i => imagePaths[i]);
    const cachePath = getCachePath({
        version: DETECT_CACHE_VERSION,
        type: 'files',
        mode,
        files: selectedPaths.map(getFileStamp)
    });
    let selectedResults = readCache(cachePath);
    if (!selectedResults) {
        const batchResults = detectFacesBatch(selectedPaths);
        const byPath = new Map(batchResults.map(r => [r.path, r.faces]));
        selectedResults = selectedPaths.map(p => byPath.get(p) || []);
        writeCache(cachePath, selectedResults);
    }

    const sparse = new Array(imagePaths.length).fill(null);
    indices.forEach((idx, i) => {
        sparse[idx] = selectedResults[i] || [];
    });
    return fillMissingFaceResults(sparse);
}

async function detectFacesInClip(videoPath, startTime, duration, jobDir, detectMode = 'balanced') {
    if (!faceDetectionReady) return [];
    const mode = normalizeDetectMode(detectMode);
    const meta = await getVideoMeta(videoPath);
    const sampling = getClipSamplingConfig(mode, duration, meta.fps);
    const cachePath = getCachePath({
        version: DETECT_CACHE_VERSION,
        type: 'clip',
        mode,
        video: getFileStamp(videoPath),
        startTime: Number(startTime) || 0,
        duration: Number(duration) || 0,
        sampling: sampling.logValue
    });
    const cached = readCache(cachePath);
    if (cached) {
        console.log(`🎯 Detect cache hit: ${mode} (${cached.length} sampled frames)`);
        return cached;
    }

    const framesDir = path.join(jobDir, 'frames_' + Date.now());
    fs.mkdirSync(framesDir, { recursive: true });
    try {
        await runCommand(
            FFMPEG_PATH,
            ['-y', '-ss', String(startTime), '-t', String(duration), '-i', videoPath, '-vf', sampling.filter, '-vsync', 'vfr', '-q:v', '3', path.join(framesDir, 'frame_%05d.jpg')],
            jobDir
        );
        const frameFiles = fs.readdirSync(framesDir).filter(f => f.endsWith('.jpg')).sort();
        if (frameFiles.length === 0) return [];
        console.log(`🎯 Detect sampling: ${frameFiles.length} frames | mode=${mode} | ${sampling.logValue}`);

        const framePaths = frameFiles.map(f => path.join(framesDir, f));
        const batchResults = detectFacesBatch(framePaths);
        const byPath = new Map(batchResults.map(r => [r.path, r.faces]));
        const results = framePaths.map((framePath, i) => ({
            frame: frameFiles[i],
            imageWidth: meta.width || 1920,
            imageHeight: meta.height || 1080,
            faceCount: (byPath.get(framePath) || []).length,
            faces: byPath.get(framePath) || []
        }));
        writeCache(cachePath, results);
        return results;
    } catch (e) {
        console.log('⚠️ Frame extraction failed:', e.message);
        return [];
    } finally {
        try {
            fs.readdirSync(framesDir).forEach(f => fs.unlinkSync(path.join(framesDir, f)));
            fs.rmdirSync(framesDir);
        } catch (e) { }
    }
}

function computeCropPosition(faceResults) {
    if (!faceResults || faceResults.length === 0) return null;
    const vW = faceResults[0].imageWidth;
    const vH = faceResults[0].imageHeight;
    const cropWidth = Math.round(vH * 9 / 16);
    if (cropWidth >= vW) return null;
    const cropXPerFrame = faceResults.map(fr => {
        let targetCX;
        if (fr.faceCount === 0) targetCX = vW / 2;
        else if (fr.faceCount === 1) targetCX = fr.faces[0].centerX;
        else {
            const sorted = [...fr.faces].sort((a, b) => a.centerX - b.centerX);
            targetCX = (sorted[0].centerX + sorted[sorted.length - 1].centerX) / 2;
        }
        return Math.max(0, Math.min(vW - cropWidth, Math.round(targetCX - cropWidth / 2)));
    });
    const sorted = [...cropXPerFrame].sort((a, b) => a - b);
    return {
        cropWidth,
        cropHeight: vH,
        cropX: sorted[Math.floor(sorted.length / 2)],
        cropY: 0,
        videoWidth: vW,
        videoHeight: vH
    };
}

function rollingMedian(values, windowSize = 7) {
    if (values.length === 0) return [];
    const results = [];
    for (let i = 0; i < values.length; i++) {
        const start = Math.max(0, i - Math.floor(windowSize / 2));
        const end = Math.min(values.length, i + Math.ceil(windowSize / 2));
        const w = values.slice(start, end).sort((a, b) => a - b);
        results.push(w[Math.floor(w.length / 2)]);
    }
    return results;
}

function applyEMA(values, alpha = 0.3) {
    if (values.length === 0) return [];
    const results = [values[0]];
    for (let i = 1; i < values.length; i++) results.push(results[i - 1] * (1 - alpha) + values[i] * alpha);
    return results;
}

function buildSingleCropStrategy(faceResults, targetAspect, srcW, srcH) {
    const usable = faceResults.filter(r => r.faces && r.faces.length > 0);
    if (usable.length === 0) return { strategy: 'safe_mode', data: {} };
    const rawX = usable.map(r => r.faces[0].centerX || srcW / 2);
    const mediatedX = rollingMedian(rawX, 7);
    const smoothedX = applyEMA(mediatedX, 0.3);
    const deadZone = srcW * 0.05;
    let finalX = smoothedX[0];
    for (let i = 1; i < smoothedX.length; i++) {
        if (Math.abs(smoothedX[i] - finalX) > deadZone) finalX = smoothedX[i];
    }
    let cropW, cropH;
    if (srcW / srcH > targetAspect) {
        cropH = srcH;
        cropW = Math.floor(srcH * targetAspect);
    } else {
        cropW = srcW;
        cropH = Math.floor(srcW / targetAspect);
    }
    let xOff = Math.round(finalX - cropW / 2);
    xOff = Math.max(0, Math.min(srcW - cropW, xOff));
    const yOff = Math.max(0, Math.floor((srcH - cropH) / 2));
    return { strategy: 'single_crop', data: { crop_region: { x: xOff, y: yOff, w: cropW, h: cropH } } };
}

function buildSplitScreenStrategy(srcW) {
    return { strategy: 'split_screen', data: { mid_x: Math.floor(srcW / 2) } };
}

function findTwoFaceSegments(faceResults, duration) {
    const total = faceResults.length;
    if (!total) return [];
    const sampledFps = total / Math.max(duration, 0.1);
    const preRoll = Math.max(1, Math.round(sampledFps * 1.8));
    const postRoll = Math.max(1, Math.round(sampledFps * 2.4));
    const mergeGap = Math.max(1, Math.round(sampledFps * 2.0));
    const minSegment = Math.max(1, Math.round(sampledFps * 1.0));

    const rawPeaks = [];
    let peakStart = -1;
    for (let i = 0; i < total; i++) {
        const isTwoFace = (faceResults[i].faceCount || 0) >= 2;
        if (isTwoFace && peakStart === -1) peakStart = i;
        if ((!isTwoFace || i === total - 1) && peakStart !== -1) {
            const peakEnd = isTwoFace && i === total - 1 ? i : i - 1;
            rawPeaks.push({ startIndex: peakStart, endIndex: peakEnd });
            peakStart = -1;
        }
    }

    const expanded = rawPeaks.map(seg => ({
        startIndex: Math.max(0, seg.startIndex - preRoll),
        endIndex: Math.min(total - 1, seg.endIndex + postRoll)
    }));

    const merged = [];
    for (const seg of expanded) {
        const prev = merged[merged.length - 1];
        if (prev && seg.startIndex - prev.endIndex <= mergeGap) prev.endIndex = Math.max(prev.endIndex, seg.endIndex);
        else merged.push({ ...seg });
    }

    const strongSegments = merged.filter(seg => (seg.endIndex - seg.startIndex + 1) >= minSegment);
    if (strongSegments.length >= 2) {
        const widened = [];
        for (const seg of strongSegments) {
            const prev = widened[widened.length - 1];
            if (prev && seg.startIndex - prev.endIndex <= Math.round(sampledFps * 3.0)) {
                prev.endIndex = Math.max(prev.endIndex, seg.endIndex);
            } else {
                widened.push({ ...seg });
            }
        }
        return widened;
    }
    return strongSegments;
}

async function computeFaceCrop(videoPath, startTime, duration, jobDir, targetW, targetH, srcW, srcH, detectMode = 'balanced') {
    if (!faceDetectionReady) return null;
    const faceResults = await detectFacesInClip(videoPath, startTime, duration, jobDir, detectMode);
    if (faceResults.length === 0) return { strategy: 'safe_mode', data: {} };

    const counts = faceResults.map(r => r.faceCount);
    const modeMap = {};
    counts.forEach(c => { modeMap[c] = (modeMap[c] || 0) + 1; });
    const dominantFaceCount = parseInt(Object.keys(modeMap).reduce((a, b) => modeMap[a] > modeMap[b] ? a : b));
    const targetAspect = targetW / targetH;
    const framesWithTwoFaces = counts.filter(c => c >= 2).length;
    const twoFaceRatio = framesWithTwoFaces / counts.length;

    console.log('🧠 [SmartCrop] Frames:', counts.length, '| Face counts:', JSON.stringify(modeMap),
        '| Dominant:', dominantFaceCount, '| 2-face frames:', framesWithTwoFaces, '(' + Math.round(twoFaceRatio * 100) + '%)', '| Mode:', normalizeDetectMode(detectMode));

    const twoFaceSegments = findTwoFaceSegments(faceResults, duration);
    if (twoFaceSegments.length > 0) {
        const segments = [];
        let cursor = 0;
        for (const seg of twoFaceSegments) {
            if (seg.startIndex > cursor) {
                const subset = faceResults.slice(cursor, seg.startIndex);
                const single = buildSingleCropStrategy(subset, targetAspect, srcW, srcH);
                segments.push({
                    start: Number((duration * cursor / faceResults.length).toFixed(3)),
                    end: Number((duration * seg.startIndex / faceResults.length).toFixed(3)),
                    ...single
                });
            }
            segments.push({
                start: Number((duration * seg.startIndex / faceResults.length).toFixed(3)),
                end: Number((duration * (seg.endIndex + 1) / faceResults.length).toFixed(3)),
                ...buildSplitScreenStrategy(srcW)
            });
            cursor = seg.endIndex + 1;
        }
        if (cursor < faceResults.length) {
            const subset = faceResults.slice(cursor);
            const single = buildSingleCropStrategy(subset, targetAspect, srcW, srcH);
            segments.push({
                start: Number((duration * cursor / faceResults.length).toFixed(3)),
                end: Number(duration.toFixed(3)),
                ...single
            });
        }
        const normalized = segments.filter(seg => seg.end - seg.start > 0.05);
        if (normalized.length === 1) return { strategy: normalized[0].strategy, data: normalized[0].data };
        console.log('🧠 [SmartCrop] Strategy: MULTI_SEGMENT | segments:', normalized.map(s => `${s.strategy}@${s.start}-${s.end}`).join(', '));
        return { segments: normalized };
    }

    if (dominantFaceCount === 1 && twoFaceRatio < 0.3) {
        const single = buildSingleCropStrategy(faceResults, targetAspect, srcW, srcH);
        const crop = single.data.crop_region;
        console.log('🧠 [SmartCrop] Strategy: SINGLE_CROP | crop:', crop.w + 'x' + crop.h + '+' + crop.x);
        return single;
    }

    if (dominantFaceCount >= 2 || twoFaceRatio >= 0.3) {
        console.log('🧠 [SmartCrop] Strategy: SPLIT_SCREEN | layout: face_detection_app style');
        return { strategy: 'split_screen', data: { mid_x: Math.floor(srcW / 2) } };
    }

    console.log('🧠 [SmartCrop] Strategy: SAFE_MODE (fallback)');
    return { strategy: 'safe_mode', data: {} };
}

function detectMotionCenter() { return null; }
function detectBodyRegion() { return null; }
function isBrightBlob() { return false; }

module.exports = {
    initFaceDetection,
    detectFacesInImage,
    detectFacesInClip,
    computeCropPosition,
    computeFaceCrop,
    rollingMedian,
    applyEMA,
    smartDetectForConfig,
    detectMotionCenter,
    detectBodyRegion,
    isBrightBlob,
    detectFacesInFiles,
    normalizeDetectMode,
    isFaceDetectionReady: () => faceDetectionReady
};
