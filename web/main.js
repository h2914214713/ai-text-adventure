import { createApp, reactive, ref, computed, nextTick } from 'vue';

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

const TOKEN_KEY = 'ata.token.v1';

function token() {
  let t = localStorage.getItem(TOKEN_KEY);
  if (!t) {
    t =
      (crypto.randomUUID && crypto.randomUUID().replace(/-/g, '')) ||
      Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem(TOKEN_KEY, t);
  }
  return t;
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      'x-user-token': token(),
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    let msg = `请求失败（${res.status}）`;
    let body = null;
    try {
      body = await res.json();
      msg = body.error || msg;
    } catch {
      /* ignore */
    }
    const e = new Error(msg);
    e.status = res.status;
    e.body = body;
    throw e;
  }
  return res.json();
}

const hexA = (hex, a) => {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};

const timeAgo = (ts) => {
  const d = Math.floor((Date.now() - ts) / 1000);
  if (d < 60) return '刚刚';
  if (d < 3600) return `${Math.floor(d / 60)} 分钟前`;
  if (d < 86400) return `${Math.floor(d / 3600)} 小时前`;
  return `${Math.floor(d / 86400)} 天前`;
};

/* ------------------------------------------------------------------ */
/* 主组件                                                              */
/* ------------------------------------------------------------------ */

const App = {
  setup() {
    const view = ref('home');
    const loading = ref(true);
    const templates = ref([]);
    const sessions = ref([]);
    const engine = ref('');
    const health = ref(false);

    const session = ref(null);
    const state = ref(null);
    const turns = ref([]);
    const ending = ref(null);
    const busy = ref(false);
    const stream = ref(null);
    const notes = ref([]);
    const pops = ref([]);
    const toast = ref(null);
    const draft = ref('');
    const scroller = ref(null);
    const autoScroll = ref(true);

    const editingId = ref('');
    const editingName = ref('');
    const deleteId = ref('');

    let toastTimer = null;
    function say(msg, bad = false) {
      toast.value = { msg, bad };
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => (toast.value = null), 3200);
    }

    const currentChoices = computed(() => {
      if (stream.value) return stream.value.choices || [];
      const last = turns.value[turns.value.length - 1];
      return last?.choices || [];
    });

    const canAct = computed(() => !busy.value && session.value?.status !== 'ended');

    /* ---------------- 启动 ---------------- */

    async function boot() {
      try {
        const h = await fetch('/api/health').then((r) => r.json());
        health.value = !!h.ok;
        engine.value = h.engine === 'llm' ? 'AI 在线' : '离线引擎';
      } catch {
        health.value = false;
      }
      try {
        // 顺序请求：首次访问时后端要建匿名用户，并发会撞唯一索引
        const t = await api('/api/templates');
        templates.value = t.templates;
        const s = await api('/api/sessions');
        sessions.value = s.sessions;
      } catch (e) {
        say(e.message, true);
      }
      loading.value = false;
    }

    async function refreshSessions() {
      try {
        const s = await api('/api/sessions');
        sessions.value = s.sessions;
      } catch {
        /* ignore */
      }
    }

    /* ---------------- 开局 / 读档 ---------------- */

    async function start(templateId) {
      if (busy.value) return;
      busy.value = true;
      try {
        const data = await api('/api/sessions', {
          method: 'POST',
          body: JSON.stringify({ templateId }),
        });
        enterGame(data);
      } catch (e) {
        say(e.message, true);
      } finally {
        busy.value = false;
      }
    }

    function enterGame(data) {
      session.value = data.session;
      state.value = data.state;
      ending.value = data.ending || null;
      let list = (data.turns || []).map((t) => ({
        turnNo: t.turnNo,
        input: t.input,
        scene: t.scene,
        narration: t.narration,
        choices: t.choices || [],
        degraded: t.degraded,
        state: t.state,
      }));
      if (!list.length && data.opening) {
        list = [
          {
            turnNo: 0,
            input: '（开局）',
            scene: data.opening.scene,
            narration: data.opening.narration,
            choices: data.opening.choices,
            degraded: false,
            state: data.state,
          },
        ];
      }
      turns.value = list;
      view.value = 'game';
      autoScroll.value = true;
      window.scrollTo({ top: 0 });
      nextTick(() => {
        if (list.length > 1) scrollToBottom(true);
        else if (scroller.value) scroller.value.scrollTop = 0;
      });
    }

    async function open(id) {
      if (busy.value) return;
      busy.value = true;
      try {
        const data = await api(`/api/sessions/${id}`);
        enterGame(data);
      } catch (e) {
        say(e.message, true);
      } finally {
        busy.value = false;
      }
    }

    /** 断线/并发冲突后重新拉取最新进度，保证不重复、不丢档 */
    async function resync(reason) {
      try {
        const data = await api(`/api/sessions/${session.value.id}`);
        enterGame(data);
        say(reason || '已同步到最新进度');
      } catch (e) {
        say(e.message, true);
      }
    }

    /* ---------------- 改名 / 删除 ---------------- */

    function beginRename(s) {
      editingId.value = s.id;
      editingName.value = s.name;
      deleteId.value = '';
    }

    async function commitRename() {
      const name = editingName.value.trim();
      if (!name) return (editingId.value = '');
      try {
        await api(`/api/sessions/${editingId.value}`, {
          method: 'PATCH',
          body: JSON.stringify({ name }),
        });
        const s = sessions.value.find((x) => x.id === editingId.value);
        if (s) s.name = name;
        if (session.value?.id === editingId.value) session.value.name = name;
        editingId.value = '';
        say('已改名');
      } catch (e) {
        say(e.message, true);
      }
    }

    async function commitDelete() {
      const id = deleteId.value;
      try {
        await api(`/api/sessions/${id}`, { method: 'DELETE' });
        sessions.value = sessions.value.filter((s) => s.id !== id);
        deleteId.value = '';
        say('存档已删除');
      } catch (e) {
        say(e.message, true);
      }
    }

    /* ---------------- 回合 ---------------- */

    function scrollToBottom(force = false) {
      const el = scroller.value;
      if (!el) return;
      if (force || autoScroll.value) el.scrollTop = el.scrollHeight;
    }

    function onScroll() {
      const el = scroller.value;
      if (!el) return;
      autoScroll.value = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    }

    function showDiffs(prev, next) {
      const list = [];
      const push = (label, a, b, unit = '') => {
        if (b !== a) list.push({ text: `${label} ${b > a ? '+' : ''}${b - a}${unit}`, up: b > a });
      };
      push('生命', prev.hp, next.hp);
      push('体力', prev.stamina, next.stamina);
      push('金币', prev.gold, next.gold);
      pops.value = list;
      setTimeout(() => (pops.value = []), 2600);
    }

    async function act(text) {
      const input = String(text ?? draft.value).trim();
      if (!input || !canAct.value) return;
      draft.value = '';
      busy.value = true;
      autoScroll.value = true;
      notes.value = [];
      stream.value = {
        turnNo: (state.value?.turn || 0) + 1,
        input,
        scene: '',
        narration: '',
        choices: [],
        degraded: false,
      };

      const body = JSON.stringify({ input, baseTurn: state.value?.turn ?? 0 });
      let res;
      try {
        res = await fetch(`/api/sessions/${session.value.id}/turns`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-user-token': token() },
          body,
        });
      } catch {
        busy.value = false;
        stream.value = null;
        return resync('网络中断，已重新同步进度');
      }

      if (!res.ok) {
        let msg = '行动提交失败';
        let data = null;
        try {
          data = await res.json();
          msg = data.error || msg;
        } catch {
          /* ignore */
        }
        busy.value = false;
        stream.value = null;
        if (res.status === 409) return resync('进度已更新，已为你同步到最新一回合');
        return say(msg, true);
      }

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let gotDone = false;

      const handle = (event, payload) => {
        if (event === 'meta') {
          stream.value.turnNo = payload.turn;
          stream.value.scene = payload.scene;
          engine.value = payload.engine === 'llm' ? 'AI 在线' : '离线引擎';
        } else if (event === 'delta') {
          stream.value.narration += payload.text;
          nextTick(() => scrollToBottom());
        } else if (event === 'replace') {
          stream.value.narration = payload.text;
          nextTick(() => scrollToBottom());
        } else if (event === 'choices') {
          stream.value.choices = payload.choices || [];
        } else if (event === 'state') {
          const prev = state.value;
          state.value = payload.state;
          notes.value = payload.notes || [];
          if (prev) showDiffs(prev, payload.state);
        } else if (event === 'status') {
          if (payload.phase === 'retry') stream.value.narration = '';
          if (payload.phase === 'degraded') stream.value.degraded = true;
        } else if (event === 'ending') {
          ending.value = payload;
        } else if (event === 'done') {
          gotDone = true;
          const finished = {
            turnNo: payload.turn,
            input,
            scene: stream.value.scene,
            narration: stream.value.narration,
            choices: stream.value.choices,
            degraded: payload.degraded,
            state: payload.state,
          };
          turns.value.push(finished);
          stream.value = null;
          busy.value = false;
          if (payload.ending) ending.value = payload.ending;
          nextTick(() => {
            const el = scroller.value;
            if (!el) return;
            const last = el.querySelector('.turn:last-child');
            if (autoScroll.value && last) {
              // 新回合从头开始读：把这一回合的标题滚到顶部
              el.scrollTop = Math.max(0, last.offsetTop - 10);
            } else {
              scrollToBottom(true);
            }
          });
          refreshSessions();
        } else if (event === 'error') {
          say(payload.message || '生成失败', true);
        }
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const blocks = buf.split('\n\n');
          buf = blocks.pop() || '';
          for (const block of blocks) {
            const lines = block.split('\n');
            let ev = 'message';
            let data = '';
            for (const line of lines) {
              if (line.startsWith('event:')) ev = line.slice(6).trim();
              else if (line.startsWith('data:')) data += line.slice(5).trim();
            }
            if (!data) continue;
            try {
              handle(ev, JSON.parse(data));
            } catch {
              /* 半包 */
            }
          }
        }
      } catch (e) {
        busy.value = false;
        stream.value = null;
        return resync('连接中断，进度已重新同步');
      }

      if (!gotDone) {
        busy.value = false;
        stream.value = null;
        resync('连接提前结束，已重新同步进度');
      }
    }

    async function endGame() {
      if (!session.value || busy.value) return;
      busy.value = true;
      try {
        const data = await api(`/api/sessions/${session.value.id}/end`, { method: 'POST' });
        ending.value = data.ending;
        session.value.status = 'ended';
        refreshSessions();
      } catch (e) {
        say(e.message, true);
      } finally {
        busy.value = false;
      }
    }

    function exportMd() {
      const url = `/api/sessions/${session.value.id}/export?token=${encodeURIComponent(token())}`;
      const a = document.createElement('a');
      a.href = url;
      a.download = '';
      document.body.appendChild(a);
      a.click();
      a.remove();
      say('正在导出 Markdown');
    }

    function backHome() {
      view.value = 'home';
      ending.value = null;
      stream.value = null;
      window.scrollTo({ top: 0 });
      refreshSessions();
    }

    function onKeydown(e) {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        act();
      }
    }

    boot();

    return {
      view,
      loading,
      templates,
      sessions,
      engine,
      health,
      session,
      state,
      turns,
      ending,
      busy,
      stream,
      notes,
      pops,
      toast,
      draft,
      scroller,
      canAct,
      currentChoices,
      editingId,
      editingName,
      deleteId,
      hexA,
      timeAgo,
      start,
      open,
      beginRename,
      commitRename,
      commitDelete,
      act,
      endGame,
      exportMd,
      backHome,
      onScroll,
      onKeydown,
      resync,
    };
  },

  template: /* html */ `
  <div v-if="loading" class="loading">
    <div class="spinner"></div>
    <div>正在点亮这座城……</div>
  </div>

  <!-- ============================ 首页 ============================ -->
  <div v-else-if="view === 'home'" class="shell">
    <header class="topbar">
      <div class="brand" @click="view='home'">
        <div class="brand-mark">✦</div>
        <div>
          <div class="brand-name">AI 文字冒险</div>
          <div class="brand-sub">TEXT ADVENTURE ENGINE</div>
        </div>
      </div>
      <div class="topbar-right">
        <span class="pill"><i class="dot" :class="{ off: !health }"></i>{{ engine || '连接中' }}</span>
      </div>
    </header>

    <section class="hero">
      <div class="hero-kicker">一句话，就是下一段剧情</div>
      <h1>你说什么，故事就往哪里<em>长</em></h1>
      <p>
        选一套剧本进入，写下一句行动——推门、问话、拔剑、撒谎。AI 负责把这句话写成 200 字剧情和新的选项；
        生命、金币、体力与背包由系统按规则裁定，谁也加不满血。每一回合自动存档，关掉网页也能接着走。
      </p>
      <div class="hero-meta">
        <div><strong>{{ templates.length }}</strong>套剧本</div>
        <div><strong>{{ sessions.length }}</strong>个存档</div>
        <div><strong>4</strong>项属性实时结算</div>
        <div><strong>Markdown</strong>一键导出</div>
      </div>
    </section>

    <div class="section-head">
      <h2>选一套剧本</h2>
      <span>点击即刻开局</span>
    </div>

    <div class="tpl-grid">
      <div
        v-for="t in templates"
        :key="t.id"
        class="tpl"
        :style="{ '--tpl-accent': t.accent, '--tpl-accent-soft': hexA(t.accent, 0.13) }"
        @click="start(t.id)"
      >
        <div class="tpl-tag">{{ t.tag }}</div>
        <h3>{{ t.title }}</h3>
        <div class="sub">{{ t.subtitle }}</div>
        <div class="world">{{ t.worldview }}</div>
        <div class="go">进入 <i>→</i></div>
      </div>
    </div>

    <div class="section-head">
      <h2>继续你的故事</h2>
      <span v-if="sessions.length">{{ sessions.length }} 个存档 · 自动保存</span>
    </div>

    <div v-if="sessions.length" class="saves">
      <div v-for="s in sessions" :key="s.id" class="save">
        <div class="save-main">
          <template v-if="editingId === s.id">
            <input
              v-model="editingName"
              class="rename-input"
              maxlength="40"
              @keyup.enter="commitRename"
              @keyup.esc="editingId=''"
              style="width:100%;background:#0f1218;border:1px solid rgba(255,255,255,.12);color:#e9e5dc;border-radius:8px;padding:8px 10px;font-size:14px;font-family:inherit;margin-bottom:6px"
            />
          </template>
          <div v-else class="save-name">{{ s.name }}</div>
          <div class="save-meta">
            <span>{{ s.templateTitle }}</span>
            <span>第 <b>{{ s.turns }}</b> 回合</span>
            <span>生命 <b>{{ s.hp }}</b></span>
            <span v-if="s.status === 'ended'" class="tag-ended">已结局 · {{ s.endingTitle }}</span>
            <span v-else class="tag-playing">进行中</span>
            <span>{{ timeAgo(s.updatedAt) }}</span>
          </div>
        </div>
        <div class="save-actions">
          <template v-if="editingId === s.id">
            <button class="btn sm primary" @click="commitRename">保存</button>
            <button class="btn sm ghost" @click="editingId=''">取消</button>
          </template>
          <template v-else-if="deleteId === s.id">
            <button class="btn sm" style="border-color:rgba(217,83,79,.5);color:#f0b7b5" @click="commitDelete">确认删除</button>
            <button class="btn sm ghost" @click="deleteId=''">取消</button>
          </template>
          <template v-else>
            <button class="btn sm primary" @click="open(s.id)">继续</button>
            <button class="btn sm ghost" @click.stop="beginRename(s)">改名</button>
            <button class="btn sm ghost" @click.stop="deleteId = s.id">删除</button>
          </template>
        </div>
      </div>
    </div>
    <div v-else class="empty">还没有存档。选一套剧本，故事从第一句话开始。</div>
  </div>

  <!-- ============================ 游戏页 ============================ -->
  <div v-else class="shell game-shell">
    <header class="topbar">
      <div class="brand" @click="backHome">
        <div class="brand-mark">✦</div>
        <div>
          <div class="brand-name">AI 文字冒险</div>
          <div class="brand-sub">TEXT ADVENTURE ENGINE</div>
        </div>
      </div>
      <div class="topbar-right">
        <span class="pill"><i class="dot" :class="{ off: !health }"></i>{{ engine }}</span>
        <button class="btn sm ghost" @click="backHome">← 返回书架</button>
      </div>
    </header>

    <div class="game-top">
      <div class="game-title">
        <div>
          <h2>{{ session?.name }}</h2>
          <div class="loc">{{ state?.location }} · {{ session?.status === 'ended' ? '已结局' : '自动存档中' }}</div>
        </div>
        <span class="turn-badge">TURN {{ state?.turn }}</span>
      </div>
      <div class="save-actions">
        <button class="btn sm" @click="exportMd">导出 Markdown</button>
        <button class="btn sm" :disabled="busy || session?.status === 'ended'" @click="endGame">结束本局</button>
      </div>
    </div>

    <div class="game-grid">
      <div class="play-col">
        <div class="narrative" ref="scroller" @scroll="onScroll">
          <div v-for="t in turns" :key="t.turnNo" class="turn">
            <div class="turn-head">
              <span class="no">T{{ String(t.turnNo).padStart(2, '0') }}</span>
              <span class="scene">{{ t.scene || t.state?.location }}</span>
            </div>
            <div v-if="t.turnNo > 0" class="turn-input"><b>你</b>{{ t.input }}</div>
            <div class="prose">{{ t.narration }}</div>
            <div v-if="t.degraded" class="degraded-note">本回合走了兜底文案（模型输出不合规）</div>
          </div>

          <div v-if="stream" class="turn streaming">
            <div class="turn-head">
              <span class="no">T{{ String(stream.turnNo).padStart(2, '0') }}</span>
              <span class="scene">{{ stream.scene || '……' }}</span>
            </div>
            <div class="turn-input"><b>你</b>{{ stream.input }}</div>
            <div class="prose">{{ stream.narration }}</div>
          </div>
        </div>

        <div v-if="currentChoices.length && !busy" class="choices">
          <button
            v-for="(c, i) in currentChoices"
            :key="c"
            class="choice"
            :disabled="!canAct"
            @click="act(c)"
          >
            <i>{{ i + 1 }}</i><span>{{ c }}</span>
          </button>
        </div>

        <div class="composer">
          <textarea
            v-model="draft"
            :placeholder="session?.status === 'ended' ? '本局已结束，导出记录留个念想吧' : '你想做什么？写下来，什么都行（Ctrl/⌘ + Enter 发送）'"
            :disabled="!canAct"
            rows="2"
            @keydown="onKeydown"
          ></textarea>
          <button class="btn primary" :disabled="!canAct || !draft.trim()" @click="act()">
            {{ busy ? '生成中…' : '行动' }}
          </button>
        </div>
      </div>

      <aside class="aside">
        <div class="card">
          <h4>状态</h4>
          <div class="stat">
            <div class="stat-top"><span>生命</span><b>{{ state?.hp }} / {{ state?.hpMax }}</b></div>
            <div class="bar hp"><span :style="{ width: (state?.hp / state?.hpMax * 100) + '%' }"></span></div>
          </div>
          <div class="stat">
            <div class="stat-top"><span>体力</span><b>{{ state?.stamina }} / {{ state?.staminaMax }}</b></div>
            <div class="bar st"><span :style="{ width: (state?.stamina / state?.staminaMax * 100) + '%' }"></span></div>
          </div>
          <div class="stat" style="margin-bottom:0">
            <div class="stat-top"><span>金币</span></div>
            <div class="gold">◎ {{ state?.gold }}</div>
          </div>
        </div>

        <div class="card">
          <h4>背包</h4>
          <div class="inv">
            <span v-for="i in (state?.items || [])" :key="i.name" class="chip">{{ i.name }}<template v-if="(i.qty||1) > 1"> ×{{ i.qty }}</template></span>
            <span v-if="!(state?.items || []).length" class="chip empty-chip">空空如也</span>
          </div>
        </div>

        <div class="card">
          <h4>本局提示</h4>
          <div style="font-size:12px;line-height:1.9;color:var(--text-dim)">
            数值由系统按区间裁定：生命单回合 ±20，金币 ±50，体力 ±30。AI 只写剧情，加不满你的血。
          </div>
          <div v-if="notes.length" style="margin-top:12px;font-size:11px;color:var(--text-faint);line-height:1.8">
            <div v-for="n in notes" :key="n">· {{ n }}</div>
          </div>
        </div>
      </aside>
    </div>
  </div>

  <!-- ============================ 结局 ============================ -->
  <div v-if="ending && view === 'game'" class="ending-wrap">
    <div class="ending-card">
      <div class="ending-kicker">ENDING</div>
      <h2>{{ ending.title }}</h2>
      <div class="ending-text">{{ ending.text }}</div>
      <div class="recap">
        <h5>关键抉择回顾</h5>
        <ol>
          <li v-for="t in turns.filter(x => x.turnNo > 0)" :key="t.turnNo">{{ t.input }}</li>
        </ol>
      </div>
      <div class="ending-actions">
        <button class="btn primary" @click="exportMd">导出本局记录</button>
        <button class="btn" @click="backHome">回到书架</button>
        <button class="btn ghost" @click="ending = null">先看看这一局</button>
      </div>
    </div>
  </div>

  <!-- ============================ 浮动提示 ============================ -->
  <div v-if="pops.length" class="delta-pop">
    <span v-for="p in pops" :key="p.text" :class="p.up ? 'up' : 'down'">{{ p.text }}</span>
  </div>

  <div v-if="toast" class="toast" :class="{ bad: toast.bad }">{{ toast.msg }}</div>
  `,
};

createApp(App).mount('#app');
