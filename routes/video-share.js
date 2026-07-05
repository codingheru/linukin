const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { URL } = require('url');

const router = express.Router();
const APPS_SCRIPT_URL = process.env.TABLE_SHARE_APPS_SCRIPT_URL;

function requireAppsScriptUrl() {
  if (!APPS_SCRIPT_URL) {
    throw new Error('Env belum lengkap: TABLE_SHARE_APPS_SCRIPT_URL');
  }
}

function requestJson(urlString, { method = 'GET', body = null, redirectCount = 0 } = {}) {
  const url = new URL(urlString);
  const payload = body ? JSON.stringify(body) : null;

  return new Promise((resolve, reject) => {
    const req = https.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method,
      headers: payload ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      } : {}
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', async () => {
        const statusCode = Number(res.statusCode || 0);
        const location = res.headers.location;

        if ([301, 302, 303, 307, 308].includes(statusCode) && location) {
          if (redirectCount >= 5) {
            return reject(new Error('Apps Script redirect terlalu banyak'));
          }
          try {
            const nextUrl = new URL(location, url).toString();
            const preserveMethod = statusCode === 307 || statusCode === 308;
            const nextMethod = preserveMethod ? method : 'GET';
            const nextBody = preserveMethod ? body : null;
            const redirected = await requestJson(nextUrl, { method: nextMethod, body: nextBody, redirectCount: redirectCount + 1 });
            return resolve(redirected);
          } catch (error) {
            return reject(error);
          }
        }

        if (statusCode < 200 || statusCode >= 300) {
          return reject(new Error(`Apps Script HTTP ${statusCode}: ${String(data).slice(0, 200)}`));
        }
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch (error) {
          reject(new Error('Apps Script response bukan JSON valid'));
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function uploadToCatbox(buffer, filename, mimetype = 'application/octet-stream') {
  const CRLF = String.fromCharCode(13, 10);
  const boundary = '----CatboxUpload' + Date.now() + Math.random().toString(36).slice(2);

  const parts = [];
  parts.push(Buffer.from(
    '--' + boundary + CRLF +
    'Content-Disposition: form-data; name="reqtype"' + CRLF + CRLF +
    'fileupload' + CRLF
  ));
  parts.push(Buffer.from(
    '--' + boundary + CRLF +
    'Content-Disposition: form-data; name="fileToUpload"; filename="' + filename + '"' + CRLF +
    'Content-Type: ' + mimetype + CRLF + CRLF
  ));
  parts.push(buffer);
  parts.push(Buffer.from(CRLF + '--' + boundary + '--' + CRLF));

  const body = Buffer.concat(parts);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'catbox.moe',
      path: '/user/api.php',
      method: 'POST',
      headers: {
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Content-Length': body.length,
        'User-Agent': 'Mozilla/5.0'
      }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        const url = String(data || '').trim();
        if (url.startsWith('https://') || url.startsWith('http://')) return resolve(url);
        reject(new Error('Catbox response: ' + url.slice(0, 200)));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function appendTableRow(row) {
  return requestJson(APPS_SCRIPT_URL, {
    method: 'POST',
    body: {
      action: 'append',
      row: {
        link: row.link || '',
        title: row.title || '',
        caption: row.caption || '',
        hashtag: row.hashtag || '',
        status: String(row.status || 'pending').toLowerCase()
      }
    }
  });
}

function buildDefaultHashtags() {
  return '#viral #fyp #foryou #foryoupage #viralvideos #trending #shorts';
}

function getOutputDir() {
  return path.join(__dirname, '..', 'output');
}

router.post('/api/video-share', async (req, res) => {
  try {
    requireAppsScriptUrl();
    const { title, caption, hashtag, videoBase64, filename, mimetype } = req.body || {};
    if (!videoBase64) return res.status(400).json({ status: 'error', error: 'videoBase64 wajib diisi' });

    const cleanedBase64 = String(videoBase64).replace(/^data:[^;]+;base64,/, '');
    const videoBuffer = Buffer.from(cleanedBase64, 'base64');
    if (!videoBuffer.length) return res.status(400).json({ status: 'error', error: 'videoBase64 tidak valid' });

    const link = await uploadToCatbox(videoBuffer, filename || 'video.mp4', mimetype || 'video/mp4');
    const result = await appendTableRow({
      link,
      title: title || '',
      caption: caption || '',
      hashtag: hashtag || '',
      status: 'pending'
    });
    res.json({ status: 'ok', link, sheet: result });
  } catch (error) {
    console.error('[VIDEO SHARE POST]', error);
    res.status(500).json({ status: 'error', error: error.message });
  }
});

router.post('/api/video-share/batch-from-convert', async (req, res) => {
  try {
    requireAppsScriptUrl();
    const { jobId, ratio, selectedIndices, clips } = req.body || {};
    const ratioTag = String(ratio || '').replace(':', 'x');
    const clipList = Array.isArray(clips) ? clips : [];

    if (!jobId) return res.status(400).json({ status: 'error', error: 'jobId wajib diisi' });
    if (!ratioTag) return res.status(400).json({ status: 'error', error: 'ratio wajib diisi' });
    if (!clipList.length) return res.status(400).json({ status: 'error', error: 'clips wajib diisi' });

    const allowedIndices = new Set((Array.isArray(selectedIndices) ? selectedIndices : []).map((x) => parseInt(x, 10)).filter((x) => Number.isInteger(x) && x >= 0));
    const outputDir = getOutputDir();
    const rows = [];

    for (const clip of clipList) {
      const originalIndex = parseInt(clip.originalIndex, 10);
      if (!Number.isInteger(originalIndex)) continue;
      if (allowedIndices.size && !allowedIndices.has(originalIndex)) continue;
      const sourceFilename = String(clip.filename || '');
      if (!sourceFilename) continue;

      const outputFilename = sourceFilename.replace('.mp4', `_${ratioTag}.mp4`);
      const outputPath = path.join(outputDir, outputFilename);
      if (!fs.existsSync(outputPath)) continue;

      const buffer = fs.readFileSync(outputPath);
      if (!buffer.length) continue;

      const link = await uploadToCatbox(buffer, outputFilename, 'video/mp4');
      const hashtag = String(clip.hashtag || clip.hashtags || '').trim() || buildDefaultHashtags();
      const row = {
        link,
        title: String(clip.hook_title || clip.title || `Clip ${originalIndex + 1}`).trim(),
        caption: String(clip.caption || '').trim(),
        hashtag,
        status: 'pending'
      };
      await appendTableRow(row);
      rows.push(Object.assign({}, row, {
        outputFilename,
        localMediaUrl: `/output/${outputFilename}`
      }));
    }

    if (!rows.length) {
      return res.status(400).json({ status: 'error', error: 'Tidak ada clip hasil convert yang bisa disimpan ke tabel' });
    }

    res.json({ status: 'ok', saved: rows.length, rows });
  } catch (error) {
    console.error('[VIDEO SHARE BATCH]', error);
    res.status(500).json({ status: 'error', error: error.message });
  }
});

router.get('/api/video-table', async (req, res) => {
  try {
    requireAppsScriptUrl();
    const url = new URL(APPS_SCRIPT_URL);
    url.searchParams.set('action', 'list');
    const result = await requestJson(url.toString());
    const rows = Array.isArray(result.rows) ? result.rows : (Array.isArray(result.data) ? result.data : []);
    res.json(rows.map((row) => ({
      link: row.link || row.url || '',
      title: row.title || row.judul || '',
      caption: row.caption || '',
      hashtag: row.hashtag || row.hashtags || '',
      status: String(row.status || 'pending').toLowerCase()
    })));
  } catch (error) {
    console.error('[VIDEO SHARE GET]', error);
    res.status(500).json({ status: 'error', error: error.message });
  }
});

router.patch('/api/video-share/status', async (req, res) => {
  try {
    requireAppsScriptUrl();
    const { link, status } = req.body || {};
    const normalizedStatus = String(status || '').trim().toLowerCase();
    if (!link) return res.status(400).json({ status: 'error', error: 'link wajib diisi' });
    if (!['pending', 'upload', 'publish'].includes(normalizedStatus)) {
      return res.status(400).json({ status: 'error', error: 'status harus pending, upload, atau publish' });
    }

    const result = await requestJson(APPS_SCRIPT_URL, {
      method: 'POST',
      body: {
        action: 'update_status',
        link,
        status: normalizedStatus
      }
    });

    if (result && result.ok === false) {
      const error = new Error(String(result.error || 'Apps Script update_status gagal'));
      error.statusCode = 502;
      throw error;
    }

    res.json({ status: 'ok', result });
  } catch (error) {
    console.error('[VIDEO SHARE STATUS]', error);
    res.status(500).json({ status: 'error', error: error.message });
  }
});

router.delete('/api/video-share', async (req, res) => {
  try {
    requireAppsScriptUrl();
    const { link } = req.body || {};
    if (!link) return res.status(400).json({ status: 'error', error: 'link wajib diisi' });

    const result = await requestJson(APPS_SCRIPT_URL, {
      method: 'POST',
      body: {
        action: 'delete_row',
        link
      }
    });

    if (result && result.ok === false) {
      const error = new Error(String(result.error || 'Apps Script delete_row gagal'));
      error.statusCode = 502;
      throw error;
    }

    res.json({ status: 'ok', result });
  } catch (error) {
    console.error('[VIDEO SHARE DELETE]', error);
    res.status(error.statusCode || 500).json({ status: 'error', error: error.message });
  }
});

module.exports = router;
