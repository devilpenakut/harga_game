# Harga Game Termurah

Aplikasi web untuk membandingkan harga sebuah game di PC, Mac, PlayStation, Xbox, dan Switch, semuanya ditampilkan dalam rupiah.

## Sumber harga

| Platform | Toko | Region | Mata uang |
| --- | --- | --- | --- |
| PC, Mac | Steam | Indonesia | IDR |
| PC, Mac | Epic, GOG, Humble, dll. lewat IsThereAnyDeal (opsional) | Indonesia | IDR atau dikonversi |
| PlayStation | PlayStation Store | Indonesia | IDR |
| Xbox | Microsoft Store | Australia, Singapura | AUD, SGD, dikonversi |
| Switch | Nintendo eShop | Malaysia, Australia | MYR, AUD, dikonversi |

Harga bertanda ≈ dikonversi ke rupiah dengan kurs tengah harian dari open.er-api.com. Tagihan kartu akan sedikit lebih tinggi karena kurs bank dan biaya transaksi luar negeri.

Hanya IsThereAnyDeal yang merupakan API resmi. Sumber Steam, PlayStation, Xbox, dan Nintendo adalah endpoint tidak resmi yang bisa berubah atau diblokir sewaktu-waktu. Kalau satu sumber gagal, sumber lain tetap tampil dan aplikasi menyebut sumber mana yang tidak bisa diakses.

## Struktur

```
index.html                 tampilan pencarian dan hasil
functions/api/search.js    Pages Function: mengambil dan menggabungkan harga
README.md
```

Tidak ada proses build dan tidak ada dependensi.

## Cara deploy

### 1. Upload ke GitHub

1. Buat repository baru di github.com (boleh private).
2. Upload ketiga file dengan struktur folder persis seperti di atas. Lewat web: **Add file → Upload files**, lalu seret `index.html`, `README.md`, dan folder `functions`.

Atau lewat terminal:

```bash
git init
git add .
git commit -m "Versi pertama"
git branch -M main
git remote add origin https://github.com/NAMA-KAMU/harga-game.git
git push -u origin main
```

### 2. Hubungkan ke Cloudflare Pages

1. Buka dash.cloudflare.com → **Workers & Pages → Create → Pages → Connect to Git**.
2. Pilih repository tadi dan beri izin akses.
3. Isi pengaturan build:
   - Framework preset: `None`
   - Build command: kosongkan
   - Build output directory: `/`
4. Klik **Save and Deploy**. Aplikasi akan tersedia di `https://NAMA-PROYEK.pages.dev`.

Setelah ini, setiap `git push` ke branch `main` otomatis men-deploy versi baru.

### 3. Pasang ITAD_KEY (opsional)

Tanpa key, harga PC dan Mac hanya dari Steam. Dengan key, toko PC lain ikut dibandingkan.

1. Daftar dan buat aplikasi di isthereanydeal.com untuk mendapat API key gratis.
2. Di proyek Pages: **Settings → Variables and Secrets → Add**.
   - Nama: `ITAD_KEY`
   - Tipe: Secret
   - Nilai: API key kamu
3. Deploy ulang (**Deployments → Retry deployment**).

### 4. Pasang cache KV (opsional, disarankan)

Hasil pencarian disimpan 1 jam, jadi judul yang sudah pernah dicari tidak mengakses store lagi. Cache bawaan Cloudflare terpisah per lokasi server; KV membuatnya berlaku global.

1. **Storage & Databases → KV → Create**, beri nama misalnya `harga-game-cache`.
2. Di proyek Pages: **Settings → Bindings → Add → KV namespace**.
   - Variable name: `CACHE` (harus persis)
   - Namespace: pilih yang baru dibuat
3. Deploy ulang.

## Menguji setelah deploy

Buka langsung di browser:

```
https://NAMA-PROYEK.pages.dev/api/search?q=hades
```

Hasilnya JSON. Bagian `sources` menunjukkan status tiap sumber:

- `ok`: ada hasil
- `kosong`: sumber bisa diakses tapi tidak menemukan game itu
- `error`: sumber gagal diakses
- `itad: "off"`: `ITAD_KEY` belum dipasang

Coba satu game multiplatform (misalnya Hades) dan satu game eksklusif Switch.

## Pengaturan

Di bagian atas `functions/api/search.js`:

- `MAX`: jumlah hasil per sumber (bawaan 6)
- `CACHE_SECONDS`: masa simpan cache dalam detik (bawaan 3600)

Region Xbox dan Switch ada di daftar `markets` dalam fungsi `xbox` dan `nintendo`.

## Masalah yang mungkin muncul

- **PlayStation `error`**: kemungkinan Sony memblokir IP Cloudflare atau mengubah struktur halaman store. Solusinya memindahkan bagian PlayStation ke server sendiri.
- **Switch hanya menampilkan Australia**: ID game di katalog Malaysia berbeda dari katalog Eropa yang dipakai untuk pencarian.
- **Switch `kosong` untuk game yang jelas ada**: coba judul bahasa Inggris yang persis.
- **Game yang sama muncul di dua kartu**: penggabungan memakai judul, jadi "Hades" dan "Hades Deluxe Edition" dianggap berbeda.
- **Harga konversi kosong**: layanan kurs sedang tidak bisa diakses; coba lagi nanti.

## Catatan pemakaian region

Harga region lain hanya bisa dibayar kalau akun diset ke region itu. Akun Microsoft dan Nintendo bisa pindah region dengan batasan; akun PSN tidak bisa pindah region sama sekali.
