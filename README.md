# Ruang — AI virtual office

Kantor 3D interaktif berbasis **Vite + Vue 3 + TypeScript + Three.js**. Backend memakai **Bun HTTP + SQLite bawaan**, tanpa framework server tambahan.

## Menjalankan

Prasyarat: Bun 1.3+ dan browser dengan WebGL/akselerasi grafis aktif.

```sh
bun install
# Untuk checkout baru: salin .env.example ke .env.
# .env lokal sudah disiapkan pada implementasi awal ini.
bun run dev
```

Buka **http://127.0.0.1:5173**. Perintah dev menjalankan Vite dan API lokal di port 29417 sekaligus. Kedua port harus tersedia.

Produksi lokal:

```sh
bun run build
bun run start
```

Buka **http://127.0.0.1:29417**. Server hanya mendengarkan loopback; jangan diteruskan ke internet.

## Docker dan instalasi lewat SSH/cURL

Image memakai Bun, menyajikan UI + API di port 29417, dan menyimpan data di volume `ruang-ai-data` (`/app/data`). Hanya provider HTTP yang tersedia di container; OMP/Hermes/Codex/Claude lokal dan pemilih folder native tidak ada di dalam image.

```sh
docker compose up -d --build            # build dan jalankan lokal
docker build -t ghcr.io/hendras1722/virtual-office:latest . && docker push ghcr.io/hendras1722/virtual-office:latest
```

Instal di server (server perlu Docker; `IMAGE` bawaan `ghcr.io/hendras1722/virtual-office:latest`, bisa diganti):

```sh
# via cURL
curl -fsSL https://raw.githubusercontent.com/hendras1722/virtual-office/main/install.sh | sh
# via SSH ke server (script dibaca dari checkout ini)
ssh user@server 'sh -s' < install.sh
# atau langsung lewat Docker context SSH
DOCKER_HOST=ssh://user@server docker compose up -d --build
```

`install.sh` melakukan `docker pull`, mengganti container lama bernama `ruang-ai`, dan menjalankannya dengan `--restart unless-stopped`. Variabel opsional: `NAME`, `VOLUME`, `PORT` (port host). Data tetap ada saat image diperbarui.

Container **hanya dipublikasikan ke `127.0.0.1` server** karena aplikasi tidak punya login dan menyimpan API key plaintext. Akses dari laptop lewat tunnel, lalu buka `http://127.0.0.1:29417` (server menolak header Host lain):

```sh
ssh -L 29417:127.0.0.1:29417 user@server
```

Jangan mengubah mapping port menjadi `0.0.0.0` tanpa reverse proxy berautentikasi.

## Alur penggunaan

1. Klik **Tambah agent**, pilih provider, lalu isi nama, peran, warna baju, dan pilih satu dari 12 karakter di daftar **Pilih karakter**. Provider API membutuhkan model dan key; OMP/Hermes memakai login CLI lokal, sedangkan **Codex · Login ChatGPT** memakai akun ChatGPT melalui Codex CLI resmi tanpa API key di Ruang.
2. Karakter langsung menempati satu meja kosong (jumlah bangku 1–24, bawaan 12; atur dengan tombol **Bangku** di header kantor). Penambahan menyimpan konfigurasi; login/key/model diuji pada task pertama. Untuk agent lokal, keberadaan executable diperiksa sebelum disimpan.
3. Pilih karakter/meja atau agent di daftar tim. Masukkan instruksi di panel **Task baru**, lalu klik **Jalankan task baru**.
   Accordion **Profil agent** di panel kanan awalnya terlipat. Buka untuk melihat nama, avatar, provider/model, peran, workspace, **Edit agent**, dan **Putus kontrak**; lipat kembali agar panel lebih ringkas. Form task dan hasil kerja tetap tersedia. Polling tidak mengubah posisi buka/tutup; memilih agent lain melipat profil kembali. Nama di daftar tim tetap terlihat.
4. Saat task API atau CLI berjalan, label di atas kepala NPC mengganti nama dengan aktivitas runtime (atau **Sedang bekerja** bila belum ada aktivitas). Saat meminta izin, label menampilkan **Minta izin** dan judul tindakan dengan penanda amber **!**. Detail lengkap serta tombol **Izinkan sekali**/**Tolak** (dan untuk OMP **Izinkan <tool> untuk sesi ini**, lihat bagian OMP) berada di dialog bergaya story di bawah adegan kantor, bukan lagi di panel kanan. Nama NPC tetap terlihat di dialog, daftar tim, dan tooltip label. Pilih label NPC atau nama dalam antrean dialog untuk meninjau permintaannya; dialog otomatis menampilkan permintaan lain yang masih menunggu setelah dijawab. Tombol **Minta izin · Lihat detail di bawah kantor** di panel tugas menuju dialog. Setelah izin dijawab, label kembali ke aktivitas; setelah task selesai/gagal, label kembali ke nama. Jawaban atau kegagalan tetap tampil di **Percakapan task**.
5. Beberapa agent dapat bekerja bersamaan; satu agent hanya boleh menjalankan satu task pada satu waktu. Setelah selesai/gagal, panel **Chat task** otomatis menautkan pesan berikutnya ke task tersebut. Klik **Task baru · Tanpa riwayat** untuk pekerjaan terpisah.
6. Pilih riwayat task untuk melihat rantai prompt, jawaban, error, dan progres parsialnya. Jawaban terpilih bisa disalin. Menghapus agent juga menghapus seluruh Todo dan riwayatnya; ada konfirmasi dan penghapusan ditolak selama agent bekerja.
7. Buka accordion **Profil agent**, klik **Putus kontrak** di bawah nama agent, lalu konfirmasi. Setelah penghapusan berhasil, karakter bangkit dari kursi dan berjalan melalui lorong menuju pintu yang terbuka, lalu menghilang di luar kantor. Meja langsung dapat dipakai agent baru tanpa menunggu animasi selesai. Pembatalan atau kegagalan penghapusan tidak memicu animasi; mode reduced-motion menghilangkan karakter tanpa gerakan berjalan.
8. Halaman lain di navigasi kiri: **Pipeline task** (`/#pipeline`, Todo dan papan status) dan **Meeting suara** (`/#meeting`, bicara dengan satu atau semua agent).

Drag untuk memutar kamera, klik kanan (atau dua jari / tombol panah) untuk menggeser, scroll/pinch atau tombol +/− untuk zoom ke arah kursor, tombol reset untuk kembali. Menggeser hanya dibuka saat zoom dan dibatasi ke dalam ruangan, jadi tampilan tidak keluar dari kantor. Pada layar kecil, hanya label lengkap agent terpilih yang ditampilkan agar tidak bertumpuk; NPC lain yang menunggu izin tetap memiliki badge **!** yang bisa dipilih. Karakter/meja, antrean izin, dan daftar tim tetap dapat dipilih. Preferensi reduced-motion menghentikan animasi karakter. Jika WebGL tidak tersedia, pengelolaan agent, dialog perizinan, dan task tetap dapat digunakan.

Jumlah bangku (1–24, bawaan 12) diatur dengan tombol − dan + di header kantor dan disimpan di tabel `settings` SQLite (`GET/PUT /api/office`, `{ "seats": n }`). Tiga meja per baris; lebih dari 12 bangku memperpanjang ruangan. Server menolak mengurangi bangku di bawah jumlah agent (409) dan menolak agent baru saat semua bangku terisi.

Mouse di atas adegan atau label agent berubah menjadi **cambuk**. Klik kiri memainkan ayunan gagang, lenturan tali, dan kilatan pecut; klik berulang memulai ulang efek tanpa menumpuk animasi. Efek hanya visual, tidak mengubah task atau perilaku agent. Drag tetap memutar kamera tanpa memecut, label tetap memilih agent, dan tombol kamera memakai kursor biasa. Keluar dari adegan atau membatalkan pointer membersihkan efek. Layar sentuh tidak menampilkan kursor cambuk; reduced-motion hanya menampilkan kilatan singkat tanpa ayunan.

Kartu **The main office** mengikuti scroll dengan posisi sticky, berjarak 16 px dari tepi atas hingga batas akhir area kantor. Tinggi adegan menyesuaikan viewport pendek agar header, kantor 3D, dan kontrol tetap terlihat.

Dialog perizinan membatasi tinggi detail dan menyediakan scroll agar perintah/patch panjang tetap bisa ditinjau. Di perangkat kecil, NPC lain yang menunggu tetap ditandai badge **!**; memilihnya menampilkan tindakan lengkap dan mengganti pembicara dialog. Perubahan ini hanya memindahkan UI: batas workspace, izin otomatis per task, dan validasi `requestId` di server tidak berubah.

## Pipeline task

- Buka **Pipeline task** di navigasi kiri atau URL **/#pipeline**. Ini halaman terpisah dari kantor; tombol **Kembali ke kantor** tidak menghentikan task. Draf form di kedua halaman bertahan saat berpindah halaman dalam tab yang sama, tetapi draf yang belum disimpan hilang saat reload.
- Pilih agent, isi prompt (maksimal **12.000 karakter**), lalu **Simpan ke Todo**. Prompt disimpan di SQLite tanpa memanggil provider/CLI dan tetap ada setelah reload/restart. Beberapa prompt dapat disiapkan untuk agent yang sama, termasuk saat agent sedang bekerja.
- Klik **Jalankan** pada kartu Todo untuk memulai task baru tanpa riwayat percakapan. Todo diubah atomik menjadi task dengan ID yang sama; klik/tab bersamaan tidak menjalankannya dua kali. Bila agent sibuk atau runtime tidak tersedia, prompt tetap berada di Todo.
- Kolom **Progress**, **Selesai**, dan **Gagal** mengikuti status task nyata dari sumber data yang sama dengan kantor, termasuk task yang dimulai lewat chat. Progress menampilkan aktivitas runtime; **Lihat output** atau **Lihat kendala & output** membuka hasil/error dan output parsial bila tersedia. Pembaruan mengikuti polling 1,5 detik, bukan persentase progres perkiraan.
- Permintaan tools ditandai **MINTA IZIN · Tinjau**. Dialog izin tersedia langsung di bawah papan dengan aturan izin sekali/tolak yang sama. Task dari Todo tidak mengaktifkan izin otomatis; persetujuan tools milik task lain tidak diwariskan.
- Todo dijalankan **manual**, bukan antrean otomatis atau rangkaian prompt yang saling meneruskan konteks. Satu agent tetap hanya boleh mengerjakan satu task sekaligus; agent berbeda dapat berjalan bersamaan. Tidak ada drag-and-drop yang dapat memalsukan status selesai/gagal.
- Papan menampilkan **semua Todo**, **100 task terbaru**, dan **seluruh task berjalan**. Menghapus agent juga menghapus Todo miliknya. Kantor 3D dilepas selama halaman Pipeline aktif agar tidak merender di latar belakang.
- API: `GET /api/todos`, `POST /api/todos { agentId, prompt }`, dan `POST /api/tasks { todoId }`. Rute task lama tetap didukung; penyimpanan menambah tabel `todos` tanpa mengubah agent, kredensial, atau riwayat task lama.

## Workspace di daftar agent

Folder workspace agent lokal kini terlihat tanpa membuka apa pun: nama folder tampil di bawah provider pada daftar **Your team**, dan path lengkapnya tampil di baris **Workspace** di atas panel kanan (di luar accordion **Profil agent**). Agent API/HTTP tidak punya workspace, jadi tidak menampilkannya.

## Karakter agent

Form **Tambah agent** dan **Edit agent** menampilkan daftar **Pilih karakter**: 12 karakter siap pakai, hanya gambar tanpa nama. Klik satu kartu untuk memilihnya. Agent baru mulai dengan karakter acak dari daftar. Baju mengikuti **Warna karakter** di atasnya. Karakter langsung dipakai NPC di kantor setelah disimpan.

- Daftar ada di `CHARACTER_PRESETS` (`src/character.ts`); setiap karakter adalah kombinasi warna kulit, gaya rambut, warna rambut, kacamata, dan hoodie.
- Disimpan di kolom `character` (JSON) pada tabel `agents`, ditambahkan otomatis tanpa menghapus data lama. `character` ada di `POST/PUT /api/agents` dan respons agent. Server menolak karakter yang tidak lengkap atau indeksnya di luar rentang (400). `PUT` tanpa `character` mempertahankan tampilan tersimpan; `null` mengembalikan tampilan otomatis.
- Agent lama tanpa pilihan tetap memakai tampilan otomatis dari ID-nya, jadi tidak berubah. Saat diedit, tampilan itu muncul sebagai kartu pertama yang sudah terpilih; tampilan baru tersimpan hanya jika kamu memilih kartu lain atau menyimpan form.
- Pratinjau adalah ilustrasi 2D sederhana; hasil 3D di kantor lebih detail.

## Mengedit agent

- Pilih agent, buka **Profil agent**, lalu klik **Edit agent**. Form menggunakan komponen yang sama dengan tambah agent dan terisi nama, provider, model, peran, warna, Base URL custom, serta workspace/persetujuan tools jika lokal. Klik **Simpan perubahan**; menutup dialog/Escape membatalkan draf.
- ID, waktu pembuatan, kursi, dan seluruh riwayat task dipertahankan. Nama/warna/profil langsung diperbarui; konfigurasi baru dipakai pada task berikutnya. Mengganti provider tidak menghapus percakapan, sehingga membalas task lama dapat mengirim riwayatnya ke provider baru.
- Key lama tidak dikirim kembali ke browser. Kolom key kosong mempertahankan key tersimpan hanya ketika provider dan endpoint yang dinormalisasi tetap sama. Isi kolom untuk mengganti key; jika provider atau endpoint berubah, masukkan key baru untuk provider yang memerlukan key. Ollama tetap mendukung key kosong; pindah ke runtime lokal menghapus kredensial HTTP.
- Edit ditolak selama agent mempunyai task berjalan, termasuk bila task dimulai dari tab lain saat dialog sudah terbuka. Draf tetap tersedia saat penyimpanan gagal. Batas jumlahjumlah bangkubangku tidak menghalangi edit agent yang sudah ada.
- `GET /api/agents/:id` memuat konfigurasi edit dan penanda `hasApiKey`, tanpa key. `PUT /api/agents/:id` menerima field yang sama dengan pembuatan agent dan memakai validasi provider, model, URL, workspace, runtime, serta persetujuan tools yang sama. Tidak ada migrasi database atau perubahan autentikasi CLI.

## Meeting suara

Halaman `#meeting` (ikon mikrofon di navigasi kiri) memungkinkan bicara langsung dengan agent seperti rapat.

- **Satu agent** atau **Semua agent**: pilih tile untuk bicara satu lawan satu, atau kirim ke semua agent sekaligus. Agent yang sedang bekerja dilewati dan ditandai di percakapan.
- **Mic nyala/mati** seperti Meet. Saat mic nyala, ucapan diubah jadi teks lalu dikirim otomatis setelah jeda sekitar 1,4 detik. Mic berhenti sendiri selama agent bekerja atau jawabannya dibacakan, lalu aktif lagi. Mic mati saat ada teks yang sedang ditangkap akan langsung mengirimkannya.
- **Suara AI** membacakan jawaban memakai text-to-speech browser, berurutan jika beberapa agent menjawab. Kode, markup, dan URL dilewati; jawaban panjang dipotong sekitar 1.500 karakter dan sisanya ada di teks. Bahasa bicara: Indonesia atau English.
- Setiap meeting punya rantai balasan sendiri per agent, sama seperti fitur Balas (`replyToId`), tetapi tidak memakai percakapan di panel kantor. Tidak ada perubahan API atau database.
- Pengenalan suara memakai **Web Speech API browser** (Chrome, Edge, Safari). Audio diproses oleh penyedia browser (di Chrome dikirim ke layanan Google), bukan oleh server Ruang, dan butuh internet serta izin mikrofon (`localhost` dianggap aman). Firefox belum mendukung. Galat "Layanan pengenalan suara tidak terjangkau" bukan soal internet biasa: browser gagal menghubungi server penyedianya. Penyebab umum: Brave atau Chromium (tanpa layanan Google), VPN/proxy/firewall, atau pemblokir iklan/DNS. Galat sesaat dicoba ulang otomatis hingga 2 kali sebelum mikrofon dimatikan; pakai Chrome, Edge, atau Safari tanpa VPN.
- Pesan suara tidak pernah mengaktifkan **Izinkan otomatis**. Agent lokal yang menerima pesan dapat meminta izin tools; dialog izin muncul di bawah halaman dan tetap manual. Pada mode **Semua agent**, agent lokal dengan akses tools ikut menerima pesan, jadi perhatikan isinya.
- Berpindah halaman mengakhiri meeting dan mematikan mikrofon. Riwayat percakapan meeting tetap tampil sampai halaman dimuat ulang; jawaban tersimpan seperti task biasa di Pipeline dan Office activity.

## Render hemat GPU

- Agent yang tidak sedang bekerja bergantian **tidur** (kepala menunduk, mata menutup, label `Zzz · Tidur`) dan **minum teh** (tangan mengangkat cangkir ke wajah, label `Minum teh`) dalam siklus 20 detik dengan fase berbeda antar kursi. Saat task masuk, cangkir langsung kembali ke meja dan karakter mengetik. Reduced-motion menetralkan pose dan menghentikan aktivitas idle; polling tidak mereset siklus.
- **Jalan-jalan saat idle:** agent yang sedang tenang (tidak bekerja, tidak sedang bereaksi, tidak sedang tidur atau minum teh di meja) sesekali bangkit lewat lorong ke salah satu tujuan: **pantry** (mesin kopi atau dispenser air di dinding kiri, 4-6 detik), **rak buku** (berdiri menghadap rak, mengambil buku, membacanya dengan kepala menunduk, lalu mengembalikannya; maksimal 2 orang sekaligus), atau **sofa** (berbalik, mundur, lalu duduk dengan pinggul turun dan kaki menekuk; membawa mug kopi panasnya dari meja dan santai sekitar 10-16 detik: sesekali ia mengangkat mug ke mulut dan menyeruput (kepala sedikit mendongak, mug miring), lalu menaruhnya kembali di pangkuan, dan sesekali menoleh; setelah itu berdiri dan membawa mug kembali ke meja; **maksimal 2 orang** di sofa). Ke pantry karakter membawa mugnya sendiri dari meja (mug di meja hilang selama ia pergi), memegangnya di telapak tangan, mengisinya di bawah keran mesin kopi atau dispenser, lalu meletakkannya kembali di meja sebelum duduk; bila ia dipanggil kembali sebelum sempat mengisi, mug kembali kosong. Mug berisi kopi panas **berasap**: uap tipis naik dari mug yang dibawa, dari mug di meja selama sekitar 40 detik setelah diletakkan kembali, dan saat agent minum teh di meja; mug berisi air tidak berasap, dan reduced-motion mematikan uap. Pantry punya satu tempat per mesin. Paling banyak 3 agent berada di luar meja sekaligus, dengan jeda minimal 5 detik antar keberangkatan; istirahat pertama sekitar 8-30 detik setelah agent muncul, lalu 45-90 detik antar istirahat. Kembali ke meja juga memakai gerakan duduk: berbalik menghadap meja lalu turun ke kursi. Label berubah menjadi `Ke pantry`, `Baca buku`, atau `Santai di sofa` dan mengikuti karakternya. Bila task baru atau hasil task datang, karakter bergegas kembali; dari sofa ia berdiri dulu dari posisi duduknya. Menghapus agent, mengganti agent di kursi itu, atau reduced-motion langsung mengakhiri istirahat. Sofa kini lebih rendah, bagian depan dudukannya menggantung agar betis yang duduk tidak menembus badan sofa, dan meja kopi digeser ke kiri agar ada jalan menuju sofa. Karakter yang berjalan tidak bisa diklik; labelnya tetap bisa dipilih.
- Ketika task **gagal**, karakter cemberut dengan alis miring, menunduk/menggeleng, dan mengangkat tangan ke dahi; label sementara `Kecewa`. Ketika task **selesai**, karakter tersenyum, mengangkat kedua tangan, dan memantul ringan; label `Senang!`. Kepala dan badan menoleh ke arah ruang agar wajah terlihat dari kamera awal. Gestur berlangsung sekitar **7 detik**, lalu tidur/minum teh kembali berjalan dengan ekspresi wajah sesuai hasil terakhir. Task baru menghentikan reaksi lama. Polling identik dan pemilihan agent tidak mengulang reaksi; task lain dengan hasil sama tetap memicu reaksi baru. Reduced-motion mempertahankan ekspresi wajah statis tanpa gestur.
- Animasi emosi, idle, mengetik, agent yang berjalan keluar, dan gerakan kamera dibatasi maksimum **30 FPS**. Kantor kosong berhenti merender setelah animasi terakhir selesai, termasuk pintu yang menutup.
- Resolusi canvas dibatasi **pixel ratio 1,5**. Bayangan memakai **1024 × 1024** dan diperbarui saat aksi karakter atau pintu bergerak, termasuk reaksi emosi, tidur, dan minum teh. Bayangan memakai cache saat adegan diam; perubahan kamera saja tidak membangunnya ulang.
- Tab yang tersembunyi menghentikan render; saat kembali, kamera dan status agent diperbarui. Preferensi reduced-motion tetap menonaktifkan animasi karakter.
- Animasi idle membuat renderer tetap aktif selama ada karakter dan reduced-motion tidak diaktifkan; beban GPU tidak lagi nol seperti adegan diam. Batas resolusi dapat membuat detail/bayangan sedikit lebih lembut pada layar Retina. Penghematan ini bukan jaminan suhu atau konsumsi daya tertentu; proses CLI lokal, tools browser, dan task agent tetap dapat membebani laptop.

## Task baru dan balasan

- **Jalankan task baru** memulai pekerjaan tanpa menyertakan riwayat task Ruang sebelumnya.
- Panel **Chat task** otomatis memakai task terpilih sebagai asal balasan setelah selesai atau gagal. Kotak pesan berada di bawah percakapan: **Enter** mengirim, **Shift+Enter** membuat baris baru, atau klik **Kirim balasan**. Setelah terkirim, pesan berikutnya tetap terhubung ke rantai itu.
- Task gagal/timeout memiliki tombol **Lanjutkan task**, termasuk ketika belum menghasilkan output. Tombol menyiapkan instruksi lanjutan untuk diperiksa/diedit sebelum dikirim, tanpa menimpa draf yang sudah ditulis. Prompt asli, status gagal/error, dan output parsial jika ada dikirim sebagai konteks; output parsial tidak dianggap hasil selesai.
- Banner **Melanjutkan task #…** menunjukkan task asal beserta cuplikan prompt. Memilih hasil lain dengan draf terisi tidak diam-diam mengganti target draf. **Task baru · Tanpa riwayat** beralih ke percakapan baru tanpa menghapus teks yang sedang ditulis. Memilih agent lain membersihkan draf dan konteks.
- **Percakapan task** menampilkan pesan Anda di kanan dan jawaban agent di kiri, dengan status, error, dan output parsial di gelembung pesan. **Salin** menyalin jawaban pada pesan tersebut; **Balas** dapat dipilih pada pesan lama untuk membuat cabang. Scroll mengikuti pesan terbaru kecuali Anda sedang membaca bagian atas. Seluruh rantai pendahulu, termasuk di luar daftar 100 task terbaru, dimuat dari `GET /api/tasks/:id/conversation`; output task aktif tetap mengikuti polling. **Task baru** mengosongkan tampilan untuk percakapan terpisah tanpa menghapus riwayat lama.
- Balasan menyertakan prompt dan jawaban dari task asal serta seluruh leluhurnya, berurutan. Task saudara, task baru lain, dan agent lain tidak ikut. Membalas pesan lama membuat cabang dari pesan itu, bukan mengambil pesan terbaru di luar rantainya.
- Hubungan disimpan sebagai `replyToId` di SQLite dan tetap tersedia setelah reload/restart. Task lama sebelum fitur ini otomatis menjadi awal percakapan (`replyToId: null`) dan tetap bisa dibalas. Task aktif atau task selesai tanpa jawaban tidak dapat menjadi asal balasan; task gagal dapat dilanjutkan dengan atau tanpa output.
- Provider API menerima riwayat sebagai pesan `user`/`assistant`. OMP/Hermes membuka proses/sesi ACP baru dan Codex membuka proses/thread app-server baru dengan transkrip sebagai konteks; fitur ini **bukan** resume sesi CLI lama dan tidak memulihkan state tools, tab browser, atau izin sebelumnya. Konfigurasi/memory bawaan CLI tetap mengikuti runtime masing-masing.
- Klien mengirim `{ agentId, prompt, replyToId, autoApprove }`; server mengambil konteks dari database. `autoApprove` opsional, default `false`, dan hanya dapat diaktifkan untuk agent lokal. Rantai harus berasal dari agent yang sama. Batas konteks **512.000 karakter**, termasuk prompt baru; percakapan yang melampaui batas ditolak dengan arahan membuat task baru, bukan dipotong diam-diam. Riwayat yang dikirim kembali menambah pemakaian token/biaya dan tetap tunduk pada context window model.

## Provider

| Provider              | Protokol                                                      | Konfigurasi endpoint                        |
| --------------------- | ------------------------------------------------------------- | ------------------------------------------- |
| OpenAI · API key      | Chat Completions; tagihan API terpisah dari langganan ChatGPT | `OPENAI_BASE_URL`                           |
| Anthropic · API key   | Messages API; tagihan API terpisah dari Claude Pro/Max        | `ANTHROPIC_BASE_URL`                        |
| Google Gemini         | OpenAI compatibility API                                      | `GEMINI_BASE_URL`                           |
| DeepSeek              | OpenAI compatibility API                                      | `DEEPSEEK_BASE_URL`                         |
| Ollama lokal          | OpenAI compatibility API; key opsional                        | `OLLAMA_BASE_URL`                           |
| Provider lain         | OpenAI-compatible Chat Completions                            | Base URL di form                            |
| OMP lokal             | ACP stdio, proses CLI asli                                    | `OMP_COMMAND` opsional; default `omp`       |
| Hermes lokal          | ACP stdio, proses CLI asli                                    | `HERMES_COMMAND` opsional; default `hermes` |
| Codex · Login ChatGPT | app-server JSON-RPC stdio, proses Codex CLI resmi             | `CODEX_COMMAND` opsional; default `codex`   |
| Antigravity lokal     | ACP stdio (agy_acp_server.par)                                | `ANTIGRAVITY_COMMAND` opsional              |
| Claude Code lokal     | `claude -p` stream-json, proses Claude Code resmi             | `CLAUDE_COMMAND` opsional; default `claude` |

`.env.example` berisi endpoint standar. Base URL adalah root versi (misalnya berakhir `/v1`), **bukan** URL lengkap `/chat/completions` atau `/messages`. HTTPS diwajibkan kecuali HTTP loopback untuk provider lokal. API key dikirim hanya ke endpoint provider yang dikonfigurasi. Pilih provider/URL yang dipercaya. Model di form adalah saran yang bisa diganti dengan ID model yang tersedia di akun provider. Ollama harus sudah berjalan dan modelnya sudah diunduh.

`APP_ORIGIN` membatasi Origin aplikasi ke localhost/127.0.0.1. Mengubah endpoint environment memerlukan restart server. Jangan meletakkan key di variabel `VITE_*` karena akan masuk bundle browser.

## Login langganan ChatGPT melalui Codex

Jalur ini memakai akun ChatGPT yang memiliki akses Codex; kuota dan model mengikuti paket/akun tersebut. Ini bukan cara memakai langganan untuk endpoint OpenAI API. Sesuai [dokumentasi app-server OpenAI](https://developers.openai.com/codex/app-server), integrasi autentikasi app-server ini hanya untuk aplikasi lokal/open-source pribadi, bukan layanan hosted atau komersial; skenario komersial membutuhkan jalur Sign in with ChatGPT dan persetujuan yang sesuai.

1. Pastikan **Codex CLI resmi** sudah terpasang dan `codex --version` berhasil. Ruang tidak memasang CLI otomatis.
2. Di terminal komputer server, dengan pengguna OS yang menjalankan Bun, jalankan:

   ```sh
   codex login
   codex login status
   ```

   Selesaikan login ChatGPT di browser. Lihat [autentikasi resmi Codex](https://developers.openai.com/codex/auth). Jangan menyalin cookie, token, atau file kredensial ke Ruang.

3. Di **Tambah agent**, pilih **Codex · Login ChatGPT**, atau gunakan tombol **Gunakan login ChatGPT lewat Codex** pada form OpenAI. Tidak ada field API key. Isi workspace absolut dan berikan persetujuan tools secara eksplisit. Model boleh kosong untuk memakai default CLI.
4. Jalankan task. Ruang memeriksa `account/read` sebelum membuka thread; akun belum login atau autentikasi API key ditolak, bukan dipakai sebagai fallback berbayar. Endpoint dan kredensial HTTP provider (`OPENAI_BASE_URL`, `OPENAI_API_KEY`, `CODEX_API_KEY`) tidak diwariskan ke proses Codex. Token OAuth tetap dikelola CLI.
5. Codex menggunakan kebijakan `workspaceWrite` / `unlessTrusted`. Permintaan izin command/file yang diteruskan ditandai di atas kepala NPC; detail dan tombol **Izinkan sekali** atau **Tolak** tampil di dialog story di bawah kantor. Permintaan Codex tetap manual meskipun **Izinkan otomatis untuk task ini** aktif, karena metadata approval belum menyediakan seluruh target file untuk memverifikasi batas workspace. Tidak ada izin sesi/permanen atau perubahan kebijakan sandbox. Kuota habis, model tidak tersedia, login kedaluwarsa, atau versi protokol tidak cocok menghasilkan task gagal dengan arahan memeriksa CLI.

Jika executable berada di luar PATH, atur `CODEX_COMMAND` ke path executable yang berfungsi, tanpa argumen shell, lalu restart backend. Status **Executable ditemukan** hanya memeriksa PATH/path, bukan kesehatan binari atau login. Jika launcher ada tetapi native binary hilang (`ENOENT`), perbaiki instalasi Codex resmi hingga `codex --version` berhasil sebelum menjalankan task.

Di macOS, binari yang hilang setelah instalasi juga dapat berasal dari penolakan tanda tangan oleh AMFI/Gatekeeper, bukan PATH yang salah. Jika macOS memindahkan Codex ke Trash atau menampilkan peringatan keamanan, gunakan rilis resmi terbaru yang diterima sistem. Jangan menonaktifkan Gatekeeper, menghapus atribut keamanan, atau menandatangani ulang binari untuk melewati penolakan tersebut.

### Bagaimana dengan langganan Anthropic?

Claude Pro/Max tidak otomatis menyediakan kredit API. [Dokumentasi Anthropic](https://code.claude.com/docs/en/agent-sdk/overview) melarang developer pihak ketiga menawarkan login/kuota Claude.ai untuk produknya tanpa persetujuan sebelumnya. Karena tidak ada persetujuan tersebut untuk Ruang, form Anthropic tetap memakai API key; Ruang tidak menambahkan login Claude.ai atau mengambil token/cookie langganan sebagai jalan pintas.

## Google Antigravity lokal

Ruang mendukung **Google Antigravity** sebagai agent lokal berbasis Agent Client Protocol (ACP). Jika Antigravity ACP terpasang di komputer server (misalnya melalui instalasi `agy_acp_server.par`), Ruang akan mendeteksinya secara otomatis.

1. Di **Tambah agent**, pilih **Antigravity · Local agent**.
2. Masukkan direktori workspace absolut dan centang persetujuan tools.
3. Model dapat dikosongkan untuk memakai default runtime (mis. `gemini-3.8-flash-high`) atau diisi ID model Gemini yang didukung runtime.
4. Jika binary berada di lokasi khusus, atur variabel `ANTIGRAVITY_COMMAND` pada `.env` dengan path penuh ke `agy_acp_server.par`, lalu restart backend.

## Claude Code lokal

Pilih **Claude Code · Local agent** di **Tambah agent** untuk memakai Claude Code yang sudah terpasang dan login di komputer server. Tidak ada API key di Ruang: login dikelola Claude Code sendiri, jadi kuota mengikuti paket akunmu.

1. Di terminal server jalankan `claude auth login`, lalu pastikan `claude auth status` menunjukkan `loggedIn: true`. Tanpa itu task gagal dengan pesan **Claude Code belum login atau sesi login kedaluwarsa**.
2. Pilih folder lewat **Pilih folder**, centang persetujuan akses tools, dan isi model bila perlu (alias `sonnet`/`opus` atau ID model; kosong memakai default CLI).
3. Ruang menjalankan `claude -p --input-format stream-json --output-format stream-json --permission-prompt-tool stdio --no-session-persistence` di folder itu. Peran agent dikirim lewat `--append-system-prompt`; **Balas** mengirim transkrip rantai percakapan sebagai konteks, bukan melanjutkan sesi Claude Code lama.
4. Setiap tindakan yang akan ditanyakan Claude Code (menulis atau mengedit file, menjalankan perintah, mengakses di luar folder) muncul di dialog kantor sebagai **Izinkan sekali** atau **Tolak**. Penolakan dikirim balik sehingga tool tidak berjalan. Bila detail terlalu panjang, hanya penolakan yang tersedia. Izinkan otomatis per task hanya menyetujui `Write`, `Edit`, `MultiEdit`, dan `Read` dengan path absolut di dalam workspace; perintah `Bash` dan tool lain selalu manual.
5. `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, dan `ANTHROPIC_BASE_URL` dihapus dari proses Claude Code, jadi pengaturan provider API Anthropic di Ruang atau `.env` tidak mengalihkan atau menagih Claude Code. Pengaturan, hook, plugin, dan CLAUDE.md milik Claude Code di komputer itu tetap berlaku seperti di terminal; hook yang menambahkan gaya jawaban (misalnya plugin gaya bicara) ikut memengaruhi jawaban agent ini.
6. Jika `claude` tidak ada di PATH server, atur `CLAUDE_COMMAND` ke path executable penuh (tanpa argumen) dan restart server.

Catatan: ini bukan sandbox dan tidak semua tindakan Claude Code harus ditanyakan (pembacaan di dalam folder kerja diizinkan Claude Code sendiri). Hentikan task untuk menghentikan proses; perubahan yang sudah terjadi tidak dibatalkan. Sama seperti jalur Codex, ini menjalankan CLI resmi dengan login milikmu sendiri untuk pemakaian lokal/pribadi; Ruang tidak menawarkan login Claude.ai kepada pihak lain. Aturan Anthropic soal penggunaan langganan di aplikasi pihak ketiga dapat berubah, jadi periksa ketentuan terbarunya sebelum memakai di luar pemakaian pribadi. Verifikasi: protokol izin diuji dengan binary `claude` asli yang diarahkan ke API Anthropic tiruan, bukan dengan model sungguhan.

## OMP dan Hermes lokal

Prasyarat: CLI sudah terpasang, dapat dijalankan oleh pengguna server Bun, dan sudah dikonfigurasi/login di terminal. Tidak perlu memasukkan atau menyalin API key ke Ruang untuk agent lokal.

```sh
omp --help
omp login
hermes --help
hermes setup
hermes acp --check
```

Di **Tambah agent**, pilih **OMP · Local agent** atau **Hermes · Local agent**:

1. Pastikan status **Executable ditemukan**. Ini deteksi executable, bukan jaminan kesehatan binari, autentikasi, atau model valid.
2. Klik **Pilih folder** pada **Direktori workspace**. Dialog folder bawaan sistem terbuka di komputer server (di macOS lewat `osascript`, Windows lewat PowerShell, Linux lewat `zenity`), jadi tidak perlu mengetik path. Tombol berganti menjadi **Ganti folder** setelah dipilih, dan agent lokal tidak bisa disimpan sebelum folder dipilih. Server menyimpan path kanonisnya (symlink diselesaikan) dan tidak membuat direktori. Bila dialog tidak bisa dibuka (tanpa sesi grafis, `zenity` tidak terpasang), kolom berubah menjadi input path manual. `POST /api/pick-folder` mengembalikan `{ path }` atau `{ path: null }` bila dibatalkan, 501 bila tidak tersedia, dan 409 bila dialog lain masih terbuka; dialog ditutup bila permintaan dibatalkan atau melewati 5 menit.
3. Kosongkan model untuk memakai model default dari konfigurasi CLI. Override OMP memakai selector runtime seperti `provider/model`; Hermes memakai ID model yang diterima runtime, umumnya `provider:model`. Model salah menghasilkan pesan kegagalan, bukan fallback palsu.
4. Baca dan centang persetujuan akses tools. Tanpa persetujuan eksplisit, frontend dan backend menolak penambahan agent lokal.
5. Jalankan task. Ruang membuka sesi ACP baru untuk setiap eksekusi, menggunakan identitas/peran agent. **Balas** membawa transkrip rantai percakapan sebagai konteks, bukan mengambil alih sesi OMP/Hermes yang sedang terbuka.

Jika executable tidak ada di PATH server, atur `OMP_COMMAND` atau `HERMES_COMMAND` pada `.env` menjadi path executable penuh, **bukan shell command berisi argumen**, lalu restart server. Status dan prasyarat tersedia melalui `/api/runtimes`.

Permintaan **ACP tool permission** dan form persetujuan tools OMP (`elicitation/create`, pilihan `Approve`/`Deny`) muncul bersama detail tindakan. Pilihan yang didukung: **Izinkan sekali**, **Tolak**, dan untuk OMP juga **Izinkan <tool> untuk sesi ini** bila OMP menawarkannya; opsi izin permanen tidak diteruskan ke UI. Detail yang melebihi batas tampilan tidak dapat disetujui. Reload halaman tetap menampilkan permintaan yang belum dijawab selama proses/server masih hidup. Form input bebas, form dengan field lain, permintaan sesi lain, serta operasi filesystem/terminal yang meminta eksekusi oleh client kantor tetap ditolak.

### Izinkan otomatis per task

- Sebelum mengirim task lokal (OMP/Hermes/Codex/Antigravity), centang **Izinkan otomatis untuk task ini** di bawah kotak pesan. Default mati. Pilihan direset setelah task berhasil dikirim, berpindah agent, atau memilih **Task baru**; balasan tidak mewarisinya.
- Saat aktif, server menjawab `allow_once` hanya untuk operasi file terstruktur yang dikenali adapter, menyediakan pilihan izin sekali, dan seluruh targetnya terverifikasi berada **di dalam workspace**. Pemeriksaan memakai batas segmen path dan resolusi filesystem: target di luar workspace, prefix direktori serupa, traversal `..`, dan symlink yang melewati luar workspace tetap manual. File baru boleh otomatis jika parent yang sudah ada terverifikasi aman.
- OMP kini mendukung form **Persetujuan tools OMP** untuk `write`, `read` file yang sudah ada, serta `edit` hashline tanpa pemindahan file, termasuk beberapa file dalam satu patch. Adapter mengambil argumen lengkap dari notifikasi `tool_call` sesi aktif, bukan menebak path dari judul atau isi dialog. Karena form OMP tidak membawa ID tool, persetujuan otomatis hanya berlaku bila tepat satu tool aktif dapat dicocokkan; metadata dikonsumsi sekali. Path filesystem biasa (huruf/angka ASCII, spasi, `_`, `-`, `.`, `/`) boleh absolut atau relatif ke workspace. Direktori, alias/URI/selector, nama path lain, edit dengan `MV`/format lain, tool bersamaan, metadata hilang/selesai/sesi lain tetap manual.
- Hermes ACP tetap mendukung `write_file` dan `patch` mode `replace` dengan path absolut serta satu diff yang cocok. Path relatif Hermes dapat mengikuti direktori aktif runtime sehingga tetap manual. Patch multi-file/V4A Hermes, perintah shell/skrip/`eval`, browser, metadata tidak lengkap/tidak dikenal, serta permintaan Codex/Antigravity tetap meminta izin. `cwd` di dalam workspace saja tidak membuktikan bahwa sebuah skrip hanya mengakses workspace.
- Akses di luar workspace tetap menunggu **Izinkan sekali** atau **Tolak**, walaupun checkbox otomatis dicentang. Persetujuan satu permintaan tidak mengizinkan tindakan berikutnya. Permintaan tanpa pilihan izin sekali, termasuk detail terlalu panjang, tetap manual; form tidak didukung dan permintaan sesi lain tetap ditolak oleh adapter.
- **Batas keamanan:** ini filter permintaan izin yang diteruskan runtime, **bukan sandbox CLI**. Tidak semua operasi CLI meminta izin kepada aplikasi, dan perubahan filesystem setelah pemeriksaan dapat mengubah target. Tidak ada grant sesi/permanen, perubahan konfigurasi global CLI, atau mode `yolo`. Gunakan **Hentikan task** untuk menghentikan proses; perubahan yang sudah terjadi tidak dibatalkan.
- Status aktif tampil di kontrol task dan tetap terlihat setelah reload. Kebijakan dimiliki server hanya selama task berjalan; browser tidak perlu tetap terbuka. Selesai/gagal/batal/restart menghapus kebijakan. Tidak ada migrasi database atau penyimpanan izin untuk task berikutnya.

### Izinkan untuk sesi ini (seperti OMP)

Dialog izin OMP menampilkan tiga pilihan, sama seperti di terminal OMP: **Tolak**, **Izinkan sekali**, dan **Izinkan `<tool>` untuk sesi ini**.

- Sesi di sini adalah **satu eksekusi task**. OMP mengingat izin itu per tool dan tingkat aksesnya, jadi panggilan berikutnya ke tool yang sama dalam task itu langsung jalan tanpa dialog. Task berikutnya (termasuk balasan) mulai dari nol dan bertanya lagi.
- Cakupannya per **tool**, bukan per target: setelah `browser` atau `eval` diizinkan untuk sesi ini, semua panggilannya sampai task selesai berjalan tanpa tanya, termasuk di luar workspace. Pilih **Izinkan sekali** bila itu terlalu luas.
- Tombol hanya muncul jika OMP menawarkannya untuk permintaan tersebut. Hermes, Codex, dan Antigravity belum punya opsi ini; izin permanen mereka tetap tidak diteruskan.
- Ini terpisah dari centang **Izinkan otomatis untuk task ini**, yang tetap hanya menyetujui operasi file terverifikasi di dalam workspace.

### Mengizinkan browser OMP

1. Pilih NPC OMP berlabel **Minta izin** (atau badge **!** di layar kecil), lalu lihat dialog story di bawah kantor. Jika beberapa NPC menunggu, pilih nama dalam antrean dialog. Tautan **Minta izin · Lihat detail di bawah kantor** juga tersedia di **Kontrol task berjalan**.
2. Tinjau detail permintaan seperti `Allow tool: eval` atau `Allow tool: browser`, kemudian pilih **Izinkan sekali** untuk tindakan yang dipercaya. Pilih **Tolak** jika tidak sesuai.
3. Satu task dapat meminta beberapa persetujuan terpisah untuk menjalankan skrip dan membuka/membaca/menutup tab. Agar tidak mengklik berulang, pilih **Izinkan <tool> untuk sesi ini** (seperti _Approve … for this session_ di OMP): tool itu, mis. `browser`, tidak menanyakan lagi sampai task ini selesai. Izin sekali tidak menjadi izin sesi dan tidak ada izin permanen. Form browser dan `eval` OMP tetap manual meskipun **Izinkan otomatis untuk task ini** dicentang: cakupan aksesnya tidak dapat dibuktikan hanya dari workspace. Form operasi file OMP yang memenuhi pemeriksaan di atas dapat otomatis.

Jika memakai versi sebelum perbaikan ini, restart backend dengan `bun run dev` (atau `bun run start` untuk produksi lokal), refresh halaman, dan kirim ulang task yang sudah selesai ditolak. Frontend saja tidak cukup: kemampuan form ACP diiklankan backend saat membuka sesi baru. Tidak perlu menambahkan key, mengubah konfigurasi global OMP, atau memakai `yolo`.

Regresi sebelumnya: backend memakai `always-ask` tetapi tidak mengiklankan form ACP; fallback dialog OMP mengembalikan penolakan tanpa menampilkan tombol. Jalur ini kini memakai panel izin yang sama dengan permission tools lain. Smoke OMP asli berhasil membaca token acak dari halaman lokal melalui browser setelah persetujuan eksplisit; tes juga mencakup penolakan dan form yang tidak didukung.

**Ini bukan sandbox atau gerbang persetujuan untuk seluruh tools.** OMP/Hermes tetap berjalan sebagai pengguna server, dengan konfigurasi dan autentikasi lokalnya. Workspace hanya direktori kerja. Beberapa tools internal, kebijakan izin yang sudah tersimpan, plugin/MCP Hermes, dan runtime provider dapat berjalan tanpa meminta izin per tindakan. OMP diluncurkan dengan `always-ask`, tanpa extension discovery dan LSP; itu mengurangi permukaan eksekusi, bukan mengisolasi filesystem.

Tombol **Hentikan task** membatalkan request/grup proses yang diluncurkan dan menolak izin yang masih menunggu. Perubahan file/perintah yang sudah dijalankan tidak dapat di-undo. Proses yang melepaskan diri dari grup bukan dijamin terhenti. Batas task lokal 10 menit; reasoning/thought chunks tidak ditampilkan atau disimpan oleh Ruang.

Versi yang diuji: OMP `18.12.2`, Hermes ACP `0.19.0`, protokol ACP v1. OMP override model menggunakan `session/set_config_option`; Hermes menggunakan `session/set_model`. CLI versi lain harus menyediakan operasi tersebut. ACP beberapa runtime dapat mengirim kegagalan provider sebagai teks jawaban dengan `end_turn`; status selesai berarti giliran runtime selesai dan menghasilkan teks, **bukan** bukti kebenaran jawaban atau keberhasilan seluruh tindakan. Periksa hasil kerja.

## Data dan batas keamanan

- Agent, API key provider HTTP, Todo, prompt, dan jawaban disimpan di `data/office.sqlite`. Direktori data dibatasi mode `0700`, file database `0600`, dan diabaikan Git. Upgrade menambah metadata `workspace`, `allowTools`, hubungan task `replyToId`, tabel `todos`, kolom `character` (pilihan karakter), dan tabel `settings` (jumlah bangku) tanpa menghapus agent, key, atau riwayat lama. Autentikasi CLI tetap dikelola OMP/Hermes, tidak disalin ke database kantor.
- **API key tersimpan plaintext lokal, bukan terenkripsi.** Endpoint daftar, konfigurasi edit, dan respons simpan agent tidak mengembalikan key. Browser tidak menyimpan key di localStorage/sessionStorage. Admin/proses yang memiliki akses filesystem pengguna tetap dapat membacanya.
- Aplikasi ini workspace **single-user lokal**, bukan server multi-tenant atau layanan internet dengan autentikasi. Tidak ada sinkronisasi cloud aplikasi; prompt/peran tetap dikirim ke provider AI pilihanmu.
- Provider HTTP menjalankan request AI teks tanpa tools/terminal; balasan menyertakan riwayat rantainya, sedangkan task baru tetap tanpa riwayat Ruang. OMP/Hermes menjalankan proses agent lokal dengan tools setelah persetujuan eksplisit. Aplikasi tidak menyambung ke sesi CLI yang sedang berjalan.
- Request provider HTTP non-streaming tetap memiliki timeout total **120 detik**. Task CLI tidak lagi dibatasi durasi total 10 menit: watchdog menghentikan proses setelah **10 menit tanpa progres**, dihitung ulang saat ada output baru, aktivitas tools, atau sinyal progres reasoning dari sesi aktif; isi reasoning tidak ditampilkan/disimpan. Menunggu persetujuan pengguna menjeda watchdog, lalu jawaban/tolakan memulai interval baru. Timeout startup/protokol ACP tetap 60/90 detik. Tools yang benar-benar diam selama 10 menit tetap dapat dihentikan meskipun prosesnya masih hidup. Error aman dan output parsial disimpan; task gagal dapat dilanjutkan lewat chat. Task aktif saat server berhenti/restart ditandai gagal dan izin tertunda dihapus.
- Batas: 1–24 bangku (bawaan 12; agent tidak boleh melebihi bangku), prompt 12.000 karakter, request body 32 KiB, respons upstream 1 MiB, output 120.000 karakter. Daftar pemilihan riwayat mengambil 100 task terbaru **ditambah semua task yang masih berjalan**; percakapan terpilih tetap memuat seluruh rantai pendahulunya dari database.
- Biaya dan pembatasan model mengikuti provider. Hasil AI tetap perlu ditinjau.
- Model/ruangan 3D dibuat secara prosedural tanpa unduhan aset. Google Fonts bersifat tambahan; bila tidak dapat diakses, font sistem menjadi fallback.

## Verifikasi

```sh
bun run build  # vue-tsc + build produksi
bun test       # API, migration, balasan/konteks, persistence, ACP, izin (termasuk izin sesi), cancellation, error, batas riwayat, bangku, karakter, animasi, dan helper suara
```

Smoke dilakukan lewat CLI OMP dan Hermes asli memakai konfigurasi autentikasi yang sudah tersedia: respons `OMP_READY`/`HERMES_READY`, kemudian task dari browser menghasilkan `OMP_BROWSER_OK`/`HERMES_BROWSER_OK` dengan karakter benar-benar mengetik. Pengujian izin sekali/tolak, efek penulisan file, reload izin tertunda, output parsial, pembatalan saat melihat riwayat, error aman, dan CLI tidak tersedia memakai server/database serta executable ACP fixture terisolasi. Layout konfigurasi mobile dan dark mode diperiksa di browser emulasi. Provider HTTP tetap diuji melalui fixture lokal, bukan key provider baru. Fixture tidak menjadi mode aplikasi; agent dan workspace smoke dibersihkan sesudah verifikasi.

Verifikasi balasan: OMP dan Hermes asli berhasil mengingat kode acak melalui rantai balasan dan tidak menerima kode itu dalam task baru. Browser memverifikasi tombol Balas/Kirim balasan, target yang tidak berubah saat memilih riwayat lain, pembatalan mode yang mempertahankan draf, reload, pembersihan konteks saat pindah agent, serta layout mobile/dark mode. Fixture API dan database smoke terisolasi; tidak ada perubahan atau penghapusan agent/riwayat pengguna untuk pengujian ini.

Verifikasi kelanjutan setelah error: build produksi dan 100 test lulus. Browser memakai server/database terisolasi dengan runner lokal fixture yang gagal dengan pesan timeout dan output parsial, serta kegagalan tanpa output. Diperiksa tombol Lanjutkan task, pesan “Lanjutkan” berulang yang tetap menautkan `replyToId`, rantai chat, pemulihan tampilan setelah reload, draf yang tidak tertukar, pemisahan task baru/agent lain, serta mobile 390 px/dark/reduced-motion tanpa overflow horizontal atau error browser. Timer 10 menit dan model CLI asli tidak dijalankan ulang dalam smoke ini. Screenshot direkam; inspeksi visual gambar tidak tersedia.

Verifikasi timeout dan tampilan chat: build produksi dan 111 test lulus. Smoke browser menggunakan executable ACP fixture sungguhan sebagai subprocess pada server/database terisolasi, dengan hanya interval 600.000 ms dipercepat menjadi 1.500 ms. Progres reasoning berkala berhasil melewati batas total lama, tanpa membocorkan isi reasoning; proses diam dihentikan dengan output parsial tetap tersedia; persetujuan yang ditunggu melampaui interval tetap bisa disetujui dan diselesaikan. Diperiksa balasan Enter/Shift+Enter, konteks task gagal, posisi gelembung kanan/kiri, input di bawah, scroll otomatis dan posisi baca yang tidak dipaksa, reload, task baru, pemisahan agent, serta mobile 390 px/dark/reduced-motion tanpa overflow atau error browser. Bukan pengukuran 10 menit waktu nyata atau pengujian model CLI asli. Screenshot direkam; inspeksi visual gambar tidak tersedia.

Verifikasi animasi putus kontrak: browser dengan respons API fixture memeriksa pembatalan, penghapusan ditolak, pergerakan karakter setelah penghapusan berhasil, pintu terbuka sebelum dilintasi lalu menutup, serta pemakaian ulang meja tanpa mengubah warna karakter yang keluar. Emulasi mobile 390 px/dark dengan reduced-motion menghapus karakter tanpa animasi dan tanpa overflow horizontal. Smoke model Three.js memeriksa keberangkatan dari seluruh 12 kursi, pelepasan material karakter, dan cleanup saat unmount; build produksi lulus. Tidak ada penghapusan agent atau riwayat pengguna. Screenshot direkam, tetapi inspeksi visual gambar tidak tersedia pada sesi verifikasi ini; pemeriksaan browser memakai state adegan, DOM, dan error runtime.

Verifikasi ekspresi emosi: build produksi dan **116 test / 839 assertions** lulus. Browser memakai komponen OfficeScene dan renderer WebGL asli dengan data fixture terisolasi; pose wajah/tangan/badan gagal dan selesai bergerak berbeda, wajah menoleh ke kamera, cangkir tetap di meja, reaksi tidak diulang polling/pemilihan, hasil baru berstatus sama memicu ulang, dan task berjalan menghentikan reaksi. Diperiksa pengembalian aktivitas idle, batas 30 FPS, reduced-motion statis dengan nol frame lanjutan, mobile 390 px/dark tanpa overflow, dan karakter keluar tanpa sisa offset lompatan hingga kantor berhenti render setelah pintu menutup. Build produksi juga menampilkan label bahagia dari task selesai tanpa error browser. Tidak ada perubahan task/agent pengguna. Screenshot direkam; inspeksi visual gambar dan pengukuran daya/suhu perangkat tidak dilakukan.

Verifikasi edit agent: build produksi dan **127 test / 1.113 assertions** lulus. Browser dengan server/database serta upstream fixture terisolasi memeriksa form yang sama untuk tambah/edit, prefill HTTP dan lokal, key kosong yang mempertahankan kredensial, pergantian endpoint dengan key baru, penggunaan model/peran/key setelah edit, ID/riwayat tetap, draf tidak ditimpa polling, pembatalan, validasi workspace, reload, penolakan saat task dimulai ketika dialog terbuka lalu penyimpanan ulang setelah berhenti, dan mobile 390 px/dark tanpa overflow atau error browser. Tidak ada edit pada agent, key, atau riwayat pengguna; provider/model asli tidak dihubungi. Screenshot direkam; inspeksi visual gambar tidak dilakukan.

Verifikasi perbaikan izin otomatis OMP: **191 test / 1.520 assertions** dan build produksi lulus; setelah penyesuaian pencocokan header tanpa detail, **14 regresi OMP / 43 assertions** juga lulus. Browser pada server/database/workspace terisolasi menjalankan subprocess yang memakai mapper event, formatter approval `WriteTool`, `requestApproval`, dan form ACP dari instalasi OMP asli tanpa inferensi model: checkbox mengizinkan penulisan dalam workspace otomatis, menahan `../outside.txt` dan symlink keluar, tetap otomatis untuk penulisan dalam workspace berikutnya, mempertahankan izin tertunda setelah reload, serta menjalankan akses luar hanya setelah izin manual. Task berikutnya kembali manual dan tidak ada error browser. Screenshot tertangkap tetapi tidak dapat ditinjau karena pembacaan gambar dinonaktifkan. Tidak menjalankan model berbayar atau mengubah database/config pengguna.

Verifikasi kursor cambuk: build produksi lulus. Smoke browser pada UI produksi dengan respons API fixture memeriksa kursor masuk/keluar office, tiga animasi pecut, restart klik cepat tanpa penumpukan, klik kanan/drag tanpa pecut, pemilihan label dan keyboard, perubahan render saat zoom/rotasi, serta pembatalan pointer aktif. Mobile 390 px/dark/reduced-motion tidak meninggalkan kursor atau overflow; reduced-motion hanya menjalankan kilatan 120 ms. Tidak ada perubahan data pengguna atau inferensi model. Screenshot direkam, tetapi inspeksi visual gambar tidak tersedia.

Verifikasi dialog izin NPC: build produksi lulus. Smoke browser pada UI produksi dengan respons API fixture terisolasi memeriksa label tindakan dan nama saat idle/selesai, dua NPC meminta izin bersamaan, pemilihan NPC/antrean, reload izin tertunda, izinkan/tolak untuk `taskId` dan `requestId` yang benar, kegagalan kirim lalu retry, permintaan tanpa opsi izinkan, teks detail di-escape, serta tautan dari panel task. Mobile 390 px/dark/reduced-motion tidak overflow horizontal; NPC lain tetap memiliki badge izin. Browser tidak mencatat error. Tidak ada eksekusi CLI/model atau perubahan data pengguna. Screenshot desktop/mobile ditangkap, tetapi peninjauan gambar tidak tersedia karena pembaca gambar dinonaktifkan.

Verifikasi Pipeline: build produksi dan **197 test / 1.612 assertions** lulus. Browser pada UI produksi dengan database dan upstream/adapter lokal fixture terisolasi membuktikan simpan tanpa eksekusi, Todo bertahan setelah reload, transisi Progress → Selesai/Gagal, agent sibuk menahan Todo berikutnya, output/error, izin tertunda setelah reload, izinkan/tolak dari halaman Pipeline, teks detail ter-escape, draf tetap saat simpan gagal serta saat bolak-balik halaman, dan posisi halaman Pipeline kembali ke atas. Mobile 390 px/dark/reduced-motion tidak overflow horizontal; saat Pipeline aktif tidak ada canvas kantor atau duplikasi dialog izin; tidak ada error browser. Provider/model CLI asli tidak dipanggil dan data pengguna tidak diubah. Screenshot desktop/mobile direkam, tetapi inspeksi visual gambar tidak tersedia.
