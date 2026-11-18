# AI 文字冒险 · Text Adventure Engine

玩家输入任何一句话，AI 把它写成下一段剧情；生命、金币、体力、背包由后端按规则裁定，谁也加不满血。

**在线地址：<https://game.aikouya.store>**（Cloudflare Workers + D1）

四套剧本：`孤城剑影`（武侠）/ `静默号`（太空求生）/ `第七教学楼`（校园悬疑）/ `齿轮与雾`（蒸汽朋克）。

---

## 1. 它是什么

按《AI 文字冒险游戏需求文档 V1.1》实现的一期功能：选模板开局 → 每回合 AI 生成约 200 字剧情和 2~4 个选项 → 玩家可点选项也可自由输入 → 数值结算 → 每回合自动存档 → 触发结局后可导出本局 Markdown。

核心原则和文档一致：**AI 只写剧情，不管数值**。模型返回的 `state_delta` 只是建议，后端按区间截断后才写库，所以不会出现"AI 随手给玩家加满血"。

## 2. 技术选型（与文档的一处偏离，先说明）

文档写的是 Spring Boot + MySQL + Redis + Vue 3。本项目要部署在 **Cloudflare**，那套后端跑不起来，因此做了等价替换，业务规则一行没少：

| 文档方案 | 本项目 | 说明 |
| --- | --- | --- |
| Spring Boot | Cloudflare Workers（TypeScript，单 Worker 路由） | 同一套 REST + SSE 接口 |
| MySQL | Cloudflare D1（SQLite），表结构照抄文档「表 4」 | `migrations/0001_init.sql` |
| Redis（会话/缓存） | 不需要：状态落 D1 的 `state_json` + `version` 做乐观并发 | 少了中间层，存档本身就是唯一事实来源 |
| Vue 3 | Vue 3（esbuild 打包，无框架脚手架） | 单页应用，静态资源由 Worker 托管 |
| DeepSeek / 通义千问 | 同一套 OpenAI 兼容协议，环境变量切换 | 未配密钥时自动降级到离线叙事引擎 |

额外的好处：没有冷启动成本、免费额度足够、`wrangler deploy` 一条命令上线。

## 3. 功能对照（F1 ~ F8）

| 编号 | 功能 | 实现位置 | 状态 |
| --- | --- | --- | --- |
| F1 | 模板开局 | `src/templates.ts`（4 套，含世界观 / 初始属性 / NPC / 结局条件） | ✅ |
| F2 | 剧情生成 | `src/prompt.ts` + `src/llm.ts`（结构化 JSON 输出） | ✅ |
| F3 | 流式输出 | `src/index.ts` SSE + `createNarrationExtractor` 增量抽取 `narration` | ✅ 逐字显示，不等整段 JSON |
| F4 | 状态结算 | `src/engine.ts` `settleState()` | ✅ 区间截断 + 道具白名单 |
| F5 | 自动存档 | `game_session` / `game_turn`，支持继续 / 改名 / 删除 | ✅ 每回合落库 |
| F6 | 结局判定 | `matchEnding()`：生命归零 / 标记 / 道具 / 回合数 | ✅ + 模型建议结局（≥5 回合才采纳） |
| F7 | 内容安全 | `src/safety.ts`：输入拦截 + 输出二次过滤 | ✅ |
| F8 | 导出 | `src/markdown.ts`，`GET /api/sessions/{id}/export` | ✅ 含关键抉择与结局 |

一期不做：多人联机、语音、AI 绘图、剧本交易、原生 App。

## 4. 核心规则（照文档「表 2」实现）

| 项目 | 规则 | 代码 |
| --- | --- | --- |
| 生命 | 单回合 −20 ~ +20，总量 0 ~ 100；归零即死亡结局 | `RULES.hpDelta` |
| 金币 | 单回合 −50 ~ +50，不得为负 | `RULES.goldDelta` |
| 体力 | 单回合 −30 ~ +30，总量 0 ~ 100 | `RULES.staminaDelta` |
| 道具 | 只接受模板 `itemPool` 白名单内的，其余丢弃并写 notes | `settleState()` |
| 选项 | 不足 2 条时后端补「观察四周 / 上前交谈 / 转身离开」 | `normalizeChoices()` |
| 一致性 | 新角色必须在 `new_characters` 带身份描述，否则重试 | `validateModelTurn()` |
| 失败处理 | JSON 不合法先重试一次，再失败返回模板化兜底文案 | `handleTurn()` |
| 背包 | 最多 8 种道具，超出提示未放入 | `RULES.itemLimit` |

模型输出结构固定五字段：

```json
{
  "scene": "场景名",
  "narration": "剧情正文 200 字左右",
  "choices": ["选项1", "选项2", "选项3"],
  "state_delta": { "hp": -5, "gold": 0, "stamina": -10, "items_gain": [], "items_lose": [], "flags": {}, "location": "" },
  "ending": null
}
```

## 5. 接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查（D1 + 当前引擎） |
| GET | `/api/templates` | 模板列表 |
| POST | `/api/sessions` | 创建存档（开局作为第 0 回合落库） |
| GET | `/api/sessions` | 存档列表 |
| GET | `/api/sessions/{id}` | 读取存档与全部回合 |
| PATCH | `/api/sessions/{id}` | 改名 |
| DELETE | `/api/sessions/{id}` | 删除 |
| POST | `/api/sessions/{id}/turns` | 提交行动，**SSE** 返回剧情 |
| POST | `/api/sessions/{id}/end` | 主动结束本局 |
| GET | `/api/sessions/{id}/export` | 导出 Markdown |

SSE 事件：`meta` → `delta`（逐字）→ `choices` → `state` → `ending?` → `done`；异常时 `status`（retry/degraded）与 `replace`（用修正后的正文覆盖已显示内容）。

请求需带 `x-user-token`（前端首次访问生成并存在 localStorage），后端据此建匿名用户，存档按用户隔离。

**并发与断线**：请求体带 `baseTurn`，若服务端回合数更大则返回 `409` + 最新状态，前端自动重新同步——重复提交不会多推一回合，断线重连不会重复剧情。

## 6. 数据表

完全对应文档「表 4」：`user` / `story_template` / `game_session` / `game_turn`，见 `migrations/0001_init.sql`。

## 7. 本地运行

```bash
npm install
npm run build                       # 打包前端 → public/assets/app.js
npx wrangler d1 migrations apply DB --local   # 初始化本地 SQLite
npx wrangler dev                    # http://127.0.0.1:8787
```

跑端到端测试（会真跑一局，覆盖结算/结局/导出/改名/删除/敏感词/并发）：

```bash
node scripts/smoke-test.mjs                      # 本地
node scripts/smoke-test.mjs https://game.aikouya.store   # 线上
```

## 8. 接入大模型（可选，但推荐）

默认不带密钥，游戏走**离线叙事引擎**（`src/storyteller.ts`）：同一套模板素材、同一套数值规则，能完整玩到结局，用于演示与自动化测试。配上密钥后自动切换为真实模型：

```bash
npx wrangler secret put LLM_API_KEY        # 粘贴密钥
# 可选：换服务商 / 模型
# wrangler.jsonc -> vars.LLM_PROVIDER / LLM_MODEL / LLM_BASE_URL
```

- DeepSeek：`https://api.deepseek.com` + `deepseek-chat`
- 通义千问（兼容模式）：`https://dashscope.aliyuncs.com/compatible-mode/v1` + `qwen-plus`

配好之后 `/api/health` 的 `engine` 会从 `offline` 变成模型名，前端胶囊标签同步变成「AI 在线」。

## 9. 部署

```bash
npx wrangler d1 create ai_adventure     # 首次：拿到 database_id 填进 wrangler.jsonc
npx wrangler d1 migrations apply DB --remote
npm run build && npx wrangler deploy
```

`wrangler.jsonc` 里已绑定自定义域名 `game.aikouya.store`（`custom_domain: true`，DNS 与证书自动签发）。换域名改 `routes[0].pattern` 即可。

## 10. 视觉层（氛围粒子 / 剧本插画）

文字冒险容易只剩滚动字幕，所以加了一层纯前端的"舞台"：不改任何接口，只换皮和氛围。

**氛围粒子**（`web/effects.js`，单 canvas 全屏常驻）
- 主题随剧本切换：武侠飘雪 / 太空星尘 / 悬疑雨丝 / 蒸汽火星与浮尘，首页是金色微尘
- 鼠标视差：粒子按"深度"跟随指针轻微偏移，前景快、背景慢
- 性能约束：粒子数按面积收敛（1440×900 约 110 颗，手机约 40 颗），DPR 封顶 1.5，切到后台自动停 rAF，`prefers-reduced-motion` 下直接隐藏

**剧本插画**：四套剧本各一张电影感封面（1536×1024，裁掉水印后转 JPEG，各约 200 KB，另出 760 px 缩略图给卡片用），用于首页卡片、游戏页顶部横幅、结局卡片背景。原图留在 `.art-src/` 不进仓库也不进部署包。

**随剧本换肤**：进入游戏时把 `--accent` 切到该剧本的主色（武侠绯红 / 太空电蓝 / 悬疑紫 / 蒸汽琥珀），按钮、进度条、回合号、光晕、粒子色温一起变；返回书架再变回金色。

**即时反馈**
- 生命下降：屏幕边缘红闪 + 数值浮动提示（涨红跌绿，符合 A 股习惯）
- 生成中：叙事区顶部一道来回扫的光条，配合逐字 SSE 输出
- 结局：全屏金色粒子爆散 + 标题由模糊拉伸到清晰，卡片背景是该剧本插画

**排版细节**：`「台词」` 染成暖色、`【强调】` 染成主色（先转义再替换，避免 XSS）；回合标题带渐隐分隔线；叙事区顶部一层随主题变色的光晕，上下边缘做渐隐遮罩。

## 11. 目录结构

```
src/
  index.ts       Worker 入口：路由、SSE、回合主流程、落库
  engine.ts      数值结算、区间截断、结局判定、选项规范化
  templates.ts   4 套剧本（世界观/NPC/道具白名单/结局/叙事素材）
  prompt.ts      系统提示词与回合上下文拼装（含早期剧情记忆）
  llm.ts         流式调用、JSON 抠取、narration 增量抽取、重试
  storyteller.ts 离线叙事引擎 + 兜底文案
  safety.ts      输入拦截 / 输出过滤
  markdown.ts    导出
web/
  main.js        Vue 3 单页（首页 / 游戏页 / 结局页）
  effects.js     氛围粒子引擎 + 剧本插画映射
public/
  index.html     入口页（含全屏 canvas 层）
  assets/style.css
  assets/art/    剧本插画（jpg + 缩略图）
migrations/      D1 建表脚本
scripts/         前端打包、端到端冒烟测试
```

## 12. 验收自查（对应文档「6 验收底线」）

| 验收项 | 结果 |
| --- | --- |
| 任选模板能从开局玩到结局，中途不报错 | ✅ 四套模板均验证，线上 31 项接口断言全通过 |
| 数值变化落在规则区间，不凭空满血 | ✅ 每回合校验 hp/体力/金币增量与上下限 |
| 第 10 回合仍记得第 1 回合的人和事 | ✅ `memories` 持久化 + 每 4 回合回扣，提示词带「必须记住的早期剧情」 |
| 断网重连不重复、进度不丢 | ✅ `baseTurn` 乐观并发 + 409 自动重新同步 |
| 首字 1.5s / 整回合 8s | 离线引擎首字 < 0.2s；接真实模型时依赖首 token 延迟，SSE 边生成边推送 |
