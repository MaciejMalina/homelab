// Wywołania Claude Messages API (bez SDK — zwykły fetch) + licznik zużycia w KV
import { kvGet, kvSet } from "./db";
import { todayPL } from "./time";

const API_URL = (process.env.ANTHROPIC_BASE_URL?.trim() || "https://api.anthropic.com") + "/v1/messages";
export const MODEL = () => process.env.CLAUDE_MODEL?.trim() || "claude-sonnet-5-5";

// Cennik Sonnet 5.5 (USD / 1 mln tokenów) — tylko do szacunku w ustawieniach
const PRICE_IN = 2;
const PRICE_OUT = 10;

export const claudeConfigured = () => !!process.env.ANTHROPIC_API_KEY?.trim();

export interface Msg {
  role: "user" | "assistant";
  content: string;
}
export interface Tool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

interface Opts {
  system: string;
  messages: Msg[];
  maxTokens?: number;
  tool?: Tool; // jeśli podane — wymuszamy wywołanie tego narzędzia (strukturalna odpowiedź)
}

interface ApiBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
}
interface ApiResponse {
  content: ApiBlock[];
  stop_reason: string;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
}

export async function askClaude(o: Opts): Promise<{ text: string; toolInput?: unknown }> {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) throw new Error("Brak ANTHROPIC_API_KEY w .env");
  const body: Record<string, unknown> = {
    model: MODEL(),
    max_tokens: o.maxTokens ?? 1500,
    system: o.system,
    messages: o.messages,
  };
  if (o.tool) {
    body.tools = [o.tool];
    body.tool_choice = { type: "tool", name: o.tool.name };
  }

  let res: Response | undefined;
  for (let proba = 1; proba <= 3; proba++) {
    res = await fetch(API_URL, {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180000),
    });
    // 429/529 = przeciążenie — krótka pauza i ponowienie
    if (res.status !== 429 && res.status !== 529 && res.status < 500) break;
    if (proba < 3) await new Promise((r) => setTimeout(r, proba * 5000));
  }
  if (!res || !res.ok) {
    const t = res ? (await res.text()).slice(0, 400) : "brak odpowiedzi";
    throw new Error(`Claude API HTTP ${res?.status}: ${t}`);
  }
  const data = (await res.json()) as ApiResponse;
  await countUsage(data.usage);

  const text = data.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n").trim();
  const tool = data.content.find((b) => b.type === "tool_use");
  if (o.tool && !tool) throw new Error(`Claude nie zwrócił struktury ${o.tool.name} (stop_reason: ${data.stop_reason})`);
  if (o.tool && data.stop_reason === "max_tokens") throw new Error("Odpowiedź Claude ucięta (max_tokens) — plan niepełny");
  return { text, toolInput: tool?.input };
}

async function countUsage(u: ApiResponse["usage"]) {
  if (!u) return;
  const key = `usage:${todayPL().slice(0, 7)}`;
  const prev = JSON.parse((await kvGet(key)) ?? '{"in":0,"out":0,"calls":0}') as { in: number; out: number; calls: number };
  const inTok = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  await kvSet(key, JSON.stringify({ in: prev.in + inTok, out: prev.out + (u.output_tokens ?? 0), calls: prev.calls + 1 }));
}

export async function usageThisMonth() {
  const v = JSON.parse((await kvGet(`usage:${todayPL().slice(0, 7)}`)) ?? '{"in":0,"out":0,"calls":0}') as {
    in: number;
    out: number;
    calls: number;
  };
  return { ...v, usd: (v.in * PRICE_IN + v.out * PRICE_OUT) / 1e6 };
}
