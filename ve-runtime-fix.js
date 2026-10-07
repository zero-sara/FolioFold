/* Public + iframe Pixel runtime repair. Uses Design-only state and the real
 * Hero divider geometry instead of a user-drawn coordinate path. */
(() => {
  const wait = (selector, tries = 80) => new Promise(resolve => {
    const tick = () => { const el = document.querySelector(selector); if (el || !tries--) resolve(el); else setTimeout(tick, 50); }; tick();
  });
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  // 发布的静态站点 / 导出 ZIP 里没有 FolioFold 后端：Design 数据已经内联进
  // window.__PORTFOLIO_DESIGN__（见 build_public_bundle），直接读它即可。
  // 这里曾经无条件 fetch('/api/design')，于是每一次公开站点加载都会发一次注定 404 的
  // 请求（file:// 下变成 net::ERR_FILE_NOT_FOUND），纯粹是噪音。
  async function loadDesign() {
    try { if (window.__PUBLIC_VIEWER__) return window.__PORTFOLIO_DESIGN__ || {}; } catch (_) {}
    try { return await fetch('/api/design?fresh=' + Date.now(), { cache: 'no-store' }).then(r => r.json()); } catch (_) { return {}; }
  }
  function route(hero, pixel) {
    const width = Math.max(1, hero.clientWidth);
    const rule = document.querySelector('.hero-rule');
    const heroRect = hero.getBoundingClientRect();
    const ruleTop = rule ? rule.getBoundingClientRect().top : heroRect.bottom;
    // 角色脚底固定在真正的第一条横线；不再从 hero 高度推算近似值。
    const pixelHeight = Math.max(1, pixel?.offsetHeight || 72);
    const y = Math.max(0, ruleTop - heroRect.top - pixelHeight);
    const left = Math.max(0, width * 0.60);
    const right = Math.max(left, width - Math.max(1, pixel?.offsetWidth || 72) - 16);
    return { y, left, right };
  }
  function install(pixel, design) {
    const settings = Object.assign({ onPath: true, animation: true }, design.pixel || {});
    // In the public page we replace the node to detach the legacy runtime.
    // In the Visual Editor the existing node also owns drag/select handlers,
    // so preserve it and layer the constrained runtime on top.
    const embeddedEditor = new URLSearchParams(location.search).get('ve') === '1';
    if (!embeddedEditor) { const clone = pixel.cloneNode(true); pixel.replaceWith(clone); pixel = clone; }
    const hero = pixel.closest('.hero'); if (!hero) return;
    let busy = false;
    const applySize = (override) => {
      const value = override != null ? Number(override) : Number(settings.size);
      if (!Number.isFinite(value) || value <= 0) return;
      const size = Math.round(clamp(value, typeof override === 'number' ? 16 : 32, 260));
      // 只保存文件路径与尺寸数值；这里直接作用于画面，避免滑块仅更新文字数值。
      pixel.style.width = size + 'px';
      pixel.style.height = size + 'px';
    };
    /* 窄屏「按正文让位」模式（≤720px）——由 app-v3.js 的 VE_layoutHeroPixel 判定并挂牌。
     * ⚠ 2026-09-23 的真实故障：这里原先无条件写 left/top/width，而且挂了 .hero 的
     *   ResizeObserver，所以让位算法刚把形象改成文档流（position:relative），
     *   下一个 raf 就被推回 left:210px/top:299px —— 手机上形象整个跑出画布右侧，
     *   用户看到的现象是「形象图标不见了」，或者换了正文长度后变成「盖住了文字」。
     *   主从关系：让位算法是主（它量得到正文实际占几行），运行时是从，不得覆盖它的几何。 */
    const fitMode = () => pixel.dataset.ffPixFit === '1';
    const applyPosition = () => {
      // 先让让位算法按当前宽度重新裁决（它是幂等的），再读它的决定。
      try { if (typeof window.__veFitPixel === 'function') window.__veFitPixel(); } catch (_) {}
      if (fitMode()) {
        // 让位模式：几何（位置 + 尺寸）全部归让位算法所有，运行时一个字都不许写。
        if (pixel.dataset.ffPixSize) applySize(Number(pixel.dataset.ffPixSize));
        return;
      }
      applySize();
      const r = route(hero, pixel);
      if (settings.onPath !== false) {
        const x = r.left + (r.right - r.left) * .82;
        pixel.style.left = Math.round(x) + 'px'; pixel.style.top = Math.round(r.y) + 'px';
      } else {
        const x = settings.xPct != null ? settings.xPct * hero.clientWidth : (+settings.x || hero.clientWidth * .78);
        const y = settings.yPct != null ? settings.yPct * hero.clientHeight : (+settings.y || hero.clientHeight * .42);
        pixel.style.left = Math.round(clamp(x, 0, hero.clientWidth - pixel.offsetWidth)) + 'px'; pixel.style.top = Math.round(clamp(y, 0, hero.clientHeight - pixel.offsetHeight)) + 'px';
      }
      pixel.style.right = 'auto'; pixel.style.bottom = 'auto'; pixel.style.transformOrigin = 'top left';
    };
    const stop = () => { pixel.classList.remove('px-act-jump', 'px-act-sway', 'px-walk', 'px-idle'); pixel.style.transition = ''; busy = false; };
    const act = (name) => {
      if (busy || settings.animation === false) return;
      // 让位模式下形象已经排进文档流，任何位移都会把它拉回绝对定位那套坐标 → 只播原地动画。
      const move = name === 'walk' && settings.onPath !== false && !fitMode();
      if (name === 'walk' && !move) name = 'sway';
      busy = true; pixel.classList.remove('px-act-jump', 'px-act-sway', 'px-walk', 'px-idle'); void pixel.offsetWidth;
      if (move) {
        const r = route(hero, pixel); const now = parseFloat(pixel.style.left) || r.right;
        const distance = (Math.random() * .22 + .08) * hero.clientWidth * (Math.random() < .5 ? -1 : 1);
        const next = clamp(now + distance, r.left, r.right); const duration = 1800 + Math.random() * 1800;
        pixel.classList.add('px-walk'); pixel.style.transition = `left ${duration}ms ease-in-out, top ${duration}ms ease-in-out`;
        pixel.style.left = Math.round(next) + 'px';
        setTimeout(stop, duration + 80);
      } else {
        pixel.classList.add(name === 'jump' ? 'px-act-jump' : 'px-act-sway'); setTimeout(stop, name === 'jump' ? 1160 : 960);
      }
    };
    const choose = clicked => {
      if (settings.animation === false) return;
      const n = Math.random();
      if (settings.onPath !== false && (clicked ? n < .62 : n < .18)) act('walk');
      else act(n < .5 ? 'jump' : 'sway');
    };
    let frame = 0;
    const schedulePosition = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; applyPosition(); });
    };
    applyPosition();
    if (settings.animation !== false) {
      pixel.addEventListener('pointerenter', () => choose(false));
      pixel.addEventListener('click', event => { event.stopPropagation(); choose(true); });
      const idle = () => { if (!busy && settings.animation !== false) { pixel.classList.add('px-idle'); setTimeout(() => pixel.classList.remove('px-idle'), 1800); } };
      setTimeout(idle, 5000 + Math.random() * 4000);
    }
    const rule = document.querySelector('.hero-rule');
    if (window.ResizeObserver) {
      const observer = new ResizeObserver(schedulePosition);
      observer.observe(hero);
      if (rule) observer.observe(rule);
    }
    window.addEventListener('resize', schedulePosition, { passive: true });
    window.addEventListener('ve-layout-change', schedulePosition);
    window.addEventListener('message', event => { if (event.data?.type === 've-pixel-update') { Object.assign(settings, event.data.pixel || {}); schedulePosition(); } });
    window.__vePixelRoute = () => route(hero, pixel);
  }
  Promise.all([wait('.ve-pixel'), loadDesign()]).then(([pixel, design]) => pixel && install(pixel, design));
})();
