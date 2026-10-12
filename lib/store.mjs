import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const now = () => new Date().toISOString();
const enumValue = (value, choices, label) => {
  if (!choices.includes(value)) throw new Error(`${label}不正确`);
  return value;
};
const required = (value, label) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`请填写${label}`);
  return value.trim();
};
const optional = (value) => typeof value === 'string' ? value.trim() : '';
const strings = (value, label) => {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error(`${label}需要是文字列表`);
  return [...new Set(value.map(item => item.trim()).filter(Boolean))];
};

export function createStore(dbPath) {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  const tables = ['profiles', 'topics', 'drafts', 'reviews', 'runs', 'publications', 'settings'];
  for (const table of tables) db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)))`);
  const read = (table, id, label) => {
    const row = db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id);
    if (!row) throw new Error(`${label}不存在，请刷新后重试`);
    return JSON.parse(row.data);
  };
  const all = table => db.prepare(`SELECT data FROM ${table} ORDER BY rowid DESC`).all().map(row => JSON.parse(row.data));
  const put = (table, record) => {
    db.prepare(`INSERT INTO ${table}(id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`).run(record.id, JSON.stringify(record));
    return record;
  };
  const transaction = fn => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  transaction(() => {
    for (const profile of all('profiles')) {
      if (!('relationship' in profile)) continue;
      const { relationship, ...rest } = profile;
      const persona = rest.persona && relationship && !rest.persona.includes(relationship) ? `${rest.persona}，${relationship}` : rest.persona || relationship || '';
      put('profiles', { ...rest, persona });
    }
  });
  const getTopic = id => read('topics', id, '选题');
  const getProfile = id => read('profiles', id, '账号');
  const getDraft = id => read('drafts', id, '稿件');
  const getRun = id => read('runs', id, '生成或检查记录');
  const assertIdle = topicId => {
    if (all('runs').some(run => run.topicId === topicId && run.status === 'running')) throw new Error('该选题正在生成或检查，请完成后再修改');
  };
  const currentDraft = id => {
    const draft = getDraft(id);
    const topic = getTopic(draft.topicId);
    if (topic.selectedDraftId !== draft.id) throw new Error('请先选中这份稿件，再继续操作');
    return { draft, topic };
  };
  const invalidate = topic => {
    for (const draft of all('drafts').filter(draft => draft.topicId === topic.id && ['approved', 'published'].includes(draft.status))) {
      put('drafts', { ...draft, status: 'draft' });
    }
    return put('topics', { ...topic, status: topic.selectedDraftId ? 'writing' : 'pending', updatedAt: now() });
  };
  const saveProfile = input => transaction(() => {
    const existing = input.id ? getProfile(input.id) : null;
    const source = { ...existing, ...input };
    const productSource = { ...existing?.product, ...input.product };
    const product = Object.fromEntries(['name', 'ageRange', 'format', 'price', 'bookingMethod'].map(key => [key, optional(productSource[key])]));
    product.features = strings(productSource.features, '课程特点');
    const accountType = required(source.accountType, '账号身份'), audience = required(source.audience, '目标读者');
    const profile = {
      id: existing?.id || randomUUID(), name: optional(input.name ?? existing?.name) || `${accountType}·${audience}`,
      accountType, persona: optional(source.persona), audience,
      tone: optional(source.tone), forbiddenTerms: strings(source.forbiddenTerms, '禁用表达'),
      handoffChannels: strings(source.handoffChannels, '承接方式'),
      defaultCta: enumValue(source.defaultCta || 'none', ['none', 'soft', 'direct'], '正文行动引导'),
      defaultProductExposure: enumValue(source.defaultProductExposure || 'natural', ['none', 'natural', 'focus'], '产品露出'),
      product, experience: optional(source.experience), reference: optional(source.reference),
      createdAt: existing?.createdAt || now(), updatedAt: now(),
    };
    if (existing && JSON.stringify({ ...profile, updatedAt: null }) !== JSON.stringify({ ...existing, updatedAt: null })) {
      const affected = all('topics').filter(topic => topic.profileId === profile.id);
      affected.forEach(topic => assertIdle(topic.id));
      affected.forEach(invalidate);
    }
    return put('profiles', profile);
  });
  const TOPIC_TEXT_FIELDS = ['goal', 'format', 'season', 'materials', 'accountType', 'persona', 'audience', 'tone', 'productName', 'bookingMethod'];
  const profileOrNull = id => id ? getProfile(id) : null;
  const topicFields = (input, profile, existing) => {
    const fields = {
      title: required(input.title ?? existing?.title, '选题'),
      idea: required(input.idea ?? existing?.idea ?? input.title, '自己的想法'),
      profileId: profile?.id || '',
      exposure: enumValue(input.exposure || existing?.exposure || profile?.defaultProductExposure || 'none', ['none', 'natural', 'focus'], '产品露出'),
      cta: enumValue(input.cta || existing?.cta || profile?.defaultCta || 'none', ['none', 'soft', 'direct'], '正文行动引导'),
      productFeatures: strings(input.productFeatures ?? existing?.productFeatures ?? [], '课程特点'),
    };
    for (const key of TOPIC_TEXT_FIELDS) fields[key] = optional(input[key] ?? existing?.[key]);
    if (!profile) {
      required(fields.accountType, '账号身份');
      required(fields.audience, '目标读者');
    }
    return fields;
  };
  const createTopic = input => {
    const profile = profileOrNull(optional(input.profileId));
    return put('topics', { id: randomUUID(), ...topicFields(input, profile), status: 'pending', selectedDraftId: null, createdAt: now(), updatedAt: now() });
  };
  const BLANK_PROFILE = {
    id: '', name: '本篇临时设置', accountType: '', persona: '', audience: '', tone: '',
    forbiddenTerms: [], handoffChannels: [], defaultCta: 'none', defaultProductExposure: 'none',
    product: { name: '', ageRange: '', format: '', price: '', bookingMethod: '', features: [] },
    experience: '', reference: '',
  };
  const resolveProfile = topic => {
    const base = topic.profileId ? getProfile(topic.profileId) : BLANK_PROFILE;
    return {
      ...base,
      accountType: topic.accountType || base.accountType,
      persona: topic.persona || base.persona,
      audience: topic.audience || base.audience,
      tone: topic.tone || base.tone,
      product: {
        ...base.product,
        name: topic.productName || base.product.name,
        bookingMethod: topic.bookingMethod || base.product.bookingMethod,
        features: topic.productFeatures?.length ? topic.productFeatures : base.product.features,
      },
    };
  };
  const updateTopic = (id, input) => transaction(() => {
    const topic = getTopic(id);
    assertIdle(id);
    const profile = profileOrNull(input.profileId ?? topic.profileId);
    const fields = topicFields(input, profile, topic);
    if (input.status === 'published') throw new Error('请先通过当前稿件的内容检查，再通过发布记录标记已发布');
    if (input.status != null) enumValue(input.status, ['pending', 'writing', 'archived'], '选题状态');
    const same = (a, b) => JSON.stringify(a ?? (Array.isArray(b) ? [] : '')) === JSON.stringify(b);
    const changed = Object.entries(fields).some(([key, value]) => !same(topic[key], value));
    if (changed) invalidate(topic);
    return put('topics', { ...getTopic(id), ...fields, ...(input.status != null ? { status: input.status } : {}), updatedAt: now() });
  });
  const addDraftRecord = input => {
    const topic = getTopic(required(input.topicId, '稿件所属选题'));
    if (topic.status === 'archived') throw new Error('选题已归档，请恢复后再写作');
    const parent = input.parentId ? getDraft(input.parentId) : null;
    if (parent && parent.topicId !== topic.id) throw new Error('修改稿与原稿必须属于同一选题');
    if (parent && topic.selectedDraftId !== parent.id) throw new Error('只能基于当前选中版本修改，请重新选择稿件');
    const origin = enumValue(input.origin || 'ai', ['ai', 'human'], '稿件来源');
    if (origin === 'human' && !parent) throw new Error('人工修改必须保留原稿版本');
    const run = input.runId ? getRun(input.runId) : null;
    if (run && (run.topicId !== topic.id || run.status !== 'running' || run.action !== (parent ? 'revise' : 'generate') || (parent && run.draftId !== parent.id))) throw new Error('稿件与模型运行记录不匹配');
    const guide = input.guide ?? parent?.guide ?? {};
    const draft = {
      id: randomUUID(), topicId: topic.id,
      version: Math.max(0, ...all('drafts').filter(draft => draft.topicId === topic.id).map(draft => draft.version)) + 1,
      parentId: parent?.id || null, runId: run?.id || null, origin, title: required(input.title, '标题'), body: required(input.body, '正文'),
      tags: strings(input.tags, '话题'), angle: optional(input.angle ?? parent?.angle),
      guide: Object.fromEntries(['hook', 'structure', 'productBridge', 'suitableFor'].map(key => [key, optional(guide[key])])),
      status: 'draft', author: origin === 'ai' ? required(input.author, '实际生成模型名称') : optional(input.author) || '大骨',
      changeNote: optional(input.changeNote), createdAt: now(),
    };
    put('drafts', draft);
    put('topics', { ...topic, status: 'writing', selectedDraftId: parent ? draft.id : topic.selectedDraftId, updatedAt: now() });
    return draft;
  };
  const addDraft = input => transaction(() => addDraftRecord(input));
  const selectDraft = id => transaction(() => {
    const draft = getDraft(id);
    const topic = getTopic(draft.topicId);
    assertIdle(topic.id);
    if (topic.status === 'archived') throw new Error('选题已归档，请恢复后再选择稿件');
    put('topics', { ...topic, selectedDraftId: id, status: draft.status === 'published' ? 'published' : 'writing', updatedAt: now() });
    return draft;
  });
  const editDraft = (id, input) => transaction(() => {
    const { draft, topic } = currentDraft(id);
    assertIdle(topic.id);
    const changes = Object.fromEntries(['title', 'body', 'tags', 'changeNote'].filter(key => key in input).map(key => [key, input[key]]));
    return addDraftRecord({ ...draft, ...changes, topicId: topic.id, parentId: draft.id, runId: null, origin: 'human', author: optional(input.author) || '大骨' });
  });
  const addReview = input => transaction(() => {
    const { draft } = currentDraft(required(input.draftId, '检查的稿件'));
    if (getTopic(draft.topicId).status === 'archived') throw new Error('选题已归档，请恢复后再检查');
    if (input.version !== draft.version) throw new Error('检查版本已变更，请重新检查当前稿件');
    const verdict = enumValue(input.verdict, ['pass', 'revise', 'verify'], '检查结论');
    if (!Array.isArray(input.findings)) throw new Error('检查问题需要是列表');
    const findings = input.findings.map(finding => ({ type: optional(finding.type), severity: enumValue(finding.severity, ['block', 'warn', 'info'], '检查问题级别'), quote: optional(finding.quote), reason: required(finding.reason, '检查原因'), suggestion: optional(finding.suggestion) }));
    if (verdict === 'pass' && findings.some(finding => finding.severity === 'block')) throw new Error('存在阻断问题，不能标记为检查通过');
    const run = input.runId ? getRun(input.runId) : null;
    if (run && (run.topicId !== draft.topicId || run.draftId !== draft.id || run.action !== 'review' || run.status !== 'running')) throw new Error('检查与模型运行记录不匹配');
    const review = put('reviews', { id: randomUUID(), draftId: draft.id, runId: run?.id || null, version: draft.version, verdict, findings, strengths: strings(input.strengths, '稿件优点'), createdAt: now() });
    put('drafts', { ...draft, status: verdict === 'pass' ? 'approved' : 'changes_requested' });
    return review;
  });
  const overrideReview = id => transaction(() => {
    const { draft, topic } = currentDraft(id);
    assertIdle(topic.id);
    if (topic.status === 'archived') throw new Error('选题已归档，请恢复后再操作');
    if (draft.status !== 'changes_requested') throw new Error('只有检查后未通过的当前版本才能人工放行');
    const review = all('reviews').filter(item => item.draftId === draft.id && item.version === draft.version).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (!review) throw new Error('请先对当前版本做内容检查');
    if (review.override) throw new Error('该检查结果已人工放行');
    if (review.findings.some(finding => finding.severity === 'block')) throw new Error('存在阻断问题，不能人工放行，请先修改');
    const warnings = review.findings.filter(finding => finding.severity === 'warn');
    if (!warnings.length && review.verdict !== 'verify') throw new Error('这次检查没有可放行的提醒项');
    put('reviews', { ...review, override: { at: now(), warnings: warnings.map(({ type, quote, reason }) => ({ type, quote, reason })), verdict: review.verdict } });
    return put('drafts', { ...draft, status: 'approved' });
  });
  const sendBack = id => transaction(() => {
    const { draft, topic } = currentDraft(id);
    assertIdle(topic.id);
    if (topic.status === 'archived') throw new Error('选题已归档，请恢复后再打回稿件');
    put('topics', { ...topic, status: 'writing', updatedAt: now() });
    return put('drafts', { ...draft, status: 'changes_requested' });
  });
  const recordPublication = (id, input = {}) => transaction(() => {
    const { draft, topic } = currentDraft(id);
    assertIdle(topic.id);
    if (topic.status === 'archived') throw new Error('选题已归档，请恢复后再记录发布');
    if (!['approved', 'published'].includes(draft.status)) throw new Error('请先通过当前稿件的内容检查，再记录发布');
    const publishedAt = input.publishedAt || now();
    if (Number.isNaN(Date.parse(publishedAt))) throw new Error('发布时间不正确');
    const publication = put('publications', { id: randomUUID(), draftId: id, channel: optional(input.channel) || '小红书', url: optional(input.url), note: optional(input.note), publishedAt, createdAt: now() });
    put('drafts', { ...draft, status: 'published' });
    put('topics', { ...topic, status: 'published', updatedAt: now() });
    return publication;
  });
  const createRun = input => transaction(() => {
    const topic = getTopic(required(input.topicId, '运行所属选题'));
    assertIdle(topic.id);
    if (topic.status === 'archived') throw new Error('选题已归档，请恢复后再生成或检查');
    const action = enumValue(input.action, ['generate', 'revise', 'review'], '运行操作');
    if (input.draftId) {
      const { draft } = currentDraft(input.draftId);
      if (draft.topicId !== topic.id) throw new Error('运行稿件与选题不匹配');
    } else if (action !== 'generate') throw new Error('请选择需要修改或检查的稿件');
    return put('runs', { id: randomUUID(), topicId: topic.id, draftId: input.draftId || null, action, status: 'running', model: optional(input.model), requestId: null, usage: null, durationMs: null, error: null, inputSnapshot: input.inputSnapshot ?? null, result: null, createdAt: now(), finishedAt: null });
  });
  const updateRun = (id, input) => {
    const run = getRun(id);
    const status = enumValue(input.status ?? run.status, ['running', 'completed', 'failed'], '运行状态');
    if (run.status !== 'running') throw new Error('已结束的运行记录不能修改');
    const changes = Object.fromEntries(['model', 'requestId', 'usage', 'durationMs', 'error', 'result'].filter(key => key in input).map(key => [key, input[key]]));
    return put('runs', { ...run, ...changes, status, finishedAt: status === 'running' ? null : now() });
  };
  const getSettings = () => {
    const row = db.prepare('SELECT data FROM settings WHERE id=?').get('default');
    return row ? JSON.parse(row.data) : {};
  };
  const saveSettings = input => transaction(() => {
    if (all('runs').some(run => run.status === 'running')) throw new Error('有模型正在生成或检查，请完成后再修改模型设置');
    const modelName = (value, label) => {
      const name = optional(value);
      if (name && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) throw new Error(`${label}名称格式不正确`);
      return name;
    };
    return put('settings', { id: 'default', writingModel: modelName(input.writingModel, '写作模型'), checkingModel: modelName(input.checkingModel, '检查模型'), updatedAt: now() });
  });

  // 重启后不把中断的模型请求保留成永远运行中的状态。
  for (const run of all('runs').filter(run => run.status === 'running')) put('runs', { ...run, status: 'failed', error: '本地服务重启，运行已中断；原有输入和稿件已保留，请重试', finishedAt: now() });
  return { listState: () => Object.fromEntries(tables.filter(table => table !== 'settings').map(table => [table, all(table)])), saveProfile, createTopic, updateTopic, getTopic, getProfile, resolveProfile, getDraft, addDraft, selectDraft, editDraft, addReview, overrideReview, sendBack, recordPublication, createRun, updateRun, getRun, getSettings, saveSettings, close: () => db.close() };
}
