import type { ProviderName, ProviderSettings, ProvidersConfig } from "./types.js";
import { DEFAULT_PROVIDER_MODELS } from "./types.js";

export const PROVIDER_NAMES: ProviderName[] = ["gpt", "claude", "gemini", "grok", "glm", "deepseek", "custom"];
export const PROVIDER_LABELS: Record<ProviderName, string> = {
  gpt: "OpenAI", claude: "Claude", gemini: "Gemini", grok: "Grok (xAI)",
  glm: "GLM (Zhipu AI)", deepseek: "DeepSeek", custom: "Custom API",
};
export const PROVIDER_ENDPOINTS: Record<ProviderName, string> = {
  gpt: "https://api.openai.com/v1/chat/completions",
  claude: "https://api.anthropic.com/v1/messages",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
  grok: "https://api.x.ai/v1/chat/completions",
  glm: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
  deepseek: "https://api.deepseek.com/chat/completions",
  custom: "",
};

export function emptyProvider(name: ProviderName): ProviderSettings {
  return { enabled: false, apiKey: "", model: DEFAULT_PROVIDER_MODELS[name], endpoint: PROVIDER_ENDPOINTS[name], authMethod: "bearer", apiName: "" };
}

export function createDefaultProviders(): ProvidersConfig {
  return { testMode: false, gpt: emptyProvider("gpt"), claude: emptyProvider("claude"), gemini: emptyProvider("gemini"), grok: emptyProvider("grok"), glm: emptyProvider("glm"), deepseek: emptyProvider("deepseek"), custom: emptyProvider("custom") };
}

export type ValidationCode = "missing_provider" | "missing_api_key" | "missing_model" | "missing_prompt" | "missing_endpoint" | "missing_api_name" | "missing_custom_header";
export function validateProviderConfig(name: ProviderName | undefined, cfg: ProviderSettings | undefined, prompt?: string, testMode = false): { ok: true } | { ok: false; code: ValidationCode; message: string } {
  if (!name || !cfg) return { ok: false, code: "missing_provider", message: "AI 제공자를 선택해 주세요." };
  if (!prompt?.trim()) return { ok: false, code: "missing_prompt", message: "프롬프트를 입력해 주세요." };
  if (testMode) return { ok: true };
  if (!cfg.apiKey.trim()) return { ok: false, code: "missing_api_key", message: `${PROVIDER_LABELS[name]} API 키를 입력해 주세요.` };
  if (!cfg.model.trim()) return { ok: false, code: "missing_model", message: "모델을 입력해 주세요." };
  if (name === "custom" && !cfg.apiName?.trim()) return { ok: false, code: "missing_api_name", message: "Custom API 이름을 입력해 주세요." };
  if (!cfg.endpoint?.trim()) return { ok: false, code: "missing_endpoint", message: `${PROVIDER_LABELS[name]} API 엔드포인트를 입력해 주세요.` };
  if (name === "custom" && cfg.authMethod === "custom-header" && !cfg.customHeader?.trim()) return { ok: false, code: "missing_custom_header", message: "인증 헤더 이름을 입력해 주세요." };
  return { ok: true };
}

export const validateProviderRequest = validateProviderConfig;

export function getSelectedProviderConfig(providers: ProvidersConfig): { provider: ProviderName; config: ProviderSettings } | undefined {
  const provider = PROVIDER_NAMES.find(name => providers[name].enabled);
  return provider ? { provider, config: providers[provider] } : undefined;
}
