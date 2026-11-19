// api/index.js
//
// Proxy Vercel minimal: /ask, /api/ask, /api → upstream deepseek.
// Tidak ada PROMPT_TERTANAM. Pertanyaan user diteruskan apa adanya.
// POST JSON dengan UA browser (curl UA diblok upstream sejak 2026-11-19).
//
// Kalau request ini masih 403 dari Vercel, itu IP block — bukan kode.

import { fetch as undiciFetch, Agent } from "undici";

const UPSTREAM_BASE = "https://api.nexadev.my.id/ai/deepsek/";
const http1Agent = new Agent({ allowH2: false, connectTimeout: 10000, headersTimeout: 25000, bodyTimeout: 25000 });

const BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const MAX_BODY_BYTES = 256 * 1024;
const MAX_QUESTION_CHARS = 4000;
const REQUEST_TIMEOUT_MS = 28000;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  corsHeaders(res);
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body;
  if (Buffer.isBuffer(req.body)) {
    try { return JSON.parse(req.body.toString("utf8")); } catch { return { raw: req.body.toString("utf8") }; }
  }
  if (typeof req.body === "string" && req.body.length) {
    try { return JSON.parse(req.body); } catch { return { raw: req.body }; }
  }
  return await new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { req.destroy(); return resolve({ __overflow: true }); }
      chunks.push(c);
    });
    req.on("end", () => {
      const data = Buffer.concat(chunks).toString("utf8");
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { resolve({ raw: data }); }
    });
    req.on("error", () => resolve({}));
  });
}

function extractQuestion(body, url) {
  const fromBody = body && (body.question || body.text || body.prompt || body.q);
  if (fromBody && String(fromBody).trim()) return String(fromBody).trim();
  const q = url.searchParams.get("text") || url.searchParams.get("q") ||
            url.searchParams.get("question") || url.searchParams.get("prompt");
  return q ? String(q).trim() : "";
}

function pickAnswer(data) {
  if (!data || typeof data !== "object") return "";
  const cand = data.result ?? data.answer ?? data.message ?? data.text ?? data.response ?? "";
  if (typeof cand === "string") return cand;
  if (cand && typeof cand === "object") {
    if (typeof cand.text === "string") return cand.text;
    if (typeof cand.content === "string") return cand.content;
    if (Array.isArray(cand.content) && cand.content[0]?.text) return cand.content[0].text;
  }
  return "";
}

async function callUpstreamJson(text) {
  const body = JSON.stringify({ text, prompt: text, question: text });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const r = await undiciFetch(UPSTREAM_BASE, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": BROWSER_UA,
        "Content-Length": String(Buffer.byteLength(body, "utf8")),
      },
      body,
      dispatcher: http1Agent,
      signal: controller.signal,
    });
    const raw = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch {}
    return { httpStatus: r.status, ok: r.ok, parsed, raw };
  } finally {
    clearTimeout(timer);
  }
}

async function callUpstreamForm(text) {
  const form = new URLSearchParams();
  form.append("text", text);
  form.append("prompt", text);
  form.append("question", text);
  const body = form.toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const r = await undiciFetch(UPSTREAM_BASE, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
        "Accept": "application/json",
        "User-Agent": BROWSER_UA,
        "Content-Length": String(Buffer.byteLength(body, "utf8")),
      },
      body,
      dispatcher: http1Agent,
      signal: controller.signal,
    });
    const raw = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch {}
    return { httpStatus: r.status, ok: r.ok, parsed, raw };
  } finally {
    clearTimeout(timer);
  }
}

async function callUpstream(text) {
  const attempts = [
    { name: "POST JSON + UA browser",        fn: () => callUpstreamJson(text) },
    { name: "POST URL-encoded + UA browser", fn: () => callUpstreamForm(text) },
  ];
  let last = null;
  for (const a of attempts) {
    let out;
    try { out = await a.fn(); } catch (err) {
      last = { attempt: a.name, error: String(err?.message ?? err) };
      continue;
    }
    if (out.ok && out.parsed && (out.parsed.status === true || out.parsed.status === "true")) {
      return { ...out, attempt: a.name };
    }
    last = { attempt: a.name, httpStatus: out.httpStatus, body_preview: out.raw?.slice(0, 512) };
  }
  return { ok: false, last };
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    corsHeaders(res);
    res.end();
    return;
  }

  const url = new URL(req.url || "/", "http://localhost");
  const path = url.pathname;

  if (path === "/" || path === "/health") {
    return json(res, 200, {
      ok: true,
      service: "deepseek-proxy-api",
      upstream: UPSTREAM_BASE,
      prompt_mode: "none",
      time: new Date().toISOString(),
    });
  }

  const isAsk = path === "/ask" || path === "/api/ask" || path === "/api";
  if (!isAsk) return json(res, 404, { ok: false, error: "Not found" });
  if (req.method !== "GET" && req.method !== "POST") return json(res, 405, { ok: false, error: "Method not allowed" });

  let body = {};
  if (req.method === "POST") {
    body = await readBody(req);
    if (body && body.__overflow) return json(res, 413, { ok: false, error: "Body terlalu besar" });
  }

  const question = extractQuestion(body, url);
  if (!question) return json(res, 400, { ok: false, error: "Pertanyaan kosong" });
  if (question.length > MAX_QUESTION_CHARS) return json(res, 400, { ok: false, error: `Pertanyaan maks ${MAX_QUESTION_CHARS} karakter` });

  try {
    const upstream = await callUpstream(question);

    if (!upstream.ok) {
      return json(res, 502, {
        ok: false,
        error: "Upstream gagal di semua varian POST",
        last_attempt: upstream.last,
        payload_chars: question.length,
      });
    }

    const answer = pickAnswer(upstream.parsed);
    if (!answer) {
      return json(res, 502, {
        ok: false,
        error: "Upstream sukses tapi answer kosong",
        attempt: upstream.attempt,
        upstream_status: upstream.httpStatus,
        upstream_keys: upstream.parsed && typeof upstream.parsed === "object" ? Object.keys(upstream.parsed) : null,
      });
    }

    return json(res, 200, {
      ok: true,
      question,
      answer,
      payload_chars: question.length,
      attempt: upstream.attempt,
      upstream_url: UPSTREAM_BASE,
      time: new Date().toISOString(),
    });
  } catch (e) {
    return json(res, 500, { ok: false, error: "Handler error", detail: String(e?.message ?? e) });
  }
}
