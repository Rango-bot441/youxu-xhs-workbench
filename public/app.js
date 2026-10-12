'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const list = value => Array.isArray(value) ? value : value ? [value] : [];
const words = value => String(value || '').split(/[\n,，]+/).map(v => v.trim()).filter(Boolean);
const tags = value => String(value || '').split(/[\s,，]+/).map(v => v.replace(/^#+/, '').trim()).filter(Boolean);
const stamp = value => value ? new Date(value).toLocaleString('zh-CN', {month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '';
const labels = {pending:'待写',writing:'写作中',published:'已发布',archived:'暂不使用',draft:'未检查',approved:'内容检查通过',changes_requested:'需修改',pass:'通过',revise:'建议修改',verify:'待核验',ai:'AI',human:'人工',generate:'生成文案',reviseRun:'修改文案',review:'内容检查'};
let state = {profiles:[],topics:[],drafts:[],reviews:[],runs:[],publications:[],provider:{}};
let view = 'topics', topicId = '', historyId = '', query = '', topicFilter = 'all', selectedText = '', preflightResult = null, newTopicStep = 1;
let noticeTimer, polling = false, operationBusy = false;
let newTopicDraft = {}, providerCheck = null, providerChecking = false, continueOpen = false, modelList = null, modelListError = '', modelChoice = { writing: [], checking: [] };
const main = $('#main');

async function api(path, method = 'GET', data) {
  let response;
  try { response = await fetch(path, {method, headers: data === undefined ? {} : {'Content-Type':'application/json'}, ...(data === undefined ? {} : {body:JSON.stringify(data)})}); }
  catch { throw new Error('无法连接本地工作台，请检查服务是否已启动。'); }
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error || '操作失败，请重试。'), {details:result});
  return result;
}
function notify(message, error = false) {
  const node = $('#notice'); node.textContent = message; node.classList.toggle('error', error); node.hidden = false;
  clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { node.hidden = true; }, error ? 9000 : 4500);
}
async function load(renderPage = true) {
  state = await api('/api/state');
  if (!topicId || !state.topics.some(t => t.id === topicId)) topicId = state.topics.find(t => t.status !== 'archived')?.id || '';
  renderProviderStatus();
  if (renderPage) render();
  if (state.runs.some(r => r.status === 'running')) poll();
}
function renderProviderStatus() {
  const p = $('#provider-status'), info = state.provider || {};
  const note = '点击检查会真实调用一次模型，有少量用量。';
  p.classList.remove('ready', 'error');
  if (!info.ready) { p.textContent = '未找到模型配置'; p.title = info.error || '请先配置模型'; }
  else if (providerChecking) { p.textContent = '检查中…'; p.title = '正在真实调用模型'; }
  else if (providerCheck?.ready) { p.classList.add('ready'); p.textContent = `连接成功 · ${providerCheck.model || info.model || '可生成'} · ${stamp(providerCheck.at)}`; p.title = `来源：${info.source || '本机配置'}。${note}`; }
  else if (providerCheck) { p.classList.add('error'); p.textContent = '连接失败，点击重试'; p.title = `${providerCheck.message || '检查未通过'}。${note}`; }
  else { p.textContent = '已找到配置 · 未检查'; p.title = `来源：${info.source || '本机配置'}。${note}`; }
}
function modelsSettings() { return state.settings || {}; }
function effectiveModel(kind) { const st = modelsSettings(); return (kind === 'checking' ? st.checkingModel : st.writingModel) || state.provider?.model || ''; }
async function loadModelList() {
  if (modelList !== null || modelListError) return;
  try { const data = await api('/api/models'); modelList = data.models || []; modelListError = ''; }
  catch (error) { modelListError = error.message; modelList = []; }
}
function buildModelChoice(kind, current) {
  const defaults = effectiveModel(kind), saved = modelsSettings()[kind === 'checking' ? 'checkingModel' : 'writingModel'];
  const list = [...new Set([defaults, current, ...(modelList || [])].filter(Boolean))];
  return list.map(model => [model, model + (model === defaults && !saved ? '（配置文件默认）' : '')]);
}
function renderModelDialog() {
  const box = $('#models-content'), st = modelsSettings(), runningCount = state.runs.filter(r => r.status === 'running').length;
  modelChoice.writing = buildModelChoice('writing', st.writingModel || '');
  modelChoice.checking = buildModelChoice('checking', st.checkingModel || '');
  if (!box) return;
  const disabled = runningCount ? 'disabled' : '';
  box.innerHTML = `
    <p class="hint">模型列表来自当前端点，已过滤生图模型。保存前会真实连接一次，不通过则不保存。Key 只在服务器配置文件里，不经浏览器。凭据来源：${esc(state.provider?.source || '未配置')}。</p>
    ${runningCount ? '<p class="hint warning-note">有生成或检查正在进行，完成后才能修改。</p>' : ''}
    ${modelListError ? `<p class="hint warning-note">模型列表读取失败：${esc(modelListError)}<button class="quiet" type="button" data-action="refresh-models">重试</button></p>` : ''}
    <form id="model-form">
      ${select('写作模型（生成 / 再出一套 / AI 修改）','writingModel',modelChoice.writing,st.writingModel || '')}
      ${select('检查模型（内容检查）','checkingModel',modelChoice.checking,st.checkingModel || '')}
      <div class="button-row"><button class="secondary" type="button" data-action="reset-models" ${disabled}>恢复为配置文件默认</button><button class="primary" type="submit" ${disabled}>检查并保存</button></div>
    </form>`;
}
async function openModels() {
  if (state.runs.some(r => r.status === 'running')) { notify('有生成或检查正在进行，完成后再修改模型设置。', true); return; }
  const dialog = $('#models-dialog');
  if (!dialog.open) dialog.showModal();
  modelList = null; modelListError = '';
  renderModelDialog();
  await loadModelList();
  renderModelDialog();
}
function activeTopic() { return state.topics.find(t => t.id === topicId); }
function profileFor(topic = activeTopic()) { return state.profiles.find(p => p.id === topic?.profileId); }
function selectedDraft(topic = activeTopic()) { return state.drafts.find(d => d.id === topic?.selectedDraftId); }
function runsFor(topic = activeTopic()) { return state.runs.filter(r => r.topicId === topic?.id).sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt)); }
function running(topic = activeTopic()) { return runsFor(topic).find(r => r.status === 'running'); }
function elapsedText(run) { const sec = Math.max(0, Math.round((Date.now() - new Date(run.createdAt)) / 1000)); return sec < 60 ? `${sec} 秒` : `${Math.floor(sec / 60)} 分 ${sec % 60} 秒`; }
setInterval(() => { const el = document.getElementById('run-elapsed'), run = running(); if (el && run) el.textContent = elapsedText(run); }, 1000);
function isBusy() { return Boolean(running()); }
function badge(status) { return `<span class="badge ${['changes_requested','verify','archived'].includes(status) ? 'warn' : ''}">${esc(labels[status] || status)}</span>`; }
function opts(options, value) { const choices = value && !options.some(([v])=>v===value) ? [...options,[value,value]] : options; return choices.map(([v,text]) => `<option value="${esc(v)}" ${v === value ? 'selected' : ''}>${esc(text)}</option>`).join(''); }
function mark(label) {
  if (label.startsWith('*')) return `${esc(label.slice(1))}<b class="req">必填</b>`;
  if (label.endsWith('（选填）')) return `${esc(label.slice(0,-4))}<i class="opt">选填</i>`;
  return esc(label);
}
function field(label, name, value = '', type = 'text', placeholder = '', extra = '') { return `<label class="field ${extra}"><span>${mark(label)}</span><input type="${type}" name="${name}" value="${esc(value)}" placeholder="${esc(placeholder)}"></label>`; }
function area(label, name, value = '', placeholder = '', extra = '') { return `<label class="field ${extra}"><span>${mark(label)}</span><textarea name="${name}" placeholder="${esc(placeholder)}">${esc(value)}</textarea></label>`; }
function select(label, name, options, value = '', extra = '') { return `<label class="field ${extra}"><span>${mark(label)}</span><select name="${name}">${opts(options,value)}</select></label>`; }
const exposureOptions = [['none','不提课程'],['natural','自然提及'],['focus','重点介绍']];
const ctaOptions = [['none','不写行动引导'],['soft','轻量行动引导'],['direct','明确行动引导']];
function profileOptions() { return state.profiles.map(p => [p.id,p.name]); }
function heading(eyebrow,title,sub,action = '') { return `<div class="page-heading"><div><span class="eyebrow">${esc(eyebrow)}</span><h1>${esc(title)}</h1><p class="subtitle">${esc(sub)}</p></div>${action}</div>`; }
function accountField(value, placeholder, req = true) { return `<label class="field"><span>${mark(req ? '*账号身份' : '账号身份（选填）')}</span><input name="accountType" list="account-types" value="${esc(value)}" placeholder="${esc(placeholder)}"><datalist id="account-types"><option value="素人账号"><option value="官方账号"><option value="KOS账号"></datalist></label>`; }
function topicFields(topic = {}, create = false) {
  const profile = profileFor(topic), hold = profile ? '留空则沿用该设置' : '';
  return `${select('写给哪个账号','profileId',[['','不使用账号，本篇自己填'],...profileOptions()],topic.profileId || '')}
    ${field('*选题','title',topic.title,'text','例如：三年级数学基础差怎么办')}
    ${area('*我的想法','idea',topic.idea,'想强调什么？希望读者看完有什么感受？')}
    <div class="form-grid">${select('本篇目的','goal',[['分享干货','分享干货'],['引发讨论','引发讨论'],['建立课程兴趣','建立课程兴趣'],['获取咨询','获取咨询']],topic.goal || '建立课程兴趣')}${select('课程露出','exposure',exposureOptions,topic.exposure || profile?.defaultProductExposure || 'natural')}</div>
    <details ${(preflightResult || !topic.profileId) && !create ? 'open' : ''}><summary>更多选项（选填，不填沿用账号设置）</summary>
      <div class="form-grid">${accountField(topic.accountType || '',hold || '例如：素人账号')}${field(profile?'目标读者（选填）':'*目标读者','audience',topic.audience,'text',hold || '例如：三年级孩子的家长')}${field('人设（选填）','persona',topic.persona,'text',hold || '例如：素人爸妈')}${field('口吻（选填）','tone',topic.tone,'text',hold || '例如：日常分享、具体不夸张')}${field('本篇课程名称','productName',topic.productName,'text',hold || '提及课程时必填')}${field('真实承接方式','bookingMethod',topic.bookingMethod,'text',hold || '写行动引导时必填，例如私信')}</div>
      ${area('本篇课程真实内容与特点','productFeatures',list(topic.productFeatures).join('，'),hold || '用逗号或换行分隔，只填写已确认的内容。')}
      ${area('真实素材／参考文案','materials',topic.materials,'需要使用的事实、经历、数据及其来源，或作为风格参考的文案。')}
      <div class="form-grid">${select('正文行动引导','cta',ctaOptions,topic.cta || profile?.defaultCta || 'none')}${field('内容形式','format',topic.format,'text','可留空，例如清单式分享')}${field('时间场景','season',topic.season,'text','可留空，例如日常学习')}</div>
    </details>`;
}
function render() {
  document.querySelectorAll('[data-view]').forEach(b => {b.classList.toggle('active', b.dataset.view === view); b.setAttribute('aria-current', b.dataset.view === view ? 'page' : 'false');});
  if (view === 'topics') renderTopics(); else if (view === 'workbench') renderWorkbench(); else renderHistory();
}
const nd = (name, fallback = '') => newTopicDraft[name] ?? fallback;
const filteredTopics = () => state.topics.filter(t => (topicFilter === 'all' ? t.status !== 'archived' : t.status === topicFilter) && `${t.title} ${t.idea}`.toLowerCase().includes(query.toLowerCase()));
function refreshTopicResults() {
  const box = $('#topic-results'); if (!box) return;
  const items = filteredTopics(); box.innerHTML = topicCards(items);
  const count = $('#topic-count'); if (count) count.textContent = items.length;
}
const defaultProfileId = () => {
  const recent = [...state.topics].sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt)).find(t => state.profiles.some(p => p.id === t.profileId));
  return recent?.profileId || state.profiles[0]?.id || '';
};
function newTopicFormHtml() {
  const hasProfiles = state.profiles.length > 0, pid = nd('profileId', defaultProfileId());
  const accountPick = hasProfiles ? `${select('*写给哪个账号','profileId',[...profileOptions(),['__new','＋ 新建账号']],pid)}<p class="small-label" id="nt-account-sum"></p>` : '';
  const newAccount = `<div id="nt-new-account" class="inline-guide" ${hasProfiles && pid === '__new' ? '' : hasProfiles ? 'hidden' : ''}>
    <h3>${hasProfiles ? '新建一个账号' : '先建一个账号，以后只需要选它'}</h3><p class="hint">只需要 2 项必填，其余可以以后在“账号管理”里慢慢补。</p>
    <div class="form-grid">${accountField(nd('accountType'),'例如：素人账号，也可以自己写')}${field('*目标读者','audience',nd('audience'),'text','例如：三年级孩子的家长')}${field('账号名称（选填）','newName',nd('newName'),'text','不填会自动命名，如 素人账号·三年级孩子的家长')}</div>
    <label class="checkbox"><input type="checkbox" name="saveAsProfile" ${nd('saveAsProfile', true) ? 'checked' : ''}>保存为账号，下次直接选用</label></div>`;
  const more = `<details><summary>更多选项（选填，不填则沿用账号设置）</summary>
    <div class="form-grid">${select('课程露出（选填）','exposure',[['','跟随账号默认'],...exposureOptions],nd('exposure'))}${select('正文行动引导（选填）','cta',[['','跟随账号默认'],...ctaOptions],nd('cta'))}${field('人设（选填）','persona',nd('persona'),'text','例如：素人爸妈')}${field('口吻（选填）','tone',nd('tone'),'text','例如：日常分享、具体不夸张')}${field('内容形式（选填）','format',nd('format'),'text','例如：清单式分享')}${field('时间场景（选填）','season',nd('season'),'text','例如：日常学习')}</div>
    ${area('真实素材或参考文案（选填）','materials',nd('materials'),'要用到的事实、经历、数据，或想参考的文案；不要编造经历、数据或课程效果。')}</details>`;
  const product = `<div id="nt-product" class="inline-guide" hidden><p class="why">因为你要提及课程，而这个账号还没有课程资料，请补充真实信息（也可以在“账号管理”里一次填好）。</p>${field('*课程或老师名称','productName',nd('productName'),'text','例如：数理思维试听课')}${area('*课程真实内容与特点','productFeatures',nd('productFeatures'),'用逗号或换行分隔，只填写已确认的内容。')}</div>
    <div id="nt-booking" class="inline-guide" hidden><p class="why">因为你要在正文里写行动引导，需要一个真实可用的承接方式。</p>${field('*真实承接方式','bookingMethod',nd('bookingMethod'),'text','例如：私信、评论区留言')}</div>`;
  return `<form id="new-topic-form">${accountPick}${newAccount}
    ${field('*选题或标题想法','title',nd('title'),'text','例如：3年级数学基础差怎么办')}${area('*你自己的核心想法','idea',nd('idea'),'先写你想强调什么，哪怕只有一句话。')}${select('这篇内容想达到什么目的','goal',[['分享干货','分享学习建议'],['引发讨论','引发家长讨论'],['建立课程兴趣','自然介绍课程'],['获取咨询','承接后续咨询']],nd('goal','分享干货'))}
    ${more}${product}
    <div class="button-row"><button class="primary" type="submit">保存并生成文案</button></div>
    <p class="small-label"><b class="req">必填</b> 为必须填写；<i class="opt">选填</i> 不填会沿用账号设置，不会编造内容。</p></form>`;
}
function syncNewTopicForm() {
  const form = $('#new-topic-form'); if (!form) return;
  const f = form.elements, pid = f.profileId?.value || '';
  const isNew = !state.profiles.length || pid === '__new', p = isNew ? null : state.profiles.find(x => x.id === pid);
  $('#nt-new-account').hidden = !isNew;
  const sum = $('#nt-account-sum');
  if (sum) sum.textContent = p ? [p.accountType, p.audience, p.persona, p.tone, p.product?.name ? `课程：${p.product.name}` : '还没有课程资料'].filter(Boolean).join(' · ') : '';
  const exposure = f.exposure.value || p?.defaultProductExposure || 'none', cta = f.cta.value || p?.defaultCta || 'none';
  $('#nt-product').hidden = exposure === 'none' || Boolean(p?.product?.name && list(p.product.features).length);
  $('#nt-booking').hidden = cta === 'none' || Boolean(p?.product?.bookingMethod || list(p?.handoffChannels).length);
}
function renderTopics() {
  const items = filteredTopics();
  main.innerHTML = `${heading('开始','新建一篇内容','选账号，写选题和想法，其余自动带入。','<button class="secondary" data-action="settings">账号管理</button>')}
    <section class="panel"><div class="section-title"><h2>新选题</h2><span class="eyebrow">从你出发</span></div>${newTopicFormHtml()}</section>
    <details class="section-gap" id="continue-writing" ${continueOpen ? 'open' : ''}><summary>继续写作（<span id="topic-count">${items.length}</span>）</summary><div class="filters"><input id="topic-search" aria-label="搜索选题" placeholder="搜索选题或想法" value="${esc(query)}"><select id="topic-filter" aria-label="筛选选题状态">${opts([['all','全部在用'],['pending','待写'],['writing','写作中'],['published','已发布'],['archived','暂不使用']],topicFilter)}</select></div><div class="topic-list" id="topic-results">${topicCards(items)}</div></details>`;
  syncNewTopicForm();
}
function topicCards(items) {
  return items.length ? items.map(t => `<article class="topic-item ${t.id === topicId?'selected':''}"><div class="topic-top"><button class="topic-title" data-action="open-topic" data-id="${esc(t.id)}">${esc(t.title)}</button>${badge(t.status)}</div><p>${esc(t.idea || '还没有补充想法')}</p><div class="meta"><span>${esc(state.profiles.find(p=>p.id===t.profileId)?.name || '')}</span><span>${esc(stamp(t.updatedAt || t.createdAt))}</span></div><div class="button-row"><button class="quiet" data-action="open-topic" data-id="${esc(t.id)}">进入写作 →</button><button class="quiet" data-action="archive-topic" data-id="${esc(t.id)}" ${state.runs.some(r=>r.topicId===t.id && r.status==='running')?'disabled':''}>${t.status==='archived'?'恢复使用':'暂不使用'}</button></div></article>`).join('') : '<div class="empty"><h3>这里等待你的想法</h3><p>保存一个选题，或调整筛选条件。</p></div>';
}
function contextStrip(topic) {
  const p = profileFor(topic) || {};
  const summary = [topic.accountType||p.accountType,topic.persona||p.persona,topic.audience||p.audience,topic.tone||p.tone,topic.exposure==='none'?'不提课程':topic.exposure==='focus'?'重点介绍课程':'自然提及课程',topic.cta==='none'?'正文不写行动引导':'正文允许行动引导'].filter(Boolean).join(' · ');
  return `<div class="context-strip"><div><strong>${esc(p.name || '本篇临时设置')}</strong><p>${esc(summary)}</p></div><button class="quiet" data-action="settings">管理账号</button></div>`;
}
function renderWorkbench() {
  const topic = activeTopic();
  if (!topic) { main.innerHTML = heading('02 / 内容工作台','从一个选题开始','完整稿、差异导读、修改与内容检查，在这里完成。') + '<div class="empty"><h3>还没有选题</h3><p>先写下你想表达的内容。</p><button class="primary" data-action="goto-topics">去创建选题</button></div>'; return; }
  const draft = selectedDraft(topic), busy = isBusy(), run = running(topic);
  const generation = runsFor(topic).find(r=>r.action==='generate' && r.status==='completed');
  const candidates = list(generation?.result?.draftIds).map(id=>state.drafts.find(d=>d.id===id)).filter(Boolean);
  const latest = runsFor(topic)[0];
  main.innerHTML = `${heading('02 / 内容工作台','把想法写成好内容','先看差异，选一稿，再修改到愿意使用。')}
    <div class="worktop">${select('当前选题','active-topic',state.topics.filter(t=>t.status!=='archived' || t.id===topicId).map(t=>[t.id,t.title]),topicId)}<button class="secondary" data-action="goto-history">查看版本记录 ↗</button></div>${contextStrip(topic)}
    ${run ? `<div class="run-note" role="status"><span class="spinner"></span>${esc(run.action==='generate'?'正在生成文案，通常一到三分钟':run.action==='review'?'正在检查当前版本':'正在按要求修改')}，输入和已有稿件会保留。已等待 <span id="run-elapsed">${elapsedText(run)}</span>。</div>` : ''}
    ${latest?.status==='failed' ? `<div class="warning-note" role="alert">上次操作未完成：${esc(latest.error)}。你的输入和已有稿件已保留，可以调整后重试。${['generate','review'].includes(latest.action) ? '<button class="secondary" type="button" data-action="retry" style="margin-left:10px" ' + (busy || !state.provider.ready ? 'disabled' : '') + '>重试</button>' : ''}</div>` : ''}
    ${!state.provider.ready ? '<div class="warning-note">模型尚未配置。可以先保存选题和账号，配置完成后再生成。</div>' : ''}
    <section class="panel"><div class="section-title"><h2>这次想写什么</h2><span class="hint">共同要求适用于所有候选稿</span></div><form id="topic-edit-form"><fieldset ${busy?'disabled':''}>${topicFields(topic)}<div class="button-row"><button class="secondary" type="submit" ${busy?'disabled':''}>保存输入</button><button class="primary" type="button" data-action="generate" ${busy || !state.provider.ready?'disabled':''}>${candidates.length?'重新生成':'生成文案'}</button></div></fieldset></form></section>
    ${preflightResult ? `<section class="panel preflight section-gap"><h3>先补充这些信息</h3><ul>${list(preflightResult.questions).map(q=>`<li>${esc(typeof q==='string'?q:q.question || q.message || JSON.stringify(q))}</li>`).join('')}</ul>${list(preflightResult.warnings).map(w=>`<p class="hint">${esc(w)}</p>`).join('')}<p class="hint">可在上方补充真实素材，或在账号管理中更新课程资料；调整后再生成。</p></section>` : ''}
    ${generation?.result?.differenceSummary ? `<div class="section-gap guide-summary"><h3>这两稿有什么区别</h3><p>${esc(typeof generation.result.differenceSummary === 'string' ? generation.result.differenceSummary : JSON.stringify(generation.result.differenceSummary || ''))}</p></div>` : ''}
    ${candidates.length ? `<div class="candidate-grid">${candidates.map((d,i)=>candidate(d,i,topic,busy)).join('')}</div>${candidates.length===1 ? `<div class="button-row section-gap"><button class="secondary" type="button" data-action="generate-more" ${busy || !state.provider.ready?'disabled':''}>再出一套不同角度的对比稿</button><span class="hint">不满意第一套时再生成，会避开它的切入角度。</span></div>` : ''}` : '<div class="empty section-gap"><h3>让你的想法先开个头</h3><p>真实生成后，完整稿会出现在这里；想对比时可再出一套。</p></div>'}
    ${draft ? editor(draft,topic,busy) : candidates.length ? '<p class="hint section-gap">选择一篇后，可以直接编辑、让 AI 定向修改，并检查当前版本。</p>' : ''}`;
}
function candidate(d,i,topic,busy) {
  return `<article class="panel candidate ${topic.selectedDraftId===d.id?'selected':''}"><div class="section-title"><span class="candidate-number">0${i+1}</span><span class="badge">${esc(d.angle || '候选稿')}</span></div><h3 class="draft-title">${esc(d.title)}</h3><div class="draft-body">${esc(d.body)}</div><div class="tags">${list(d.tags).map(t=>'#'+esc(t.replace(/^#/,''))).join(' ')}</div><details><summary>这篇是怎样写的</summary>${guide(d.guide)}</details><button class="${topic.selectedDraftId===d.id?'secondary':'primary'}" data-action="select-draft" data-id="${esc(d.id)}" ${busy?'disabled':''}>${topic.selectedDraftId===d.id?'当前选中':'选这篇继续修改'}</button><p class="small-label">AI 原稿保留在历史中；选择此稿会切换当前使用版本。</p></article>`;
}
function guide(g = {}) { return `<dl class="guide">${[['开头钩子',g.hook],['展开结构',g.structure],['课程衔接',g.productBridge],['适合需求',g.suitableFor]].map(([name,v])=>`<dt>${name}</dt><dd>${esc(Array.isArray(v)?v.join(' → '):v || '未提供')}</dd>`).join('')}</dl>`; }
function editor(d,topic,busy) {
  const review = state.reviews.filter(r=>r.draftId===d.id).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt))[0];
  const usable = ['approved','published'].includes(d.status) && topic.selectedDraftId===d.id;
  return `<div class="editor-layout"><section class="panel"><div class="section-title"><h2>当前稿件</h2><div class="button-row"><span class="hint">v${esc(d.version)}</span>${badge(d.status)}</div></div>
      <form id="draft-edit-form" data-id="${esc(d.id)}"><fieldset ${busy?'disabled':''}>${field('标题','title',d.title)}${area('正文','body',d.body,'','body-field')}${field('话题 tag','tags',list(d.tags).map(t=>'#'+t.replace(/^#/,'')).join(' '),'text','用空格分隔')}${field('修改备注（选填）','changeNote','','text','记录这次为什么修改')}
      <div class="button-row"><button class="secondary" ${busy?'disabled':''}>保存为新版本</button><button class="primary" type="button" data-action="review" ${busy || !state.provider.ready?'disabled':''}>${review?'重新检查当前稿':'检查当前稿'}</button></div><p class="small-label" id="edit-state">修改会保存为新版本，并需要重新检查。</p></fieldset></form>
      <div class="editor-toolbar"><div class="button-row"><button class="primary" data-action="copy" ${!usable || busy?'disabled':''}>复制整套文字</button><button class="secondary" data-action="export" data-format="txt" ${!usable || busy?'disabled':''}>导出 TXT</button><button class="quiet" data-action="export" data-format="md" ${!usable || busy?'disabled':''}>Markdown</button></div>${!usable?'<p class="small-label">当前选中版本内容检查通过后可复制和导出。</p>':''}</div>
    </section><aside><section class="panel"><div class="section-title"><h3>让 AI 帮你修改</h3><span class="eyebrow">只改需要的地方</span></div><form id="revise-form">
      ${select('修改范围','scope',[['all','整篇文案'],['title','只改标题'],['body','只改正文'],['tags','只改话题'],['selection','正文中选中的文字']],'all')}
      <div id="selected-text-box" class="selection-note" hidden></div>${area('这次怎么改','instruction','','例如：开头像普通家长说话；保留中间的干货，不加行动引导。')}
      <button class="primary" ${busy || !state.provider.ready?'disabled':''}>生成修改版</button><p class="small-label">可先在正文中选中一段，再指定修改。未保存的编辑会先另存为新版本。</p></form></section>
      <section class="panel review-box"><div class="section-title"><h3>当前版本内容检查</h3>${review?badge(review.verdict):''}</div>${review?reviewContent(review):'<p class="hint">选稿后发起内容检查，检查要求、写作质量和事实依据。</p>'}<p class="small-label">AI 辅助检查不等同于平台审核。待核验事实需要你确认。</p>${overrideBox(d,review,busy)}${review?`<button class="quiet" data-action="send-back" ${busy?'disabled':''}>标记需要继续修改</button>`:''}</section>
      ${usable?`<section class="panel section-gap"><h3>手动发布记录</h3><p class="hint">实际发布后再记录，不会自动发布。</p><form id="publication-form" class="section-gap">${field('发布位置','channel','小红书')}${field('笔记链接（选填）','url','','url','https://…')}${field('发布时间','publishedAt',localDateTime(),'datetime-local')}${area('备注（选填）','note')}<button class="secondary" ${busy?'disabled':''}>保存发布记录</button></form></section>`:''}</aside></div>`;
}
function overrideBox(d,review,busy) {
  if (!review || review.version!==d.version) return '';
  if (review.override) return `<p class="small-label">已于 ${esc(stamp(review.override.at))} 人工放行（你确认已核对提醒项），并非模型判定通过。`+'</p>';
  const items = list(review.findings);
  if (d.status!=='changes_requested' || items.some(x=>x.severity==='block') || !(items.some(x=>x.severity==='warn') || review.verdict==='verify')) return '';
  return `<div class="override-box"><p class="hint">没有阻断问题，只有提醒或待核验项。逐条核对后，你可以决定仍然使用这一版。放行会被记录，之后再修改会重新检查。</p><button class="secondary" data-action="override" ${busy?'disabled':''}>我已核对，仍然使用这一版</button></div>`;
}
function reviewContent(r) {
  return `<div class="review-summary">${list(r.strengths).map(s=>`<p class="hint">✓ ${esc(s)}</p>`).join('')}</div>${list(r.findings).length ? list(r.findings).map(f=>`<article class="finding"><span class="badge ${f.severity==='block'?'error':f.severity==='warn'?'warn':''}">${esc(f.type || '审查意见')}</span>${f.quote?`<blockquote>${esc(f.quote)}</blockquote>`:''}<p>${esc(f.reason)}</p>${f.suggestion?`<p class="suggestion">建议：${esc(f.suggestion)}</p>`:''}</article>`).join('') : '<p class="hint">本次检查未提出修改项。</p>'}`;
}
function localDateTime() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; }
function renderHistory() {
  const topic = activeTopic();
  const drafts = state.drafts.filter(d=>d.topicId===topic?.id).sort((a,b)=>b.version-a.version);
  if (!drafts.some(d=>d.id===historyId)) historyId = selectedDraft(topic)?.id || drafts[0]?.id || '';
  const d = drafts.find(d=>d.id===historyId), parent = drafts.find(p=>p.id===d?.parentId);
  main.innerHTML = `${heading('03 / 历史记录','每一次修改，都有来处','保留 AI 原稿、人工判断与内容检查结果。')}
    <div class="worktop">${select('选题','history-topic',state.topics.map(t=>[t.id,t.title]),topicId)}<button class="secondary" data-action="goto-workbench">回到工作台 →</button></div>
    ${drafts.length ? `<div class="history-grid"><section class="version-list">${drafts.map(v=>`<button class="version-button ${v.id===historyId?'selected':''}" data-action="history-version" data-id="${esc(v.id)}"><strong>v${esc(v.version)} · ${esc(labels[v.origin] || v.origin)}${v.id===topic.selectedDraftId?' / 当前稿':''}</strong><div class="meta">${esc(stamp(v.createdAt))}</div><div class="small-label">${esc(v.changeNote || '候选初稿')}</div>${badge(v.status)}</button>`).join('')}</section><section class="panel"><div class="section-title"><h2>v${esc(d.version)} ${d.origin==='ai'?'AI 稿件':'人工修订'}</h2>${badge(d.status)}</div><p class="hint">${esc(d.author || '')} · ${esc(stamp(d.createdAt))}</p><h3 class="draft-title">${esc(d.title)}</h3><div class="plain-preview">${esc(d.body)}</div><p class="tags">${list(d.tags).map(t=>'#'+esc(t.replace(/^#/,''))).join(' ')}</p>
      ${parent?`<details open><summary>与 v${esc(parent.version)} 比较</summary><p class="hint">绿色为新增，红色为删除；未变部分保留原色。</p><div class="diff-content">${diffText(parent,d)}</div></details>`:'<p class="hint">这是候选原稿，没有前一版本。</p>'}
      <details><summary>写作说明</summary>${d.parentId?'<p class="hint">此说明沿用候选原稿。修改后的文字可能与原说明不同，请结合正文判断。</p>':''}${guide(d.guide)}</details>
      <details><summary>这个版本的检查记录</summary>${state.reviews.filter(r=>r.draftId===d.id).map(r=>`<div class="record"><div class="section-title"><span>${esc(stamp(r.createdAt))}</span>${badge(r.verdict)}</div>${reviewContent(r)}</div>`).join('') || '<p class="hint">这个版本尚未检查。</p>'}</details>
      <details><summary>手动发布记录</summary>${state.publications.filter(p=>p.draftId===d.id).map(p=>`<div class="record"><strong>${esc(p.channel)}</strong> · ${esc(stamp(p.publishedAt))}<p>${esc(p.url)}</p><p>${esc(p.note)}</p></div>`).join('') || '<p class="hint">这个版本没有发布记录。</p>'}</details></section></div>` : '<div class="empty"><h3>还没有稿件版本</h3><p>真实生成或保存修改后，会在这里留下记录。</p><button class="primary" data-action="goto-workbench">进入工作台</button></div>'}
    ${topic ? `<section class="panel section-gap"><h3>模型运行记录</h3><p class="hint">实际调用的时间、结果与用量。失败不会自动替换成预置文案。</p>${runsFor(topic).map(r=>`<div class="record"><div class="button-row"><strong>${esc(r.action==='revise'?'修改文案':labels[r.action] || r.action)}</strong><span class="badge ${r.status==='failed'?'error':''}">${esc({running:'处理中',completed:'已完成',failed:'未完成'}[r.status])}</span><span class="hint">${esc(stamp(r.createdAt))}</span></div><p class="hint">${esc(r.model || '尚未返回模型')} ${r.durationMs?`· ${(r.durationMs/1000).toFixed(1)} 秒`:''}${r.usage?` · 用量 ${esc(typeof r.usage==='object'?JSON.stringify(r.usage):r.usage)}`:''}</p>${r.error?`<p>${esc(r.error)}</p>`:''}${r.requestId?`<p class="hint">调用编号：${esc(r.requestId)}</p>`:''}</div>`).join('') || '<p class="hint section-gap">尚无运行记录。</p>'}</section>`:''}`;
}
function diffText(before,after) {
  const combined = d => [d.title,...String(d.body).split('\n'),list(d.tags).join(' ')];
  const a = combined(before), b = combined(after);
  if (a.length*b.length>200000) return `<div class="diff-line remove">${esc(a.join('\n'))}</div><div class="diff-line add">${esc(b.join('\n'))}</div>`;
  const dp = Array.from({length:a.length+1},()=>new Uint16Array(b.length+1));
  for(let i=a.length-1;i>=0;i--) for(let j=b.length-1;j>=0;j--) dp[i][j]=a[i]===b[j]?dp[i+1][j+1]+1:Math.max(dp[i+1][j],dp[i][j+1]);
  let i=0,j=0,html='';
  while(i<a.length || j<b.length) {
    if(i<a.length && j<b.length && a[i]===b[j]) {html+=`<div class="diff-line">${esc(a[i]) || ' '}</div>`;i++;j++;}
    else if(j<b.length && (i===a.length || dp[i][j+1]>=dp[i+1][j])) html+=`<div class="diff-line add">+ ${esc(b[j++])}</div>`;
    else html+=`<div class="diff-line remove">− ${esc(a[i++])}</div>`;
  } return html;
}
function settings(id = profileFor()?.id || state.profiles[0]?.id || '') {
  const p = state.profiles.find(v=>v.id===id) || {}, product = p.product || {};
  const picker = state.profiles.length ? `<div class="profile-picker"><select id="profile-picker" aria-label="选择要编辑的账号">${opts([...profileOptions(),['','＋ 新建账号']],p.id || '')}</select></div>` : '<div class="inline-guide"><h3>先建第一个账号</h3><p class="hint">只需要填 2 项：账号身份和目标读者。之后新建内容时，直接在下拉里选账号名就行。</p></div>';
  $('#settings-content').innerHTML = `${picker}
    <form id="profile-form" data-id="${esc(p.id || '')}"><div class="form-grid">${accountField(p.accountType || '', '例如：素人账号，也可以自己写')}${field('*目标读者','audience',p.audience,'text','例如：三年级孩子的家长')}${field('账号名称（选填）','name',p.name,'text','不填会自动命名，如 素人账号·三年级孩子的家长','full')}</div>
    <details><summary>更多设置（选填，设一次以后都沿用）</summary><div class="form-grid">${field('人设（选填）','persona',p.persona,'text','例如：素人爸妈；或课程顾问／分享者')}${field('表达口吻（选填）','tone',p.tone,'text','例如：日常分享、具体不夸张')}${select('默认课程露出','defaultProductExposure',exposureOptions,p.defaultProductExposure || 'natural')}${select('默认正文引导','defaultCta',ctaOptions,p.defaultCta || 'none')}${field('实际承接渠道（选填）','handoffChannels',list(p.handoffChannels).join('，'),'text','评论、私信；不会自动写入正文','full')}${area('避开的表达（选填）','forbiddenTerms',list(p.forbiddenTerms).join('\n'),'用逗号或换行分隔；属于自己的写作限制，不代表平台词库。','full')}</div></details>
    <details><summary>这个账号推广的课程资料（选填，提及课程时才需要）</summary><div class="form-grid">${field('课程／老师','productName',product.name)}${field('适合年级／人群','productAgeRange',product.ageRange)}${field('授课形式','productFormat',product.format)}${field('费用说明','productPrice',product.price)}${area('真实内容与特点','productFeatures',list(product.features).join('\n'),'用逗号或换行分隔，只填写已确认的内容。','full')}${field('预约方式','productBookingMethod',product.bookingMethod,'text','仅作为资料保存，正文是否使用由引导设置决定。','full')}</div></details>
    <details><summary>真实经历与风格参考（选填）</summary>${area('已确认的亲身经历','experience',p.experience,'没有试听经历可以留空，模型不会自行编造。')}${area('参考文案','reference',p.reference,'用于参考口吻和结构，不作为未经核实的事实来源。')}</details><div class="sticky-actions button-row"><button class="primary" ${state.runs.some(r=>r.status==='running')?'disabled':''}>保存账号</button><span class="hint">账号里的内容新建文章时自动带入，单篇仍可临时调整。</span></div></form>`;
  const dialog = $('#settings-dialog'); if (!dialog.open) dialog.showModal();
}
function values(form) { return Object.fromEntries(new FormData(form)); }
function formChanged(form) {
  if (!form) return false;
  return [...form.elements].some(node => {
    if (!node.name || !['INPUT','TEXTAREA','SELECT'].includes(node.tagName)) return false;
    const initial = node.tagName==='SELECT' ? [...node.options].find(o=>o.defaultSelected)?.value || node.options[0]?.value || '' : node.defaultValue;
    return node.value !== initial;
  });
}
function topicChanged() { return formChanged($('#topic-edit-form')); }
function requireSavedTopic() { if (topicChanged()) throw new Error('选题或写作要求有未保存的修改，请先保存输入，再处理当前稿件。'); }
function allowLeave() {
  const dirty = ['topic-edit-form','draft-edit-form','revise-form','publication-form'].some(id=>formChanged($('#'+id)));
  return !dirty || window.confirm('有未保存的输入或修改。确定放弃这些修改并切换吗？');
}
async function saveTopic() {
  const form = $('#topic-edit-form'); if (!form) return activeTopic();
  const v = values(form);
  const result = await api(`/api/topics/${encodeURIComponent(topicId)}`, 'PATCH', {...v, productFeatures: words(v.productFeatures)});
  await load(false); return result.topic;
}
function editorChanged(d) {
  const form = $('#draft-edit-form'); if (!form) return false;
  const v = values(form); return v.title!==d.title || v.body!==d.body || JSON.stringify(tags(v.tags))!==JSON.stringify(list(d.tags).map(t=>t.replace(/^#/,'')));
}
async function saveEditor(force = false) {
  const d = selectedDraft(), form = $('#draft-edit-form');
  if (!d || !form || (!force && !editorChanged(d))) return d;
  const v = values(form); const result = await api(`/api/drafts/${encodeURIComponent(d.id)}/edit`,'POST',{...v,tags:tags(v.tags)});
  await load(false); return result.draft;
}
async function startAction(path,data = {}) { await api(path,'POST',data); await load(); poll(); }
async function generateForActiveTopic(more = false) {
  const check = await api(`/api/topics/${encodeURIComponent(topicId)}/preflight`,'POST',{});
  preflightResult = check.ready ? null : check;
  if (!check.ready) { render(); notify('请先补充影响真实性的信息。'); return; }
  await startAction(`/api/topics/${encodeURIComponent(topicId)}/generate`, more ? {more:true} : {});
}
async function poll() {
  if (polling) return; polling = true;
  try {
    while (state.runs.some(r=>r.status==='running')) {
      await new Promise(resolve=>setTimeout(resolve,2200));
      const previous = new Set(state.runs.filter(r=>r.status==='running').map(r=>r.id));
      await load(false);
      const finished = state.runs.filter(r=>previous.has(r.id) && r.status!=='running');
      if (finished.length) {
        const dirty = ['topic-edit-form','draft-edit-form','revise-form','publication-form'].some(id=>formChanged($('#'+id)));
        if (!dirty) render();
        finished.forEach(r=>{
          const failed = r.status==='failed', done = r.action==='generate'?(list(r.result?.draftIds).length>1?'第二套对比稿已生成':'文案已生成，可再出一套对比'):r.action==='review'?'内容检查已完成':'修改版已保存';
          notify(failed?r.error:(dirty?`${done}。保存或放弃当前修改后，切换一下选题即可看到结果。`:done),failed);
        });
      }
    }
  } catch (error) { notify(error.message,true); }
  finally { polling = false; }
}
async function checkProviderNow() {
  if (providerChecking || !state.provider.ready) { if (!state.provider.ready) notify(state.provider.error || '未找到模型配置。', true); return; }
  providerChecking = true; renderProviderStatus();
  try {
    const result = await api('/api/provider/check', 'POST', {});
    providerCheck = {ready:Boolean(result.ready), model:result.model, message:result.message, at:new Date().toISOString()};
  } catch (error) { providerCheck = {ready:false, message:error.message, at:new Date().toISOString()}; }
  finally { providerChecking = false; renderProviderStatus(); }
  notify(providerCheck.message || (providerCheck.ready ? '模型连接成功' : '模型连接失败'), !providerCheck.ready);
}
async function perform(task) {
  if (operationBusy) return; operationBusy = true;
  try { await task(); } catch (error) { notify(error.message,true); }
  finally { operationBusy = false; }
}

document.addEventListener('click', event => {
  if (event.target.closest('#provider-status')) { checkProviderNow(); return; }
  if (event.target.closest('#open-models')) { if (allowLeave()) openModels(); return; }
  const nav = event.target.closest('[data-view]'); if (nav) {if(nav.dataset.view===view || !allowLeave())return;view=nav.dataset.view;preflightResult=null;render();return;}
  const button = event.target.closest('[data-action]'); if (!button || button.disabled) return;
  const action = button.dataset.action, id = button.dataset.id;
  if (action==='settings') {if(!allowLeave())return;return settings();}
    if (action.startsWith('goto-')) {if(!allowLeave())return;view=action.replace('goto-','');render();return;}
  if (action==='open-topic') {if(!allowLeave())return;topicId=id;view='workbench';selectedText='';preflightResult=null;render();return;}
  if (action==='history-version') {historyId=id;renderHistory();return;}
  perform(async()=>{
    if (action==='archive-topic') {const t=state.topics.find(t=>t.id===id);await api(`/api/topics/${encodeURIComponent(id)}`,'PATCH',{status:t.status==='archived'?'pending':'archived'});await load();}
    if (action==='generate') {if(selectedDraft() && editorChanged(selectedDraft()))throw new Error('当前稿有未保存的修改，请先保存稿件再重新生成。');await saveTopic();await generateForActiveTopic();}
    if (action==='generate-more') {if(selectedDraft() && editorChanged(selectedDraft()))throw new Error('当前稿有未保存的修改，请先保存稿件再生成对比稿。');await saveTopic();await generateForActiveTopic(true);}
    if (action==='retry') {const last=runsFor()[0];if(last?.action==='review'){requireSavedTopic();const d=await saveEditor();await startAction(`/api/drafts/${encodeURIComponent(d.id)}/review`);}else{await saveTopic();await generateForActiveTopic(Boolean(last?.inputSnapshot?.existingDraftId));}}
    if (action==='select-draft') {if(!allowLeave())return;await api(`/api/drafts/${encodeURIComponent(id)}/select`,'POST',{});selectedText='';await load();$('#draft-edit-form')?.scrollIntoView({block:'start',behavior:'auto'});}
    if (action==='review') {requireSavedTopic();const d=await saveEditor();await startAction(`/api/drafts/${encodeURIComponent(d.id)}/review`);}
    if (action==='override') {requireSavedTopic();if(selectedDraft() && editorChanged(selectedDraft()))throw new Error('请先保存稿件修改，再放行。');if(!window.confirm('确认你已逐条核对提醒项，并决定仍然使用这一版？'))return;await api(`/api/drafts/${encodeURIComponent(selectedDraft().id)}/override`,'POST',{});await load();notify('已人工放行，可以复制和导出。');}
    if (action==='send-back') {requireSavedTopic();if(selectedDraft() && editorChanged(selectedDraft()))throw new Error('请先保存稿件修改，再标记需要修改。');await api(`/api/drafts/${encodeURIComponent(selectedDraft().id)}/send-back`,'POST',{});await load();}
    if (action==='refresh-models') { modelList = null; modelListError = ''; await loadModelList(); renderModelDialog(); return; }
    if (action==='reset-models') { await api('/api/settings/models', 'POST', { writingModel: '', checkingModel: '' }); await load(); renderModelDialog(); notify('已恢复为配置文件默认模型。'); return; }
    if (action==='copy' || action==='export') {requireSavedTopic();const d=selectedDraft();if(editorChanged(d)) throw new Error('稿件有未保存的修改，请先保存并重新检查。');if(!['approved','published'].includes(d.status)) throw new Error('请先完成当前稿件的内容检查。');if(action==='copy'){await navigator.clipboard.writeText(`${d.title}\n\n${d.body}\n\n${list(d.tags).map(t=>'#'+t.replace(/^#/,'')).join(' ')}`);notify('标题、正文和话题已复制。');}else{const res=await fetch(`/api/drafts/${encodeURIComponent(d.id)}/export?format=${button.dataset.format}`);if(!res.ok){const result=await res.json();throw new Error(result.error);}const url=URL.createObjectURL(await res.blob());const a=document.createElement('a');a.href=url;a.download=`小红书文案-v${d.version}.${button.dataset.format}`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}}
  });
});
document.addEventListener('submit',event=>{
  const form = event.target; event.preventDefault();
  perform(async()=>{
    if(form.id==='new-topic-form') {
      const v=values(form),isNew=!state.profiles.length||v.profileId==='__new';let profileId=isNew?'':v.profileId||'';
      const {saveAsProfile,newName,...fields}=v;
      if(isNew){
        if(!v.accountType?.trim()||!v.audience?.trim())throw new Error('请先填写账号身份和目标读者。');
        if(saveAsProfile==='on'){
          const saved=await api('/api/profiles','POST',{name:newName,accountType:v.accountType,audience:v.audience,persona:v.persona,tone:v.tone,defaultCta:v.cta||'none',defaultProductExposure:v.exposure||'none',product:{name:v.productName,features:words(v.productFeatures),bookingMethod:v.bookingMethod}});
          profileId=saved.profile.id;newTopicDraft={profileId};
        }
      } else { delete fields.accountType; delete fields.audience; }
      const result=await api('/api/topics','POST',{...fields,productFeatures:words(v.productFeatures),profileId});
      topicId=result.topic.id;view='workbench';newTopicDraft=profileId?{profileId}:{};preflightResult=null;await load();
      if(!state.provider.ready){notify('已保存。模型尚未配置，配置完成后再生成。');return;}
      notify('已保存，正在生成两套文案。');await generateForActiveTopic();
    }
    if(form.id==='topic-edit-form') {if(selectedDraft() && editorChanged(selectedDraft()))throw new Error('当前稿有未保存的修改，请先保存稿件，再保存写作输入。');await saveTopic();preflightResult=null;render();notify('输入已保存。');}
    if(form.id==='profile-form') {const v=values(form);await api('/api/profiles','POST',{...(form.dataset.id?{id:form.dataset.id}:{}),name:v.name,accountType:v.accountType,persona:v.persona,audience:v.audience,tone:v.tone,forbiddenTerms:words(v.forbiddenTerms),handoffChannels:words(v.handoffChannels),defaultCta:v.defaultCta,defaultProductExposure:v.defaultProductExposure,product:{name:v.productName,ageRange:v.productAgeRange,format:v.productFormat,price:v.productPrice,features:words(v.productFeatures),bookingMethod:v.productBookingMethod},experience:v.experience,reference:v.reference});$('#settings-dialog').close();await load();notify('账号已保存。');}
    if(form.id==='draft-edit-form') {if(!editorChanged(selectedDraft())){notify('内容没有变化，无需创建新版本。');return;}const pending=topicChanged()?values($('#topic-edit-form')):null;await saveEditor(true);selectedText='';render();if(pending)Object.entries(pending).forEach(([key,value])=>{const control=$('#topic-edit-form').elements.namedItem(key);if(control)control.value=value;});notify('修改已另存为新版本，请重新检查。');}
    if(form.id==='revise-form') {requireSavedTopic();const v=values(form),selection=selectedText;if(!v.instruction.trim())throw new Error('请填写这次修改要求。');if(v.scope==='selection' && !selection)throw new Error('请先在正文中选中需要修改的文字。');const d=await saveEditor();await startAction(`/api/drafts/${encodeURIComponent(d.id)}/revise`,{instruction:v.instruction,scope:v.scope,selectedText:v.scope==='selection'?selection:''});selectedText='';}
    if(form.id==='model-form') { const v = values(form); await api('/api/settings/models', 'POST', { writingModel: v.writingModel, checkingModel: v.checkingModel }); await load(); $('#models-dialog').close(); notify('模型已保存，下次生成和检查生效。'); return; }
    if(form.id==='publication-form') {requireSavedTopic();if(editorChanged(selectedDraft()))throw new Error('有未保存的修改，请先保存并重新检查。');const v=values(form);await api(`/api/drafts/${encodeURIComponent(selectedDraft().id)}/publish`,'POST',{...v,publishedAt:v.publishedAt?new Date(v.publishedAt).toISOString():''});await load();notify('手动发布记录已保存。');}
  });
});
document.addEventListener('change',event=>{
  if(['active-topic','history-topic'].includes(event.target.name)){if(!allowLeave()){event.target.value=topicId;return;}topicId=event.target.value;historyId='';preflightResult=null;selectedText='';render();}
  if(event.target.closest('#new-topic-form')){trackNewTopic(event);syncNewTopicForm();}
  if(event.target.id==='topic-filter'){topicFilter=event.target.value;refreshTopicResults();}
  if(event.target.id==='profile-picker'){if(formChanged($('#profile-form')) && !window.confirm('账号设置有未保存的修改，确定放弃并切换吗？')){event.target.value=$('#profile-form').dataset.id;return;}settings(event.target.value);}
  if(event.target.name==='scope'){const box=$('#selected-text-box');box.hidden=event.target.value!=='selection';box.textContent=selectedText || '先在左侧正文里选中一段文字。';}
});
document.addEventListener('input',event=>{
  if(event.target.closest('#new-topic-form'))trackNewTopic(event);
  if(event.target.id==='topic-search'){query=event.target.value;refreshTopicResults();}
  if(event.target.closest('#draft-edit-form')) {const dirty=editorChanged(selectedDraft());$('#edit-state').textContent=dirty?'有未保存的修改。保存后需重新检查。':'修改会保存为新版本，并需要重新检查。';document.querySelectorAll('[data-action="copy"],[data-action="export"]').forEach(b=>b.disabled=dirty || !['approved','published'].includes(selectedDraft().status));}
});
function trackNewTopic(event){const t=event.target;if(t.name)newTopicDraft[t.name]=t.type==='checkbox'?t.checked:t.value;}
document.addEventListener('toggle',event=>{if(event.target.id==='continue-writing')continueOpen=event.target.open;},true);
function captureSelection(event){if(event.target.matches('#draft-edit-form textarea[name="body"]')){const node=event.target;const text=node.value.slice(node.selectionStart,node.selectionEnd);if(text){selectedText=text;const box=$('#selected-text-box');box.textContent=selectedText;box.hidden=false;$('#revise-form [name="scope"]').value='selection';}}}
document.addEventListener('mouseup',captureSelection);document.addEventListener('keyup',captureSelection);document.addEventListener('select',captureSelection);
$('#open-settings').addEventListener('click',()=>{if(allowLeave())settings();});
function closeSettings(event){if(formChanged($('#profile-form')) && !window.confirm('账号设置有未保存的修改，确定关闭并放弃吗？')){event?.preventDefault();return;}$('#settings-dialog').close();$('#settings-content').replaceChildren();}
$('#close-models').addEventListener('click',()=>$('#models-dialog').close());
$('#models-dialog').addEventListener('cancel',()=>{});
$('#close-settings').addEventListener('click',closeSettings);$('#settings-dialog').addEventListener('cancel',closeSettings);
window.addEventListener('beforeunload',event=>{if(newTopicDraft.title||newTopicDraft.idea||['topic-edit-form','draft-edit-form','profile-form','revise-form'].some(id=>formChanged($('#'+id)))){event.preventDefault();event.returnValue='';}});
load().catch(error=>{main.innerHTML='<div class="empty"><h3>暂时无法读取工作台</h3><p>请检查本地服务，然后刷新页面。已有内容不会丢失。</p></div>';notify(error.message,true);});
