/**
 * Shared helper functions for ElevenLabs STT + caption generation.
 * Used by both video-cropper.js and youtube-cutter.js
 */
const fs = require('fs');
const path = require('path');
const { runCommand, FFMPEG_PATH, PYTHON_CMD, PYTHON_ARGS } = require('../lib/utils');
const WHISPER_SCRIPT = path.join(__dirname, '..', 'lib', 'whisper_transcribe.py');
const FONT_DIR = path.join(__dirname, '..', 'assets', 'fonts');
const CAPTION_FONT_FILE = path.join(FONT_DIR, 'CaptionModern.ttf');
const CAPTION_FONT_NAME = fs.existsSync(CAPTION_FONT_FILE) ? 'Montserrat SemiBold' : 'Montserrat';

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

async function transcribeWithWhisper(audioPath, model = 'base') {
    const result = await runCommand(PYTHON_CMD, [...PYTHON_ARGS, WHISPER_SCRIPT, audioPath, '--model', model], path.dirname(audioPath));
    const lines = String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean);
    if (!lines.length) throw new Error('Whisper returned empty output');
    let parsed = null;
    for (let i = lines.length - 1; i >= 0; i--) {
        try {
            parsed = JSON.parse(lines[i]);
            break;
        } catch (e) { }
    }
    if (!parsed) throw new Error('Invalid response from Whisper');
    return parsed;
}

// Group words into readable subtitle lines (2-3 words per line)
function groupWordsIntoCaptions(words) {
    if (!words || words.length === 0) return [];
    const OFFSET = 0.0;
    const MIN_DUR = 0.5;
    const MAX_DUR = 3.0;
    const MAX_WORDS = 3;
    const MIN_WORDS = 2;
    const MIN_WORD_DUR = 0.12;
    const MAX_WORD_GAP = 0.45;

    const captions = [];
    let i = 0;
    while (i < words.length) {
        const firstStart = Math.max(0, Number(words[i].start || 0) + OFFSET);
        const firstEnd = Math.max(firstStart + MIN_WORD_DUR, Number(words[i].end || firstStart + 0.3) + OFFSET);
        const groupWords = [{ text: words[i].text, start: firstStart, end: firstEnd }];
        const groupStart = firstStart;
        let groupEnd = firstEnd;
        let j = i + 1;

        while (j < words.length && groupWords.length < MAX_WORDS) {
            const prevWord = groupWords[groupWords.length - 1];
            const rawStart = Math.max(0, Number(words[j].start || prevWord.end) + OFFSET);
            const wStart = Math.max(prevWord.end, rawStart);
            const rawEnd = Math.max(wStart + MIN_WORD_DUR, Number(words[j].end || wStart + 0.3) + OFFSET);
            const wEnd = rawEnd;
            const gap = wStart - prevWord.end;
            const potentialDur = wEnd - groupStart;
            if ((potentialDur > MAX_DUR || gap > MAX_WORD_GAP) && groupWords.length >= MIN_WORDS) break;
            groupWords.push({ text: words[j].text, start: wStart, end: wEnd });
            groupEnd = wEnd;
            j++;
        }
        if (groupEnd - groupStart < MIN_DUR) groupEnd = groupStart + MIN_DUR;

        captions.push({
            start: Math.round(groupStart * 100) / 100,
            end: Math.round(groupEnd * 100) / 100,
            text: groupWords.map(w => w.text).join(' '),
            words: groupWords
        });
        i = j;
    }
    return captions;
}

// === CAPCUT-STYLE ASS SUBTITLE GENERATOR ===
// Calm CapCut-like style: strong readable base text with gentle active-word highlight
function generateCapcutASS(captions, videoW, videoH) {
    const white = '&H00FFFFFF';
    const yellow = '&H0000FFFF';
    const outlineColor = '&H00000000';
    const shadowColor = '&H80000000';
    const inactiveColor = '&H00EAEAEA';
    const fontSize = Math.round(videoH * 0.068);
    const marginBottom = Math.round(videoH * 0.12);
    const WORDS_PER_GROUP = 3;
    const DIALOGUE_OVERLAP = 0.06;
    const MIN_DIALOGUE_DUR = 0.2;
    const FADE_IN_MS = 80;
    const FADE_OUT_MS = 120;

    let ass = '';
    ass += '[Script Info]\n';
    ass += 'Title: Karaoke Captions\n';
    ass += 'ScriptType: v4.00+\n';
    ass += 'PlayResX: ' + videoW + '\n';
    ass += 'PlayResY: ' + videoH + '\n';
    ass += 'WrapStyle: 0\n';
    ass += 'ScaledBorderAndShadow: yes\n';
    ass += 'YCbCr Matrix: TV.709\n';
    ass += '\n';
    ass += '[V4+ Styles]\n';
    ass += 'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n';
    ass += 'Style: Karaoke,' + CAPTION_FONT_NAME + ',' + fontSize + ',' + inactiveColor + ',' + yellow + ',' + outlineColor + ',' + shadowColor + ',-1,0,0,0,100,100,1,0,1,5.5,1.5,2,40,40,' + marginBottom + ',1\n';
    ass += '\n';
    ass += '[Events]\n';
    ass += 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';

    for (const cap of captions) {
        const text = String(cap.text || '').trim();
        if (!text) continue;
        const startTime = parseFloat(cap.start) || 0;
        const endTime = parseFloat(cap.end) || startTime + 2;
        const lineDuration = endTime - startTime;
        if (lineDuration <= 0) continue;

        let wordTimings;
        if (cap.words && cap.words.length > 0) {
            wordTimings = cap.words.map(w => ({
                text: String(w.text || '').trim(),
                start: parseFloat(w.start) || startTime,
                end: parseFloat(w.end) || (parseFloat(w.start) || startTime) + 0.3
            })).filter(w => w.text);
        } else {
            const words = text.split(/\s+/).filter(w => w);
            if (words.length === 0) continue;
            const wordDur = lineDuration / words.length;
            wordTimings = words.map((w, i) => ({
                text: w,
                start: startTime + i * wordDur,
                end: startTime + (i + 1) * wordDur
            }));
        }
        if (wordTimings.length === 0) continue;
        for (let wi = 0; wi < wordTimings.length; wi++) {
            const prev = wi > 0 ? wordTimings[wi - 1] : null;
            if (prev) wordTimings[wi].start = Math.max(wordTimings[wi].start, prev.end);
            wordTimings[wi].end = Math.max(wordTimings[wi].end, wordTimings[wi].start + 0.12);
        }

        // Group words into chunks
        const chunks = [];
        for (let i = 0; i < wordTimings.length; i += WORDS_PER_GROUP) {
            chunks.push(wordTimings.slice(i, Math.min(i + WORDS_PER_GROUP, wordTimings.length)));
        }

        for (let ci = 0; ci < chunks.length; ci++) {
            const chunk = chunks[ci];
            const chunkStart = chunk[0].start;
            const rawChunkEnd = ci < chunks.length - 1 ? chunks[ci + 1][0].start + DIALOGUE_OVERLAP : endTime + DIALOGUE_OVERLAP;
            const chunkEnd = Math.max(rawChunkEnd, chunk[chunk.length - 1].end + 0.1, chunkStart + MIN_DIALOGUE_DUR);

            // Build calmer karaoke text: subtle fade-in, active word turns yellow with gentle scale lift
            let karaokeText = '';
            for (let wi = 0; wi < chunk.length; wi++) {
                const wt = chunk[wi];
                const cleanWord = wt.text.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}');
                const wordOffsetMs = Math.round((wt.start - chunkStart) * 1000);
                const activeDur = Math.max(120, Math.round((wt.end - wt.start) * 1000));
                const settleDur = 140;

                karaokeText += '{\\fad(' + FADE_IN_MS + ',' + FADE_OUT_MS + ')\\1c' + inactiveColor + '\\fscx100\\fscy100';
                karaokeText += '\\t(' + wordOffsetMs + ',' + (wordOffsetMs + activeDur) + ',\\1c' + yellow + '\\fscx104\\fscy104)';
                karaokeText += '\\t(' + (wordOffsetMs + activeDur) + ',' + (wordOffsetMs + activeDur + settleDur) + ',\\1c' + white + '\\fscx100\\fscy100)';
                karaokeText += '}' + cleanWord;
                if (wi < chunk.length - 1) karaokeText += ' ';
            }

            const startASS = formatASSTime(chunkStart);
            const endASS = formatASSTime(chunkEnd);
            ass += 'Dialogue: 0,' + startASS + ',' + endASS + ',Karaoke,,0,0,0,,' + karaokeText + '\n';
        }
    }

    return ass;
}

function formatASSTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const cs = Math.round((seconds % 1) * 100);
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

module.exports = { extractAudio, transcribeWithElevenLabs, transcribeWithWhisper, groupWordsIntoCaptions, generateCapcutASS, formatASSTime };
