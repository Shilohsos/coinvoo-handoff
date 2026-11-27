// Minimal Telegram Bot API client: sendMessage only.
//   * plain text: the request body never carries `parse_mode`
//   * 10 s timeout per attempt, ONE retry on a network error, a 5xx or a 429; never on any other 4xx
//   * never throws, and never puts the bot token in a log line or a returned error
// `fetchImpl` is injectable, so the whole sender is callable from one function in a test or by an
// operator: sendMessage({ token, chatId, text, fetchImpl }).

export const TELEGRAM_TIMEOUT_MS = 10000;
export const TELEGRAM_MAX_TEXT = 4096;
const DEFAULT_BASE = 'https://api.telegram.org';

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

function redact(msg, token) {
  let s = String(msg === undefined || msg === null ? '' : msg);
  if (token) s = s.split(token).join('***');
  return s.replace(/bot\d+:[A-Za-z0-9_-]{20,}/g, 'bot***').slice(0, 300);
}

// Resolves to { ok, messageId, status, attempts, transient, error }.
//   transient: true when the failure may succeed later (no HTTP answer, 5xx, 429), so a caller
//              that wants to retry across minutes can tell it from a refusal (400, 401, 403, ...).
export async function sendMessage({
  token, chatId, text,
  fetchImpl = globalThis.fetch,
  apiBase = DEFAULT_BASE,
  timeoutMs = TELEGRAM_TIMEOUT_MS,
  retryDelayMs = 1000,
  sleep = sleepMs
}) {
  const out = { ok: false, messageId: null, status: null, attempts: 0, transient: false, error: null };
  try {
    if (!token || !chatId) {
      out.error = 'missing token or chat id';
      return out;
    }
    const url = `${apiBase}/bot${token}/sendMessage`;
    // Exactly these keys. In particular there is no parse_mode: the text is sent as plain text.
    const body = JSON.stringify({ chat_id: chatId, text: String(text).slice(0, TELEGRAM_MAX_TEXT), disable_web_page_preview: true });

    for (let attempt = 1; attempt <= 2; attempt++) {
      out.attempts = attempt;
      let wait = retryDelayMs;
      let retry = false;
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          signal: AbortSignal.timeout(timeoutMs)
        });
        out.status = res.status;
        let json = null;
        try { json = await res.json(); } catch { /* not JSON */ }
        if (res.ok && json && json.ok) {
          out.ok = true;
          out.transient = false;
          out.error = null;
          out.messageId = json.result && json.result.message_id !== undefined ? json.result.message_id : null;
          return out;
        }
        out.error = redact((json && json.description) || `HTTP ${res.status}`, token);
        if (res.status >= 500 || res.status === 429) {
          retry = true;
          out.transient = true;
          if (res.status === 429 && json && json.parameters && Number(json.parameters.retry_after) > 0) {
            wait = Math.min(Number(json.parameters.retry_after) * 1000, 5000);
          }
        } else {
          out.transient = false; // 400 and the other refusals: retrying cannot help
          return out;
        }
      } catch (e) {
        out.status = null;
        out.transient = true;
        out.error = redact(e && e.message ? e.message : e, token);
        retry = true;
      }
      if (retry && attempt < 2) await sleep(wait);
      else break;
    }
    return out;
  } catch (e) {
    out.error = redact(e && e.message ? e.message : e, token);
    return out;
  }
}
