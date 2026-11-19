// api/index.js
//
// Proxy Vercel: /ask, /api/ask, /api  →  upstream deepseek.
// Tempel prompt panjang + pertanyaan user, forward ke upstream.
//
// Perbaikan dari versi paste:
//   - PROMPT_TERTANAM berpotensi > 8KB → tidak pernah dipakai sebagai URL.
//     Fallback GET cuma bawa pertanyaan user (bukan prompt), di-slice di
//     karakter boundary aman (bukan byte), dan upstream dipanggil dengan
//     header X-Prompt-Mode: question-only supaya server tahu prompt tidak
//     ikut di URL.
//   - Body parsing Vercel: req.body bisa sudah object (Vercel parse) atau
//     stream mentah. Stream dibaca dengan limit 256KB supaya tidak OOM.
//   - Error upstream diteruskan dengan upstream_status (numeric) dan
//     upstream_body (string kalau bukan JSON), bukan cuma raw text.

import { PROMPT_TERTANAM } from "../prompt.js";
import { fetch as undiciFetch, Agent } from "undici";

const UPSTREAM_BASE = "https://api.nexadev.my.id/ai/deepsek/";
const http1Agent = new Agent({ allowH2: false, connectTimeout: 10000, headersTimeout: 25000, bodyTimeout: 25000 });

const MAX_BODY_BYTES = 256 * 1024;
const MAX_QUESTION_CHARS = 1200;      // GET fallback: hanya user question, bukan prompt
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
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        return resolve({ __overflow: true });
      }
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

async function readResponseSafely(r) {
  const ct = r.headers.get("content-type") || "";
  const raw = await r.text();
  if (ct.includes("application/json")) {
    try { return { parsed: JSON.parse(raw), raw }; } catch { return { parsed: null, raw }; }
  }
  try { return { parsed: JSON.parse(raw), raw }; } catch { return { parsed: null, raw }; }
}

async function callUpstreamJson(teksLengkap) {
  const payload = JSON.stringify({ text: teksLengkap, prompt: teksLengkap, question: teksLengkap });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const r = await undiciFetch(UPSTREAM_BASE, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Content-Length": String(Buffer.byteLength(payload, "utf8")),
      },
      body: payload,
      dispatcher: http1Agent,
      signal: controller.signal,
    });
    const { parsed, raw } = await readResponseSafely(r);
    return { httpStatus: r.status, ok: r.ok, parsed, raw };
  } finally {
    clearTimeout(timer);
  }
}

async function callUpstreamForm(teksLengkap) {
  const form = new URLSearchParams();
  form.append("text", teksLengkap);
  form.append("prompt", teksLengkap);
  form.append("question", teksLengkap);
  const body = form.toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const r = await undiciFetch(UPSTREAM_BASE, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
        "Accept": "application/json",
        "Content-Length": String(Buffer.byteLength(body, "utf8")),
      },
      body,
      dispatcher: http1Agent,
      signal: controller.signal,
    });
    const { parsed, raw } = await readResponseSafely(r);
    return { httpStatus: r.status, ok: r.ok, parsed, raw };
  } finally {
    clearTimeout(timer);
  }
}

async function callUpstreamGetQuestionOnly(question) {
  // Prompt TIDAK ikut di URL. Hanya pertanyaan user, dipotong di 1200 char
  // (aman untuk limit URL 4KB setelah encoding + base URL).
  const safeQ = question.length > MAX_QUESTION_CHARS ? question.slice(0, MAX_QUESTION_CHARS) : question;
  const params = new URLSearchParams({ text: safeQ });
  const target = UPSTREAM_BASE + "?" + params.toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const r = await undiciFetch(target, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (compatible; VercelProxy/1.0)",
        "X-Prompt-Mode": "question-only",
        "X-Prompt-Chars": String(PROMPT_TERTANAM.length),
      },
      dispatcher: http1Agent,
      signal: controller.signal,
    });
    const { parsed, raw } = await readResponseSafely(r);
    return { httpStatus: r.status, ok: r.ok, parsed, raw };
  } finally {
    clearTimeout(timer);
  }
}

async function callUpstream(teksLengkap, question) {
  const attempts = [
    { name: "POST JSON",           fn: () => callUpstreamJson(teksLengkap) },
    { name: "POST URL-encoded",    fn: () => callUpstreamForm(teksLengkap) },
    { name: "GET question-only",   fn: () => callUpstreamGetQuestionOnly(question) },
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
    last = { attempt: a.name, httpStatus: out.httpStatus, body: out.parsed ?? out.raw?.slice(0, 2048) };
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
      prompt_chars: PROMPT_TERTANAM.length,
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
  if (question.length > 4000) return json(res, 400, { ok: false, error: "Pertanyaan maks 4000 karakter" });

  const teksLengkap = PROMPT_TERTANAM + "\nPertanyaan user: " + question;

  try {
    const upstream = await callUpstream(teksLengkap, question);

    if (!upstream.ok) {
      return json(res, 502, {
        ok: false,
        error: "Upstream gagal di semua varian",
        last_attempt: upstream.last,
        prompt_chars: PROMPT_TERTANAM.length,
        full_payload_chars: teksLengkap.length,
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
        upstream_raw: upstream.parsed ?? upstream.raw?.slice(0, 2048),
      });
    }

    return json(res, 200, {
      ok: true,
      question,
      answer,
      prompt_chars: PROMPT_TERTANAM.length,
      full_payload_chars: teksLengkap.length,
      attempt: upstream.attempt,
      upstream_url: UPSTREAM_BASE,
      time: new Date().toISOString(),
    });
  } catch (e) {
    return json(res, 500, { ok: false, error: "Handler error", detail: String(e?.message ?? e) });
  }
}
