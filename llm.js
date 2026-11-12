// Model adapters behind one interface, so the agent loop is provider-neutral.
//   GROQ_API_KEY      → gpt-oss on Groq (OpenAI-compatible chat completions with tool calling)
//   ANTHROPIC_API_KEY → Claude (Anthropic SDK). Takes precedence when both are set.
// Each adapter: next() → { texts: string[], calls: [{id, name, input}], stop: "tool_use" | "end" | "refusal" }
//               addResults([{ id, content, isError }])
import Anthropic from "@anthropic-ai/sdk";

export function providerName() {
  if (process.env.ANTHROPIC_API_KEY) return "claude";
  if (process.env.GROQ_API_KEY) return "groq";
  return null;
}

export function modelLabel() {
  const p = providerName();
  if (p === "claude") return "Claude (claude-opus-5-5)";
  if (p === "groq") return `${currentGroqModel()} on Groq`;
  return "no model configured";
}

export function createSession({ system, tools, userMessage }) {
  const p = providerName();
  if (p === "claude") return claudeSession(system, tools, userMessage);
  if (p === "groq") return groqSession(system, tools, userMessage);
  throw new Error("No AI key configured. Set GROQ_API_KEY (or ANTHROPIC_API_KEY) in .env");
}

function claudeSession(system, tools, userMessage) {
  const client = new Anthropic();
  const messages = [{ role: "user", content: userMessage }];
  return {
    async next() {
      const r = await client.beta.messages.create({
        model: "claude-opus-5-5",
        max_tokens: 16000,
        system,
        tools,
        messages,
        output_config: { effort: "medium" },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });
      const texts = r.content.filter((b) => b.type === "text" && b.text.trim()).map((b) => b.text);
      if (r.stop_reason === "refusal") return { texts, calls: [], stop: "refusal" };
      messages.push({ role: "assistant", content: r.content });
      if (r.stop_reason === "pause_turn") return { texts, calls: [], stop: "tool_use" };
      const calls = r.content.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id, name: b.name, input: b.input }));
      return { texts, calls, stop: r.stop_reason === "tool_use" ? "tool_use" : "end" };
    },
    addResults(results) {
      messages.push({
        role: "user",
        content: results.map((x) => ({ type: "tool_result", tool_use_id: x.id, content: x.content, ...(x.isError ? { is_error: true } : {}) })),
      });
    },
    say(text) {
      messages.push({ role: "user", content: text });
    },
  };
}

// When the primary model's DAILY quota is exhausted, switch to a fallback model (separate quota) for an hour
// instead of failing the run in front of a user.
const FALLBACK_MODEL = () => process.env.GROQ_FALLBACK_MODEL || "openai/gpt-oss-20b";
let dailyFallbackUntil = 0;
export const isDailyQuotaError = (status, j) => status === 429 && /per day|(TPD)|(RPD)/i.test(j?.error?.message || "");
export function currentGroqModel() {
  const primary = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
  return Date.now() < dailyFallbackUntil ? FALLBACK_MODEL() : primary;
}

function groqSession(system, tools, userMessage) {
  let model = currentGroqModel();
  const base = process.env.GROQ_BASE || "https://api.groq.com/openai/v1";
  const fnTools = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  const messages = [{ role: "system", content: system }, { role: "user", content: userMessage }];
  return {
    async next() {
      let r, j;
      for (let attempt = 0; attempt < 6; attempt++) {
        r = await fetch(`${base}/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model, messages, tools: fnTools, tool_choice: "auto", temperature: 0.2, max_completion_tokens: 8000, reasoning_effort: process.env.GROQ_REASONING || "low" }),
        });
        j = await r.json().catch(() => ({}));
        // gpt-oss occasionally emits a malformed tool call (e.g. a tool named "commentary"); Groq rejects it with
        // 400 tool_use_failed. Sampling again usually succeeds.
        const malformedToolCall = r.status === 400 && j?.error?.code === "tool_use_failed";
        if (isDailyQuotaError(r.status, j) && model !== FALLBACK_MODEL()) {
          dailyFallbackUntil = Date.now() + 60 * 60 * 1000;
          model = FALLBACK_MODEL();
          continue; // retry immediately on the fallback model
        }
        if (r.status !== 429 && r.status < 500 && !malformedToolCall) break;
        // Free-tier TPM limits are tight (the deep scan's root-cause calls share the key): honor "try again in Xs".
        const hint = Number(/try again in ([\d.]+)s/.exec(j?.error?.message || "")?.[1]);
        const wait = Math.min(30, Number(r.headers.get("retry-after")) || (hint ? hint + 1 : 2 ** attempt * 2));
        await new Promise((ok) => setTimeout(ok, wait * 1000));
      }
      if (!r.ok) throw new Error(`Groq ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
      const msg = j.choices[0].message;
      const toolCalls = msg.tool_calls || [];
      messages.push({ role: "assistant", content: msg.content || "", ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
      const calls = toolCalls.map((tc) => {
        let input;
        try { input = JSON.parse(tc.function.arguments || "{}"); } catch { input = { __invalid_json: tc.function.arguments }; }
        return { id: tc.id, name: tc.function.name, input };
      });
      const texts = msg.content?.trim() ? [msg.content] : [];
      return { texts, calls, stop: calls.length ? "tool_use" : "end" };
    },
    addResults(results) {
      for (const x of results) messages.push({ role: "tool", tool_call_id: x.id, content: x.isError ? `ERROR: ${x.content}` : x.content });
    },
    say(text) {
      messages.push({ role: "user", content: text });
    },
  };
}
