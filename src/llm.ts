export interface LlmEnv {
  LLM_API_KEY?: string;
  LLM_BASE_URL?: string;
  LLM_MODEL?: string;
  LLM_PROVIDER?: string;
}

export function llmReady(env: LlmEnv): boolean {
  return !!env.LLM_API_KEY && env.LLM_API_KEY.length > 8;
}

function endpoint(env: LlmEnv): string {
  const base = (env.LLM_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
  return `${base}/chat/completions`;
}

interface Msg {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** 流式调用（OpenAI 兼容协议：DeepSeek / 通义千问 compatible-mode） */
export async function streamChat(
  env: LlmEnv,
  messages: Msg[],
  onDelta: (text: string) => void,
  opts: { temperature?: number; maxTokens?: number; timeoutMs?: number } = {}
): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 30000);
  let full = '';
  try {
    const res = await fetch(endpoint(env), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.LLM_API_KEY}`,
      },
      body: JSON.stringify({
        model: env.LLM_MODEL || 'deepseek-chat',
        messages,
        stream: true,
        temperature: opts.temperature ?? 0.9,
        max_tokens: opts.maxTokens ?? 1200,
      }),
      signal: ac.signal,
    });

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      throw new Error(`LLM ${res.status}: ${detail.slice(0, 200)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith('data:')) continue;
        const payload = s.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const json = JSON.parse(payload);
          const delta = json?.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta.length) {
            full += delta;
            onDelta(delta);
          }
        } catch {
          /* 半包数据，忽略 */
        }
      }
    }
    return full;
  } finally {
    clearTimeout(timer);
  }
}

/** 非流式调用，用于 JSON 不合法时的重试 */
export async function chatOnce(
  env: LlmEnv,
  messages: Msg[],
  opts: { temperature?: number; maxTokens?: number; timeoutMs?: number } = {}
): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 25000);
  try {
    const res = await fetch(endpoint(env), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.LLM_API_KEY}`,
      },
      body: JSON.stringify({
        model: env.LLM_MODEL || 'deepseek-chat',
        messages,
        stream: false,
        temperature: opts.temperature ?? 0.7,
        max_tokens: opts.maxTokens ?? 1200,
      }),
      signal: ac.signal,
    });
    const txt = await res.text();
    if (!res.ok) throw new Error(`LLM ${res.status}: ${txt.slice(0, 200)}`);
    const json = JSON.parse(txt);
    return json?.choices?.[0]?.message?.content || '';
  } finally {
    clearTimeout(timer);
  }
}

/** 从模型输出里抠出 JSON 对象（容忍代码块包裹 / 前后缀文字） */
export function extractJson(raw: string): any | null {
  if (!raw) return null;
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        const slice = text.slice(start, i + 1);
        try {
          return JSON.parse(slice);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * 流式增量提取 narration 字段的字符，实现"不用等整段 JSON 生成完就能逐字显示"。
 */
export function createNarrationExtractor() {
  let buf = '';
  let started = false;
  let cursor = 0;
  let finished = false;

  return function feed(chunk: string): string {
    if (finished) return '';
    buf += chunk;
    if (!started) {
      const m = /"narration"\s*:\s*"/.exec(buf);
      if (!m) {
        // 有的模型把 narration 写在前面但还没写完 key，保留尾部继续等
        if (buf.length > 200) buf = buf.slice(-160);
        return '';
      }
      started = true;
      cursor = m.index + m[0].length;
    }
    let out = '';
    let i = cursor;
    while (i < buf.length) {
      const c = buf[i];
      if (c === '\\') {
        if (i + 1 >= buf.length) break;
        const n = buf[i + 1];
        if (n === 'u') {
          if (i + 5 >= buf.length) break;
          const code = parseInt(buf.slice(i + 2, i + 6), 16);
          if (Number.isFinite(code)) out += String.fromCharCode(code);
          i += 6;
          continue;
        }
        const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', b: '', f: '' };
        out += map[n] !== undefined ? map[n] : n;
        i += 2;
        continue;
      }
      if (c === '"') {
        finished = true;
        cursor = i + 1;
        break;
      }
      out += c;
      i++;
    }
    if (!finished) cursor = i;
    return out;
  };
}
