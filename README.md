# PPT Secure Slideshow Viewer

Web MVP untuk menjual/menampilkan materi presentasi tanpa memberikan file PPT asli ke pembeli.

## Fitur

- Admin login.
- Admin upload deck presentasi.
- Admin delete deck.
- Admin generate/delete kode akses.
- Kode akses dibatasi jumlah device, misalnya 1 kode untuk 2 device.
- Viewer memasukkan kode akses.
- Mode fullscreen slideshow.
- Proteksi UI: disable klik kanan, copy, print, drag, beberapa shortcut download/print.
- File PPT asli tidak diberikan ke viewer.
- Watermark kode akses + device.

## Batasan penting

Tidak ada web yang bisa 100% mencegah screenshot, screen recording, kamera HP, atau ekstraksi lewat DevTools oleh pengguna teknis. Proteksi di project ini adalah proteksi distribusi file dan friction layer, bukan DRM absolut.

PPTX animasi tidak bisa dijamin berjalan sempurna jika dikonversi menjadi gambar. Untuk animasi, gunakan mode `video`: export PPT dari PowerPoint ke MP4/WebM, lalu upload video tersebut sebagai deck. Untuk PPT tanpa animasi, gunakan mode `slides`, server akan convert PPT/PPTX/PDF menjadi gambar slide.

## Kebutuhan server

- Node.js 20+
- LibreOffice, untuk convert PPT/PPTX ke PDF
- Poppler utils, untuk convert PDF ke PNG

Ubuntu/Debian:

```bash
sudo apt update
sudo apt install -y libreoffice poppler-utils
```

Windows:

- Install LibreOffice.
- Install Poppler for Windows.
- Set `LIBREOFFICE_BIN` dan `POPPLER_PDFTOPPM_BIN` di `.env` jika command tidak ada di PATH.

## Instalasi

```bash
cp .env.example .env
npm install
npm start
```

Buka:

- Admin: http://localhost:3000/admin.html
- Viewer: http://localhost:3000/viewer.html

Default admin dari `.env.example`:

- Username: `admin`
- Password: `admin12345`

Ganti semua secret dan password sebelum production.

## Cara pakai

1. Login ke `/admin.html`.
2. Upload deck:
   - `slides`: upload `.ppt`, `.pptx`, atau `.pdf`. Cocok untuk PPT tanpa animasi.
   - `video`: upload `.mp4` atau `.webm`. Cocok untuk PPT beranimasi, setelah diexport ke video.
3. Generate kode akses dan tentukan jumlah device.
4. Pembeli buka `/viewer.html`, masukkan kode, lalu presentasi fullscreen.

## Rekomendasi production

- Wajib HTTPS.
- Simpan file di object storage private, bukan folder public.
- Pakai reverse proxy Nginx.
- Tambahkan rate limit untuk login dan akses code.
- Tambahkan audit log.
- Tambahkan watermark dinamis yang bergerak.
- Pertimbangkan DRM platform/secure streaming bila materi sangat mahal.
