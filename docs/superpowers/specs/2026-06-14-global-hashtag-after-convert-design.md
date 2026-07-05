# 2026-06-14 Global Hashtag After Convert Design

## Goal
Tambah 1 input `Global Hashtags` setelah convert video selesai agar user bisa menambahkan hashtag secara keseluruhan ke hasil convert terakhir sebelum save ke tabel, schedule ke Repliz, kirim ke Zernio, atau memakai metadata hasil download.

## User-approved scope
- 1 input hashtag global di modal selesai convert
- Berlaku untuk **semua hasil convert terakhir**, baik mode single maupun all
- Cara gabung hashtag: **merge + dedupe** dengan hashtag/caption lama
- State hashtag global hanya berlaku untuk **hasil convert terakhir**, tidak persisten ke job berikutnya
- Dipakai sebelum:
  - simpan ke tabel
  - handoff/schedule ke Repliz
  - handoff/submit ke Zernio
  - metadata/caption hasil download

## Non-goals
Fitur ini tidak mencakup:
- Edit hashtag per clip satu per satu
- Menyimpan hashtag global ke `localStorage` lintas job/browser session
- Menambah kolom baru di Google Sheet
- Mengubah AI generation awal di backend
- Mengubah caption asli permanen di source backend job

## Product behavior
Setelah convert selesai dan modal `convertCompleteModal` muncul, user melihat field baru `Global Hashtags`. User bisa isi contoh seperti `#fyp #viral #podcast`.

Hashtag ini berlaku ke hasil convert terakhir saja. Saat user melakukan action berikut dari modal atau flow turunannya:
- save ke tabel
- kirim/schedule ke Repliz
- kirim/schedule ke Zernio
- memakai metadata caption/download dari hasil convert

app akan mengambil caption/hashtag lama, lalu menambahkan hashtag global dan membuang duplikat.

## Final merge rule
Aturan gabung yang disetujui:
1. Ambil caption/hashtag lama
2. Ambil hashtag global dari input modal
3. Gabungkan keduanya
4. Dedupe hashtag tanpa peduli huruf besar/kecil
5. Simpan urutan lama dulu, hashtag baru menyusul jika belum ada

Contoh:
- caption lama:
  `Ini caption\n\n#viral #podcast`
- global hashtags:
  `#podcast #fyp #shorts`
- hasil final:
  `Ini caption\n\n#viral #podcast #fyp #shorts`

## Scope by result set
Karena user memilih opsi `3`, field global ini berlaku untuk **hasil convert terakhir apapun modenya**:
- single convert
- convert all

Namun state-nya tetap hanya hidup untuk hasil convert terakhir yang sedang aktif. Saat job/hasil convert baru menggantikan state lama, hashtag global lama ikut hilang.

## UI design

### Convert completion modal
Tambahkan field baru di `convertCompleteModal`:
- Label: `Global Hashtags`
- Input: text input atau textarea 1 baris
- Placeholder contoh: `#fyp #viral #podcast`
- Helper text: `Berlaku ke semua hasil convert terakhir sebelum save/schedule/download.`

Field ini muncul untuk mode single maupun all agar konsisten dengan scope yang dipilih user.

### UX details
- Field default kosong setiap hasil convert baru selesai
- Jika user tidak isi apa-apa, behavior lama tetap jalan
- Jika user isi hashtag tanpa `#`, app boleh menormalkan jadi hashtag valid
- Jika user isi campuran spasi/koma/newline, app menormalisasi menjadi daftar hashtag bersih

## Data and state design
Frontend menyimpan state hashtag global hanya untuk hasil convert terakhir. State ini hidup bersama metadata `_cvtLastClipData` atau state sejenis di `public/app.js`.

State minimum yang dibutuhkan:
- raw input global hashtag untuk hasil convert aktif
- helper hasil normalisasi/merge saat dibutuhkan

State ini harus di-reset ketika hasil convert baru selesai atau ketika context hasil convert terakhir diganti.

## Frontend architecture
Semua logic cukup di `public/index.html` dan `public/app.js`.

### New frontend helpers
Direncanakan helper seperti:
- `getConvertGlobalHashtagsRaw()`
- `normalizeHashtagTokens(input)`
- `mergeCaptionWithGlobalHashtags(caption, globalInput)`
- `mergeHashtagText(existingHashtagText, globalInput)` bila perlu dipisah
- helper untuk mengambil caption final dari hasil convert aktif

### Where the merge must apply
#### 1. Save to table
Flow `saveConvertedClipsToTable()` harus mengirim caption/hashtag hasil merge, bukan caption mentah lama.

#### 2. Repliz handoff
Flow convert → Repliz harus memakai caption/title/media seperti sekarang, tetapi caption yang diisi ke form Repliz harus sudah mengandung hashtag global hasil merge.

#### 3. Zernio handoff
Flow convert/table → Zernio harus mengisi caption/media seperti sekarang, tetapi caption yang diisi ke Zernio composer harus sudah mengandung hashtag global hasil merge.

#### 4. Download metadata
Jika hasil download menghasilkan metadata/caption text yang dipakai user, teks itu juga harus memakai caption final yang sudah merge hashtag global.

## Behavioral boundaries
- Merge dilakukan di frontend/action layer, bukan regenerate clip dari backend
- Caption asli di `allResults` tidak wajib dimutasi permanen jika ada cara lebih aman di action layer
- Tetapi apa pun pendekatannya, semua action dari hasil convert terakhir harus konsisten memakai caption final yang sama

## Error handling
- Input kosong → no-op, flow lama tetap jalan
- Input hashtag kacau (`viral, fyp #podcast`) → app bersihkan jadi hashtag valid sebisa mungkin
- Jika merge gagal karena bug parsing, fallback aman adalah caption lama tetap dipakai, bukan memblokir seluruh flow

## Testing plan
Verifikasi minimal:
1. Convert single clip → isi global hashtags → send to Repliz → caption di form Repliz mengandung hashtag hasil merge
2. Convert single clip → isi global hashtags → handoff Zernio → caption Zernio mengandung hashtag hasil merge
3. Convert all → save ke tabel → row yang dikirim memakai hashtag hasil merge
4. Duplicate hashtag tidak muncul dua kali
5. Hasil convert baru mereset field hashtag global lama
6. Jika field kosong, semua flow lama tetap aman

## Files likely affected
- `public/index.html`
- `public/app.js`

## Acceptance criteria
Fitur dianggap selesai bila:
- modal selesai convert punya field `Global Hashtags`
- input berlaku untuk semua hasil convert terakhir
- merge memakai aturan gabung + dedupe
- save ke tabel memakai hashtag hasil merge
- Repliz memakai caption hasil merge
- Zernio memakai caption hasil merge
- metadata/download memakai caption hasil merge
- state tidak bocor ke hasil convert/job berikutnya
- flow lama tetap aman bila input kosong
