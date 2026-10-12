import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createStore } from './lib/store.mjs';
import { getProviderInfo, checkProvider, listModels } from './lib/provider.mjs';
import { preflight, generateContent, reviseContent, reviewContent } from './lib/workflow.mjs';

const root = dirname(fileURLToPath(import.meta.url));
await mkdir(join(root, 'data'), { recursive: true });
const store = createStore(process.env.WORKBENCH_DB || join(root, 'data', 'workbench.sqlite'));
const busy = new Map();
const send = (res, value, code = 200) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(value));
};
async function body(req) {
  let text = '', bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 200_000) throw new Error('输入过长，请缩小到 200 KB 以内。');
    text += chunk.toString('utf8');
  }
  try { const value = JSON.parse(text || '{}'); if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(); return value; }
  catch { throw new Error('输入格式无效。'); }
}
function assertIdle(topicId) {
  if (busy.has(topicId)) throw new Error('这条选题正在处理，请等待本次操作完成。');
}
function currentDraft(id) {
  const draft = store.getDraft(id), topic = store.getTopic(draft.topicId);
  if (topic.selectedDraftId !== id) throw new Error('请先选中这份稿件；历史版本需作为新版本修改后再检查。');
  return { draft, topic };
}
// 生成期间锁定模型选择，避免中途修改后结果归属混乱。
function lockedModel(input, settings, kind) {
  return input.lockedModels?.[kind] ?? (kind === 'checking' ? settings.checkingModel : settings.writingModel) ?? '';
}
function startRun(action, topic, profile, draft, input = {}) {
  assertIdle(topic.id);
  const run = store.createRun({ id: randomUUID(), topicId: topic.id, draftId: draft?.id || '', action, status: 'running', inputSnapshot: { topic, profile, draft, ...input }, createdAt: new Date().toISOString() });
  busy.set(topic.id, run.id);
  void (async () => {
    try {
      let response, result;
      if (action === 'generate') {
        response = await generateContent({ topic, profile, existing: input.existingDraft, model: lockedModel(input, store.getSettings(), 'writing') });
        const fresh = response.value.variants.map(item => store.addDraft({ ...item, topicId: topic.id, origin: 'ai', author: response.evidence.model, changeNote: input.existingDraft ? '候选第二稿' : '候选初稿', runId: run.id }).id);
        result = { draftIds: [...(input.existingDraftId ? [input.existingDraftId] : []), ...fresh], differenceSummary: response.value.differenceSummary };
      } else if (action === 'revise') {
        response = await reviseContent({ topic, profile, draft, ...input, model: lockedModel(input, store.getSettings(), 'writing') });
        const updated = store.addDraft({ ...response.value, topicId: topic.id, parentId: draft.id, origin: 'ai', author: response.evidence.model, changeNote: input.instruction, runId: run.id });
        result = { draftId: updated.id };
      } else {
        response = await reviewContent({ topic, profile, draft, model: lockedModel(input, store.getSettings(), 'checking') });
        const review = store.addReview({ ...response.value, draftId: draft.id, topicId: topic.id, version: draft.version, runId: run.id });
        result = { reviewId: review.id, ...response.value };
      }
      store.updateRun(run.id, { status: 'completed', ...response.evidence, result, finishedAt: new Date().toISOString() });
    } catch (error) {
      store.updateRun(run.id, { status: 'failed', error: error.message, ...(error.evidence || {}), usage: error.usage || error.evidence?.usage, requestId: error.requestId || error.evidence?.requestId || '', durationMs: error.durationMs || error.evidence?.durationMs || 0, finishedAt: new Date().toISOString() });
    } finally { busy.delete(topic.id); }
  })();
  return run;
}

const server = http.createServer(async (req, res) => {
  try {
    const host = req.headers.host || '';
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return send(res, { error: '此版本仅允许本机访问。' }, 403);
    if (!['GET', 'HEAD'].includes(req.method)) {
      const origin = req.headers.origin;
      if (origin && origin !== `http://${host}`) return send(res, { error: '已拒绝跨站写入请求。' }, 403);
      if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return send(res, { error: '请使用 JSON 请求。' }, 415);
    }
    const url = new URL(req.url, `http://${host}`), path = url.pathname;
    if (req.method === 'GET' && path === '/api/health') return send(res, { ok: true, busy: busy.size });
    if (req.method === 'GET' && path === '/api/state') return send(res, { ...store.listState(), settings: store.getSettings(), provider: await getProviderInfo() });
    if (req.method === 'POST' && path === '/api/provider/check') return send(res, await checkProvider());
    if (req.method === 'GET' && path === '/api/models') {
      try { return send(res, { models: await listModels(), defaultModel: (await getProviderInfo()).model || '' }); }
      catch (error) { return send(res, { error: error.message, models: [], defaultModel: (await getProviderInfo()).model || '' }, 502); }
    }
    if (req.method === 'POST' && path === '/api/settings/models') {
      if (busy.size) throw new Error('有模型正在生成或检查，请完成后再修改模型设置。');
      const input = await body(req);
      for (const [key, label] of [['writingModel', '写作模型'], ['checkingModel', '检查模型']]) {
        const model = typeof input[key] === 'string' ? input[key].trim() : '';
        if (!model) continue;
        const check = await checkProvider(model);
        if (!check.ready) return send(res, { error: `${label}「${model}」连接检查未通过：${check.message}。已保留原来的设置。` }, 422);
      }
      return send(res, { settings: store.saveSettings(input) });
    }
    if (req.method === 'POST' && path === '/api/profiles') {
      const input = await body(req);
      const related = store.listState().topics.filter(t => t.profileId === input.id);
      related.forEach(t => assertIdle(t.id));
      return send(res, { profile: store.saveProfile(input) });
    }
    if (req.method === 'POST' && path === '/api/topics') return send(res, { topic: store.createTopic(await body(req)) }, 201);
    const topicMatch = path.match(/^\/api\/topics\/([^/]+)(?:\/(generate|preflight))?$/);
    if (topicMatch) {
      const topic = store.getTopic(topicMatch[1]), profile = store.resolveProfile(topic);
      if (req.method === 'PATCH' && !topicMatch[2]) { assertIdle(topic.id); return send(res, { topic: store.updateTopic(topic.id, await body(req)) }); }
      if (req.method === 'POST' && topicMatch[2] === 'preflight') return send(res, preflight(topic, profile));
      if (req.method === 'POST' && topicMatch[2] === 'generate') {
        const lockedModels = store.getSettings();
        const check = preflight(topic, profile);
        if (!check.ready) return send(res, { error: '请先补充影响真实性的关键信息。', ...check }, 422);
        const input = await body(req);
        if (!input.more) return send(res, { run: startRun('generate', topic, profile, null, { lockedModels }) }, 202);
        const lastRun = store.listState().runs.filter(r => r.topicId === topic.id && r.action === 'generate' && r.status === 'completed').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        const ids = lastRun?.result?.draftIds || [];
        if (ids.length !== 1) throw new Error('当前没有可参照的第一套稿，请先生成。');
        const existing = store.getDraft(ids[0]);
        return send(res, { run: startRun('generate', topic, profile, null, { lockedModels, existingDraftId: existing.id, existingDraft: { title: existing.title, body: existing.body, tags: existing.tags, angle: existing.angle, guide: existing.guide } }) }, 202);
      }
    }
    const draftMatch = path.match(/^\/api\/drafts\/([^/]+)\/(select|edit|revise|review|override|send-back|publish|export)$/);
    if (draftMatch) {
      const id = draftMatch[1], action = draftMatch[2], draft = store.getDraft(id), topic = store.getTopic(draft.topicId);
      if (req.method === 'GET' && action === 'export') {
        currentDraft(id);
        if (!['approved', 'published'].includes(draft.status)) throw new Error('请先完成当前版本的内容检查，再导出。');
        const md = url.searchParams.get('format') !== 'txt';
        const text = `${md ? '# ' : ''}${draft.title}\n\n${draft.body}\n\n${draft.tags.map(tag => `#${tag.replace(/^#/, '')}`).join(' ')}\n`;
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-disposition': `attachment; filename="content-v${draft.version}.${md ? 'md' : 'txt'}"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        return res.end(text);
      }
      if (req.method === 'POST') {
        assertIdle(topic.id);
        const input = await body(req);
        if (action === 'select') return send(res, { draft: store.selectDraft(id) });
        currentDraft(id);
        if (action === 'edit') return send(res, { draft: store.editDraft(id, input) }, 201);
        if (action === 'override') return send(res, { draft: store.overrideReview(id) });
        if (action === 'send-back') return send(res, { draft: store.sendBack(id) });
        if (action === 'publish') return send(res, { publication: store.recordPublication(id, input) }, 201);
        if (action === 'revise') {
          if (typeof input.instruction !== 'string' || !input.instruction.trim()) throw new Error('请填写修改要求。');
          if (!['all', 'title', 'body', 'tags', 'selection'].includes(input.scope || 'all')) throw new Error('修改范围无效。');
          return send(res, { run: startRun('revise', topic, store.resolveProfile(topic), draft, { instruction: input.instruction, scope: input.scope || 'all', selectedText: input.selectedText || '', lockedModels: store.getSettings() }) }, 202);
        }
        if (action === 'review') return send(res, { run: startRun('review', topic, store.resolveProfile(topic), draft, { lockedModels: store.getSettings() }) }, 202);
      }
    }
    if (path.startsWith('/api/')) return send(res, { error: '没有找到这个操作。' }, 404);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, { error: '不支持此操作。' }, 405);
    const assets = { '/': ['index.html', 'text/html'], '/index.html': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'] };
    if (!assets[path]) return send(res, { error: '页面不存在。' }, 404);
    const [file, type] = assets[path];
    res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'" });
    res.end(req.method === 'HEAD' ? '' : await readFile(join(root, 'public', file)));
  } catch (error) { send(res, { error: error.message || '操作失败，请重试。' }, 400); }
});
server.listen(Number(process.env.WORKBENCH_PORT || 4328), '127.0.0.1', () => console.log(`本地工作台：http://127.0.0.1:${server.address().port}`));
server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? '端口已被使用，请通过 WORKBENCH_PORT 选择其他端口。' : '服务启动失败。'); store.close(); process.exitCode = 1; });
function stop() {
  if (busy.size) { console.log('正在等待当前模型操作完成后退出。'); const timer = setInterval(() => { if (!busy.size) { clearInterval(timer); server.close(() => { store.close(); process.exit(0); }); } }, 500); return; }
  server.close(() => { store.close(); process.exit(0); });
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
