// api/index.js
// Proxy API ke upstream DeepSeek. Open public, tanpa auth.
// ESM, Node 18+, single handler, semua route di sini.

import { PROMPT_TERTANAM } from "../prompt.js";

// WAJIB pakai trailing slash "/deepsek/" — tanpa slash upstream balikin 301
// dan fetch di Vercel gagal (ECONNRESET).
const UPSTREAM_URL = "https://api.nexadev.my.id/ai/deepsek/";

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body.length) {
    try { return JSON.parse(req.body); } catch { return { raw: req.body }; }
  }
  return await new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { resolve({ raw: data }); }
    });
    req.on("error", () => resolve({}));
  });
}

function extractQuestion(req, body, url) {
  const fromBody =
    (body && (body.question || body.text || body.prompt || body.q)) || null;
  if (fromBody && String(fromBody).trim()) return String(fromBody).trim();

  const q =
    url.searchParams.get("text") ||
    url.searchParams.get("q") ||
    url.searchParams.get("question") ||
    url.searchParams.get("prompt");
  return q ? String(q).trim() : "";
}

async function callUpstream(teksLengkap) {
  const target = UPSTREAM_URL + "?text=" + encodeURIComponent(teksLengkap);
  const r = await fetch(target, {
    method: "GET",
    redirect: "follow",
    headers: {
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (compatible; VercelProxy/1.0)",
    },
  });
  const rawText = await r.text();
  let parsed = null;
  try { parsed = JSON.parse(rawText); } catch { /* biarkan null */ }
  return { ok: r.ok, status: r.status, parsed, rawText };
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
    res.end();
    return;
  }

  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;

  // health hanya di root dan /health
  if (path === "/" || path === "/health") {
    return json(res, 200, {
      ok: true,
      service: "deepseek-proxy-api",
      upstream: UPSTREAM_URL,
      endpoints: {
        "GET /ask?q=<pertanyaan>": "kirim pertanyaan via query",
        "POST /ask { question: '<pertanyaan>' }": "kirim pertanyaan via JSON body",
      },
      time: new Date().toISOString(),
    });
  }

  const isAsk = path === "/ask" || path === "/api/ask" || path === "/api";
  if (!isAsk) {
    return json(res, 404, {
      ok: false,
      error: "Not found",
      hint: "Gunakan GET /ask?q=... atau POST /ask { question: ... }",
    });
  }

  if (req.method !== "GET" && req.method !== "POST") {
    return json(res, 405, { ok: false, error: "Method not allowed. Pakai GET atau POST." });
  }

  let body = {};
  if (req.method === "POST") {
    body = await readBody(req);
  }

  const question = extractQuestion(req, body, url);
  if (!question) {
    return json(res, 400, {
      ok: false,
      error: "Pertanyaan kosong",
      hint: "GET /ask?q=apa+itu+nodejs  atau  POST /ask {\"question\":\"apa itu nodejs\"}",
    });
  }

  const teksLengkap = PROMPT_TERTANAM + "\nPertanyaan user: " + question;

  try {
    const upstream = await callUpstream(teksLengkap);

    if (!upstream.ok) {
      return json(res, 502, {
        ok: false,
        error: "Upstream HTTP " + upstream.status,
        upstream_raw: upstream.parsed || upstream.rawText,
      });
    }

    const data = upstream.parsed;

    if (!data || typeof data !== "object") {
      return json(res, 502, {
        ok: false,
        error: "Upstream bukan JSON valid",
        upstream_raw: upstream.rawText,
      });
    }

    if (!data.status) {
      return json(res, 502, {
        ok: false,
        error: "Upstream status=false",
        upstream_raw: data,
      });
    }

    const answer = data.result || data.answer || data.message || "";
    return json(res, 200, {
      ok: true,
      question,
      answer,
      prompt_used: PROMPT_TERTANAM,
      upstream_url: UPSTREAM_URL,
      time: new Date().toISOString(),
    });
  } catch (e) {
    const cause =
      e && e.cause
        ? {
            code: e.cause.code || null,
            errno: e.cause.errno || null,
            syscall: e.cause.syscall || null,
            hostname: e.cause.hostname || null,
            message: e.cause.message || String(e.cause),
          }
        : null;
    return json(res, 500, {
      ok: false,
      error: "Gagal memanggil upstream",
      detail: String(e && e.message ? e.message : e),
      cause,
    });
  }
}
