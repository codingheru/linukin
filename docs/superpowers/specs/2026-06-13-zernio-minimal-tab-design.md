# 2026-06-13 Zernio Minimal Tab Design

## Goal
Tambah tab baru `Zernio` di `public/index.html` untuk auto posting minimal, terpisah dari Repliz, dengan scope kecil tapi siap dipakai. V1 fokus pada 1 account per post dan 3 action: `draft`, `schedule`, `publish now`.

## User-approved scope
- Tab baru bernama `Zernio`
- Pendekatan: tab terpisah, reuse pola Repliz
- Account selection: single account selector
- Submit actions: `Draft`, `Schedule`, `Publish Now` dalam 1 form

## Non-goals
V1 tidak mencakup:
- Dashboard penuh seperti Repliz
- Multi-account posting
- Queue/history Zernio
- Upload binary langsung ke Zernio
- Auto integrasi langsung dari table share atau hasil clip
- Analytics, comments, profiles management
- Auto connect account / OAuth flow

## Product behavior
User membuka tab `Zernio`, memasukkan API key, lalu menyimpan credential lokal. User bisa test connection. Jika valid, app memuat daftar account Zernio dan menampilkannya dalam dropdown.

User lalu mengisi:
- Title
- Caption
- Media URL
- Account
- Action (`draft`, `schedule`, `publish now`)
- Schedule time jika action = `schedule`

Saat submit, frontend mengirim request ke backend proxy lokal. Backend meneruskan request ke API Zernio dengan `Authorization: Bearer <apiKey>`. Backend juga memetakan action form ke payload endpoint Zernio. Hasil sukses atau gagal ditampilkan kembali ke user dalam status area/form feedback.

## Why separate tab
Memisahkan Zernio dari Repliz menahan scope supaya tidak merusak flow yang sudah jalan. User juga minta tab baru eksplisit di `index.html`. Reuse visual pattern Repliz menjaga UI konsisten tanpa menyatukan logic provider yang berbeda.

## Source assumptions from docs
Dokumentasi `https://docs.zernio.com/llms-full.txt` menunjukkan:
- base URL API: `https://zernio.com/api/v1`
- auth: bearer token API key
- supports draft / schedule / publish-now style posting
- media bisa via URL
- jika user punya banyak account pada platform sama, `account_id` perlu eksplisit

Implementasi v1 akan mengikuti asumsi ini dan menggunakan 1 selected `account_id` per submit.

## UI design

### Navigation
Tambah tab button baru di navbar utama:
- id tombol: `tabBtnZernio`
- target content: `tabZernio`

Tab switching frontend akan ditambah ke `switchTab(...)` mapping yang sudah ada.

### Layout
Struktur tab meniru bahasa visual Repliz tapi lebih kecil:
1. **Credential card**
   - API Key input
   - `Save` button
   - `Test Connection` button
   - connection status text/badge

2. **Composer card**
   - Account selector (`select`)
   - Title input
   - Caption textarea
   - Media URL input
   - Action selector (`draft`, `schedule`, `publish_now`)
   - Schedule datetime field, hidden unless `schedule`
   - Submit button
   - result message / error area

### UX details
- API key disimpan di `localStorage` agar user tidak isi ulang terus
- Test connection aktif tanpa harus submit post
- Jika API key kosong, disable account loading and submit
- Jika action bukan `schedule`, field datetime disembunyikan dan tidak dikirim
- Jika request sedang berjalan, button berubah loading/disabled
- Error backend ditampilkan apa adanya tapi dibersihkan jadi singkat bila perlu

## Frontend architecture
Semua logic tetap di `public/app.js` supaya konsisten dengan struktur proyek sekarang.

### New frontend state
Tambahan state minimal:
- `_zernioAccounts = []`
- `_zernioSelectedAction = 'draft'`

### New frontend functions
Direncanakan helper berikut:
- `zernioGetApiKey()`
- `zernioSaveCredentials()`
- `zernioHeaders()` atau body helper untuk proxy calls
- `zernioTestConnection()`
- `zernioLoadAccounts()`
- `zernioOnActionChange()`
- `zernioCreatePost()`
- `zernioSetStatus(message, type)`

### Frontend data flow
1. User save API key → localStorage
2. User test connection → `GET /api/zernio/accounts` with API key sent to backend proxy
3. Backend returns accounts → frontend fills dropdown
4. User fills form and choose action
5. Frontend validates required fields
6. Frontend `POST /api/zernio/posts`
7. Backend hits Zernio
8. Frontend shows success/failure

## Backend architecture
Buat route proxy lokal baru. Disarankan file baru mis. `routes/zernio.js` agar tidak mencampur dengan Repliz atau video share.

### Endpoints
#### `GET /api/zernio/accounts`
Purpose:
- validasi API key
- fetch account list untuk dropdown

Input:
- API key dikirim dari frontend, kemungkinan lewat header custom seperti `x-zernio-api-key` atau body/query jika perlu

Output normalized:
```json
{
  "status": "ok",
  "accounts": [
    {
      "id": "acc_123",
      "name": "My Account",
      "platform": "instagram"
    }
  ]
}
```

#### `POST /api/zernio/posts`
Purpose:
- create draft / schedule / publish now

Input normalized from frontend:
```json
{
  "apiKey": "...",
  "accountId": "...",
  "title": "...",
  "caption": "...",
  "mediaUrl": "https://...",
  "action": "draft|schedule|publish_now",
  "scheduledAt": "2026-06-13T20:00"
}
```

Output normalized:
```json
{
  "status": "ok",
  "action": "draft",
  "result": { }
}
```

### Backend responsibilities
- inject bearer auth
- validate required fields before calling Zernio
- map frontend action names ke format endpoint/payload Zernio yang benar
- normalize account list payload
- normalize post response
- return concise error messages to frontend

## Action mapping design
Karena docs menunjukkan 3 posting mode, frontend memakai selector tunggal.

Mapping concept:
- `draft` → backend create draft request
- `schedule` → backend create scheduled post request with datetime
- `publish_now` → backend create immediate publish request

Jika Zernio ternyata memakai endpoint berbeda per action, backend yang menangani branching. Frontend tetap sederhana dan stabil.

## Validation rules

### Credential/account
- API key wajib untuk test/load/submit
- accountId wajib saat submit

### Post content
- mediaUrl wajib di v1
- caption minimal optional unless API requires it
- title optional unless API requires it
- action wajib salah satu `draft`, `schedule`, `publish_now`
- `scheduledAt` wajib jika action = `schedule`

### Time handling
- frontend kirim datetime-local string
- backend konversi/normalisasi bila Zernio butuh ISO penuh
- jika docs menuntut timezone explicit, backend kirim dalam ISO UTC atau format yang cocok

## Error handling
- Invalid API key → tampil `API key tidak valid atau akses ditolak`
- No accounts → tampil `Account tidak ditemukan di Zernio`
- Missing media URL → validasi frontend sebelum submit
- Schedule without time → validasi frontend dan backend
- Upstream Zernio failure → tampil `Zernio API error: ...`
- Network timeout → tampil pesan retry-friendly

## Security considerations
- API key tidak hardcoded di repo
- API key tidak disimpan di backend permanent storage
- API key dikirim hanya ke backend proxy lokal saat diperlukan
- Backend tidak log full API key
- Error logging harus hati-hati agar tidak membocorkan credential

## Testing plan
Minimum verification saat implementasi nanti:
1. `node --check` untuk file backend/frontend yang berubah
2. `lsp_diagnostics` untuk file terkait
3. test save credential UI
4. test connection dengan API key valid
5. test load single account dropdown
6. test submit `draft`
7. test submit `publish now`
8. test submit `schedule` dengan waktu valid
9. test error kosong: no key, no media URL, no account, no schedule time

## Integration notes with existing app
- Reuse class/style system existing app, terutama card/form/button patterns dari Repliz
- Update `switchTab()` mapping di `public/app.js`
- Add content section `#tabZernio` di `public/index.html`
- Keep Repliz untouched selain nav/layout coexistence
- Do not change existing table-share or cropper flows in v1

## File plan
Likely files to change later during implementation:
- `public/index.html` — add tab button + tab panel markup
- `public/app.js` — add Zernio frontend logic + tab mapping
- `server.js` — mount new route if needed
- `routes/zernio.js` — new backend proxy route

## Open implementation detail intentionally deferred to coding phase
Exact Zernio request body and exact accounts endpoint response shape will be aligned to docs during implementation. Product scope is fixed; payload wiring is implementation detail.

## Acceptance criteria
Feature dianggap selesai jika:
1. Ada tab `Zernio` baru di `index.html`
2. User bisa simpan API key dan test connection
3. User bisa load dan pilih 1 account
4. User bisa submit post dengan action `draft`, `schedule`, atau `publish now`
5. `mediaUrl` bisa dipakai tanpa upload binary
6. Error tampil jelas di UI
7. Repliz existing flow tidak rusak
