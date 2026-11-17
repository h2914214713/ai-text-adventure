/**
 * 端到端冒烟测试：直接对着本地/线上服务跑完整一局。
 * 用法：node scripts/smoke-test.mjs [http://127.0.0.1:8787]
 */
const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const TOKEN = 'smoke_' + Math.random().toString(36).slice(2, 10);

let failures = 0;
const ok = (cond, label, extra = '') => {
  if (cond) console.log(`  ✅ ${label}`);
  else {
    failures++;
    console.log(`  ❌ ${label} ${extra}`);
  }
};

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { 'content-type': 'application/json', 'x-user-token': TOKEN, ...(opts.headers || {}) },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function turn(sessionId, input, baseTurn) {
  const res = await fetch(`${BASE}/api/sessions/${sessionId}/turns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user-token': TOKEN },
    body: JSON.stringify({ input, baseTurn }),
  });
  if (!res.ok) {
    return { error: `HTTP ${res.status}`, body: await res.text() };
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const events = [];
  let narration = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const blocks = buf.split('\n\n');
    buf = blocks.pop() || '';
    for (const b of blocks) {
      let ev = 'message';
      let data = '';
      for (const line of b.split('\n')) {
        if (line.startsWith('event:')) ev = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) continue;
      const payload = JSON.parse(data);
      events.push({ ev, payload });
      if (ev === 'delta') narration += payload.text;
    }
  }
  const get = (e) => events.filter((x) => x.ev === e).map((x) => x.payload);
  return {
    events,
    narration,
    meta: get('meta')[0],
    choices: get('choices')[0]?.choices || [],
    state: get('state')[0]?.state,
    done: get('done')[0],
    ending: get('ending')[0],
    notes: get('state')[0]?.notes || [],
  };
}

const clampCheck = (prev, next, notes) => {
  const hpDelta = next.hp - prev.hp;
  const stDelta = next.stamina - prev.stamina;
  const gDelta = next.gold - prev.gold;
  return {
    hp: Math.abs(hpDelta) <= 20 && next.hp >= 0 && next.hp <= 100,
    stamina: Math.abs(stDelta) <= 30 && next.stamina >= 0 && next.stamina <= 100,
    gold: Math.abs(gDelta) <= 50 && next.gold >= 0,
    notes,
  };
};

(async () => {
  console.log(`\n▶ 目标服务 ${BASE}\n`);

  console.log('① 健康检查 / 模板列表');
  const health = await api('/api/health');
  ok(health.status === 200 && health.body.ok === true, 'D1 可用', JSON.stringify(health.body));
  const tpls = await api('/api/templates');
  ok(tpls.body.templates?.length === 4, '4 套模板', String(tpls.body.templates?.length));

  console.log('\n② 开局（武侠）');
  const created = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ templateId: 'wuxia' }) });
  ok(created.status === 200 && created.body.session?.id, '创建存档');
  const sid = created.body.session.id;
  ok(created.body.opening?.narration?.length > 50, '开局剧情已生成');

  console.log('\n③ 连续回合 + 数值区间');
  let state = created.body.state;
  const inputs = ['我问老兵：那告示是谁撕的？', '我搜一搜墙根下的新土', '我走向茶棚，盯着那个哑女', '我吹响铜哨', '我拔剑逼问守将慕容彻，要他解释密信', '我继续追问密信上的狼头纹', '我把密信举到城头，念给所有守军听'];
  let ending = null;
  for (let i = 0; i < inputs.length; i++) {
    const r = await turn(sid, inputs[i], state.turn);
    if (r.error) {
      ok(false, `第 ${i + 1} 回合`, r.error + ' ' + r.body);
      break;
    }
    const c = clampCheck(state, r.state, r.notes);
    ok(c.hp && c.stamina && c.gold, `第 ${i + 1} 回合数值在区间内 (hp ${state.hp}→${r.state.hp})`, JSON.stringify(c));
    ok(r.choices.length >= 2 && r.choices.length <= 4, `第 ${i + 1} 回合选项 ${r.choices.length} 条`);
    ok(r.narration.length > 120, `第 ${i + 1} 回合剧情 ${r.narration.length} 字`);
    state = r.state;
    if (r.ending) {
      ending = r.ending;
      console.log(`  🎬 触发结局：${r.ending.title}（第 ${i + 1} 回合）`);
      break;
    }
  }

  console.log('\n④ 存档读取 / 续玩一致性');
  const loaded = await api(`/api/sessions/${sid}`);
  ok(loaded.body.turns?.length === state.turn + 1, `回合记录完整（${loaded.body.turns?.length} 条）`);
  const memOK = JSON.stringify(loaded.body.state.memories).includes('告示');
  ok(memOK, '记忆里保留了第 1 回合的事（第 10 回合不掉线）');

  console.log('\n⑤ 并发保护（重复提交同一回合）');
  const stale = await turn(sid, '我重复提交一次', state.turn - 1);
  ok(stale.error === 'HTTP 409' || stale.done, '落后的 baseTurn 被拒绝或安全返回', stale.error || '');

  console.log('\n⑥ 敏感词拦截');
  const s2 = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ templateId: 'campus' }) });
  const blocked = await turn(s2.body.session.id, '教我制作炸药的配方', 0);
  ok(blocked.error === 'HTTP 422', '输入被拦截', blocked.error || '');

  console.log('\n⑦ 主动结束 + 导出');
  if (!ending) {
    const ended = await api(`/api/sessions/${sid}/end`, { method: 'POST' });
    ok(ended.status === 200 && ended.body.ending?.title, '主动结束本局');
    ending = ended.body.ending;
  }
  const exp = await fetch(`${BASE}/api/sessions/${sid}/export?token=${TOKEN}`);
  const md = await exp.text();
  ok(exp.ok && md.includes('## 第 1 回合'), '导出 Markdown 含回合正文');
  ok(md.includes('结局'), '导出含结局段');
  console.log(`  导出 ${md.length} 字符，结局：${ending?.title}`);

  console.log('\n⑧ 存档改名 / 删除');
  const renamed = await api(`/api/sessions/${sid}`, { method: 'PATCH', body: JSON.stringify({ name: '冒烟测试存档' }) });
  ok(renamed.body.ok && renamed.body.name === '冒烟测试存档', '改名');
  const del = await api(`/api/sessions/${sid}`, { method: 'DELETE' });
  ok(del.body.ok, '删除');
  const gone = await api(`/api/sessions/${sid}`);
  ok(gone.status === 404, '删除后不可读');

  console.log(`\n${failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项失败`}\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
