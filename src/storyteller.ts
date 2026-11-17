import type { ModelTurn, State, Template } from './types';

/**
 * 离线叙事引擎（未配置大模型密钥时启用）。
 * 目的：没有 API Key 也能完整玩通一局——同一套模板素材、同一套数值规则，
 * 保证验收口径（区间结算、结局判定、存档、导出）始终可以测试。
 */

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

const pick = <T,>(arr: T[], n: number): T => arr[n % arr.length];

type Intent = 'fight' | 'ask' | 'search' | 'rest' | 'move' | 'other';

function classify(input: string): Intent {
  if (/打|砍|刺|攻|杀|冲|搏|动手|拔剑|开枪|踢|砸|抢/.test(input)) return 'fight';
  if (/问|说|谈|打听|告诉|喊|叫|聊|请|求|劝|谈条件/.test(input)) return 'ask';
  if (/找|搜|查|翻|观察|检查|撬|开|摸|听|看|研究|读/.test(input)) return 'search';
  if (/休息|睡|等|坐|藏|躲|喘|包扎|疗|缓/.test(input)) return 'rest';
  if (/走|去|进|出|上|下|爬|跑|离开|返回|退/.test(input)) return 'move';
  return 'other';
}

const INTENT_LINES: Record<Intent, string[]> = {
  fight: ['你没有再废话，先动了手，动作比对方预想的快了半拍。', '你把手里的东西握紧，往前踏了一步，脚底碾过碎石。', '你决定不再试探，直接让事情变快。'],
  ask: ['你把问题抛了出去，然后安静地等着，等对方先撑不住。', '你没有绕弯子，那句话问得很直。', '你压低了声音，问了一句很轻但谁也躲不开的话。'],
  search: ['你放慢了脚步，一寸一寸地看，不放过任何一处不对。', '你蹲下去，把手伸进那片阴影里，指尖先碰到了灰。', '你把注意力全压在细节上，连自己的呼吸都听得见。'],
  rest: ['你找了一个能看见出口的位置坐下来，先让呼吸慢下来。', '你把背靠在墙上，闭了几秒眼，让手不再抖。'],
  move: ['你朝那个方向走，脚下没有停，也没有回头看。', '你绕开了人群，往更深的地方去。'],
  other: ['你照自己的意思做了，没有人拦你，也没有人应你。', '你做了一个不算聪明的决定，但至少是主动做的。'],
};

/** 各模板的「高潮标记」触发词——离线模式下用来走到结局 */
const CLIMAX: Record<string, { flag: string; kw: RegExp }[]> = {
  wuxia: [
    { flag: 'truth', kw: /密信|慕容|真相|对质|揭|质问/ },
    { flag: 'escaped', kw: /逃|弃|离开城|出城|不管这城/ },
    { flag: 'horn', kw: /铜哨|吹号|集结号|哨/ },
  ],
  space: [
    { flag: 'signal_sent', kw: /信标|求救|广播|呼叫地球/ },
    { flag: 'hera_off', kw: /关掉|关闭|断电|切手动|掐断/ },
    { flag: 'become_37', kw: /躺进|睡进|休眠舱|接受|放弃/ },
  ],
  campus: [
    { flag: 'truth', kw: /录音|档案|真相|对质|公布|问陈/ },
    { flag: 'out', kw: /跑|逃|出去|退学|不再来/ },
    { flag: 'replaced', kw: /签名|签下|借书卡背面|交换/ },
  ],
  steampunk: [
    { flag: 'exposed', kw: /议长|密封信|公布|揭|贴出去/ },
    { flag: 'stop_clock', kw: /不上弦|停钟|让它停|不要走/ },
    { flag: 'wind_clock', kw: /上弦|装回|修好|十七号轮/ },
  ],
};

/** 通用收束句：让每回合正文稳定落在 200 字左右，并留一个钩子 */
const HOOKS = [
  '更远处，有什么东西刚刚合上，声音很轻。',
  '你注意到有人在看你，但你找不到那张脸。',
  '风停了一下，然后又起。',
  '有人在你身后轻轻吸了一口气，没有出声。',
  '门轴响了一声，只响了一半。',
  '远处开始有人走动，脚步很急。',
];

const TAILS = [
  '你知道自己只剩一次机会把话问对。',
  '手里的东西比刚才重了一点。',
  '你没有马上做决定，先看了一眼退路。',
  '这种地方的时间过得特别慢，慢到能听见自己的心跳。',
  '有些事只要多问一句，就再也回不去了。',
  '你忽然想起刚到这里时，那些人对你说话的语气。',
];

export function offlineTurn(t: Template, s: State, input: string): ModelTurn {
  const intent = classify(input);
  const seed = hash(`${t.id}|${s.turn}|${input}|${s.location}`);
  const next = s.turn + 1;

  const place = intent === 'move' ? pick(t.bank.places, seed + next * 3) : s.location || pick(t.bank.places, seed + next * 3);
  const sense = pick(t.bank.senses, seed + next);
  const npc = pick(t.npcs, seed % t.npcs.length);
  const npcLine = pick(t.bank.npcLines, seed + next * 7);
  const twist = pick(t.bank.twists, seed + next * 11);
  const outcome = pick(t.bank.outcomes, seed + next * 13);

  // 让「在场角色」跟着行动走：询问/战斗优先出现具体 NPC
  const who = intent === 'ask' || intent === 'fight' ? npc.name : `空气里有人动了一下，是${npc.name}`;

  const parts: string[] = [];
  parts.push(pick(INTENT_LINES[intent], seed));
  parts.push(`在${place}，${sense}。${pick(t.bank.senses, seed + next + 1)}。${twist}。${pick(HOOKS, seed + next * 17)}`);
  parts.push(
    intent === 'fight'
      ? `${npc.name}退了半步，${npcLine}`
      : intent === 'ask'
        ? `${who}看了你一会儿，${npcLine}`
        : `${who}，${npcLine}`
  );

  // 记忆回扣：保证第 10 回合仍记得第 1 回合的人和事
  if (s.memories?.length && next % 4 === 0) {
    const m = s.memories[0];
    parts.push(`你忽然想起第 ${m.turn} 回合的事：${m.text}。它现在看起来，比当时更像一条线索。`);
  }
  parts.push(pick(TAILS, seed + next * 19));
  parts.push(outcome + '。');

  // ---- 数值建议 ----
  const jitter = (n: number) => (hash(`${seed}|${n}`) % (n * 2 + 1)) - n;
  const delta: ModelTurn['state_delta'] = { hp: 0, gold: 0, stamina: 0, flags: {}, location: place };
  if (intent === 'fight') {
    delta.hp = -(5 + Math.abs(jitter(6)));
    delta.stamina = -(8 + Math.abs(jitter(8)));
    if (hash(`${seed}|g`) % 3 === 0) delta.gold = 5 + Math.abs(jitter(10));
  } else if (intent === 'ask') {
    delta.stamina = -3;
    delta.flags = { 线索: Number(s.flags['线索'] || 0) + 1 };
  } else if (intent === 'search') {
    delta.stamina = -(4 + Math.abs(jitter(6)));
    delta.flags = { 线索: Number(s.flags['线索'] || 0) + 1 };
  } else if (intent === 'rest') {
    delta.hp = 6 + Math.abs(jitter(6));
    delta.stamina = 14 + Math.abs(jitter(8));
  } else if (intent === 'move') {
    delta.stamina = -4;
  } else {
    delta.stamina = -2;
  }

  // 偶发获得白名单道具
  if ((intent === 'search' || intent === 'move') && s.items.length < 6 && hash(`${seed}|item`) % 3 === 0) {
    const owned = new Set(s.items.map((i) => i.name));
    const cand = t.itemPool.filter((i) => !owned.has(i.name));
    if (cand.length) {
      const got = pick(cand, seed);
      delta.items_gain = [got.name];
      parts.push(`你把它收进怀里——${got.name}。`);
    }
  }

  // 高潮标记：线索足够且命中关键词，推进到结局线
  const clues = Number(delta.flags?.['线索'] ?? s.flags['线索'] ?? 0);
  if (clues >= 3 || next >= 9) {
    for (const c of CLIMAX[t.id] || []) {
      if (c.kw.test(input)) {
        delta.flags = { ...(delta.flags || {}), [c.flag]: 1 };
        break;
      }
    }
  }

  const choiceSet: string[] = [];
  for (let k = 0; choiceSet.length < 3 && k < t.bank.choices.length * 3; k++) {
    const c = pick(t.bank.choices, seed + next * 5 + k * 2);
    if (!choiceSet.includes(c)) choiceSet.push(c);
  }
  const choices = choiceSet;

  return {
    scene: place,
    narration: parts.filter(Boolean).join('\n\n'),
    choices,
    state_delta: delta,
    ending: null,
  };
}

/** 结构化失败时的模板化兜底文案（不让玩家卡住） */
export function fallbackTurn(t: Template, s: State, input: string): ModelTurn {
  const place = s.location || pick(t.bank.places, s.turn);
  const npc = pick(t.npcs, s.turn);
  return {
    scene: place,
    narration: `你${input.replace(/^[，。\s]+/, '') || '停在原地'}。\n\n${place}的光线暗了一格，${pick(t.bank.senses, s.turn + 3)}。${npc.name}没有回答你，只是把视线移开了——那种移开，比拒绝更像承认。\n\n你听见远处有什么东西合上的声音，很轻，但很清楚。`,
    choices: ['再问一次，把话说明白', '先退开，看清周围有几个人', '改变主意，直接动手'],
    state_delta: { hp: 0, gold: 0, stamina: -2, flags: { 线索: Number(s.flags['线索'] || 0) + 1 }, location: place },
    ending: null,
  };
}
