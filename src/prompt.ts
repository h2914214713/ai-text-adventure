import type { State, Template } from './types';

/** 输出结构（需求文档：模型固定返回五个字段） */
export const OUTPUT_SCHEMA = `{
  "scene": "场景名（8 字以内）",
  "narration": "剧情正文，200 字左右，可以有对话，可用 \\n 分段",
  "choices": ["选项1", "选项2", "选项3"],
  "state_delta": { "hp": 0, "gold": 0, "stamina": 0, "items_gain": [], "items_lose": [], "flags": {}, "location": "" },
  "ending": null,
  "new_characters": []
}`;

export function buildSystemPrompt(t: Template): string {
  return `你是文字冒险游戏的叙事引擎，负责写剧情，不负责算数值。

【世界观】
${t.worldview}

【本局目标】${t.goal}

【文风】${t.tone}

【固定角色】（只能用这些名字，或在 new_characters 里登记新角色）
${t.npcs.map((n) => `- ${n.name}：${n.role}`).join('\n')}

【允许出现的道具】（其它道具一律不要发给玩家）
${t.itemPool.map((i) => `- ${i.name}：${i.desc}`).join('\n')}

【硬性规则】
1. 只输出一个 JSON 对象，不要任何解释、不要 markdown 代码块、不要前后缀文字。
2. 结构必须是：
${OUTPUT_SCHEMA}
3. narration 用第二人称「你」，200 字左右，写具体场景、动作与对话，不要写玩家的心理决定。
4. choices 必须 2 到 4 条，每条不超过 20 字，是玩家能立刻执行的具体动作，不要出现「你可能……」这类含糊描述。
5. state_delta 只是建议值：hp 单回合绝对值不超过 20，gold 绝对值不超过 50，stamina 绝对值不超过 30。不发生变化就填 0 或省略。
6. 不要凭空给玩家加满血，不要凭空给大宗金币，代价要与剧情匹配。
7. 出现新角色必须在 new_characters 里写 { "name": "名字", "role": "身份描述" }；不登记新角色就不要写新名字。
8. 只有明确达成结局时才填 ending：{ "title": "结局标题", "type": "good|bad|neutral", "text": "结局正文 150 字左右" }，否则必须为 null。生命归零由系统判定，你不要自行判死。
9. 与前文保持严格一致：已经发生过的事、已经获得的道具、已经见过的人都不能矛盾；可以自然回扣前文细节。
10. 不要输出任何现实世界的敏感内容、真实政治人物、真实品牌或现实犯罪方法。`;
}

export function buildTurnMessages(
  t: Template,
  state: State,
  history: { turn: number; input: string; narration: string }[],
  playerInput: string
) {
  const mem = (state.memories || [])
    .slice(-6)
    .map((m) => `第 ${m.turn} 回合：${m.text}`)
    .join('\n');

  const recent = history
    .slice(-4)
    .map((h) => `【第 ${h.turn} 回合】玩家：${h.input}\n剧情：${h.narration}`)
    .join('\n\n');

  const user = `【当前状态】回合 ${state.turn} · 生命 ${state.hp}/${state.hpMax} · 金币 ${state.gold} · 体力 ${state.stamina}/${state.staminaMax} · 位置：${state.location}
【背包】${state.items.map((i) => `${i.name}×${i.qty || 1}`).join('、') || '空'}
【剧情标记】${JSON.stringify(state.flags)}
【必须记住的早期剧情】
${mem || '（暂无）'}

【最近剧情】
${recent || '（本回合为开局）'}

【玩家这一回合的行动】${playerInput}

请输出这一回合的 JSON。`;

  return { user };
}
