import type { State, Template } from './types';

interface TurnRow {
  turn_no: number;
  player_input: string;
  ai_raw: string;
  state_after: string;
}

function itemLine(s: State) {
  return s.items.map((i) => `${i.name}×${i.qty || 1}`).join('、') || '（空）';
}

export function exportMarkdown(
  t: Template,
  session: { id: string; name: string; status: string; ending_json: string | null; created_at: number },
  turns: TurnRow[]
): string {
  const date = new Date(session.created_at).toLocaleString('zh-CN', { hour12: false });
  const playTurns = turns.filter((r) => r.turn_no > 0).length;
  const lines: string[] = [];
  lines.push(`# ${session.name || t.title}`);
  lines.push('');
  lines.push(`> 剧本：${t.title} · ${t.subtitle}`);
  lines.push(`> 开局时间：${date}　回合数：${playTurns}　状态：${session.status === 'ended' ? '已结局' : '进行中'}`);
  lines.push('');
  lines.push('## 世界观');
  lines.push('');
  lines.push(t.worldview);
  lines.push('');

  for (const row of turns) {
    let payload: any = {};
    try {
      payload = JSON.parse(row.ai_raw);
    } catch {
      payload = { narration: row.ai_raw };
    }
    const state: State = JSON.parse(row.state_after);
    lines.push(`## 第 ${row.turn_no} 回合 · ${payload.scene || state.scene || state.location}`);
    lines.push('');
    lines.push(`**你的行动：** ${row.player_input}`);
    lines.push('');
    lines.push(String(payload.narration || '').trim());
    lines.push('');
    if (Array.isArray(payload.choices) && payload.choices.length) {
      lines.push('可选：' + payload.choices.map((c: string) => `「${c}」`).join('　'));
      lines.push('');
    }
    lines.push(
      `*生命 ${state.hp}/${state.hpMax}　金币 ${state.gold}　体力 ${state.stamina}/${state.staminaMax}　背包：${itemLine(state)}*`
    );
    lines.push('');
  }

  if (session.ending_json) {
    try {
      const e = JSON.parse(session.ending_json);
      lines.push('---');
      lines.push('');
      lines.push(`## 结局 · ${e.title}`);
      lines.push('');
      lines.push(e.text || '');
      lines.push('');
    } catch {
      /* ignore */
    }
  }

  lines.push('---');
  lines.push('');
  lines.push(`<sub>由 AI 文字冒险游戏生成 · 存档 ${session.id}</sub>`);
  return lines.join('\n');
}
