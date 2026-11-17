import type { State, Template, ModelTurn } from './types';

export const RULES = {
  hpDelta: 20, // 单回合生命变化 ±20
  hpMin: 0,
  hpMax: 100,
  goldDelta: 50, // 单回合金币变化 ±50
  staminaDelta: 30,
  itemLimit: 8, // 背包最多 8 种
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const num = (v: unknown, fallback = 0) =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

export function cloneState(s: State): State {
  return JSON.parse(JSON.stringify(s));
}

export function initialState(t: Template): State {
  return cloneState(t.initialState);
}

export function itemNames(t: Template): string[] {
  return t.itemPool.map((i) => i.name);
}

/**
 * 按需求文档「表 2 剧情与数值规则」裁定 AI 给出的数值建议。
 * AI 只提建议，后端按区间截断后才落库。
 */
export function settleState(
  t: Template,
  prev: State,
  delta: ModelTurn['state_delta'] = {},
  notes: string[] = []
): State {
  const s = cloneState(prev);
  const d = delta || {};

  // 生命：单回合 −20 ~ +20，总量 0 ~ 100
  const rawHp = num(d.hp);
  const hpDelta = clamp(rawHp, -RULES.hpDelta, RULES.hpDelta);
  if (rawHp !== hpDelta) notes.push(`生命变化 ${rawHp} → ${hpDelta}（区间截断）`);
  s.hp = clamp(s.hp + hpDelta, RULES.hpMin, RULES.hpMax);

  // 体力：单回合 −30 ~ +30，总量 0 ~ 100
  const rawSt = num(d.stamina);
  const stDelta = clamp(rawSt, -RULES.staminaDelta, RULES.staminaDelta);
  if (rawSt !== stDelta) notes.push(`体力变化 ${rawSt} → ${stDelta}（区间截断）`);
  s.stamina = clamp(s.stamina + stDelta, 0, s.staminaMax);

  // 金币：单回合 −50 ~ +50，不得为负
  const rawGold = num(d.gold);
  const goldDelta = clamp(rawGold, -RULES.goldDelta, RULES.goldDelta);
  if (rawGold !== goldDelta) notes.push(`金币变化 ${rawGold} → ${goldDelta}（区间截断）`);
  s.gold = Math.max(0, s.gold + goldDelta);
  if (s.gold + goldDelta < 0) notes.push('金币不足，按 0 结算');

  // 道具：只接受模板白名单内的
  const allowed = itemNames(t);
  for (const raw of d.items_gain || []) {
    const name = String(raw || '').trim();
    if (!name) continue;
    if (!allowed.includes(name)) {
      notes.push(`道具「${name}」不在模板清单内，已丢弃`);
      continue;
    }
    const exist = s.items.find((i) => i.name === name);
    if (exist) exist.qty = (exist.qty || 1) + 1;
    else if (s.items.length < RULES.itemLimit) s.items.push({ name, qty: 1 });
    else {
      notes.push(`背包已满，「${name}」未放入`);
    }
  }
  for (const raw of d.items_lose || []) {
    const name = String(raw || '').trim();
    if (!name) continue;
    const idx = s.items.findIndex((i) => i.name === name);
    if (idx >= 0) {
      s.items[idx].qty = (s.items[idx].qty || 1) - 1;
      if ((s.items[idx].qty || 0) <= 0) s.items.splice(idx, 1);
    } else {
      notes.push(`试图失去不存在的道具「${name}」`);
    }
  }

  // 剧情标记
  if (d.flags && typeof d.flags === 'object') {
    for (const [k, v] of Object.entries(d.flags)) {
      if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') {
        s.flags[k] = v;
      }
    }
  }

  // 地点
  if (typeof d.location === 'string' && d.location.trim().length <= 30) {
    s.location = d.location.trim();
  }

  s.hp = Math.round(s.hp);
  s.stamina = Math.round(s.stamina);
  s.gold = Math.round(s.gold);
  return s;
}

/** 模板中的结局条件判定 */
export function matchEnding(t: Template, s: State): { id: string; title: string; text: string } | null {
  if (s.hp <= 0) {
    const dead = t.endings.find((e) => e.when === 'hp_zero') || t.endings[0];
    return { id: dead.id, title: dead.title, text: dead.text };
  }
  for (const e of t.endings) {
    if (e.when === 'flag' && e.key) {
      const v = s.flags[e.key];
      if (e.value !== undefined ? v === e.value : Boolean(v)) {
        return { id: e.id, title: e.title, text: e.text };
      }
    }
    if (e.when === 'item' && e.key) {
      if (s.items.some((i) => i.name === e.key)) {
        return { id: e.id, title: e.title, text: e.text };
      }
    }
    if (e.when === 'turns_flag' && e.key && e.turns) {
      if (s.turn >= e.turns && Boolean(s.flags[e.key])) {
        return { id: e.id, title: e.title, text: e.text };
      }
    }
  }
  return null;
}

const FALLBACK_CHOICES = ['观察四周', '上前交谈', '转身离开'];

/** 选项不足 2 条时补默认选项 */
export function normalizeChoices(raw: unknown): string[] {
  let list: string[] = [];
  if (Array.isArray(raw)) {
    list = raw
      .map((c) => (typeof c === 'string' ? c : String((c as any)?.text ?? '')))
      .map((c) => c.replace(/\s+/g, ' ').trim())
      .filter((c) => c.length > 0 && c.length <= 40);
  }
  // 去重
  const seen = new Set<string>();
  list = list.filter((c) => (seen.has(c) ? false : (seen.add(c), true)));
  list = list.slice(0, 4);
  let i = 0;
  while (list.length < 2 && i < FALLBACK_CHOICES.length) {
    const f = FALLBACK_CHOICES[i++];
    if (!list.includes(f)) list.push(f);
  }
  return list;
}

/** 一致性检查：剧情里出现的新角色必须带身份描述，否则视为不合格 */
export function checkConsistency(
  t: Template,
  narration: string,
  newChars: { name: string; role: string }[]
): string[] {
  const problems: string[] = [];
  for (const c of newChars || []) {
    if (!c || !c.name) problems.push('返回了没有名字的新角色');
    else if (!c.role || String(c.role).trim().length < 2)
      problems.push(`新角色「${c.name}」缺少身份描述`);
  }
  // 把新角色记为已知，避免下一回合被当成陌生人
  return problems;
}

/** 合并已知角色名 */
export function mergeKnownNames(s: State, t: Template, newChars: { name: string }[] = []): State {
  const names = new Set([...(s.knownNames || []), ...t.npcs.map((n) => n.name)]);
  for (const c of newChars) if (c?.name) names.add(c.name);
  s.knownNames = Array.from(names).slice(0, 20);
  return s;
}

/** 写入记忆（用于第 10 回合仍能提到第 1 回合的人事） */
export function pushMemory(s: State, text: string): State {
  const m = { turn: s.turn, text: text.slice(0, 120) };
  s.memories = [...(s.memories || []), m].slice(-12);
  return s;
}
