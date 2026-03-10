# 🚀 TikFlow — Panduan Instalasi Lengkap

## Daftar Isi
1. [Gambaran Sistem](#gambaran-sistem)
2. [Prasyarat](#prasyarat)
3. [Langkah 1 — TikTok Developer App](#langkah-1--tiktok-developer-app)
4. [Langkah 2 — Setup Cloudflare](#langkah-2--setup-cloudflare)
5. [Langkah 3 — Deploy Backend (Worker)](#langkah-3--deploy-backend-worker)
6. [Langkah 4 — Deploy Frontend (Pages)](#langkah-4--deploy-frontend-pages)
7. [Langkah 5 — Setup R2 per User](#langkah-5--setup-r2-per-user)
8. [Langkah 6 — Konfigurasi Pertama](#langkah-6--konfigurasi-pertama)
9. [Struktur Folder](#struktur-folder)
10. [Tabel Free Tier](#tabel-free-tier)
11. [Troubleshooting](#troubleshooting)
12. [FAQ](#faq)

---

## Gambaran Sistem

```
┌─────────────────────────────────────────────────────────┐
│                     TIKFLOW SYSTEM                      │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Browser User                                           │
│     │                                                   │
│     ▼                                                   │
│  Cloudflare Pages          ← Frontend (HTML/CSS/JS)     │
│     │  (tikflow.pages.dev)                              │
│     │                                                   │
│     ▼  REST API                                         │
│  Cloudflare Workers        ← Backend API + Scheduler    │
│     │  (worker.workers.dev)                             │
│     │                                                   │
│     ├──▶ Cloudflare D1     ← Database (SQLite serverless)│
│     ├──▶ Cloudflare KV     ← Session storage            │
│     └──▶ R2 (per-user)     ← Video storage              │
│                                                         │
│  [Cron: setiap 1 menit]                                 │
│  Workers Scheduler                                      │
│     ├── Baca jadwal dari D1                             │
│     ├── Ambil video dari R2 user                        │
│     ├── POST ke TikTok API                              │
│     └── Update status di D1                             │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## Prasyarat

- **Node.js** v18+ → https://nodejs.org
- **Akun Cloudflare** (gratis) → https://cloudflare.com
- **Akun TikTok Developer** → https://developers.tiktok.com
- **Git** (opsional, untuk deploy via GitHub)

---

## Langkah 1 — TikTok Developer App

### 1.1 Buat Aplikasi

1. Buka https://developers.tiktok.com
2. Login dengan akun TikTok Anda
3. Klik **"Manage apps"** → **"Create an app"**
4. Isi:
   - **App name**: TikFlow Scheduler
   - **Category**: Content & Media Tools
   - **Platform**: Web
5. Klik **"Create**"

### 1.2 Tambahkan Products

Di halaman app Anda, klik **"Add products"**:
- ✅ **Login Kit** (untuk OAuth login)
- ✅ **Content Posting API** (untuk upload & jadwal video)

### 1.3 Konfigurasi Login Kit

Di menu **Login Kit** → **Settings**:
- **Redirect URI**: Tambahkan:
  ```
  https://tikflow-worker.SUBDOMAIN_ANDA.workers.dev/api/accounts/callback
  ```
  *(Ganti `SUBDOMAIN_ANDA` dengan subdomain Workers Anda — akan diketahui di Langkah 3)*
- **Scope yang dicentang**:
  - `user.info.basic`
  - `video.upload`
  - `video.publish`

### 1.4 Konfigurasi Content Posting API

Di menu **Content Posting API** → **Settings**:
- Request access ke scope `video.publish` *(perlu review TikTok, 2-7 hari kerja)*
- Untuk testing gunakan **Sandbox Mode** terlebih dahulu

### 1.5 Catat Credentials

Di halaman **App Info**:
```
Client Key   : xxxxxxxxxxxxxxxx
Client Secret: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```
**Simpan baik-baik, jangan share ke siapapun!**

---

## Langkah 2 — Setup Cloudflare

### 2.1 Install Wrangler CLI

```bash
npm install -g wrangler
```

### 2.2 Login ke Cloudflare

```bash
wrangler login
# Akan membuka browser, login dengan akun Cloudflare Anda
```

### 2.3 Buat D1 Database

```bash
wrangler d1 create tikflow-db
```

Output:
```
✅ Successfully created DB 'tikflow-db'

[[d1_databases]]
binding      = "DB"
database_name = "tikflow-db"
database_id  = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"  ← CATAT INI
```

**Salin `database_id`** dan tempel ke `backend/wrangler.toml` di bagian:
```toml
[[d1_databases]]
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

### 2.4 Buat KV Namespace

```bash
wrangler kv:namespace create TIKFLOW_KV
```

Output:
```
✅ Successfully created namespace TIKFLOW_KV

[[kv_namespaces]]
binding = "KV"
id      = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"  ← CATAT INI
```

**Salin `id`** dan tempel ke `backend/wrangler.toml` di bagian:
```toml
[[kv_namespaces]]
binding = "KV"
id      = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

### 2.5 Buat R2 Bucket (untuk Super Admin sendiri)

1. Buka https://dash.cloudflare.com
2. Menu kiri → **R2 Object Storage**
3. Klik **"Create bucket"**
4. Nama bucket: `tikflow-videos-admin` *(bisa bebas)*
5. Location: **APAC** (agar lebih cepat di Indonesia)
6. Klik **"Create bucket"**

**Aktifkan Public Access**:
1. Klik bucket Anda
2. Tab **"Settings"**
3. Bagian **"Public access"** → klik **"Allow Access"**
4. Catat domain: `pub-xxxxxxxxxxxx.r2.dev`

**Buat API Token R2**:
1. Di halaman R2 → klik **"Manage R2 API tokens"**
2. Klik **"Create API token"**
3. Nama: `tikflow-token`
4. Permissions: **Object Read & Write**
5. Scope: **Specific bucket** → pilih bucket Anda
6. Klik **"Create API Token"**
7. Catat:
   ```
   Access Key ID    : xxxxxxxxxxxxxxxxxxxx
   Secret Access Key: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   Endpoint URL     : https://xxxxxxxxxxxx.r2.cloudflarestorage.com
   ```

---

## Langkah 3 — Deploy Backend (Worker)

### 3.1 Masuk ke folder backend

```bash
cd backend/
npm install
```

### 3.2 Update wrangler.toml

Buka `backend/wrangler.toml` dan sesuaikan:

```toml
[[d1_databases]]
database_id = "ID_D1_DARI_LANGKAH_2"

[[kv_namespaces]]
id = "ID_KV_DARI_LANGKAH_2"

[vars]
FRONTEND_URL       = "https://tikflow.pages.dev"
OAUTH_REDIRECT_URI = "https://tikflow-worker.NAMA_ANDA.workers.dev/api/accounts/callback"
```

### 3.3 Set Secrets

```bash
# TikTok Client Key (dari Langkah 1)
wrangler secret put TIKTOK_CLIENT_KEY
# ↑ Masukkan Client Key lalu tekan Enter

# TikTok Client Secret
wrangler secret put TIKTOK_CLIENT_SECRET
# ↑ Masukkan Client Secret lalu tekan Enter

# JWT Secret (string acak panjang)
wrangler secret put JWT_SECRET
# ↑ Masukkan string ini (contoh): a8f3k9d2m7n1p4q6r0s5t8u2v9w3x7y1z4b6c0d8e2f5g9h3j7
```

### 3.4 Inisialisasi Database

```bash
# Buat tabel di database LOCAL (untuk testing)
npm run db:init

# Buat tabel di database REMOTE (production) — WAJIB
npm run db:init:remote
```

Output yang diharapkan:
```
🌀 Executing on remote database tikflow-db...
✅ Executed 1 commands in 0.XXms
```

### 3.5 Deploy Worker

```bash
npm run deploy
```

Output:
```
✅ Successfully deployed tikflow-worker

Published tikflow-worker (X.XX sec)
  https://tikflow-worker.NAMA_ANDA.workers.dev
  schedule: * * * * *
```

**Catat URL worker Anda**: `https://tikflow-worker.NAMA_ANDA.workers.dev`

### 3.6 Update Redirect URI TikTok

Kembali ke https://developers.tiktok.com → App Anda → Login Kit → Settings

Update redirect URI dengan URL yang benar:
```
https://tikflow-worker.NAMA_ANDA.workers.dev/api/accounts/callback
```

---

## Langkah 4 — Deploy Frontend (Pages)

### Cara A — Via GitHub (Direkomendasikan)

1. Push folder ini ke GitHub:
   ```bash
   git init
   git add .
   git commit -m "Initial TikFlow deployment"
   git remote add origin https://github.com/NAMAANDA/tikflow.git
   git push -u origin main
   ```

2. Buka https://dash.cloudflare.com → **Pages** → **Create a project**

3. **Connect to Git** → pilih repo `tikflow`

4. Build settings:
   - **Framework preset**: None
   - **Build command**: *(kosongkan)*
   - **Build output directory**: `frontend`

5. Klik **"Save and Deploy"**

6. URL otomatis: `https://tikflow.pages.dev`

### Cara B — Via Wrangler CLI

```bash
cd frontend/
wrangler pages deploy . --project-name tikflow
```

### Update API URL di Frontend

Buka `frontend/index.html`, cari baris `const API_BASE` dan update:

```javascript
// Cari di awal script section:
const API_BASE = 'https://tikflow-worker.NAMA_ANDA.workers.dev';
```

*(Jika belum ada, tambahkan di awal `<script>` tag sebelum baris `let ME = null;`)*

---

## Langkah 5 — Setup R2 per User

Setiap pengguna **wajib** menghubungkan Cloudflare R2 mereka sendiri sebelum bisa upload video. Ini dilakukan langsung di dalam aplikasi:

1. Login ke TikFlow
2. Di sidebar kiri → klik **"Cloudflare R2"** *(ada dot oranye = belum setup)*
3. Isi form:
   - **Endpoint URL**: `https://xxxx.r2.cloudflarestorage.com`
   - **Nama Bucket**: contoh `tikflow-videos-namaanda`
   - **Access Key ID**: dari R2 API Token
   - **Secret Access Key**: dari R2 API Token
   - **Domain Publik**: `pub-xxxx.r2.dev`
4. Klik **"Test Koneksi"** untuk verifikasi
5. Klik **"Simpan & Verifikasi R2"**
6. Dot di sidebar berubah hijau ✅

**Supaya lebih mudah, buat panduan singkat untuk setiap user baru:**
```
1. Buka dash.cloudflare.com
2. R2 → Create bucket → nama bebas
3. Bucket Settings → Public Access → Allow
4. Manage R2 API Tokens → Create token (Read & Write)
5. Masukkan data ke TikFlow → R2 Settings
```

---

## Langkah 6 — Konfigurasi Pertama

### Login Super Admin

Buka `https://tikflow.pages.dev` dan login:
```
Email   : admin@tikflow.app
Password: admin123
```
**⚠️ Segera ganti password!** Masuk ke Settings → ubah password.

### Buat User Pertama

1. Sidebar → **Manajemen User** → **+ Tambah User**
2. Isi nama, email, password
3. Role: **User**
4. Pilih akun TikTok yang bisa diakses
5. Klik **"Buat Pengguna"**

### Hubungkan Akun TikTok

1. Sidebar → **Akun TikTok** → **+ Hubungkan Akun TikTok**
2. Klik **"Login dengan TikTok"**
3. Ikuti proses OAuth di halaman TikTok
4. Setelah redirect balik, akun akan muncul di daftar

---

## Struktur Folder

```
tikflow/
├── frontend/
│   ├── index.html          ← Aplikasi frontend (single-file)
│   └── _cf_headers         ← Security headers Cloudflare Pages
│
├── backend/
│   ├── worker.js           ← API + Cron Scheduler
│   ├── schema.sql          ← Database schema D1
│   ├── wrangler.toml       ← Konfigurasi deployment
│   └── package.json        ← npm scripts
│
└── docs/
    └── INSTALL.md          ← File ini
```

---

## Tabel Free Tier Cloudflare

| Layanan             | Free Tier             | Catatan                           |
|---------------------|-----------------------|-----------------------------------|
| Cloudflare Pages    | Unlimited bandwidth   | 500 build/bulan                   |
| Cloudflare Workers  | 100,000 req/hari      | Cukup untuk ~70 post/menit        |
| Cloudflare D1       | 500 MB, 5M baca/hari  | Cukup untuk jutaan post records   |
| Cloudflare KV       | 100,000 baca/hari     | Untuk session management          |
| Cloudflare R2       | 10 GB storage         | Per user, ~500-1000 video/bulan   |
| **Total biaya**     | **$0/bulan**          | Untuk skala kecil-menengah        |

**Estimasi kapasitas free tier:**
- 🧑 Hingga ~20 pengguna aktif
- 📱 Hingga ~10 akun TikTok
- 🎬 Hingga ~1.000 video/bulan (total semua user)
- 📅 Hingga ~50 jadwal posting/hari

---

## Troubleshooting

### Error: "R2 belum dikonfigurasi"
**Penyebab**: User belum setup Cloudflare R2 mereka  
**Solusi**: Masuk ke sidebar → Cloudflare R2 → isi form → simpan

### Error: "TikTok OAuth gagal"
**Penyebab**: Redirect URI tidak cocok atau Client Key salah  
**Solusi**:
```bash
# Cek secret sudah benar
wrangler secret list
# Pastikan TIKTOK_CLIENT_KEY dan TIKTOK_CLIENT_SECRET ada

# Update redirect URI di TikTok Developer console
# Pastikan URL persis sama termasuk https://
```

### Error: "video.publish scope not approved"
**Penyebab**: TikTok belum approve scope publish  
**Solusi**: Gunakan Sandbox Mode untuk testing dulu. Submit request review di TikTok Developer portal.

### Scheduler tidak jalan
**Penyebab**: Cron trigger belum aktif  
**Solusi**:
```bash
# Cek cron terdaftar
wrangler triggers list

# Redeploy jika perlu
npm run deploy
```

### Post berstatus "failed"
**Penyebab**: Token TikTok expired atau video tidak bisa diakses  
**Solusi**:
1. Cek status token akun TikTok → hubungkan ulang jika expired
2. Pastikan R2 bucket masih public
3. Klik tombol **Retry** di daftar post

### Error D1 database saat deploy
```bash
# Reset dan inisialisasi ulang
wrangler d1 execute tikflow-db --remote --command="DROP TABLE IF EXISTS users"
npm run db:init:remote
```

---

## FAQ

**Q: Apakah benar-benar gratis?**  
A: Ya, 100% gratis menggunakan free tier Cloudflare. Tidak perlu kartu kredit untuk skala kecil-menengah.

**Q: Berapa lama proses review TikTok?**  
A: Biasanya 2-7 hari kerja. Selama menunggu, gunakan Sandbox Mode untuk testing.

**Q: Apakah video disimpan permanen di R2?**  
A: Ya, video tersimpan di R2 user masing-masing sampai dihapus manual. Perhatikan kuota 10GB free tier.

**Q: Bisa dipakai untuk berapa akun TikTok?**  
A: Tidak ada batasan di level aplikasi. Batasan hanya dari TikTok API (rate limit per akun).

**Q: Apakah keranjang VT langsung aktif?**  
A: Tergantung status affiliate akun TikTok. Akun harus sudah terdaftar sebagai seller/affiliate di TikTok Shop.

**Q: Bisa deploy di server sendiri (non-Cloudflare)?**  
A: Worker.js ditulis untuk Cloudflare Workers. Untuk Node.js biasa, perlu modifikasi (ganti D1 dengan SQLite/Postgres, KV dengan Redis).

**Q: Bagaimana cara update aplikasi?**  
A: Edit file → commit ke GitHub → Cloudflare Pages otomatis redeploy. Untuk backend: `npm run deploy`

---

## Kontak & Support

Jika ada pertanyaan atau bug, buka issue atau hubungi developer.

**Versi**: 1.0.0  
**Terakhir diupdate**: 2025
