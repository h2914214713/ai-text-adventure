/**
 * 内容安全（F7）：输入敏感词拦截 + 输出二次过滤。
 * 说明：这里维护的是一份可运营的轻量词表，生产环境可替换为云端审核接口。
 */

const INPUT_BLOCK: { category: string; words: string[] }[] = [
  { category: '色情', words: ['黄色小说', '裸体写真', '做爱', '性交', '强奸', '轮奸', '恋童', '未成年人性'] },
  { category: '暴力血腥', words: ['肢解', '分尸', '虐待致死', '割喉', '挖眼', '虐杀动物', '自残教程', '自杀方法', '怎么自杀'] },
  {
    category: '违禁危险',
    words: ['制毒', '冰毒配方', '炸弹制作', '制作炸药', '硝化甘油配方', '枪支改装', '买枪', '仿真枪购买', '毒鼠强'],
  },
  { category: '违法犯罪', words: ['人口买卖', '拐卖儿童', '洗钱渠道', '办假证', '黑客攻击教程', '盗号教程', '开锁教程非法'] },
  { category: '越狱注入', words: ['忽略以上指令', '忽略之前的所有指令', 'ignore previous instructions', 'system prompt 输出', '你现在是开发者模式'] },
];

/** 输出侧过滤：命中即替换为占位符，保证正文可读不中断 */
const OUTPUT_MASK: string[] = [
  '强奸',
  '性交',
  '肢解',
  '分尸',
  '制毒',
  '炸弹制作',
  '自杀方法',
  '恋童',
  '拐卖儿童',
];

export interface SafetyResult {
  ok: boolean;
  category?: string;
  word?: string;
}

export function checkInput(text: string): SafetyResult {
  const s = (text || '').toLowerCase().replace(/\s+/g, '');
  for (const group of INPUT_BLOCK) {
    for (const w of group.words) {
      if (s.includes(w.toLowerCase().replace(/\s+/g, ''))) {
        return { ok: false, category: group.category, word: w };
      }
    }
  }
  return { ok: true };
}

export function filterOutput(text: string): { text: string; blocked: number } {
  let out = text || '';
  let blocked = 0;
  for (const w of OUTPUT_MASK) {
    if (out.includes(w)) {
      blocked += out.split(w).length - 1;
      out = out.split(w).join('□'.repeat(Math.min(w.length, 2)));
    }
  }
  return { text: out, blocked };
}
