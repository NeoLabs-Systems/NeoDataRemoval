"use strict";

const crypto = require("crypto");

const sysconfig = require("./sysconfig");

function cacheKey(brokerName, fullName, userId) {
  return crypto
    .createHash("sha256")
    .update(`${userId}:${brokerName}|${fullName}`)
    .digest("hex");
}

/**
 * Returns true for GPT-5 family models that require the Responses API.
 * The special alias "gpt-5-chat-latest" is intentionally excluded because
 * it is a Chat Completions-compatible snapshot of GPT-5.
 */
function usesResponsesApi(model) {
  return (
    (/^gpt-5(\.|-)/.test(model) ||
      model === "gpt-5" ||
      model === "gpt-5-mini") &&
    !model.startsWith("gpt-5-chat")
  );
}

async function draftRemovalEmail(brokerName, profile, brokerUrl, userId) {
  const apiKey = sysconfig.get("openai_api_key");
  if (!apiKey) return null;

  const db = require("../db/database").getDb();
  const key = cacheKey(brokerName, profile.full_name || "", userId || 0);
  const cached = db
    .prepare("SELECT content, created_at FROM ai_cache WHERE cache_key = ?")
    .get(key);
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

  if (cached && Date.now() - cached.created_at * 1000 < thirtyDaysMs) {
    return cached.content;
  }

  let OpenAI;
  try {
    OpenAI = require("openai");
  } catch {
    return null;
  }

  const openai = new (OpenAI.default || OpenAI)({ apiKey });

  const model = sysconfig.get("openai_model") || "gpt-4.1-mini";
  const name = profile.full_name || "Unknown";
  const address = profile.addresses && profile.addresses[0];
  const addrStr = address
    ? [address.street, address.city, address.state].filter(Boolean).join(", ")
    : "";

  const prompt = [
    `Write a concise, professional GDPR/CCPA data removal request email to the data broker "${brokerName}"`,
    brokerUrl ? `(${brokerUrl})` : "",
    `Subject line: "Data Removal Request — ${brokerName}".`,
    `For the individual: ${name}${addrStr ? `, ${addrStr}` : ""}.`,
    "Keep the body under 200 words. Be direct and formal.",
    "Request: deletion of all records, no re-adding or re-selling, written confirmation of removal.",
    `Sign as ${name}.`,
    "Return only the email body — no subject line, no extra commentary.",
  ]
    .filter(Boolean)
    .join(" ");

  let draft = null;
  try {
    if (usesResponsesApi(model)) {
      // ── Responses API (GPT-5.x family) ────────────────────────────────
      // Uses `input` instead of `messages` and `max_output_tokens` instead
      // of `max_tokens`.  Response text is at `resp.output_text`.
      const resp = await openai.responses.create({
        model,
        input: prompt,
        max_output_tokens: 450,
      });
      draft = resp.output_text?.trim() || null;
    } else {
      // ── Chat Completions API (GPT-4.x, GPT-3.x, gpt-5-chat-latest) ───
      const resp = await openai.chat.completions.create({
        model,
        max_tokens: 450,
        messages: [{ role: "user", content: prompt }],
      });
      draft = resp.choices[0]?.message?.content?.trim() || null;
    }
  } catch (err) {
    console.error("[AI] OpenAI call failed:", err.message);
    return null;
  }

  if (draft) {
    db.prepare(
      `
      INSERT INTO ai_cache (cache_key, content, created_at)
      VALUES (?, ?, unixepoch())
      ON CONFLICT(cache_key) DO UPDATE
        SET content    = excluded.content,
            created_at = excluded.created_at
    `,
    ).run(key, draft);
  }

  return draft;
}

module.exports = { draftRemovalEmail };
