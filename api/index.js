// api/index.js
// Proxy API ke upstream DeepSeek. Open public, tanpa auth.

import { PROMPT_TERTANAM } from "../prompt.js";
import { fetch as undiciFetch, Agent } from "undici";

const UPSTREAM_BASE = "https://api.nexadev.my.id/ai/deepsek/";

// Agent dengan allowH2:false → paksa HTTP/1.1
const http1Agent = new Agent({ allowH2: false });

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
  const fromBody = (body && (body.question || body.text || body.prompt || body.q)) || null;
  if (fromBody && String(fromBody).trim()) return String(fromBody).trim();
  const q = url.searchParams.get("text") || url.searchParams.get("q") ||
            url.searchParams.get("question") || url.searchParams.get("prompt");
  return q ? String(q).trim() : "";
}

async function callUpstream(teksLengkap) {
  // 1. Coba POST dulu (biar tidak kena limit URL)
  try {
    const rPost = await undiciFetch(UPSTREAM_BASE, {
      method: "POST",
      dispatcher: http1Agent,
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ text: teksLengkap, prompt: teksLengkap, question: teksLengkap })
    });
    
    if (rPost.ok) {
      const raw = await rPost.text();
      let parsed = null; try { parsed = JSON.parse(raw); } catch {}
      return { ok: true, status: rPost.status, parsed, rawText: raw };
    }
    // Kalau POST ditolak (404/405), lanjut ke GET
  } catch (e) {
    // Abaikan error POST, coba GET
  }

  // 2. Fallback ke GET (tapi kita potong prompt-nya kalau kepanjangan)
  // Vercel punya limit URL, upstream juga. Kita batasi total URL max ~4000 char.
  const safeTeks = teksLengkap.length > 3000 ? teksLengkap.slice(-3000) : teksLengkap;
  const target = UPSTREAM_BASE + "?text=" + encodeURIComponent(safeTeks);
  
  const r = await undiciFetch(target, {
    method: "GET",
    dispatcher: http1Agent,
    headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (compatible; VercelProxy/1.0)" }
  });
  
  const rawText = await r.text();
  let parsed = null;
  try { parsed = JSON.parse(rawText); } catch {}
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

  if (path === "/" || path === "/health") {
    return json(res, 200, {
      ok: true, service: "deepseek-proxy-api", upstream: UPSTREAM_BASE,
      endpoints: { "GET /ask?q=": "query", "POST /ask": "json body" },
      time: new Date().toISOString(),
    });
  }

  const isAsk = path === "/ask" || path === "/api/ask" || path === "/api";
  if (!isAsk) return json(res, 404, { ok: false, error: "Not found" });
  if (req.method !== "GET" && req.method !== "POST") return json(res, 405, { ok: false, error: "Method not allowed" });

  let body = {};
  if (req.method === "POST") body = await readBody(req);

  const question = extractQuestion(req, body, url);
  if (!question) return json(res, 400, { ok: false, error: "Pertanyaan kosong" });

  // Gabung prompt + pertanyaan
  const teksLengkap = PROMPT_TERTANAM + "\nPertanyaan user: " + question;

  try {
    const upstream = await callUpstream(teksLengkap);

    if (!upstream.ok) {
      return json(res, 502, { ok: false, error: "Upstream HTTP " + upstream.status, upstream_raw: upstream.parsed || upstream.rawText });
    }

    const data = upstream.parsed;
    if (!data || typeof data !== "object") {
      return json(res, 502, { ok: false, error: "Upstream bukan JSON valid", upstream_raw: upstream.rawText });
    }
    if (!data.status) {
      return json(res, 502, { ok: false, error: "Upstream status=false", upstream_raw: data });
    }

    const answer = data.result || data.answer || data.message || "";
    return json(res, 200, {
      ok: true,
      question,
      answer,
      prompt_used: PROMPT_TERTANAM,
      upstream_url: UPSTREAM_BASE,
      time: new Date().toISOString(),
    });
  } catch (e) {
    const cause = e && e.cause ? { code: e.cause.code || null, message: e.cause.message || String(e.cause) } : null;
    return json(res, 500, { ok: false, error: "Gagal memanggil upstream", detail: String(e && e.message ? e.message : e), cause });
  }
}
