require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.text({ type: 'text/plain', limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/output', express.static(path.join(__dirname, 'output')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/processed', express.static(path.join(__dirname, 'processed')));

// Repliz media upload
const multer = require('multer');
const replizUploadDir = path.join(__dirname, 'uploads', 'repliz');
if (!fs.existsSync(replizUploadDir)) fs.mkdirSync(replizUploadDir, { recursive: true });

const replizStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, replizUploadDir),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname) || '.mp4';
        cb(null, 'rz_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + ext);
    }
});
const replizUpload = multer({ storage: replizStorage, limits: { fileSize: 500 * 1024 * 1024 } });

// Shared helper: upload file buffer to litterbox.catbox.moe (72h retention), returns public direct URL
function uploadToFileHost(fileBuffer, filename, mimetype) {
    const CRLF = String.fromCharCode(13, 10);
    const boundary = '----CatboxUpload' + Date.now() + Math.random().toString(36).slice(2);

    // Build multipart form data
    let parts = [];

    // reqtype field
    parts.push(Buffer.from(
        '--' + boundary + CRLF +
        'Content-Disposition: form-data; name="reqtype"' + CRLF + CRLF +
        'fileupload' + CRLF
    ));

    // time field (72 hours)
    parts.push(Buffer.from(
        '--' + boundary + CRLF +
        'Content-Disposition: form-data; name="time"' + CRLF + CRLF +
        '72h' + CRLF
    ));

    // file field
    parts.push(Buffer.from(
        '--' + boundary + CRLF +
        'Content-Disposition: form-data; name="fileToUpload"; filename="' + filename + '"' + CRLF +
        'Content-Type: ' + mimetype + CRLF + CRLF
    ));
    parts.push(fileBuffer);
    parts.push(Buffer.from(CRLF + '--' + boundary + '--' + CRLF));

    const body = Buffer.concat(parts);

    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: 'litterbox.catbox.moe',
            path: '/resources/internals/api.php',
            method: 'POST',
            headers: {
                'Content-Type': 'multipart/form-data; boundary=' + boundary,
                'Content-Length': body.length,
                'User-Agent': 'Mozilla/5.0'
            }
        }, (res) => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => {
                const url = d.trim();
                if (url.startsWith('https://')) {
                    resolve(url);
                } else {
                    reject(new Error('Litterbox response: ' + d.substring(0, 200)));
                }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

// Upload video/image media
app.post('/repliz-upload', replizUpload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const filePath = path.join(replizUploadDir, req.file.filename);

    try {
        const fileBuffer = fs.readFileSync(filePath);
        const publicUrl = await uploadToFileHost(fileBuffer, req.file.originalname, req.file.mimetype || 'application/octet-stream');
        console.log('[UPLOAD] Public URL:', publicUrl);
        res.json({ url: publicUrl, filename: req.file.filename, size: req.file.size });
    } catch (err) {
        console.error('[UPLOAD] Public upload failed:', err.message);
        const localUrl = `${req.protocol}://${req.get('host')}/uploads/repliz/${req.file.filename}`;
        res.json({ url: localUrl, filename: req.file.filename, size: req.file.size, warning: 'Local URL only' });
    }
});

// Upload thumbnail (from base64 canvas capture)
app.post('/repliz-upload-thumb', express.json({ limit: '10mb' }), async (req, res) => {
    const { data } = req.body;
    if (!data) return res.status(400).json({ error: 'No data' });
    const matches = data.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!matches) return res.status(400).json({ error: 'Invalid data URL' });
    const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
    const buffer = Buffer.from(matches[2], 'base64');
    const mime = 'image/' + (ext === 'jpg' ? 'jpeg' : ext);
    const filename = 'thumb_' + Date.now() + '.' + ext;

    try {
        const publicUrl = await uploadToFileHost(buffer, filename, mime);
        console.log('[THUMB] Public URL:', publicUrl);
        res.json({ url: publicUrl, filename: filename });
    } catch (err) {
        console.error('[THUMB] Public upload failed:', err.message);
        fs.writeFileSync(path.join(replizUploadDir, filename), buffer);
        const localUrl = `${req.protocol}://${req.get('host')}/uploads/repliz/${filename}`;
        res.json({ url: localUrl, filename: filename });
    }
});

// Repliz API Proxy — forward /public/* to https://api.repliz.com/public/*
const https = require('https');
const http_module = require('http');
const { URL } = require('url');

app.all('/public/*', (req, res) => {
    const targetUrl = 'https://api.repliz.com' + req.originalUrl;
    const parsed = new URL(targetUrl);

    const headers = {};
    if (req.headers['authorization']) headers['Authorization'] = req.headers['authorization'];
    if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];

    let body = null;
    if (req.method === 'POST' || req.method === 'PUT') {
        body = JSON.stringify(req.body);
        headers['Content-Length'] = Buffer.byteLength(body);
    }

    const options = {
        hostname: parsed.hostname,
        port: 443,
        path: parsed.pathname + parsed.search,
        method: req.method,
        headers: headers,
    };

    const proxyReq = https.request(options, (proxyRes) => {
        res.status(proxyRes.statusCode);
        res.set('Content-Type', proxyRes.headers['content-type'] || 'application/json');
        proxyRes.pipe(res);
    });

    // 60 second timeout for Repliz API
    proxyReq.setTimeout(60000, () => {
        proxyReq.destroy();
        console.error('[REPLIZ PROXY] Timeout after 60s:', req.method, req.originalUrl);
        if (!res.headersSent) {
            res.status(504).json({ error: 'Repliz API timeout (60s) — server mungkin sedang down atau lambat. Coba lagi nanti.' });
        }
    });

    proxyReq.on('error', (err) => {
        console.error('[REPLIZ PROXY ERROR]', err.message);
        if (!res.headersSent) {
            res.status(502).json({ error: 'Repliz API error: ' + err.message + ' — server mungkin sedang down.' });
        }
    });

    if (body) proxyReq.write(body);
    proxyReq.end();
});

// Route modules
const youtubeCutterRoutes = require('./routes/youtube-cutter');
const videoCropperRoutes = require('./routes/video-cropper');
const zernioRoutes = require('./routes/zernio');
app.use(youtubeCutterRoutes);
app.use(videoCropperRoutes);
app.use('/', require('./routes/video-share'));
app.use(zernioRoutes);


// ── Bulk Schedule Drafts ──────────────────────────────────────────────────────
const BULK_DRAFTS_DIR = path.join(__dirname, 'history', 'bulk-drafts');
if (!fs.existsSync(BULK_DRAFTS_DIR)) fs.mkdirSync(BULK_DRAFTS_DIR, { recursive: true });

// List all drafts (summary)
app.get('/api/bulk-drafts', (req, res) => {
    try {
        const files = fs.readdirSync(BULK_DRAFTS_DIR).filter(f => f.endsWith('.json'));
        const drafts = files.map(f => {
            try {
                const d = JSON.parse(fs.readFileSync(path.join(BULK_DRAFTS_DIR, f), 'utf-8'));
                return { id: d.id, name: d.name, itemCount: (d.items || []).length, type: d.type, updatedAt: d.updatedAt, createdAt: d.createdAt };
            } catch { return null; }
        }).filter(Boolean).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
        res.json(drafts);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get one draft (full)
app.get('/api/bulk-drafts/:id', (req, res) => {
    const file = path.join(BULK_DRAFTS_DIR, req.params.id + '.json');
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'Draft not found' });
    try { res.json(JSON.parse(fs.readFileSync(file, 'utf-8'))); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// Save / upsert draft
app.post('/api/bulk-drafts', express.json({ limit: '10mb' }), (req, res) => {
    try {
        const draft = req.body;
        if (!draft.id) draft.id = require('crypto').randomUUID();
        draft.updatedAt = new Date().toISOString();
        if (!draft.createdAt) draft.createdAt = draft.updatedAt;
        fs.writeFileSync(path.join(BULK_DRAFTS_DIR, draft.id + '.json'), JSON.stringify(draft, null, 2), 'utf-8');
        res.json({ ok: true, id: draft.id });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete draft
app.delete('/api/bulk-drafts/:id', (req, res) => {
    const file = path.join(BULK_DRAFTS_DIR, req.params.id + '.json');
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'Draft not found' });
    try { fs.unlinkSync(file); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});
// ─────────────────────────────────────────────────────────────────────────────

// ── Local Folder Scanner ──────────────────────────────────────────────────────
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm', '.flv', '.wmv', '.m4v', '.ts', '.mts']);
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff']);

// Scan a local folder and return list of media files
app.get('/api/scan-folder', (req, res) => {
    const folderPath = (req.query.path || '').trim();
    if (!folderPath) return res.status(400).json({ error: 'path required' });
    if (!fs.existsSync(folderPath)) return res.status(404).json({ error: 'Folder tidak ditemukan: ' + folderPath });
    try {
        const stat = fs.statSync(folderPath);
        if (!stat.isDirectory()) return res.status(400).json({ error: 'Path bukan folder' });
        const entries = fs.readdirSync(folderPath);
        const files = entries
            .map(name => {
                const fullPath = path.join(folderPath, name);
                try {
                    const s = fs.statSync(fullPath);
                    if (!s.isFile()) return null;
                    const ext = path.extname(name).toLowerCase();
                    if (!VIDEO_EXTS.has(ext) && !IMAGE_EXTS.has(ext)) return null;
                    return { name, fullPath, size: s.size, ext };
                } catch { return null; }
            })
            .filter(Boolean);
        res.json({ folder: folderPath, files });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Serve a local file by absolute path (for browser fetch → File object)
app.get('/api/local-file', (req, res) => {
    const filePath = (req.query.path || '').trim();
    if (!filePath) return res.status(400).json({ error: 'path required' });
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File tidak ditemukan' });
    try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) return res.status(400).json({ error: 'Bukan file' });
        const ext = path.extname(filePath).toLowerCase();
        const mimeMap = {
            '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo',
            '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.flv': 'video/x-flv',
            '.wmv': 'video/x-ms-wmv', '.m4v': 'video/x-m4v', '.ts': 'video/mp2t',
            '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
            '.gif': 'image/gif', '.webp': 'image/webp'
        };
        const mime = mimeMap[ext] || 'application/octet-stream';
        res.setHeader('Content-Type', mime);
        res.setHeader('Content-Length', stat.size);
        res.setHeader('Content-Disposition', 'inline; filename="' + path.basename(filePath) + '"');
        fs.createReadStream(filePath).pipe(res);
    } catch (e) { res.status(500).json({ error: e.message }); }
});
// ─────────────────────────────────────────────────────────────────────────────
const { YTDLP_PATH, FFMPEG_PATH, COOKIES_PATH } = require('./lib/utils');
const { initFaceDetection } = require('./lib/face-detection');

async function checkDependencies() {
    console.log('🔍 Checking dependencies...');
    if (!fs.existsSync(YTDLP_PATH)) { console.error(`❌ yt-dlp not found at ${YTDLP_PATH}`); process.exit(1); }
    console.log('✅ yt-dlp found');
    if (!fs.existsSync(FFMPEG_PATH)) { console.error(`❌ ffmpeg not found at ${FFMPEG_PATH}`); process.exit(1); }
    console.log('✅ ffmpeg found');
    if (fs.existsSync(COOKIES_PATH)) console.log('🍪 cookies.txt found');
}

checkDependencies().then(async () => {
    await initFaceDetection();
    app.listen(PORT, '::', () => {
        console.log(`\n🚀 Video Tools (Gabungan) running at http://localhost:${PORT}\n`);
        console.log('   📺 Tab 1: YouTube AI Cutter');
        console.log('   🎬 Tab 2: Video Cropper');
        console.log('   📲 Tab 3: Repliz Dashboard');
        console.log('');
    });
});
