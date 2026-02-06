import React, { useEffect, useMemo, useRef, useState } from "react";
import mondaySdk from "monday-sdk-js";

const monday = mondaySdk();

const COLUMN_ID = import.meta.env.VITE_COLUMN_ID || "link4__1";
const PROXY_BASE_URL = import.meta.env.VITE_PROXY_BASE_URL || "";
const BROWSER_BASE_URL = import.meta.env.VITE_BROWSER_BASE_URL || "";
const BROWSER_TOKEN = import.meta.env.VITE_BROWSER_TOKEN || "";
const RENDER_MODE = import.meta.env.VITE_RENDER_MODE || "proxy";

function extractUrl(columnValue) {
  if (!columnValue) return "";
  if (columnValue.text) return columnValue.text;
  if (typeof columnValue.value === "string") {
    try {
      const parsed = JSON.parse(columnValue.value);
      return parsed?.url || "";
    } catch {
      return "";
    }
  }
  return "";
}

export default function App() {
  const [itemId, setItemId] = useState(null);
  const [boardId, setBoardId] = useState(null);
  const [contextRaw, setContextRaw] = useState(null);
  const [videoUrl, setVideoUrl] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [contextTimeout, setContextTimeout] = useState(false);
  const [contextError, setContextError] = useState("");
  const [apiStatus, setApiStatus] = useState("");
  const contextTimerRef = useRef(null);

  useEffect(() => {
    contextTimerRef.current = setTimeout(() => {
      setContextTimeout(true);
      setContextError("No item context received from monday.");
    }, 3000);

    const handleContext = (res) => {
      if (contextTimerRef.current) {
        clearTimeout(contextTimerRef.current);
        contextTimerRef.current = null;
      }
      const ctx = res?.data || {};
      setContextRaw(ctx);
      const nextItemId = ctx.itemId || ctx.itemId?.toString();
      const nextBoardId = ctx.boardId || ctx.boardId?.toString();
      setItemId(nextItemId);
      setBoardId(nextBoardId);
      if (!nextItemId) {
        setContextError("Missing itemId in monday context.");
      } else {
        setContextError("");
      }
      setContextTimeout(false);
    };
    monday.get("context").then(handleContext);
    const unsubscribe = monday.listen("context", handleContext);
    return () => {
      if (contextTimerRef.current) {
        clearTimeout(contextTimerRef.current);
        contextTimerRef.current = null;
      }
      if (typeof unsubscribe === "function") unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!itemId) return;
    const query = `query ($itemId: [ID!]) { items(ids: $itemId) { id column_values(ids: ["${COLUMN_ID}"]) { id text value } } }`;

    setLoading(true);
    setApiStatus("Calling monday.api...");
    monday.api(query, { variables: { itemId } }).then((res) => {
      const item = res?.data?.items?.[0];
      const col = item?.column_values?.[0];
      const url = extractUrl(col);
      setVideoUrl(url);
      setError(url ? "" : "No URL found in column link4__1");
      setApiStatus("monday.api success");
      setLoading(false);
    }).catch((err) => {
      setApiStatus("monday.api error");
      setError(`Failed to read item data from monday. ${err?.message || ""}`.trim());
      setLoading(false);
    });
  }, [itemId]);

  const proxiedUrl = useMemo(() => {
    if (!videoUrl) return "";
    if (RENDER_MODE === "browser") {
      return BROWSER_BASE_URL;
    }
    if (!PROXY_BASE_URL) return "";
    try {
      const parsed = new URL(videoUrl);
      if (!parsed.hostname.endsWith("tiktok.com")) return "";
    } catch {
      return "";
    }
    const base = PROXY_BASE_URL.endsWith("/") ? PROXY_BASE_URL.slice(0, -1) : PROXY_BASE_URL;
    return `${base}/proxy?url=${encodeURIComponent(videoUrl)}`;
  }, [videoUrl]);

  useEffect(() => {
    if (RENDER_MODE !== "browser") return;
    if (!videoUrl || !BROWSER_BASE_URL || !BROWSER_TOKEN) return;
    const base = BROWSER_BASE_URL.endsWith("/") ? BROWSER_BASE_URL.slice(0, -1) : BROWSER_BASE_URL;
    const openUrl = `${base}/open?token=${encodeURIComponent(BROWSER_TOKEN)}&url=${encodeURIComponent(videoUrl)}`;
    fetch(openUrl).catch(() => {});
  }, [videoUrl]);

  if (loading) {
    return (
      <div className="container">
        <div className="card">
          {contextTimeout ? "Waiting for monday context..." : "Loading item..."}
        </div>
        <div className="card">
          <div>Context: {contextRaw ? JSON.stringify(contextRaw) : "none"}</div>
          <div>itemId: {itemId || "none"}</div>
          <div>boardId: {boardId || "none"}</div>
          <div>{apiStatus}</div>
        </div>
      </div>
    );
  }

  if (contextError) {
    return (
      <div className="container">
        <div className="card error">{contextError}</div>
      </div>
    );
  }

  if (!videoUrl) {
    return (
      <div className="container">
        <div className="card error">{error || "No video URL"}</div>
      </div>
    );
  }

  if (RENDER_MODE === "browser" && (!BROWSER_BASE_URL || !BROWSER_TOKEN)) {
    return (
      <div className="container">
        <div className="card error">
          Missing `VITE_BROWSER_BASE_URL` or `VITE_BROWSER_TOKEN`.
        </div>
      </div>
    );
  }

  if (RENDER_MODE !== "browser" && !PROXY_BASE_URL) {
    return (
      <div className="container">
        <div className="card error">
          Missing `VITE_PROXY_BASE_URL`. Set this to your UK proxy server.
        </div>
      </div>
    );
  }

  if (!proxiedUrl) {
    return (
      <div className="container">
        <div className="card error">
          The URL in column {COLUMN_ID} must be a TikTok link.
        </div>
      </div>
    );
  }

  return (
    <div className="container">
      <div className="header">
        <div>
          <div className="title">TikTok Preview (UK)</div>
          <div className="subtitle">Board {boardId} · Item {itemId}</div>
        </div>
        <a className="link" href={videoUrl} target="_blank" rel="noreferrer">
          Open original
        </a>
      </div>
      <div className="frame-wrap">
        <iframe
          title="TikTok"
          src={proxiedUrl}
          sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
          referrerPolicy="no-referrer"
        />
      </div>
    </div>
  );
}
