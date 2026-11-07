# gemini-pupeter

A local HTTP API in front of the Gemini web interface, driven by Puppeteer.

It keeps one persistent browser profile, so you log into Gemini once and the session
survives restarts. Prompts are sent through the web UI and the reply is returned as JSON.
Requests are serialised through a queue, because a single browser page cannot handle
concurrent prompts.

## How it works

1. On the first request the server launches Chrome with a persistent `userDataDir`
   (`./gemini_session` by default).
2. If that profile is not signed in, the browser is opened visibly so you can log in.
3. Prompts are queued; each one is typed into the Gemini composer and the answer is
   captured from the response stream.
4. The reply is returned to the caller.

## Requirements

- Node.js 18+
- Google Chrome installed locally
- A Google account you are willing to use for this purpose

## Install and run

```bash
npm install
node server.js
```

The API listens on `http://localhost:3000` by default.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `CHROME_PATH` | system Chrome | Explicit Chrome executable |
| `USER_DATA_DIR` | `./gemini_session` | Profile directory holding the login session |
| `HEADLESS` | `false` | Set `true` to run without a visible window |
| `RESPONSE_TIMEOUT` | `90000` | Maximum wait for a reply in ms |

## Important

This automates the **consumer Gemini web app**, not an official API. That means:

- it can break whenever Google changes the page markup;
- it is subject to Google's terms of service, so use your own account and keep volume low;
- the `gemini_session` directory holds your login cookies — keep it out of version control
  and never share it.

If you need reliability, use the official Gemini API instead.

---

## Bahasa Indonesia

**gemini-pupeter** menyediakan API HTTP lokal di depan antarmuka web Gemini, digerakkan oleh Puppeteer. Profil browser disimpan permanen, jadi cukup masuk sekali dan sesi itu dipakai ulang oleh pemanggilan berikutnya.

---

## License

MIT
