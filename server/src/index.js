import express from "express";
import cors from "cors";
import helmet from "helmet";
import dotenv from "dotenv";
import { load as loadHtml } from "cheerio";
import { URL } from "url";
import { Readable } from "stream";
import { Agent, setGlobalDispatcher } from "undici";
import { execFile } from "child_process";
import httpProxy from "http-proxy";
import net from "net";

dotenv.config();

setGlobalDispatcher(new Agent({
  bodyTimeout: 0,
  headersTimeout: 0
}));

const app = express();
const PORT = process.env.PORT || 8787;
const PROXY_BASE_PATH = process.env.PROXY_BASE_PATH || "/proxy";
const ASSET_BASE_PATH = process.env.ASSET_BASE_PATH || "/asset";
const VIDEO_BASE_PATH = process.env.VIDEO_BASE_PATH || "/video";
const OPEN_TOKEN = process.env.OPEN_TOKEN || "";
const BROWSER_PUBLIC_BASE = process.env.BROWSER_PUBLIC_BASE || "";
const BROWSER_PORT_START = Number(process.env.BROWSER_PORT_START || 5901);

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

const proxy = httpProxy.createProxyServer({ ws: true, xfwd: true });
const sessionsByUser = new Map();
const sessionsById = new Map();
const usedPorts = new Set();
let portCursor = BROWSER_PORT_START;

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

  const injectScript = `
  <script>
  (function() {
    const proxyBase = window.location.origin;
    const allowed = ["tiktok.com","tiktokcdn.com","tiktokcdn-eu.com","tiktokcdn-us.com","byteoversea.com","muscdn.com"];
    const isAllowedHost = (host) => allowed.some((d) => host === d || host.endsWith("." + d));
    const makeUrl = (u) => {
      try {
        const abs = new URL(u, "https://www.tiktok.com");
        if (!isAllowedHost(abs.hostname)) return u;
        return proxyBase + "${ASSET_BASE_PATH}?url=" + encodeURIComponent(abs.toString());
      } catch {
        return u;
      }
    };
    const origFetch = window.fetch;
    if (origFetch) {
      window.fetch = function(input, init) {
        const url = typeof input === "string" ? input : (input && input.url) || "";
        const newUrl = makeUrl(url);
        if (typeof input === "string") return origFetch(newUrl, init);
        const req = new Request(newUrl, input);
        return origFetch(req, init);
      };
    }
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      return origOpen.call(this, method, makeUrl(url), ...rest);
    };
    const origSet = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function(name, value) {
      if (name === "src" || name === "href") {
        value = makeUrl(value);
      }
      return origSet.call(this, name, value);
    };
    const desc = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, "src");
    if (desc && desc.set) {
      Object.defineProperty(HTMLScriptElement.prototype, "src", {
        set: function(value) { return desc.set.call(this, makeUrl(value)); },
        get: desc.get
      });
    }
  })();
  </script>
  `;
  $("head").prepend(injectScript);

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

function getNextPort() {
  let port = portCursor;
  while (usedPorts.has(port)) {
    port += 1;
  }
  portCursor = port + 1;
  usedPorts.add(port);
  return port;
}

function getFreePort() {
  return new Promise((resolve) => {
    const port = getNextPort();
    const server = net.createServer();
    server.unref();
    server.on("error", () => resolve(getFreePort()));
    server.listen({ port, host: "127.0.0.1" }, () => {
      server.close(() => resolve(port));
    });
  });
}

function createSession(userKey) {
  return new Promise(async (resolve, reject) => {
    const id = `s_${Math.random().toString(36).slice(2, 10)}`;
    const port = await getFreePort();
    const name = `uk-browser-${id}`;

    const args = [
      "docker",
      "run",
      "-d",
      "--name",
      name,
      "-p",
      `127.0.0.1:${port}:5800`,
      "jlesage/chromium"
    ];

    execFile("sudo", args, (err, stdout, stderr) => {
      if (err) {
        usedPorts.delete(port);
        return reject(new Error(stderr || err.message));
      }
      const session = { id, port, name, userKey, createdAt: Date.now(), lastUsed: Date.now() };
      sessionsByUser.set(userKey, session);
      sessionsById.set(id, session);
      return resolve(session);
    });
  });
}

function openInSession(session, url) {
  return new Promise((resolve, reject) => {
    const args = [
      "docker",
      "exec",
      "-e",
      `TARGET_URL=${url}`,
      session.name,
      "sh",
      "-lc",
      "xdg-open \"$TARGET_URL\" || chromium \"$TARGET_URL\" || chromium-browser \"$TARGET_URL\""
    ];
    execFile("sudo", args, (err, stdout, stderr) => {
      if (err) {
        return reject(new Error(stderr || err.message));
      }
      return resolve(stdout.trim());
    });
  });
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

app.get("/session", async (req, res) => {
  const token = String(req.query.token || "");
  if (!OPEN_TOKEN || token !== OPEN_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const userKey = String(req.query.user || "");
  if (!userKey) {
    return res.status(400).json({ error: "Missing user" });
  }

  let session = sessionsByUser.get(userKey);
  if (!session) {
    try {
      session = await createSession(userKey);
    } catch (err) {
      return res.status(500).json({ error: "Failed to create session", details: err.message });
    }
  }

  session.lastUsed = Date.now();
  const base = BROWSER_PUBLIC_BASE || `${req.protocol}://${req.get("host")}`;
  return res.json({
    sessionId: session.id,
    browserUrl: `${base}/browser/${session.id}/`
  });
});

app.get("/open", async (req, res) => {
  const token = String(req.query.token || "");
  if (!OPEN_TOKEN || token !== OPEN_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const urlParam = req.query.url;
  const userKey = String(req.query.user || "");
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

  let session = userKey ? sessionsByUser.get(userKey) : null;
  if (!session) {
    if (!userKey) {
      return res.status(400).json({ error: "Missing user" });
    }
    try {
      session = await createSession(userKey);
    } catch (err) {
      return res.status(500).json({ error: "Failed to create session", details: err.message });
    }
  }

  try {
    const output = await openInSession(session, targetUrl.toString());
    session.lastUsed = Date.now();
    return res.json({ ok: true, output, sessionId: session.id });
  } catch (err) {
    return res.status(500).json({ error: "Failed to open URL", details: err.message });
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

app.get("*", async (req, res) => {
  const knownPaths = new Set([
    "/health",
    PROXY_BASE_PATH,
    ASSET_BASE_PATH,
    VIDEO_BASE_PATH,
    "/egress",
    "/session",
    "/open"
  ]);
  if (knownPaths.has(req.path)) {
    return res.status(404).send("Not found");
  }

  const allowedExt = [
    ".js", ".css", ".map", ".json",
    ".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg",
    ".woff", ".woff2", ".ttf", ".mp4"
  ];
  const hasAllowedExt = allowedExt.some((ext) => req.path.endsWith(ext));
  const hasAllowedPrefix = req.path.startsWith("/node/") || req.path.startsWith("/i18n/") || req.path.startsWith("/pns/") || req.path.startsWith("/api/");

  if (!hasAllowedExt && !hasAllowedPrefix) {
    return res.status(404).send("Not found");
  }

  try {
    const targetUrl = new URL(`https://www.tiktok.com${req.originalUrl}`);
    if (!isAllowedHost(targetUrl)) {
      return res.status(403).json({ error: "Host not allowed" });
    }
    const upstream = await fetchUpstream(targetUrl, req);
    const headers = stripProblemHeaders(Object.fromEntries(upstream.headers.entries()));
    for (const [key, value] of Object.entries(headers)) {
      res.setHeader(key, value);
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

app.use("/browser/:id", async (req, res) => {
  const sessionId = req.params.id;
  let session = sessionsById.get(sessionId);
  if (!session) {
    try {
      session = await createSession(sessionId);
      sessionsById.set(sessionId, session);
      sessionsByUser.set(sessionId, session);
    } catch (err) {
      return res.status(500).send(`Failed to create session: ${err.message}`);
    }
  }
  const target = `http://127.0.0.1:${session.port}`;
  proxy.web(req, res, { target, changeOrigin: true }, () => {
    res.status(502).send("Proxy error");
  });
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Proxy listening on :${PORT}`);
});
