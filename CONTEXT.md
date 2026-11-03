# gemini-pupeter — Project Context

## Ringkasan

Jembatan antara aplikasi apa pun dan antarmuka web Gemini. Server Express membuka Gemini di Puppeteer,
mengirim pertanyaan, menunggu jawaban selesai, lalu mengembalikannya dalam bentuk **OpenAI-compatible**:
`POST /v1/chat/completions`. Klien yang sudah mendukung endpoint OpenAI bisa langsung memakainya dengan
mengganti `baseURL`.

## Keputusan desain

- **Profil persisten.** Browser memakai `USER_DATA_DIR` (default `./gemini_session`), sehingga sesi
  login Gemini bertahan antar restart. Login dilakukan manual sekali.
- **Satu permintaan pada satu waktu.** `isProcessing` + `requestQueue` mencegah dua permintaan
  mengetik di kotak yang sama; permintaan berikutnya menunggu, bukan gagal.
- **Menunggu jawaban benar-benar selesai**, bukan sekadar jeda tetap: server memantau tombol
  berhenti/hilangnya indikator lalu memakai `RESPONSE_TIMEOUT` (default 90 detik) sebagai batas atas.
- Non-headless secara default agar mudah memantau; set `HEADLESS=true` di server tanpa layar.

## Konfigurasi

```
PORT=3000
CHROME_PATH=            # kosong = pakai Chrome bawaan Puppeteer
USER_DATA_DIR=./gemini_session
HEADLESS=false
RESPONSE_TIMEOUT=90000
```

## Menjalankan

```bash
pnpm install
pnpm start          # pertama kali: jendela Chrome terbuka, login Gemini manual
```

Uji cepat:

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini","messages":[{"role":"user","content":"halo"}]}'
```

## Struktur

```
server.js            Seluruh server: antrean, browser, pengiriman prompt, parsing jawaban
gemini_session/      Profil Chrome (JANGAN di-commit — berisi cookie login)
test_server/         Skrip uji manual
```

## Catatan

- Ini mengotomasi antarmuka web, bukan API resmi: perubahan tata letak Gemini bisa mematahkannya.
- Jangan pakai akun utama untuk otomasi berlebihan; risiko pembatasan ada di sisi Google.
