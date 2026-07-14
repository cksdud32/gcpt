import type { ProviderName, ProviderSettings } from "./types.js";
import { PROVIDER_ENDPOINTS, PROVIDER_LABELS, validateProviderConfig } from "./provider-config.js";

export interface ProviderMessage { role: "system" | "user" | "assistant"; content: string }
export interface ProviderRequest {
  provider: ProviderName;
  config: ProviderSettings;
  messages: ProviderMessage[];
  prompt: string;
  testMode?: boolean;
  maxTokens?: number;
  temperature?: number;
}
export interface ProviderResult { text: string; promptTokens?: number; completionTokens?: number; raw?: unknown }

export class ProviderRuntimeError extends Error {
  constructor(public readonly code: string, message: string, public readonly cause?: unknown) { super(message); this.name = "ProviderRuntimeError"; }
}

function getPath(value: unknown, path: string): unknown {
  const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
  return parts.reduce<unknown>((cur, key) => cur != null && typeof cur === "object" ? (cur as Record<string, unknown>)[key] : undefined, value);
}

export function normalizeProviderResponse(provider: ProviderName, response: unknown, responsePath?: string): string {
  const paths = responsePath?.trim()
    ? [responsePath.trim()]
    : provider === "claude" ? ["content[0].text", "choices[0].message.content"]
      : provider === "gemini" ? ["candidates[0].content.parts[0].text", "choices[0].message.content"]
        : ["choices[0].message.content", "content[0].text", "candidates[0].content.parts[0].text"];
  for (const path of paths) {
    const text = getPath(response, path);
    if (typeof text === "string" && text.trim()) return text.trim();
  }
  throw new ProviderRuntimeError("invalid_response", `AI 응답에서 텍스트를 추출할 수 없습니다${responsePath ? ` (응답 경로: ${responsePath})` : ""}.`);
}

function statusOf(error: unknown): number | undefined {
  if (error && typeof error === "object") {
    const e = error as Record<string, unknown>;
    if (typeof e.status === "number") return e.status;
    if (typeof e.statusCode === "number") return e.statusCode;
  }
  return undefined;
}

export function normalizeApiError(error: unknown, development = process.env.NODE_ENV === "development"): ProviderRuntimeError {
  if (error instanceof ProviderRuntimeError) return error;
  const status = statusOf(error);
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const lower = raw.toLowerCase();
  let code = "request_failed", message = "AI 요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.";
  if (status === 401 || status === 403 || /invalid.*(key|token)|unauthori|authentication/.test(lower)) [code, message] = ["invalid_api_key", "API 키가 올바르지 않습니다."];
  else if (status === 429 || /rate.?limit|too many requests/.test(lower)) [code, message] = ["rate_limit", "요청 한도를 초과했습니다. 잠시 후 다시 시도해 주세요."];
  else if (status === 402 || /credit|quota.*exceed|insufficient.*(fund|balance)/.test(lower)) [code, message] = ["missing_credits", "API 크레딧이 부족합니다. 결제 상태를 확인해 주세요."];
  else if (status === 404 || /model.*(not found|invalid|does not exist)/.test(lower)) [code, message] = ["invalid_model", "선택한 모델을 사용할 수 없습니다. 모델 설정을 확인해 주세요."];
  else if (status && status >= 500) [code, message] = ["server_error", "AI 서버에 문제가 발생했습니다. 잠시 후 다시 시도해 주세요."];
  else if (/timeout|timed out|aborterror/.test(lower)) [code, message] = ["timeout", "AI 요청 시간이 초과되었습니다. 다시 시도해 주세요."];
  else if (/fetch failed|network|enotfound|econnrefused|socket|dns/.test(lower)) [code, message] = ["network_error", "네트워크 연결을 확인한 후 다시 시도해 주세요."];
  return new ProviderRuntimeError(code, development && raw ? `${message} (${raw})` : message, error);
}

class HttpError extends Error { constructor(public status: number, body: string) { super(`HTTP ${status}: ${body}`); } }

export async function executeProviderRequest(req: ProviderRequest): Promise<ProviderResult> {
  if (req.testMode) {
    const instructions = `${req.prompt}\n${req.messages.map(message => message.content).join("\n")}`;
    if (instructions.includes("implementation plan") || instructions.includes('"steps"')) {
      return { text: '{"title":"Test Mode plan","steps":[{"id":"1","title":"Verify mock workflow","description":"No real API request"}]}' };
    }
    return { text: /Output (ONLY )?(valid )?JSON|Output JSON|valid JSON/i.test(instructions) ? '{"value":"Test Mode response","reason":"Mock response","rationale":"No real API request","stanceAction":"propose"}' : "Test Mode mock response" };
  }
  const validation = validateProviderConfig(req.provider, req.config, req.prompt, false);
  if (!validation.ok) throw new ProviderRuntimeError(validation.code, validation.message);
  try {
    const { provider, config } = req;
    let endpoint = config.endpoint!.trim() || PROVIDER_ENDPOINTS[provider];
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    let body: unknown;
    if (provider === "claude") {
      headers["x-api-key"] = config.apiKey; headers["anthropic-version"] = "2023-06-01";
      const system = req.messages.filter(m => m.role === "system").map(m => m.content).join("\n");
      body = { model: config.model, max_tokens: req.maxTokens ?? 1024, system, messages: req.messages.filter(m => m.role !== "system") };
    } else if (provider === "gemini") {
      endpoint = `${endpoint.replace(/\/$/, "")}/models/${encodeURIComponent(config.model)}:generateContent?key=${encodeURIComponent(config.apiKey)}`;
      body = { contents: [{ role: "user", parts: [{ text: req.messages.map(m => `${m.role}: ${m.content}`).join("\n\n") }] }], generationConfig: { maxOutputTokens: req.maxTokens ?? 1024, temperature: req.temperature } };
    } else {
      if (config.authMethod === "api-key") headers["x-api-key"] = config.apiKey;
      else if (config.authMethod === "custom-header") headers[config.customHeader!] = config.apiKey;
      else headers.Authorization = `Bearer ${config.apiKey}`;
      body = { model: config.model, messages: req.messages, max_tokens: req.maxTokens ?? 1024, temperature: req.temperature };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      const res = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
      const rawText = await res.text();
      if (!res.ok) throw new HttpError(res.status, rawText.slice(0, 500));
      let json: unknown;
      try { json = JSON.parse(rawText); } catch { throw new ProviderRuntimeError("invalid_response", "AI 서버가 올바른 JSON 응답을 반환하지 않았습니다."); }
      const text = normalizeProviderResponse(provider, json, provider === "custom" ? config.responsePath : undefined);
      const usage = (json as { usage?: { prompt_tokens?: number; completion_tokens?: number }; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } });
      return { text, promptTokens: usage.usage?.prompt_tokens ?? usage.usageMetadata?.promptTokenCount, completionTokens: usage.usage?.completion_tokens ?? usage.usageMetadata?.candidatesTokenCount, raw: json };
    } finally { clearTimeout(timer); }
  } catch (error) { throw normalizeApiError(error); }
}
