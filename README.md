# YT Cutter for Clippers

Web app buat clipping YouTube, crop video ke format vertikal, dan bulk scheduling Repliz.

## Features

- YouTube AI Cutter
- Bulk YouTube workflow
- Video Cropper dengan face detection helper
- Repliz dashboard
- Python helper untuk InsightFace dan Whisper

## Tech Stack

- Node.js + Express
- HTML/CSS/JavaScript frontend
- Python helper scripts
- InsightFace, OpenCV, NumPy, Whisper

## Requirements

- Node.js 18+
- npm 9+
- Python 3.11
- FFmpeg + FFprobe
- yt-dlp
- Build tools Linux untuk native module seperti `canvas` dan `@tensorflow/tfjs-node`

## Setup

### Windows

1. Install Node deps:

```bash
npm install
```

2. Install Python deps:

```bash
py -3.11 -m pip install -r requirements.txt
```

3. Optional local `bin/` folder kalau mau bundle binary sendiri:

```bash
mkdir bin
```

Isi bisa pakai:
- `bin/ffmpeg.exe`
- `bin/ffprobe.exe`
- `bin/yt-dlp.exe`

Kalau file itu tidak ada, app fallback ke binary dari `PATH`.

### Linux

Target aman: Debian / Ubuntu.

1. Install system packages:

```bash
sudo apt update
sudo apt install -y \
  nodejs npm python3 python3-pip python3-venv \
  ffmpeg yt-dlp \
  build-essential pkg-config libcairo2-dev libpango1.0-dev \
  libjpeg-dev libgif-dev librsvg2-dev
```

2. Install Node deps:

```bash
npm install
```

3. Install Python deps:

```bash
python3 -m venv .venv
. .venv/bin/activate
python -m pip install --upgrade pip setuptools wheel
python -m pip install -r requirements.txt
```

4. Verifikasi binary:

```bash
node -v
npm -v
python3 --version
ffmpeg -version
ffprobe -version
yt-dlp --version
```

## Optional Local Files

File ini sengaja tidak dipush dan harus tetap lokal:

- `client_secret.json`
- `token.json`
- `cookies.txt`

Kalau butuh YouTube OAuth atau download pakai cookies, taruh file itu sendiri di root project.

## Runtime Folders

Folder runtime dipakai buat file kerja sementara dan hasil proses.

| Folder | Fungsi | Status Git |
|---|---|---|
| `uploads/` | file input user | hanya folder, isi di-ignore |
| `downloads/` | hasil download mentah | hanya folder, isi di-ignore |
| `output/` | hasil final/export | hanya folder, isi di-ignore |
| `history/` | riwayat job/proses | hanya folder, isi di-ignore |
| `processed/` | file proses antara | full di-ignore |

Kalau folder belum ada:

```bash
mkdir uploads downloads output history processed
```

## Run

### Local basic

```bash
npm start
```

Buka:

- `http://localhost:3000`

### Public tunnel / remote host

Kalau app dibuka lewat tunnel / domain publik dan pakai YouTube OAuth, start pakai `PUBLIC_BASE_URL`:

```bash
PUBLIC_BASE_URL=https://your-public-url.example npm start
```

Kalau port mau diubah:

```bash
PORT=3000 npm start
```

## Linux Notes

- App sekarang fallback ke binary `ffmpeg`, `ffprobe`, `yt-dlp` dari `PATH` kalau `bin/` tidak ada.
- Python helper sekarang fallback ke `python3` di Linux.
- QSV encode default dibatasi ke Windows path saja.
- OAuth callback bisa pakai `PUBLIC_BASE_URL`, tidak hardcode localhost terus.

## Project Structure

- `server.js` — main server entry
- `routes/` — route app
- `public/` — frontend UI
- `lib/` — JS + Python helpers
- `models/` — face detection model assets

## License

Belum ada file license terpisah.
