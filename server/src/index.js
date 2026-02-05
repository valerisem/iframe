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

app.get("/health", (_req, res) => {
  res.json({ ok: true });
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

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Proxy listening on :${PORT}`);
});
