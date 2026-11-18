/* ------------------------------------------------------------------ */
/* 氛围粒子层                                                          */
/* 一套 canvas 覆盖全屏，按剧本切换气质：飘雪 / 星尘 / 雨丝 / 火星      */
/* 只做常量级绘制：粒子数按面积收敛，DPR 封顶 1.5，页面隐藏即暂停      */
/* ------------------------------------------------------------------ */

const TAU = Math.PI * 2;
const rand = (a, b) => a + Math.random() * (b - a);

/** 每种主题的粒子配比，权重和为 1 */
const THEMES = {
  home: { snow: 0, rain: 0, star: 0.34, dust: 0.66, ember: 0, tint: [232, 201, 138] },
  wuxia: { snow: 0.82, rain: 0, star: 0.04, dust: 0.14, ember: 0, tint: [226, 235, 246] },
  space: { snow: 0, rain: 0, star: 0.68, dust: 0.32, ember: 0, tint: [150, 220, 255] },
  campus: { snow: 0, rain: 1, star: 0, dust: 0, ember: 0, tint: [186, 168, 255] },
  suspense: { snow: 0, rain: 1, star: 0, dust: 0, ember: 0, tint: [186, 168, 255] },
  steampunk: { snow: 0, rain: 0, star: 0, dust: 0.34, ember: 0.66, tint: [240, 168, 74] },
};

const KIND_ORDER = ['snow', 'rain', 'star', 'dust', 'ember'];

function pickKind(theme) {
  const t = THEMES[theme] || THEMES.home;
  const r = Math.random();
  let acc = 0;
  for (const k of KIND_ORDER) {
    acc += t[k] || 0;
    if (r <= acc) return k;
  }
  return 'dust';
}

export function createAmbience(canvas) {
  if (!canvas) return { setTheme() {}, burst() {}, destroy() {} };

  const ctx = canvas.getContext('2d', { alpha: true });
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  let w = 0;
  let h = 0;
  let dpr = 1;
  let theme = 'home';
  let parts = [];
  let bursts = [];
  let raf = 0;
  let last = 0;
  let running = false;
  const mouse = { x: 0.5, y: 0.5, tx: 0.5, ty: 0.5 };

  function count() {
    // 面积决定粒子数量：1440×900 约 110 颗，手机上约 40 颗
    return Math.max(34, Math.min(120, Math.round((w * h) / 14000)));
  }

  function spawn(p, seed) {
    const kind = p.kind;
    p.x = rand(-20, w + 20);
    p.y = seed ? rand(0, h) : -rand(10, 60);
    p.a = rand(0.25, 0.85);
    p.ph = rand(0, TAU);
    p.sp = rand(0.6, 1.7);

    if (kind === 'snow') {
      p.r = rand(0.7, 2.3);
      p.vy = rand(14, 46);
      p.vx = rand(-10, 10);
      p.sway = rand(8, 26);
      p.a = rand(0.28, 0.78);
    } else if (kind === 'rain') {
      p.r = 1;
      p.len = rand(10, 26);
      p.vy = rand(520, 820);
      p.vx = rand(-70, -34);
      p.a = rand(0.06, 0.2);
      if (seed) p.y = rand(0, h);
    } else if (kind === 'star') {
      p.r = rand(0.5, 1.5);
      p.vy = rand(-3, 3);
      p.vx = rand(-4, 4);
      p.a = rand(0.2, 0.9);
      p.tw = rand(0.6, 2.4);
      if (!seed) p.y = rand(0, h);
    } else if (kind === 'dust') {
      p.r = rand(0.6, 1.8);
      p.vy = rand(-7, 9);
      p.vx = rand(-9, 9);
      p.a = rand(0.12, 0.42);
      if (!seed) p.y = rand(0, h);
    } else {
      // ember：火星向上飘，越飘越淡
      p.r = rand(0.8, 2.4);
      p.vy = -rand(22, 66);
      p.vx = rand(-12, 12);
      p.a = rand(0.3, 0.9);
      p.y = seed ? rand(0, h) : h + rand(0, 40);
      p.life = rand(0.3, 1);
    }
    return p;
  }

  function reseed() {
    const n = count();
    parts = [];
    for (let i = 0; i < n; i++) {
      parts.push(spawn({ kind: pickKind(theme) }, true));
    }
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    w = window.innerWidth;
    h = window.innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    reseed();
  }

  function step(dt) {
    mouse.x += (mouse.tx - mouse.x) * Math.min(1, dt * 3);
    mouse.y += (mouse.ty - mouse.y) * Math.min(1, dt * 3);
    const px = (mouse.x - 0.5) * 26;
    const py = (mouse.y - 0.5) * 16;

    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const depth = p.r / 2.4; // 视差深度

      if (p.kind === 'snow') {
        p.ph += dt * 1.6;
        p.y += p.vy * dt;
        p.x += (p.vx + Math.sin(p.ph) * p.sway) * dt;
      } else if (p.kind === 'rain') {
        p.y += p.vy * dt;
        p.x += p.vx * dt;
      } else if (p.kind === 'star') {
        p.ph += dt * p.tw;
        p.y += p.vy * dt;
        p.x += p.vx * dt;
      } else if (p.kind === 'dust') {
        p.ph += dt * 0.9;
        p.y += (p.vy + Math.sin(p.ph) * 5) * dt;
        p.x += p.vx * dt;
      } else {
        p.ph += dt * 5;
        p.life -= dt * 0.16;
        p.y += p.vy * dt;
        p.x += (p.vx + Math.sin(p.ph) * 12) * dt;
        if (p.life <= 0) {
          spawn(p, false);
          continue;
        }
      }

      if (p.y > h + 40 || p.y < -60 || p.x < -60 || p.x > w + 60) spawn(p, false);

      p.sx = p.x + px * depth;
      p.sy = p.y + py * depth;
    }

    for (let i = bursts.length - 1; i >= 0; i--) {
      const b = bursts[i];
      b.vy += 260 * dt;
      b.vx *= 1 - 1.4 * dt;
      b.vy *= 1 - 1.4 * dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.life -= dt;
      if (b.life <= 0) bursts.splice(i, 1);
    }
  }

  function draw() {
    ctx.clearRect(0, 0, w, h);
    const tint = (THEMES[theme] || THEMES.home).tint;
    const base = `rgb(${tint[0]},${tint[1]},${tint[2]})`;

    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const x = p.sx ?? p.x;
      const y = p.sy ?? p.y;

      if (p.kind === 'rain') {
        ctx.strokeStyle = `rgba(${tint[0]},${tint[1]},${tint[2]},${p.a})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + p.vx * 0.014, y - p.len);
        ctx.stroke();
        continue;
      }

      let a = p.a;
      if (p.kind === 'star') a *= 0.55 + 0.45 * Math.sin(p.ph);
      if (p.kind === 'ember') a *= Math.max(0, Math.min(1, p.life));

      // 外圈柔光 + 内芯亮点，比 shadowBlur 便宜得多
      ctx.fillStyle = `rgba(${tint[0]},${tint[1]},${tint[2]},${a * 0.16})`;
      ctx.beginPath();
      ctx.arc(x, y, p.r * 3.2, 0, TAU);
      ctx.fill();

      ctx.fillStyle = p.kind === 'snow' ? `rgba(255,255,255,${a})` : base.replace('rgb', 'rgba').replace(')', `,${a})`);
      ctx.beginPath();
      ctx.arc(x, y, p.r, 0, TAU);
      ctx.fill();
    }

    for (let i = 0; i < bursts.length; i++) {
      const b = bursts[i];
      const a = Math.max(0, b.life / b.max) * 0.9;
      ctx.fillStyle = `rgba(255, ${200 + Math.round(40 * a)}, 150, ${a})`;
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r * (0.4 + a), 0, TAU);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  function loop(ts) {
    if (!running) return;
    const dt = Math.min(0.05, (ts - last) / 1000 || 0.016);
    last = ts;
    step(dt);
    draw();
    raf = requestAnimationFrame(loop);
  }

  function start() {
    if (running || reduce) return;
    running = true;
    last = performance.now();
    raf = requestAnimationFrame(loop);
  }

  function stop() {
    running = false;
    cancelAnimationFrame(raf);
  }

  function setTheme(name) {
    if (theme === name) return;
    theme = THEMES[name] ? name : 'home';
    reseed();
    if (reduce) draw();
  }

  function burst(x = w / 2, y = h / 2, n = 90) {
    for (let i = 0; i < n; i++) {
      const ang = rand(0, TAU);
      const sp = rand(70, 460);
      bursts.push({
        x,
        y,
        vx: Math.cos(ang) * sp,
        vy: Math.sin(ang) * sp - 60,
        r: rand(1, 3.4),
        life: rand(1.1, 2.6),
        max: 2.6,
      });
    }
    if (reduce) draw();
  }

  const onMove = (e) => {
    mouse.tx = e.clientX / window.innerWidth;
    mouse.ty = e.clientY / window.innerHeight;
  };
  const onVis = () => (document.hidden ? stop() : start());

  window.addEventListener('resize', resize, { passive: true });
  window.addEventListener('mousemove', onMove, { passive: true });
  document.addEventListener('visibilitychange', onVis);

  resize();
  draw();
  start();

  return {
    setTheme,
    burst,
    destroy() {
      stop();
      window.removeEventListener('resize', resize);
      window.removeEventListener('mousemove', onMove);
      document.removeEventListener('visibilitychange', onVis);
    },
  };
}

/* ------------------------------------------------------------------ */
/* 剧本视觉映射：封面图 + 主色 + 氛围主题                               */
/* ------------------------------------------------------------------ */

export const SCENES = {
  wuxia: { art: '/assets/art/wuxia.jpg', thumb: '/assets/art/wuxia-sm.jpg', theme: 'wuxia' },
  space: { art: '/assets/art/space.jpg', thumb: '/assets/art/space-sm.jpg', theme: 'space' },
  campus: { art: '/assets/art/suspense.jpg', thumb: '/assets/art/suspense-sm.jpg', theme: 'campus' },
  suspense: { art: '/assets/art/suspense.jpg', thumb: '/assets/art/suspense-sm.jpg', theme: 'campus' },
  steampunk: { art: '/assets/art/steampunk.jpg', thumb: '/assets/art/steampunk-sm.jpg', theme: 'steampunk' },
};

export const sceneOf = (id) => SCENES[id] || { art: '/assets/art/hero.jpg', thumb: '/assets/art/hero-sm.jpg', theme: 'home' };
