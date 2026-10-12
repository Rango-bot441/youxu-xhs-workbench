import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_BASE = 'https://api.openai.com/v1';
const TIMEOUT_MS = 300_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const usageFrom = usage => usage && Number.isFinite(usage.input_tokens) && Number.isFinite(usage.output_tokens)
  ? { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens } : null;
function responseError(message, response) {
  const error = new Error(message);
  error.usage = usageFrom(response?.usage);
  error.usageUnknown = !error.usage;
  error.requestId = response?.id || '';
  return error;
}

// Parse only the small, relevant TOML surface. Unrelated configuration is ignored.
function outsideSplit(value, separator) {
  const parts = [];
  let quote = '', escaped = false, depth = 0, start = 0;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\' && quote === '"') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') depth--;
    else if (char === separator && depth === 0) {
      parts.push(value.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
}

function parseValue(value) {
  value = outsideSplit(value, '#')[0].trim();
  if (value.startsWith('"')) return JSON.parse(value);
  if (value.startsWith("'")) {
    if (!value.endsWith("'")) throw new Error('当前模型配置格式无法读取。');
    return value.slice(1, -1);
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value.startsWith('{') && value.endsWith('}')) {
    const result = Object.create(null);
    for (const entry of outsideSplit(value.slice(1, -1), ',')) {
      if (!entry.trim()) continue;
      const [key, ...rest] = outsideSplit(entry, '=');
      result[parseKey(key)] = parseValue(rest.join('='));
    }
    return result;
  }
  throw new Error('当前模型配置含有暂不支持的配置格式。');
}

function parseKey(key) {
  key = key.trim();
  return key.startsWith('"') || key.startsWith("'") ? parseValue(key) : key;
}

function readCodexFields(text) {
  const root = Object.create(null), providers = Object.create(null);
  let section = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = outsideSplit(raw, '#')[0].trim();
    if (!line) continue;
    if (line.startsWith('[')) {
      section = line.endsWith(']') ? outsideSplit(line.slice(1, -1), '.').map(parseKey) : [];
      continue;
    }
    const [rawKey, ...rest] = outsideSplit(line, '=');
    if (!rest.length) continue;
    const key = parseKey(rawKey);
    if (!section.length && ['model', 'model_provider'].includes(key)) root[key] = parseValue(rest.join('='));
    if (section[0] !== 'model_providers' || !section[1]) continue;
    const provider = providers[section[1]] ??= Object.create(null);
    if (section.length === 2 && ['base_url', 'wire_api', 'env_key', 'experimental_bearer_token', 'http_headers', 'env_http_headers', 'requires_openai_auth'].includes(key)) {
      provider[key] = parseValue(rest.join('='));
    } else if (section.length === 3 && ['http_headers', 'env_http_headers'].includes(section[2])) {
      (provider[section[2]] ??= Object.create(null))[key] = parseValue(rest.join('='));
    }
  }
  return { root, providers };
}

function safeMessage(message, secrets = []) {
  let text = String(message || '模型请求失败。');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length > 3) text = text.split(secret).join('[已隐藏]');
  }
  return text
    .replace(/Bearer\s+[^\s"',;<>]+/gi, 'Bearer [已隐藏]')
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/g, '[已隐藏]')
    .replace(/(?:api[_-]?key|access[_-]?token|authorization)\s*[:=]\s*["']?[^\s"',;}]+/gi, '[凭据已隐藏]')
    .replace(/[\r\n\u0000-\u001f]+/g, ' ')
    .slice(0, 400);
}

function normalizeBase(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('模型服务地址格式无效。'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('模型服务必须使用 HTTPS；仅本机服务允许 HTTP。');
  }
  if (url.username || url.password || url.search || url.hash) throw new Error('模型服务地址不能包含凭据、查询参数或锚点。');
  return url.href.replace(/\/+$/, '');
}

function completeConfig({ key, base, model, source, headers = {} }) {
  if (!model || typeof model !== 'string') throw new Error('缺少模型名称，请配置对应来源的 MODEL。');
  const normalized = Object.create(null);
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== 'string' || /[\r\n]/.test(value) || !/^[A-Za-z0-9-]+$/.test(name)) throw new Error('模型请求头配置格式无效。');
    if (['host', 'content-length', 'connection', 'cookie'].includes(name.toLowerCase())) throw new Error('模型请求头包含不允许转发的字段。');
    normalized[name.toLowerCase()] = value;
  }
  if (!normalized.authorization && key) normalized.authorization = `Bearer ${key}`;
  if (!normalized.authorization && !Object.keys(normalized).some(name => /auth|key|token/i.test(name))) {
    throw new Error('未找到当前模型服务对应的可用凭据。');
  }
  const secrets = [key, ...Object.values(normalized)].filter(Boolean);
  return { model, source, base: normalizeBase(base), headers: normalized, secrets };
}

// The reader is injected so credential matching can be tested without real local secrets.
export async function resolveCodexCredentials(providerId, provider, env, readAuth) {
  const headers = { ...(provider.http_headers || {}) };
  for (const [name, envName] of Object.entries(provider.env_http_headers || {})) {
    if (!env[envName]) throw new Error('当前模型服务所需的请求头环境变量尚未配置。');
    headers[name] = env[envName];
  }
  let key = provider.experimental_bearer_token;
  if (!key && provider.env_key) {
    key = env[provider.env_key];
    if (!key) throw new Error('当前 Codex provider 指定的凭据环境变量尚未配置。');
  }
  const mayReadCodexAuth = providerId === 'openai' || provider.requires_openai_auth === true;
  if (!key && !Object.keys(headers).some(name => /auth|key|token/i.test(name)) && mayReadCodexAuth) {
    try { key = (await readAuth()).OPENAI_API_KEY; }
    catch { /* No credential is better than sending an unrelated credential. */ }
  }
  return { key, headers };
}

async function loadConfig() {
  // Keep credential sources together: a new base URL never inherits a different source's key.
  for (const prefix of ['XHS', 'OPENAI']) {
    if (['API_KEY', 'BASE_URL', 'MODEL'].some(name => process.env[`${prefix}_${name}`])) {
      if (!process.env[`${prefix}_API_KEY`]) throw new Error(`已设置 ${prefix} 模型配置，但缺少 ${prefix}_API_KEY；不会借用其他服务的凭据。`);
      return completeConfig({
        key: process.env[`${prefix}_API_KEY`],
        base: process.env[`${prefix}_BASE_URL`] || DEFAULT_BASE,
        model: process.env[`${prefix}_MODEL`],
        source: `${prefix} 环境变量`,
      });
    }
  }
  const configDir = process.env.CODEX_HOME || join(homedir(), '.codex');
  let text;
  try { text = await readFile(join(configDir, 'config.toml'), 'utf8'); }
  catch { throw new Error('没有找到模型配置，请设置 XHS_API_KEY、XHS_BASE_URL 和 XHS_MODEL。'); }
  let parsed;
  try { parsed = readCodexFields(text); }
  catch { throw new Error('当前 Codex 模型配置格式无法安全读取，请使用独立的 XHS 环境变量配置。'); }
  const { root, providers } = parsed;
  const providerId = root.model_provider || 'openai';
  const provider = providers[providerId] || (providerId === 'openai' ? {} : null);
  if (!provider) throw new Error('当前 Codex provider 未定义，无法匹配模型服务和凭据。');
  if (provider.wire_api && provider.wire_api !== 'responses') throw new Error('当前模型服务不是 Responses API，首版暂不支持此协议。');
  const { key, headers } = await resolveCodexCredentials(providerId, provider, process.env, async () => JSON.parse(await readFile(join(configDir, 'auth.json'), 'utf8')));
  return completeConfig({ key, headers, base: provider.base_url || DEFAULT_BASE, model: root.model, source: `本机 Codex · ${providerId}` });
}

export async function getProviderInfo() {
  try {
    const config = await loadConfig();
    return { ready: true, model: config.model, source: config.source };
  } catch (error) {
    return { ready: false, model: '', source: '未配置', error: safeMessage(error.message) };
  }
}

async function readBoundedText(response, maxBytes = MAX_RESPONSE_BYTES) {
  if (!response.body) return '';
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let total = 0, text = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return text + decoder.decode();
      total += value.byteLength;
      if (total > maxBytes) throw new Error('模型响应超过允许大小。');
      text += decoder.decode(value, { stream: true });
    }
  } finally { await reader.cancel().catch(() => {}); }
}

async function readSSE(response) {
  if (!response.body) throw new Error('模型服务返回空响应。');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', total = 0, completed = null, lastResponse = null;
  const output = new Map();
  function event(block) {
    const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    let item;
    try { item = JSON.parse(data); } catch { throw new Error('模型服务返回了无法解析的流式事件。'); }
    if (item.response) lastResponse = item.response;
    if (item.type === 'error' || item.type === 'response.failed') throw responseError(item.error?.message || item.response?.error?.message || '模型服务执行失败。', item.response);
    if (item.type === 'response.incomplete') throw responseError(`模型输出未完成：${item.response?.incomplete_details?.reason || '输出被截断'}。`, item.response);
    if (item.type === 'response.output_item.added' || item.type === 'response.output_item.done') output.set(item.output_index, structuredClone(item.item));
    if (item.type === 'response.function_call_arguments.delta') {
      const target = output.get(item.output_index);
      if (target) target.arguments = (target.arguments || '') + item.delta;
    }
    if (item.type === 'response.output_text.delta') {
      const target = output.get(item.output_index);
      if (target) {
        target.content ??= [];
        target.content[item.content_index] ??= { type: 'output_text', text: '', annotations: [] };
        target.content[item.content_index].text += item.delta;
      }
    }
    if (item.type === 'response.completed' || item.type === 'response.done') completed = item.response;
  }
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new Error('模型响应超过允许大小。');
      buffer += decoder.decode(value, { stream: true });
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        event(buffer.slice(0, match.index));
        buffer = buffer.slice(match.index + match[0].length);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) event(buffer);
    if (!completed) throw new Error('模型连接提前结束，未收到完成事件；本次结果未保存为成功。');
    if (!completed.output?.length) completed.output = [...output.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
    return completed;
  } catch (error) {
    error.usage ??= usageFrom(lastResponse?.usage);
    error.usageUnknown = !error.usage;
    error.requestId ||= lastResponse?.id || '';
    throw error;
  } finally { await reader.cancel().catch(() => {}); }
}

export async function callModel({ instructions, input, tools = [], signal, maxOutputTokens = 4500, modelOverride = '' }) {
  let config;
  try { config = await loadConfig(); if (modelOverride) config = { ...config, model: modelOverride }; }
  catch (error) { error.usageUnknown = false; error.usage = { inputTokens: 0, outputTokens: 0 }; throw error; }
  const startedAt = Date.now();
  let attempted = false, knownUsage = null, requestId = '';
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), TIMEOUT_MS);
  timer.unref?.();
  const combinedSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
  try {
    if (!Array.isArray(input) && typeof input !== 'string') throw new Error('模型输入必须是文本或 Responses 消息列表。');
    if (!Array.isArray(tools)) throw new Error('模型工具定义必须是列表。');
    const body = {
      model: config.model,
      instructions,
      input,
      tools,
      stream: true,
      store: false,
      include: ['reasoning.encrypted_content'],
      max_output_tokens: Math.max(64, Math.min(12_000, Number(maxOutputTokens) || 4500)),
      ...(/^gpt-[56](?:[.-]|$)/i.test(config.model) ? { reasoning: { effort: 'low' } } : {}),
      ...(tools.length ? { tool_choice: 'auto', parallel_tool_calls: false } : {}),
    };
    combinedSignal.throwIfAborted();
    attempted = true;
    const response = await fetch(`${config.base}/responses`, {
      method: 'POST',
      headers: { ...config.headers, 'content-type': 'application/json', accept: 'text/event-stream, application/json' },
      body: JSON.stringify(body),
      signal: combinedSignal,
      redirect: 'manual',
    });
    requestId = response.headers.get('x-request-id') || '';
    if (response.status >= 300 && response.status < 400) throw new Error('模型服务要求重定向；为保护凭据，已拒绝向其他地址转发。');
    if (!response.ok) {
      const text = await readBoundedText(response, 65_536);
      let detail = '';
      try { const data = JSON.parse(text); detail = data.error?.message || data.message || ''; } catch { /* Do not expose HTML/proxy responses. */ }
      const label = ({ 401: '认证失败', 403: '无权访问此模型', 429: '额度不足或请求过于频繁', 502: '上游模型不可用', 503: '模型服务暂时不可用' })[response.status] || '请求失败';
      throw new Error(`模型服务返回 HTTP ${response.status}（${label}）${detail ? `：${detail}` : '。'}`);
    }
    const data = /text\/event-stream/i.test(response.headers.get('content-type') || '')
      ? await readSSE(response)
      : JSON.parse(await readBoundedText(response));
    knownUsage = usageFrom(data.usage);
    requestId ||= data.id || '';
    if (data.error) throw responseError(data.error.message || '模型服务执行失败。', data);
    if (data.status && data.status !== 'completed') throw responseError(`模型输出未完成（${data.status}）：${data.incomplete_details?.reason || '请重试或缩小任务范围'}。`, data);
    if (!Array.isArray(data.output) || !data.output.length) throw new Error('模型服务未返回有效输出。');
    // Keep opaque reasoning state for stateless tool continuations, never reasoning text.
    const output = data.output.filter(item => ['message', 'function_call', 'reasoning'].includes(item.type)).map(item => item.type === 'reasoning'
      ? { type: 'reasoning', ...(item.id ? { id: item.id } : {}), ...(item.encrypted_content ? { encrypted_content: item.encrypted_content } : {}), summary: [] }
      : item);
    if (!output.some(item => ['message', 'function_call'].includes(item.type))) throw new Error('模型服务没有返回可展示结果或工具调用。');
    return {
      output,
      usage: knownUsage || { inputTokens: 0, outputTokens: 0 },
      usageUnknown: !knownUsage,
      model: data.model || config.model,
      requestId,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    let message = error.message;
    if (signal?.aborted) message = '模型请求已取消。';
    else if (timeout.signal.aborted) message = '模型请求超过 300 秒，已取消；可重试或缩小任务范围。';
    else if (error.message === 'fetch failed') {
      const code = /^[A-Z][A-Z0-9_]{1,40}$/.test(error.cause?.code || '') ? error.cause.code : 'NETWORK_ERROR';
      const reason = ({ ECONNRESET: '连接被远端或网络中间节点重置', ENOTFOUND: '无法解析模型服务域名', ECONNREFUSED: '模型服务拒绝连接', ETIMEDOUT: '连接超时', UND_ERR_CONNECT_TIMEOUT: '连接超时' })[code] || '无法连接模型服务';
      message = `模型网络请求失败（${code}）：${reason}。尚未收到模型响应，不能据此判断凭据是否有效。`;
    }
    const failure = new Error(safeMessage(message, config.secrets));
    failure.usage = knownUsage || error.usage || { inputTokens: 0, outputTokens: 0 };
    failure.usageUnknown = attempted && !(knownUsage || error.usage);
    failure.requestId = requestId || error.requestId ? safeMessage(requestId || error.requestId, config.secrets) : '';
    failure.durationMs = Date.now() - startedAt;
    throw failure;
  } finally { clearTimeout(timer); }
}

export async function checkProvider(modelOverride = '') {
  const info = await getProviderInfo();
  if (!info.ready) return { ready: false, model: info.model, message: info.error };
  try {
    const result = await callModel({ modelOverride,
      instructions: '这是一次连接检查。仅回复“连接成功”。',
      input: [{ role: 'user', content: '请确认连接。' }],
      maxOutputTokens: 96,
    });
    const text = result.output.filter(item => item.type === 'message').flatMap(item => item.content || []).filter(part => part.type === 'output_text').map(part => part.text).join('').trim();
    if (!text) throw new Error('模型已响应，但未返回文本，连接检查未通过。');
    return { ready: true, model: result.model, message: '真实模型连接成功。', usage: result.usage };
  } catch (error) {
    return { ready: false, model: info.model, message: error.message };
  }
}

// 从当前端点读取模型列表，过滤掉名字含 image/imagine 的生图模型。
export async function listModels() {
  const config = await loadConfig();
  const response = await fetch(`${config.base}/models`, { headers: { ...config.headers }, redirect: 'manual', signal: AbortSignal.timeout(20_000) });
  if (response.status >= 300 && response.status < 400) throw new Error('模型服务要求重定向；为保护凭据，已拒绝向其他地址转发。');
  if (!response.ok) {
    let detail = '';
    try { const data = JSON.parse(await readBoundedText(response, 65_536)); detail = data.error?.message || data.message || ''; } catch { /* 不暴露非 JSON 响应 */ }
    throw new Error(`读取模型列表失败（HTTP ${response.status}）${detail ? `：${detail}` : '。'}`);
  }
  let data;
  try { data = JSON.parse(await readBoundedText(response)); } catch { throw new Error('模型列表返回格式无法解析。'); }
  if (!Array.isArray(data?.data)) throw new Error('模型列表格式不正确。');
  return [...new Set(data.data.map(item => typeof item?.id === 'string' ? item.id : '').filter(id => id && !/image|imagine/i.test(id)))];
}
