// api/index.js
//
// Proxy Vercel tanpa prompt. Upstream PHP NexaDev cuma baca $_GET[text];
// POST body diabaikan. Maka proxy menerjemahkan /ask POST jadi GET ?text=...
//
// Perbaikan dari versi sebelumnya:
//   - readBody kasih timeout 2000ms. Kalau stream gak pernah end (Vercel
//     sudah drain di layer atas), resolve {} supaya handler tetap lanjut
//     dan extractQuestion bisa fallback ke query string.
//   - Kalau req.body sudah object dari Vercel, langsung pakai tanpa sentuh
//     stream.

import { fetch as undiciFetch, Agent } from "undici";

const UPSTREAM_BASE = "https://api.nexadev.my.id/ai/deepsek/";
const http1Agent = new Agent({ allowH2: false, connectTimeout: 10000, headersTimeout: 25000, bodyTimeout: 25000 });
const BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const MAX_BODY_BYTES = 256 * 1024;
const BODY_READ_TIMEOUT_MS = 2000;
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

function parseJsonOrRaw(text) {
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

async function readBody(req) {
  // Vercel kadang sudah parse body jadi object sebelum handler dipanggil.
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
    return req.body;
  }
  if (Buffer.isBuffer(req.body)) {
    return parseJsonOrRaw(req.body.toString("utf8"));
  }
  if (typeof req.body === "string" && req.body.length) {
    return parseJsonOrRaw(req.body);
  }

  return await new Promise((resolve) => {
    let size = 0;
    let done = false;
    const chunks = [];
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      // Stream tidak pernah end. Lepas listener dan beri objek kosong;
      // extractQuestion akan jatuh ke query string kalau ada.
      req.removeAllListeners("data");
      req.removeAllListeners("end");
      req.removeAllListeners("error");
      finish({});
    }, BODY_READ_TIMEOUT_MS);

    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        finish({ __overflow: true });
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => finish(parseJsonOrRaw(Buffer.concat(chunks).toString("utf8"))));
    req.on("error", () => finish({}));
  });
}

function extractQuestion(body, url) {
  const fromBody = body && (body.question || body.text || body.prompt || body.q);
  if (fromBody && String(fromBody).trim()) return String(fromBody).trim();
  const q = url.searchParams.get("text") || url.searchParams.get("q") ||
            url.searchParams.get("question") || url.searchParams.get("prompt");
  return q ? String(q).trim() : "";
}

async function callUpstreamGet(question) {
  const params = new URLSearchParams({ text: question });
  const target = UPSTREAM_BASE + "?" + params.toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const r = await undiciFetch(target, {
      method: "GET",
      headers: {
        "Accept": "application/json",
        "User-Agent": BROWSER_UA,
      },
      dispatcher: http1Agent,
      signal: controller.signal,
    });
    const raw = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch {}
    return { httpStatus: r.status, ok: r.ok, parsed, raw, url_length: target.length };
  } finally {
    clearTimeout(timer);
  }
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
      upstream_method: "GET",
      prompt_mode: "none",
      time: new Date().toISOString(),
    });
  }

  const isAsk = path === "/ask" || path === "/api/ask" || path === "/api";
  if (!isAsk) return json(res, 404, { ok: false, error: "Not found" });
  if (req.method !== "GET" && req.method !== "POST") return json(res, 405, { ok: false, error: "Method not allowed" });

  let body = {};
  if (req.method === "POST") {
    try {
      body = await readBody(req);
    } catch (e) {
      return json(res, 400, { ok: false, error: "Gagal baca body", detail: String(e?.message ?? e) });
    }
    if (body && body.__overflow) return json(res, 413, { ok: false, error: "Body terlalu besar" });
  }

  const question = extractQuestion(body, url);
  if (!question) {
    return json(res, 400, {
      ok: false,
      error: "Pertanyaan kosong",
      debug: { method: req.method, body_keys: body && typeof body === "object" ? Object.keys(body) : null, has_query: url.search.length > 0 },
    });
  }
  if (question.length > MAX_QUESTION_CHARS) {
    return json(res, 400, { ok: false, error: `Pertanyaan maks ${MAX_QUESTION_CHARS} karakter` });
  }

  try {
    const upstream = await callUpstreamGet(question);

    if (!upstream.ok || !upstream.parsed) {
      return json(res, 502, {
        ok: false,
        error: "Upstream GET gagal",
        upstream_status: upstream.httpStatus,
        upstream_body: upstream.raw?.slice(0, 512),
        upstream_url_length: upstream.url_length,
        payload_chars: question.length,
      });
    }
    if (upstream.parsed.status !== true && upstream.parsed.status !== "true") {
      return json(res, 502, {
        ok: false,
        error: "Upstream status=false",
        upstream_status: upstream.httpStatus,
        upstream_message: upstream.parsed.message ?? null,
        payload_chars: question.length,
      });
    }
    const answer = upstream.parsed.result || upstream.parsed.answer || upstream.parsed.message || "";
    if (!answer) {
      return json(res, 502, {
        ok: false,
        error: "Upstream sukses tapi answer kosong",
        upstream_keys: Object.keys(upstream.parsed),
      });
    }
    return json(res, 200, {
      ok: true,
      question,
      answer,
      payload_chars: question.length,
      upstream_url_length: upstream.url_length,
      upstream_author: upstream.parsed.author ?? null,
      upstream_url: UPSTREAM_BASE,
      time: new Date().toISOString(),
    });
  } catch (e) {
    return json(res, 500, { ok: false, error: "Handler error", detail: String(e?.message ?? e) });
  }
}
