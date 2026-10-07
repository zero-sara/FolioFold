/* Visual Editor 2026-09-09 repair layer.
 * Keeps the existing iframe editor intact while fixing the canvas boundary,
 * normalising positions before they reach design.json, and adding reliable
 * text/Px controls. This file owns Design-only interactions. */
(() => {
  const q = (s) => document.querySelector(s);
  // 排版编辑使用总览视口：保留真实桌面宽度比例，同时多显示一段内容，
  // 方便比较整个框架而不是只看 Hero / Experience 的开头。
  const DESKTOP = { width: 1280, height: 1200 };
  const MOBILE = { width: 390, height: 844 };
  let mode = 'desktop';

  function canvas() { return q('#ve-canvas'); }
  function virtualSize() { return mode === 'mobile' ? MOBILE : DESKTOP; }
  function ensureStage() {
    const frame = canvas();
    const wrap = frame && frame.parentElement;
    if (!frame || !wrap) return null;
    let stage = q('#ve-canvas-stage');
    if (!stage) {
      stage = document.createElement('div');
      stage.id = 've-canvas-stage';
      frame.before(stage);
      stage.appendChild(frame);
    } else if (!stage.contains(frame)) {
      // 外壳现在由 visual-editor.js 在首屏 HTML 里预先建好，正常情况下走不到这里。
      // 真走到这里说明 iframe 被别处挪走了：只能搬一次 —— ⚠ 搬动 iframe 会让浏览器
      // 重新加载它的文档，所以绝不能把它放在每次重排都会走的路径上（这就是以前
      // "画布莫名刷新一次" 的根因）。只在真的不在壳里时才搬。
      stage.appendChild(frame);
    }
    return stage;
  }
  /* 量画布内容的真实高度。
   * 画布高度**必须跟着内容长**：旧实现把画布写死成「1280×1200 的窗口」，
   * 页面超过 1200px 的部分会被 #ve-canvas-stage 的 overflow:hidden 裁掉 ——
   * 而 Resume 区块、页脚、以及「目录与页脚间距」那根拖动杆恰恰都在页面最底部，
   * 于是用户看到的现象是"那根杆不见了 / 脚注间距调不了"。
   * 宽度仍按真实桌面宽 1280 折算缩放比例（保证排版比例与发布版一致），高度取实际内容高。 */
  function measureContentH(frame, minH) {
    try {
      const doc = frame.contentDocument;
      if (!doc) return minH;
      const de = doc.documentElement, bd = doc.body;
      // ⚠ 2026-09-26 人工回归：这里**不能**用 de/body 的 scrollHeight。
      //   fitCanvas() 刚把 frame.style.height 写成上一轮量到的 contentH，而画布内部的
      //   html/body 是 100% 高度 —— 于是 scrollHeight 恒等于 iframe 高度，下一轮又量到
      //   同一个数。结果就是画布容器「只增不减」：底部留白从 600 调回 20 后，内容确实
      //   矮了（shell 2378→1798），画布外壳却还停在 2778，下方空出一大片，
      //   用户看到的就是「改了半天一点反应都没有」。
      //   .shell 的高度 / offsetHeight 才是内容真实高度（实测能正确回落）。
      const shell = doc.querySelector('.shell');
      const shellH = shell ? Math.max(shell.scrollHeight || 0, shell.getBoundingClientRect().height || 0) : 0;
      return Math.max(minH, Math.ceil(Math.max(shellH,
        de ? de.offsetHeight : 0,
        bd ? bd.offsetHeight : 0)));
    } catch (_) { return minH; }
  }
  function fitCanvas() {
    const frame = canvas(); const stage = ensureStage();
    if (!frame || !stage) return;
    const wrap = stage.parentElement; const v = virtualSize();
    const usableW = Math.max(260, wrap.clientWidth - 28);
    const contentH = measureContentH(frame, v.height);
    // 缩放只由宽度决定；高度交给内容，中部容器改为可滚动（见 visual-editor.css）
    const scale = Math.min(usableW / v.width, 1);
    stage.style.width = Math.round(v.width * scale) + 'px';
    stage.style.height = Math.round(contentH * scale) + 'px';
    frame.style.width = v.width + 'px';
    frame.style.height = contentH + 'px';
    frame.dataset.veContentH = String(contentH);
    frame.style.transform = `scale(${scale})`;
    frame.style.transformOrigin = 'top left';
    frame.dataset.veScale = String(scale);
    frame.classList.toggle('ve-cv-mobile', mode === 'mobile');
    frame.classList.toggle('ve-cv-desktop', mode !== 'mobile');
    const doc = frame.contentDocument; const shell = doc?.querySelector('.shell');
    const images = doc?.defaultView?.__veImages;
    if (shell && Array.isArray(images)) images.forEach(image => {
      const el = doc.querySelector(`[data-ve-img="${CSS.escape(String(image.id))}"]`);
      // v3 容器锚点图由画布内 VE_renderFreeLayer 自己按容器折算定位，这里不要再按整页覆盖
      if (el && image.aKind) return;
      if (el && image.xPct != null && image.yPct != null) {
        el.style.left = Math.round(image.xPct * shell.clientWidth) + 'px';
        el.style.top = Math.round(image.yPct * shell.clientHeight) + 'px';
      }
    });
    try {
      const metrics = frame.contentWindow && frame.contentWindow.__veDirect && frame.contentWindow.__veDirect.getCanvasMetrics
        ? frame.contentWindow.__veDirect.getCanvasMetrics() : null;
      if (metrics) window.postMessage({ type: 've-canvas-metrics', metrics }, '*');
    } catch (_) {}
    // ★ 2026-09-23：宽度变了 → 让画布把「自由摆放的图」按新宽度重算几何。
    //   ⚠ 漏了这一步的后果实测过：1280 → 390 之后，那张自由摆放的图还带着
    //   left:775px（1280 时代算出来的值）停在 390 宽的画布外边 = 用户看到
    //   「AI Lab 底下的图片不见了」。放在最后发，确保前面已经把新宽度写进 iframe。
    try { frame.contentWindow.postMessage({ type: 've-relayout-free' }, '*'); } catch (_) {}
  }
  function setMode(next) {
    mode = next === 'mobile' ? 'mobile' : 'desktop';
    try { localStorage.setItem('ve-cv-mode', mode); } catch (_) {}
    q('#ve-cv-mobile')?.classList.toggle('primary', mode === 'mobile');
    q('#ve-cv-desktop')?.classList.toggle('primary', mode === 'desktop');
    fitCanvas();
  }
  function postStyle(prop, value) {
    const selection = typeof veSelection !== 'undefined' ? veSelection : null;
    if (!selection || !selection.path) { typeof toast === 'function' && toast('请先在画布中选中文字'); return; }
    const frame = canvas();
    frame?.contentWindow?.postMessage({ type: 've-apply-inline', prop, value, scope: selection.scope || 'field' }, '*');
  }
  function installTextExtras() {
    const row = q('.ve-tb-iconrow');
    if (!row || row.dataset.fixed === '1') return;
    row.dataset.fixed = '1';
    const align = [...row.querySelectorAll('[data-act="al"],[data-act="ac"],[data-act="ar"]')];
    const reset = row.querySelector('[data-act="reset"]');
    const font = row.querySelector('#tl-fs-v');
    if (font && !q('#tl-fs-input')) {
      const input = document.createElement('input');
      input.id = 'tl-fs-input'; input.type = 'number'; input.min = '8'; input.max = '200';
      input.value = String(parseInt(font.textContent, 10) || 16); input.title = '字体大小（px）';
      font.replaceWith(input);
    }
    const alignRow = document.createElement('div'); alignRow.className = 've-tb-align-row';
    alignRow.innerHTML = '<span>文本对齐</span>';
    align.forEach(button => alignRow.appendChild(button));
    if (reset) alignRow.appendChild(reset);
    row.after(alignRow);
  }
  function normalisePixel(payload) {
    const frame = canvas(); const doc = frame?.contentDocument;
    const hero = doc?.querySelector('.hero'); const px = payload.pixel;
    if (!hero || !px || px.x == null || px.y == null) return;
    const w = Math.max(1, hero.clientWidth), h = Math.max(1, hero.clientHeight);
    payload.pixel = Object.assign({}, px, { xPct: Math.max(0, Math.min(1, +px.x / w)), yPct: Math.max(0, Math.min(1, +px.y / h)), x: null, y: null });
  }
  function normaliseImages(payload) {
    const frame = canvas(); const doc = frame?.contentDocument; const shell = doc?.querySelector('.shell');
    if (!shell || !Array.isArray(payload.images)) return;
    const w = Math.max(1, shell.clientWidth), h = Math.max(1, shell.clientHeight);
    payload.images = payload.images.map(image => {
      if (!image || image.x == null || image.y == null) return image;
      return Object.assign({}, image, { xPct: Math.max(0, Math.min(1, +image.x / w)), yPct: Math.max(0, Math.min(1, +image.y / h)), x: null, y: null });
    });
  }

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 've-pixel-path') { event.stopImmediatePropagation(); typeof toast === 'function' && toast('活动轨迹已改为 Hero 下方固定横线，无需手绘。'); return; }
    if (data.type === 've-pixel-update') normalisePixel(data);
    if (data.type === 've-commit-images') normaliseImages(data);
    // 间距/图片尺寸一改，页面高度就变（页脚、间距杆跟着往下走）→ 立刻重排画布高度，
    // 否则新长出来的那一段会有最多 0.8 秒被裁在可视区外（拖动时看起来"下面那根杆不见了"）。
    const _t = data.type || '';
    if (_t === 've-commit-space' || _t === 've-set-spacing-key' ||
        _t === 've-commit-image' || _t === 've-commit-images' ||
        _t === 've-commit-media-item' || _t === 've-commit-media-items') {
      setTimeout(fitCanvas, 60); setTimeout(fitCanvas, 600);
    }
  }, true);
  document.addEventListener('input', (event) => {
    if (event.target?.id === 'tl-fs-input') {
      const value = Math.max(8, Math.min(200, Number(event.target.value) || 16));
      event.target.value = String(value); postStyle('fontSize', value + 'px');
    }
  }, true);
  window.addEventListener('resize', fitCanvas);
  // 图片、字体、展开/收起区块都会在加载完之后改变页面高度；画布高度得跟着走，
  // 否则新长出来的底部内容（页脚 / 间距杆）又会被裁掉。变化 >6px 才重排，避免抖动。
  let fitTimer = null;
  function watchCanvasSize() {
    if (fitTimer) clearInterval(fitTimer);
    fitTimer = setInterval(() => {
      const frame = canvas(); if (!frame) return;
      const want = measureContentH(frame, virtualSize().height);
      if (Math.abs(want - Number(frame.dataset.veContentH || 0)) > 6) fitCanvas();
    }, 800);
  }
  const observer = new MutationObserver(installTextExtras);
  let wired = false;
  function initialize() {
    const frame = canvas(); const edit = q('#ve-edit');
    // visual-editor.js loads data asynchronously, so its DOM can appear after
    // this repair script's DOMContentLoaded callback.
    if (!frame || !edit) { setTimeout(initialize, 80); return; }
    if (!wired) {
      wired = true;
      try { mode = localStorage.getItem('ve-cv-mode') || 'desktop'; } catch (_) {}
      // Replace the legacy width-only handlers instead of layering on top of
      // them; otherwise their later inline-width reset undoes fitCanvas().
      const mobileButton = q('#ve-cv-mobile'); const desktopButton = q('#ve-cv-desktop');
      if (mobileButton) mobileButton.onclick = event => { event.preventDefault(); setMode('mobile'); };
      if (desktopButton) desktopButton.onclick = event => { event.preventDefault(); setMode('desktop'); };
      frame.addEventListener('load', fitCanvas);
      observer.observe(edit, { childList: true, subtree: true });
    }
    installTextExtras(); setMode(mode); watchCanvasSize();
  }
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', initialize);
  else initialize();
  window.__veFitCanvas = fitCanvas;
})();
