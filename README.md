# Monday Item View: UK TikTok Proxy

This repo contains:
- `client/` A monday **Item View** app that reads a TikTok URL from column `link4__1` and embeds it.
- `server/` A UK‑egress proxy that fetches and rewrites TikTok pages and assets.

## Why this exists
Some TikTok links are region‑restricted. This app loads the content via a UK‑hosted proxy so clients can see the video directly inside monday.

## Setup

### 1) Proxy server (UK hosted)

Create an `.env` for the server based on the example below.

`server/.env.example`
```
PORT=8787
# Optional: comma-separated allowlist. Defaults include *.tiktok.com, *.tiktokcdn.com
ALLOWED_HOSTS=
PROXY_BASE_PATH=/proxy
ASSET_BASE_PATH=/asset
```

Run locally:
```
cd server
npm install
npm run dev
```

### 2) Client (monday Item View)

Create `client/.env`:
```
VITE_PROXY_BASE_URL=https://YOUR-UK-PROXY-DOMAIN
VITE_COLUMN_ID=link4__1
```

Run locally:
```
cd client
npm install
npm run dev
```

### 3) monday app configuration

- App type: **Item View**
- iFrame URL: `https://YOUR-CLIENT-HOST/`
- OAuth: use monday **seamless auth**

## Notes
- TikTok may change or block embeddings. The proxy strips `X-Frame-Options` and CSP and rewrites asset URLs to ensure all sub‑requests go through the UK proxy.
- If TikTok changes their page structure, we may need to adjust rewriting logic.
- This is for internal use only, as requested.
