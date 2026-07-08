const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

const BIN_DIR = path.join(__dirname, '..', 'bin');
const IS_WIN = process.platform === 'win32';

function resolveBinary(baseName, envVar) {
  const envValue = process.env[envVar];
  if (envValue) return envValue;

  const winLocal = path.join(BIN_DIR, `${baseName}.exe`);
  const plainLocal = path.join(BIN_DIR, baseName);

  if (IS_WIN && fs.existsSync(winLocal)) return winLocal;
  if (fs.existsSync(plainLocal)) return plainLocal;
  return IS_WIN ? `${baseName}.exe` : baseName;
}

const FFMPEG_PATH = resolveBinary('ffmpeg', 'FFMPEG_PATH');
const FFPROBE_PATH = resolveBinary('ffprobe', 'FFPROBE_PATH');
const YTDLP_PATH = resolveBinary('yt-dlp', 'YTDLP_PATH');
const COOKIES_PATH = path.join(__dirname, '..', 'cookies.txt');
const PYTHON_CMD = process.env.PYTHON_CMD || (IS_WIN ? 'py' : 'python3');
const PYTHON_ARGS = process.env.PYTHON_ARGS
  ? process.env.PYTHON_ARGS.split(' ').filter(Boolean)
  : (IS_WIN ? ['-3.11'] : []);

function runCommand(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, maxBuffer: 50 * 1024 * 1024, timeout: 900000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`Command failed: ${cmd} ${args.join(' ')}\n${stderr || error.message}`));
      else resolve({ stdout, stderr });
    });
  });
}

async function runYtdlp(args, cwd, opts = {}) {
  const commonRetryArgs = ['--retries', '20', '--fragment-retries', '20', '--retry-sleep', '2'];
  const profileDefault = [];
  const profileNoJs = ['--extractor-args', 'youtube:player_client=android,web;player_skip=js'];
  const profileNoJsIos = ['--extractor-args', 'youtube:player_client=ios,android;player_skip=js'];
  const profileJs = ['--js-runtimes', 'node', '--extractor-args', 'youtube:player_client=web_safari'];
  const profileImpersonate = ['--impersonate', 'chrome', '--extractor-args', 'youtube:player_client=web'];

  const preferNoCookies = !!opts.preferNoCookies;
  const attempts = [];
  const addWithCookies = () => {
    if (!fs.existsSync(COOKIES_PATH)) return;
    attempts.push({ label: 'with cookies (default extractor)', args: [...profileDefault, ...commonRetryArgs, '--cookies', COOKIES_PATH, ...args] });
    attempts.push({ label: 'with cookies (web_safari js)', args: [...profileJs, ...commonRetryArgs, '--cookies', COOKIES_PATH, ...args] });
    attempts.push({ label: 'with cookies (impersonate chrome)', args: [...profileImpersonate, ...commonRetryArgs, '--cookies', COOKIES_PATH, ...args] });
    attempts.push({ label: 'with cookies (ios,android no-js)', args: [...profileNoJsIos, ...commonRetryArgs, '--cookies', COOKIES_PATH, ...args] });
    attempts.push({ label: 'with cookies (android,web no-js)', args: [...profileNoJs, ...commonRetryArgs, '--cookies', COOKIES_PATH, ...args] });
  };
  const addWithoutCookies = () => {
    attempts.push({ label: 'without cookies (default extractor)', args: [...profileDefault, ...commonRetryArgs, ...args] });
    attempts.push({ label: 'without cookies (web_safari js)', args: [...profileJs, ...commonRetryArgs, ...args] });
    attempts.push({ label: 'without cookies (impersonate chrome)', args: [...profileImpersonate, ...commonRetryArgs, ...args] });
    attempts.push({ label: 'without cookies (ios,android no-js)', args: [...profileNoJsIos, ...commonRetryArgs, ...args] });
    attempts.push({ label: 'without cookies (android,web no-js)', args: [...profileNoJs, ...commonRetryArgs, ...args] });
  };

  if (preferNoCookies) {
    addWithoutCookies();
    addWithCookies();
  } else {
    addWithCookies();
    addWithoutCookies();
  }

  let lastErr = null;
  for (const attempt of attempts) {
    try {
      console.log(`▶ yt-dlp attempt: ${attempt.label}`);
      return await runCommand(YTDLP_PATH, attempt.args, cwd);
    } catch (err) {
      lastErr = err;
      console.log(`⚠️ yt-dlp failed (${attempt.label}), trying next fallback...`);
    }
  }
  throw lastErr;
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
      depth--;
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
      depth--;
      if (start !== -1 && depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

function fetchJSON(url, options) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const lib = parsedUrl.protocol === 'https:' ? https : http;
    const req = lib.request(url, {
      method: options.method || 'GET',
      headers: options.headers || {}
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const body = String(data || '');
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body) });
          return;
        } catch (e) {
          const parsedArray = extractBalancedJSONArray(body);
          if (parsedArray) {
            try {
              resolve({ status: res.statusCode, data: JSON.parse(parsedArray) });
              return;
            } catch (innerErr) { }
          }
          const parsedObject = extractBalancedJSONObject(body);
          if (parsedObject) {
            try {
              resolve({ status: res.statusCode, data: JSON.parse(parsedObject) });
              return;
            } catch (innerErr) { }
          }
          reject(new Error(`Failed to parse response (status ${res.statusCode}): ${body.substring(0, 500)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(120000, () => { req.destroy(); reject(new Error('Request timeout')); });
    if (options.body) req.write(options.body);
    req.end();
  });
}

function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return mins + ':' + String(secs).padStart(2, '0');
}

function parseVTT(vttContent) {
  const lines = vttContent.split(/\r?\n/);
  const entries = [];
  const seenTexts = new Set();
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (line.includes('-->')) {
      const startMatch = line.match(/(\d{1,2}):(\d{2}):(\d{2})[.,]\d{3}/);
      const endMatch = line.match(/-->\s*(\d{1,2}):(\d{2}):(\d{2})[.,]\d{3}/);
      if (startMatch && endMatch) {
        const startSec = parseInt(startMatch[1]) * 3600 + parseInt(startMatch[2]) * 60 + parseInt(startMatch[3]);
        const endSec = parseInt(endMatch[1]) * 3600 + parseInt(endMatch[2]) * 60 + parseInt(endMatch[3]);
        const duration = endSec - startSec;
        i++;
        const textParts = [];
        let foundText = false;
        while (i < lines.length) {
          const textLine = lines[i].trim();
          if (textLine.includes('-->')) break;
          if (textLine === '') { if (foundText) break; i++; continue; }
          if (textLine === 'WEBVTT' || textLine.startsWith('Kind:') || textLine.startsWith('Language:') || textLine.startsWith('NOTE') || /^\d+$/.test(textLine)) { i++; continue; }
          const clean = textLine.replace(/<[^>]+>/g, '').replace(/\{[^}]+\}/g, '').trim();
          if (clean) { textParts.push(clean); foundText = true; }
          i++;
        }
        if (duration > 0 && textParts.length > 0) {
          const text = textParts.join(' ');
          if (!seenTexts.has(text)) { seenTexts.add(text); entries.push('[' + startSec + 's] ' + text); }
        }
        continue;
      }
    }
    i++;
  }
  return entries.join('\n');
}

function parseVTTPrecise(vttContent) {
  const lines = vttContent.split(/\r?\n/);
  const entries = [];
  const seen = new Set();
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (line.includes('-->')) {
      const startMatch = line.match(/(\d{1,2}):(\d{2}):(\d{2})[.,](\d{3})/);
      const endMatch = line.match(/-->\s*(\d{1,2}):(\d{2}):(\d{2})[.,](\d{3})/);
      if (startMatch && endMatch) {
        const startSec = parseInt(startMatch[1]) * 3600 + parseInt(startMatch[2]) * 60 + parseInt(startMatch[3]) + parseInt(startMatch[4]) / 1000;
        const endSec = parseInt(endMatch[1]) * 3600 + parseInt(endMatch[2]) * 60 + parseInt(endMatch[3]) + parseInt(endMatch[4]) / 1000;
        i++;
        const textParts = [];
        let foundText = false;
        while (i < lines.length) {
          const textLine = lines[i].trim();
          if (textLine.includes('-->')) break;
          if (textLine === '') { if (foundText) break; i++; continue; }
          if (textLine === 'WEBVTT' || textLine.startsWith('Kind:') || textLine.startsWith('Language:') || textLine.startsWith('NOTE') || /^\d+$/.test(textLine)) { i++; continue; }
          const clean = textLine.replace(/<[^>]+>/g, '').replace(/\{[^}]+\}/g, '').trim();
          if (clean) { textParts.push(clean); foundText = true; }
          i++;
        }
        if (endSec > startSec && textParts.length > 0) {
          const text = textParts.join(' ');
          const key = `${startSec.toFixed(3)}|${text}`;
          if (!seen.has(key)) {
            seen.add(key);
            entries.push(`[${startSec.toFixed(2)}s] ${text}`);
          }
        }
        continue;
      }
    }
    i++;
  }
  return entries.join('\n');
}

async function getVideoDimensions(videoPath) {
  const result = await runCommand(FFPROBE_PATH, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', videoPath], path.dirname(videoPath));
  const info = JSON.parse(result.stdout);
  return { width: info.streams[0].width, height: info.streams[0].height };
}

async function getVideoInfo(videoPath) {
  const result = await runCommand(FFPROBE_PATH, ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', videoPath], path.dirname(videoPath));
  const data = JSON.parse(result.stdout);
  const vs = data.streams.find(s => s.codec_type === 'video');
  return {
    width: parseInt(vs.width), height: parseInt(vs.height),
    duration: parseFloat(data.format.duration),
    fps: vs.avg_frame_rate ? eval(vs.avg_frame_rate) : 30
  };
}

function sanitizeCrop(r, srcW, srcH) {
  let x = Math.max(0, Math.floor(r.x || 0));
  let y = Math.max(0, Math.floor(r.y || 0));
  let w = Math.floor(r.w || srcW);
  let h = Math.floor(r.h || srcH);
  if (x + w > srcW) w = srcW - x;
  if (y + h > srcH) h = srcH - y;
  w = Math.floor(w / 2) * 2; h = Math.floor(h / 2) * 2;
  if (w < 2) w = 2; if (h < 2) h = 2;
  return { x, y, w, h };
}

function even(n) { n = Math.round(n); return n % 2 === 0 ? n : n + 1; }

// Parse VTT content into caption array filtered to a time range, with timestamps adjusted to clip-relative
function parseVTTToCaptions(vttContent, clipStartSec, clipEndSec) {
  const lines = vttContent.split(/\r?\n/);
  const captions = [];
  const seenTexts = new Set();
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (line.includes('-->')) {
      // Parse start timestamp (with milliseconds)
      const startMatch = line.match(/(\d{1,2}):(\d{2}):(\d{2})[.,](\d{3})/);
      const endMatch = line.match(/-->\s*(\d{1,2}):(\d{2}):(\d{2})[.,](\d{3})/);
      if (startMatch && endMatch) {
        const startSec = parseInt(startMatch[1]) * 3600 + parseInt(startMatch[2]) * 60 + parseInt(startMatch[3]) + parseInt(startMatch[4]) / 1000;
        const endSec = parseInt(endMatch[1]) * 3600 + parseInt(endMatch[2]) * 60 + parseInt(endMatch[3]) + parseInt(endMatch[4]) / 1000;
        i++;
        const textParts = [];
        let foundText = false;
        while (i < lines.length) {
          const textLine = lines[i].trim();
          if (textLine.includes('-->')) break;
          if (textLine === '') { if (foundText) break; i++; continue; }
          if (textLine === 'WEBVTT' || textLine.startsWith('Kind:') || textLine.startsWith('Language:') || textLine.startsWith('NOTE') || /^\d+$/.test(textLine)) { i++; continue; }
          const clean = textLine.replace(/<[^>]+>/g, '').replace(/\{[^}]+\}/g, '').trim();
          if (clean) { textParts.push(clean); foundText = true; }
          i++;
        }
        // Check if this segment overlaps with the clip time range
        if (textParts.length > 0 && endSec > clipStartSec && startSec < clipEndSec) {
          const text = textParts.join(' ');
          if (!seenTexts.has(text)) {
            seenTexts.add(text);
            captions.push({
              start: Math.max(0, parseFloat((startSec - clipStartSec).toFixed(2))),
              end: parseFloat((Math.min(endSec, clipEndSec) - clipStartSec).toFixed(2)),
              text: text
            });
          }
        }
        continue;
      }
    }
    i++;
  }
  return captions;
}

module.exports = {
  BIN_DIR, IS_WIN, FFMPEG_PATH, FFPROBE_PATH, YTDLP_PATH, COOKIES_PATH, PYTHON_CMD, PYTHON_ARGS,
  runCommand, runYtdlp, fetchJSON, formatTime, parseVTT, parseVTTPrecise, parseVTTToCaptions,
  getVideoDimensions, getVideoInfo, sanitizeCrop, even
};
