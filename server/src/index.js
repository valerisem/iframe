import express from "express";
import cors from "cors";
import helmet from "helmet";
import dotenv from "dotenv";
import { load as loadHtml } from "cheerio";
import { URL } from "url";
import { Readable } from "stream";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8787;
const PROXY_BASE_PATH = process.env.PROXY_BASE_PATH || "/proxy";
const ASSET_BASE_PATH = process.env.ASSET_BASE_PATH || "/asset";
const VIDEO_BASE_PATH = process.env.VIDEO_BASE_PATH || "/video";

const DEFAULT_ALLOWED_HOSTS = [
  ".tiktok.com",
  ".tiktokcdn.com",
  ".tiktokcdn-eu.com",
  ".tiktokcdn-us.com",
  ".byteoversea.com",
  ".muscdn.com"
];

const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const allowedHosts = ALLOWED_HOSTS.length ? ALLOWED_HOSTS : DEFAULT_ALLOWED_HOSTS;

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: false,
  crossOriginResourcePolicy: false,
  frameguard: false
}));
app.use(cors({
  origin: true,
  credentials: true
}));

function isAllowedHost(url) {
  const hostname = url.hostname.toLowerCase();
  return allowedHosts.some((host) => {
    if (host.startsWith(".")) {
      return hostname.endsWith(host);
    }
    return hostname === host;
  });
}

function makeAssetUrl(targetUrl) {
  return `${ASSET_BASE_PATH}?url=${encodeURIComponent(targetUrl)}`;
}

function rewriteHtml(html, baseUrl) {
  const $ = loadHtml(html);

  const attrTargets = [
    { selector: "[src]", attr: "src" },
    { selector: "[href]", attr: "href" },
    { selector: "[data-src]", attr: "data-src" },
    { selector: "[data-href]", attr: "data-href" }
  ];

  for (const { selector, attr } of attrTargets) {
    $(selector).each((_, el) => {
      const val = $(el).attr(attr);
      if (!val) return;
      if (val.startsWith("data:")) return;
      if (val.startsWith("#")) return;
      let resolved;
      try {
        resolved = new URL(val, baseUrl).toString();
      } catch {
        return;
      }
      $(el).attr(attr, makeAssetUrl(resolved));
    });
  }

  return $.html();
}

function stripProblemHeaders(headers) {
  const blocked = new Set([
    "content-security-policy",
    "content-security-policy-report-only",
    "x-frame-options",
    "frame-options",
    "x-xss-protection",
    "cross-origin-embedder-policy",
    "cross-origin-opener-policy",
    "cross-origin-resource-policy"
  ]);

  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!blocked.has(key.toLowerCase())) {
      result[key] = value;
    }
  }
  return result;
}

function decodeEscapedUrl(value) {
  if (!value) return "";
  return value
    .replace(/\\u002F/g, "/")
    .replace(/\\u0026/g, "&")
    .replace(/\\u003D/g, "=")
    .replace(/\\\\/g, "\\");
}

function findVideoUrlInObject(root) {
  const stack = [root];
  const seen = new Set();

  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;

    if (typeof node === "string") {
      const match = node.match(/https?:\/\/[^\s"]+\.mp4[^\s"]*/);
      if (match?.[0]) return decodeEscapedUrl(match[0]);
      continue;
    }

    if (typeof node !== "object") continue;
    if (seen.has(node)) continue;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
      continue;
    }

    for (const [key, value] of Object.entries(node)) {
      if (
        key === "playAddr" ||
        key === "downloadAddr" ||
        key === "playAddrH264" ||
        key === "playAddrBytevc1"
      ) {
        if (typeof value === "string") return decodeEscapedUrl(value);
      }
      stack.push(value);
    }
  }

  return "";
}

function extractVideoUrl(html) {
  const $ = loadHtml(html);
  const sigi = $("#SIGI_STATE").text();
  if (sigi) {
    try {
      const data = JSON.parse(sigi);
      const found = findVideoUrlInObject(data);
      if (found) return found;
    } catch {
      // ignore
    }
  }

  const universal = $("#__UNIVERSAL_DATA_FOR_REHYDRATION__").text();
  if (universal) {
    try {
      const data = JSON.parse(universal);
      const found = findVideoUrlInObject(data);
      if (found) return found;
    } catch {
      // ignore
    }
  }

  const nextData = $("#__NEXT_DATA__").text();
  if (nextData) {
    try {
      const data = JSON.parse(nextData);
      const found = findVideoUrlInObject(data);
      if (found) return found;
    } catch {
      // ignore
    }
  }

  const playAddrMatch = html.match(/"playAddr":"(https:[^"]+)"/);
  if (playAddrMatch?.[1]) return decodeEscapedUrl(playAddrMatch[1]);
  const downloadAddrMatch = html.match(/"downloadAddr":"(https:[^"]+)"/);
  if (downloadAddrMatch?.[1]) return decodeEscapedUrl(downloadAddrMatch[1]);

  const sigiMatch = html.match(/SIGI_STATE['"]?\\]?\\s*[:=]\\s*({.*?})\\s*;\\s*window/s);
  if (sigiMatch?.[1]) {
    try {
      const data = JSON.parse(sigiMatch[1]);
      const found = findVideoUrlInObject(data);
      if (found) return found;
    } catch {
      // ignore
    }
  }

  return "";
}

async function fetchUpstream(targetUrl, req) {
  const headers = {
    "user-agent": req.headers["user-agent"] || "Mozilla/5.0",
    "accept": req.headers["accept"] || "*/*",
    "accept-language": req.headers["accept-language"] || "en-GB,en;q=0.9",
    "accept-encoding": "identity",
    "referer": targetUrl.origin
  };

  if (req.headers.range) {
    headers.range = req.headers.range;
  }

  const res = await fetch(targetUrl.toString(), {
    headers,
    redirect: "follow"
  });

  return res;
}

function extractVideoIdFromUrl(urlString) {
  if (!urlString) return "";
  const match = urlString.match(/\/video\/(\d+)/);
  return match?.[1] || "";
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/egress", async (_req, res) => {
  try {
    const ipRes = await fetch("https://api.ipify.org?format=json");
    const ipJson = await ipRes.json();
    const geoRes = await fetch(`https://ipinfo.io/${ipJson.ip}/json`);
    const geoJson = await geoRes.json();
    res.json({ ip: ipJson.ip, geo: geoJson });
  } catch {
    res.status(502).json({ error: "Failed to resolve egress IP" });
  }
});

app.get(PROXY_BASE_PATH, async (req, res) => {
  const urlParam = req.query.url;
  if (!urlParam) {
    return res.status(400).json({ error: "Missing url" });
  }

  let targetUrl;
  try {
    targetUrl = new URL(String(urlParam));
  } catch {
    return res.status(400).json({ error: "Invalid url" });
  }

  if (!isAllowedHost(targetUrl)) {
    return res.status(403).json({ error: "Host not allowed" });
  }

  try {
    const upstream = await fetchUpstream(targetUrl, req);
    const contentType = upstream.headers.get("content-type") || "";

    const headers = stripProblemHeaders(Object.fromEntries(upstream.headers.entries()));
    for (const [key, value] of Object.entries(headers)) {
      res.setHeader(key, value);
    }
    res.removeHeader("x-frame-options");
    res.removeHeader("frame-options");

    if (contentType.includes("text/html")) {
      res.removeHeader("content-encoding");
      res.removeHeader("content-length");
      const text = await upstream.text();
      const rewritten = rewriteHtml(text, targetUrl);
      res.setHeader("content-type", "text/html; charset=utf-8");
      return res.status(upstream.status).send(rewritten);
    }

    res.status(upstream.status);
    if (upstream.body) {
      Readable.fromWeb(upstream.body).pipe(res);
    } else {
      res.end();
    }
  } catch {
    res.status(502).json({ error: "Proxy failed" });
  }
});

app.get(ASSET_BASE_PATH, async (req, res) => {
  const urlParam = req.query.url;
  if (!urlParam) {
    return res.status(400).json({ error: "Missing url" });
  }

  let targetUrl;
  try {
    targetUrl = new URL(String(urlParam));
  } catch {
    return res.status(400).json({ error: "Invalid url" });
  }

  if (!isAllowedHost(targetUrl)) {
    return res.status(403).json({ error: "Host not allowed" });
  }

  try {
    const upstream = await fetchUpstream(targetUrl, req);
    const headers = stripProblemHeaders(Object.fromEntries(upstream.headers.entries()));
    for (const [key, value] of Object.entries(headers)) {
      res.setHeader(key, value);
    }
    res.removeHeader("x-frame-options");
    res.removeHeader("frame-options");
    res.status(upstream.status);
    if (upstream.body) {
      Readable.fromWeb(upstream.body).pipe(res);
    } else {
      res.end();
    }
  } catch {
    res.status(502).json({ error: "Proxy failed" });
  }
});

app.get(VIDEO_BASE_PATH, async (req, res) => {
  const urlParam = req.query.url;
  const debug = req.query.debug === "1";
  if (!urlParam) {
    return res.status(400).json({ error: "Missing url" });
  }

  let targetUrl;
  try {
    targetUrl = new URL(String(urlParam));
  } catch {
    return res.status(400).json({ error: "Invalid url" });
  }

  if (!isAllowedHost(targetUrl)) {
    return res.status(403).json({ error: "Host not allowed" });
  }

  try {
    const upstream = await fetchUpstream(targetUrl, req);
    const html = await upstream.text();
    const videoUrl = extractVideoUrl(html);

    if (!videoUrl) {
      const finalUrl = upstream.url || targetUrl.toString();
      const videoId = extractVideoIdFromUrl(finalUrl);
      if (videoId) {
        const embedUrl = `https://www.tiktok.com/embed/v2/${videoId}`;
        res.setHeader("content-type", "text/html; charset=utf-8");
        return res.send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>TikTok Video</title>
    <style>
      html, body { margin: 0; height: 100%; background: #000; }
      iframe { width: 100%; height: 100%; border: 0; }
    </style>
  </head>
  <body>
    <iframe src="${makeAssetUrl(embedUrl)}" allow="autoplay; fullscreen; clipboard-read; clipboard-write"></iframe>
  </body>
</html>`);
      }

      if (debug) {
        res.setHeader("content-type", "text/html; charset=utf-8");
        return res.status(422).send(`<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>Debug</title></head>
  <body>
    <h3>Could not extract video URL</h3>
    <div>Final URL: ${finalUrl}</div>
    <pre>${html.slice(0, 2000).replace(/</g, "&lt;")}</pre>
  </body>
</html>`);
      }
      return res.status(422).send("Could not extract video URL.");
    }

    const proxiedVideo = makeAssetUrl(videoUrl);
    res.setHeader("content-type", "text/html; charset=utf-8");
    return res.send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>TikTok Video</title>
    <style>
      html, body { margin: 0; height: 100%; background: #000; }
      video { width: 100%; height: 100%; object-fit: contain; }
    </style>
  </head>
  <body>
    <video controls playsinline src="${proxiedVideo}"></video>
  </body>
</html>`);
  } catch {
    return res.status(502).json({ error: "Proxy failed" });
  }
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Proxy listening on :${PORT}`);
});
