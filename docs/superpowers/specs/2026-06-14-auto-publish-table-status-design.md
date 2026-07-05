# 2026-06-14 Auto Publish Table Status Design

## Goal
Ubah status row pada `tabel share video` dari `pending` menjadi `publish` otomatis setelah submit ke Repliz atau Zernio dinyatakan sukses oleh API app ini.

## User-approved scope
- Trigger status update terjadi saat submit ke Repliz sukses
- Trigger status update terjadi saat submit ke Zernio sukses
- Status target langsung `publish`
- Patokan sukses memakai sukses response dari API app ini, bukan menunggu status final platform
- Flow auto-update hanya berlaku untuk handoff yang berasal dari tombol tabel

## Non-goals
V1 ini tidak mencakup:
- Menunggu status final publish dari platform sosial
- Retry otomatis jika update status tabel gagal
- Auto-refresh halaman tabel
- Mengubah submit manual biasa di tab Repliz/Zernio menjadi selalu terkait tabel
- Menambah status baru selain `pending`, `upload`, `publish`
- Menambah queue sync background atau webhook

## Product behavior
User membuka `tabel-share-video.html`, lalu klik tombol `Repliz` atau `Zernio` pada suatu row. Handoff draft ke `index.html` akan tetap seperti sekarang, tetapi draft ikut membawa identitas row tabel, paling aman memakai field `link`.

Setelah user submit di tab Repliz atau Zernio, jika request posting utama sukses, frontend langsung memanggil endpoint lokal `PATCH /api/video-share/status` dengan payload:

```json
{
  "link": "https://...",
  "status": "publish"
}
```

Jika update status tabel juga sukses, user melihat status sukses normal. Jika posting sukses tetapi update tabel gagal, posting tetap dianggap sukses. UI hanya menampilkan warning tambahan bahwa status tabel belum berhasil diubah.

Jika user submit Repliz/Zernio tanpa berasal dari tombol tabel, maka tidak ada auto-update status karena tidak ada row tabel yang sedang diikat ke flow itu.

## Why this approach
Pendekatan ini paling kecil ubahannya karena backend update status sudah ada (`PATCH /api/video-share/status`). Kita hanya perlu memastikan flow handoff dari tabel menyimpan `link` row, lalu success path di Repliz/Zernio memakai `link` itu untuk update status.

Ini juga menjaga agar posting tetap tidak gagal hanya karena Apps Script update tabel gagal. Posting ke platform dan sinkronisasi status tabel diperlakukan sebagai dua langkah berbeda, dengan posting utama tetap prioritas.

## Data contract

### Draft handoff from table
Draft yang dikirim dari tabel ke `index.html` harus memuat minimal:
- `link` — identitas row tabel yang dipakai untuk update status
- `title`
- `caption`
- `mediaUrl`

Repliz draft dan Zernio draft masing-masing tetap memakai localStorage terpisah seperti sekarang, tetapi isi draft ditambah field `link`.

### Runtime state in app.js
Frontend perlu menyimpan identitas row aktif yang berasal dari tabel agar success handler bisa memakainya. State ini boleh disimpan sebagai object kecil per provider atau helper umum, selama jelas sumbernya dan mudah di-reset setelah submit selesai.

Contoh shape yang cukup:

```js
{
  source: 'table-share',
  link: 'https://files.catbox.moe/...',
  title: '...',
  caption: '...',
  mediaUrl: '...'
}
```

## UI/UX behavior

### Table page
Tidak perlu ada perubahan visual besar pada halaman tabel. Tombol `Repliz` dan `Zernio` tetap seperti sekarang.

### Repliz/Zernio page
Tidak perlu ada kontrol baru. Perubahan hanya pada behavior setelah submit sukses:
- jika draft berasal dari tabel dan punya `link`, lakukan auto-update status ke `publish`
- jika update status gagal, tampilkan warning non-blocking

Contoh feedback:
- sukses penuh: `✅ Post berhasil ... Status tabel juga diubah ke publish.`
- sukses posting, gagal update tabel: `✅ Post berhasil ... ⚠️ Status tabel gagal diubah ke publish.`

## Architecture

### Frontend responsibilities
`public/tabel-share-video.html`
- tambahkan `link` ke payload draft Repliz
- tambahkan `link` ke payload draft Zernio

`public/app.js`
- saat consume draft dari tabel, simpan metadata source-table termasuk `link`
- tambahkan helper kecil untuk update status tabel ke `publish`
- panggil helper itu setelah success path Repliz
- panggil helper itu setelah success path Zernio
- reset draft/runtime marker setelah flow selesai atau setelah dipakai agar submit berikutnya tidak salah update row lama

### Backend responsibilities
`routes/video-share.js`
- kemungkinan tanpa perubahan besar karena endpoint `PATCH /api/video-share/status` sudah tersedia
- hanya perlu dipakai ulang apa adanya, selama payload `{ link, status: 'publish' }` sudah valid

## Error handling
- Jika draft tidak punya `link`, skip auto-update status tanpa error fatal
- Jika posting utama gagal, jangan ubah status tabel
- Jika posting utama sukses tapi `PATCH /api/video-share/status` gagal, tampilkan warning saja
- Jangan rollback posting utama hanya karena update Apps Script gagal
- Jika localStorage draft rusak atau tidak lengkap, fallback ke behavior manual biasa

## Testing plan

### Functional checks
1. Dari tabel klik `Repliz`, submit sukses, lalu row target berubah ke `publish`
2. Dari tabel klik `Zernio`, submit sukses, lalu row target berubah ke `publish`
3. Submit manual langsung dari tab Repliz tanpa asal tabel tidak mengubah row tabel mana pun
4. Submit manual langsung dari tab Zernio tanpa asal tabel tidak mengubah row tabel mana pun
5. Simulasikan Apps Script status update gagal setelah posting sukses; pastikan user dapat warning tapi posting tetap dianggap sukses

### Regression checks
- Handoff tabel → Repliz tetap mengisi form seperti sekarang
- Handoff tabel → Zernio tetap auto test connection / select all / default schedule seperti sekarang
- Update status manual dari tabel (jika masih dipakai backend/API) tidak rusak

## Files expected to change
- Modify: `public/tabel-share-video.html`
- Modify: `public/app.js`
- Likely unchanged or minor verify only: `routes/video-share.js`

## Acceptance criteria
- Row tabel yang dipost lewat tombol `Repliz` otomatis berubah ke `publish` setelah submit sukses
- Row tabel yang dipost lewat tombol `Zernio` otomatis berubah ke `publish` setelah submit sukses
- Submit non-tabel tidak memicu perubahan status tabel
- Gagal update status tabel tidak membatalkan keberhasilan posting utama
- Tidak ada auto-refresh tabel baru yang diperkenalkan
