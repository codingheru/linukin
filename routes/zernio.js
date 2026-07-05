const express = require('express');
const path = require('path');
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
  const normalizedPath = String(pathname || '').startsWith('/') ? String(pathname) : '/' + String(pathname || '');
  const url = new URL(ZERNIO_API_BASE + normalizedPath);
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

function fetchRemoteBinary(urlString) {
  const url = new URL(urlString);
  const client = url.protocol === 'https:' ? https : null;
  if (!client) {
    const error = new Error('Media URL harus https:// agar bisa dipakai ke Zernio');
    error.statusCode = 400;
    throw error;
  }

  return new Promise((resolve, reject) => {
    const req = client.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*' }
    }, (res) => {
      const statusCode = Number(res.statusCode || 0);
      if ([301, 302, 303, 307, 308].includes(statusCode) && res.headers.location) {
        try {
          const redirectedUrl = new URL(res.headers.location, url).toString();
          return resolve(fetchRemoteBinary(redirectedUrl));
        } catch (err) {
          return reject(err);
        }
      }
      if (statusCode < 200 || statusCode >= 300) {
        const error = new Error(`Gagal ambil media source (${statusCode})`);
        error.statusCode = 400;
        return reject(error);
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          buffer: Buffer.concat(chunks),
          contentType: String(res.headers['content-type'] || '').split(';')[0].trim() || 'application/octet-stream'
        });
      });
    });

    req.setTimeout(ZERNIO_TIMEOUT_MS, () => req.destroy(new Error('Download media source timeout (60s)')));
    req.on('error', (err) => {
      const error = new Error(err.message || 'Gagal download media source');
      error.statusCode = 400;
      reject(error);
    });
    req.end();
  });
}

function inferFilenameFromUrl(urlString, contentType) {
  try {
    const url = new URL(urlString);
    const base = path.basename(url.pathname || '') || 'media';
    if (base.includes('.')) return base;
  } catch { }

  const extMap = {
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'video/webm': '.webm',
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif'
  };
  return 'media' + (extMap[String(contentType || '').toLowerCase()] || '.bin');
}

function uploadBinaryToPresignedUrl(uploadUrl, buffer, contentType) {
  const url = new URL(uploadUrl);
  const client = url.protocol === 'https:' ? https : null;
  if (!client) {
    const error = new Error('Upload URL Zernio tidak valid');
    error.statusCode = 502;
    throw error;
  }

  return new Promise((resolve, reject) => {
    const req = client.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: 'PUT',
      headers: {
        'Content-Type': contentType || 'application/octet-stream',
        'Content-Length': buffer.length
      }
    }, (res) => {
      const statusCode = Number(res.statusCode || 0);
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        if (statusCode < 200 || statusCode >= 300) {
          const preview = Buffer.concat(chunks).toString('utf8').slice(0, 220);
          const error = new Error(`Upload media ke Zernio gagal (${statusCode}): ${preview}`);
          error.statusCode = 502;
          return reject(error);
        }
        resolve();
      });
    });

    req.setTimeout(ZERNIO_TIMEOUT_MS, () => req.destroy(new Error('Upload media ke Zernio timeout (60s)')));
    req.on('error', (err) => {
      const error = new Error(err.message || 'Gagal upload media ke Zernio');
      error.statusCode = 502;
      reject(error);
    });
    req.write(buffer);
    req.end();
  });
}

async function uploadMediaToZernio(apiKey, sourceUrl) {
  const downloaded = await fetchRemoteBinary(sourceUrl);
  if (!downloaded.buffer.length) {
    const error = new Error('Media source kosong atau tidak bisa dibaca');
    error.statusCode = 400;
    throw error;
  }

  const filename = inferFilenameFromUrl(sourceUrl, downloaded.contentType);
  const presign = await requestZernio('/media/presign', {
    method: 'POST',
    apiKey,
    body: {
      filename,
      contentType: downloaded.contentType,
      size: downloaded.buffer.length
    }
  });

  if (!presign.uploadUrl || !presign.publicUrl) {
    const error = new Error('Zernio presign response tidak lengkap');
    error.statusCode = 502;
    throw error;
  }

  await uploadBinaryToPresignedUrl(presign.uploadUrl, downloaded.buffer, downloaded.contentType);
  return {
    publicUrl: presign.publicUrl,
    type: String(presign.type || '').toLowerCase() || (String(downloaded.contentType || '').startsWith('video/') ? 'video' : 'image'),
    filename,
    contentType: downloaded.contentType
  };
}

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
    profileId: item.profileId || item.profile_id || item.profile?._id || '',
    raw: item
  })).filter((item) => item.id);
}

function toIsoLocalString(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString();
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

router.post('/api/zernio/posts', async (req, res) => {
  try {
    const apiKey = requireApiKey(req);
    const { accountIds, title, caption, mediaUrl, action, scheduledAt } = req.body || {};
    const normalizedAction = String(action || '').trim().toLowerCase();
    const normalizedAccountIds = Array.isArray(accountIds)
      ? [...new Set(accountIds.map((item) => String(item || '').trim()).filter(Boolean))]
      : [];
    const normalizedMediaUrl = String(mediaUrl || '').trim();
    const normalizedCaption = String(caption || '').trim();
    const normalizedTitle = String(title || '').trim();

    if (!normalizedAccountIds.length) {
      return res.status(400).json({ status: 'error', error: 'Pilih minimal 1 account' });
    }
    if (!normalizedMediaUrl) {
      return res.status(400).json({ status: 'error', error: 'Media URL wajib diisi' });
    }
    if (!['draft', 'schedule', 'publish_now'].includes(normalizedAction)) {
      return res.status(400).json({ status: 'error', error: 'Action harus draft, schedule, atau publish_now' });
    }
    if (normalizedAction === 'schedule' && !String(scheduledAt || '').trim()) {
      return res.status(400).json({ status: 'error', error: 'Waktu schedule wajib diisi' });
    }

    const upstreamAccounts = await requestZernio('/accounts', { method: 'GET', apiKey });
    const accountMap = new Map(normalizeAccountsResponse(upstreamAccounts).map((account) => [account.id, account]));
    const selectedAccounts = normalizedAccountIds.map((id) => accountMap.get(id)).filter(Boolean);
    if (!selectedAccounts.length) {
      return res.status(400).json({ status: 'error', error: 'Account terpilih tidak ditemukan di Zernio' });
    }
    if (selectedAccounts.length !== normalizedAccountIds.length) {
      return res.status(400).json({ status: 'error', error: 'Sebagian account terpilih tidak valid atau sudah tidak tersedia' });
    }

    const platforms = selectedAccounts.map((account) => ({
      platform: String(account.platform || '').trim().toLowerCase(),
      accountId: account.id
    }));

    if (platforms.some((item) => !item.platform || !item.accountId)) {
      return res.status(400).json({ status: 'error', error: 'Ada account tanpa platform valid' });
    }

    const uploadedMedia = await uploadMediaToZernio(apiKey, normalizedMediaUrl);
    const zernioMediaUrl = uploadedMedia.publicUrl;
    const mediaType = uploadedMedia.type === 'video' ? 'video' : 'image';
    const mediaItems = [{ url: zernioMediaUrl, type: mediaType }];
    const payload = {
      content: normalizedCaption || normalizedTitle || ' ',
      platforms,
      mediaItems,
      mediaUrls: [zernioMediaUrl],
      media_urls: zernioMediaUrl,
      customMedia: platforms.map((item) => ({
        platform: item.platform,
        accountId: item.accountId,
        mediaItems,
        mediaUrls: [zernioMediaUrl],
        media_urls: zernioMediaUrl,
        media: mediaItems
      }))
    };

    if (normalizedTitle) payload.title = normalizedTitle;
    if (normalizedAction === 'publish_now') payload.publishNow = true;
    if (normalizedAction === 'schedule') {
      const isoValue = toIsoLocalString(scheduledAt);
      if (!isoValue) {
        return res.status(400).json({ status: 'error', error: 'Format waktu schedule tidak valid' });
      }
      payload.scheduledFor = isoValue;
      payload.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    }

    const result = await requestZernio('/posts', { method: 'POST', apiKey, body: payload });
    res.json({ status: 'ok', action: normalizedAction, accountCount: platforms.length, result });
  } catch (error) {
    console.error('[ZERNIO POST]', error.message);
    res.status(error.statusCode || 500).json({ status: 'error', error: error.message });
  }
});

module.exports = router;
