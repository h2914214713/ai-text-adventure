import { TEMPLATES, getTemplate } from './templates';
import {
  initialState,
  settleState,
  matchEnding,
  normalizeChoices,
  mergeKnownNames,
  pushMemory,
} from './engine';
import { checkInput, filterOutput } from './safety';
import { buildSystemPrompt, buildTurnMessages } from './prompt';
import { llmReady, streamChat, chatOnce, extractJson, createNarrationExtractor } from './llm';
import { offlineTurn, fallbackTurn } from './storyteller';
import { exportMarkdown } from './markdown';
import type { ModelTurn, State, Template } from './types';

interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  LLM_API_KEY?: string;
  LLM_BASE_URL?: string;
  LLM_MODEL?: string;
  LLM_PROVIDER?: string;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

const err = (message: string, status = 400, extra: Record<string, unknown> = {}) =>
  json({ error: message, ...extra }, status);

const now = () => Date.now();
const uid = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/* ------------------------------------------------------------------ */
/* 用户                                                                */
/* ------------------------------------------------------------------ */

async function ensureUser(env: Env, request: Request): Promise<{ id: string; token: string } | null> {
  const token = request.headers.get('x-user-token') || new URL(request.url).searchParams.get('token') || '';
  if (!token || token.length < 8) return null;
  const found = await env.DB.prepare('SELECT id, token FROM user WHERE token = ?').bind(token).first<any>();
  if (found) return { id: found.id, token: found.token };
  const id = uid('u');
  // 并发首访时用 OR IGNORE 兜住唯一索引冲突，再回读一次
  await env.DB.prepare('INSERT OR IGNORE INTO user (id, type, token, created_at) VALUES (?, ?, ?, ?)')
    .bind(id, 'anonymous', token, now())
    .run();
  const again = await env.DB.prepare('SELECT id, token FROM user WHERE token = ?').bind(token).first<any>();
  if (!again) return null;
  return { id: again.id, token: again.token };
}

/* ------------------------------------------------------------------ */
/* 模板                                                                */
/* ------------------------------------------------------------------ */

/** 模板写入数据库（story_template 表），保持"模板配置落库"的设计 */
async function ensureTemplates(env: Env) {
  const row = await env.DB.prepare('SELECT COUNT(*) AS c FROM story_template').first<any>();
  if (row && row.c >= TEMPLATES.length) return;
  for (const t of TEMPLATES) {
    await env.DB.prepare(
      `INSERT INTO story_template (id, title, worldview, initial_state, endings, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, worldview = excluded.worldview,
         initial_state = excluded.initial_state, endings = excluded.endings, updated_at = excluded.updated_at`
    )
      .bind(t.id, t.title, t.worldview, JSON.stringify(t.initialState), JSON.stringify(t.endings), now())
      .run();
  }
}

function publicTemplate(t: Template) {
  return {
    id: t.id,
    title: t.title,
    subtitle: t.subtitle,
    tag: t.tag,
    accent: t.accent,
    worldview: t.worldview,
    goal: t.goal,
    npcs: t.npcs,
    items: t.itemPool,
    initialState: {
      hp: t.initialState.hp,
      gold: t.initialState.gold,
      stamina: t.initialState.stamina,
      location: t.initialState.location,
    },
  };
}

/* ------------------------------------------------------------------ */
/* 存档                                                                */
/* ------------------------------------------------------------------ */

async function loadSession(env: Env, id: string, userId: string) {
  return env.DB.prepare('SELECT * FROM game_session WHERE id = ? AND user_id = ?').bind(id, userId).first<any>();
}

async function loadTurns(env: Env, sessionId: string) {
  const res = await env.DB.prepare(
    'SELECT turn_no, player_input, ai_raw, state_after, degraded, created_at FROM game_turn WHERE session_id = ? ORDER BY turn_no ASC LIMIT 200'
  )
    .bind(sessionId)
    .all<any>();
  return res.results || [];
}

/* ------------------------------------------------------------------ */
/* SSE 工具                                                            */
/* ------------------------------------------------------------------ */

function sseResponse(run: (send: (event: string, data: unknown) => Promise<void>) => Promise<void>) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const send = async (event: string, data: unknown) => {
    await writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  };
  (async () => {
    try {
      await run(send);
    } catch (e: any) {
      await send('error', { message: String(e?.message || e) }).catch(() => {});
    } finally {
      await writer.close().catch(() => {});
    }
  })();
  return new Response(readable, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 把整段文本切成小块推给前端，模拟逐字显示（离线模式 / 兜底文案用） */
async function streamText(text: string, send: (e: string, d: unknown) => Promise<void>, size = 4, gap = 14) {
  for (let i = 0; i < text.length; i += size) {
    await send('delta', { text: text.slice(i, i + size) });
    if (gap) await sleep(gap);
  }
}

/* ------------------------------------------------------------------ */
/* 回合主流程                                                          */
/* ------------------------------------------------------------------ */

function validateModelTurn(obj: any): { ok: boolean; reason?: string } {
  if (!obj || typeof obj !== 'object') return { ok: false, reason: '不是对象' };
  for (const k of ['scene', 'narration', 'choices', 'state_delta']) {
    if (!(k in obj)) return { ok: false, reason: `缺少字段 ${k}` };
  }
  if (typeof obj.narration !== 'string' || obj.narration.trim().length < 20)
    return { ok: false, reason: 'narration 过短' };
  if (typeof obj.scene !== 'string' || !obj.scene.trim()) return { ok: false, reason: 'scene 为空' };
  if (!Array.isArray(obj.choices)) return { ok: false, reason: 'choices 不是数组' };
  if (!('ending' in obj)) return { ok: false, reason: '缺少字段 ending' };
  for (const c of obj.new_characters || []) {
    if (!c?.name) return { ok: false, reason: '新角色缺少名字' };
    if (!c?.role || String(c.role).trim().length < 2)
      return { ok: false, reason: `新角色「${c.name}」缺少身份描述` };
  }
  return { ok: true };
}

async function handleTurn(env: Env, request: Request, sessionId: string, userId: string) {
  const body: any = await request.json().catch(() => ({}));
  const input = String(body.input || '').trim().slice(0, 200);
  const baseTurn = Number.isFinite(body.baseTurn) ? Number(body.baseTurn) : -1;

  const session = await loadSession(env, sessionId, userId);
  if (!session) return err('存档不存在', 404);
  const template = getTemplate(session.template_id);
  if (!template) return err('模板不存在', 404);

  let state: State = JSON.parse(session.state_json);

  if (session.status === 'ended') return err('本局已结束', 409, { latest: state });
  if (!input) return err('行动不能为空', 400);
  if (input.length > 200) return err('行动太长了（最多 200 字）', 400);

  // 乐观并发：客户端认为的回合数落后于服务端 → 让它重新同步，避免重复推进
  if (baseTurn >= 0 && baseTurn < state.turn) {
    return err('进度已更新，请重新同步', 409, { latest: state, serverTurn: state.turn });
  }

  const safe = checkInput(input);
  if (!safe.ok) {
    return err(`这句话涉及「${safe.category}」，换个说法吧`, 422, { blocked: true });
  }

  const history = (await loadTurns(env, sessionId))
    .filter((r) => r.turn_no > 0)
    .map((r) => {
      let n = '';
      try {
        n = JSON.parse(r.ai_raw)?.narration || '';
      } catch {
        n = '';
      }
      return { turn: r.turn_no, input: r.player_input, narration: n };
    });

  const useLlm = llmReady(env);

  return sseResponse(async (send) => {
    const turnNo = state.turn + 1;
    await send('meta', {
      turn: turnNo,
      sessionId,
      scene: state.scene || state.location,
      state,
      engine: useLlm ? 'llm' : 'offline',
    });

    let payload: ModelTurn | null = null;
    let degraded = false;
    let rawText = '';
    let streamedNarration = '';

    if (!useLlm) {
      // 离线引擎：直接产出结构化结果，再模拟流式输出
      payload = offlineTurn(template, state, input);
    } else {
      const sys = buildSystemPrompt(template);
      const { user } = buildTurnMessages(template, state, history, input);
      const messages = [
        { role: 'system' as const, content: sys },
        { role: 'user' as const, content: user },
      ];

      try {
        const extractor = createNarrationExtractor();
        rawText = await streamChat(env, messages, (delta) => {
          const piece = extractor(delta);
          if (piece) {
            streamedNarration += piece;
            const f = filterOutput(piece);
            void send('delta', { text: f.text });
          }
        });

        const parsed = extractJson(rawText);
        const check = validateModelTurn(parsed);
        if (check.ok) {
          payload = parsed;
        } else {
          // 第一次不合格：补一句纠错要求后重试一次（非流式），成功后用 replace 覆盖已显示内容
          await send('status', { phase: 'retry', reason: check.reason });
          const retryMessages = [
            ...messages,
            { role: 'assistant' as const, content: (rawText || '').slice(0, 1500) || '（未输出）' },
            {
              role: 'user' as const,
              content: `你上一次的输出不合格：${check.reason}。请严格只输出一个 JSON 对象，必须包含 scene、narration、choices、state_delta、ending 五个字段（没有结局时 ending 必须是 null），不要任何解释文字。`,
            },
          ];
          const retry = await chatOnce(env, retryMessages);
          const parsed2 = extractJson(retry);
          const check2 = validateModelTurn(parsed2);
          if (check2.ok) {
            payload = parsed2;
            rawText = retry;
            await send('replace', { text: filterOutput(parsed2.narration).text });
          } else {
            degraded = true;
            payload = fallbackTurn(template, state, input);
            await send('replace', { text: filterOutput(payload.narration).text });
          }
        }
      } catch (e: any) {
        degraded = true;
        payload = fallbackTurn(template, state, input);
        await send('status', { phase: 'degraded', reason: String(e?.message || e).slice(0, 120) });
        await send('replace', { text: filterOutput(payload.narration).text });
      }
    }

    // 离线模式：模拟逐字输出
    if (!useLlm && payload) {
      const f = filterOutput(payload.narration);
      await streamText(f.text, send);
    }

    const filteredNarration = filterOutput(payload!.narration).text;

    // ---- 结算 ----
    const notes: string[] = [];
    let next = settleState(template, state, payload!.state_delta || {}, notes);
    next.turn = turnNo;
    next.scene = payload!.scene;
    next = mergeKnownNames(next, template, (payload as any).new_characters || []);
    next = pushMemory(next, `在${next.location}，玩家「${input.slice(0, 40)}」，${payload!.scene}`);

    const choices = normalizeChoices(payload!.choices);
    await send('choices', { choices });

    // ---- 结局判定 ----
    let ending: { id?: string; title: string; text: string; type?: string } | null = matchEnding(template, next);
    if (!ending && (payload as any).ending && next.turn >= 5) {
      const e = (payload as any).ending;
      if (e && typeof e.title === 'string' && typeof e.text === 'string') {
        ending = { title: e.title, text: e.text, type: e.type || 'neutral' };
      }
    }
    if (ending) {
      next.hp = Math.max(0, next.hp);
    }

    await send('state', { state: next, notes, delta: payload!.state_delta || {} });

    // ---- 落库 ----
    const rawToStore = JSON.stringify({
      scene: payload!.scene,
      narration: filteredNarration,
      choices,
      state_delta: payload!.state_delta,
      ending: (payload as any).ending ?? null,
      degraded,
    });

    await env.DB.prepare(
      'INSERT OR REPLACE INTO game_turn (id, session_id, turn_no, player_input, ai_raw, state_after, degraded, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
      .bind(uid('t'), sessionId, turnNo, input, rawToStore, JSON.stringify(next), degraded ? 1 : 0, now())
      .run();

    await env.DB.prepare(
      'UPDATE game_session SET state_json = ?, version = version + 1, status = ?, ending_json = ?, updated_at = ? WHERE id = ?'
    )
      .bind(JSON.stringify(next), ending ? 'ended' : 'playing', ending ? JSON.stringify(ending) : null, now(), sessionId)
      .run();

    if (ending) await send('ending', ending);
    await send('done', { turn: turnNo, state: next, degraded, ending });
  });
}

/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (!path.startsWith('/api/')) return env.ASSETS.fetch(request);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { 'access-control-allow-headers': '*' } });
    }

    try {
      // 健康检查
      if (path === '/api/health') {
        let dbOk = false;
        try {
          const r = await env.DB.prepare('SELECT 1 AS ok').first<any>();
          dbOk = !!r?.ok;
        } catch {
          dbOk = false;
        }
        return json({
          ok: dbOk,
          engine: llmReady(env) ? env.LLM_MODEL || 'llm' : 'offline',
          providers: { deepseek: 'https://api.deepseek.com', qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
          time: now(),
        });
      }

      const user = await ensureUser(env, request);
      if (!user) return err('缺少用户标识（x-user-token）', 401);

      // GET /api/templates
      if (path === '/api/templates' && request.method === 'GET') {
        await ensureTemplates(env);
        return json({ templates: TEMPLATES.map(publicTemplate) });
      }

      // POST /api/sessions
      if (path === '/api/sessions' && request.method === 'POST') {
        const body: any = await request.json().catch(() => ({}));
        const t = getTemplate(String(body.templateId || ''));
        if (!t) return err('模板不存在', 404);
        await ensureTemplates(env);

        const state = initialState(t);
        state.scene = t.opening.scene;
        state.location = t.opening.scene;
        state.memories = [{ turn: 0, text: `开局在${t.opening.scene}` }];

        const id = uid('s');
        const name = String(body.name || `${t.title}·第${Math.floor(Math.random() * 900 + 100)}局`).slice(0, 40);
        const ts = now();
        await env.DB.prepare(
          'INSERT INTO game_session (id, user_id, template_id, name, state_json, version, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)'
        )
          .bind(id, user.id, t.id, name, JSON.stringify(state), 'playing', ts, ts)
          .run();

        // 开局作为第 0 回合落库，方便导出与复盘
        await env.DB.prepare(
          'INSERT INTO game_turn (id, session_id, turn_no, player_input, ai_raw, state_after, degraded, created_at) VALUES (?, ?, 0, ?, ?, ?, 0, ?)'
        )
          .bind(
            uid('t'),
            id,
            '（开局）',
            JSON.stringify({ scene: t.opening.scene, narration: t.opening.narration, choices: t.opening.choices }),
            JSON.stringify(state),
            ts
          )
          .run();

        return json({
          session: { id, name, templateId: t.id, status: 'playing', turn: 0 },
          template: publicTemplate(t),
          state,
          opening: t.opening,
          turns: [
            {
              turnNo: 0,
              input: '（开局）',
              scene: t.opening.scene,
              narration: t.opening.narration,
              choices: t.opening.choices,
              state,
              degraded: false,
            },
          ],
        });
      }

      // GET /api/sessions —— 存档列表
      if (path === '/api/sessions' && request.method === 'GET') {
        const res = await env.DB.prepare(
          `SELECT s.id, s.name, s.template_id, s.status, s.state_json, s.ending_json, s.updated_at, s.created_at,
                  (SELECT COUNT(*) FROM game_turn g WHERE g.session_id = s.id) - 1 AS turns
           FROM game_session s WHERE s.user_id = ? ORDER BY s.updated_at DESC LIMIT 50`
        )
          .bind(user.id)
          .all<any>();
        const sessions = (res.results || []).map((r) => {
          const st = JSON.parse(r.state_json);
          return {
            id: r.id,
            name: r.name,
            templateId: r.template_id,
            templateTitle: getTemplate(r.template_id)?.title || r.template_id,
            status: r.status,
            turns: Math.max(0, r.turns || 0),
            hp: st.hp,
            gold: st.gold,
            stamina: st.stamina,
            location: st.location,
            endingTitle: r.ending_json ? JSON.parse(r.ending_json)?.title : null,
            updatedAt: r.updated_at,
            createdAt: r.created_at,
          };
        });
        return json({ sessions });
      }

      const m = path.match(/^\/api\/sessions\/([^/]+)(\/[a-z]+)?$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        const action = m[2] || '';
        const session = await loadSession(env, id, user.id);
        if (!session) return err('存档不存在', 404);
        const template = getTemplate(session.template_id)!;

        // GET /api/sessions/{id}
        if (!action && request.method === 'GET') {
          const turns = await loadTurns(env, id);
          return json({
            session: {
              id: session.id,
              name: session.name,
              templateId: session.template_id,
              status: session.status,
              version: session.version,
              createdAt: session.created_at,
              updatedAt: session.updated_at,
            },
            template: publicTemplate(template),
            state: JSON.parse(session.state_json),
            ending: session.ending_json ? JSON.parse(session.ending_json) : null,
            turns: turns.map((t) => {
              let p: any = {};
              try {
                p = JSON.parse(t.ai_raw);
              } catch {
                p = { narration: t.ai_raw };
              }
              return {
                turnNo: t.turn_no,
                input: t.player_input,
                scene: p.scene || '',
                narration: p.narration || '',
                choices: p.choices || [],
                state: JSON.parse(t.state_after),
                degraded: !!t.degraded,
              };
            }),
          });
        }

        // PATCH /api/sessions/{id} —— 改名
        if (!action && request.method === 'PATCH') {
          const body: any = await request.json().catch(() => ({}));
          const name = String(body.name || '').trim().slice(0, 40);
          if (!name) return err('名字不能为空', 400);
          await env.DB.prepare('UPDATE game_session SET name = ?, updated_at = ? WHERE id = ?')
            .bind(name, now(), id)
            .run();
          return json({ ok: true, name });
        }

        // DELETE /api/sessions/{id}
        if (!action && request.method === 'DELETE') {
          await env.DB.prepare('DELETE FROM game_turn WHERE session_id = ?').bind(id).run();
          await env.DB.prepare('DELETE FROM game_session WHERE id = ?').bind(id).run();
          return json({ ok: true });
        }

        // POST /api/sessions/{id}/turns —— SSE
        if (action === '/turns' && request.method === 'POST') {
          return handleTurn(env, request, id, user.id);
        }

        // POST /api/sessions/{id}/end —— 主动结束
        if (action === '/end' && request.method === 'POST') {
          if (session.status === 'ended') return json({ ok: true, ending: JSON.parse(session.ending_json || 'null') });
          const state = JSON.parse(session.state_json);
          const ending = {
            title: '自行收场',
            type: 'neutral',
            text: `你在这里停下了。${state.location}的风还在，事情没有解决，但你已经不想再往前走。有些故事不是结束，是被放下。`,
          };
          await env.DB.prepare('UPDATE game_session SET status = ?, ending_json = ?, updated_at = ? WHERE id = ?')
            .bind('ended', JSON.stringify(ending), now(), id)
            .run();
          return json({ ok: true, ending });
        }

        // GET /api/sessions/{id}/export
        if (action === '/export' && request.method === 'GET') {
          const turns = await loadTurns(env, id);
          const md = exportMarkdown(template, session, turns as any);
          const filename = encodeURIComponent(`${session.name || template.title}.md`);
          return new Response(md, {
            headers: {
              'content-type': 'text/markdown; charset=utf-8',
              'content-disposition': `attachment; filename*=UTF-8''${filename}`,
              'cache-control': 'no-store',
            },
          });
        }
      }

      return err('接口不存在', 404);
    } catch (e: any) {
      return err(`服务异常：${String(e?.message || e).slice(0, 200)}`, 500);
    }
  },
};
