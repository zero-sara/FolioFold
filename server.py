"""Local-only FolioFold server: static files, safe draft/publish storage and media uploads."""
import base64
import cgi
import hashlib
import io
import json
import mimetypes
import os
import random
import re
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import traceback
import time
import zlib
import urllib.error
import urllib.request
import uuid
import zipfile
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse
from translation_providers import (
    TranslationProviderUnavailable,
    resolve_translation_provider,
    translation_provider_status,
)

# ============================================================================
# 出网层：代理探活 + 自动降级（2026-09-25 加）
# ----------------------------------------------------------------------------
# ⚠ 真实故障：Windows「系统代理」开着、但代理程序根本没在跑时，urllib 会忠实把每一个
#   对外 HTTPS 请求发往 127.0.0.1:<port>，拿到 [WinError 10061] 连接被拒。
#   后果是 GitHub Pages 与 CloudBase **同时全线发布失败**；更糟的是体检函数把这种
#   「连不出去」误判成「授权失效」，界面于是让用户「断开 GitHub → 重新连接 GitHub」——
#   用户照做多少次都解决不了，因为问题压根不在授权上。
#
# 修法（底层逻辑，对所有 Provider / 所有模板一律生效）：
#   ① 出网前先对代理做一次极短超时的 TCP 探活；不可达就**自动降级为直连**。
#   ② 万一代理「连得上但不干活」，请求失败时再**直连重试一次**，成功即永久降级。
#   ③ 「网络不可达」与「授权失效」必须分成两类错误，绝不再互相顶替。
#   ④ 当前出网方式写进 /api/deploy/status，界面能显示，用户有据可查。
# ============================================================================
_NET_LOCK = threading.Lock()
_NET = {'mode': 'direct', 'proxy': '', 'proxyAlive': None, 'downgraded': False,
        'note': '', 'checkedAt': 0.0}
_NET_TTL = 60.0          # 探活结论有效期（秒）；每次发布开始会强制刷新一次


def _net_proxy_urls():
    """(http_proxy, https_proxy)：环境变量优先，其次 urllib 读到的系统代理（Windows 注册表）。"""
    get = os.environ.get
    hp = (get('HTTP_PROXY') or get('http_proxy') or '').strip()
    sp = (get('HTTPS_PROXY') or get('https_proxy') or get('ALL_PROXY') or get('all_proxy') or '').strip()
    try:
        sysp = urllib.request.getproxies() or {}
    except Exception:
        sysp = {}
    return (hp or (sysp.get('http') or '')), (sp or (sysp.get('https') or sysp.get('http') or ''))


def _net_host_port(url):
    try:
        p = urlparse(url if '://' in url else 'http://' + url)
        return (p.hostname or ''), int(p.port or (443 if (p.scheme or '').lower() == 'https' else 80))
    except Exception:
        return ('', 0)


def _net_tcp_alive(host, port, timeout=1.0):
    if not host or not port:
        return False
    try:
        s = socket.create_connection((host, port), timeout=timeout)
        s.close()
        return True
    except Exception:
        return False


def _net_install(mode):
    """安装全局 opener：'proxy' 走已探活通过的代理，'direct' 完全不走代理。"""
    if mode == 'proxy':
        hp, sp = _net_proxy_urls()
        urllib.request.install_opener(urllib.request.build_opener(
            urllib.request.ProxyHandler({'http': hp, 'https': sp})))
    else:
        urllib.request.install_opener(urllib.request.build_opener(urllib.request.ProxyHandler({})))


def net_refresh(force=False):
    """决定生效的出网方式并安装全局 opener。返回 net_status() 快照。"""
    now = time.time()
    with _NET_LOCK:
        if not force and _NET['checkedAt'] and (now - _NET['checkedAt']) < _NET_TTL:
            return dict(_NET)
        hp, sp = _net_proxy_urls()
        chosen = (sp or hp or '').strip()
        if chosen:
            host, port = _net_host_port(chosen)
            if _net_tcp_alive(host, port):
                _NET.update({'mode': 'proxy', 'proxy': chosen, 'proxyAlive': True,
                             'downgraded': False, 'note': '正在使用系统代理 %s' % chosen})
            else:
                _NET.update({'mode': 'direct', 'proxy': chosen, 'proxyAlive': False,
                             'downgraded': True,
                             'note': '系统代理 %s 无法连接，已自动改为直连' % chosen})
        else:
            _NET.update({'mode': 'direct', 'proxy': '', 'proxyAlive': None,
                         'downgraded': False, 'note': '未设置代理，直连出网'})
        _NET['checkedAt'] = now
        snap = dict(_NET)
    try:
        _net_install(snap['mode'])
    except Exception:
        pass
    return snap


def net_status():
    with _NET_LOCK:
        return dict(_NET)


def net_hint():
    """网络类失败时给用户的可行动说明。绝不再让用户去「重新授权」。"""
    s = net_status()
    if s.get('downgraded'):
        return '（已检测到系统代理 %s 连不上，程序已自动改为直连；若仍失败，请检查网络，' \
               '或在 Windows「设置 → 网络和 Internet → 代理」里关掉这个已失效的代理。）' % (s.get('proxy') or '')
    if s.get('mode') == 'proxy':
        return '（当前正通过代理 %s 出网；若持续失败，请确认该代理可用。）' % (s.get('proxy') or '')
    return '（请检查本机网络连接是否正常。）'


def net_urlopen(req, timeout=None, _retry=True):
    """出网唯一入口。HTTP 状态码类错误（401/403/404…）原样上抛，只有「连不出去」才降级重试。"""
    def _fire_direct():
        """显式直连（绕过任何代理）。"""
        op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        return (op.open(req, timeout=timeout) if timeout is not None else op.open(req))
    # 主路径必须走 urlopen —— 它用的是 install_opener() 装好的全局 opener，
    # 而 build_opener() 每次都新建、根本不认全局设置（写成 build_opener() 会让降级失效）。
    try:
        if timeout is not None:
            return urllib.request.urlopen(req, timeout=timeout)
        return urllib.request.urlopen(req)
    except urllib.error.HTTPError:
        raise
    except Exception:
        st = net_status()
        # 只有「无正文 / 正文是 bytes」的请求才能安全重放；流式正文（大文件上传）重放会丢数据。
        body = getattr(req, 'data', None)
        if not (_retry and st.get('mode') == 'proxy'
                and (body is None or isinstance(body, (bytes, bytearray)))):
            raise
    try:
        r = _fire_direct()
    except urllib.error.HTTPError:
        raise
    except Exception:
        raise
    with _NET_LOCK:
        _NET.update({'mode': 'direct', 'proxyAlive': False, 'downgraded': True,
                     'note': '代理 %s 连得上但不通，已自动改为直连' % (st.get('proxy') or '')})
    try:
        _net_install('direct')
    except Exception:
        pass
    return r


# 模块加载就定一次出网方式。这样**任何入口**都不会被一个死掉的系统代理拖垮：
# HTTP 服务、命令行、乃至于别的脚本 `import server` 直接调 cb_request / gh_check_access。
# 只靠 publish_core 里那次刷新是不够的 —— 体检、状态查询这些入口根本不走 publish_core。
try:
    net_refresh(force=True)
except Exception:
    pass


ROOT = Path(__file__).resolve().parent
CONTENT = ROOT / 'content'
DRAFT = CONTENT / 'portfolio.json'
PREVIOUS = CONTENT / 'portfolio.previous.json'
PUBLISHED = CONTENT / 'portfolio.published.json'
DESIGN = CONTENT / 'design.json'
DESIGN_PREVIOUS = CONTENT / 'design.previous.json'
DESIGN_PUBLISHED = CONTENT / 'design.published.json'
MEDIA = ROOT / 'public' / 'media'
# —— 多模板 ——
# content/templates.json 是模板注册表；'main' 代表"模板一"，也就是升级前就存在的那套数据
# （仍是 content/ 根目录下的 portfolio.json / design.json，原地不动，升级零迁移、零丢失风险）。
# 模板二/三……放在 content/templates/<id>/ 下，各自一套 content+design，彼此完全独立。
# 媒体文件（public/media）仍然共用——照片/视频只是被引用的资源，没有必要每个模板各存一份。
TEMPLATES_DIR = CONTENT / 'templates'
TEMPLATES_INDEX = CONTENT / 'templates.json'
LEGACY_TPL_ID = 'main'
TPL_ID_RE = re.compile(r'^[a-z0-9][a-z0-9_-]{0,39}$')
SCHEMA_VERSION = 2
# —— 模板导出 / 导入：Template 与 Personal Content 分离 ——
# Personal Content  = portfolio.json（姓名 / 简介 / 经历 / 作品 / 联系方式 / 媒体本体引用）
# Template / Design = design.json（主题 / 字体 / 间距 / 布局 / 媒体排版位置 / 像素形象…）
# 导出的模板只含 Template，绝不含 Personal Content，也不含任何媒体本体（不打包图片视频）。
TEMPLATE_TYPE = 'folioframe-template'
TEMPLATE_VERSION = 1
TEMPLATE_SHARE = CONTENT / 'template-share.json'
# —— 自包含模板码 FF1-… ——
# 旧版 FF-XXXXXX 是「本机登记表 + 随机短码」：短码只在生成它的那台机器的
# content/template-share.json 里有意义，跨电脑必然失效。
# 新版把整份 Template 压进码本身：zlib 压缩 + base64url + CRC32 自校验。
# 解析完全离线——不联网、不查服务器、不读登记表，所以能跨任意机器粘贴。
CODE_PREFIX = 'FF1'
CODE_HEADER = CODE_PREFIX + '-'
# —— 短码 FF2-…（2026-10-03 新增）——
# FF1 把「整份」design 压进码里，含逐项微调（某个标题 23px、某张图 18% 宽…），
# 结果是几百到上千字符，微信里一粘贴就是一大坨。用户要的是「能随口发给别人」的短码。
# FF2 只带**与内容无关的核心版式**：主题 / 明暗 / 区块顺序 / 间距 / 展示区 / 像素形象 / 模板名，
# 用定长二进制打包（不做 zlib——几十字节的数据压缩反而变大），典型长度 60~90 字符。
# FF1 保留为「完整码」：需要连逐项微调一起带走时用（或直接用模板文件）。
CODE_PREFIX_V2 = 'FF2'
CODE_HEADER_V2 = CODE_PREFIX_V2 + '-'
SHORT_VERSION = 1
# ⚠ 下面这些顺序表是**码的二进制协议**，只能在末尾追加，绝不能重排或插入 ——
#   改顺序 = 老码解出来的主题/区块全错位。真要改就升 SHORT_VERSION 并让旧版本仍能解。
SHORT_THEMES = ('light-01', 'light-02', 'light-03', 'light-04',
                'dark-01', 'dark-02', 'dark-03', 'dark-04')
SHORT_SECTIONS = ('about', 'education', 'experience', 'works', 'showreel', 'aiVoices')
SHORT_SPACING_KEYS = ('topSpace', 'heroNameGap', 'heroPad', 'metaTop',
                      'dirGap', 'entryGap', 'footerTop', 'footerBottom')
SHORT_HERO_KEYS = ('eyebrow', 'name', 'role', 'intro')
SHORT_SECONDARY_KEYS = ('about', 'highlights', 'education', 'skills',
                        'contactLinks', 'publicLinks', 'audioIntro')
# 区块顺序属于「页面模板结构」，权威位置是 design.json；portfolio.json 里的
# data.sections 是历史遗留位置，只在 design 里没有顺序时作为回退读取。
SECTION_ORDER_KEY = 'sectionOrder'
# 这些 design 字段不进模板：images 直接指向个人图片，其余是元数据
DESIGN_EXCLUDE_KEYS = {'images', 'savedAt', 'schemaVersion', 'designVersion'}
# 「纯排版」字段：改这些属于所见即所得的排版微调，保存时自动同步到「已发布」的 design，
# 不需要用户再手动点一次「更新到最新版本」。（theme / typography 是有意排除的：
# 换主题会改变整站观感，算成品内容层面的决定，仍走手动发布。）
LAYOUT_KEYS = ('spacing', 'imgSizes', 'mediaLayout', 'mediaItems',
               'textStyles', 'inlineStyles', 'removedStatic', 'staticText',
               'sectionOrder', 'pixel', 'imgPos', 'displayZones')
# —— 展示区（Display Zones）：hero 主展示区 + hero 下方次展示区 ——
# ⚠ 这是**系统级能力**，对所有模板生效 —— 它是 Design 的一部分，随模板导出/导入一起走，
#    不是某个模板的私有字段，也不是 portfolio.json 的内容（它回答"怎么排"，不是"写了什么"）。
# 需求要点（用户原话）：主展示区最多 4 项，位置固定、字号不变；
#   次展示区最多 4 项；没被选进任一展示区的资料必须回落 About 区块并自适应重排，不能留空洞。
# 候选合计 11 项 —— 正好是"资料（about）里除去 resume"的全部条目，外加音频介绍（audioIntro）。
ZONE_MAX = 4
ZONE_HERO_KEYS = ('eyebrow', 'name', 'role', 'intro')
ZONE_SECONDARY_KEYS = ('about', 'highlights', 'education', 'skills',
                       'contactLinks', 'publicLinks', 'audioIntro')
ZONE_DEFAULT = {'hero': list(ZONE_HERO_KEYS),
                'secondary': ['contactLinks', 'publicLinks', 'skills']}


def norm_display_zones(raw):
    """展示区配置归一化：容错 + 去重 + 限长 + 跨区去重。

    前端有一份同款实现（display-zones.js FF_ZONES.resolve），两边口径必须一致。
    为什么服务端也要做：design.json 是磁盘上的文件，可能被手改、可能来自旧模板、
    也可能来自别的机器导入的模板 —— 服务端必须在写盘前把形状校正干净，
    不能指望前端一定发来对的数据。
    ⚠ 任何脏数据都要退化到一个**能安全渲染**的形状，绝不抛异常。
    """
    if not isinstance(raw, dict):
        raw = {}
    out = {}
    for zone, allowed, dflt in (('hero', ZONE_HERO_KEYS, ZONE_DEFAULT['hero']),
                                ('secondary', ZONE_SECONDARY_KEYS, ZONE_DEFAULT['secondary'])):
        src = raw.get(zone)
        is_arr = isinstance(src, (list, tuple))
        if not is_arr:
            # ① 这个区从来没被配置过 / 类型不对 → 用出厂默认
            out[zone] = list(dflt)
            continue
        items, seen = [], set()
        for k in src:
            k = str(k)
            if k in allowed and k not in seen:
                seen.add(k)
                items.append(k)
        # 同一项不能同时出现在两个区 —— hero 是人名牌，优先级更高
        if zone == 'secondary':
            items = [k for k in items if k not in out.get('hero', [])]
        items = items[:ZONE_MAX]
        if not items:
            # ② 过滤后什么都不剩：hero 不允许空（一个人名牌什么都不显示只会留下空白），
            #    回落到默认；secondary 空 = "统统放回 About 区块"，是用户可以选择的合法状态。
            items = list(dflt) if zone == 'hero' else []
        out[zone] = items
    return out
# —— 公网部署（GitHub Pages 默认 + CloudBase 备选）——
# 全部用官方 REST/HTTP API 实现（纯标准库 urllib，无需 wrangler / Node / npm / 数据库）。
# 密钥只存本地、且 gitignored 的 .folioframe/ 下，绝不写进
# content/portfolio.json / design.json / 模板 / 导出的 HTML / 导出的 ZIP / JS，也不进 git。
DEPLOY_DIR = ROOT / '.folioframe'
PUBLIC_LINK = CONTENT / 'public-link.json'
# 单文件大小上限：超过则阻止发布到免费静态托管，并明确提示用户改用外链。
# （免费静态托管对单文件/总体积普遍有约束，这里给一个稳妥的兜底阈值。）
DEFAULT_MAX_FILE_BYTES = 100 * 1024 * 1024

# —— 公网部署 Provider 抽象（PublishProvider）——
# 当前实现：github（默认，唯一开箱即用）、cloudbase（备选，需自备腾讯云配置）。
# 新增渠道只需实现子类并注册到 PUBLISH_PROVIDERS，无需改写发布核心（Publish Core → Provider）。
PUBLISH_PROVIDERS = {}   # 在文件末尾填充（避免前向引用）

# —— 发布诊断：磁盘日志 + 实时阶段/字节进度 ——
# 为什么必须有：发布一个大视频要跑好几分钟（实测 67MB 视频 = 449 秒），期间面板上只有
# 一句「发布中…」；而失败原因以前只 print 到那个黑色控制台窗口，窗口一关就再也查不到，
# 同一个问题只能反复远程猜。这里把每一步都落到 .folioframe/publish.log，并把当前阶段
# 暴露给 /api/deploy/status，让面板能显示「正在上传 xxx（42%）」而不是干等。
PUBLISH_LOG = DEPLOY_DIR / 'publish.log'


def pub_log(msg):
    """写一行带时间戳的发布日志（失败也不影响主流程）。"""
    try:
        DEPLOY_DIR.mkdir(parents=True, exist_ok=True)
        with open(PUBLISH_LOG, 'a', encoding='utf-8') as f:
            f.write('%s %s\n' % (time.strftime('%Y-%m-%d %H:%M:%S'), msg))
        try:
            if PUBLISH_LOG.stat().st_size > 400000:   # 超 400KB 只留最后 300 行，避免无限增长
                tail = PUBLISH_LOG.read_text(encoding='utf-8', errors='replace').splitlines()[-300:]
                PUBLISH_LOG.write_text('\n'.join(tail) + '\n', encoding='utf-8')
        except Exception:
            pass
    except Exception:
        pass


# 当前发布进度（本地单用户服务，模块级字典足够）。sent/total 是**已发送字节**，
# 由 gh_push_files 的上传体回调实时累加（见 _ProgressBody）。
PUBLISH_JOB = {'running': False, 'phase': '', 'detail': '', 'current': '',
               'sent': 0, 'total': 0, 'startedAt': 0.0, 'finishedAt': 0.0,
               'ok': None, 'error': ''}


def pub_job_begin(phase='', detail=''):
    PUBLISH_JOB.update({'running': True, 'phase': phase, 'detail': detail, 'current': '',
                        'sent': 0, 'total': 0, 'startedAt': time.time(),
                        'finishedAt': 0.0, 'ok': None, 'error': ''})


def pub_job_phase(phase, detail=''):
    PUBLISH_JOB.update({'phase': phase, 'detail': detail})


def pub_job_file(phase, current, detail='', total=0):
    PUBLISH_JOB.update({'phase': phase, 'current': current, 'detail': detail,
                        'sent': 0, 'total': total})


def pub_job_end(ok, error=''):
    PUBLISH_JOB.update({'running': False, 'ok': bool(ok), 'error': str(error)[:500],
                        'finishedAt': time.time(), 'sent': 0, 'total': 0, 'current': ''})


def pub_job_state():
    _pub_job_watchdog()
    d = dict(PUBLISH_JOB)
    st = d.get('startedAt') or 0
    d['elapsed'] = round(time.time() - st, 1) if (d.get('running') and st) else 0
    return d


# 单次发布允许的最长墙钟时间。超时后不再干等，直接判定为超时并给出可行动的指引。
PUB_JOB_STALL_SECONDS = 15 * 60


def _pub_job_watchdog():
    """发布状态的看门狗：保证 PUBLISH_JOB 永远不会停在 running=True 上下不来。

    为什么必须有：发布线程理论上总会走到 pub_job_end，但真实网络里 urllib 的 timeout
    是**单次 socket 操作**的超时，不是整个请求的超时 —— 对端一边慢一边吐字节时，
    read() 每次都不到超时阈值，线程就会被挂住很久而不抛异常。

    实测（2026-09-18）真实踩到：git push 已成功、GitHub Pages 也已完成重建、
    线上站点其实已经更新，但发布后的远端校验请求把线程挂住 15 分钟以上，
    结果是面板一直显示「发布中…」、网址也没有落盘成「✓ 已更新」——
    用户看到的是一个没有原因、也不知道要不要重试的失败。

    这里是最后一道兜底：超过阈值还没有结果就收敛为超时失败，
    并明确告诉用户「先去看网址，页面已是新的就不用重发」。
    """
    j = PUBLISH_JOB
    if not j.get('running'):
        return
    st = j.get('startedAt') or 0
    if not st or (time.time() - st) <= PUB_JOB_STALL_SECONDS:
        return
    pub_log('发布超时兜底：startedAt 至今 %.0f 秒无结果，判定为超时' % (time.time() - st))
    j.update({'running': False, 'ok': False,
              'error': ('发布超过 %d 分钟仍没有结果，已判定为超时。这通常意味着 GitHub 的确认请求被网络拖住了，'
                        '并不一定代表没发布成功 —— 请先打开公开网址确认页面是否已经更新：'
                        '如果页面已经是新的，就不需要再更新了。'
                        % int(PUB_JOB_STALL_SECONDS // 60)),
              'finishedAt': time.time(), 'sent': 0, 'total': 0, 'current': ''})


def cleanup_stale_bundles(max_age_hours=6):
    """清理发布残留的临时打包目录（_bundle_gh_* / _bundle_cb_*）。

    正常路径里这些目录用完就会被 _rmtree_forgiving 删掉；但发布线程中途被挂起 /
    进程被强杀时它们会留在磁盘上。实测本机累积了 5 个共约 330 MB ——
    每个里面都有一份 67 MB 的视频副本，放久了很占地方，且没有任何用途。

    只认这两个前缀，且只清理超过 max_age_hours 的；
    绝不碰 _repo_gh（那里存着 git 对象，是二次发布只需 11 秒而不是 117 秒的原因）。
    """
    try:
        base = DEPLOY_DIR
        if not base.exists():
            return 0
        now = time.time()
        removed = 0
        for p in base.iterdir():
            if not p.is_dir():
                continue
            if not (p.name.startswith('_bundle_gh_') or p.name.startswith('_bundle_cb_')):
                continue
            try:
                age_h = (now - p.stat().st_mtime) / 3600.0
            except Exception:
                continue
            if age_h < max_age_hours:
                continue
            if age_h < max_age_hours:
                continue
            _rmtree_forgiving(p)
            if not p.exists():
                removed += 1
                pub_log('清理残留临时打包目录：%s' % p.name)
        return removed
    except Exception as e:
        pub_log('清理残留打包目录失败（不影响启动）：%s' % e)
        return 0


def _brief_url(u):
    """日志里的 URL 去掉 query，避免把 token 之类的参数写进日志。"""
    try:
        return str(u).split('?')[0]
    except Exception:
        return ''


class _ProgressBody:
    """把上传正文包一层，边发边报字节数。

    http.client 原生支持 file-like body（按 blocksize 分块 read + sendall），且会调用
    len(body) 得到 Content-Length —— 所以对 GitHub 来说这就是一个普通请求，
    我们却能实时知道「发了多少 / 一共多少」，面板才能显示真实进度条。
    上传失败时 gh_push_files 会回退到普通正文（见那里的注释）。"""
    def __init__(self, data, job=None, content_type='application/json'):
        self._buf = io.BytesIO(data)
        self._len = len(data)
        self._job = job if job is not None else PUBLISH_JOB
        self.content_type = content_type

    def __len__(self):
        return self._len

    def read(self, n=-1):
        chunk = self._buf.read(n)
        if chunk:
            try:
                self._job['sent'] = self._job.get('sent', 0) + len(chunk)
                self._job['total'] = self._len
            except Exception:
                pass
        return chunk



# —— GitHub Pages Provider（OAuth 授权 + 仓库/ Pages / 大媒体 Release Assets）——
# 仅用 GitHub 官方 REST API（纯标准库 urllib，无第三方依赖）。
# 授权态只存本地、且 gitignored 的 .folioframe/gh.json，绝不写进
# content/portfolio.json / design.json / 仓库 / 导出的 HTML / JS，也不进 git。
GH_API = 'https://api.github.com'
GH_UPLOAD = 'https://uploads.github.com'
# 本地应用没有公网回调地址，OAuth 用回环回调。
# GitHub 官方（RFC 8252）明确建议：不要用 "localhost"，而用回环字面量 "127.0.0.1"（或 IPv6 ::1），
# 且 redirect_uri 的端口不必与登记的回调端口一致。见 OAuth App 文档 "Loopback redirect urls"。
GH_CALLBACK = 'http://127.0.0.1:3000/api/github/callback'
GH_TOKEN_FILE = DEPLOY_DIR / 'gh.json'          # {token, login, expires_at, via}
GH_APP_FILE = DEPLOY_DIR / 'gh-app.json'         # {client_id, client_secret}（可选：自带 OAuth App 的高级模式）
GH_STATE_FILE = DEPLOY_DIR / 'gh-state.json'     # OAuth state 防 CSRF

# —— Device Flow（RFC 8628）：默认授权方式，普通用户无需创建任何 GitHub App ——
# 关键依据（GitHub 官方文档）："The client_secret is not needed for the device flow."
# 因此 FolioFold 只需内置一个公开的 client_id（公开客户端标识，非机密），
# 全程不产生、也不需要 client_secret，更不会把任何机密写进前端 / 仓库 / 导出包。
# 这是把用户从 Level 4（自己建 OAuth App）降到 Level 1（只点登录/授权）的唯一官方途径。
GH_DEVICE_CODE_URL = 'https://github.com/login/device/code'
GH_DEVICE_TOKEN_URL = 'https://github.com/login/oauth/access_token'
GH_DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
GH_DEVICE_FILE = DEPLOY_DIR / 'gh-device.json'   # {device_code, user_code, verification_uri, expires_at, interval}（短时，仅本机）
# ======================= GitHub 授权：公共 OAuth App + Device Flow（默认方案）=======================
# 产品模型（2026-09-16 正式切换）：
#   用户下载 FolioFold → 点「连接 GitHub」→ 在 GitHub 页面输入 8 位设备码 → 授权自己的账号
#   → 点 Publish → FolioFold 自动在该用户名下创建仓库、自动启用 GitHub Pages → 返回公开网址。
#   普通用户【不需要】注册 OAuth App、不需要 Client Secret、不需要手动建仓库 / 配 Pages / 传文件。
#
# ⚠ 硬性前提：内置的公共 client_id 必须属于一个 **OAuth App**，不能是 GitHub App。
#   实测依据（2026-09-16，真实 API 响应，不是靠令牌前缀猜的）：
#     · GitHub App 的 device flow 令牌前缀 ghu_，X-OAuth-Scopes 头为空，/user/installations 返回 200，
#       POST /user/repos → 403 {"message":"Resource not accessible by integration"}（永远建不了仓库），
#       且官方规定 ghu_ 仅 8 小时有效。
#     · OAuth App 的令牌前缀 gho_，X-OAuth-Scopes 含 repo，POST /user/repos 可通过鉴权层，且长期有效。
#   注册（FolioFold 发布方一次性、约 2 分钟）：github.com/settings/developers → New OAuth App
#     Application name            = FolioFold
#     Homepage URL                = http://127.0.0.1:3000
#     Authorization callback URL  = http://127.0.0.1:3000/api/github/callback
#     勾选 Enable device flow（OAuth App 走设备码授权必须先勾上）
#   → 把页面上方的 Client ID 填到下面。
#   Client ID 是**公开标识**（不是机密），可以安全内置进产品；Client Secret 永远不需要、也绝不内置。
FOLIOFRAME_PUBLIC_CLIENT_ID = os.environ.get('FOLIOFRAME_GH_CLIENT_ID') or 'Ov23lipiRnRbi1Dcdzhb'
# 兼容旧引用名：空字符串 = 尚未内置公共 Client ID，此时前端会给出明确的配置指引。
GH_DEVICE_CLIENT_ID = FOLIOFRAME_PUBLIC_CLIENT_ID
# Device Flow 需要的 OAuth scope：repo = 读写用户仓库（含新建仓库）；workflow = 需要时推 Actions workflow。
GH_DEVICE_SCOPE = 'repo workflow'
# GitHub 普通 Git 仓库单文件硬上限 100MB（且 Contents API 仅支持 ≤1MB）；
# 超过此安全线的媒体不入仓库（避免推送失败 / Pages 构建失败），改走 GitHub Release Assets。
# 单文件体积阈值：**十进制 90 MB**，刻意跟用户设备上的显示口径一致。
# 曾经的坑：代码按 1024*1024 算、面板写"143.9 MB"，而手机 / 微信 / 浏览器下载器按 1000*1000 算、
# 显示"150.8 MB" —— 同一个文件两个数字，用户会以为是"被压缩过 / 上传失败"。
# 现在统一按 1 MB = 1,000,000 字节（format_mb）算，页面上写多少，用户在自己设备上就看到多少。
# GitHub 的硬上限是 100 MiB（= 104.86 MB），取 90 MB 留足余量。
GH_REPO_MAX_BYTES = 90 * 1000 * 1000
# ⚠ 2026-10-06 发布收口（Release Hardening）：GitHub 发布仓库名钉死。
# 旧逻辑在「上次发布不是 GitHub」时按 profile.name 的 slug 自动派生仓库名 ——
# tpl-2（FolioFold Demo）的名字是 "FolioFold"，会派生出已弃用的 foliofold 仓，
# 导致 Demo 误发到旧仓库。现在统一回落到 GH_PUBLISH_REPO，且永不复用
# GH_PUBLISH_REPO_DEPRECATED（foliofold，已弃用，只读保留）。
# 2026-10-08：默认发布仓库由 FolioFrame 统一更名为 FolioFoldPages（旧名仅作历史记录）。
GH_PUBLISH_REPO = 'FolioFoldPages'
GH_PUBLISH_REPO_DEPRECATED = 'foliofold'

def format_mb(nbytes, digits=1):
    """人类可读体积：**十进制 MB**（1 MB = 1,000,000 字节）。
    刻意不用 MiB —— 手机、微信、浏览器下载管理器全都是十进制显示，
    面板跟它们用同一套算法，用户才不会看到"同一个文件两个大小"。"""
    try:
        return round(float(nbytes) / 1000000.0, digits)
    except Exception:
        return 0.0
GH_RELEASE_TAG = 'folioframe-media'              # 大媒体固定 release tag（多次发布复用同一 release）
# 导出 ZIP 时，超过这个体积的媒体**默认不复制进包**（否则一个 400MB 视频会让 ZIP 大到没法用），
# 但会在 folioframe-export.json 与 README.txt 里逐条列出，让用户知道"少了什么、怎么办"。
# 与 GH 阈值同源（90MB 十进制），保证"能发布的就能导出"。
LARGE_MEDIA_SKIP_BYTES = GH_REPO_MAX_BYTES
# 导出 ZIP 时，"打进来了但超过国内平台常见单文件上限"的告警阈值（25 MB 十进制）。
# 常见平台单文件上限：Cloudflare Pages 25 MiB、EdgeOne Pages 25MB、Gitee 50MB。
LARGE_MEDIA_WARN_BYTES = 25 * 1000 * 1000
GH_ASSET_TIMEOUT = 1800                          # 单个 Release Asset 上传的 socket 超时（秒）
GH_ASSET_RETRIES = 3                             # 单个 asset 的上传重试次数（传入不可续传，重试=整份重传）
# 进仓库的媒体（<90MB，可在 Pages 上内联播放）走 git/blobs，同样需要放大超时：
# base64 后体积 ×1.33，70MB 视频 = 93MB 请求体，默认 120s 在慢速上行链路上必然超时。
GH_PUSH_TIMEOUT = 900

# 未配置任何授权方式时的兜底说明页。默认路径已改为 Device Flow（无需 OAuth App），
# 这一页只在「自带 OAuth App」的高级模式被显式选中、却没填 Client ID 时出现。
GH_APP_HINT = '''<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8">
<title>开发者选项：自带 OAuth App</title><style>body{font-family:system-ui,'Segoe UI',sans-serif;max-width:680px;margin:48px auto;padding:0 20px;line-height:1.7;color:#222}
code{background:#f1f1f4;padding:2px 6px;border-radius:4px;font-size:13px}
h1{font-size:20px}.box{border:1px solid #e3e3e8;border-radius:10px;padding:16px 18px;background:#fafafb;margin:14px 0}
a{color:#0969da}.warn{color:#9a6700}</style></head><body>
<h1>开发者选项：自带 OAuth App</h1>
<p><b>普通用户不需要这一页</b> —— 直接回 FolioFold 点「连接 GitHub」即可（走内置公共 OAuth App 的设备码授权，无需自建任何应用）。</p>
<p>只有在你希望使用自己的 GitHub OAuth App 身份时才需要下面这些步骤：</p>
<div class="box">
<ol>
<li>打开 <a href="https://github.com/settings/developers" target="_blank" rel="noopener">github.com/settings/developers</a> → <b>New OAuth App</b>。</li>
<li><b>Homepage URL</b> 填 <code>http://127.0.0.1:3000</code>。</li>
<li><b>Authorization callback URL</b> 填 <code>''' + GH_CALLBACK + '''</code>（GitHub 允许回环端口变化，路径需一致）。</li>
<li>创建后得到 <b>Client ID</b> 与 <b>Client Secret</b>。</li>
<li>回到 FolioFold 发布面板「③ 公开链接 → GitHub Pages → 高级」，粘贴保存。</li>
</ol>
</div>
<p class="warn">安全边界：Client Secret 只存本机 <code>.folioframe/gh-app.json</code>（已 gitignore），用户令牌只存本机 <code>.folioframe/gh.json</code>，二者都不会写进作品集数据 / 网页 / 仓库，也不会发往任何第三方。FolioFold 没有自有服务器。</p>
<p><a href="/">← 返回 FolioFold</a></p>
</body></html>'''
DATA_IMAGE = re.compile(r'^data:(image/[\w.+-]+);base64,([A-Za-z0-9+/=\s]+)$', re.S)
DEFAULT_GROUPS = [
    {'id': 'original', 'title': 'Original Production', 'description': '原创 / 实际参与制作'},
    {'id': 'redesign', 'title': 'Film Sound Re-design', 'description': '基于已有影视素材进行声音重构与再设计，重点展示对白、音效、声音设计及多声道混音能力。'},
    {'id': 'music', 'title': 'Music / MV', 'description': '音乐与影像制作。'},
    {'id': 'other', 'title': 'Other Works', 'description': '其他声音与制作作品。'},
]

def read(path, fallback=None):
    try: return json.loads(path.read_text(encoding='utf-8'))
    except Exception: return fallback if fallback is not None else {}

def _same_file(a, b, chunk=1 << 20):
    """按块比对两个文件内容是否一致。用于跳过 67MB 视频的无谓复制。"""
    try:
        if a.stat().st_size != b.stat().st_size:
            return False
        with open(a, 'rb') as fa, open(b, 'rb') as fb:
            while True:
                x = fa.read(chunk)
                y = fb.read(chunk)
                if x != y:
                    return False
                if not x:
                    return True
    except Exception:
        return False


def _sync_tree(src, dst, skip=(), preserve=()):
    """把目录 src 增量同步到 dst：内容相同的文件**不重写**，dst 里多出来的条目删掉。

    为什么不用「rmtree 整个目录再 copytree」：持久化仓库目录里有 67MB 视频，
    每次发布都白删白写一遍（本地 I/O 几十秒）；更糟的是"先全删再重拷"一旦中途失败，
    下一次 git add -A 会把这次删除当成改动提交上去 → **线上视频被删**。
    这里逐文件比对（先比大小，大小相同再比内容），相同就跳过，安全又快。

    ⚠ skip 用来保护 dst 里的 .git（它不属于发布内容，绝不能被当成"多出来的条目"删掉）。

    ⚠ preserve（多模板共存用）：这些**顶层**条目即使 src 里没有也**不许删**。
    多模板发布是「同一个仓库、每个模板一个子目录」——发布模板二时 src 只有 v2/，
    若不保护就会把仓库里的 tpl-1/（模板一）当成"多出来的条目"整个删掉，
    等于把模板一的线上站点清空。只在**顶层**生效（子目录内部仍按发布内容清理，
    避免某个模板自己目录里残留旧文件）。
    注意：preserve 只在递归的第一层判断，递归调用时不传下去。"""
    src = Path(src)
    dst = Path(dst)
    dst.mkdir(parents=True, exist_ok=True)
    keep = set()
    for item in os.listdir(src):
        if item in skip:
            continue
        keep.add(item)
        s = src / item
        d = dst / item
        if s.is_dir():
            _sync_tree(s, d, skip)
            continue
        try:
            if d.is_file() and _same_file(s, d):
                continue
        except Exception:
            pass
        try:
            shutil.copy2(s, d)
        except Exception as e:
            pub_log('git sync 复制失败 %s：%s' % (item, e))
    # 删掉 dst 里 bundle 已经没有的条目（保持仓库快照 = 本次发布内容）
    for item in list(os.listdir(dst)):
        if item in skip or item in keep or item in preserve:
            continue
        p = dst / item
        try:
            if p.is_dir():
                _rmtree_forgiving(p)
            else:
                p.unlink()
        except Exception:
            pass


def _rmtree_forgiving(path):
    """删除目录树。shutil.rmtree 在部分环境（含某些沙箱/回收站重定向）会因
    SHFileOperationW 失败而抛异常；这里先正常删，失败则逐项 os.remove 兜底。

    ⚠️ 2026-09-22：必须连 BaseException 一起接，不能只接 Exception。
    环境里的 safe-delete 钩子（WorkBuddy 的 sitecustomize shim）在它的守卫失效时
    会 `raise SystemExit(1)`，而 SystemExit 是 BaseException、不是 Exception。
    漏掉它会让整个请求线程静默死掉：客户端只看到 "Empty reply from server"，
    而目录会留在磁盘上变成孤儿（模板列表里已经没了、磁盘上还在）。
    这个坑真实发生过 —— 三个回归用例因此报 socket hang up。"""
    try:
        shutil.rmtree(path)
        return
    except BaseException:
        pass
    try:
        entries = sorted(path.rglob('*'), key=lambda x: -len(x.parts))
    except BaseException:
        entries = []
    for p in entries:
        try:
            p.unlink()
        except BaseException:
            pass
    try:
        path.rmdir()
    except BaseException:
        pass

def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    # 关键修复：用 PID + 纳秒时间戳生成唯一临时文件名，避免并发保存（颜色工具触发高频 POST）
    # 时同名 .tmp 文件在 Windows 上被锁住导致的 "Permission denied: design.json.tmp" 崩溃。
    # 同时如果磁盘上残留旧的 .tmp 文件（上次异常退出留下的），先尝试清理。
    stale = path.with_suffix(path.suffix + '.tmp')
    try:
        if stale.exists():
            stale.unlink()
    except Exception:
        pass
    # 唯一 tmp 文件名：把 .tmp 换成 .tmp.PID.纳秒
    import time as _t
    for _attempt in range(3):
        temp = path.parent / (path.name + f'.tmp.{os.getpid()}.{int(_t.time_ns())}')
        try:
            temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
            break
        except PermissionError as e:
            # 极端情况：tmp 命名碰撞（同一纳秒内多进程）。再加一次纳秒戳。
            _t.sleep(0.001)
            continue
    else:
        # 兜底：直接写目标文件（无原子性，但能保证不阻塞保存）
        path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
        return
    # 用 os.replace 原子替换（Path.replace 在 Windows 下偶尔抛 PermissionError，加重试）
    for _attempt in range(3):
        try:
            os.replace(temp, path)
            break
        except PermissionError:
            _t.sleep(0.02)
    else:
        # 兜底：如果原子替换也失败（目标文件被读锁住），就回退到直接写
        try:
            temp.replace(path)
        except PermissionError:
            try:
                path.write_text(temp.read_text(encoding='utf-8'), encoding='utf-8')
            except Exception:
                pass
            try: temp.unlink()
            except Exception: pass

def now_iso():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())

def load_templates():
    """读取模板注册表；缺失或损坏时自动播种为只含「模板一」的列表。"""
    data = read(TEMPLATES_INDEX, None)
    if not isinstance(data, dict) or not isinstance(data.get('items'), list):
        data = {'version': 1, 'items': []}
    items = [it for it in data['items'] if isinstance(it, dict) and it.get('id')]
    # 模板一（main）永远存在，且永远排在第一位
    if not any(it.get('id') == LEGACY_TPL_ID for it in items):
        items.insert(0, {'id': LEGACY_TPL_ID, 'name': '模板一', 'legacy': True, 'createdAt': now_iso()})
    data['items'] = items
    data.setdefault('version', 1)
    return data

def save_templates(data):
    write(TEMPLATES_INDEX, data)

def tpl_exists(tpl_id):
    return tpl_id == LEGACY_TPL_ID or any(it.get('id') == tpl_id for it in load_templates()['items'])

def tpl_paths(tpl_id):
    """返回某个模板的 6 个数据文件路径。
    'main'（模板一）= content/ 根目录下已有的那套文件（原地不动）；
    其余模板 = content/templates/<id>/ 下的同名文件，互不影响。"""
    if not tpl_id or tpl_id == LEGACY_TPL_ID:
        return {'draft': DRAFT, 'previous': PREVIOUS, 'published': PUBLISHED,
                'design': DESIGN, 'designPrevious': DESIGN_PREVIOUS, 'designPublished': DESIGN_PUBLISHED}
    base = TEMPLATES_DIR / tpl_id
    return {'draft': base / 'portfolio.json', 'previous': base / 'portfolio.previous.json',
            'published': base / 'portfolio.published.json', 'design': base / 'design.json',
            'designPrevious': base / 'design.previous.json', 'designPublished': base / 'design.published.json'}

# —— GitHub Clone 开箱体验（2026-09-27 加入，2026-10-05 改为从 tpl-3 播种）——
# 仓库刻意「不入库」个人作品集（content/portfolio.json 等被 .gitignore 排除），只发布
# FolioFold 本体 + 干净的 Starter 模板（templates/tpl-3/）。新用户 Clone 后 content/portfolio.json
# 不存在，如果什么都不做，首次启动会得到一个「空壳」。这里在首次启动时，仅当用户自己还没有
# main 数据（content/portfolio.json 缺失）时，从内置 FolioFold Starter 模板（tpl-3）复制一份干净
# 的 main 数据；一旦用户已有自己的 portfolio.json，就绝不覆盖、也绝不每次启动重复复制。
def seed_main_from_demo():
    if DRAFT.exists():
        return  # 用户已有自己的 main 数据：绝不覆盖、绝不重置
    demo_base = TEMPLATES_DIR / 'tpl-3'
    if not demo_base.is_dir():
        return  # 没有内置 Demo 模板（极罕见）：保持原逻辑，由后续兜底
    demo_draft = demo_base / 'portfolio.json'
    demo_design = demo_base / 'design.json'
    demo_previous = demo_base / 'portfolio.previous.json'
    demo_published = demo_base / 'portfolio.published.json'
    if demo_draft.exists():
        write(DRAFT, read(demo_draft))
    if demo_design.exists():
        write(DESIGN, read(demo_design))
    if demo_previous.exists():
        write(PREVIOUS, read(demo_previous))
    if demo_published.exists():
        write(PUBLISHED, read(demo_published))
    if DRAFT.exists():
        print('FolioFold: 已从内置 FolioFold Starter 模板初始化 main 数据（content/portfolio.json）。')

# —— Phase 4（2026-09-26）：意外关闭恢复 ——
# 只做三件事：列出抢救副本 / 给出顶层差异摘要 / 白名单恢复（恢复前先备份当前草稿）。
# 绝不自动恢复、绝不删除任何文件、绝不碰 published / media / designPublished。
RESUCED_NAME_RE = re.compile(r'^portfolio\.(?:rescued-(?:prerestore-)?[0-9TZ]+|previous)\.json$')

def _recovery_list_rescued(tp):
    """列出该模板数据目录里的 portfolio.rescued-*.json（含 previous），按时间倒序。只读。"""
    out = []
    d = tp['draft'].parent
    try:
        if d.is_dir():
            for p in d.iterdir():
                if not RESUCED_NAME_RE.match(p.name):
                    continue
                try:
                    st = p.stat()
                except OSError:
                    continue
                out.append({'name': p.name, 'mtime': int(st.st_mtime), 'size': st.st_size})
    except OSError:
        pass
    out.sort(key=lambda x: -x['mtime'])
    return out

def _recovery_resolve(tp, name):
    """把用户给的文件名解析成该模板数据目录内的真实路径。
    白名单：只接受 portfolio.rescued-*.json / portfolio.previous.json，且必须就在数据目录里
    （防路径穿越）。返回 Path 或 None。"""
    if not name or not RESUCED_NAME_RE.match(str(name)):
        return None
    base = tp['draft'].parent.resolve()
    cand = (base / str(name)).resolve()
    if cand.parent != base or not cand.is_file():
        return None
    return cand

def _brief_titles(obj, key):
    """从 projects / experience 数组里抽标题（最多 6 个），帮用户认出这份内容是什么。"""
    arr = obj.get(key) if isinstance(obj, dict) else None
    if not isinstance(arr, list):
        return []
    out = []
    for it in arr[:6]:
        t = ''
        if isinstance(it, dict):
            t = str(it.get('title') or it.get('name') or '').strip()
        out.append(t[:40])
    return out

def _recovery_diff(src_obj, cur_obj):
    """顶层差异摘要：每个 key 标 新增/缺失/不同/一致；projects / experience 附标题样例。
    只是比较内存里的两个 dict，不写任何文件。"""
    src_obj = src_obj if isinstance(src_obj, dict) else {}
    cur_obj = cur_obj if isinstance(cur_obj, dict) else {}
    rows = []
    for key in sorted(set(src_obj) | set(cur_obj)):
        in_src, in_cur = key in src_obj, key in cur_obj
        entry = {'key': key, 'inRescued': in_src, 'inDraft': in_cur}
        if in_src and in_cur:
            same = json.dumps(src_obj[key], ensure_ascii=False, sort_keys=True, default=str) == \
                   json.dumps(cur_obj[key], ensure_ascii=False, sort_keys=True, default=str)
            entry['state'] = 'same' if same else 'changed'
        else:
            entry['state'] = 'onlyRescued' if in_src else 'onlyDraft'
        for tag, obj in (('rescuedTitles', src_obj), ('draftTitles', cur_obj)):
            if entry['state'] != 'same' and key in ('projects', 'experience'):
                entry[tag] = _brief_titles(obj, key)
        rows.append(entry)
    return rows

# —— Phase 4：环境检查（只读）——
# 分类固定四种：ok=正常 / fixable=可修复（有安全自动修复）/ optional=可选（不影响主功能）/ blocked=阻塞（只给人工建议）。
# 纯标准库 + 复用现有探测函数（ffmpeg_path / translation_provider_status），不引入新依赖。
ENV_REQUIRED_DIRS = [
    ('作品集数据 content/', CONTENT),
    ('媒体目录 public/media/', MEDIA),
    ('备份目录 _backups/', ROOT / '_backups'),
    ('配置目录 .folioframe/', DEPLOY_DIR),
]

def env_check_rows(port=0):
    rows = []
    # 1) Python：本服务就用当前解释器跑，检查版本即可（cgi 模块 3.13 起被移除）。
    v = sys.version_info
    py_ok = v >= (3, 11)
    rows.append({'id': 'python', 'label': 'Python 解释器',
                 'status': 'ok' if py_ok else 'fixable',
                 'detail': ('%d.%d.%d（满足 3.11+）' % (v.major, v.minor, v.micro)) if py_ok else
                           ('当前 %d.%d.%d：建议用 Python 3.11 启动（3.13 起标准库移除 cgi，功能会缺）。'
                            'FolioFold 启动.bat 已固定指向 3.11，用 bat 启动即可。' % (v.major, v.minor, v.micro))})
    # 2) 第三方依赖：server.py 是纯标准库实现，没有 pip install 依赖。
    rows.append({'id': 'deps', 'label': '第三方依赖',
                 'status': 'ok', 'detail': '无需安装任何 pip 包（纯 Python 标准库实现）。'})
    # 3) FFmpeg：可选组件，只影响视频压缩；缺失时已有「一键下载压缩组件」入口。
    ff = ffmpeg_path()
    rows.append({'id': 'ffmpeg', 'label': 'FFmpeg（视频压缩组件）',
                 'status': 'optional',
                 'detail': ('已找到：%s' % ff) if ff else
                           '未安装。只影响「视频压缩」功能，其余功能全部可用；在排版编辑的媒体卡片里点「下载压缩组件」即可自动安装。'})
    # 4) 关键目录 / 文件：缺失目录可安全创建（env-repair 只做 mkdir）；缺关键文件只报告。
    for label, p in ENV_REQUIRED_DIRS:
        exists = p.is_dir()
        rows.append({'id': 'dir:' + p.name, 'label': '关键目录 ' + label,
                     'status': 'ok' if exists else 'fixable',
                     'detail': ('存在' if exists else '缺失——可安全自动创建（只建目录，不写入任何内容）')})
    for label, rel in [('界面字典 i18n.js', 'i18n.js'), ('词典 i18n-zh-en.js', 'i18n-zh-en.js'),
                       ('模板注册表 content/templates.json', 'content/templates.json')]:
        exists = (ROOT / rel).is_file()
        rows.append({'id': 'file:' + rel, 'label': label,
                     'status': 'ok' if exists else 'blocked',
                     'detail': '存在' if exists else '缺失——这属于程序文件，不能自动生成。建议重新解压/克隆 FolioFold 程序目录（不要覆盖 content/ 与 public/media/）。'})
    # 5) 凭据：只报告存在与否，绝不读内容（与 cleaner.py 同一原则）。
    for label, rel in [('GitHub token', '.folioframe/gh.json'), ('CloudBase 凭据', '.folioframe/cloudbase.json')]:
        exists = (ROOT / rel).is_file()
        rows.append({'id': 'cred:' + rel, 'label': label + '（可选）',
                     'status': 'optional',
                     'detail': '已配置' if exists else '未配置——只在发布到 GitHub / CloudBase 时需要，本地使用不受影响。'})
    # 6) 端口：能走到这里说明本服务正在监听，直接报告事实（端口由 handler 传入）。
    rows.append({'id': 'port', 'label': '服务端口',
                 'status': 'ok' if port else 'blocked',
                 'detail': ('本服务正监听 127.0.0.1:%d' % port) if port else
                           '无法确定端口（请用 start-folioframe.bat 启动，默认 3000）。'})
    # 7) Ollama（可选翻译 Provider）：复用现有探测，不额外拉服务。
    try:
        st = translation_provider_status(DEPLOY_DIR).as_dict()
        ready = bool(st.get('ready'))
        rows.append({'id': 'ollama', 'label': 'Ollama 本地翻译（可选）',
                     'status': 'optional',
                     'detail': (st.get('message') or ('已就绪（%s）' % st.get('model', ''))) if ready else
                               (st.get('message') or '未配置——只影响「生成新译文」，已审核译文照常显示。')})
    except Exception as e:
        rows.append({'id': 'ollama', 'label': 'Ollama 本地翻译（可选）', 'status': 'optional',
                     'detail': '探测失败（不影响主功能）：%s' % str(e)[:120]})
    # 8) 磁盘余量：低于 500MB 提示（媒体上传 / 备份 / ffmpeg 下载都会失败）。
    try:
        du = shutil.disk_usage(ROOT)
        free_mb = du.free // (1024 * 1024)
        rows.append({'id': 'disk', 'label': '磁盘剩余空间',
                     'status': 'ok' if free_mb >= 500 else 'fixable',
                     'detail': ('剩余 %d MB' % free_mb) if free_mb >= 500 else
                               ('仅剩 %d MB——上传媒体、备份、下载压缩组件都可能失败。建议清理后重试。' % free_mb)})
    except Exception as e:
        rows.append({'id': 'disk', 'label': '磁盘剩余空间', 'status': 'optional',
                     'detail': '无法读取（不影响主功能）：%s' % str(e)[:120]})
    return rows

def blank_portfolio():
    """新模板的空白内容：结构完整，但没有用户内容（无简介 / 无项目 / 无经历）。
    只保留 4 个内置分类骨架（normalize 的默认值，可在文本编辑里改/删），这样新模板一打开
    就有一个可用的结构，而不是一片空白导致页面无从下手。"""
    d = normalize({})
    d['projects'] = []
    d['experience'] = []
    return d

def scaffold_template():
    """新建 / 导入模板时的「占位脚手架」：结构可见，但无真实个人内容。

    与 blank_portfolio 的区别：profile 关键字段填上中性占位文本（如 "Your Name"），
    contactLinks / publicLinks 各给一条占位（邮箱 / 网站），projectGroups 保留默认分类名但剔除描述。
    这样用户一打开模板就能看到排版骨架（主展示区该填什么、次展示区有哪些区块），
    而不是面对一片空白无从下手；同时占位内容非空，数据闸门不会把它当「空骨架」拦截。

    ⚠ 这些占位只是脚手架，不随 FF2 短码 / 模板导出走（导出只含 design），
       所以分享出去的模板仍是干净的版式，不会把 "Your Name" 带给别人。
    """
    d = blank_portfolio()
    p = d.get('profile') or {}
    p['name'] = 'Your Name'
    p['role'] = 'Your Role'
    p['intro'] = 'Your one-line intro'
    p['about'] = 'A few words about you and what you do.'
    p['contactLinks'] = [{'label': 'Email', 'value': 'you@example.com'}]
    p['publicLinks'] = [{'label': 'Website', 'value': 'https://example.com'}]
    d['profile'] = p
    # 分类：保留默认分类名（id + title），剔除描述（描述带原作者个人色彩，新用户多半要重写）。
    d['projectGroups'] = [{'id': g['id'], 'title': g['title']} for g in DEFAULT_GROUPS]
    # 示意条目：让用户一眼看懂 Works / Experience 区块该填什么（纯占位，不随 FF2/模板导出走）。
    # 名称用 "Project 01 / Experience 01" 这种中性示例，明确是要被替换的样板，不会误当成真实内容。
    d['projects'] = [
        {'name': 'Project 01', 'type': 'Short Film',
         'summary': 'A short description of your first project — what it is and your role in it.',
         'groupId': 'original'},
        {'name': 'Project 02', 'type': 'Music Video',
         'summary': 'A short description of your second project — replace with your own work.',
         'groupId': 'music'},
    ]
    d['experience'] = [
        {'company': 'Company Name', 'position': 'Your Position', 'date': '2023 – 2024',
         'summary': 'What you did and achieved in this role. Replace with your real experience.'},
    ]
    return d

def content_blank(d):
    """判断一份 portfolio 数据是否「没有任何实质内容」。
    判定顺序是「先找实质内容，找不到才算空」：任意一项命中就立刻 return False。

    ⚠ 存在的唯一理由：**防数据丢失**。2026-09-19 发生过一次真实事故 ——
    编辑器（editor-v3.js / visual-editor.js）在数据还没加载成功时自动保存，
    前端把空对象 `{}` POST 给 /api/save；而 /api/save 是「照单全收」，
    `normalize({})` 正好等于 blank_portfolio()，于是模板一的草稿被空骨架覆盖，
    文本/排版/作品集三处同时变空。这里把「空」定义清楚，让 /api/save 能够拒绝这种覆盖。

    ⚠⚠ 2026-09-20 二次事故（务必读懂再改本函数）⚠⚠
    症状：用户在编辑器里「删掉最后一项实质内容」（例如删掉最后一个项目、清空最后一个联系方式）
    → 保存被这个闸门判为"空内容"而**拒绝**（409）→ 用户的删除操作静默失效、数据回滚。

    根因是**方向搞反了**：这个函数本意是回答"要不要拦"，
    但它对 incoming 和 existing 两侧用的是**同一个阈值**。
    - 判断 incoming：宁可偏保守（稍像空就拦）—— 拦错了只是保存失败，可重试。
    - 判断 existing：必须偏**激进**（只要不是彻底空就认为"有数据、要保护"）—— 这里判错就是丢数据。
    "existing 是否值得保护"应该问的是"它是不是彻底的空骨架"，
    而不是"它有没有实质内容"。两者在"用户刚删完最后一项"时结论完全相反。

    → 修复：existing 一侧改用 blank_portfolio() 骨架比对（见 below）。
    本函数保持"有实质内容"的语义不变，仍用于 incoming 一侧。
    """
    d = d or {}
    p = d.get('profile') or {}
    for k in ('name', 'role', 'intro', 'about'):
        if str(p.get(k) or '').strip():
            return False
    for k in ('education', 'skills', 'highlights', 'contactLinks', 'publicLinks'):
        v = p.get(k)
        if isinstance(v, list) and len(v):
            return False
        if isinstance(v, dict) and v:
            return False
    for k in ('projects', 'experience'):
        v = d.get(k)
        if isinstance(v, list) and len(v):
            return False
    if isinstance((d.get('showreel') or {}).get('projects'), list) and (d.get('showreel') or {}).get('projects'):
        return False
    if isinstance((d.get('aiVoices') or {}).get('projects'), list) and (d.get('aiVoices') or {}).get('projects'):
        return False
    if isinstance((d.get('aiVoices') or {}).get('sections'), dict) and (d.get('aiVoices') or {}).get('sections'):
        return False
    if isinstance(d.get('media'), dict) and d.get('media'):
        return False
    # 2026-09-20 补充：这些字段同样是"用户的实质内容"，漏掉任何一个都会让
    # "用户删掉最后一项 → 被判空 → 拒绝保存 → 删除失效"再次发生。
    for k in ('sectionTitles', 'sectionTitleTranslations', 'sectionLogos'):
        v = d.get(k)
        if isinstance(v, dict) and v:
            return False
    if isinstance(d.get('resume'), dict) and d.get('resume'):
        return False
    if isinstance(d.get('profile'), dict) and (d['profile'].get('avatar')):
        return False
    return True


def content_is_empty_shell(d):
    """判断一份数据是不是**彻底的空骨架**（只用于决定"要不要保护现有草稿"）。

    为什么单开一个函数：#541 的 content_blank() 语义是"有没有实质内容"，
    对 incoming 一侧合适（宁可多拦）；但用它判断 existing **会误伤** ——
    当用户刚删完最后一项实质内容时，existing 恰好也"没有实质内容"，
    于是闸门放行覆盖 → 删除生效；反过来若闸门想拦，就变成"删不掉"。
    两个方向的需求是相反的，必须分开。

    本函数只认「这一个信号」：数据在"把用户可能编辑过的字段全部掏空"之后，
    和 blank_portfolio() 的骨架**逐键对齐且无值**。
    只要用户留下任何一点东西（哪怕只是一个区块标题、一张区块 Logo、一个简历），
    就返回 False = **不保护**（= 允许覆盖，让用户的删除生效）。

    这样：
      · 真·空对象 `{}`（数据没加载成功）→ True  → 保护，拒绝覆盖。
      · 用户删光所有内容的正常操作      → True  → hmm，这会拦。

    ⚠ 上面两种必须在行为上区分开，见 allow_overwrite_with_blank()。
    """
    d = d or {}
    # 逐项检查：任何一处留有用户痕迹，就不是空骨架
    p = d.get('profile') or {}
    for k, v in p.items():
        if k in ('avatar',):
            if v:
                return False
            continue
        if isinstance(v, str) and v.strip():
            return False
        if isinstance(v, (list, dict)) and v:
            return False
    for k in ('projects', 'experience'):
        if isinstance(d.get(k), list) and d.get(k):
            return False
    for k in ('showreel', 'aiVoices', 'media', 'resume'):
        v = d.get(k)
        if isinstance(v, list) and v:
            return False
        if isinstance(v, dict):
            # ⚠ 不能只看 list/dict 值：resume 归一化后是 {url:'…', name:'…'} 这类**扁平字符串表**，
            #   只查容器类型会把"用户上传了简历"误判成空骨架（本文件 2026-09-20 就踩了这个）。
            for kk, vv in v.items():
                if isinstance(vv, (list, dict)) and vv:
                    return False
                if isinstance(vv, str) and vv.strip():
                    return False
    for k in ('sectionTitles', 'sectionLogos', 'projectGroups'):
        if isinstance(d.get(k), dict) and d.get(k):
            return False
    if isinstance(d.get('settings'), dict):
        # settings 里 sectionVisibility 之类的显式 false 也是"用户改过"的痕迹
        if any(v is False for v in d['settings'].values()):
            return False
    return True


def content_blank_payload(raw):
    """incoming 一侧的判定：「这次请求是不是那个致命事故的空 payload」。

    只在这个 payload **连 normalize 前的原始形态都是空的**时才算。
    一旦用户真的往里放了任何东西（包括"删到只剩一个区块标题"），就绝不算空。
    这样「用户把内容删光」和「前端没加载成功误发 {}」就能被区分开。

    ⚠ 必须**递归**判空：前端出故障时发来的往往不是裸 `{}`，
    而是 `{'profile': {'name': ''}, 'projects': [], 'aiVoices': {}}` 这种**空骨架形状**。
    只查顶层容器是否为真会把后者放过（空 dict/list 在 Python 里也是真值以外的"空"，
    但嵌套一层之后顶层 dict 本身是真值）→ 漏拦。故递归。
    """
    if not isinstance(raw, dict):
        return True
    # ⚠ `settings` 里的显式 `false` 是**用户的决定**（例如"隐藏这个区块"），
    #   不能按"空值"处理 —— 否则用户"把所有区块都隐藏"会被当成空 payload 而拦下。
    for k, v in raw.items():
        if k == 'settings' and isinstance(v, dict):
            if _settings_has_decision(v):
                return False
    return all(_value_is_empty(v) for v in raw.values())


def _settings_has_decision(s):
    """settings 里是否留有用户的显式决定（只看 boolean，不管 true/false）。"""
    if not isinstance(s, dict):
        return False
    for v in s.values():
        if isinstance(v, bool):
            return True
        if isinstance(v, dict) and any(isinstance(x, bool) for x in v.values()):
            return True
    return False


def _value_is_empty(v):
    """值是否"没有任何内容"（递归）。"""
    if v is None or v is False:
        return True
    if isinstance(v, str):
        return not v.strip()
    if isinstance(v, (list, tuple, set)):
        return all(_value_is_empty(x) for x in v)
    if isinstance(v, dict):
        return all(_value_is_empty(x) for x in v.values())
    # 数字 0 / 空 bytes 之类也视作空；其余（True、非 0 数字）算有内容
    if isinstance(v, bool):
        return not v
    return False

def blank_design():
    """新模板的空白排版：只保留默认主题，不含任何图片 / 间距 / 媒体布局等用户决策。"""
    return {'schemaVersion': SCHEMA_VERSION, 'designVersion': 1, 'savedAt': now_iso(),
            'theme': {'mode': 'light', 'preset': 'light-01'}}

# ======================= 模板导出 / 导入 =======================
# —— 区块顺序（Section Order）——
# 顺序是「页面结构」，属于 Template，不属于 Personal Content：
#   权威来源 = design.json 的 sectionOrder
#   历史来源 = portfolio.json 的 sections（老草稿，仅当 design 里没有时回退）
# 迁移是「读时补 + 保存时写」，不去改写 portfolio.json，也不在启动时偷偷改动用户文件。
def valid_section_order(value):
    return isinstance(value, list) and len(value) > 0 and all(isinstance(x, str) and x for x in value)

def with_section_order(design, content):
    """design 里没有顺序时，用 content 里的旧顺序兜底（只读补全，不落盘）。"""
    d = design if isinstance(design, dict) else {}
    if valid_section_order(d.get(SECTION_ORDER_KEY)): return d
    old = (content or {}).get('sections') if isinstance(content, dict) else None
    if not valid_section_order(old): return d
    out = dict(d)
    out[SECTION_ORDER_KEY] = [str(x) for x in old]
    return out

def effective_design(tpl_id):
    """给前台看的 design：保证 sectionOrder 有值（没有就从 content 兜）。"""
    paths = tpl_paths(tpl_id)
    return with_section_order(read(paths['design']) or {}, read(paths['draft']) or {})

# —— 「草稿 vs 已发布」的差异口径 ——
# 记忆点：区块顺序 sectionOrder 已经归 Template，老草稿把它存在 content.sections 里。
# 直接对原始 JSON 做签名会把「同一个顺序换个地方存」误判成"内容有改动"，
# 所以这里统一走与前台一致的归一化：content 用 normalize()，design 用 with_section_order()。
# 另外 designVersion / savedAt 只是「写过几次 / 什么时候写的」这类元数据，不代表内容差异，
# 必须排除，否则纯排版改动（已自动同步到已发布）仍会被报成"有未更新的改动"。
_SIG_SKIP_KEYS = ('designVersion', 'savedAt', 'schemaVersion')

def _strip_sig_meta(obj):
    if not isinstance(obj, dict): return obj
    return {k: v for k, v in obj.items() if k not in _SIG_SKIP_KEYS}

def design_sig(tpl_id):
    """design 现状 → 与前台同口径的签名。

    三处归一化，缺一个都会产生假阳性「有未更新的改动」：
      1. sectionOrder 在 design.json 里可能还没落盘（老草稿留在 content.sections），
         用 with_section_order() 补齐后再比，避免"同一个顺序换个地方存"被判成差异；
      2. designVersion / savedAt / schemaVersion 只是元数据（写过几次、什么时候写的），
         不代表内容差异，必须排除；
      3. 键序无关，用 sort_keys 归一。
    """
    d = read(tpl_paths(tpl_id)['design']) or {}
    d = with_section_order(d, read(tpl_paths(tpl_id)['draft']) or {})
    return json.dumps(_strip_sig_meta(d), ensure_ascii=False, sort_keys=True)

def content_sig(path):
    """content 文件 → 归一化后的签名（normalize 会补齐 keyWork/highlights 等派生字段）。"""
    c = normalize(read(path)) if path.exists() else {}
    return json.dumps(c, ensure_ascii=False, sort_keys=True)

def design_file_sig(path):
    """design 文件（任意路径）→ 同口径签名，供调用方直接传 designPublished 等路径。"""
    d = read(path) if path.exists() else {}
    return json.dumps(_strip_sig_meta(d if isinstance(d, dict) else {}), ensure_ascii=False, sort_keys=True)

def load_shares():
    data = read(TEMPLATE_SHARE, None)
    if not isinstance(data, dict): data = {}
    codes = data.get('codes')
    if not isinstance(codes, dict): codes = {}
    data['codes'] = codes
    return data

def save_shares(data):
    write(TEMPLATE_SHARE, data)

def tpl_display_name(tpl_id):
    for it in load_templates()['items']:
        if it.get('id') == tpl_id: return it.get('name') or tpl_id
    return tpl_id

def clean_design_for_export(design):
    """从 Design 里剥掉一切会带上个人痕迹的东西，只留纯版式。"""
    d = design if isinstance(design, dict) else {}
    out = {k: v for k, v in d.items() if k not in DESIGN_EXCLUDE_KEYS}
    # imgSizes 里 auto:<媒体路径> 这种键直接指向某张个人图片，不能进模板
    isz = out.get('imgSizes')
    if isinstance(isz, dict):
        out['imgSizes'] = {k: v for k, v in isz.items() if not str(k).startswith('auto:')}
    return out

def build_template(tpl_id, name=''):
    """把某个模板的 Design 抽成一份可分享的模板（不含任何个人内容 / 媒体本体）。
    Design 里此时一定带 sectionOrder——区块顺序是 Template 的一部分，会被一起带走。
    settings.translationMode 是**语言设置**（review/direct 两个开关，不含任何译文），
    属于「设置」不是「内容」，所以一并带走；真正的译文在 localizedContent 里，一律不导。"""
    design = clean_design_for_export(effective_design(tpl_id))
    order = design.get(SECTION_ORDER_KEY) if valid_section_order(design.get(SECTION_ORDER_KEY)) else None
    out = {
        'type': TEMPLATE_TYPE,
        'templateVersion': TEMPLATE_VERSION,
        'app': 'FolioFold',
        'name': (name or tpl_display_name(tpl_id) or '未命名模板')[:40],
        'createdAt': now_iso(),
        'design': design,
    }
    try:
        out['settings'] = {'translationMode': translation_mode(read(tpl_paths(tpl_id)['draft']) or {})}
    except Exception:
        pass
    if order: out['structure'] = {SECTION_ORDER_KEY: order}
    return out

def template_is_valid(obj):
    return isinstance(obj, dict) and obj.get('type') == TEMPLATE_TYPE and isinstance(obj.get('design'), dict)

def new_share_code(n=6):
    alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    return ''.join(random.choice(alphabet) for _ in range(n))

# —— 自包含模板码：把整份 Template 压进码本身，跨电脑 / 离线可用 ——
# 格式：FF1-<base64url( 4 字节 CRC32(大端) + zlib(JSON) )>
# CRC32 用来判断「码有没有复制完整/被改动」，zlib 负责压缩长度，
# base64url 保证只有 A-Za-z0-9-_ ，微信 / 邮件 / 聊天框里不会被转义或断行破坏。
# 代价是码会比旧短码长得多（几百到上千字符）——这是「不牺牲可靠性」的必然取舍。
def encode_template_code(tpl):
    raw = json.dumps(tpl, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    crc = (zlib.crc32(raw) & 0xffffffff).to_bytes(4, 'big')
    body = base64.urlsafe_b64encode(crc + zlib.compress(raw, 9)).decode('ascii').rstrip('=')
    return CODE_HEADER + body

def decode_template_code(text):
    """纯离线解析：不联网、不查本地登记表。返回 (template, error)。"""
    s = re.sub(r'\s+', '', str(text or ''))
    if not s.upper().startswith(CODE_HEADER.upper()):
        return None, '不是自包含模板码（应以 ' + CODE_HEADER + ' 开头）'
    body = s[len(CODE_HEADER):]
    pad = '=' * (-len(body) % 4)
    try:
        blob = base64.urlsafe_b64decode(body + pad)
    except Exception:
        return None, '模板码被截断或含有非法字符，请重新完整复制一次'
    if len(blob) < 5:
        return None, '模板码不完整，请重新完整复制一次'
    crc = int.from_bytes(blob[:4], 'big')
    try:
        raw = zlib.decompress(blob[4:])
    except Exception:
        return None, '模板码已损坏（解压失败），请重新生成一次'
    if (zlib.crc32(raw) & 0xffffffff) != crc:
        return None, '模板码校验失败：复制过程中被截断或被改动，请重新完整复制一次'
    try:
        obj = json.loads(raw.decode('utf-8'))
    except Exception:
        return None, '模板码内容不是合法 JSON，请重新生成一次'
    if not template_is_valid(obj):
        return None, '模板码里不是有效的 FolioFold 模板（缺少 type = folioframe-template）'
    return obj, None

# ======================= 短码 FF2-…（定长二进制打包） =======================
# 布局（全部小端、无压缩）：
#   u8  格式版本(=1)
#   u8  主题序号（255 = 模板没指定主题）
#   u8  明暗（0 浅 / 1 深）
#   u8  区块顺序长度 n  + n×u8 区块序号
#   u8  模板名 UTF-8 长度 + 名字（最多 40 字节）
#   u8  有无间距(0/1)   + 8×u16 间距（顺序见 SHORT_SPACING_KEYS）
#   u8  主展示区长度    + n×u8 序号
#   u8  次展示区长度    + n×u8 序号
#   u8  有无像素形象(0/1) + u16 尺寸 / u16 缩放×100 / u16 xPct×1000 / u16 yPct×1000
def _short_idx(table, value):
    return table.index(value) if value in table else -1

def _u8(b): return int(b) & 0xff

def pack_short_template(name, design):
    d = design if isinstance(design, dict) else {}
    b = bytearray()
    b.append(SHORT_VERSION)
    th = d.get('theme') if isinstance(d.get('theme'), dict) else {}
    b.append(_short_idx(SHORT_THEMES, th.get('preset')) & 0xff)   # -1 → 255 = 未指定
    b.append(1 if th.get('mode') == 'dark' else 0)
    order = [x for x in (d.get(SECTION_ORDER_KEY) or []) if x in SHORT_SECTIONS]
    b.append(len(order))
    for x in order: b.append(_short_idx(SHORT_SECTIONS, x) & 0xff)
    nm = str(name or '')[:40].encode('utf-8')
    b.append(len(nm)); b += nm
    sp = d.get('spacing') if isinstance(d.get('spacing'), dict) else {}
    if sp:
        b.append(1)
        for k in SHORT_SPACING_KEYS:
            v = sp.get(k)
            # ⚠ 缺省必须写 0xffff（=「这一项没设」），绝不能写 0：
            #   0 是「间距=0」的**有效值**，解出来的模板会把默认间距强行压成 0，
            #   导入方看到的排版就和导出方不一样（2026-10-04 实测抓到）。
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                iv = max(0, min(int(round(v)), 0xfffe))
            else:
                iv = 0xffff
            b += iv.to_bytes(2, 'little')
    else:
        b.append(0)
    dz = d.get('displayZones') if isinstance(d.get('displayZones'), dict) else {}
    hero = [x for x in (dz.get('hero') or []) if x in SHORT_HERO_KEYS]
    sec = [x for x in (dz.get('secondary') or []) if x in SHORT_SECONDARY_KEYS]
    b.append(len(hero))
    for x in hero: b.append(_short_idx(SHORT_HERO_KEYS, x) & 0xff)
    b.append(len(sec))
    for x in sec: b.append(_short_idx(SHORT_SECONDARY_KEYS, x) & 0xff)
    px = d.get('pixel') if isinstance(d.get('pixel'), dict) else {}
    if px:
        b.append(1)
        b += min(int(px.get('size') or 0), 0xffff).to_bytes(2, 'little')
        b += min(int(round(float(px.get('scale') or 1) * 100)), 0xffff).to_bytes(2, 'little')
        b += min(int(round(float(px.get('xPct') or 0) * 1000)), 0xffff).to_bytes(2, 'little')
        b += min(int(round(float(px.get('yPct') or 0) * 1000)), 0xffff).to_bytes(2, 'little')
    else:
        b.append(0)
    return bytes(b)

def unpack_short_template(blob):
    """解 FF2 负载 → (name, design)。任何越界/异常都抛 ValueError（当成码损坏）。"""
    if not isinstance(blob, (bytes, bytearray)) or len(blob) < 6:
        raise ValueError('模板码不完整')
    i = 0
    ver = _u8(blob[i]); i += 1
    if ver != SHORT_VERSION:
        raise ValueError('短码版本不认识（v%d），请让对方用新版重新生成一次' % ver)
    def take(n):
        nonlocal i
        if i + n > len(blob): raise ValueError('模板码不完整，请重新完整复制一次')
        out = blob[i:i + n]; i += n; return out
    def idx_of(table, v):
        return table[v] if 0 <= v < len(table) else None
    theme_i = _u8(take(1)[0])
    dark = _u8(take(1)[0]) == 1
    n = _u8(take(1)[0])
    order = [idx_of(SHORT_SECTIONS, _u8(x)) for x in take(n)]
    order = [x for x in order if x]
    nl = _u8(take(1)[0])
    name = take(nl).decode('utf-8', 'replace')
    design = {}
    if theme_i != 255 and 0 <= theme_i < len(SHORT_THEMES):
        design['theme'] = {'preset': SHORT_THEMES[theme_i], 'mode': 'dark' if dark else 'light'}
    if _u8(take(1)[0]) == 1:
        sp = {}
        for k in SHORT_SPACING_KEYS:
            v = int.from_bytes(take(2), 'little')
            if v != 0xffff: sp[k] = v
        design['spacing'] = sp
    nh = _u8(take(1)[0])
    hero = [idx_of(SHORT_HERO_KEYS, _u8(x)) for x in take(nh)]
    ns = _u8(take(1)[0])
    sec = [idx_of(SHORT_SECONDARY_KEYS, _u8(x)) for x in take(ns)]
    dz = {}
    hero = [x for x in hero if x]
    sec = [x for x in sec if x]
    if hero: dz['hero'] = hero
    if sec: dz['secondary'] = sec
    if dz: design['displayZones'] = dz
    if _u8(take(1)[0]) == 1:
        size = int.from_bytes(take(2), 'little')
        scale = int.from_bytes(take(2), 'little') / 100.0
        xp = int.from_bytes(take(2), 'little') / 1000.0
        yp = int.from_bytes(take(2), 'little') / 1000.0
        design['pixel'] = {'size': size, 'x': None, 'y': None, 'scale': scale, 'xPct': xp, 'yPct': yp}
    if order: design[SECTION_ORDER_KEY] = order
    return name, design

def encode_short_code(name, design):
    payload = pack_short_template(name, design)
    crc = (zlib.crc32(payload) & 0xffffffff).to_bytes(4, 'big')
    return CODE_HEADER_V2 + base64.urlsafe_b64encode(crc + payload).decode('ascii').rstrip('=')

def decode_short_code(text):
    s = re.sub(r'\s+', '', str(text or ''))
    if not s.upper().startswith(CODE_HEADER_V2.upper()):
        return None, '不是短模板码（应以 ' + CODE_HEADER_V2 + ' 开头）'
    body = s[len(CODE_HEADER_V2):]
    # base64 长度不是 4 的倍数，几乎一定是复制时被截断（少了一两个字符），
    # 而不是"含有非法字符"——给更准确的指引，避免用户以为码本身坏了。
    if len(body) % 4 != 0:
        return None, ('短模板码不完整：复制时可能漏掉了结尾几个字符。' +
                      '请点「复制」按钮复制完整内容，再整段粘贴，不要手动拖选。')
    try:
        blob = base64.urlsafe_b64decode(body + '=' * (-len(body) % 4))
    except Exception:
        return None, ('短模板码含有无法识别的字符（复制途中可能被改动或自动纠错改了符号）。' +
                      '请重新点「复制」按钮，整段原样粘贴。')
    if len(blob) < 5:
        return None, '短模板码不完整，请重新完整复制一次'
    crc = int.from_bytes(blob[:4], 'big')
    payload = blob[4:]
    if (zlib.crc32(payload) & 0xffffffff) != crc:
        return None, '短模板码校验失败：复制过程中被截断或被改动，请重新完整复制一次'
    try:
        name, design = unpack_short_template(payload)
    except ValueError as e:
        return None, str(e)
    except Exception:
        return None, '短模板码已损坏，请重新生成一次'
    return {'type': TEMPLATE_TYPE, 'templateVersion': TEMPLATE_VERSION,
            'name': name, 'design': design}, None

def extract_section_order(obj):
    """模板里可能有两处写着区块顺序：design.sectionOrder（权威）或 structure.sectionOrder（冗余备份）。"""
    if not isinstance(obj, dict): return None
    d = obj.get('design')
    if isinstance(d, dict) and valid_section_order(d.get(SECTION_ORDER_KEY)):
        return [str(x) for x in d[SECTION_ORDER_KEY]]
    st = obj.get('structure')
    if isinstance(st, dict) and valid_section_order(st.get(SECTION_ORDER_KEY)):
        return [str(x) for x in st[SECTION_ORDER_KEY]]
    return None

def export_template_with_code(tpl_id, name=''):
    """返回 (短码 FF2-, 完整码 FF1-, 模板本体)。

    · 短码只带核心版式（主题 / 明暗 / 区块顺序 / 间距 / 展示区 / 像素形象 / 名字），几十个字符，
      微信里随口就能发；逐项微调（某条标题的字号、某张媒体的栏宽…）不带 —— 那些绑在具体条目上，
      换到别人作品集上本来也对不上号。
    · 完整码把整份 design 压进码里，几百字符，需要连逐项微调一起带走时用。
    两者都是自包含的：解析不联网、不查服务器。旧登记表不再写入——它只在本机有意义。"""
    tpl = build_template(tpl_id, name)
    return (encode_short_code(tpl.get('name') or '', tpl.get('design') or {}),
            encode_template_code(tpl), tpl)

def resolve_import_payload(payload):
    """导入输入有三种：自包含模板码 FF1-…、本机旧短码 FF-XXXXXX、整份模板 JSON。"""
    if not isinstance(payload, dict): return None, '导入内容无效'
    code = re.sub(r'\s+', '', str(payload.get('code') or ''))
    if code:
        if code.upper().startswith(CODE_HEADER_V2.upper()):
            return decode_short_code(code)
        if code.upper().startswith(CODE_HEADER.upper()):
            return decode_template_code(code)
        hit = load_shares()['codes'].get(code.upper())   # 旧机制：只能在这台机器上生效
        if hit:
            return {'type': TEMPLATE_TYPE, 'templateVersion': TEMPLATE_VERSION,
                    'name': hit.get('name') or '', 'design': hit.get('design') or {}}, None
        return None, ('找不到这个模板码。跨电脑分享请用 ' + CODE_HEADER +
                      ' 开头的自包含模板码，或直接把模板文件发给对方。')
    obj = payload.get('template')
    if isinstance(obj, str):
        try: obj = json.loads(obj)
        except Exception: return None, '模板内容不是合法 JSON'
    if template_is_valid(obj): return obj, None
    # 容错：只贴了 design 部分也接受
    if isinstance(obj, dict) and isinstance(obj.get('design'), dict):
        # 容错：只贴了 design 那一段（顶层没写 type）也接受；
        # 但显式写了别的 type 就是别的东西，必须明确拒绝，不能悄悄当成我国模板。
        t = obj.get('type')
        if t is None or t == TEMPLATE_TYPE:
            return {'type': TEMPLATE_TYPE, 'templateVersion': TEMPLATE_VERSION, 'design': obj['design']}, None
        return None, '不是有效的 FolioFold 模板（type 应为 ' + TEMPLATE_TYPE + '）'
    return None, '不是有效的 FolioFold 模板（缺少 type = folioframe-template）'

# ======================= 公网部署（腾讯云 CloudBase 静态网站托管）=======================
# ⚠ 这里只做「把静态包传上去」。不代建环境、不代实名、不提供一键授权。
#   创作者必须自己准备：EnvId + SecretId + SecretKey（腾讯云控制台创建）。
#   签名算法：TC3-HMAC-SHA256（腾讯云官方 SDK 的标准签名），纯标准库实现。
class CBError(Exception):
    def __init__(self, code, message):
        self.code = code; self.message = message
    def __str__(self):
        return '[CloudBase %s] %s' % (self.code, self.message)

def load_public_link():
    data = read(PUBLIC_LINK, None)
    return data if isinstance(data, dict) else {}

def save_public_link(info):
    write(PUBLIC_LINK, info)

# ======================= 多模板多路径发布（deployments）=======================
# 背景：模板一 / 模板二… 各自是一整套独立内容，但**共用一个** public-link.json。
# 老格式只存「最后一次发布」（顶层 provider/url），导致切模板发布 = 互相覆盖，
# 别人拿不到两个不同的链接。
# 现在改成「一份发布记录表」：deployments = [{provider, tpl, path, url, deployedAt, meta}, ...]
#   · provider：'github' | 'cloudbase'
#   · tpl     ：模板 id（'main' = 模板一）
#   · path    ：站点下的子路径名（CloudBase 走 cloudPath，GitHub 走仓库子目录）；
#               空字符串 = 站点根（模板一的兼容默认值就是 'FolioFold'，沿用线上已有地址）。
#   · url     ：该子路径的**完整可访问地址**，面板直接把这个发给别人。
# 顶层仍保留 provider / url / deployedAt / meta = 「最后一次发布」，向后兼容旧读取点
# （/api/deploy/status 的 publicUrl、github_publish 取仓库名等），不破坏既有行为。
# ⚠ 设计约束：**各子路径之间互相隔离** —— 发 V1 链接的人看不到 V2，也看不到总入口。
#    所以站点根**不放**任何"列出全部模板"的导航页（只放一个不暴露信息的占位）。

DEPLOYMENTS_KEY = 'deployments'

# —— 发布记录防丢失加固（2026-09-23）——
# 历史追加文件：每次增/删/改都记一笔（删除记墓碑），是「自愈」的唯一真相来源。
DEPLOY_HISTORY = DEPLOY_DIR / 'deploy-history.jsonl'
# 写盘前备份（保留最近一代），误写可回退到 public-link.previous.json。
DEP_PUBLINK_PREV = PUBLIC_LINK.with_name('public-link.previous.json')
# 写锁：保护 public-link.json 的「读-改-写」不被并发请求互相覆盖（ThreadingHTTPServer 多线程）。
_DEP_WRITE_LOCK = threading.Lock()

def load_deployments():
    """读全部发布记录；老格式（只有顶层 provider/url）自动迁移成一条记录（tpl=main）。"""
    link = load_public_link()
    items = link.get(DEPLOYMENTS_KEY)
    out = []
    if isinstance(items, list):
        for it in items:
            if not isinstance(it, dict): continue
            p = str(it.get('provider') or '').strip()
            u = str(it.get('url') or '').strip()
            if not p or not u: continue
            out.append({
                'provider': p,
                'tpl': str(it.get('tpl') or LEGACY_TPL_ID).strip() or LEGACY_TPL_ID,
                'tplName': str(it.get('tplName') or '').strip(),
                'path': str(it.get('path') if it.get('path') is not None else '').strip().strip('/'),
                'url': u,
                'deployedAt': str(it.get('deployedAt') or '').strip(),
                'meta': it.get('meta') if isinstance(it.get('meta'), dict) else {},
            })
    if not out and link.get('provider') and link.get('url'):
        # —— 老格式迁移（只读补全，不改盘；真正落盘发生在下一次发布写盘时）——
        out.append({
            'provider': str(link.get('provider')).strip(),
            'tpl': LEGACY_TPL_ID,
            'path': 'FolioFrame' if str(link.get('provider')).strip() == 'cloudbase' else '',   # 历史发布的线上路径就是 /FolioFrame/，兜底必须与之一致
            'url': str(link.get('url')).strip(),
            'deployedAt': str(link.get('deployedAt') or '').strip(),
            'meta': link.get('meta') if isinstance(link.get('meta'), dict) else {},
        })
    return out

def _dep_key(d):
    return (str(d.get('provider') or '').strip(),
            str(d.get('tpl') or LEGACY_TPL_ID).strip() or LEGACY_TPL_ID,
            str(d.get('path') if d.get('path') is not None else '').strip().strip('/'))


def _gh_repo_name(tpl):
    """推算 GitHub 仓库名（与 github_publish 同口径）：上次发布的仓库（已弃用名除外）> 固定默认仓。
    ⚠ 2026-10-06：不再按 profile.name 的 slug 派生 —— tpl-2 的名字 "FolioFold" 会派生出
    已弃用的 foliofold 仓。当前环境不设置时一律回落 GH_PUBLISH_REPO。
    ⚠ 2026-10-08：旧名 'folioframe'（FolioFrame）也视为弃用，避免改名后回落到已不存在的旧仓库。"""
    try:
        prev = load_public_link()
        r = ((prev.get('meta') or {}).get('repoName') or '') if prev.get('provider') == 'github' else ''
        if r and r.strip().lower() not in (GH_PUBLISH_REPO_DEPRECATED, 'folioframe'):
            return r[:50]
        return GH_PUBLISH_REPO
    except Exception:
        return GH_PUBLISH_REPO


def _clean_dep(it):
    """把一条记录规范化成可落盘的干净 dict；缺 provider/url 的一律丢弃（不写脏数据）。"""
    if not isinstance(it, dict):
        return None
    p = str(it.get('provider') or '').strip()
    u = str(it.get('url') or '').strip()
    if not p or not u:
        return None
    return {'provider': p,
            'tpl': str(it.get('tpl') or LEGACY_TPL_ID).strip() or LEGACY_TPL_ID,
            'tplName': str(it.get('tplName') or '').strip(),
            'path': str(it.get('path') if it.get('path') is not None else '').strip().strip('/'),
            'url': u,
            'deployedAt': str(it.get('deployedAt') or '').strip(),
            'meta': it.get('meta') if isinstance(it.get('meta'), dict) else {}}


def _parse_remote_flag(payload):
    """严格解析破坏性操作的 remote 开关（2026-10-06 事故回归）。

    事故复盘：调用 /api/deploy/remove 时误把 remote=false 写成 doRemote=false，
    旧代码 `True if v is None else bool(v)` 把「参数缺失」当成 True，真实删除了线上路径。
    危险默认值不能带进 1.0，新规则：
      · remote=True            → 明确要求远端删除；
      · remote=False / 缺失 / null → 只处理本机记录（安全默认，绝不触远端）；
      · 其它任何类型（字符串 "true"/"false"、数字等）→ 拒绝请求（类型错误不猜测）。
    返回 (ok, value, err)。"""
    v = payload.get('remote') if isinstance(payload, dict) else None
    if v is None:
        return True, False, ''
    if isinstance(v, bool):
        return True, v, ''
    return False, None, ('remote 参数必须是布尔值 true/false（收到 %s）。'
                         '为安全起见本次请求已拒绝，未删除任何记录、未触碰线上。' % type(v).__name__)


def _backup_publink():
    """写盘前把当前 public-link.json 留一份备份（仅保留最近一代），用于误写后回退。"""
    try:
        if PUBLIC_LINK.exists():
            shutil.copy(PUBLIC_LINK, DEP_PUBLINK_PREV)
    except Exception:
        pass


def _append_dep_history(entries):
    """向追加式历史追加若干条（含删除墓碑 / 自愈补回）。失败时静默忽略，绝不阻断发布。"""
    try:
        DEPLOY_DIR.mkdir(parents=True, exist_ok=True)
        lines = []
        for e in (entries or []):
            rec = {'ts': now_iso(), 'op': e.get('op')}
            for k in ('provider', 'tpl', 'tplName', 'path', 'url', 'deployedAt'):
                if k in e:
                    rec[k] = e[k]
            rec['meta'] = e.get('meta') if isinstance(e.get('meta'), dict) else {}
            lines.append(json.dumps(rec, ensure_ascii=False))
        if lines:
            with open(DEPLOY_HISTORY, 'a', encoding='utf-8') as f:
                f.write('\n'.join(lines) + '\n')
    except Exception:
        pass


def _persist_deployments(items, latest=None, history=None):
    """线程/进程安全地落盘发布记录表（带写前备份 + 追加历史）。

    这是**唯一**真正接触 public-link.json 的写入口：所有增删改都先经它，
    绝不允许"只带部分记录的全量覆盖"。latest=None 时顶层『最后一次发布』自动
    取剩余记录里 deployedAt 最新的一条（跨 provider），保证顶层不丢失。"""
    link = load_public_link()
    clean = []
    for it in (items or []):
        c = _clean_dep(it)
        if c:
            clean.append(c)
    link = dict(link)
    link[DEPLOYMENTS_KEY] = clean
    if latest:
        link['provider'] = latest.get('provider')
        link['url'] = latest.get('url')
        link['deployedAt'] = latest.get('deployedAt')
        link['meta'] = latest.get('meta') or {}
        link['files'] = latest.get('files')
        link['mediaCopied'] = latest.get('mediaCopied')
    else:
        top = None
        for it in clean:
            if top is None or (it.get('deployedAt') or '') > (top.get('deployedAt') or ''):
                top = it
        if top:
            link['provider'] = top.get('provider')
            link['url'] = top.get('url')
            link['deployedAt'] = top.get('deployedAt')
            link['meta'] = top.get('meta') or {}
        else:
            for k in ('provider', 'url', 'deployedAt', 'meta', 'files', 'mediaCopied'):
                link.pop(k, None)
    _backup_publink()
    write(PUBLIC_LINK, link)
    if history:
        _append_dep_history(history)


def save_deployment_upsert(rec, replace=False, match_path=False):
    """线程安全地『读最新盘 → 只改这一条 → 写回』。

    调用方**不必**先 load 全部记录再回传：本函数每次都从盘上读最新态，
    因此不会因为调用方拿到的是"不完整/过期"的列表而把别的渠道 / 模板记录抹掉。
    返回写入后的完整记录列表。"""
    with _DEP_WRITE_LOCK:
        cur = load_deployments()
        existed = find_deployment(cur, rec.get('provider'),
                                  rec.get('tpl') or LEGACY_TPL_ID) is not None
        new_list = upsert_deployment(cur, rec, replace=replace, match_path=match_path)
        op = 'update' if existed else 'add'
        _persist_deployments(new_list, latest=rec,
                             history=[{'op': op, 'provider': rec.get('provider'),
                                       'tpl': rec.get('tpl'), 'tplName': rec.get('tplName'),
                                       'path': rec.get('path'), 'url': rec.get('url'),
                                       'deployedAt': rec.get('deployedAt'), 'meta': rec.get('meta')}])
        return new_list


def save_deployment_remove(provider, tpl, path):
    """线程安全地删除一条记录（带删除墓碑历史）。返回 (新列表, 被删记录)。"""
    with _DEP_WRITE_LOCK:
        cur = load_deployments()
        new_list, removed = remove_deployment(cur, provider, tpl, path)
        hist = []
        if removed:
            hist.append({'op': 'delete', 'provider': provider, 'tpl': tpl,
                         'tplName': removed.get('tplName'), 'path': path,
                         'url': removed.get('url'), 'deployedAt': removed.get('deployedAt'),
                         'meta': removed.get('meta')})
        _persist_deployments(new_list, history=hist)
        return new_list, removed


def heal_deployments():
    """从历史找回『本应存在、但当前盘上缺失且未被删除』的发布记录。

    历史 = .folioframe/deploy-history.jsonl（追加式，含 add/update/delete 墓碑）。
    重建每个 (provider,tpl,path) 的最后状态：若最后一条是 delete → 视为已删，不补回；
    若最后一条是 add/update 且该键当前盘上不存在 → 补回（自愈）。

    返回 {healed: [...记录...], found: N}。无历史或无需补回时 healed=[]。"""
    expected = {}
    deleted = set()
    try:
        if DEPLOY_HISTORY.exists():
            with open(DEPLOY_HISTORY, 'r', encoding='utf-8') as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        e = json.loads(line)
                    except Exception:
                        continue
                    key = (str(e.get('provider') or '').strip(),
                           str(e.get('tpl') or LEGACY_TPL_ID).strip() or LEGACY_TPL_ID,
                           str(e.get('path') if e.get('path') is not None else '').strip().strip('/'))
                    if e.get('op') == 'delete':
                        deleted.add(key)
                        expected.pop(key, None)
                    else:
                        deleted.discard(key)
                        expected[key] = e
    except Exception:
        pass
    # —— 首次运行（历史文件缺失/为空）：把当前盘上的记录作为「基线」写入历史，
    # 这样之后若某条被异常写丢失，下一次 heal 就能从基线补回（含本次启动前就存在的老记录）。
    # 仅当历史确实为空时才播种，避免重复；已存在删除墓碑的记录不会被误当基线复活。
    if not DEPLOY_HISTORY.exists() or not expected:
        try:
            _seed = []
            if not DEPLOY_HISTORY.exists() or os.path.getsize(DEPLOY_HISTORY) == 0:
                for d in load_deployments():
                    _seed.append({'op': 'add', 'provider': d.get('provider'), 'tpl': d.get('tpl'),
                                  'tplName': d.get('tplName'), 'path': d.get('path'),
                                  'url': d.get('url'), 'deployedAt': d.get('deployedAt'), 'meta': d.get('meta')})
                if _seed:
                    _append_dep_history(_seed)
                    for e in _seed:
                        key = (str(e.get('provider') or '').strip(),
                               str(e.get('tpl') or LEGACY_TPL_ID).strip() or LEGACY_TPL_ID,
                               str(e.get('path') if e.get('path') is not None else '').strip().strip('/'))
                        expected[key] = e
        except Exception:
            pass
    if not expected:
        return {'healed': [], 'found': 0}
    with _DEP_WRITE_LOCK:
        cur = load_deployments()
        cur_keys = {_dep_key(d) for d in cur}
        to_add = []
        for k, e in expected.items():
            if k in cur_keys or k in deleted:
                continue
            rec = {'provider': e.get('provider'), 'tpl': e.get('tpl'),
                   'tplName': e.get('tplName') or '', 'path': e.get('path') or '',
                   'url': e.get('url'), 'deployedAt': e.get('deployedAt') or now_iso(),
                   'meta': e.get('meta') or {}}
            c = _clean_dep(rec)
            if c:
                to_add.append(c)
        if not to_add:
            return {'healed': [], 'found': 0}
        new_list = list(cur) + to_add
        _persist_deployments(new_list,
                             history=[{'op': 'heal-add', 'provider': c['provider'], 'tpl': c['tpl'],
                                       'tplName': c['tplName'], 'path': c['path'], 'url': c['url'],
                                       'deployedAt': c['deployedAt'], 'meta': c['meta']} for c in to_add])
        return {'healed': to_add, 'found': len(to_add)}

def find_deployment(items, provider, tpl):
    """找某个 provider 下某个模板**当前那条**记录（没有则 None）。

    ⚠ 一个模板在同一个 provider 下可以有多条记录（用户点「另外发布一个链接」就会多一条）。
    这里返回**最后写入的那条** = 该模板的"当前发布"，也就是「更新当前发布」按钮要覆盖的目标。"""
    found = None
    for it in (items or []):
        if it.get('provider') == provider and (it.get('tpl') or LEGACY_TPL_ID) == (tpl or LEGACY_TPL_ID):
            found = it   # 不 break：取最后一条 = 最新
    return found

def resolve_provider(provider_id, tpl=None, path=None):
    """把「可能缺失的 provider」还原成确定的渠道 id，还原不了就返回 ''。

    为什么需要它（2026-09-28 修复）：发布面板的链接列表里每条记录都要带 provider，
    老版本 /api/deploy/status 组装记录时漏了这个字段，前端 JSON.stringify 直接丢键，
    于是「更新发布 / 改发布内容 / 删除」一律被判成「不支持的平台：(空)」。
    只认 provider 会让老数据/第三方调用全部失效，所以这里加一层兜底：
    用 (tpl, path) 反查记录，**只在匹配结果唯一无歧义时**才采信，绝不猜。"""
    p = str(provider_id or '').strip()
    if p in PUBLISH_PROVIDERS:
        return p
    tpl = str(tpl or '').strip() or None
    path = str(path or '').strip().strip('/') if path is not None else ''
    cands = set()
    for it in (load_deployments() or []):
        ip = str(it.get('provider') or '').strip()
        if ip not in PUBLISH_PROVIDERS: continue
        if tpl is not None and (it.get('tpl') or LEGACY_TPL_ID) != tpl: continue
        if path and str(it.get('path') or '').strip().strip('/') != path: continue
        cands.add(ip)
    return cands.pop() if len(cands) == 1 else ''

def upsert_deployment(items, rec, replace=False, match_path=False):
    """写入一条发布记录。

    replace=False（默认，「另外发布一个链接」）：**追加**一条新记录。
        同一模板下可以有多条 —— 这正是"一个模板挂多个地址"的实现方式。
    replace=True（「更新当前发布」）：替换掉旧记录，没有旧记录时等同追加。

    match_path=False（默认）：按 (provider, tpl) 匹配旧记录 —— 「更新当前发布」用，
        因为它的目标是"这个模板上次发到哪，这次就还发到哪"。
    match_path=True：按 (provider, path) 匹配 —— 「改发布内容 / 更新发布这条」用。
        ⚠ 这里必须按路径匹配：把 A 地址的内容换成模板二，被顶掉的是 A 地址那条记录，
        而不是"模板二自己那条"（模板二那条在别的路径上，不该被牵连）。
        2026-09-20 修复：旧实现只会按 tpl 匹配，导致 retarget 时新模板写到了**它自己**的路径上，
        用户指定的目标路径纹丝不动 —— 表现为「点了改发布内容，什么都没变」。
    返回新列表。"""
    out = list(items or [])
    if not replace:
        out.append(rec)
        return out
    rec_path = str(rec.get('path') if rec.get('path') is not None else '').strip().strip('/')
    rec_tpl = (rec.get('tpl') or LEGACY_TPL_ID)
    idx = None
    for i, it in enumerate(out):
        if str(it.get('provider') or '').strip() != str(rec.get('provider') or '').strip():
            continue
        if match_path:
            same = str(it.get('path') if it.get('path') is not None else '').strip().strip('/') == rec_path
        else:
            same = (it.get('tpl') or LEGACY_TPL_ID) == rec_tpl
        if same:
            idx = i
    if idx is None:
        out.append(rec)
    else:
        out[idx] = rec
    return out

def remove_deployment(items, provider, tpl, path):
    """精确删除一条发布记录（provider + tpl + path 三者同时匹配才算）。
    返回 (新列表, 被删掉的那条 or None)。
    ⚠ 必须三者都匹配：同一模板可以有多条记录，只按 tpl 删会误删别的路径。"""
    provider = str(provider or '').strip()
    tpl = (str(tpl or '').strip() or LEGACY_TPL_ID)
    path = str(path if path is not None else '').strip().strip('/')
    out, removed = [], None
    for it in (items or []):
        same = (str(it.get('provider') or '').strip() == provider
                and (str(it.get('tpl') or LEGACY_TPL_ID).strip() or LEGACY_TPL_ID) == tpl
                and str(it.get('path') if it.get('path') is not None else '').strip().strip('/') == path)
        if same and removed is None:
            removed = it
            continue          # 只删第一条匹配（防重复记录被一次全删）
        out.append(it)
    return out, removed

def _norm_path_name(name):
    """子路径名规范化：只留字母数字与 - _ ，去掉首尾分隔符与多余连字符。
    ⚠ 必须严格 —— 这个值会进 CloudBase cloudPath 与 GitHub 仓库目录名，
    放任 '.' / '/' / '..' 会写错位置甚至越界。
    保留原大小写（URL 路径区分大小写，'FolioFold' 这类可读名字要维持原样）。"""
    s = re.sub(r'[^A-Za-z0-9_-]', '-', str(name or '').strip())
    s = re.sub(r'-+', '-', s).strip('-_')
    return s[:48]

def suggest_deploy_path(tpl, provider, deployments=None, prefer=None):
    """为某个模板生成一个**可用且不冲突**的子路径名。

    规则（用户拍板：自动生成 + 可改）：
      · 模板一（main）→ 'FolioFold'（沿用线上已有地址，不破坏老链接）
      · 其余模板 → 优先用模板名里的 ASCII 部分（如 '模板2' → '2' 不够好，
        会拼成 'v2'）；实在没有可用名字就按模板序号 → 'v2' / 'v3'
      · 与已有路径冲突 → 追加 -2 / -3 …
    prefer：用户在界面上手填的名字，优先采用（同样会做规范化 + 冲突处理）。
    """
    items = deployments if deployments is not None else load_deployments()
    # CloudBase 是「环境 + cloudPath」共享同一个域名，GitHub 是「仓库 + 目录」——
    # 两边都要按 provider 分别查重（同名在不同 provider 下是允许的）。
    taken = set()
    for it in items:
        if it.get('provider') == provider:
            taken.add(str(it.get('path') or '').strip().strip('/').lower())

    def _seq():
        """按模板在注册表里的序号给一个 vN（模板二 → v2）。"""
        n = 2
        try:
            others = [it for it in load_templates()['items'] if it.get('id') != LEGACY_TPL_ID]
            ids = [it.get('id') for it in others]
            if tpl in ids:
                n = ids.index(tpl) + 2
            else:
                n = len(others) + 1
        except Exception:
            n = 2
        return 'v%d' % max(2, n)

    cand = ''
    if prefer:
        raw = str(prefer)
        cand = _norm_path_name(raw)
        # 纯中文名规范化后会变空 → 试图抽出里面的数字（'模板2' → '2' → 补成 'v2'）
        if not cand:
            digits = re.sub(r'[^0-9]', '', raw)
            if digits:
                cand = ('v' + digits).lower()
    if not cand:
        if not tpl or tpl == LEGACY_TPL_ID:
            cand = 'FolioFold'
        else:
            name = ''
            try:
                for it in load_templates()['items']:
                    if it.get('id') == tpl:
                        name = str(it.get('name') or '').strip(); break
            except Exception:
                name = ''
            if name:
                cand = _norm_path_name(name)
                # '模板2' 会被规范成 '2'；这种"只有数字"的名字太弱，改用 vN 更清楚。
                if cand.isdigit():
                    cand = 'v' + cand
            if not cand:
                cand = _seq()
        if not cand:
            cand = 'site'
    base = cand
    i = 2
    while cand.lower() in taken:
        cand = '%s-%d' % (base, i); i += 1
    return cand

def slugify_project(name):
    s = re.sub(r'[^a-z0-9-]', '-', str(name or '').lower()).strip('-')
    s = re.sub(r'-+', '-', s)
    if not s or not re.match(r'^[a-z0-9]', s):
        s = 'portfolio'
    return s[:50] or 'portfolio'

def collect_media_refs(published, design):
    """收集 Published 数据 + Design 里所有指向本地 /media/ 的引用（头像 / 项目图视频 / Showreel / AI 封面…）。"""
    refs = set()
    def walk(o):
        if isinstance(o, str):
            if o.startswith('/media/'): refs.add(o)
        elif isinstance(o, list):
            for x in o: walk(x)
        elif isinstance(o, dict):
            for v in o.values(): walk(v)
    walk(published)
    walk(design or {})
    return sorted(refs)

def _collect_external_video_urls(data):
    """收集内容里的外部视频链接（http/https 开头）。

    为什么单独收集：外部链接**不是本地文件**，不进 collect_media_refs（那会把它们
    当成 media/ 路径去找、找不到就报缺失）。必须在导出清单里单独列出，
    才能让用户知道"这个包依赖外部网络才能播这段视频"。
    """
    out = []
    def walk(o, key=''):
        if isinstance(o, dict):
            for k, v in o.items(): walk(v, k)
        elif isinstance(o, list):
            for x in o: walk(x, key)
        elif isinstance(o, str):
            if 'external' in key.lower() or 'url' in key.lower():
                if o.startswith('http://') or o.startswith('https://'):
                    out.append(o)
    walk(data or {})
    return sorted(set(out))

def _export_readme(manifest):
    """ZIP 内 README：说清怎么用、少了什么、以及"密钥绝不在这里"。"""
    L = []
    L.append('FolioFold 静态站点导出')
    L.append('=' * 40)
    L.append('')
    L.append('导出时间：%s' % manifest.get('exportedAt', ''))
    name = (manifest.get('profile') or {}).get('name') or ''
    if name:
        L.append('作者：%s %s' % (name, (manifest.get('profile') or {}).get('role') or ''))
    L.append('')
    L.append('【怎么用】')
    L.append('1) 直接看：解压后双击 index.html，离线即可浏览（不需要 FolioFold、不需要联网）。')
    L.append('2) 传上去：把解压后的**全部内容**上传到任意静态托管平台。')
    L.append('   · 腾讯云 EdgeOne Pages：把本 ZIP 直接拖进 Pages Drop 上传页即可（无需配置密钥）。')
    L.append('   · 腾讯云 CloudBase / 其他平台：进入静态托管后上传同一批文件。')
    L.append('   · 注意：各平台对**单个文件大小**有上限（常见 25MB / 50MB），超限需先压缩视频。')
    L.append('')
    L.append('【这个包里有什么】')
    L.append('- index.html：整个网站（样式与脚本已内联，不依赖外部文件）')
    L.append('- 404.html / .nojekyll：托管平台用的兜底页与配置')
    L.append('- media/：作品集实际引用的本地媒体')
    L.append('- folioframe-export.json：导出清单（机器可读，便于将来重新导入）')
    L.append('')
    L.append('【媒体情况】')
    inc = manifest.get('mediaIncluded') or []
    L.append('- 已包含 %d 个媒体文件' % len(inc))
    big = manifest.get('mediaSkippedTooLarge') or []
    if big:
        L.append('- 以下 %d 个媒体**因为太大没有放进这个包**（默认阈值 %s MB，避免 ZIP 过大）：'
                 % (len(big), manifest.get('skipThresholdMB') or '?'))
        L.append('  它们在页面里仍指向原地址，但在本包里是失效链接：')
        for f in big: L.append('    · %s（%s MB）' % (f.get('path'), f.get('mb')))
        L.append('  处理办法：① 在 FolioFold 里先压缩视频再导出；② 把源文件单独上传到存储后改')
        L.append('  用外部视频链接；③ 重新导出时在下载链接后加 ?include=all（会跳过体积限制，包会很大）。')
    over = manifest.get('mediaOversizedForSomeHosts') or []
    if over:
        L.append('- 以下 %d 个媒体**已经打进包里，但超过了部分平台的单文件上限**（常见 25MB / 50MB）：' % len(over))
        for f in over: L.append('    · %s（%s MB）' % (f.get('path'), f.get('mb')))
        L.append('  离线双击 index.html 观看不受影响；但要上传托管时可能需要先压缩这些文件。')
    miss = manifest.get('mediaMissing') or []
    if miss:
        L.append('- 以下 %d 个媒体在导出时**源文件已不存在**，包内必然缺失：' % len(miss))
        for f in miss: L.append('    · %s' % f)
    ext = manifest.get('externalVideoUrls') or []
    if ext:
        L.append('- 以下 %d 个**外部视频链接**不在包内，播放时需要能访问对应平台：' % len(ext))
        for u in ext: L.append('    · %s' % u)
        L.append('  提醒：外部平台是否支持页面内播放、进度跳转，取决于该平台本身。')
    L.append('')
    L.append('【关于密钥】')
    L.append('这个 ZIP 里**不包含任何账号凭证**（GitHub 令牌、腾讯云 SecretKey 等一律不在包内）。')
    L.append('凭证只存在你本机的 .folioframe 目录里。')
    L.append('')
    L.append('【关于默认域名】')
    L.append('若上传后用的是平台免费默认域名（例如 *.tcloudbaseapp.com），请注意它通常在')
    L.append('官方定位上属于"开发测试"用途：可能有访问频率限制、或浏览器安全提示中间页。')
    L.append('正式对外分享建议绑定自定义域名。')
    return '\n'.join(L)

def media_preflight(refs, max_bytes=DEFAULT_MAX_FILE_BYTES):
    """Deploy 前媒体体检：返回超过阈值（无法随免费静态托管发布）的文件清单。"""
    oversized = []
    for ref in refs:
        p = MEDIA / ref[len('/media/'):]
        if p.exists():
            sz = p.stat().st_size
            if sz > max_bytes:
                oversized.append({'path': ref, 'bytes': sz,
                                  'mb': round(sz / (1024 * 1024), 1)})
    return oversized

def _public_app_js():
    """静态发布页 / 导出 HTML 要内联的前端脚本。

    ⚠ 顺序敏感：display-zones.js 必须在 app-v3.js **之前** —— 后者渲染时直接读
    window.FF_ZONES，读不到就整体回落默认展示区（用户配好的分区在线上会失效）。
    """
    parts = []
    for name in ('display-zones.js', 'app-v3.js'):
        try:
            parts.append((ROOT / name).read_text(encoding='utf-8'))
        except Exception:
            pass
    return '\n'.join(parts)


def build_public_bundle(out_dir, tpl_id, max_commit_bytes=None):
    """生成脱离本地 FolioFold 也能运行的静态站点（index.html + 404.html + media/）。
    只含已发布 FolioFold 必需内容；内联数据 / Design，不依赖 /api/data 或本地 server。
    max_commit_bytes：若设置，超过该大小的媒体文件不进 media/（返回在 largeMedia 里），
    由调用方走外部媒体后端（如 GitHub Release Assets），避免撑爆普通 Git 仓库 / 触发平台单文件限制。"""
    import shutil as _sh
    tp = tpl_paths(tpl_id)
    published = normalize(read(tp['published']) if tp['published'].exists() else read(tp['draft']))
    design = with_section_order(read(tp['designPublished']) or {}, read(tp['published']) or {})
    # 内联数据 + Design，并把 /media/ 改成相对路径 media/（静态托管根即 bundle 根）
    data_json = json.dumps(published, ensure_ascii=False)
    design_json = json.dumps(design, ensure_ascii=False)
    data_json = data_json.replace('"/media/', '"media/').replace("'/media/", "'media/")
    design_json = design_json.replace('"/media/', '"media/').replace("'/media/", "'media/")
    try:
        css = (ROOT / 'styles.css').read_text(encoding='utf-8') + '\n' + (ROOT / 'public-v2.css').read_text(encoding='utf-8') + '\n' + (ROOT / 'i18n.css').read_text(encoding='utf-8')
    except Exception:
        css = ''
    try:
        # 展示区清单（display-zones.js）必须排在 app-v3.js **前面**先定义好 window.FF_ZONES，
        # 否则静态发布页会因为拿不到清单而整体回落到默认展示区。
        js = _public_app_js()
    except Exception:
        js = ''
    try:
        i18n_js = (ROOT / 'i18n.js').read_text(encoding='utf-8')
    except Exception:
        i18n_js = ''
    # ⑥ 发布页的语言切换必须**真的能用**：之前只内联了 i18n.js 运行时，没带
    #    i18n-zh-en.js（界面字典）和内容译文表 —— 切语言时字典是空的，等于没切。
    #    这里把两样都打进去，并挂 __FF_STATIC_BUILD__ 让发布页不再尝试打翻译接口。
    try:
        i18n_dict_js = (ROOT / 'i18n-zh-en.js').read_text(encoding='utf-8')
    except Exception:
        i18n_dict_js = ''
    content_i18n_obj = {}
    _pub_mode = translation_mode(published)
    for _lang in CONTENT_I18N_LANGS:
        # Phase 3 门控：默认（发布前审核）只内联**已审核**的译文表（观看者看到的必须是过审版本）。
        # 2026-09-26：模式 'direct' 下机翻直接可用 —— 门控结构不变，只是确认要求按模式放开。
        _m = read_content_i18n(tpl_id, _lang, require_reviewed=_pub_mode != 'direct')
        if _m:
            content_i18n_obj[_lang] = _m
    content_i18n_json = json.dumps(content_i18n_obj, ensure_ascii=False).replace('</', '<\\/')
    try:
        runtime = (ROOT / 've-runtime-fix.js').read_text(encoding='utf-8')
    except Exception:
        runtime = ''
    title = str((published.get('profile') or {}).get('name') or 'FolioFold')
    html = (
        '<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="UTF-8" />\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1.0" />\n'
        '<title>' + title + ' — FolioFold</title>\n'
        # 品牌图标：favicon / apple-touch-icon。必须用**相对**路径 ——
        # 站点常挂在 https://<user>.github.io/<repo>/ 子路径下，写成绝对 /media/... 会跑到域名根 → 404。
        '<link rel="icon" type="image/png" href="media/brand/folioframe-icon-256.png" />\n'
        '<link rel="apple-touch-icon" href="media/brand/folioframe-icon-256.png" />\n'
        # ⚠ 品牌字体：以前是 styles.css 里的 @import。本包把 styles.css **原样内联**进 <style>，
        #   那条 @import 就成了渲染阻塞 —— 访客要白等 Google Fonts 超时（实测约 2 秒）。
        #   改成 media="print" 的异步 link：连得上就用、连不上也不拖慢首屏（字体本来就有系统兜底）。
        '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&amp;family=Noto+Sans+SC:wght@400;500;700&amp;family=Playfair+Display:ital,wght@0,500;0,600;1,500&amp;display=swap" media="print" onload="this.media=\'all\'" />\n'
        '<style>\n' + css + '\n</style>\n</head>\n<body>\n'
        '<noscript>请启用 JavaScript 以浏览作品集。</noscript>\n<main id="app"></main>\n'
        '<script>window.__PUBLIC_VIEWER__=true;window.__PORTFOLIO_DATA__=' + data_json + ';'
        'window.__PORTFOLIO_DESIGN__=' + design_json + ';</script>\n'
        '<script>' + i18n_js + '</script>\n'
        '<script>' + i18n_dict_js + '</script>\n'
        '<script>window.__FF_STATIC_BUILD__=true;window.FF_CONTENT_I18N=' + content_i18n_json + ';</script>\n'
        '<script type="module">\n' + js + '\n</script>\n'
        '<script>' + runtime + '</script>\n</body>\n</html>'
    )
    if out_dir.exists():
        _rmtree_forgiving(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / 'index.html').write_text(html, encoding='utf-8')
    (out_dir / '404.html').write_text(html, encoding='utf-8')  # 未知路径也展示作品集，不暴露本地信息
    # 关键：放一个空的 .nojekyll，禁止 GitHub Pages 用 Jekyll 处理本包。
    # 否则页面里内联的 window.__PORTFOLIO_DATA__ = {...} 含大量 { }，会被 Jekyll 的 Liquid 模板引擎
    # 当成 {{ }} / {% %} 误改甚至报错，导致线上 HTML 被改坏（最严重变成空/残缺）。
    (out_dir / '.nojekyll').write_text('', encoding='utf-8')
    # 只复制被引用的媒体（避免把未引用的大文件一起上传）
    refs = collect_media_refs(published, design)
    copied = 0
    largeMedia = []   # 超过 max_commit_bytes 的相对 media 路径（不含 /media/ 前缀），交由外部媒体后端
    missing = []      # 本应复制却没复制成功的媒体（源缺失 / 拷贝失败）—— 绝不允许静默吞掉，
                      # 否则会出现"发布报成功、网页却 404"的假成功。
    for ref in refs:
        rel = ref[len('/media/'):]
        src = MEDIA / rel
        if not src.exists():
            missing.append(rel); continue
        if max_commit_bytes and src.stat().st_size > max_commit_bytes:
            largeMedia.append(rel)
            continue
        dst = out_dir / 'media' / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        try:
            _sh.copyfile(src, dst); copied += 1
        except Exception as e:
            # 拷贝失败（磁盘读取失败 / 被其它程序占用 / 权限）必须记下来并让上层报错，
            # 不能假装复制成功。
            missing.append(rel)
            print('[build_public_bundle] 媒体拷贝失败（将影响发布）：/media/%s -> %s' % (rel, e))
    # 品牌图标：head 里的 favicon / apple-touch-icon 要用，页脚的小 Logo 也要用，
    # 但它们都不属于「内容引用」，别指望 collect_media_refs 会带上 —— 显式复制，
    # 否则线上图标 404（页面里却是指向它的死链）。
    for brand in ('brand/folioframe-icon-256.png', 'brand/folioframe-mark-96.png'):
        bsrc = MEDIA / brand
        if bsrc.exists():
            bdst = out_dir / 'media' / brand
            bdst.parent.mkdir(parents=True, exist_ok=True)
            try:
                _sh.copyfile(bsrc, bdst); copied += 1
            except Exception as e:
                print('[build_public_bundle] 品牌图标拷贝失败：%s' % e)
    return {'files': len(refs), 'mediaCopied': copied, 'largeMedia': largeMedia, 'missing': missing}

def _tc3_sign(secret_key, secret_id, service, host, action, version, region, payload):
    """腾讯云 TC3-HMAC-SHA256 签名。纯标准库，无 SDK 依赖。

    为什么自己实现：CloudBase CLI 需要 Node + npm 全局安装，对一个本地 Python
    服务来说是过重的依赖；而腾讯云 API 的签名算法是公开固定的，用 hmac/hashlib
    实现约 30 行，联网前本地可完全自测（见 verify 脚本）。
    """
    import hmac as _hmac, hashlib as _hashlib, time as _time
    algorithm = 'TC3-HMAC-SHA256'
    timestamp = int(_time.time())
    date = _time.strftime('%Y-%m-%d', _time.gmtime(timestamp))
    # 1) 规范请求串
    ct = 'application/json; charset=utf-8'
    canonical_headers = 'content-type:%s\nhost:%s\nx-tc-action:%s\n' % (ct, host, action.lower())
    signed_headers = 'content-type;host;x-tc-action'
    hashed_payload = _hashlib.sha256(payload.encode('utf-8')).hexdigest()
    canonical_request = '\n'.join(['POST', '/', '', canonical_headers, signed_headers, hashed_payload])
    # 2) 待签名字符串
    credential_scope = '%s/%s/tc3_request' % (date, service)
    hashed_canonical = _hashlib.sha256(canonical_request.encode('utf-8')).hexdigest()
    string_to_sign = '\n'.join([algorithm, str(timestamp), credential_scope, hashed_canonical])
    # 3) 计算签名（逐级派生密钥）
    def _sign(key, msg):
        return _hmac.new(key, msg.encode('utf-8'), _hashlib.sha256).digest()
    secret_date = _sign(('TC3' + secret_key).encode('utf-8'), date)
    secret_service = _sign(secret_date, service)
    secret_signing = _sign(secret_service, 'tc3_request')
    signature = _hmac.new(secret_signing, string_to_sign.encode('utf-8'), _hashlib.sha256).hexdigest()
    # 4) 拼 Authorization
    authorization = ('%s Credential=%s/%s, SignedHeaders=%s, Signature=%s'
                     % (algorithm, secret_id, credential_scope, signed_headers, signature))
    return {
        'Authorization': authorization,
        'Content-Type': ct,
        'Host': host,
        'X-TC-Action': action,
        'X-TC-Version': version,
        'X-TC-Timestamp': str(timestamp),
        'X-TC-Region': region,
    }

def cb_request(action, body, cfg):
    """调用腾讯云 CloudBase HTTP API（tcb.tencentcloudapi.com）。

    返回解析后的 Response 字典；任何业务错误抛 CBError，并翻译成中文可行动提示。
    """
    import urllib.request, urllib.error
    secret_id = (cfg.get('secretId') or '').strip()
    secret_key = (cfg.get('secretKey') or '').strip()
    if not secret_id or not secret_key:
        raise CBError(0, '尚未填写 SecretId / SecretKey')
    region = (cfg.get('region') or 'ap-shanghai').strip()
    host = 'tcb.tencentcloudapi.com'
    version = '2018-06-08'
    payload = json.dumps(body or {}, ensure_ascii=False)
    headers = _tc3_sign(secret_key, secret_id, 'tcb', host, action, version, region, payload)
    req = urllib.request.Request('https://' + host, data=payload.encode('utf-8'),
                                 headers=headers, method='POST')
    try:
        r = net_urlopen(req, timeout=120)
        resp = json.loads(r.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        detail = ''
        try: detail = e.read().decode('utf-8', 'replace')
        except Exception: pass
        # 401/403 基本都是密钥或权限问题，给中文行动指引而不是抛英文
        if e.code in (401, 403):
            raise CBError(e.code, '密钥无效或权限不足，请检查 SecretId / SecretKey 是否正确、'
                                  '以及该密钥是否有 CloudBase 权限')
        raise CBError(e.code, detail[:300] or str(e.reason))
    except CBError:
        raise
    except Exception as e:
        raise CBError(0, '网络错误：' + str(e))
    err = (resp.get('Response') or {}).get('Error')
    if err:
        code = err.get('Code') or ''
        msg = err.get('Message') or ''
        if 'AuthFailure' in code:
            raise CBError(401, '密钥校验失败（%s）。请确认 SecretId / SecretKey 属于同一个腾讯云账号。' % code)
        if 'LimitExceeded' in code or 'ResourceInUse' in code:
            raise CBError(409, '操作过于频繁或资源被占用（%s）：%s' % (code, msg))
        raise CBError(0, '%s：%s' % (code, msg))
    return resp.get('Response') or {}

# ---------- CloudBase 只读探测（用创作者自己的密钥，只查不改）----------
def cb_probe_impl(cfg):
    """只读探测：云开发是否开通、名下环境列表、静态托管是否开通、默认域名。

    只用 DescribeEnvs（只读，免费，不会产生任何费用或资源变更）。
    返回结构：
      {'serviceOpened': bool, 'environments': [...], 'note': str}
    environments 每项：{envId, alias, packageName, region, status,
                       staticOpened, staticDomain, source, createTime}

    ⚠ 只读失败一律如实返回 error，绝不编造"已开通"。密钥不完整时明确告知。
    """
    out = {'serviceOpened': False, 'environments': [], 'error': ''}
    if not cfg or not (cfg.get('secretId') or '').strip() or not (cfg.get('secretKey') or '').strip():
        out['error'] = '尚未填写 SecretId / SecretKey，无法查询你的腾讯云环境。'
        return out
    try:
        resp = cb_request('DescribeEnvs', {}, cfg)
    except CBError as e:
        out['error'] = str(e)
        return out
    envs = resp.get('EnvList') or []
    out['serviceOpened'] = True          # 能调通 DescribeEnvs 即说明云开发已开通
    for e in envs:
        statics = e.get('StaticStorages') or []
        st_open = any((s.get('Status') or '').lower() == 'online' for s in statics)
        domain = ''
        for s in statics:
            if (s.get('StaticDomain') or '').strip():
                domain = s['StaticDomain'].strip()
                break
        out['environments'].append({
            'envId': e.get('EnvId') or '',
            'alias': e.get('Alias') or '',
            'packageName': e.get('PackageName') or '',
            'packageId': e.get('PackageId') or '',
            'region': e.get('Region') or '',
            'status': e.get('Status') or '',
            'source': e.get('Source') or '',
            'createTime': e.get('CreateTime') or '',
            'staticOpened': bool(st_open),
            'staticDomain': domain,
        })
    if not out['environments']:
        out['note'] = ('你的账号下还没有 CloudBase 环境。请到 CloudBase 控制台新建一个'
                       '（免费体验版，只能在网页创建）。')
    return out

def cb_quota_impl(cfg):
    """只读查询环境的套餐与到期信息（DescribeBillingInfo）。

    ⚠ 该接口在不同账号/套餐下的字段完整度不一致：拿不到就如实留空，
      由前端显示「未知」，绝不猜测或编造天数。
    """
    out = {'ok': False, 'envId': (cfg or {}).get('envId') or '', 'error': ''}
    if not cfg or not (cfg.get('secretId') or '').strip() or not (cfg.get('secretKey') or '').strip():
        out['error'] = '尚未配置密钥，无法查询套餐与到期信息。'
        return out
    env_id = (cfg.get('envId') or '').strip()
    body = {'EnvIds': [env_id]} if env_id else {}
    try:
        resp = cb_request('DescribeBillingInfo', body, cfg)
    except CBError as e:
        out['error'] = str(e)
        return out
    items = resp.get('EnvBillingInfoList') or []
    item = None
    for it in items:
        if not env_id or (it.get('EnvId') or '') == env_id:
            item = it
            break
    if item is None and items:
        item = items[0]
    if item is None:
        out['error'] = '未查到该环境的计费信息（可能套餐较新或接口暂未返回）。'
        return out
    out.update({
        'ok': True,
        'envId': item.get('EnvId') or env_id,
        'packageId': item.get('PackageId') or '',
        'status': item.get('Status') or '',
        'payMode': item.get('PayMode') or '',
        'expireTime': item.get('ExpireTime') or '',
        'createTime': item.get('CreateTime') or '',
        'isolatedTime': item.get('IsolatedTime') or '',
        'autoRenew': bool(item.get('IsAutoRenew')),
        'isAlwaysFree': bool(item.get('IsAlwaysFree')),
        'freeQuota': item.get('FreeQuota') or '',
        'envCharged': item.get('EnvCharged') or '',
    })
    return out

# ---------- 发布前权限体检（只读为主，写探测自清理）----------
# ⚠ 为什么必须有这一步（2026-09-19 真实故障）：
#   静态托管"上传文件"底层是**往 COS 桶写对象**（桶名形如 4f9f-static-<envId>-<appid>），
#   而 DescribeEnvs / DescribeStaticStore 走的是 tcb 服务。两者权限互相独立，
#   于是子账号完全可能出现「读得到环境、写不了任何文件」——CLI 原文只有一句
#   `Access Denied`，用户以为是"没授权"，实际是**授权挂错了层**。
#   本函数把它翻译成：你是谁 → 缺哪个权限 → 去哪开。
CB_PERM_STRATEGY = 'QcloudCOSFullAccess'   # 对象存储 COS 全读写访问权限，上传静态托管文件必需
CB_CAM_URL = 'https://console.cloud.tencent.com/cam'

def cb_tc_call(service, host, action, version, body, cfg, region=''):
    """通用腾讯云 API 调用（诊断用）。**不抛异常**，返回 (http_code, resp_dict)。

    与 cb_request 的区别：cb_request 专供 tcb 且把错误翻译成中文抛出；
    而做权限体检时"被拒绝"本身就是答案，必须原样拿到错误码。
    """
    import urllib.request, urllib.error
    secret_id = (cfg.get('secretId') or '').strip()
    secret_key = (cfg.get('secretKey') or '').strip()
    if not secret_id or not secret_key:
        return 0, {'error': '尚未填写 SecretId / SecretKey'}
    payload = json.dumps(body or {}, ensure_ascii=False)
    try:
        headers = _tc3_sign(secret_key, secret_id, service, host, action, version, region or '', payload)
    except Exception as e:
        return 0, {'error': '签名失败：%s' % e}
    req = urllib.request.Request('https://' + host, data=payload.encode('utf-8'),
                                 headers=headers, method='POST')
    try:
        r = net_urlopen(req, timeout=30)
        return r.status, json.loads(r.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        raw = ''
        try: raw = e.read().decode('utf-8', 'replace')
        except Exception: pass
        try: return e.code, json.loads(raw)
        except Exception: return e.code, {'raw': raw[:300]}
    except Exception as e:
        return 0, {'error': '%s: %s' % (type(e).__name__, e)}

def _cos_sign_v5(secret_id, secret_key, method, host, uri, query=None, headers=None):
    """腾讯云 COS 签名（q-sign-algorithm=sha1，即 v5）。纯标准库实现，已对真实桶验证过。"""
    import hmac as _hmac, hashlib as _hashlib, time as _time, urllib.parse as _up
    query = query or {}
    hdrs = dict(headers or {})
    hdrs['Host'] = host
    now = int(_time.time())
    key_time = '%d;%d' % (now, now + 3600)
    sign_key = _hmac.new(secret_key.encode('utf-8'), key_time.encode('utf-8'), _hashlib.sha1).hexdigest()
    lk = sorted([k.lower() for k in hdrs])
    parts = []
    for k in lk:
        orig = [x for x in hdrs if x.lower() == k][0]
        parts.append('%s=%s' % (k, _up.quote(str(hdrs[orig]), safe='')))
    param_keys = sorted(query.keys())
    param_str = '&'.join('%s=%s' % (k, _up.quote(str(query[k]), safe='')) for k in param_keys)
    http_string = '%s\n%s\n%s\n%s\n' % (method.lower(), uri, param_str, '&'.join(parts))
    string_to_sign = 'sha1\n%s\n%s\n' % (key_time, _hashlib.sha1(http_string.encode('utf-8')).hexdigest())
    signature = _hmac.new(sign_key.encode('utf-8'), string_to_sign.encode('utf-8'), _hashlib.sha1).hexdigest()
    return ('q-sign-algorithm=sha1&q-ak=%s&q-sign-time=%s&q-key-time=%s'
            '&q-header-list=%s&q-url-param-list=%s&q-signature=%s'
            % (secret_id, key_time, key_time, ';'.join(lk), ';'.join([k.lower() for k in param_keys]), signature))

def _cos_request(cfg, method, host, uri='/', query=None, body=b''):
    """对 COS 发一次请求，返回 (status, text)。仅用于权限体检，不改变业务数据。"""
    import urllib.request, urllib.error, urllib.parse
    sid = (cfg.get('secretId') or '').strip()
    skey = (cfg.get('secretKey') or '').strip()
    auth = _cos_sign_v5(sid, skey, method, host, uri, query or {})
    qs = ('?' + urllib.parse.urlencode(query)) if query else ''
    req = urllib.request.Request('https://%s%s%s' % (host, uri, qs),
                                 data=(body if method.lower() in ('put', 'post') else None),
                                 headers={'Authorization': auth, 'Host': host},
                                 method=method.upper())
    try:
        r = net_urlopen(req, timeout=30)
        return r.status, r.read().decode('utf-8', 'replace')[:300]
    except urllib.error.HTTPError as e:
        try: return e.code, e.read().decode('utf-8', 'replace')[:300]
        except Exception: return e.code, ''
    except Exception as e:
        return 0, '%s: %s' % (type(e).__name__, e)

def cb_permcheck_impl(cfg):
    """发布前权限体检：回答"为什么上传 Access Denied"。

    检查项（全部无害）：① 密钥身份（主账号 / 子用户）② tcb 读能力 ③ 静态托管读能力
    ④ COS 桶访问能力（只读探测）⑤ 必要时做一次 0 字节写入自检并立即删除。
    结论一律有据可依；查不到就说查不到，绝不猜。
    """
    out = {'ok': False, 'canDeploy': False, 'identity': {}, 'checks': [], 'verdict': '', 'fix': [], 'error': ''}
    secret_id = (cfg.get('secretId') or '').strip()
    secret_key = (cfg.get('secretKey') or '').strip()
    if not (secret_id and secret_key):
        out['error'] = '尚未填写 SecretId / SecretKey，无法体检。'
        return out
    region = (cfg.get('region') or 'ap-shanghai').strip()
    env_id = (cfg.get('envId') or '').strip()

    def rec(name, ok, detail):
        out['checks'].append({'name': name, 'ok': bool(ok), 'detail': detail})

    # ① 身份：sts:GetCallerIdentity（绝大多数密钥都可调用，是最可靠的"你是谁"）
    st, r = cb_tc_call('sts', 'sts.tencentcloudapi.com', 'GetCallerIdentity', '2018-08-13', {}, cfg, region)
    ident = (r.get('Response') or {}) if isinstance(r, dict) else {}
    itype = ident.get('Type') or ''
    out['identity'] = {
        'type': itype,
        'accountId': ident.get('AccountId') or '',
        'userId': ident.get('UserId') or '',
        'arn': ident.get('Arn') or '',
        'isSubAccount': (itype == 'CAMUser'),
        'known': bool(itype),
    }
    if itype:
        rec('密钥身份', True, ('子用户（Uid %s，属主账号 %s）' % (out['identity']['userId'], out['identity']['accountId']))
            if itype == 'CAMUser' else '主账号密钥')
    else:
        rec('密钥身份', False, (ident.get('Error') or {}).get('Message') or r.get('error') or '无法识别')

    # ② tcb 读能力
    st2, r2 = cb_tc_call('tcb', 'tcb.tencentcloudapi.com', 'DescribeEnvs', '2018-06-08',
                         {'EnvId': env_id} if env_id else {}, cfg, region)
    envs = (r2.get('Response') or {}).get('EnvList') if isinstance(r2, dict) else None
    rec('CloudBase 环境可读', bool(envs), '读到 %d 个环境' % len(envs) if envs else
        ((r2.get('Response') or {}).get('Error', {}).get('Code') or '读取失败'))

    # ③ 静态托管读能力（同时拿真实桶名与默认域名）
    st3, r3 = cb_tc_call('tcb', 'tcb.tencentcloudapi.com', 'DescribeStaticStore', '2018-06-08',
                         {'EnvId': env_id} if env_id else {}, cfg, region)
    stores = (r3.get('Response') or {}).get('Data') if isinstance(r3, dict) else None
    bucket, domain, store_region = '', '', region
    if stores:
        for s in stores:
            if not env_id or (s.get('EnvId') or '') == env_id:
                bucket = s.get('Bucket') or ''
                domain = s.get('CdnDomain') or ''
                store_region = s.get('Region') or s.get('Regoin') or region
                break
        if not bucket and stores:
            bucket = stores[0].get('Bucket') or ''
            domain = stores[0].get('CdnDomain') or ''
    out['bucket'] = bucket
    out['staticDomain'] = domain
    rec('静态托管可读', bool(stores), ('存储桶 ' + bucket) if bucket else '静态托管未开通或读取失败')

    # ④⑤ COS 访问能力：上传文件 = 往这个桶写对象，这一层才是 Access Denied 的真正来源。
    # ⚠ 直接实测写能力，而不是"先看 HEAD 再决定"：HEAD 403 也可能只是缺 HeadBucket 权限，
    #   只有真正 PUT 一次才能确定"到底能不能上传"。自检对象 0 字节，成功即刻删除。
    write_ok, write_detail = None, ''
    if bucket:
        host = '%s.cos.%s.myqcloud.com' % (bucket, store_region)
        hcode, _hb = _cos_request(cfg, 'HEAD', host, '/')
        rec('对象存储（COS）桶可读', hcode in (200, 204), 'HTTP %s' % hcode)
        pcode, _pb = _cos_request(cfg, 'PUT', host, '/.folioframe-permcheck', body=b'')
        if pcode in (200, 204):
            _cos_request(cfg, 'DELETE', host, '/.folioframe-permcheck')
            write_ok, write_detail = True, '写入自检通过（自检文件已自动删除）'
        elif pcode == 403:
            write_ok, write_detail = False, 'HTTP 403 Access Denied —— 该密钥没有这个桶的写入权限'
        else:
            write_ok, write_detail = False, 'HTTP %s' % (pcode or '(无响应)')
        rec('对象存储（COS）可写', bool(write_ok), write_detail)
    else:
        rec('对象存储（COS）桶可读', False, '未能取得存储桶名，无法判断')

    # ---- 结论 ----
    if write_ok:
        out['ok'] = True; out['canDeploy'] = True
        out['verdict'] = '权限正常：能读环境、也能写对象存储，可以直接发布。'
        return out
    if write_ok is None:
        out['verdict'] = '未能确认对象存储写权限（存储桶名没取到）。请先确认静态托管已开通。'
        return out

    out['ok'] = False; out['canDeploy'] = False
    if out['identity'].get('isSubAccount'):
        out['verdict'] = ('你的密钥属于**子用户**（Uid %s，属主账号 %s）。它只能读 CloudBase 环境，'
                          '但**没有对象存储（COS）的写权限**——而"上传文件"底层就是往 COS 桶写对象，'
                          '所以每个文件都被拒（Access Denied）。这不是"没授权"，是**授权挂在了错的层**。'
                          % (out['identity']['userId'], out['identity']['accountId']))
        out['fix'] = [
            '打开访问管理 CAM → 用户 → 用户列表',
            '在 CAM「用户列表」里找到 Uid %s 这个子账号**所在的那一行**，点该行右侧操作列的「授权」' % out['identity']['userId'],
            '搜索并勾选 %s（对象存储 COS 全读写访问权限，上传文件到静态托管必需）' % CB_PERM_STRATEGY,
            '确定保存后回到本面板，再点一次「更新发布」',
        ]
    else:
        out['verdict'] = ('这把密钥未被评为子用户但 COS 仍拒绝写入。请检查密钥是否被禁用、账号是否欠费，'
                          '以及是否有关联了显式 Deny 的策略。')
        out['fix'] = [
            '打开访问管理 CAM → 用户 → 用户列表',
            '确认该密钥对应的用户未被禁用、账号无欠费',
            '检查是否有关联显式拒绝（Deny）COS 的自定义策略',
        ]
    out['camUrl'] = CB_CAM_URL
    return out


# 不模拟、不假装：直接用创作者自己的 SecretId/SecretKey 走 CloudBase CLI 完成
# 登录 → 静态托管上传 → 返回真实 URL，并对 URL 做真实可达性校验。
# 任一环节失败都抛 CBError，绝不让"上传完"等于"发布成功"。
def _cloudbase_cli_path():
    """定位 CloudBase CLI（cloudbase / tcb）**可被 Windows 直接执行的**入口。

    优先级：① 环境变量 CLOUDBASE_CLI（绝对路径）② PATH 里的 cloudbase/tcb
    ③ 常见安装位置。找不到返回 None，由调用方给出可执行安装指引，绝不假装成功。

    ⚠ 2026-09-19 修复 WinError 193：
      npm 安装的包在 bin 目录同时放了三份入口 —— `cloudbase`（**sh 脚本**）、
      `cloudbase.cmd`、`cloudbase.ps1`。`shutil.which('cloudbase')` 在 Windows 上
      会优先命中**没有扩展名的 sh 脚本**，而 subprocess 直接 exec 它会报
      「[WinError 193] %1 不是有效的 Win32 应用程序」——真实踩到（用户点发布即失败）。
      因此这里必须**显式挑出可执行入口**：.cmd/.exe/.bat > .ps1 > node_modules 里的
      真实 JS 入口（用 node 跑）> 最后才退回裸 sh 脚本（仅在非 Windows 上合理）。
    """
    def _pick_from_bindir(bindir):
        """在一个 npm bin 目录里挑出可执行入口，返回 (kind, path) 或 None。"""
        if not bindir or not os.path.isdir(bindir):
            return None
        # ① Windows 原生批处理 / 可执行文件
        for ext in ('.cmd', '.exe', '.bat'):
            p = os.path.join(bindir, 'cloudbase' + ext)
            if os.path.exists(p):
                return ('exec', p)
        # ② node_modules 里的真实 JS 入口（用 node 执行，最稳）
        for rel in (os.path.join('node_modules', '@cloudbase', 'cli', 'bin', 'cloudbase'),
                    os.path.join('node_modules', '@cloudbase', 'cli', 'bin', 'cloudbase.js')):
            p = os.path.join(bindir, rel)
            if os.path.exists(p):
                return ('node', p)
        # ③ PowerShell 脚本（次选，需要 shell 承载）
        p = os.path.join(bindir, 'cloudbase.ps1')
        if os.path.exists(p):
            return ('exec', p)
        # ④ 非 Windows 上 sh 脚本才是正常入口
        if os.name != 'nt':
            p = os.path.join(bindir, 'cloudbase')
            if os.path.exists(p):
                return ('exec', p)
        return None

    env_path = os.environ.get('CLOUDBASE_CLI') or ''
    if env_path and os.path.exists(env_path):
        return env_path

    # PATH：先看 which 给的路径所在目录，再逐个找可执行入口
    for name in ('cloudbase', 'tcb'):
        p = shutil.which(name)
        if p:
            hit = _pick_from_bindir(os.path.dirname(p))
            if hit:
                _CB_CLI_KIND[0] = hit[0]
                return hit[1]
            # which 命中的就是唯一入口（非 Windows 场景）
            if os.name != 'nt':
                return p

    candidates = [
        os.path.expandvars(r'%APPDATA%\npm'),
        os.path.expandvars(r'%APPDATA%\npm\node_modules\.bin'),
        os.path.expanduser('~/.cloudbase/cli'),
        # 本机/沙箱可能由 WorkBuddy 自带
        os.path.expanduser('~/.workbuddy/binaries/node/cli-connector-packages'),
        os.path.expanduser('~/.workbuddy/binaries/node/workspace/node_modules/.bin'),
    ]
    for d in candidates:
        hit = _pick_from_bindir(d)
        if hit:
            _CB_CLI_KIND[0] = hit[0]
            return hit[1]
    return None


# 记录 CLI 入口类型：'exec'（直接执行）或 'node'（用 node 跑 JS 入口）。
# _cloudbase_cli_path() 探测时写入，_run_cloudbase() 据此决定怎么起进程。
_CB_CLI_KIND = ['exec']

# node 解释器路径（跑 JS 入口用）。找不到就退回 PATH 里的 node。
def _node_exe():
    import shutil as _sh
    for c in (os.path.expanduser('~/.workbuddy/binaries/node/versions/22.22.2-2/node.exe'),
              _sh.which('node')):
        if c and os.path.exists(c):
            return c
    return 'node'


def _run_cloudbase(args, timeout=1800):
    """运行 CloudBase CLI，返回 (returncode, combined_output)。

    不做任何"成功假设"：returncode != 0 由调用方决定如何报错。
    timeout 是整进程墙钟，避免 CLI 卡死把发布线程挂住（复用 _pub_job_watchdog 兜底）。
    """
    _CB_CLI_KIND[0] = 'exec'
    cli = _cloudbase_cli_path()
    if not cli:
        return (-1, 'CLOUDBASE_CLI_NOT_FOUND')
    # npm 的 JS 入口要用 node 承载；否则 Windows 会报 WinError 193。
    argv = ([_node_exe(), cli] if _CB_CLI_KIND[0] == 'node' else [cli]) + list(args)
    # 关键修复：cloudbase.cmd 内部会再调一次 `node ...`，但服务经 .bat 拉起时 PATH 里
    # 通常没有 node，会报 "'node' is not recognized"。这里把 node 所在目录**显式加进子进程
    # 的 PATH**，与当前进程的环境解耦——无论服务怎么被启动都能找到 node。
    env = dict(os.environ)
    node_bin = os.path.dirname(_node_exe())
    if node_bin and os.path.isdir(node_bin):
        _p = env.get('PATH', '')
        if node_bin.lower() not in _p.lower():
            env['PATH'] = node_bin + os.pathsep + _p
    try:
        proc = subprocess.run(argv, capture_output=True, text=True,
                              timeout=timeout, env=env,
                              shell=False)
    except subprocess.TimeoutExpired:
        return (-2, 'TIMEOUT')
    except OSError as e:
        # 兜底：把"入口选错了"这类系统级错误翻译成可行动的中文，不再裸抛 WinError。
        return (-3, 'CLOUDBASE_CLI_NOT_EXECUTABLE: %s（入口：%s）' % (e, cli))
    out = (proc.stdout or '') + '\n' + (proc.stderr or '')
    return (proc.returncode, out)


def cloudbase_delete_dir(cfg, cloud_path):
    """真正从 CloudBase 静态托管里删掉某个子目录（该模板的那条发布）。

    用官方 CLI：`cloudbase hosting delete <cloudPath> --dir`（3.8.1 起支持删除目录）。
    ⚠ 只删指定 cloudPath，绝不删站点根、不碰其它模板的路径。
    返回 (ok, message)。目录本来就不存在时视为已删除（幂等）。"""
    cloud_path = (str(cloud_path or '').strip().strip('/'))
    if not cloud_path:
        return False, '拒绝删除站点根目录。请到腾讯云控制台手动处理。'
    cfg = cfg or {}
    env_id = (cfg.get('envId') or '').strip()
    sid = (cfg.get('secretId') or '').strip()
    skey = (cfg.get('secretKey') or '').strip()
    if not (env_id and sid and skey):
        return False, 'CloudBase 未配置完整，无法删除线上目录（可先在本机记录中移除）。'
    cli = _cloudbase_cli_path()
    if not cli:
        return False, '未找到 CloudBase CLI，无法删除线上目录（可先在本机记录中移除）。'
    rc, out = _run_cloudbase(['login', '--apiKeyId', sid, '--apiKey', skey], timeout=120)
    if rc != 0:
        return False, 'CloudBase 登录失败，未删除线上目录：' + out[-300:]
    rc, out = _run_cloudbase(['hosting', 'delete', cloud_path, '--dir', '-e', env_id], timeout=600)
    if rc != 0:
        low = out.lower()
        # 目录不存在 = 已经是目标状态，视为成功（幂等）
        if 'not exist' in low or 'not found' in low or '不存在' in out or '404' in out:
            return True, '该目录在线上已不存在（幂等）。'
        return False, 'CloudBase 删除失败：' + out[-400:]
    return True, '已从 CloudBase 删除 /%s/。' % cloud_path


def _verify_cloudbase_deploy(url, bundle_dir):
    """上传后真实校验（对应需求第 8 条）：URL 能打开、HTML 正常、视频 URL 正确且
    Content-Type / Range 正常。任一项不通过就抛 CBError —— 绝不"上传完就报成功"。

    章节跳转的硬依赖是 video/mp4 + HTTP 206（见项目记忆），所以这里用 Range 请求
    校验视频，等价于校验 Showreel 章节跳转能否工作。
    """
    import time as _t
    import urllib.request as _ureq
    bundle_dir = Path(bundle_dir)
    base = url.rstrip('/')

    def _get(target, with_range=False, timeout=30):
        hdr = {'User-Agent': 'FolioFold-Verify'}
        if with_range:
            hdr['Range'] = 'bytes=0-65535'
        return net_urlopen(_ureq.Request(target, headers=hdr), timeout=timeout)

    # 1) 首页：可打开 + 内容正常（重试应对静态托管刚发布时的传播延迟）
    last = None
    for _ in range(4):
        try:
            with _get(base + '/') as r:
                body = r.read(8192).decode('utf-8', 'replace')
            if r.status != 200 or ('__PORTFOLIO_DATA__' not in body and 'FolioFold' not in body):
                last = '首页返回 %s 或内容异常' % getattr(r, 'status', '?')
                _t.sleep(3); continue
            break
        except Exception as e:
            last = '首页无法访问：%s' % e
            _t.sleep(3)
    else:
        raise CBError(0, '部署后校验失败（首页）：' + str(last))

    # 2) 视频：Content-Type 必须是 video/* 且支持 Range（206 或 Accept-Ranges: bytes）
    vids = sorted(bundle_dir.glob('media/**/*.mp4'), key=lambda p: p.stat().st_size, reverse=True)
    if vids:
        vrel = 'media/' + str(vids[0].relative_to(bundle_dir / 'media')).replace('\\', '/')
        vurl = base + '/' + vrel
        try:
            with _get(vurl, with_range=True) as r:
                status = r.status
                ct = (r.headers.get('Content-Type') or '').lower()
                ar = (r.headers.get('Accept-Ranges') or '').lower()
        except Exception as e:
            raise CBError(0, '视频校验失败（%s）：%s' % (vurl, e))
        if status not in (200, 206):
            raise CBError(0, '视频校验失败：HTTP %s（期望 200/206）' % status)
        if 'video' not in ct:
            raise CBError(0, '视频 Content-Type 异常：%s（期望含 video）' % ct)
        if status != 206 and 'bytes' not in ar:
            raise CBError(0, '视频似乎不支持 Range 请求（status=%s, Accept-Ranges=%r）—— Showreel 章节跳转可能失效' % (status, ar))
    return True


def cloudbase_deploy(bundle_dir, cfg):
    """把 bundle 目录里的静态文件**真实**部署到 CloudBase 静态网站托管。

    真实链路（非模拟）：
      1) 用创作者自己的 SecretId/SecretKey 非交互登录 CloudBase CLI
         （`cloudbase login --apiKeyId <id> --apiKey <key>`，密钥只来自本机 cloudbase.json）。
      2) `cloudbase hosting deploy <bundle> <cloudPath> -e <envId> --verify`
         把整包（含 67MB 视频）上传到静态托管。CLI 通道单文件上限 50TB 级，
         远大于网页上传的 50MB，因此 67MB Showreel 走 CLI 不会触发大小限制。
      3) 返回默认域名 URL（<envId>.tcloudbaseapp.com）。
      4) 真实校验 URL / HTML / 视频 Content-Type+Range（见 _verify_cloudbase_deploy）。

    ⚠ 默认域名官方定位为"开发测试"，可能有频率限制与安全提示中间页；
      正式对外建议绑自定义域名（需 ICP 备案）。
    任何一步失败都**明确抛 CBError**，绝不假装成功。
    """
    bundle_dir = Path(bundle_dir)
    if not bundle_dir.exists():
        raise CBError(0, 'CloudBase 发布缺少打包目录')
    cfg = cfg or {}
    env_id = (cfg.get('envId') or '').strip()
    sid = (cfg.get('secretId') or '').strip()
    skey = (cfg.get('secretKey') or '').strip()
    sub = (cfg.get('path') or '').strip().strip('/')
    if not (env_id and sid and skey):
        raise CBError(0, 'CloudBase 尚未配置：请在发布面板填入 EnvId 与 SecretId / SecretKey（需自备腾讯云账号）。')

    cli = _cloudbase_cli_path()
    if not cli:
        raise CBError(0, '未找到 CloudBase CLI，无法真实发布。请先安装：在命令行执行 '
                         '`npm install -g @cloudbase/cli`（装完重开终端），或在「FolioFold 开发者选项」里'
                         '指定 CloudBase CLI 的绝对路径（环境变量 CLOUDBASE_CLI）。')

    # 1) 非交互登录（永久密钥）
    pub_job_phase('授权中', '正在用 SecretId / SecretKey 登录腾讯云 CloudBase…')
    rc, out = _run_cloudbase(['login', '--apiKeyId', sid, '--apiKey', skey], timeout=120)
    if rc == -3 or 'CLOUDBASE_CLI_NOT_EXECUTABLE' in out:
        raise CBError(0, 'CloudBase CLI 定位到了但无法执行（' + out[-200:] + '）。'
                         '这通常是 npm 在 Windows 上把 Unix 版启动脚本也放进了 bin 目录导致的。'
                         '请在「FolioFold 开发者选项」里把 CloudBase CLI 路径指向 cloudbase.cmd，'
                         '或设置环境变量 CLOUDBASE_CLI。')
    if rc != 0:
        tail = out[-700:] if out not in ('CLOUDBASE_CLI_NOT_FOUND', 'TIMEOUT') else out
        # 安全兜底：若 CLI 因为找不到 node 起不来（仍有可能发生在极特殊的启动环境），
        # 给一句人话，而不是把操作系统的英文报错原样甩给用户。
        if "'node'" in tail or '"node"' in tail:
            raise CBError(rc, 'CloudBase CLI 需要 Node.js 才能运行，但当前运行环境里找不到 node（原始报错：'
                             + tail.strip()[-260:] + '）。\n'
                             '本机已自带 Node.js，重启 FolioFold 服务即可自动修复；若仍失败，'
                             '在「FolioFold 开发者选项」里设置环境变量 CLOUDBASE_CLI 指向 cloudbase.cmd 的绝对路径。')
        raise CBError(rc, 'CloudBase 登录失败（请确认 SecretId/SecretKey 正确、属于同一腾讯云账号、'
                         '且密钥具有 CloudBase 访问权限）：\n' + tail)

    # 2) 上传（CLI 通道支持大文件，含 67MB 视频）
    pub_job_phase('上传中', '正在上传静态文件到 CloudBase 静态网站托管（含视频，可能需数分钟）…')
    args = ['hosting', 'deploy', str(bundle_dir), '-e', env_id, '--verify']
    if sub:
        args.insert(3, sub)   # 第二个位置参数 = cloudPath
    rc, out = _run_cloudbase(args, timeout=1800)
    if rc != 0:
        tail = out[-700:]
        if 'Access Denied' in out or 'access denied' in out.lower():
            # 2026-09-19 实测：只读接口全通、写操作全被拒 = 密钥缺少 CloudBase 写权限。
            # 这是**权限配置问题**，不是网络/环境问题，必须给出可行动的下一步，
            # 而不是把 CLI 的英文原文甩给用户。
            tail = ('\n\n【为什么】你当前的 SecretId 能读取环境（只读接口正常），但**没有写入权限**，'
                    '所以文件传不上去。\n'
                    '【怎么修】到腾讯云「访问管理 CAM」→ 用户列表，检查这把密钥对应的账号：\n'
                    '  · 如果是**主账号密钥** → 正常情况下不该被拒。请确认密钥未被禁用、账号无欠费。\n'
            '  · 如果是**子账号密钥** → 它缺少**对象存储（COS）的写权限**。上传文件底层是往对象存储桶写对象，'
            '所以每个文件都会 Access Denied。给该子用户关联**两条**策略（缺一条都不行）：\n'
            '    - `QcloudTCBFullAccess`（CloudBase 环境读写）\n'
            '    - `QcloudCOSFullAccess`（对象存储 COS 全读写访问权限，上传文件靠它）\n'
            '    只挂 `QcloudTCBFullAccess` 会出现「能读环境、但上传每个文件都 Access Denied」。\n'
            '  · 授权入口：CAM → 左侧「用户」→「用户列表」→ 找到该子账号**所在的那一行**，'
            '点该行右侧操作列的「授权」（入口在列表行上，主账号行没有这个入口）→ '
            '在「关联策略」窗口分别搜上面两个策略名 → 勾选 → 确定。\n'
            '  · 不确定自己缺哪条？回到面板点「🔍 权限体检」一键查（它会真去读身份 + 试写一次）。\n'
                    '【验证】改完后回到本面板再点一次「发布到 CloudBase」，或先点「检测我的 CloudBase 环境」'
                    '确认读得到环境。\n\n--- CLI 原文 ---\n' + tail)
        elif 'static' in out.lower() and ('enable' in out.lower() or '开通' in out or 'not' in out.lower()):
            tail += '\n（提示：该环境可能尚未开通「静态网站托管」，请到腾讯云 CloudBase 控制台 → 静态网站托管 → 开启。）'
        raise CBError(rc, 'CloudBase 上传失败：\n' + tail)

    # 3) 构造公开 URL
    # ⚠ 2026-09-19 实测修正：默认域名**不是** `<envId>.tcloudbaseapp.com`，
    #    真实形态是 `<envId>-<随机数字串>.tcloudbaseapp.com`
    #    （本例 folioframe-site-d4f57yrt27bf927f-1486162327.tcloudbaseapp.com）。
    #    随机串只能从接口读（DescribeEnvs → StaticStorages[].StaticDomain），不能猜。
    #    读不到才退回拼法，并如实记录到日志（绝不静默用一个大概是错的地址）。
    url = _cloudbase_default_domain(env_id, cfg)
    url += ('/' + sub + '/') if sub else '/'
    pub_log('CloudBase 上传完成，开始校验：' + url)

    # 4) 真实校验（不通过则视为发布失败）
    _verify_cloudbase_deploy(url, bundle_dir)
    pub_log('CloudBase 部署成功并通过校验：' + url)
    return url


def _cloudbase_default_domain(env_id, cfg):
    """读该环境的**真实**默认访问域名（<envId>-<随机串>.tcloudbaseapp.com）。

    官方并没有 `<envId>.tcloudbaseapp.com` 这种拼法；随机串由平台分配，
    只能通过 DescribeEnvs 的 StaticStorages[].StaticDomain 拿到。
    读不到时退回拼法并把原因写进日志 —— 让"可能是错的地址"这件事可见，
    而不是让面板显示一个看起来正常的错链接。
    """
    try:
        env = dict(cfg or {})
        env['envId'] = env_id
        res = cb_probe_impl(env)
        for e in (res.get('environments') or []):
            if (e.get('envId') or '').strip() == env_id and e.get('staticDomain'):
                return 'https://' + str(e['staticDomain']).strip().lstrip('https://').lstrip('http://').strip('/')
        pub_log('⚠ 未能从接口读到该环境的默认域名，将退回拼法 <envId>.tcloudbaseapp.com（可能不正确）')
    except Exception as e:
        pub_log('⚠ 读取默认域名失败：%s，将退回拼法（可能不正确）' % e)
    return 'https://%s.tcloudbaseapp.com' % env_id

# ======================= PublishProvider 抽象（核心只认 Provider）=======================
class PublishProvider:
    """所有公网部署 Provider 的统一接口。当前实现：github / cloudbase。
    新增渠道只需新增一个子类并注册到 PUBLISH_PROVIDERS，
    现有「发布核心」（确保 Published Snapshot → 打包 → 调 provider.publish）完全不用改。"""
    id = 'base'; name = 'Base'
    def configured(self, cfg): raise NotImplementedError
    def status_extras(self, cfg, link): return {}
    def publish(self, bundle_dir, tpl, meta): raise NotImplementedError

class CloudBaseProvider(PublishProvider):
    """腾讯云 CloudBase 静态网站托管（国内部署备选渠道）。

    ⚠ 与 GitHub Pages 的定位不同，务必在 UI 上说清楚：
      - **不是一键授权**。腾讯云没有面向第三方应用的 OAuth，创作者必须自己
        注册腾讯云 → 实名 → 建 CloudBase 环境 → 创建 SecretId/SecretKey，
        再把 EnvId 等填进来。配置成本明显高于 GitHub。
      - 免费体验版默认域名（*.tcloudbaseapp.com）官方只建议用于测试：有频率限制、
        且浏览器直访可能出现安全提示中间页。要去掉中间页需绑自定义域名 → 需 ICP 备案
        → 免费环境不支持备案，须升级个人版。
      - 免费环境资源点用尽后**停服**（不支持按量付费），每 6 个月需手动续期。

    因此本 Provider 只负责「用创作者自己填的凭证把静态包传上去」，
    绝不代为创建环境，也绝不声称「点一下就能发布」。
    """
    id = 'cloudbase'; name = 'CloudBase（国内部署，需要腾讯云配置）'
    def configured(self, cfg):
        if not cfg or cfg.get('provider') != 'cloudbase':
            return False
        return bool((cfg.get('envId') or '').strip() and (cfg.get('secretId') or '').strip()
                    and (cfg.get('secretKey') or '').strip())
    def status_extras(self, cfg, link):
        return {'envId': (cfg or {}).get('envId') or '',
                'path': (cfg or {}).get('path') or '',
                'publicUrl': link.get('url') or ''}
    def publish(self, bundle_dir, tpl, meta):
        if bundle_dir is None:
            raise CBError(0, 'CloudBase 发布缺少打包目录')
        meta = meta or {}
        cfg = dict(load_cb_cfg())
        # ⚠ 多模板多路径：每次发布的 cloudPath 由 publish_core 决定（模板一沿用配置里的
        # 默认 path，其余模板各用自己的子路径），**只在本次调用内覆盖** —— 不写回
        # cloudbase.json，避免发模板二时把配置里的默认路径也改掉。
        sub = _norm_path_name(meta.get('subPath') or '')
        cfg['path'] = sub
        url = cloudbase_deploy(bundle_dir, cfg)
        return {'url': url, 'envId': cfg.get('envId'), 'subPath': sub, 'hostingPath': url,
                'files': meta.get('files'), 'mediaCopied': meta.get('mediaCopied')}

def cb_cfg_path(tpl='main'):
    """CloudBase 凭证存放路径。与部署配置分离，便于单独清理/忽略。"""
    return DEPLOY_DIR / 'cloudbase.json'

def load_cb_cfg(tpl='main'):
    try:
        obj = read(cb_cfg_path(tpl)) or {}
        return obj if isinstance(obj, dict) else {}
    except Exception:
        return {}

def save_cb_cfg(obj):
    p = cb_cfg_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    write(p, obj or {})

# —— GitHub Pages Provider ——
class GHError(Exception):
    def __init__(self, code, message):
        self.code = code; self.message = message
    def __str__(self): return '[GitHub %s] %s' % (self.code, self.message)

# --- auth kind detection (per GitHub credential-types reference token prefixes) ---
#   ghp_ / github_pat_ = personal access token (classic / fine-grained)
#   gho_               = OAuth App access token -> classic scope model, repo scope can create repos; long-lived
#   ghu_               = GitHub App user access token -> fine-grained perms, only repos the App is installed on; 8h expiry
#   ghs_               = GitHub App installation token (1h); ghr_ = GitHub App refresh token (6 months)
# Why detect it: "connected to GitHub" means very different things for ghu_ vs gho_.
# Without this check a doomed 403 authorization is shown as "connected, ready", and the user
# only finds out after hitting Publish, facing an English error they cannot act on.
GH_TOKEN_KINDS = (('github_pat_', 'pat_fine'), ('ghp_', 'pat_classic'),
                  ('gho_', 'oauth_app'), ('ghu_', 'github_app'),
                  ('ghs_', 'app_install'), ('ghr_', 'app_refresh'))

def gh_token_kind(tok):
    t = str(tok or '')
    if not t: return ''
    for pre, kind in GH_TOKEN_KINDS:
        if t.startswith(pre): return kind
    return 'unknown'

# 极端情况（内置 client_id 被配成了 GitHub App 类型）时的提示。这不是用户的错 ——
# 是 FolioFold 发布方的配置问题，所以文案必须指向"换 client_id"，而不是让用户去建 App。
GH_APP_TOKEN_HINT = (
    '当前 GitHub 授权属于「GitHub App」类型：权限只覆盖「该 App 已被安装的仓库」，'
    '没有在你的账号下新建仓库的权限，因此无法发布'
    '（GitHub 原始响应 403 Resource not accessible by integration）。'
    '这是 FolioFold 内置授权标识（client_id）的类型问题，与你的 GitHub 账号无关。'
    '请联系 FolioFold 提供者：把内置 client_id 换成 OAuth App 的 Client ID，'
    '并在该 OAuth App 上勾选 Enable device flow。'
)

# 尚未内置公共 Client ID 时的提示（面向 FolioFold 发布方 / 开发者）。
GH_NO_CLIENT_ID_HINT = (
    'FolioFold 尚未内置公共 OAuth App 的 Client ID，无法发起 GitHub 授权。'
    '这是产品配置项，与你的 GitHub 账号无关。配置办法：'
    'github.com/settings/developers → New OAuth App'
    '（Homepage URL 与 Authorization callback URL 都填 http://127.0.0.1:3000/api/github/callback，'
    '并勾选 Enable device flow），把拿到的 Client ID 填进 FolioFold 的「开发者选项」，'
    '或写入 server.py 的 FOLIOFRAME_PUBLIC_CLIENT_ID。Client ID 是公开标识，不是机密。'
)


def gh_token_expired(t):
    """本地记录的令牌是否已过期（只在 expires_at 是时间戳时有意义）。"""
    try:
        e = float((t or {}).get('expires_at') or 0)
    except Exception:
        return False
    return e > 0 and time.time() > e


_GH_CAP_CACHE = {'at': 0.0, 'token': '', 'res': None}
_GH_PROBE_BUSY = set()
_GH_PROBE_LOCK = threading.Lock()
# 能力探测结果的"新鲜度"上限：超过就后台刷新（不阻塞任何请求）。
GH_CAP_TTL = 600


def gh_check_access(token, force=False):
    """用**真实 API 响应**判定这枚令牌到底能做什么 —— 不靠令牌前缀猜权限。
    返回：ok / login / scopes / kind / canCreateRepo / canCreateRepoReason /
          reposVisible / expired / error。结果缓存 60 秒，避免面板反复渲染打满配额。

    建仓权限用「非破坏性探针」：POST /user/repos 故意发一个非法请求体。
      · 400/422（参数非法）= 已通过鉴权层 → 有建仓权限，不会真建出任何仓库；
      · 403 Resource not accessible by integration = 授权类型本身不对（GitHub App），永远建不了仓库。
    """
    now = time.time()
    if (not force and _GH_CAP_CACHE.get('res') and _GH_CAP_CACHE.get('token') == token
            and now - float(_GH_CAP_CACHE.get('at') or 0) < 60):
        return _GH_CAP_CACHE['res']
    out = {'ok': False, 'login': '', 'scopes': '', 'kind': gh_token_kind(token),
           'canCreateRepo': False, 'canCreateRepoReason': '', 'reposVisible': -1,
           'expired': False, 'error': ''}
    # ① 身份：能读到 login 才说明令牌有效
    #   刚换到的 OAuth 令牌在 GitHub 侧有极短的最终一致性窗口：紧随"换令牌"执行的探测
    #   偶发拿到一次 401（实测同一令牌 1~2 秒后再打就 200）。所以 401 先短重试一次，
    #   只有重试仍 401 才判定"授权失效"——否则用户刚授权成功就被提示"请重新授权"。
    _auth_err = None
    for _attempt in (0, 1):
        try:
            data, hdrs = gh_request('GET', GH_API + '/user', token, with_headers=True)
            out['ok'] = True
            out['login'] = (data or {}).get('login') or ''
            out['scopes'] = (hdrs.get('X-OAuth-Scopes') or hdrs.get('x-oauth-scopes') or '').strip()
            _auth_err = None
            break
        except GHError as _e:
            _auth_err = _e
            if _e.code == 401 and _attempt == 0:
                time.sleep(1.2)
                continue
            break
    if _auth_err is not None:
        e = _auth_err
        if e.code == 401:
            out['expired'] = True
            out['error'] = 'GitHub 授权已失效或已被撤销（HTTP 401）'
        elif e.code == 0:
            out['error'] = '网络异常：无法连接 GitHub（' + (e.message or '') + '）'
            # ⚠ 2026-09-25：这条分支是「连不出去」，不是「授权失效」。
            #   以前没打这个标记，上层一律补一句「请断开 GitHub 重新授权」，
            #   于是系统代理死掉这种纯网络故障也会被说成授权问题 —— 用户重连到天亮也修不好。
            out['netProblem'] = True
        else:
            out['error'] = '读取 GitHub 账号信息失败（HTTP %s）：%s' % (e.code, e.message or '')
        _GH_CAP_CACHE.update({'at': now, 'token': token, 'res': out})
        return out
    # ② 可见仓库数：GitHub App 令牌只能看到「该 App 已安装的仓库」，OAuth App 能看到全部
    try:
        repos = gh_request('GET', GH_API + '/user/repos?per_page=100&affiliation=owner', token)
        out['reposVisible'] = len(repos) if isinstance(repos, list) else -1
    except GHError:
        pass
    # ③ 建仓权限探针（不会真的创建任何仓库）
    try:
        gh_request('POST', GH_API + '/user/repos', token, {'name': ''})
        out['canCreateRepo'] = True
        out['canCreateRepoReason'] = '建仓接口返回成功'
    except GHError as e:
        low = (e.message or '').lower()
        if e.code in (400, 422):
            out['canCreateRepo'] = True
            out['canCreateRepoReason'] = '已通过鉴权层（HTTP %s 仅因探针参数非法）' % e.code
        elif e.code == 403 and 'not accessible by integration' in low:
            out['canCreateRepoReason'] = GH_APP_TOKEN_HINT
        elif e.code == 401:
            out['expired'] = True
            out['canCreateRepoReason'] = 'GitHub 授权已失效或已被撤销（HTTP 401），请重新连接 GitHub。'
        elif e.code == 403:
            out['canCreateRepoReason'] = 'GitHub 拒绝建仓请求（HTTP 403）：' + (e.message or '')
        else:
            out['canCreateRepoReason'] = '建仓权限探测失败（HTTP %s）：%s' % (e.code, e.message or '')
    _GH_CAP_CACHE.update({'at': now, 'token': token, 'res': out})
    return out


def gh_probe_async(token):
    """后台刷新能力探测结果并落盘到 gh.json —— 绝不阻塞面板渲染。
    面板读的是"上次的真实结论"，同时这里静默把它更新到最新。"""
    if not token:
        return
    with _GH_PROBE_LOCK:
        if token in _GH_PROBE_BUSY:
            return
        _GH_PROBE_BUSY.add(token)

    def work():
        try:
            cap = gh_check_access(token, force=True)
            rec = load_gh_token()
            if (rec.get('token') or '') == token:
                rec['scopes'] = cap.get('scopes') or ''
                rec['canCreateRepo'] = bool(cap.get('canCreateRepo'))
                rec['canCreateRepoReason'] = cap.get('canCreateRepoReason') or ''
                rec['capError'] = '' if cap.get('ok') else (cap.get('error') or '')
                rec['capLogin'] = cap.get('login') or ''
                rec['capAt'] = time.time()
                save_gh_token(rec)
        except Exception:
            pass
        finally:
            with _GH_PROBE_LOCK:
                _GH_PROBE_BUSY.discard(token)

    threading.Thread(target=work, daemon=True).start()


def gh_user_message(e, phase=''):
    """把 GHError 翻成「用户能照着做」的中文。绝不把裸英文 403 丢给用户。
    phase: auth / repo / push / pages / release / '' """
    code = getattr(e, 'code', 0)
    msg = (getattr(e, 'message', '') or str(e) or '').strip()
    low = msg.lower()
    if code == 0:
        # code=0 有两个来源：真·网络异常（urllib 抛的），以及我们自己抛的"配置缺失"说明。
        # 只有前者才该说"网络失败"，否则会把"没配 Client ID"误报成网络问题。
        looks_net = any(k in low for k in ('urlopen', 'timed out', 'timeout', 'connection',
                                           'ssl', 'certificate', 'network', 'name resolution',
                                           '网络错误', '无法连接'))
        if looks_net or not msg:
            return '网络连接失败：无法访问 GitHub，请检查网络或代理后重试。（' + msg + '）'
        return msg
    if code == 401:
        return 'GitHub 授权已失效或已过期（HTTP 401）。请点「断开 GitHub」，再点「连接 GitHub」重新授权一次。'
    if code == 403:
        if 'not accessible by integration' in low:
            return GH_APP_TOKEN_HINT
        if 'rate limit' in low or 'abuse' in low:
            return 'GitHub API 速率限制已达上限（HTTP 403），请等几分钟后重试。'
        if 'saml' in low or 'two-factor' in low or 'must have' in low:
            return '你的 GitHub 账号或组织要求额外校验（SAML / 2FA），当前授权无法执行此操作（HTTP 403）：' + msg
        return 'GitHub 拒绝了此操作（HTTP 403）：' + msg
    if code == 404:
        if phase == 'repo':
            return 'GitHub 仓库不存在，且当前授权无法创建它（HTTP 404）：' + msg
        if phase == 'pages':
            return 'GitHub Pages 尚未启用或无权访问（HTTP 404）：' + msg
        return 'GitHub 返回 404（资源不存在或无权访问）：' + msg
    if code == 422:
        if phase == 'repo':
            return '仓库创建失败（HTTP 422）：' + msg + '（常见原因：仓库名不合法，或同名仓库已存在）'
        if phase == 'pages':
            return 'GitHub Pages 启用/更新失败（HTTP 422）：' + msg
        return 'GitHub 拒绝了请求参数（HTTP 422）：' + msg
    if code >= 500:
        return 'GitHub 服务端暂时故障（HTTP %s），请稍后重试：%s' % (code, msg)
    return 'GitHub 操作失败（HTTP %s）：%s' % (code, msg)


def _gh_err_msg(detail):
    try:
        d = json.loads(detail) if isinstance(d, str) else detail
        if isinstance(d, dict):
            # OAuth / Device Flow 的错误体用 error + error_description（没有 message 字段），
            # 必须一并带出来，否则轮询拿不到 authorization_pending / slow_down 这些中间态。
            m = d.get('message') or ''
            if not m:
                m = d.get('error_description') or d.get('error') or ''
            if d.get('errors'): m += ' ' + str(d['errors'])
            return m
    except Exception:
        pass
    return detail if isinstance(detail, str) else str(detail)

def gh_request(method, url, token=None, body=None, raw=False, with_headers=False, timeout=120,
               content_type=None):
    """唯一的 GitHub REST 调用出口。
    with_headers=True 时返回 (payload, headers) —— 判定授权类型与权限必须看真实响应
    （X-OAuth-Scopes / x-accepted-github-permissions），不能只看令牌前缀。
    timeout：socket 超时（秒）。上传大文件必须放大 —— 默认 120s 对 100MB+ 的
    release asset 太短，慢速上行链路会出现「The write operation timed out」，见 gh_upload_release_assets。
    content_type：raw 字节上传时**必须显式给**。不设的话 urllib 会默认套
    `application/x-www-form-urlencoded`，GitHub 的 Release Asset 上传会直接 422
    「content_type can't be application/x-www-form-urlencoded」（踩过，导致大媒体从来没传成功过）。"""
    headers = {'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
               'User-Agent': 'FolioFold'}
    if token: headers['Authorization'] = 'Bearer ' + token
    if isinstance(body, (dict, list)) and not raw:
        data = json.dumps(body).encode('utf-8'); headers['Content-Type'] = 'application/json'
    elif raw and isinstance(body, (bytes, bytearray)):
        data = bytes(body)
        headers['Content-Type'] = content_type or 'application/octet-stream'
    elif isinstance(body, _ProgressBody):
        # 流式正文（能报进度）：显式给 Content-Type，否则 urllib 会套 form-urlencoded。
        data = body
        headers['Content-Type'] = content_type or body.content_type or 'application/json'
    else:
        data = body   # 已编码的 bytes，或可流式读取的对象（_ProgressBody，用于大 blob 的真实进度）
    try:
        _nbytes = len(data) if data is not None else 0
    except Exception:
        _nbytes = 0
    if _nbytes > 5 * 1000 * 1000:
        pub_log('上传 %s %s（%.1f MB）开始…' % (method, url.split('?')[0], _nbytes / 1000000.0))
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        r = net_urlopen(req, timeout=timeout)
    except urllib.error.HTTPError as e:
        detail = ''
        try: detail = e.read().decode('utf-8', 'replace')
        except Exception: pass
        # 原始响应体必须落盘：401/403 到底是谁发的（GitHub 还是本地代理），只看代码分不出来。
        pub_log('HTTP %s %s -> %s | %s' % (method, url.split('?')[0], e.code,
                                           detail[:400].replace('\n', ' ')))
        err = GHError(e.code, _gh_err_msg(detail) or e.reason)
        try: err.headers = {k: v for k, v in e.headers.items()}
        except Exception: err.headers = {}
        err.body = detail
        raise err
    except Exception as e:
        pub_log('NET  %s %s -> %s: %s' % (method, url.split('?')[0], type(e).__name__, str(e)[:200]))
        raise GHError(0, '网络错误：' + str(e))
    payload = r.read()
    hdrs = {}
    try: hdrs = {k: v for k, v in r.headers.items()}
    except Exception: pass
    parsed = {}
    if not raw:
        try: parsed = json.loads(payload.decode('utf-8'))
        except Exception: parsed = {}
    if with_headers:
        return (payload if raw else parsed), hdrs
    return payload if raw else parsed


def load_gh_token(): return read(GH_TOKEN_FILE, None) or {}
def save_gh_token(d): DEPLOY_DIR.mkdir(parents=True, exist_ok=True); write(GH_TOKEN_FILE, d)
def load_gh_app(): return read(GH_APP_FILE, None) or {}
def save_gh_app(d): DEPLOY_DIR.mkdir(parents=True, exist_ok=True); write(GH_APP_FILE, d)
def load_gh_state(): return read(GH_STATE_FILE, None) or {}
def save_gh_state(d): DEPLOY_DIR.mkdir(parents=True, exist_ok=True); write(GH_STATE_FILE, d)
def load_gh_device(): return read(GH_DEVICE_FILE, None) or {}
def save_gh_device(d): DEPLOY_DIR.mkdir(parents=True, exist_ok=True); write(GH_DEVICE_FILE, d)
def gh_configured(): return bool(load_gh_token().get('token'))

# ——— Device Flow（默认授权路径：普通用户无需创建任何 GitHub App）———
def gh_client_id():
    """返回用于 Device Flow 的公开 client_id。
    优先级：开发者在「开发者选项」填的自定义 client_id > 内置公共 Client ID。
    Device Flow 不需要 client_secret，所以这里不存在任何机密。"""
    app = load_gh_app()
    return (app.get('client_id') or '').strip() or GH_DEVICE_CLIENT_ID



def github_device_start(force=False):
    """第一步：向 GitHub 申请设备码。返回给前端的只有 user_code / 验证网址 / 轮询间隔。
    注意：全程只用公开 client_id，官方文档明确 "The client_secret is not needed for the device flow."。

    force=False（默认）时**幂等复用**：同一 client_id 下若磁盘上已有未过期的设备码，直接把它交回，
    不再向 GitHub 申请新的。原因（2026-09-17 实测踩坑）：连点两次「连接 GitHub」会申请到两枚不同的码
    并互相覆盖落盘，而 github_device_poll() 只读落盘那一枚 —— 结果用户在 GitHub 上授权的是面板上显示
    的那枚，服务端却在轮询另一枚，永远 authorization_pending，界面死等 15 分钟。
    force=True 表示"我要一枚全新的码"，用于显式重试。"""
    cid = gh_client_id()
    if not cid:
        # 没有公共 client_id 就发不出设备码 —— 这属于发布方配置缺失，
        # 直接给可执行的配置指引，而不是抛裸 404。
        raise GHError(0, GH_NO_CLIENT_ID_HINT)
    if not force:
        old = load_gh_device() or {}
        left = float(old.get('expires_at') or 0) - time.time()
        if old.get('device_code') and old.get('user_code') \
                and (old.get('client_id') or '') == cid and left > 10:
            uc = str(old.get('user_code') or '')
            return {'user_code': uc,
                    'verification_uri': old.get('verification_uri') or 'https://github.com/login/device',
                    'verification_uri_complete': old.get('verification_uri_complete')
                        or ('https://github.com/login/device?user_code=' + quote(uc)),
                    'expires_in': int(left), 'interval': int(old.get('interval') or 5),
                    'reused': True}
    try:
        r = gh_request('POST', GH_DEVICE_CODE_URL,
                       body={'client_id': cid, 'scope': GH_DEVICE_SCOPE})
    except GHError as e:
        if e.code == 404:
            raise GHError(0, 'GitHub 不认识这个 Client ID（HTTP 404）：它可能不是 OAuth App 的 Client ID，'
                             '或该 OAuth App 已被删除。请检查「开发者选项」/ server.py 里的 Client ID 配置。')
        raise
    dc = r.get('device_code'); uc = r.get('user_code')
    if not dc or not uc:
        err = r.get('error_description') or r.get('error') or 'GitHub 未返回设备码'
        if r.get('error') == 'device_flow_disabled':
            err = ('该 OAuth App 未启用 Device Flow。请在 github.com/settings/developers 打开它，'
                   '勾选 Enable device flow 并保存后重试。')
        raise GHError(0, err)
    expires_in = int(r.get('expires_in') or 900)
    interval = int(r.get('interval') or 5)
    # GitHub 的 device code 响应**不返回** verification_uri_complete（那是 RFC 8628 的可选字段）。
    # 自己拼一个带 ?user_code= 的链接：支持预填的浏览器上用户点开就只剩一个 Authorize 按钮，
    # 不用手抄 8 位码（手抄正是"码还没输完就过期"的主因）。面板同时仍会显示可复制的设备码，
    # 万一 GitHub 不预填，用户照抄即可，不会更差。落盘保存一份，幂等复用时原样交回。
    vc = r.get('verification_uri_complete') or (
        'https://github.com/login/device?user_code=' + quote(uc))
    save_gh_device({'device_code': dc, 'user_code': uc,
                    'verification_uri': r.get('verification_uri') or 'https://github.com/login/device',
                    'verification_uri_complete': vc,
                    'expires_at': time.time() + expires_in, 'interval': interval,
                    'client_id': cid})
    return {'user_code': uc,
            'verification_uri': r.get('verification_uri') or 'https://github.com/login/device',
            'verification_uri_complete': vc,
            'expires_in': expires_in, 'interval': interval}

def github_device_poll(req_device_code=None):
    """第二步：轮询换取令牌。
    - 未完成授权 → {'status': 'pending'}（GitHub 返回 authorization_pending）
    - 用户点拒绝   → {'status': 'denied'}
    - 设备码过期   → {'status': 'expired'}
    - 成功         → {'status': 'connected', 'login': ...}
    注意：Device Flow 全程只用 client_id，官方文档明确 "The client_secret is not needed for the device flow."

    req_device_code：前端可以把自己**显示给用户**的那枚 device_code 带过来。正常情况下它与落盘的一致；
    带上它只是兜底 —— 万一落盘那枚被另一次 start 覆盖，也不会出现"用户照着面板授权 A、服务端却在轮询 B"
    而永远停在 pending 的死等。
    """
    d = load_gh_device()
    dc = (req_device_code or '').strip() or d.get('device_code')
    if not dc:
        return {'status': 'idle'}
    if time.time() > float(d.get('expires_at') or 0):
        try: GH_DEVICE_FILE.unlink()
        except Exception: pass
        return {'status': 'expired', 'message': '设备码已过期，请重新点击「连接 GitHub」'}
    try:
        r = gh_request('POST', GH_DEVICE_TOKEN_URL,
                       body={'client_id': d.get('client_id') or gh_client_id(),
                             'device_code': dc, 'grant_type': GH_DEVICE_GRANT})
    except GHError as e:
        # GitHub 把授权未完成这类"正常中间态"也放在 body 里返回，不一定是 HTTP 错误
        low = (e.message or '').lower()
        if 'authorization_pending' in low: return {'status': 'pending'}
        if 'slow_down' in low: return {'status': 'pending', 'slowDown': True}
        raise
    tok = r.get('access_token')
    if not tok:
        err = (r.get('error') or '').strip()
        if err in ('authorization_pending',): return {'status': 'pending'}
        if err == 'slow_down': return {'status': 'pending', 'slowDown': True}
        if err == 'access_denied': 
            try: GH_DEVICE_FILE.unlink()
            except Exception: pass
            return {'status': 'denied', 'message': '你在 GitHub 上拒绝了本次授权'}
        if err == 'expired_token':
            try: GH_DEVICE_FILE.unlink()
            except Exception: pass
            return {'status': 'expired', 'message': '设备码已过期，请重新点击「连接 GitHub」'}
        raise GHError(0, r.get('error_description') or err or 'GitHub 未返回 access_token')
    try:
        login = gh_request('GET', GH_API + '/user', tok).get('login') or ''
    except Exception:
        login = ''
    # 注意：此处不保存 refresh_token（scope=repo 的经典 token 无刷新概念）；
    # Device Flow 授权的 token 长期有效，直到用户在 GitHub 侧撤销。
    kind = gh_token_kind(tok)
    # 授权成功 ≠ 能发布。这里立刻用真实 API 探一次能力，把"能不能建仓库"当场算清楚，
    # 免得用户点了发布才撞上 403。探测失败(网络抖动)不阻断连接，只是不给 warning。
    try:
        cap = gh_check_access(tok, force=True)
    except Exception:
        cap = {}
    expires_at = ''
    try:
        if r.get('expires_in'):
            expires_at = str(time.time() + float(r['expires_in']))
    except Exception:
        expires_at = ''
    save_gh_token({'token': tok, 'login': login or cap.get('login') or '', 'expires_at': expires_at,
                   'via': 'device', 'scope': r.get('scope') or '', 'kind': kind,
                   'scopes': cap.get('scopes') or '', 'canCreateRepo': bool(cap.get('canCreateRepo')),
                   'canCreateRepoReason': cap.get('canCreateRepoReason') or '',
                   'capError': '' if cap.get('ok') else (cap.get('error') or ''),
                   'capLogin': cap.get('login') or '',
                   'capAt': time.time()})
    try: GH_DEVICE_FILE.unlink()
    except Exception: pass
    warn = ''
    if cap and cap.get('ok') and not cap.get('canCreateRepo'):
        warn = cap.get('canCreateRepoReason') or GH_APP_TOKEN_HINT
    return {'status': 'connected', 'login': login or cap.get('login') or '', 'tokenKind': kind,
            'scopes': cap.get('scopes') or '', 'canCreateRepo': bool(cap.get('canCreateRepo')),
            'warning': warn}

def github_pages_auth_url():
    app = load_gh_app()
    cid = app.get('client_id') or gh_client_id()
    return ('https://github.com/login/oauth/authorize?client_id=' + urllib.parse.quote(cid) +
            '&redirect_uri=' + urllib.parse.quote(GH_CALLBACK) +
            '&scope=' + urllib.parse.quote('repo workflow') + '&state=' + load_gh_state().get('state', ''))

def github_exchange_code(code):
    app = load_gh_app()
    cid = app.get('client_id') or ''; csec = app.get('client_secret') or ''
    if not cid or not csec:
        raise GHError(0, '尚未配置 GitHub OAuth App（client_id / client_secret）')
    r = gh_request('POST', 'https://github.com/login/oauth/access_token',
                   body={'client_id': cid, 'client_secret': csec, 'code': code,
                         'redirect_uri': GH_CALLBACK})
    tok = r.get('access_token')
    if not tok:
        raise GHError(0, r.get('error_description') or r.get('error') or 'GitHub 未返回 access_token（授权可能被拒绝）')
    try:
        login = gh_request('GET', GH_API + '/user', tok).get('login')
    except Exception:
        login = ''
    exp = ''
    try:
        if r.get('expires_in'):
            exp = str(time.time() + float(r['expires_in']))
    except Exception:
        exp = ''
    cap = {}
    try:
        cap = gh_check_access(tok, force=True)
    except Exception:
        cap = {}
    save_gh_token({'token': tok, 'login': login or cap.get('login') or '', 'expires_at': exp,
                   'via': 'oauth', 'kind': gh_token_kind(tok), 'scopes': cap.get('scopes') or '',
                   'canCreateRepo': bool(cap.get('canCreateRepo')),
                   'canCreateRepoReason': cap.get('canCreateRepoReason') or '',
                   'capError': '' if cap.get('ok') else (cap.get('error') or ''),
                   'capLogin': cap.get('login') or '',
                   'capAt': time.time()})

def gh_ensure_repo(token, owner, name):
    """确保 owner/name 仓库存在。**已存在就直接复用（只更新内容），绝不重复建仓** ——
    这样同一个用户重复发布永远落在同一个仓库上，公开网址保持不变。
    返回 (full_name, created)。"""
    try:
        r = gh_request('GET', GH_API + '/repos/%s/%s' % (owner, name), token)
        return (r or {}).get('full_name') or ('%s/%s' % (owner, name)), False
    except GHError as e:
        if e.code != 404: raise
    gh_request('POST', GH_API + '/user/repos', token,
               {'name': name, 'private': False, 'auto_init': True,
                'description': 'Published portfolio via FolioFold (static site).'})
    return '%s/%s' % (owner, name), True


def gh_push_files(token, owner, repo, files):
    """files: list of (path, bytes)。用 Git Data API 提交到 main（单文件上限 100MB）。
    ⚠ blob 上传必须放大超时：base64 之后体积膨胀 33%，一个 70MB 的视频会变成 93MB 请求体。
    默认 120s 在慢速上行链路上必然 «The write operation timed out»（143.9MB 那次就是这么被打断的），
    而且失败发生在推到一半 —— 站点会留下一个旧的 index.html 配新的媒体（或干脆没推上去）。
    这里给到 900s + 一次重试，让"可在线播放的大视频"这条路真的走得通。"""
    ref = gh_request('GET', GH_API + '/repos/%s/%s/git/ref/heads/main' % (owner, repo), token)
    base_sha = ref['object']['sha']
    commit = gh_request('GET', GH_API + '/repos/%s/%s/git/commits/%s' % (owner, repo, base_sha), token)
    base_tree = commit['tree']['sha']
    blobs = {}
    # 小文件优先（媒体按体积升序）：面板进度能立刻往前走，最大的视频放最后。
    # 这样用户看到的是「已经在动」，而不是一个几十秒不动的「发布中…」。
    ordered = sorted(files, key=lambda kv: len(kv[1]) if kv[1] is not None else 0)
    for idx, (path, data) in enumerate(ordered, 1):
        mb = format_mb(len(data))
        pub_job_file('push', path,
                     '正在上传 %d/%d · %s（%s MB）' % (idx, len(ordered), path.split('/')[-1], mb))
        pub_log('push %d/%d %s（%s MB）开始' % (idx, len(ordered), path, mb))
        b64 = base64.b64encode(data).decode('ascii')
        body_bytes = ('{"content":"' + b64 + '","encoding":"base64"}').encode('utf-8')
        payload = {'content': b64, 'encoding': 'base64'}
        last = None
        for attempt in (1, 2):
            try:
                # 大正文走流式上传：http.client 支持 file-like body，能实时报「发了多少字节」；
                # 一旦流式这条路在某些代理/环境下不被接受（非 HTTP 错误），
                # 下面的 except 里会回退到一次性正文，行为与改造前完全一致。
                if len(body_bytes) > 2 * 1000 * 1000:
                    b = gh_request('POST', GH_API + '/repos/%s/%s/git/blobs' % (owner, repo), token,
                                   _ProgressBody(body_bytes), timeout=GH_PUSH_TIMEOUT)
                else:
                    b = gh_request('POST', GH_API + '/repos/%s/%s/git/blobs' % (owner, repo), token,
                                   payload, timeout=GH_PUSH_TIMEOUT)
                blobs[path] = b['sha']
                pub_log('push %s 成功 sha=%s' % (path, str(b.get('sha'))[:12]))
                last = None
                break
            except GHError as e:
                last = e
                pub_log('push %s 失败 attempt=%d code=%s %s'
                        % (path, attempt, e.code, str(e.message)[:200]))
                # 4xx 是我们的请求有问题，重试没意义；5xx / 超时（code=0）才重试。
                # code=0 且是流式上传 → 先用普通正文确认一次（排除流式本身不被环境支持）。
                if not e.code and attempt == 1 and len(body_bytes) > 2 * 1000 * 1000:
                    try:
                        b = gh_request('POST', GH_API + '/repos/%s/%s/git/blobs' % (owner, repo),
                                       token, payload, timeout=GH_PUSH_TIMEOUT)
                        blobs[path] = b['sha']
                        last = None
                        pub_log('push %s 成功（回退普通正文）sha=%s' % (path, str(b.get('sha'))[:12]))
                        break
                    except GHError as e2:
                        last = e2
                        pub_log('push %s 回退也失败 code=%s %s' % (path, e2.code, str(e2.message)[:200]))
                if e.code and 400 <= e.code < 500:
                    raise GHError(e.code, '上传「%s」被 GitHub 拒绝（HTTP %s）：%s'
                                  % (path, e.code, e.message))
                if attempt == 1: time.sleep(2)
        if last is not None:
            raise GHError(0, '上传「%s」（%.1f MB）失败：%s。文件越大越容易在上行链路超时/被中断，'
                             '可以改用更小的压缩档位（例如「最小」）再发布。'
                          % (path, format_mb(len(data)), last.message or '网络超时'))
    tree = [{'path': p, 'mode': '100644', 'type': 'blob', 'sha': sha} for p, sha in blobs.items()]
    new_tree = gh_request('POST', GH_API + '/repos/%s/%s/git/trees' % (owner, repo), token,
                          {'base_tree': base_tree, 'tree': tree})
    new_commit = gh_request('POST', GH_API + '/repos/%s/%s/git/commits' % (owner, repo), token,
                            {'message': 'Publish portfolio via FolioFold', 'tree': new_tree['sha'],
                             'parents': [base_sha]})
    gh_request('PATCH', GH_API + '/repos/%s/%s/git/refs/heads/main' % (owner, repo), token,
               {'sha': new_commit['sha']})
    return new_commit['sha']


def _git_bin():
    """定位「Windows 能直接执行」的 git.exe。

    坑：Git Bash 里的 `/mingw64/bin/git` 是 MSYS 路径，原生 Python 的 subprocess
    执行它会 WinError 2（找不到文件）。所以必须给真实 .exe 路径，或在 PATH 里找。
    顺序：已知常见安装位置（含 PortableGit 通配）→ shutil.which。
    找不到不报错，返回 'git' 让调用方自己失败并给出可读错误。"""
    import glob as _glob
    pats = [
        os.path.expanduser('~/.workbuddy/binaries/PortableGit/versions/*/mingw64/bin/git.exe'),
        'D:/Program Files/Git/cmd/git.exe',
        'C:/Program Files/Git/cmd/git.exe',
        'C:/Program Files (x86)/Git/cmd/git.exe',
        'D:/mingw64/bin/git.exe',
        'C:/mingw64/bin/git.exe',
    ]
    for p in pats:
        for hit in sorted(_glob.glob(p), reverse=True):
            if os.path.exists(hit):
                return hit
    return shutil.which('git') or shutil.which('git.exe') or 'git'


def _gh_root_placeholder_html():
    """仓库根的最小占位页（多模板子目录模式用）。

    ⚠ 关键设计 —— 为什么**不**做一个"列出全部模板"的总入口：
      用户明确要求「我给他什么他看什么，而不是让他总入口」。发 V1 链接的人
      不应该顺藤摸瓜看到 V2 的存在。所以根目录这一页刻意**不含任何链接、
      不含任何模板列表、不含任何标题信息**，只是一句"此地址不是访问入口"。
    同时它也避免直接访问仓库根时出现 GitHub 的 404 或文件目录列表。"""
    return ('<!doctype html>\n<html lang="zh-CN"><head><meta charset="UTF-8" />'
            '<meta name="viewport" content="width=device-width, initial-scale=1.0" />'
            '<meta name="robots" content="noindex,nofollow" />'
            '<title>Not Found</title></head><body style="font:15px/1.6 system-ui,sans-serif;'
            'color:#555;max-width:36em;margin:18vh auto;padding:0 24px;text-align:center">'
            '<p>此地址不是访问入口。</p></body></html>')

def gh_push_repo_git(token, owner, repo, bundle_dir, tpl, sub='', reserved=()):
    """用 git 协议把静态站点推到 GitHub Pages 仓库 —— 替代 Git Data API 的 /git/blobs。

    为什么必须换：Git Data API 的 blob 接口对大文件（67MB 视频 base64 后 ~90MB 请求体）
    会被 GitHub 边缘网关返回 401 "Bad credentials"，而同一令牌对小请求 / GET /user 全部 200
    （2026-09-17 实锤：87MB 直连与走代理都 401，29MB 都 201，令牌有效）。
    git 的 smart-http 推送走 git-receive-pack，协商阶段只上传「服务端还没有的对象」——
    未改动的 67MB 视频不会每次重复上传，且不受 API 大体积限制。

    用持久化仓库目录（_repo_gh/repo）：每次把新打包内容覆盖进去再提交，git 对象复用，
    重复发布只传差异（改了文字不重传视频）。
    ⚠ 2026-09-19 起从 `_repo_gh/<tpl>` 改为 **一个仓库一个克隆** `_repo_gh/repo`，
      因为多模板共用同一个仓库（各自子目录），分模板各克隆一份会互相打架。

    —— 多模板多路径（2026-08 起）——
    sub：本模板在仓库里的**子目录名**（如 'FolioFold' / 'v2'）。空字符串 = 推到仓库根。
      · 多个模板共用一个仓库，各自一个子目录 → 各链接互相独立、互不暴露。
    reserved：仓库里**其它模板**占用的顶层目录名（不允许被当垃圾清掉）。
      ⚠ 这是多模板共存的要害：发布模板二时，仓库里模板一的目录必须原样保留，
        否则一次发布就会把另一个模板的线上站点整体删除。
    打包内容不直接同步到 repo 根，而是同步进 repo_root/<sub>/；仓库根只放一个
    不泄露信息的最小 index.html（避免直接访问仓库根时看到 404 或目录列表）。"""
    g = _git_bin()
    repo_dir = DEPLOY_DIR / '_repo_gh' / 'repo'   # ⚠ 一个仓库一个本地克隆（不再按 tpl 分），多模板共享
    repo_dir.mkdir(parents=True, exist_ok=True)
    bundle_dir = Path(bundle_dir)
    sub = _norm_path_name(sub) if sub else ''
    staging = (repo_dir / sub) if sub else repo_dir
    # 本条记录对应的顶层条目（发布后要保证保留）；避免把自己当 reserved 误伤
    reserved_top = {r for r in (_norm_path_name(x) for x in (reserved or ())) if r and r != sub}
    if not sub:
        reserved_top |= {'.git'}
    try:
        _sync_tree(bundle_dir, staging, skip=('.git',), preserve=(reserved_top | {'.git'}) if sub else (reserved_top,))
    except Exception as e:
        pub_log('git sync 失败：%s' % e)
    # 子目录模式：仓库根放一个最小占位页（不含任何链接，不暴露其它模板的存在）。
    # 只在**根目录还没有 index.html** 时写入，绝不用它覆盖某个模板已经发在根上的站点。
    if sub:
        root_index = repo_dir / 'index.html'
        if not root_index.exists():
            try:
                root_index.write_text(_gh_root_placeholder_html(), encoding='utf-8')
            except Exception as e:
                pub_log('根占位页写入失败（不影响子目录发布）：%s' % e)
    env = dict(os.environ)
    # 彻底绕过系统代理直连 GitHub（与 API 探测一致：直连可用），避免 sing-box 干扰 git 的 HTTPS。
    for k in ('HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy'):
        env.pop(k, None)
    env['NO_PROXY'] = '*'; env['no_proxy'] = '*'
    env['GIT_TERMINAL_PROMPT'] = '0'   # 绝不等交互输入（令牌已嵌入 remote URL）
    env['GIT_AUTHOR_NAME'] = env['GIT_COMMITTER_NAME'] = 'FolioFold'
    env['GIT_AUTHOR_EMAIL'] = env['GIT_COMMITTER_EMAIL'] = 'folioframe@local'
    remote = 'https://%s@github.com/%s/%s.git' % (token, owner, repo)
    # ⚠ 必须带 safe.directory：项目在 G 盘（exFAT/NTFS 不记录文件属主），git 会以
    # 「detected dubious ownership」为由拒绝一切操作（add/status/commit 全部 fatal）。
    # 这种失败只写 stderr、stdout 为空 → 极易被误判成「无变化」而静默跳过推送（已踩）。
    base = [g, '-c', 'safe.directory=*']

    def run(args, timeout=120):
        return subprocess.run(base + args, cwd=str(repo_dir), env=env,
                              capture_output=True, text=True, timeout=timeout)

    def run_stream(args, timeout=GH_PUSH_TIMEOUT + 180):
        """推送时流式读 stderr，实时收日志（失败时用来给出可读原因）。

        坑（已踩）：git 的进度用 \\r 回车原地刷新，不是 \\n 换行 —— 按行迭代
        （for line in proc.stderr）会一直阻塞到进程结束才吐出内容。
        所以必须按块读原始字节，再用 [\\r\\n] 切分。
        另一个坑：不能再用 proc.communicate() 读同一根 stderr（会和 drain 线程抢数据，
        拿到的 err 时有时无，失败原因就丢了）—— 主线程只读 stdout，stderr 全交给 drain。

        ⚠ 刻意**不用** git 的 "Writing objects: NN%" 当进度条：它按**对象个数**算，
        本站只有几个对象（一个 67MB 视频 + 两个 html），会瞬间跳到 100% 然后原地等两分钟。
        把这种 100% 显示给用户等于撒谎（旧行为就是「看着像完成了其实还在传」）。
        真实的「还在动」由面板上的「已用 N 秒」体现。"""
        proc = subprocess.Popen(base + args, cwd=str(repo_dir), env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        tail = []

        def drain():
            buf = b''
            try:
                while True:
                    chunk = proc.stderr.read1(1024)   # read1：有数据就返回，不等满 buffer
                    if not chunk:
                        break
                    buf += chunk
                    parts = re.split(rb'[\r\n]', buf)
                    buf = parts.pop()
                    for raw in parts:
                        line = raw.decode('utf-8', 'replace').strip()
                        if line:
                            tail.append(line)
                            del tail[:-60]
            except Exception:
                pass

        th = threading.Thread(target=drain, daemon=True); th.start()
        killer = threading.Timer(timeout, proc.kill); killer.start()
        try:
            out = proc.stdout.read()
            proc.wait()
        finally:
            killer.cancel()
        th.join(timeout=10)
        errtxt = '\n'.join(tail[-12:])
        if proc.returncode != 0 and not errtxt:
            errtxt = 'git push 异常退出（returncode=%s，可能是网络中断或被超时终止）' % proc.returncode
        return proc.returncode, (out or b'').decode('utf-8', 'replace'), errtxt

    pub_job_phase('push', '正在比对改动…')
    pub_log('git push 开始：%s/%s' % (owner, repo))
    if not (repo_dir / '.git').exists():
        r = run(['init', '--initial-branch=main'])
        if r.returncode != 0:
            raise GHError(0, 'git init 失败：' + (r.stderr or r.stdout)[:300])
    run(['config', 'user.name', 'FolioFold'])
    run(['config', 'user.email', 'folioframe@local'])
    run(['config', 'http.postBuffer', '1048576000'])  # 1GB，避免大文件被 http post buffer 限制
    run(['remote', 'remove', 'origin'])
    rr = run(['remote', 'add', 'origin', remote])
    if rr.returncode != 0:
        raise GHError(0, 'git remote 配置失败：' + (rr.stderr or rr.stdout)[:300])
    a = run(['add', '-A'], timeout=600)
    # ⚠ 绝不能让 add 的失败被当成「没有改动」：git 出错时只写 stderr、stdout 是空的，
    # 旧代码只看 stdout 就 return True → 静默跳过推送、线上还是旧站点（G 盘 dubious ownership 踩过）。
    if a.returncode != 0:
        raise GHError(0, 'git add 失败：' + (a.stderr or a.stdout)[:300])
    st = run(['status', '--porcelain'])
    if st.returncode != 0:
        raise GHError(0, 'git status 失败：' + (st.stderr or st.stdout)[:300])
    if not st.stdout.strip():
        pub_log('git: 工作区与上次提交一致，跳过提交/推送')
        return True
    c = run(['commit', '-m', 'Publish portfolio via FolioFold'], timeout=300)
    if c.returncode != 0:
        raise GHError(0, 'git commit 失败：' + (c.stderr or c.stdout)[:300])
    # 只有真的有对象要传时才喊「正在上传」——顺手把预期时长说清楚，
    # 用户才知道该等、而不是以为卡死了又点一次（并发发布正是空站点的起因）。
    pub_job_phase('push', '正在上传到 GitHub…（首次含大视频，通常需要 1~3 分钟，请保持页面打开）')
    code, out, err = run_stream(['push', '--progress', '--force', 'origin', 'main'])
    if code != 0:
        raise GHError(0, 'git push 失败：' + (err or out)[:400])
    pub_log('git push 成功')
    return True


def _gh_remote_url(token, owner, repo):
    """构造 GitHub 远端 git URL。
    QA 专用逃生门：设 FF_GH_REMOTE_URL_OVERRIDE 时替换整个 URL（可含 {owner}/{repo}/{token}
    占位符），让删除机制的回归测试能指向本地 bare 仓库离线运行。正常环境绝不设置。"""
    ov = (os.environ.get('FF_GH_REMOTE_URL_OVERRIDE') or '').strip()
    if ov:
        return ov.replace('{owner}', owner).replace('{repo}', repo).replace('{token}', token)
    return 'https://%s@github.com/%s/%s.git' % (token, owner, repo)


def _gh_clone_owner_repo(repo_dir):
    """读本地克隆的 origin，返回 (owner, repo)；读不出或不是 GitHub URL 返回 None。
    用于删除前校验「这个克隆到底是谁的」——绝不允许拿 A 仓的克隆去动 B 仓。"""
    try:
        r = subprocess.run([_git_bin(), '-c', 'safe.directory=*', 'remote', 'get-url', 'origin'],
                           cwd=str(repo_dir), capture_output=True, text=True, timeout=30)
    except Exception:
        return None
    if r.returncode != 0:
        return None
    m = re.search(r'github\.com[/:]([^/]+)/([^/]+?)(?:\.git)?/?$', (r.stdout or '').strip())
    return (m.group(1), m.group(2)) if m else None


def _gh_remote_sub_exists(token, owner, repo, sub):
    """以 GitHub 远端为准判断子路径是否仍存在（contents API：200=存在，404=不存在）。
    删除的「幂等」判断必须看远端，绝不能拿本地克隆有没有目录来下结论。"""
    try:
        gh_request('GET', GH_API + '/repos/%s/%s/contents/%s?ref=main' % (owner, repo, sub),
                   token, timeout=30)
        return True
    except GHError as e:
        if e.code == 404:
            return False
        raise


def _gh_sync_clone_to_remote(run, remote):
    """把本地克隆强制对齐到目标仓库远端最新状态（fetch/reset/clean 只写本地，绝不推送）。
    成功返回 None；失败返回 (False, 消息)。失败时调用方必须原样失败，不做任何删除。"""
    run(['remote', 'remove', 'origin'])
    rr = run(['remote', 'add', 'origin', remote])
    if rr.returncode != 0:
        return False, 'git remote 配置失败：' + (rr.stderr or rr.stdout)[:200]
    f = run(['fetch', '--depth=1', 'origin', 'main'], timeout=600)
    if f.returncode != 0:
        return False, ('拉取目标仓库最新状态失败，未做任何删除：' + (f.stderr or f.stdout)[:300])
    r2 = run(['reset', '--hard', 'FETCH_HEAD'], timeout=120)
    if r2.returncode != 0:
        return False, '对齐目标仓库失败（git reset），未做任何删除：' + (r2.stderr or r2.stdout)[:200]
    cb = run(['checkout', '-B', 'main'], timeout=120)
    if cb.returncode != 0:
        return False, '对齐目标仓库失败（git checkout main），未做任何删除：' + (cb.stderr or cb.stdout)[:200]
    run(['clean', '-fd'], timeout=120)   # 清掉远端没有的本地残留，保证 worktree == 远端树
    return None


def gh_delete_repo_dir(token, owner, repo, sub):
    """真正从 GitHub Pages 仓库里删掉某个子目录（该模板的那条发布）。

    ⚠ 2026-10-06 安全重写（专项审计修复，见 qa/gh-delete-safety.py）：
    · 删除永远以「目标仓库远端的真实状态」为唯一依据，绝不信本地克隆有没有目录
      ——旧代码只看本地克隆，跨仓记录（克隆是 folioframe、目标是 foliofold）会
      误报「线上已不存在」的假成功；
    · 动手前必须把本地克隆 fetch+reset 对齐到目标仓库最新（fetch 只写本地，不推送）；
      克隆 origin 与目标仓库不一致也要先对齐；对齐失败 → 明确失败，绝不 push；
    · 对齐后用**普通 push（非 force）**：删除提交的父提交就是远端最新，天然 fast-forward；
      若远端期间又有新提交导致被拒，如实失败，绝不 force 覆盖别人的内容；
    · 根路径（sub=''）仍拒绝；只删指定 sub，绝不碰其它模板目录。
    返回 (ok, message)。"""
    sub = _norm_path_name(sub) if sub else ''
    if not sub:
        return False, '拒绝删除仓库根（多模板/占位页所在位置）。请到 GitHub 手动处理。'
    g = _git_bin()
    repo_dir = DEPLOY_DIR / '_repo_gh' / 'repo'
    env = dict(os.environ)
    for k in ('HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy'):
        env.pop(k, None)
    env['NO_PROXY'] = '*'; env['no_proxy'] = '*'
    env['GIT_TERMINAL_PROMPT'] = '0'
    env['GIT_AUTHOR_NAME'] = env['GIT_COMMITTER_NAME'] = 'FolioFold'
    env['GIT_AUTHOR_EMAIL'] = env['GIT_COMMITTER_EMAIL'] = 'folioframe@local'
    remote = _gh_remote_url(token, owner, repo)
    base = [g, '-c', 'safe.directory=*']

    def run(args, timeout=120):
        return subprocess.run(base + args, cwd=str(repo_dir), env=env,
                              capture_output=True, text=True, timeout=timeout)

    if not (repo_dir / '.git').exists():
        # 本机没有克隆：只能以远端 contents API 为准判断；线上确实没有 → 真幂等；
        # 线上还有 → 无法安全删除，明确失败（路由层会给 manualUrl 让用户手动删）。
        try:
            exists = _gh_remote_sub_exists(token, owner, repo, sub)
        except Exception as e:
            return False, '本机没有该仓库的克隆，且查询 GitHub 远端失败，未做任何删除：' + str(e)[:200]
        if not exists:
            return True, '该目录在线上已不存在（以 GitHub 远端为准，幂等）。'
        return False, ('本机没有 %s/%s 的克隆，无法安全删除线上 /%s/；请到 GitHub 手动删除。'
                       % (owner, repo, sub))

    cur = _gh_clone_owner_repo(repo_dir)
    if cur != (owner, repo):
        # 克隆属于别的仓库（如克隆是 folioframe、要删的是 foliofold 的记录）：
        # 先把克隆对齐到目标仓库远端最新（fetch/reset 只写本地）。对齐失败就明确失败——
        # 绝不拿错误的克隆 push，也绝不说「线上已不存在」。
        bad = '本地克隆属于 %s，与目标仓库 %s/%s 不一致' % (
              ('%s/%s' % cur) if cur else '未知来源', owner, repo)
        aligned = _gh_sync_clone_to_remote(run, remote)
        if aligned:
            return False, bad + '；' + aligned[1]
    else:
        # 克隆虽然属于目标仓库，也可能落后/偏离远端：同样先对齐，
        # 让后面的「幂等判断」和普通 push 都有真实依据。
        aligned = _gh_sync_clone_to_remote(run, remote)
        if aligned:
            return False, '对齐目标仓库最新状态失败，未做任何删除：' + aligned[1]

    target = repo_dir / sub
    if not target.exists():
        # 走到这里说明克隆已 = 目标仓库远端最新 →「本地没有」才真正等于「线上没有」。
        return True, '该目录在线上已不存在（已对齐远端后确认，幂等）。'
    try:
        if target.is_dir():
            shutil.rmtree(target)
        else:
            target.unlink()
    except Exception as e:
        return False, '本机清理失败：' + str(e)[:200]
    run(['config', 'user.name', 'FolioFold'])
    run(['config', 'user.email', 'folioframe@local'])
    run(['remote', 'remove', 'origin'])
    rr = run(['remote', 'add', 'origin', remote])
    if rr.returncode != 0:
        return False, 'git remote 配置失败：' + (rr.stderr or rr.stdout)[:200]
    a = run(['add', '-A'], timeout=300)
    if a.returncode != 0:
        return False, 'git add 失败：' + (a.stderr or a.stdout)[:200]
    st = run(['status', '--porcelain'])
    if st.returncode != 0:
        return False, 'git status 失败：' + (st.stderr or st.stdout)[:200]
    if not st.stdout.strip():
        # 对齐后删除却无差异，只可能是远端本来就没有该目录（已被外部删掉）→ 真幂等。
        return True, '该目录在线上已不存在（对齐远端后无差异，幂等）。'
    c = run(['commit', '-m', 'Remove published path: ' + sub], timeout=300)
    if c.returncode != 0:
        return False, 'git commit 失败：' + (c.stderr or c.stdout)[:200]
    # 普通 push（非 force）：父提交就是刚 fetch 的远端最新，正常必然 fast-forward。
    # 若远端在此期间被推进而被拒 → 如实失败，绝不 force 覆盖。
    p = run(['push', 'origin', 'main'], timeout=GH_PUSH_TIMEOUT + 120)
    if p.returncode != 0:
        err = (p.stderr or p.stdout)
        hint = '（远端可能有新提交导致非快进被拒；请稍后重试或到 GitHub 手动处理）' \
               if ('fetch first' in err or 'non-fast-forward' in err.lower()
                   or 'rejected' in err.lower()) else ''
        return False, 'git push 失败，线上未删除' + hint + '：' + err[:300]
    return True, '已从 GitHub 删除 /%s/。' % sub


def _verify_remote_tree(token, owner, repo, repo_files):
    """发布后核对远端 Git 树确实包含所有要推的文件（尤其大视频），
    缺任何一个就显式报错，避免『发布报成功、网页却 404』的静默漏推。
    GitHub 的 git/trees 返回的是「提交后的完整目录清单」，逐项比对即可。"""
    try:
        tree = gh_request('GET', GH_API + '/repos/%s/%s/git/trees/main?recursive=1' % (owner, repo),
                          token, timeout=60)
    except GHError:
        # 拉不到树就不阻断发布（极少发生），交给后续页面加载去暴露问题。
        return
    have = {t['path']: t for t in tree.get('tree', []) if t.get('type') == 'blob'}
    missing = [p for p, _ in repo_files if p not in have]
    if missing:
        raise GHError(0, '发布后校验发现以下文件没有真正推上 GitHub（网页会 404）：\n' +
                       '\n'.join('• ' + p for p in missing[:8]) +
                       '\n请重试发布；若持续出现，可能是网络中断导致推送不完整，'
                       '可先把对应视频压到更小的档位再发布。')

def gh_enable_pages(token, owner, repo):
    body = {'source': {'branch': 'main', 'path': '/'}}
    try:
        gh_request('POST', GH_API + '/repos/%s/%s/pages' % (owner, repo), token, body)
    except GHError as e:
        if e.code == 409:  # 已启用 → 更新
            gh_request('PUT', GH_API + '/repos/%s/%s/pages' % (owner, repo), token, body)
        elif e.code == 422 and 'workflow' in (e.message or '').lower():
            # 新版 GitHub 要求 Actions workflow：提交标准 pages.yml 再启用
            wf = ('name: Pages\non:\n  push:\n    branches: [main]\npermissions:\n  '
                  'contents: read\n  pages: write\n  id-token: write\njobs:\n  build:\n    '
                  'runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      '
                  '- uses: actions/upload-pages-artifact@v3\n        with:\n          path: ./\n      '
                  '- uses: actions/deploy-pages@v4\n        id: deploy\n        with:\n          '
                  'artifact-name: github-pages\n')
            gh_push_files(token, owner, repo, [('.github/workflows/pages.yml', wf.encode('utf-8'))])
            gh_request('POST', GH_API + '/repos/%s/%s/pages' % (owner, repo), token,
                       {'build_type': 'workflow', 'source': {'branch': 'main', 'path': '/'}})
        else:
            raise

def gh_pages_url(token, owner, repo):
    try:
        d = gh_request('GET', GH_API + '/repos/%s/%s/pages' % (owner, repo), token)
        return d.get('html_url') or ('https://%s.github.io/%s/' % (owner, repo))
    except Exception:
        return 'https://%s.github.io/%s/' % (owner, repo)

def gh_release_info(token, owner, repo, tag):
    try:
        return gh_request('GET', GH_API + '/repos/%s/%s/releases/tags/%s' % (owner, repo, tag), token)
    except GHError as e:
        if e.code == 404: return None
        raise

def gh_upload_one_asset(token, upload_url, owner, repo, tag, fn, data):
    """上传单个 release asset，带重试。
    注意：GitHub 的 asset 上传**不支持断点续传**，每次重试都得整份重传 ——
    这也是为什么外层要优先「跳过已存在的同名同长度 asset」，避免重复发布反复重传 100MB+。
    另外必须显式指定 Content-Type：不指定时 urllib 会套 urlencoded，GitHub 直接 422
    「content_type can't be application/x-www-form-urlencoded」，且这条错误与文件大小无关，
    会被误判成"网络问题"。按扩展名给真实 MIME（视频给 video/mp4），GitHub CDN 也会照此下发，
    `<video>` 才能正常播放。"""
    ctype = mimetypes.guess_type(fn)[0] or 'application/octet-stream'
    last = None
    for attempt in range(1, GH_ASSET_RETRIES + 1):
        try:
            u = upload_url + '?name=' + urllib.parse.quote(fn)
            gh_request('POST', u, token, data, raw=True, timeout=GH_ASSET_TIMEOUT, content_type=ctype)
            return True, ''
        except GHError as e:
            last = e
            if e.code in (401, 403, 404):
                return False, ('HTTP %s %s' % (e.code, e.message or '')).strip()
            if e.code == 422:
                return False, 'HTTP 422 %s' % (e.message or 'GitHub 拒绝了这次上传')[:160]
            if attempt < GH_ASSET_RETRIES:
                time.sleep(min(3 * attempt, 10))
    return False, '网络中断（已重试 %d 次）：%s' % (GH_ASSET_RETRIES, (last.message if last else '未知'))[:160]


def gh_upload_release_assets(token, owner, repo, tag, assets, progress=None):
    """assets: list of (filename, bytes)。创建/复用固定 tag 的 release，上传为 assets。
    返回 ({filename: download_url}, [{'file','sizeMB','reason'}, ...]) —— **失败不抛异常**：
    大媒体走的是慢速上行，网络中断很常见；此时站点本身早已推送完成、Pages 也已构建，
    绝不能因为一个视频没传上去就把整次发布判成「失败」（用户会以为站点根本没上线）。
    另外：同名且长度一致的 asset 直接复用，不做 DELETE+重传 —— 重复发布省掉整份 100MB+ 的上行。
    progress(done, total, current_file)：可选进度回调，供后台线程回报给面板。"""
    rel = gh_release_info(token, owner, repo, tag)
    if rel is None:
        rel = gh_request('POST', GH_API + '/repos/%s/%s/releases' % (owner, repo), token,
                         {'tag_name': tag, 'name': 'FolioFold Media',
                          'body': 'Large media for the published portfolio (served to the public site).'})
    rel_id = rel['id']
    upload_url = rel['upload_url'].split('{')[0]  # 去掉 {?name,label} 模板
    existing = {a['name']: a for a in (rel.get('assets') or [])}
    out, failures = {}, []
    total = len(assets)
    for idx, (fn, data) in enumerate(assets):
        if progress: progress(idx, total, fn)
        url = 'https://github.com/%s/%s/releases/download/%s/%s' % (
            owner, repo, tag, urllib.parse.quote(fn))
        old = existing.get(fn)
        if old and int(old.get('size') or -1) == len(data):
            out[fn] = url          # 线上已有同长度同名 asset → 复用，跳过重传
            if progress: progress(idx + 1, total, '')
            continue
        if old:
            try: gh_request('DELETE', GH_API + '/repos/%s/%s/releases/assets/%s' % (owner, repo, old['id']), token)
            except GHError: pass
        ok, why = gh_upload_one_asset(token, upload_url, owner, repo, tag, fn, data)
        if ok:
            out[fn] = url
        else:
            failures.append({'file': fn.replace('__', '/'), 'sizeMB': format_mb(len(data)),
                             'reason': why})
        if progress: progress(idx + 1, total, '')
    return out, failures


# —— 大媒体后台上传状态（发布请求不再被 100MB+ 的上行阻塞）——
_RELEASE_UPLOAD = {'running': False, 'total': 0, 'done': 0, 'current': '', 'failed': [],
                   'startedAt': 0.0, 'finishedAt': 0.0, 'ok': 0}


def gh_release_upload_state():
    st = dict(_RELEASE_UPLOAD)
    st['failed'] = list(st.get('failed') or [])
    return st


def gh_start_release_upload_bg(token, owner, repo, tag, assets):
    """在后台线程里上传大媒体。
    为什么必须异步：150MB 的 showreel 走慢速上行要几分钟到几十分钟；同步做的话
    发布请求会一直挂着（实测 421 秒后被写超时打断），面板显示「发布中…」甚至误报
    「发布失败」，而站点其实早就上线了。异步后发布请求秒回、网址立刻可见，
    上传进度通过 /api/deploy/status 的 mediaUpload 字段暴露给面板轮询。"""
    if _RELEASE_UPLOAD.get('running'):
        return False
    _RELEASE_UPLOAD.update({'running': True, 'total': len(assets), 'done': 0, 'current': '',
                            'failed': [], 'startedAt': time.time(), 'finishedAt': 0.0, 'ok': 0})

    def _progress(done, total, current):
        _RELEASE_UPLOAD['done'] = int(done)
        _RELEASE_UPLOAD['total'] = int(total)
        if current:
            _RELEASE_UPLOAD['current'] = str(current).replace('__', '/')

    def _worker():
        try:
            urls, failures = gh_upload_release_assets(token, owner, repo, tag, assets, progress=_progress)
            _RELEASE_UPLOAD['ok'] = len(urls)
            _RELEASE_UPLOAD['failed'] = failures
        except Exception as e:
            _RELEASE_UPLOAD['failed'] = [{'file': _RELEASE_UPLOAD.get('current') or '媒体文件',
                                          'sizeMB': 0, 'reason': str(e)[:160]}]
        finally:
            _RELEASE_UPLOAD['running'] = False
            _RELEASE_UPLOAD['current'] = ''
            _RELEASE_UPLOAD['finishedAt'] = time.time()

    threading.Thread(target=_worker, daemon=True).start()
    return True

def github_publish(tpl, meta, sub='', reserved=()):
    """GitHub Pages 发布：确保 Published Snapshot → 建/复用稳定名 repo（public）→
    推静态站点（HTML/CSS/JS/小媒体）→ 启用 Pages → 取 URL → 大媒体走 Release Assets。
    同一用户重复发布会复用同名仓库（只更新内容），公开网址保持不变。

    —— 多模板多路径 ——
    sub：本模板在仓库里的子目录名（空 = 推到仓库根）。多个模板共用一个仓库，
      每个模板一个子目录，各自的链接 `https://<owner>.github.io/<repo>/<sub>/` 互相独立。
    reserved：仓库里其它模板占用的顶层目录名，同步时**不许删**（见 _sync_tree 的 preserve）。
    meta：本次发布的附加信息（含 useSub 标记），用于决定 URL 是否带子路径。"""
    tok = load_gh_token()
    if not tok.get('token'):
        raise GHError(0, '尚未连接 GitHub。请在发布面板点「连接 GitHub」，输入 8 位设备码完成授权后重试。')
    token = tok['token']

    def _stage(phase, fn, *a, **k):
        try:
            return fn(*a, **k)
        except GHError as e:
            try: e.phase = phase
            except Exception: pass
            raise

    # 0) 发布前体检：用真实 API 确认这枚令牌现在还能用、还能建仓库。
    #    绝不在"授权早已失效 / 类型不对"的情况下闷头跑到一半才报英文错。
    cap = _stage('auth', gh_check_access, token, True)
    if not cap.get('ok'):
        # ⚠ 2026-09-25：网络问题 ≠ 授权问题。以前两种都让用户「断开→重新连接 GitHub」，
        #   于是「系统代理死了」这种纯网络故障被当成授权失效，用户怎么重连都没用。
        if cap.get('netProblem'):
            raise GHError(0, (cap.get('error') or '无法访问 GitHub') + '。' + net_hint())
        raise GHError(401 if cap.get('expired') else 0,
                      (cap.get('error') or 'GitHub 授权当前不可用')
                      + '。请点「断开 GitHub」后重新「连接 GitHub」完成一次授权。')
    login = cap.get('login') or tok.get('login') or ''
    # 仓库名优先级（⚠ 2026-10-06 发布收口）：
    # 上次发布用的仓库（重复发布必须落到同一个仓库；已弃用的 foliofold / folioframe 除外）
    # > 固定默认仓 GH_PUBLISH_REPO。不再按 profile.name 的 slug 自动派生 ——
    # tpl-2 的名字是 "FolioFold"，会派生出已弃用的 foliofold 仓。
    # ⚠ 2026-10-08：旧名 folioframe（FolioFrame）一并排除，避免改名后回落到已不存在的旧仓库。
    prev = load_public_link()
    prev_repo = ((prev.get('meta') or {}).get('repoName') or '') if prev.get('provider') == 'github' else ''
    if (prev_repo or '').strip().lower() in (GH_PUBLISH_REPO_DEPRECATED, 'folioframe'):
        prev_repo = ''
    repo_name = (prev_repo or GH_PUBLISH_REPO)[:50] or GH_PUBLISH_REPO
    # ⚠ 每次发布用独立的临时目录，避免两次发布并发跑时互相 rmtree 掉对方的打包目录
    # （旧实现共用固定的 _bundle_gh/<tpl>，连点两下「更新」就会把 index.html 读成空 → 推成 0 字节空白站点）。
    bundle = Path(tempfile.mkdtemp(prefix='_bundle_gh_', dir=DEPLOY_DIR))
    info = build_public_bundle(bundle, tpl, max_commit_bytes=GH_REPO_MAX_BYTES)
    large = info.get('largeMedia') or []
    # ⚠ 打包阶段若有媒体没复制成功（源缺失/磁盘占用/拷贝失败），绝不假装成功继续推。
    # 否则会出现"发布报成功、网页视频却 404"的假成功 —— 正是之前踩过的坑。
    missing = info.get('missing') or []
    if missing:
        raise GHError(0, '以下媒体文件在打包时未能复制进发布包（网页会 404）：\n' +
                       '\n'.join('• /media/' + m for m in missing[:8]) +
                       '\n可能是文件被其它程序占用或磁盘读取失败。请关闭占用它的程序后重试发布；'
                       '若仍失败，可把对应视频压到更小的档位再发布。')
    # 1) 仓库：已存在 → 直接复用（网址不变）；不存在 → 需要建仓权限
    # ⚠ 2026-09-25 审计修复（BUG-2）：这是个幂等 GET，2026-09-25 20:24 真实失败案例——
    #   前一步建仓探针还通（TLS 正常），18 秒后这个 GET 被瞬时 SSL 重置掐断，
    #   整场发布直接失败。网络抖动重试一次即可显著降低误伤；404 是「仓库不存在」的正常回答。
    repo_exists = False
    for _attempt in (0, 1):
        try:
            gh_request('GET', GH_API + '/repos/%s/%s' % (login, repo_name), token)
            repo_exists = True
            break
        except GHError as e:
            if e.code == 0 and _attempt == 0:
                time.sleep(1.5)
                continue
            if e.code != 404:
                e.phase = 'repo'
                raise
            break
    if not repo_exists and not cap.get('canCreateRepo'):
        raise GHError(403, cap.get('canCreateRepoReason') or GH_APP_TOKEN_HINT)
    created = False
    try:
        _, created = gh_ensure_repo(token, login, repo_name)
    except GHError as e:
        e.phase = 'repo'
        raise
    # 2) 大媒体：预测 release 下载 URL，先把 index.html/404.html 里的引用改写掉（避免撑爆 Git 仓库）
    #    release asset 名不能含 "/"，用 "__" 拍平子目录，下载 URL 与上传名保持一致。
    if large:
        release_urls = {}
        for fn in large:
            flat = fn.replace('/', '__')
            release_urls[fn] = 'https://github.com/%s/%s/releases/download/%s/%s' % (
                login, repo_name, GH_RELEASE_TAG, urllib.parse.quote(flat))
        for htmlf in ('index.html', '404.html'):
            p = bundle / htmlf
            if p.exists():
                t = p.read_text(encoding='utf-8')
                for fn, url in release_urls.items():
                    t = t.replace('"media/%s"' % fn, '"%s"' % url).replace("'media/%s'" % fn, "'%s'" % url)
                p.write_text(t, encoding='utf-8')
    # 3) 收集要进仓库的文件（index.html / 404.html / media/* 小文件）
    #    ⚠ 子目录模式下，远端路径 = <sub>/... —— 校验清单必须带上 sub，否则会误报"没推上去"。
    pre = (sub + '/') if sub else ''
    repo_files = []
    for htmlf in ('index.html', '404.html'):
        p = bundle / htmlf
        if p.exists(): repo_files.append((pre + htmlf, p.read_bytes()))
    media_dir = bundle / 'media'
    if media_dir.exists():
        for f in media_dir.rglob('*'):
            if f.is_file():
                repo_files.append((pre + 'media/' + f.relative_to(media_dir).as_posix(), f.read_bytes()))
    # 3b) ⚠ 推送前兜底：index.html / 404.html 绝不能空。空文件一旦推上去，线上站点就是空白页，
    # 而 _verify_remote_tree 只校验"路径在不在"、不校验内容，会放过空文件造成假成功。
    for path, data in repo_files:
        if path in ('index.html', '404.html', pre + 'index.html', pre + '404.html') and len(data) == 0:
            raise GHError(0, '发布包里的 %s 生成为空（多半是两次发布同时跑、打包目录被互相删除导致）。'
                           '已中止发布，避免把空白站点推上线。请等几秒、只点一次「更新 FolioFold」再重试。' % path)
    # 4) 推送（用 git 协议：Git Data API 的 /git/blobs 对大视频会被 GitHub 边缘返回 401）
    _stage('push', gh_push_repo_git, token, login, repo_name, bundle, tpl, sub, reserved)
    # 4b) 核对远端 tree 真的收到了所有文件（尤其大视频），缺任一立即报错，绝不"假成功"。
    _verify_remote_tree(token, login, repo_name, repo_files)
    # 4c) 打包临时目录已无用（后续 Release 上传只读原始 MEDIA），立即清理，避免堆积 + 下次并发互相干扰。
    try:
        _rmtree_forgiving(bundle)
    except Exception:
        pass
    # 5) 启用 Pages（已启用则更新）+ 取 URL
    _stage('pages', gh_enable_pages, token, login, repo_name)
    url = _stage('pages', gh_pages_url, token, login, repo_name)
    # ⚠ 子目录模式：把 URL 指向 <sub>/。gh_pages_url 返回的是仓库主页地址
    # （https://<owner>.github.io/<repo>/），各模板必须各自带上自己的子路径，
    # 否则面板会把所有人都指到同一个地址（=模板一），也就等于"多路径"白做。
    if sub:
        url = url.rstrip('/') + '/' + sub + '/'
    else:
        url = url.rstrip('/') + '/'
    # 6) 大媒体走 Release Assets，但**放到后台线程上传**：
    #    发布请求立刻返回（网址马上可用），上传进度由 /api/deploy/status 的 mediaUpload 暴露。
    #    实测教训：150MB 的 showreel 同步上传要 7 分钟以上并被写超时打断，期间面板一直
    #    显示「发布中…」最后还误报失败 —— 而站点其实早已上线。
    warnings, media_pending, media_mb = [], 0, 0.0
    if large:
        assets = []
        for fn in large:
            src = MEDIA / fn
            if src.exists(): assets.append((fn.replace('/', '__'), src.read_bytes()))
        if assets:
            media_mb = format_mb(sum(len(d) for _, d in assets))
            if gh_start_release_upload_bg(token, login, repo_name, GH_RELEASE_TAG, assets):
                media_pending = len(assets)
            else:
                warnings.append('已有一次大媒体上传正在进行，本次跳过（稍后可在面板查看进度）。')
    if media_pending:
        warnings.append('站点已上线。另有 %d 个较大的媒体文件（约 %s MB）正在后台上传，'
                        '上传完成前，网页上的视频/大图会暂时是空的——进度可在发布面板查看，'
                        '不必再更新。' % (media_pending, media_mb))
    # 关键提醒：走 Release 附件的大视频，上线后**只能下载、不能在线播放**。
    # 这件事必须在发布那一刻就讲清楚，否则用户会以为是"上传失败 / 编码有问题"来回折腾。
    # （实测：某 143.9MB 的 showreel 上线后，站点一切正常、视频能下载，
    #   但 <video> 因 Content-Type: application/octet-stream 直接 onerror。）
    play_lost = []
    for rel in large:
        try:
            if ff_probe_url('/media/' + rel) and media_abs_path('/media/' + rel).suffix.lower() in ('.mp4', '.mov', '.m4v', '.webm'):
                play_lost.append(rel.split('/')[-1])
        except Exception:
            pass
    if play_lost:
        warnings.append('⚠️ %s 体积超过 GitHub 单文件上限（%d MB），已放进 Release 附件。'
                        '附件只能下载、不能被浏览器在线播放 —— 网页上会显示成「无法直接播放」。'
                        '想让它在网页里直接播：打开「② 文本编辑 → Showreel」最下面的「视频压缩」，'
                        '压到上限以内后再发布一次。'
                        % ('、'.join(play_lost[:3]), format_mb(GH_REPO_MAX_BYTES, 0)))
    return {'url': url, 'repoName': repo_name, 'owner': login, 'files': info.get('files'),
            'mediaCopied': info.get('mediaCopied'), 'largeMedia': len(large), 'repoCreated': created,
            'mediaPending': media_pending, 'warnings': warnings, 'releaseFailed': [],
            'unplayableLarge': play_lost, 'subPath': sub, 'hostingPath': url}



class GitHubPagesProvider(PublishProvider):
    id = 'github'; name = 'GitHub Pages'
    def configured(self, cfg): return gh_configured()
    def status_extras(self, cfg, link):
        t = load_gh_token()
        return {'login': t.get('login') or '', 'publicUrl': link.get('url') or '',
                'repoName': (link.get('meta') or {}).get('repoName') or ''}
    def publish(self, bundle_dir, tpl, meta):
        meta = meta or {}
        return github_publish(tpl, meta, meta.get('subPath') or '', meta.get('reservedPaths') or ())

# 注册所有 Provider（新增 Provider 只需在此追加，无需改动发布核心）
PUBLISH_PROVIDERS = {'cloudbase': CloudBaseProvider(), 'github': GitHubPagesProvider()}

# ======================= Publish Core（只认 Provider，不含任何 Provider 细节）=======================
def publish_core(provider_id, tpl, mode='update', path_name=None, force_path=None):
    """统一的发布核心：确保有 Published Snapshot（不碰 Draft）→ 打包 → 调对应 Provider。
    返回 {ok, url, provider, subPath, ...}。Draft 与 Published 严格分离。

    —— 多模板多路径（mode）——
    mode='update'（默认，「更新当前发布」）：
        覆盖本模板**上一次发布用过的**子路径；没有记录则按自动规则分配一个。
        → 拿到原链接的人看到的内容变成当前模板，其它模板的链接完全不受影响。
    mode='new'（「新增子发布」）：
        分配一个新子路径（path_name 给了就用它，否则自动生成且避让冲突），
        原本的记录保持不动。→ 同一套内容可以同时挂在多个地址下。
    path_name：用户在界面上手填的子路径名（可为空 = 自动）。会做规范化与去重。

    —— force_path（2026-09-20 新增，修「改发布内容点了没反应」的根因）——
    一旦给了 force_path，本次**必须**发布到这个路径，不再走"该模板上一次用过的路径"
    那套推断。为什么必须有这个参数：
        retarget 的语义是「保留 /A/ 这个网址，把里面的内容换成模板二」，
        但旧实现里 publish_core 只用 tpl 去查 existing → 查到的是**模板二自己**那条
        （比如 /tpl-2/），于是内容被发到了模板二自己的地址上，用户点名要改的
        /A/ 一动不动，界面上表现为「点了按钮，什么都没发生」。
    force_path 非空时记录也按 (provider, path) 覆盖，保证 A 地址那条记录被真正改写。

    —— 出网前置（2026-09-25 加）——
    每次发布前强制刷新一次「代理是否可用」的结论：系统代理可能在上一次发布之后
    才变成不可用（或反过来），用旧结论会让整次发布白跑一趟。
    """
    net_refresh(force=True)
    provider = PUBLISH_PROVIDERS.get(provider_id)
    if provider is None:
        raise ValueError('未知 Provider：' + str(provider_id))
    mode = 'new' if str(mode or '').strip().lower() in ('new', 'add', 'sub') else 'update'
    try:
        deployments = load_deployments()
        # —— 决定本次发布的子路径 ——
        # 一个模板在同一个 provider 下**可以有多条**记录（点「另外发布一个链接」就多一条）。
        # existing = 该模板当前那条（= 「更新当前发布」要覆盖的目标）。
        existing = find_deployment(deployments, provider_id, tpl)
        legacy_default = ''
        if provider_id == 'cloudbase':
            legacy_default = str((load_cb_cfg() or {}).get('path') or '').strip().strip('/')
        forced = _norm_path_name(force_path) if str(force_path or '').strip() else ''
        if forced:
            # 用户点名了目标路径 —— 无条件服从（retarget / 更新发布这条）。
            sub = forced
        elif mode == 'update' and existing:
            # 覆盖该模板当前的路径 —— 链接不变、内容变新。
            sub = str(existing.get('path') or '').strip().strip('/')
        elif mode == 'update' and not existing and not path_name and legacy_default:
            # 模板一第一次在 CloudBase 上发布：直接用配置里既有的 path（线上地址不变）。
            sub = _norm_path_name(legacy_default)
        else:
            # 「另外发布一个链接」：分配一个全新且不冲突的路径。
            sub = suggest_deploy_path(tpl, provider_id, deployments, prefer=path_name)
        sub = _norm_path_name(sub) if sub else ''
        # ⚠ 防双路径：GitHub 下若 sub 与仓库名相同（用户误填 repo slug，或某次把路径填成了仓库名），
        # 下面拼 URL 时会变成 <repo>/<repo>/ 双路径，站点能建但地址错、且和根路径记录重复。
        # 这种情况一律当作根路径处理（仓库根目录本就是它的归属）。CloudBase 无仓库概念，跳过。
        if provider_id == 'github':
            _gh_repo = _gh_repo_name(tpl)
            if sub and _gh_repo and sub.lower() == _gh_repo.lower():
                sub = ''
        # 同一 provider 下，**除了"本次要覆盖的那一条"**，任何占用都不能撞车。
        taken = set()
        for d in deployments:
            if d.get('provider') != provider_id: continue
            p = str(d.get('path') or '').strip().strip('/')
            if not p: continue
            if forced:
                # 强制路径：目标那条本身就是被覆盖对象，允许；其余同路径记录也放行
                if p.lower() == forced.lower(): continue
            elif mode == 'update' and existing and p == str(existing.get('path') or '').strip().strip('/'):
                continue   # 自己那条，允许
            taken.add(p.lower())
        if sub and sub.lower() in taken:
            sub = suggest_deploy_path(tpl, provider_id, deployments, prefer=(path_name or sub))

        # 1) 确保有已发布快照（草稿有改动则先固化为本地发布版；绝不改写草稿）
        pub_job_phase('准备', '正在固化发布快照（草稿不会被改动）…')
        tp = tpl_paths(tpl)
        draft_sig = json.dumps(normalize(read(tp['draft']) or {}), ensure_ascii=False, sort_keys=True)
        pub_sig = json.dumps(normalize(read(tp['published']) or {}), ensure_ascii=False, sort_keys=True)
        d_sig = json.dumps(read(tp['design']) or {}, ensure_ascii=False, sort_keys=True)
        dp_sig = json.dumps(read(tp['designPublished']) or {}, ensure_ascii=False, sort_keys=True)
        if draft_sig != pub_sig or d_sig != dp_sig:
            write(tp['published'], normalize(read(tp['draft'])))
            if tp['design'].exists():
                write(tp['designPublished'], read(tp['design']))
        # 2) 媒体体检：只有超出对应平台「单文件硬上限」才拦截，绝不把"文件 >100MB"简单定义为产品失败。
        #    - （早期 Cloudflare Pages 渠道单文件上限约 25MiB，已于 2026-09-18 移除。）
        #    - GitHub：普通仓库 100MB 限制由 Release Assets 绕过；Release Assets 单文件上限约 2GB，
        #      仅当媒体 >2GB 才拦。500MB 级媒体可保留（改走 Release Assets）。
        published = normalize(read(tp['published']))
        design = with_section_order(read(tp['designPublished']) or {}, read(tp['published']) or {})
        refs = collect_media_refs(published, design)
        if provider_id == 'cloudbase':
            # CloudBase 单文件上限极宽（控制台单对象 512GB 级），真正的约束是
            # 每月 CDN 流量而不是文件体积，所以这里沿用宽松阈值，只在明显异常时拦截。
            oversized = media_preflight(refs, max_bytes=2 * 1024 * 1024 * 1024)
        else:
            oversized = [f for f in media_preflight(refs, max_bytes=2 * 1024 * 1024 * 1024)]
        if oversized:
            return {'ok': False, 'mediaBlocked': True, 'files': oversized,
                    'error': '以下媒体文件过大，无法随当前 Public Link 发布：\n' +
                             '\n'.join('• ' + f['path'] + '（' + str(f['mb']) + ' MB）' for f in oversized)}
        # 3) 打包：**每次都用独立临时目录**。
        #    ⚠ 旧实现用固定的 _bundle/<tpl> 共享目录：
        #    连点两次「更新」时，两个发布进程会互相 rmtree 掉对方的打包目录 →
        #    index.html 被读成 0 字节 → 推成空白站点（2026-09-17 线上变空白页的根因）。
        #    改成 mkdtemp 后并发各打各的，互不影响。
        #    另外 GitHub Provider 自己会再打包一份（见 github_publish 内的 mkdtemp）且会自清理，
        #    这里不再替它重复打一份 —— 否则每次发布白复制 ~67MB、白等几十秒。
        bundle = None
        if provider_id == 'github':
            info = {}
        else:
            pub_job_phase('打包', '正在打包静态站点（含媒体文件）…')
            bundle = Path(tempfile.mkdtemp(prefix='_bundle_cb_', dir=DEPLOY_DIR))
            info = build_public_bundle(bundle, tpl)
        # 传给 Provider 的附加信息：子路径 + 需要保留的其它模板目录（GitHub 用）。
        meta = dict(info or {})
        meta['subPath'] = sub
        meta['mode'] = mode
        meta['reservedPaths'] = sorted({
            str(d.get('path') or '').strip().strip('/')
            for d in deployments
            if d.get('provider') == provider_id and (d.get('tpl') or LEGACY_TPL_ID) != (tpl or LEGACY_TPL_ID)
            and str(d.get('path') or '').strip().strip('/')
        })
        try:
            # 4) 调 Provider
            res = provider.publish(bundle, tpl, meta)
        finally:
            if bundle is not None:
                _rmtree_forgiving(bundle)
        # 5) 记录本次发布
        #    replace=(mode=='update')：更新当前发布就替换该模板那条记录（链接不变）；
        #    否则**追加**一条 —— 一个模板可以挂多个地址（用户点几次「另外发布一个链接」就有几条）。
        # tplName 一并落盘：面板显示用；否则列表里会只剩 id，用户看到两条都是「模板一」分不清。
        _tpl_name = next((it.get('name') for it in (load_templates().get('items') or [])
                          if it.get('id') == (tpl or LEGACY_TPL_ID)), None)
        rec = {'provider': provider_id, 'tpl': tpl or LEGACY_TPL_ID,
               'tplName': _tpl_name or ('模板一' if (tpl or LEGACY_TPL_ID) == LEGACY_TPL_ID else (tpl or LEGACY_TPL_ID)),
               'path': str(res.get('subPath') if res.get('subPath') is not None else sub).strip().strip('/'),
               'url': res['url'], 'deployedAt': now_iso(),
               'meta': {k: res[k] for k in ('repoName', 'owner', 'files', 'mediaCopied', 'largeMedia', 'envId') if k in res},
               'files': res.get('files'), 'mediaCopied': res.get('mediaCopied')}
        save_deployment_upsert(rec, replace=(mode == 'update'), match_path=bool(forced))
        return {'ok': True, 'url': res['url'], 'provider': provider_id, 'subPath': rec['path'], **res}
    except CBError as e:
        return {'ok': False, 'error': 'CloudBase 部署失败：' + str(e), 'code': e.code}
    except GHError as e:
        # 分阶段中文错误：授权失败 / 权限不足 / 令牌过期 / 网络失败 / 建仓失败 / Pages 失败 各说各的。
        return {'ok': False, 'error': gh_user_message(e, getattr(e, 'phase', '')), 'code': e.code}
    except Exception as e:
        return {'ok': False, 'error': '发布失败：' + str(e)[:200]}

def apply_template(tpl_id, obj):
    """只把模板里的 design 合进当前模板的 design.json —— 绝不写 portfolio.json。"""
    if not template_is_valid(obj):
        return False, '不是有效的 FolioFold 模板'
    incoming = obj.get('design') or {}
    if not isinstance(incoming, dict):
        return False, '模板里的 design 字段无效'
    paths = tpl_paths(tpl_id)
    cur = read(paths['design']) or {}
    if not isinstance(cur, dict): cur = {}
    # 上一版留作可恢复点（design.previous.json）
    if paths['design'].exists():
        try: write(paths['designPrevious'], cur)
        except Exception: pass
    merged = dict(cur)
    merged.update(incoming)
    # —— Section Order：属于 Template，导入时可以被模板替换 ——
    # 模板带了合法顺序 → 用模板的；模板没带（老模板）→ 保留本机现有顺序，绝不回退到默认或写清。
    new_order = extract_section_order(obj)
    if new_order is not None: merged[SECTION_ORDER_KEY] = new_order
    elif valid_section_order(cur.get(SECTION_ORDER_KEY)): merged[SECTION_ORDER_KEY] = cur[SECTION_ORDER_KEY]
    elif not valid_section_order(merged.get(SECTION_ORDER_KEY)): merged.pop(SECTION_ORDER_KEY, None)
    merged['schemaVersion'] = SCHEMA_VERSION
    merged['designVersion'] = int(cur.get('designVersion') or 1) + 1
    merged['savedAt'] = now_iso()
    write(paths['design'], merged)
    # 导入模板也是「纯排版」变更：把新版的排版字段一并同步到「已发布」的 design，
    # 否则用户导入完切到「最新版本」会看到旧版式，误以为导入没生效。
    sync_layout_to_published(tpl_id, merged)
    return True, merged

def apply_content_settings(tpl_id, settings):
    """把「语言设置」这类纯开关写进 content —— 只碰 settings 白名单里的键，其它一个字节都不动。

    为什么要单独开一个函数：导入模板的大原则是「绝不写 portfolio.json」。
    但 translationMode（机翻是否直接采用）是**设置**不是内容，用户明确希望它跟着模板走。
    所以这里用白名单把写入面收到最小：只改 settings.translationMode，
    绝不碰 localizedContent / sectionTitleTranslations —— 那里装的是**译文**，
    译文里全是个人文本，跟内容一样不能跨作品集搬运。
    """
    if not isinstance(settings, dict): return False
    tm = str(settings.get('translationMode') or '').strip().lower()
    if tm not in ('review', 'direct'): return False
    paths = tpl_paths(tpl_id)
    content = read(paths['draft']) or {}
    if not isinstance(content, dict): return False
    cur = content.get('settings') if isinstance(content.get('settings'), dict) else {}
    if cur.get('translationMode') == tm: return False
    cur = dict(cur); cur['translationMode'] = tm
    content = dict(content); content['settings'] = cur
    write(paths['draft'], content)
    return True

def sync_layout_to_published(tpl_id, design=None):
    """把 design 里的「纯排版」字段同步进已发布的 design。

    间距 / 图片尺寸 / 媒体排版 / 文本样式 / 静态元素增删 / 静态文案 / 区块顺序 / pixel
    这类改动属于「所见即所得」的排版微调，用户改完就应该立刻生效，
    不该再要求他手动点一次「更新到最新版本」——否则他看"最新版本"时会看到旧值，
    误以为"改了没存"。theme / typography 有意不在其中（换主题属成品内容层面的决定）。
    返回是否真的同步了。
    """
    paths = tpl_paths(tpl_id)
    if not paths['design'].exists():
        return False
    src = design if isinstance(design, dict) else (read(paths['design']) or {})
    pub = read(paths['designPublished']) or {}
    if not isinstance(pub, dict): pub = {}
    for k in LAYOUT_KEYS:
        if k in src: pub[k] = src[k]
    pub['schemaVersion'] = src.get('schemaVersion', pub.get('schemaVersion', SCHEMA_VERSION))
    pub['savedAt'] = src.get('savedAt') or now_iso()
    write(paths['designPublished'], pub)
    return True

def media_ref(path, mime=''):
    return {'url': '/media/' + path.relative_to(MEDIA).as_posix(), 'name': path.name, 'type': mime or mimetypes.guess_type(path.name)[0] or ''}

def save_data_image(value, hint='image'):
    match = DATA_IMAGE.match(value.strip()) if isinstance(value, str) else None
    if not match: return None
    ext = mimetypes.guess_extension(match.group(1)) or '.png'
    folder = MEDIA / 'migrated'; folder.mkdir(parents=True, exist_ok=True)
    target = folder / f'{hint}-{int(time.time() * 1000)}{ext}'
    target.write_bytes(base64.b64decode(re.sub(r'\s+', '', match.group(2))))
    return media_ref(target, match.group(1))

def clean_text(value):
    if not isinstance(value, str): return value
    return re.sub(r'data:image/[\w.+-]+;base64,[A-Za-z0-9+/=\s]+', '[已迁移的图片媒体]', value)

# 真正浏览器完全解不了的封装（连 H.264/MJPEG 都没有的纯容器）：这些上传后前台一定播不了。
# 注意：.mov / .m4v 已移除——Chromium/Edge 能播 H.264/HEVC 封装的 MOV，只有 ProRes 这类编码才不行，
# 而编码无法靠后缀判断，故交给前端「先试播、解码失败再 onerror 兜底」处理，最大化支持的格式。
BROWSER_UNPLAYABLE = ('.mxf', '.avi', '.mkv', '.flv', '.wmv')

def prefer_playable_video(ref):
    """把浏览器无法解码的容器优先指向同名 .mp4，避免前台出现"没有可播放资源"的黑框。
    没有同名 mp4 时保持原引用不动（前端会给出明确提示，而不是静默失败）。"""
    if not isinstance(ref, dict): return ref
    url = str(ref.get('url') or '')
    low = url.lower()
    if not low.endswith(BROWSER_UNPLAYABLE): return ref
    cand = url[:url.rfind('.')] + '.mp4'
    target = ROOT / cand.lstrip('/')
    if target.is_file():
        ref = dict(ref); ref['url'] = cand; ref['type'] = 'video/mp4'
        ref['name'] = Path(cand).name
        ref['convertedFrom'] = Path(url).name
    return ref

# ============================================================================
# 视频本地压缩（转码）
# ----------------------------------------------------------------------------
# 为什么必须有这个东西：
#   GitHub Pages 能正常内联播放：文件进仓库，Pages 下发 Content-Type: video/mp4。
#   但 Git 单文件硬上限 100MB（本机阈值取 90MB），超过就只能走 GitHub Release 附件。
#   而 Release 附件的 HTTP 响应被 GitHub 固定为
#       Content-Type: application/octet-stream
#       Content-Disposition: attachment
#   浏览器遇到这种响应一律拒绝内联播放（<video> 直接 onerror）——**只能下载**。
#   于是「上传成功、网址可开、视频点开却报不支持」就出现了：不是编码问题，是下发方式问题。
#   唯一解法：在本地把视频压到 90MB 以内，让它回到 Pages 托管。
#   顺带解决另一个真问题：手机 / 微信内置浏览器对 1920x1440 + H.264 Level 5.0 这类
#   非主流规格常常没有硬解，压到 ≤1920x1080 / Level 4.x 才是真正的"到处都能播"。
# ----------------------------------------------------------------------------
FFMPEG_ENV = 'FOLIOFRAME_FFMPEG'
FFMPEG_DIR = DEPLOY_DIR / 'tools'
FFMPEG_EXE = FFMPEG_DIR / 'ffmpeg.exe'
WEB_OK_VCODECS = ('h264', 'vp8', 'vp9', 'av1')
WEB_OK_ACODECS = ('aac', 'mp3', 'opus', 'vorbis')

def ffmpeg_path():
    """找 ffmpeg：环境变量 → .folioframe/tools/ffmpeg.exe → PATH。找不到返回 ''。"""
    cands = []
    env = (os.environ.get(FFMPEG_ENV) or '').strip()
    if env: cands.append(Path(env))
    cands.append(FFMPEG_EXE)
    found = shutil.which('ffmpeg')
    if found: cands.append(Path(found))
    for c in cands:
        try:
            if c and Path(c).is_file(): return str(c)
        except Exception:
            pass
    return ''

def _ff_run(args, timeout=120):
    """跑一次 ffmpeg，返回 (returncode, stderr_text)。ffmpeg 把一切信息都写在 stderr。"""
    exe = ffmpeg_path()
    if not exe: return -1, '未找到 ffmpeg'
    try:
        p = subprocess.run([exe, '-hide_banner'] + args, stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, timeout=timeout,
                           creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        return p.returncode, p.stderr.decode('utf-8', 'ignore')
    except subprocess.TimeoutExpired:
        return -1, 'ffmpeg 执行超时'
    except Exception as e:
        return -1, str(e)

def media_abs_path(url):
    """把 /media/xxx 或 media/xxx 或 http(s):// 外部链接转成磁盘路径；外部链接返回 None。"""
    u = str(url or '').strip()
    if not u or u.startswith(('http://', 'https://', 'data:')): return None
    u = u.split('?')[0].split('#')[0]
    for pre in ('/media/', 'media/'):
        if u.startswith(pre):
            u = u[len(pre):]
            break
    try:
        p = (MEDIA / unquote(u)).resolve()
        p.relative_to(MEDIA.resolve())     # 防目录穿越
    except Exception:
        return None
    return p if p.is_file() else None

_TIME_RE = re.compile(r'Duration:\s*(\d+):(\d\d):(\d\d(?:\.\d+)?)')
_VID_RE = re.compile(r'Stream #\d+:\d+.*?:\s*Video:\s*([A-Za-z0-9_]+)')
_AUD_RE = re.compile(r'Stream #\d+:\d+.*?:\s*Audio:\s*([A-Za-z0-9_]+)')
_DIM_RE = re.compile(r'(\d{2,5})x(\d{2,5})')
_VBRE_RE = re.compile(r'Stream #\d+:\d+.*?:\s*Video:.*?,\s*(\d+)\s*kb/s')
_ABRE_RE = re.compile(r'Stream #\d+:\d+.*?:\s*Audio:.*?,\s*(\d+)\s*kb/s')
_WEB_PREVIEW_RE = re.compile(r'-web', re.IGNORECASE)

def ff_probe_url(url, timeout=60):
    """用 ffmpeg（不是 ffprobe）读媒体信息。返回 dict；文件不存在/外部链接返回 None。"""
    path = media_abs_path(url)
    if path is None: return None
    rc, err = _ff_run(['-i', str(path)], timeout=timeout)
    info = {'file': path.name, 'path': str(path), 'bytes': path.stat().st_size,
            'mb': format_mb(path.stat().st_size),
            'bytes': path.stat().st_size,
            'mib': round(path.stat().st_size / 1048576.0, 2)}
    m = _TIME_RE.search(err)
    if m:
        info['duration'] = round(int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3)), 2)
    mv, ma = _VID_RE.search(err), _AUD_RE.search(err)
    info['vcodec'] = (mv.group(1).lower() if mv else '')
    info['acodec'] = (ma.group(1).lower() if ma else '')
    if mv:
        seg = err[mv.start():err.find('Stream #', mv.end()) if err.find('Stream #', mv.end()) > 0 else len(err)]
        d = _DIM_RE.search(seg)
        if d:
            info['width'], info['height'] = int(d.group(1)), int(d.group(2))
    info['container'] = path.suffix.lower()
    info['overLimit'] = info['bytes'] > GH_REPO_MAX_BYTES
    # 视频 / 音频码率（用于"每个压缩版本记录"的元数据）。ffmpeg -i 的 stderr 会打印 kb/s。
    mv_bre = _VBRE_RE.search(err); ma_bre = _ABRE_RE.search(err)
    if mv_bre: info['vbr'] = int(mv_bre.group(1)) * 1000
    if ma_bre: info['abr'] = int(ma_bre.group(1)) * 1000
    # 浏览器友好性判定：编码在可播白名单里才算"能播"。
    # 后缀像 .mp4 但里面是 HEVC/ProRes 的情况真实存在，所以只认编码，不认后缀。
    info['webPlayable'] = bool(info.get('vcodec')) and info['vcodec'] in WEB_OK_VCODECS
    # 是否可作为「网页内联播放」的 Web Preview：未超 GitHub 单文件上限 + 编码浏览器兼容。
    # （必须在 webPlayable 之后算，否则 webPlayable 还是 None）
    info['playable'] = (not info['overLimit']) and bool(info.get('webPlayable'))
    return info

def media_publish_warning(info, kind='video'):
    """把媒体信息翻译成"发布到公网会发生什么"的大白话警告。空字符串 = 没问题。
    这是这套压缩功能的入口提示：用户在上传那一刻就该知道后果，而不是等上线后才发现播不了。"""
    if not info: return ''
    limit_mb = format_mb(GH_REPO_MAX_BYTES, 0)
    load = '视频' if kind == 'video' else '文件'
    if info.get('overLimit'):
        return (f'这个{load} {info["mb"]} MB，超过 GitHub 单文件上限（{limit_mb} MB）。'
                f'发布时它只能走 Release 附件，而 Release 附件被 GitHub 强制以「下载」方式下发，'
                f'浏览器不会内联播放 —— 网页上会显示成「无法直接播放」，但可以下载。'
                f'点下面的「压缩」把它压到 {limit_mb} MB 以内，就能回到 GitHub Pages 正常在线播放。')
    if info.get('vcodec') and not info.get('webPlayable'):
        return (f'这个{load}的编码是 {info["vcodec"].upper()}，不是浏览器通用的 H.264 / VP9 / AV1。'
                f'手机 Safari、微信内置浏览器常常解不了，建议点下面的「压缩」转成 H.264 再发布。')
    w, h = info.get('width'), info.get('height')
    if w and h and (w > 1920 or h > 1080):
        return (f'这个{load}是 {w}×{h}，比 1920×1080 还大。电脑上能播，'
                f'但部分手机 / 微信内置浏览器没有对应的硬解，可能出现黑屏或只出声。'
                f'想要「到处都能播」，建议点下面的「压缩」。')
    return ''

# —— 压缩档位 ——
# 「推荐」故意用降分辨率而不是硬压同分辨率：同样压到 50MB 左右，
# 1440 长边 + CRF23 的画面比 1920 长边 + CRF26 干净得多（实测同一素材）。
# 原分辨率 1920x1440 在 H.264 里是非标准规格（Level 5.0），很多手机硬解不支持，
# 所以「推荐」档不是敷衍，是兼容性最优解。估计值来自本机 20 秒试压外推，仅供预览。
COMPRESS_PRESETS = {
    'balanced': {'label': '推荐 · 到处都能播', 'maxEdge': 1440, 'crf': 23, 'abr': '128k',
                 'note': '等比缩到最长边 1440，H.264 High / yuv420p。手机、微信、B 站都吃得下。'},
    'keeplarge': {'label': '保原分辨率 · 体积更紧', 'maxEdge': 0, 'crf': 25, 'abr': '128k',
                  'note': '保持原始分辨率，用更低的码率换体积。画面细节比推荐档略糊。'},
    'smallest': {'label': '最小 · 弱网/朋友圈', 'maxEdge': 1080, 'crf': 24, 'abr': '96k',
                 'note': '缩到最长边 1080，体积最小，适合微信里直接发。'},
}

def _even(n): return int(n) - (int(n) % 2)

def compress_scale_filter(info, max_edge):
    """按最长边等比缩放（只缩不放）。返回 -vf 参数或 ''。"""
    w, h = info.get('width'), info.get('height')
    if not max_edge or not w or not h: return ''
    long_edge = max(w, h)
    if long_edge <= max_edge: return ''
    k = max_edge / float(long_edge)
    return 'scale=%d:%d' % (_even(round(w * k)), _even(round(h * k)))

def compress_out_path(src):
    """压缩产物固定写成 <stem>-web.mp4，放在同一个 media 目录里。"""
    return src.with_name(src.stem + '-web.mp4')

def web_preview_root(stem):
    """求一个文件名属于哪个「原始片」家族（用于把 Web 版本按片子归组）。

    压缩产物是 <原stem>-web.mp4；对产物再压一次 → <原stem>-web-web.mp4；
    历史上还用过 <原stem>-web-<preset>.mp4（如 -web-high100）。因此把结尾的
    `-web` 及其后随的 `-xxx` 段反复剥掉，剩下的就是最初的原始片名：
      showreel-web-web → showreel ； showreel-web-high100 → showreel ； FolioFold-1 → FolioFold-1
    ⚠ 必须按家族过滤：不同模板的媒体共用同一个 public/media/<kind>/ 目录
      （如 showreel/ 里同时有 示例用户 的 showreel.mp4 和 Folio Fold 的 FolioFold-1.mp4），
      只按「同目录」列举 Web 版本会把别的模板的压缩产物混进来。
    """
    s = stem
    while True:
        n = re.sub(r'-web(?:-[A-Za-z0-9]+)*$', '', s, flags=re.IGNORECASE)
        if n == s: break
        s = n
    return s

# —— Web Preview 版本清单：记录每一次压缩/生成的版本元数据（文件大小/分辨率/视频码率/音频码率/编码参数/转码耗时），
# 供编辑器里「选择 Web Preview 版本」展示。仅本地记录，不影响发布数据。
WEB_PREVIEW_MANIFEST = CONTENT / '_web_preview_manifest.json'

def record_web_preview(entry):
    """把一次压缩/生成的 Web Preview 版本元数据写进清单。

    key 用**相对 media 的路径**（如 showreel/showreel-web.mp4），不是裸文件名：
    不同模板的媒体共用 public/media/<kind>/，不同文件夹里完全可能有同名文件
    （showreel/showreel-web.mp4 与 ai-voices/showreel-web.mp4），用裸文件名做 key
    会让两个模板互相读到对方的「压缩参数/转码耗时」——又是一种模板间串显示。
    旧清单只有裸文件名 key，读取端仍会回退查旧键，向后兼容。"""
    try:
        data = {}
        if WEB_PREVIEW_MANIFEST.exists():
            try: data = json.loads(WEB_PREVIEW_MANIFEST.read_text(encoding='utf-8')) or {}
            except Exception: data = {}
        key = entry.get('rel') or entry['file']
        data[key] = entry
        WEB_PREVIEW_MANIFEST.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    except Exception:
        pass

def list_web_previews(url):
    """列出**与给定媒体同源**的所有 Web Preview 变体（<原stem>-web*.mp4），带实测元数据 + 清单补充（转码耗时/参数）。
    用于编辑器里让用户「选择 Web Preview 版本」——尤其当 70MB 与 100MB 都能生成时。
    ⚠ 只列同一支片子的产物：同目录里可能还躺着别的模板/别的片子的压缩产物（不同模板共用
      public/media/<kind>/），必须按家族名过滤，否则会出现「Folio Fold 的视频里列出 示例用户 的 showreel-web*」。"""
    src = media_abs_path(url)
    if not src: return {'ok': False, 'error': '找不到这个媒体文件，或它是外部链接。'}
    manifest = {}
    if WEB_PREVIEW_MANIFEST.exists():
        try: manifest = json.loads(WEB_PREVIEW_MANIFEST.read_text(encoding='utf-8')) or {}
        except Exception: manifest = {}
    root = web_preview_root(src.stem)
    variants = []
    for p in sorted(src.parent.glob('*-web*.mp4')):
        if not _WEB_PREVIEW_RE.search(p.stem): continue
        if web_preview_root(p.stem) != root: continue
        info = ff_probe_url('/media/' + p.relative_to(MEDIA).as_posix())
        if not info: continue
        rel = p.relative_to(MEDIA).as_posix()
        # 先按相对路径查（新格式），回退裸文件名（旧清单）——避免同名文件跨目录串元数据
        m = manifest.get(rel) or manifest.get(p.name) or {}
        variants.append({
            'name': p.name, 'url': '/' + ('media/' + p.relative_to(MEDIA).as_posix()),
            'mb': info['mb'], 'bytes': info['bytes'],
            'w': info.get('width'), 'h': info.get('height'),
            'vbr': info.get('vbr'), 'abr': info.get('abr'),
            'vcodec': info.get('vcodec'), 'acodec': info.get('acodec'),
            'overLimit': info['overLimit'], 'playable': info.get('playable'),
            'webPlayable': info.get('webPlayable'),
            'preset': m.get('preset'), 'params': m.get('params'), 'elapsed': m.get('elapsed'),
            'current': (src.resolve() == p.resolve()),
        })
    return {'ok': True, 'variants': variants, 'limitMB': format_mb(GH_REPO_MAX_BYTES, 0),
            'currentUrl': '/media/' + src.relative_to(MEDIA).as_posix()}

def _ffmpeg_encode_args(src, dst, preset, info, sample_from=None, sample_secs=None):
    cfg = COMPRESS_PRESETS.get(preset) or COMPRESS_PRESETS['balanced']
    args = ['-y']
    if sample_from is not None:
        args += ['-ss', str(sample_from)]
    args += ['-i', str(src)]
    if sample_secs:
        args += ['-t', str(sample_secs)]
    vf = compress_scale_filter(info, cfg['maxEdge'])
    if vf: args += ['-vf', vf]
    args += ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', str(cfg['crf']),
             '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-movflags', '+faststart']
    if info.get('acodec'):
        args += ['-c:a', 'aac', '-b:a', cfg['abr'], '-ac', '2']
    else:
        args += ['-an']
    return args + [str(dst)]

# 压缩任务状态（同一时刻只允许一个，避免把 CPU 全抢光）
# srcRel / outRel 是相对 public/media 的路径，前端据此拼出 /media/... 直接换引用。
# ⚠ 这是**进程级单例**：同时只跑一个压缩任务。因此必须记下它是**哪个模板**发起的，
#   否则切到另一个模板时，那边会读到别人的「正在压缩 xxx → yyy」进度 —— 和
#   public/media/<kind>/ 跨模板共享导致的串显示是同一类病。
_COMPRESS = {'running': False, 'percent': 0, 'stage': '', 'src': '', 'out': '',
             'srcRel': '', 'outRel': '', 'srcMB': 0, 'outMB': 0, 'error': '',
             'done': False, 'startedAt': 0, 'preset': '', 'elapsed': 0, 'cancelled': False,
             'tpl': ''}
_COMPRESS_LOCK = threading.Lock()

def _compress_progress(line, duration):
    m = re.search(r'time=(\d+):(\d\d):(\d\d(?:\.\d+)?)', line)
    if not m or not duration: return
    t = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
    _COMPRESS['percent'] = max(0, min(99, int(t / duration * 100)))

def compress_sample_plan(url, preset, points=(0.15, 0.5, 0.85), sample_secs=4):
    """试压：在全片 15% / 50% / 85% 各压 4 秒，量出真实码率再外推全片。
    返回的 mp4 可以直接在浏览器里播放 —— 用户要的「看到压缩后的画质」就靠它，
    不用等整片压完（整片要一两分钟到几分钟）。

    ⚠ 为什么必须用三点、不能只取中段一小段：
    实测同一支 showreel，只取中间 10 秒外推得到 116 MB，整片压完实际只有 70 MB ——
    因为中段恰好是全片画面最复杂的段落。单点取样会系统性高估 60% 以上，
    把本来合适的档位误判成"仍然超限"。多点取样把这个误差压到可接受范围。"""
    info = ff_probe_url(url)
    if not info: return {'ok': False, 'error': '找不到这个媒体文件，或它是外部链接。'}
    if not ffmpeg_path():
        return {'ok': False, 'error': '压缩需要 ffmpeg 组件，本机还没装。点「下载压缩组件」自动装好。',
                'needFfmpeg': True}
    src = Path(info['path'])
    dur = info.get('duration') or 0
    tmp = MEDIA / 'tmp'
    tmp.mkdir(parents=True, exist_ok=True)
    parts, err_tail = [], ''
    for k, frac in enumerate(points):
        if dur:
            start = max(0.0, min(dur - sample_secs, dur * frac))
        else:
            start = 0.0
        out = tmp / ('compress-sample-%s-%d.mp4' % (preset, k))
        rc, err = _ff_run(_ffmpeg_encode_args(src, out, preset, info, start, sample_secs), timeout=600)
        err_tail = (err or '').strip()
        if rc != 0 or not out.is_file():
            return {'ok': False, 'error': '试压失败：' + (err_tail.splitlines()[-1][:200] if err_tail else '未知原因')}
        parts.append(out)
    got = sum(p.stat().st_size for p in parts)
    total_secs = float(sample_secs * len(points))
    est = int((got / total_secs) * dur) if dur else 0
    cfg = COMPRESS_PRESETS.get(preset) or COMPRESS_PRESETS['balanced']
    vf = compress_scale_filter(info, cfg['maxEdge'])
    # 把三段拼成一支连续样片，方便直接播放判断画质（同参数同编码，-c copy 秒拼）
    merged = tmp / ('compress-sample-%s.mp4' % preset)
    try:
        lst = tmp / ('concat-%s.txt' % preset)
        lst.write_text(''.join("file '%s'\n" % p.as_posix() for p in parts), encoding='utf-8')
        _ff_run(['-f', 'concat', '-safe', '0', '-i', str(lst), '-c', 'copy', '-movflags', '+faststart', str(merged)], timeout=120)
    except Exception:
        merged = parts[0]
    for p in parts:
        try: p.unlink()
        except Exception: pass
    return {'ok': True, 'preset': preset, 'label': cfg['label'], 'note': cfg['note'],
            'sampleUrl': '/media/tmp/' + merged.name, 'sampleMB': format_mb(got, 2),
            'sampleSecs': int(total_secs),
            'estMB': format_mb(est) if est else None,
            'estFits': bool(est) and est <= GH_REPO_MAX_BYTES,
            'srcMB': info['mb'], 'limitMB': format_mb(GH_REPO_MAX_BYTES, 0),
            'scale': vf.replace('scale=', '') if vf else ('%sx%s' % (info.get('width'), info.get('height')))}

def compress_start(url, preset, tpl=''):
    """整片压缩，后台线程跑，进度写 _COMPRESS（并记录发起它的模板，供状态查询隔离）。"""
    info = ff_probe_url(url)
    if not info: return {'ok': False, 'error': '找不到这个媒体文件，或它是外部链接。'}
    if not ffmpeg_path():
        return {'ok': False, 'error': '压缩需要 ffmpeg 组件，本机还没装。', 'needFfmpeg': True}
    with _COMPRESS_LOCK:
        if _COMPRESS.get('running'): return {'ok': False, 'error': '已有一个压缩任务在跑，等它结束再开始。'}
        src = Path(info['path'])
        out = compress_out_path(src)
        _COMPRESS.update({'running': True, 'percent': 0, 'src': src.name, 'out': out.name,
                          'srcRel': src.relative_to(MEDIA).as_posix(),
                          'outRel': out.relative_to(MEDIA).as_posix(),
                          'srcMB': info['mb'], 'outMB': 0, 'error': '', 'done': False,
                          'startedAt': time.time(), 'preset': preset, 'elapsed': 0,
                          'cancelled': False, 'tpl': tpl or '',
                          'stage': '正在压缩 %s → %s' % (src.name, out.name)})

    def _worker():
        try:
            args = _ffmpeg_encode_args(src, out, preset, info)
            exe = ffmpeg_path()
            proc = subprocess.Popen([exe, '-hide_banner'] + args, stdout=subprocess.PIPE,
                                    stderr=subprocess.STDOUT,
                                    creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            buf = ''
            while True:
                ch = proc.stdout.read(1)
                if not ch:
                    break
                if ch in (b'\r', b'\n'):
                    if buf: _compress_progress(buf, info.get('duration'))
                    buf = ''
                else:
                    buf += ch.decode('utf-8', 'ignore')
                if _COMPRESS.get('cancelled'):
                    proc.kill(); break
            proc.wait()
            _COMPRESS['elapsed'] = round(time.time() - _COMPRESS['startedAt'], 1)
            if _COMPRESS.get('cancelled'):
                _COMPRESS['error'] = '已取消'
            elif proc.returncode != 0 or not out.is_file():
                _COMPRESS['error'] = '压缩失败（ffmpeg 退出码 %s）' % proc.returncode
            else:
                _COMPRESS['outMB'] = format_mb(out.stat().st_size)
                _COMPRESS['percent'] = 100
                # 记录这个 Web Preview 版本的元数据（文件大小/分辨率/码率/参数/耗时），供编辑器选择版本。
                try:
                    cfg = COMPRESS_PRESETS.get(preset) or COMPRESS_PRESETS['balanced']
                    i2 = ff_probe_url('/media/' + out.relative_to(MEDIA).as_posix()) or {}
                    record_web_preview({
                        'file': out.name, 'rel': out.relative_to(MEDIA).as_posix(), 'preset': preset,
                        'params': 'libx264 crf%s maxEdge%s abr%s' % (cfg['crf'], cfg['maxEdge'] or '原始', cfg['abr']),
                        'elapsed': _COMPRESS['elapsed'],
                        'mb': _COMPRESS['outMB'], 'w': i2.get('width'), 'h': i2.get('height'),
                        'vbr': i2.get('vbr'), 'abr': i2.get('abr'),
                    })
                except Exception:
                    pass
        except Exception as e:
            _COMPRESS['error'] = str(e)[:200]
        finally:
            _COMPRESS['running'] = False
            _COMPRESS['done'] = True
            _COMPRESS['stage'] = ''
    threading.Thread(target=_worker, daemon=True).start()
    return {'ok': True, 'out': compress_out_path(Path(info['path'])).name}

def normalize_project(project):
    p = dict(project or {})
    p['name'] = p.get('name', p.get('title', '')); p['date'] = p.get('date', p.get('period', ''))
    p['role'] = clean_text(p.get('role', '')); p['rawMaterial'] = clean_text(p.get('rawMaterial', ''))
    # —— Type 字段：公司不再是主展示字段，类型（原创短片/MV/电影片段...）是核心分类。company 仍保留供向后兼容。
    p['type'] = clean_text(p.get('type', p.get('company', '')))
    if p.get('company'): p['company'] = clean_text(p['company'])
    structured = dict(p.get('structuredContent') or {})
    structured['summary'] = clean_text(structured.get('summary', p.get('summary', p.get('description', ''))))
    structured['keyWork'] = list(structured.get('keyWork', p.get('keyWork', [])) or [])[:6]
    structured['highlights'] = list(structured.get('highlights', p.get('highlights', [])) or [])[:4]
    p['structuredContent'] = structured; p['summary'], p['keyWork'], p['highlights'] = structured['summary'], structured['keyWork'], structured['highlights']
    media = dict(p.get('media') or {})
    for old, new in [('image', 'mainVisual'), ('processImage', 'processImages'), ('video', 'video'), ('audio', 'audio')]:
        if old in p and new not in media: media[new] = p[old]
    main = save_data_image(media.get('mainVisual'), 'project-main')
    if main: media['mainVisual'] = main
    process = media.get('processImages') or []
    if not isinstance(process, list): process = [process]
    converted = [save_data_image(x, 'project-process') or x for x in process]
    media['processImages'] = [x for x in converted if isinstance(x, dict)]
    for key in ('video', 'audio', 'mainVisual'):
        if isinstance(media.get(key), str): media[key] = None if media[key].startswith('data:') else {'url': media[key], 'name': Path(media[key]).name, 'type': ''}
    media.setdefault('mainVisual', None); media.setdefault('video', None); media.setdefault('audio', None)
    media.setdefault('externalVideoUrl', p.get('externalVideoUrl', '')); media.setdefault('externalLink', p.get('externalLink', p.get('link', '')))
    media['video'] = prefer_playable_video(media.get('video'))
    p['media'] = media
    # 详细/简略展示开关：默认 undefined（前端按 true 处理），仅明确 false 才禁止展开
    if 'showDetails' in p: p['showDetails'] = bool(p['showDetails'])
    return p

# —— Phase 2：英文翻译 Draft 元数据（只支持 Project / Experience 的 summary）——
# localeKey 是内部稳定标识，不参与渲染，也绝不由名称/排序/原文派生。读取时可以临时补齐，
# 但只有显式 /api/save 才会把它写回对应模板的 portfolio.json。
LOCALE_STATUSES = {'unconfigured', 'draft', 'reviewed', 'stale', 'failed'}
TRANSLATION_UNAVAILABLE = '尚未配置翻译服务'

def ensure_locale_key(entity):
    key = entity.get('localeKey') if isinstance(entity, dict) else None
    if isinstance(key, str) and key.strip():
        return key.strip()
    key = str(uuid.uuid4())
    entity['localeKey'] = key
    return key

def summary_hash(value):
    """Hash the exact source string as UTF-8: do not trim or normalize newlines."""
    source = '' if value is None else (value if isinstance(value, str) else str(value))
    return 'sha256:' + hashlib.sha256(source.encode('utf-8')).hexdigest()

def _locale_summary_record(raw, current_hash):
    record = dict(raw) if isinstance(raw, dict) else {}
    record['sourceLanguage'] = str(record.get('sourceLanguage') or 'zh-CN')
    record['targetLanguage'] = str(record.get('targetLanguage') or 'en')
    record['draft'] = record.get('draft') if isinstance(record.get('draft'), str) else ''
    record['reviewed'] = record.get('reviewed') if isinstance(record.get('reviewed'), str) else ''
    record['error'] = record.get('error') if isinstance(record.get('error'), str) else ''
    status = record.get('status') if isinstance(record.get('status'), str) else ''
    if status not in LOCALE_STATUSES:
        status = 'stale' if (record['draft'] or record['reviewed']) else 'unconfigured'
    prior_hash = record.get('sourceHash') if isinstance(record.get('sourceHash'), str) else ''
    if status == 'unconfigured':
        record['sourceHash'] = current_hash
        record['error'] = record['error'] or TRANSLATION_UNAVAILABLE
    elif status in ('draft', 'reviewed', 'stale'):
        # Keep the historical hash and English evidence. A source mismatch is intentionally stale.
        if not prior_hash:
            prior_hash = current_hash
        record['sourceHash'] = prior_hash
        if prior_hash != current_hash:
            status = 'stale'
    else:  # failed: preserve the failure information and never invent an English result.
        record['sourceHash'] = prior_hash or current_hash
    record['status'] = status
    return record

def reconcile_localized_content(data, materialize=False):
    """Return data with safe, template-local summary translation metadata.

    materialize=False leaves legacy on-disk data untouched. materialize=True may add
    localeKey/records to the in-memory response; /api/save is the only path that persists them.
    """
    if not materialize:
        return data
    root = data.get('localizedContent') if isinstance(data.get('localizedContent'), dict) else {}
    root = dict(root)
    en = dict(root.get('en') or {})
    for kind, entities in (('projects', data.get('projects') or []), ('experience', data.get('experience') or [])):
        records = dict(en.get(kind) or {})
        for entity in entities:
            if not isinstance(entity, dict):
                continue
            key = ensure_locale_key(entity)
            structured = entity.get('structuredContent') if isinstance(entity.get('structuredContent'), dict) else {}
            source = structured.get('summary', '')
            container = dict(records.get(key) or {})
            container['summary'] = _locale_summary_record(container.get('summary'), summary_hash(source))
            records[key] = container
        en[kind] = records
    root['en'] = en
    data['localizedContent'] = root
    return data

def localized_summary_record(data, kind, locale_key):
    """Resolve a stable entity and its template-local English summary record."""
    if kind not in ('projects', 'experience'):
        return None, None
    for entity in (data.get(kind) or []):
        if isinstance(entity, dict) and entity.get('localeKey') == locale_key:
            root = data.setdefault('localizedContent', {})
            en = root.setdefault('en', {})
            records = en.setdefault(kind, {})
            record = records.setdefault(locale_key, {})
            summary = record.setdefault('summary', _locale_summary_record({}, summary_hash(
                (entity.get('structuredContent') or {}).get('summary', ''))))
            return entity, summary
    return None, None

# ————————————————————————————————————————————————————————————————
# 整篇翻译：作品集「用户自己写的内容」的多语言译文
#
# 背景（用户原话）：「我希望它的整体翻译是针对于作品集已经写的内容，然后直接就整体翻译，
# 不要再说文本编辑里一个去调，因为这样子的话很费时间，而且不是所有人都必须需要。」
#
# 所以这里不再要求用户逐个 Project / Experience 去生成 Draft，而是：
#   1. 按下面的白名单把整份 content 里的**用户文案**收成一个去重集合；
#   2. 一次交给本地 Ollama 批量翻译；
#   3. 落成 content/i18n.<lang>.json 里的 {中文原文: 译文} 平表；
#   4. 前台画布按「原文精确匹配」替换文本节点 —— 这样不用给每个渲染点都写一遍翻译逻辑。
#
# 两个刻意的设计：
#   · 用**白名单路径**而不是"排除黑名单"：content 里 url / 文件名 / localeKey / 主题 preset
#     这些一旦被翻掉就是真故障，白名单漏了一个字段最多是"这句还是中文"，代价小得多。
#   · 「不跟随语言」的板块（content.localePins，由文本编辑里点板块名设置）在这里就**不收**，
#     于是原文压根不在表里 → 画布上自然不会翻。不需要在渲染层到处判断开关。
# ————————————————————————————————————————————————————————————————
# ⚠ 2026-09-26（Phase 3）：3 → 9 种目标语言（源语言 zh-CN 不在此列）。
# 顺序即「语言设置」面板与状态接口的展示顺序；zh-TW 与 zh-CN 同源但按独立目标语言处理。
CONTENT_I18N_LANGS = ('en', 'zh-TW', 'ja', 'ko', 'fr', 'es', 'it', 'de', 'pt')

CONTENT_I18N_PATHS = (
    'profile.name', 'profile.role', 'profile.intro', 'profile.about',
    'profile.education[]', 'profile.skills[]', 'profile.highlights[]',
    'profile.contactLinks[].label', 'profile.contactLinks[].value',
    'profile.publicLinks[].label', 'profile.publicLinks[].value',
    'experience[].company', 'experience[].position', 'experience[].date', 'experience[].rawMaterial',
    # ⚠ 2026-09-22 补：数据模型里 highlights/summary/responsibilities **平铺**在 experience 项上，
    # 画布渲染读的也是平铺那份（DOM 上是 data-field=experience.0.highlights.2）。
    # 只收 structuredContent.* 会让「工作亮点」整列在英文模式下留中文 —— 实测踩过。
    'experience[].summary', 'experience[].highlights[]',
    'experience[].structuredContent.summary', 'experience[].structuredContent.highlights[]',
    'experience[].structuredContent.responsibilities[]',
    'projectGroups[].title', 'projectGroups[].description',
    'projects[].name', 'projects[].date', 'projects[].role', 'projects[].type', 'projects[].rawMaterial',
    'projects[].summary', 'projects[].keyWork[]', 'projects[].highlights[]',
    'projects[].structuredContent.summary', 'projects[].structuredContent.keyWork[]',
    'projects[].structuredContent.highlights[]',
    'showreel.projects[].name', 'showreel.projects[].role',
    'showreel.projects[].chapters[].title', 'showreel.projects[].chapters[].role',
    'chapter.showreel.chapters[].title', 'chapter.showreel.chapters[].role',
    'aiVoices.title', 'aiVoices.summary', 'aiVoices.sections.*',
    'aiVoices.projects[].name', 'aiVoices.projects[].role', 'aiVoices.projects[].summary',
    # ⚠ 2026-09-22 补：AI Project 卡片的「技术栈 / 亮点」也是平铺字段。
    'aiVoices.projects[].tech[]', 'aiVoices.projects[].highlights[]',
    'aiVoices.projects[].sections.*',
    # ⚠ 2026-09-26 AI Project 信息结构升级：项目定位 / 我的贡献（我的角色 = 既有 role，已在上面）。
    'aiVoices.projects[].positioning', 'aiVoices.projects[].contribution',
    'sectionTitles.*',
)

_CJK_RE = re.compile(r'[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]')

# —— 「用户原文语言是根本」（2026-09-23 用户明确要求）——
# 用户用中文界面操作，但某个字段他自己写的就是英文 / 日文（专有名词、技术名词、片名…），
# 那这一条**任何语言切换都不许动它**，包括"切回中文"也不许把它翻成中文。
#   · 翻英文时：只要这段文字里没有任何 CJK/假名/谚文，就说明它本来就是拉丁文字写的 → 不收。
#     （collect_translatable 里的 _CJK_RE 判断已经在做这件事。）
#   · 翻日文时：带平假名/片假名 → 本来就是日文 → 不收（纯汉字无法与中文区分，按中文处理）。
#   · 翻韩文时：带谚文 → 本来就是韩文 → 不收。
# 这样"翻译表"里永远不会出现用户原本就写下的外文原文，切语言时它自然保持原样。
_KANA_RE = re.compile(r'[\u3040-\u30ff]')
_HANGUL_RE = re.compile(r'[\uac00-\ud7af\u1100-\u11ff]')


def looks_native(text, lang):
    """这段文字是不是**已经用目标语言**写的？（是 → 不能当"中文原文"送去翻译）"""
    s = str(text or '')
    if not s:
        return True
    if lang == 'ja':
        return bool(_KANA_RE.search(s))
    if lang == 'ko':
        return bool(_HANGUL_RE.search(s))
    # 默认（英文等拉丁语言）：一个 CJK 字符都没有 → 本来就是目标语言写的
    return not _CJK_RE.search(s)



def _path_steps(pattern):
    """'projects[].name' -> ['projects', '[]', 'name']
    ⚠ 必须先滤掉空段：'projects[].name' 把 [] 换成 .@. 之后是 'projects.@..name'，
    直接 split 会多出一个空字符串段，匹配就永远走不到 name 上（曾经因此只收到 4 条文案）。"""
    return [('[]' if p == '@' else p)
            for p in pattern.replace('[]', '.@.').split('.') if p]


def _collect_at(node, steps, path, out):
    if not steps:
        if isinstance(node, str) and node.strip():
            out.append(('.'.join(path), node))
        return
    step, rest = steps[0], steps[1:]
    if step == '[]':
        if isinstance(node, list):
            for index, value in enumerate(node):
                _collect_at(value, rest, path + [str(index)], out)
        return
    if step == '*':
        if isinstance(node, dict):
            for key, value in node.items():
                _collect_at(value, rest, path + [str(key)], out)
        return
    if isinstance(node, dict) and step in node:
        _collect_at(node[step], rest, path + [step], out)


def collect_translatable(content, design=None, lang=None):
    """按白名单收出 [(数据路径, 中文原文)]，并跳过「不跟随语言」的板块。

    design 可选：模板级静态文案（Hero 眉标等）存在 design.staticText，
    路径写成 'staticText.<id>'，与文本编辑里「钉住」用的 pin key 一致 ——
    于是眉标也能被钉住（钉住 = 不收集 = 画布保持原文）。

    lang 可选：目标语言。给了就再排掉「本来就是目标语言写的」那些条
    （见 looks_native —— 用户自己写的英文/日文原文，任何语言切换都不许动）。"""
    pins = content.get('localePins') if isinstance(content, dict) else None
    pins = pins if isinstance(pins, dict) else {}
    pinned = {str(k) for k, v in pins.items() if v}

    def is_pinned(path):
        if path in pinned:
            return True
        # 列表字段是按整体 pin 的（editor 里点的是「技能（每行一项）」这个标题），
        # 所以 'profile.skills.0' 必须被 'profile.skills' 拦住。
        return any(path.startswith(p + '.') for p in pinned)

    found = []
    for pattern in CONTENT_I18N_PATHS:
        _collect_at(content, _path_steps(pattern), [], found)
    # 模板级静态文案（Hero 眉标等）：默认值是英文 'Selected works'（CJK 校验会自然跳过），
    # 只有用户改成中文时才会被收进来；钉住后不再收集 → 画布保持原文。
    if isinstance(design, dict):
        _st = design.get('staticText')
        if isinstance(_st, dict):
            for _k, _v in _st.items():
                if isinstance(_v, str) and _v.strip():
                    found.append(('staticText.' + str(_k), _v))
    out, seen = [], set()
    for path, value in found:
        if is_pinned(path):
            continue
        text = value.strip()
        if not _CJK_RE.search(text):     # 本来就是英文 / 数字 / 符号 → 没什么可翻的
            continue
        if lang and looks_native(text, lang):   # 用户就是用目标语言写的这行 → 不许动它
            continue
        if text in seen:
            continue
        seen.add(text)
        out.append((path, text))
    return out


def content_i18n_path(tpl_id, lang):
    return tpl_paths(tpl_id)['draft'].with_name('i18n.%s.json' % lang)


def translation_mode(content):
    """翻译质量模式（2026-09-26，用户可选、存 content.settings.translationMode）：
      · 'review'（默认）发布前审核 —— 机翻结果要等创作者**确认**后才会进入正式 Canvas / 发布；
      · 'direct'        机器翻译直接使用 —— 生成后即可用于作品集与发布，无需逐条确认。
    这是通用产品机制（任何用户 / 作品 / 目标语言同一流程），不含任何项目专用判断。"""
    v = ''
    if isinstance(content, dict):
        s = content.get('settings')
        if isinstance(s, dict):
            v = str(s.get('translationMode') or '').strip().lower()
    return 'direct' if v in ('direct', 'auto', 'machine') else 'review'


def read_content_i18n(tpl_id, lang, require_reviewed=False):
    """读某个模板某语言的内容译文表（{中文原文: 译文}）。

    require_reviewed=True（画布 / 发布内联的语义）：只返回**已通过审核**的表。
    机翻生成的新表 reviewed=false —— 未审核的译文绝不能进入最终 Canvas / 发布内容
    （Phase 3 门控，2026-09-26）。创作端预览用 ?draft=1 显式绕过。
    """
    path = content_i18n_path(tpl_id, lang)
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
        if not isinstance(data, dict):
            return {}
        if require_reviewed and data.get('reviewed') is not True:
            return {}
        table = data.get('map') if isinstance(data.get('map'), dict) else None
        if not isinstance(table, dict):
            return {}
        # ⚠ 出口再拦一道：译文表里**不允许**存在「键本来就是目标语言」的条目。
        # 老版本可能把用户写的英文/日文原文也收进去翻过一遍，那种条目会让用户自己
        # 写下的专业名词在切语言时被替换掉。这里直接丢掉，等于永远按用户原文显示。
        return {k: v for k, v in table.items() if isinstance(v, str) and not looks_native(k, lang)}
    except Exception:
        return {}


def normalize(data, materialize_localization=False):
    d = dict(data or {}); p = dict(d.get('profile') or {}); p['contact'] = dict(p.get('contact') or {})
    for key in ('name', 'role', 'intro', 'about'): p[key] = clean_text(p.get(key, ''))
    for key in ('education', 'skills', 'highlights'): p.setdefault(key, [])
    # —— Contact/Links：独立模块。contactLinks 是 [{label,value}]，兼容旧 contact 对象 ——
    links = p.get('contactLinks')
    if not isinstance(links, list):
        links = []
    links = [{'label': clean_text(x.get('label', '')), 'value': clean_text(x.get('value', ''))} for x in links if isinstance(x, dict)]
    links = [x for x in links if x['label'] or x['value']]
    p['contactLinks'] = links
    # —— Links：2026-09-24 起与 Contact 拆开。publicLinks 是「公开链接」（点击跳转），
    # 与 contactLinks（联系方式，点击复制）属性不同，故分开存、分开渲染。同样兼容非 list 的脏数据。
    plinks = p.get('publicLinks')
    if not isinstance(plinks, list):
        plinks = []
    plinks = [{'label': clean_text(x.get('label', '')), 'value': clean_text(x.get('value', ''))} for x in plinks if isinstance(x, dict)]
    plinks = [x for x in plinks if x['label'] or x['value']]
    p['publicLinks'] = plinks
    d['profile'] = p; d['projectGroups'] = list(d.get('projectGroups') or DEFAULT_GROUPS)
    projects = [normalize_project(x) for x in list(d.get('projects') or [])]; names = {x['name'] for x in projects}
    # 早期迁移曾把旧项目兜底补回，但用户一旦主动删掉某项目，
    # 这里会反复把它加回来（「删了又出现」）。现在数据已是用户精心整理过的真实列表，
    # 不再兜底补回任何默认项目 —— 删除操作必须真正持久化。
    d['projects'] = projects;     d['experience'] = list(d.get('experience') or [])
    for x in d['experience']:
        x['rawMaterial'] = clean_text(x.get('rawMaterial', ''))
        x['structuredContent'] = dict(x.get('structuredContent') or {'summary': x.get('summary', x.get('detail', '')), 'responsibilities': x.get('responsibilities', []), 'highlights': x.get('highlights', [])})
        sc = x['structuredContent']
        x['summary'] = sc.get('summary', '')
        x['responsibilities'] = list(sc.get('responsibilities', x.get('responsibilities', [])) or [])
        x['highlights'] = list(sc.get('highlights', x.get('highlights', [])) or [])
        # keyWork 作为 responsibilities 的别名，保持前端读取兼容
        if x.get('keyWork') and not x['responsibilities']:
            x['responsibilities'] = list(x['keyWork'])
        # —— 把原 responsibilities 合并到 highlights（避免 FolioFold 丢失 Key Work 语义）——
        # 仅当 highlights 中还没有对应条目（简单去重）时合并
        merged = list(x['highlights'])
        for k in x.get('responsibilities') or []:
            if not k: continue
            kk = re.sub(r'\s+', '', str(k))
            if not any(re.sub(r'\s+', '', str(h)) == kk for h in merged):
                merged.append(str(k))
        x['highlights'] = merged
        x['responsibilities'] = []  # FolioFold 不再显示 Key Work 字段，置空避免被误用
    show = dict(d.get('showreel') or {})
    if isinstance(show.get('media'), str): show['media'] = {'url': show['media'], 'name': Path(show['media']).name, 'type': ''}
    # —— Showreel 多项目结构（v2）：showreel.projects = [{id,name,role,media,externalVideoUrl,chapters}] ——
    # 旧结构（顶层 media/externalVideoUrl/chapters）自动迁移为 projects[0]，数据不丢失。
    legacy_chapters = show.get('chapters') if isinstance(show.get('chapters'), list) else []
    if not isinstance(show.get('projects'), list):
        legacy_media = show.get('media')
        legacy_ext = show.get('externalVideoUrl') or ''
        show['projects'] = []
        if legacy_media or legacy_ext or legacy_chapters:
            show['projects'].append({
                'id': 'sr_main', 'name': show.get('name') or 'Showreel 01', 'role': show.get('role') or '',
                'media': legacy_media, 'externalVideoUrl': legacy_ext, 'chapters': legacy_chapters,
            })
    # A pre-v2 editor may have saved chapters at the former top-level path while
    # current Showreel projects already exist. Preserve that content by moving it
    # into the first existing reel instead of silently discarding it during the
    # v2 cleanup below. Native project chapters always keep their order/timing.
    elif legacy_chapters and show['projects']:
        first_project = show['projects'][0]
        if isinstance(first_project, dict):
            first_project = dict(first_project)
            first_project['chapters'] = list(first_project.get('chapters') or []) + legacy_chapters
            show['projects'][0] = first_project
    norm_projects = []
    for idx, sp in enumerate(show['projects']):
        if not isinstance(sp, dict): continue
        sp = dict(sp)
        sp.setdefault('id', 'sr_%d' % (idx + 1))
        sp.setdefault('name', 'Showreel 项目 %02d' % (idx + 1))
        sp.setdefault('role', '')
        if isinstance(sp.get('media'), str):
            sp['media'] = {'url': sp['media'], 'name': Path(sp['media']).name, 'type': ''}
        sp.setdefault('media', None); sp.setdefault('externalVideoUrl', '')
        sp.setdefault('chapters', [] if not isinstance(sp.get('chapters'), list) else sp['chapters'])
        for c in sp['chapters']:
            if isinstance(c, dict):
                c.setdefault('projectId', None); c.setdefault('title', ''); c.setdefault('role', '')
                c.setdefault('start', '00:00:00.000'); c.setdefault('end', '00:00:00.000')
        # Showreel 项目视频：H.264 封装的 .mov 在 Chromium/Edge 能直接播，故不再强制改写。
        # 仅当存在「同名 .mp4」时才优先用更兼容的 mp4（ProRes 这类编码浏览器解不了，交给前端试播+明确提示）。
        m = sp.get('media')
        if isinstance(m, dict) and str(m.get('url', '')).lower().endswith('.mov'):
            mp4_url = m['url'][:-4] + '.mp4'
            if (MEDIA / 'showreel' / Path(mp4_url).name).exists():
                sp['media'] = dict(m); sp['media']['url'] = mp4_url
                sp['media']['name'] = Path(mp4_url).name; sp['media']['type'] = 'video/mp4'
        norm_projects.append(sp)
    show['projects'] = norm_projects
    # 旧顶层字段清理（已迁移进 projects，避免双份渲染）
    for k in ('media', 'externalVideoUrl', 'chapters', 'name', 'role'):
        show.pop(k, None)
    d['showreel'] = show
    d['aiVoices'] = dict(d.get('aiVoices') or {}); d['aiVoices'].setdefault('sections', {}); d['aiVoices'].setdefault('media', {})
    d['styles'] = dict(d.get('styles') or {}); d['styles'].setdefault('text', '#161616'); d['styles'].setdefault('background', '#f1eee7'); d['styles'].setdefault('accent', '#e64e2e')
    # —— Theme Preset：mode + preset —— 默认 light-01，preset 必须是合法 ID
    # ⚠ 2026-09-25：这张白名单必须与 `editor/themes.js` 的 `THEME_PRESETS` 同步。
    #   不同步的后果很隐蔽：模板里用了新主题（如 light-04），normalize 时不认识它
    #   → **静默回落成 light-01**，用户看到的是「导入后主题没了」，而不是报错。
    THEME_VALID_IDS = ('light-01', 'light-02', 'light-03', 'light-04',
                       'dark-01', 'dark-02', 'dark-03', 'dark-04')
    theme = dict(d.get('theme') or {})
    preset = theme.get('preset') if theme.get('preset') in THEME_VALID_IDS else 'light-01'
    d['theme'] = {'mode': 'dark' if str(preset).startswith('dark') else 'light', 'preset': preset}
    d['media'] = dict(d.get('media') or {}); d['settings'] = dict(d.get('settings') or {'version': 3})
    # 用户可直改的区块大标题覆盖表：{about:'About', works:'…', ...}，缺省回落到 SECTION_DEFS 默认标题
    d['sectionTitles'] = dict(d.get('sectionTitles') or {})
    # 已审核的 Section 英文显示名：只作英文展示层，不改 stable id 或原始显示名称。
    _stt = d.get('sectionTitleTranslations')
    _en = _stt.get('en') if isinstance(_stt, dict) else {}
    d['sectionTitleTranslations'] = {'en': {str(k): str(v).strip() for k, v in (_en or {}).items()
                                          if isinstance(k, str) and isinstance(v, str) and v.strip()}}
    # 区块级 Logo 点缀图（2026-09-19）：{<sectionId>: {url, pos:'before'|'after'}}。
    # key 就是区块 id（about/experience/works/showreel/aiVoices/用户新增板块），
    # 因为"一个作品集可能只有三大区、不再细分项目，但也想放大图"，所以必须按区块存。
    # 逐项清洗：url 必须是非空字符串，pos 只接受 before/after，非法项直接丢弃（不污染数据）。
    _slogos = {}
    # ⚠ normalize 是保存链路的闸门：脏值绝不能让它抛异常（否则整次保存 500、草稿丢）。
    # 所以先确认外层是 dict，否则直接当空处理。
    _slogos_raw = d.get('sectionLogos')
    if not isinstance(_slogos_raw, dict):
        _slogos_raw = {}
    for _k, _v in _slogos_raw.items():
        if not isinstance(_k, str) or not _k.strip():
            continue
        if isinstance(_v, str):
            _u, _p = _v.strip(), 'after'
        elif isinstance(_v, dict):
            _u = str(_v.get('url') or _v.get('src') or '').strip()
            _p = 'before' if _v.get('pos') == 'before' else 'after'
        else:
            continue
        if _u:
            _slogos[_k.strip()] = {'url': _u, 'pos': _p}
    d['sectionLogos'] = _slogos
    # —— 设计数据边界（预留）：content data 之外，独立保存 design data 与 visual editor project data。
    # 这些字段本阶段只做占位与兼容，不影响现有 portfolio.json 的读取与写入。
    # design data：GrapesJS 未来保存的视觉设计（theme/typography/spacing/layout/组件配置）
    d['design'] = dict(d.get('design') or {})
    d['design'].setdefault('theme', d['theme'])
    d['design'].setdefault('typography', dict(d.get('styles') or {}))
    d['design'].setdefault('layout', {})
    d['design'].setdefault('components', {})
    # —— Schema 版本：为未来数据结构升级提供 normalize 依据 ——
    d['schemaVersion'] = d.get('schemaVersion', SCHEMA_VERSION)
    # visual editor project data：GrapesJS 项目快照（HTML/CSS/样式），与 content 解耦
    d['visualEditor'] = dict(d.get('visualEditor') or {})
    d['visualEditor'].setdefault('project', None)
    d['visualEditor'].setdefault('savedAt', None)
    # Resume 由文本编辑上传并写入 data.resume = {url, name, allowDownload}，不再自动探测 public/resume.pdf。
    # 旧逻辑会在 public/resume.pdf 存在时强行覆盖 data.resume，导致「未上传则不显示」与「允许下载开关」失效，已移除。
    return reconcile_localized_content(d, materialize_localization)

from ai_organizer import parse_with_ai, parse_category

class Handler(SimpleHTTPRequestHandler):
    def translate_path(self, path):
        path = unquote(urlparse(path).path)
        return str(MEDIA / path[len('/media/'):] if path.startswith('/media/') else ROOT / path.lstrip('/'))
    def json(self, value, status=200):
        raw = json.dumps(value, ensure_ascii=False).encode(); self.send_response(status); self.send_header('Content-Type', 'application/json; charset=utf-8'); self.send_header('Cache-Control', 'no-store'); self.send_header('Content-Length', str(len(raw))); self.end_headers(); self.wfile.write(raw)
    def tpl_qs(self):
        """原样取出 URL 上的 tpl（不校验），用于重定向时原样带过去。"""
        return str((parse_qs(urlparse(self.path).query).get('tpl', ['']) or [''])[0] or '').strip()
    def _tpl(self):
        """取出并校验模板 id；非法或不存在一律回落到模板一，避免路径穿越 / 幽灵目录。"""
        raw = self.tpl_qs()
        if not raw or raw == LEGACY_TPL_ID or not TPL_ID_RE.match(raw):
            return LEGACY_TPL_ID
        return raw if tpl_exists(raw) else LEGACY_TPL_ID
    def _tpl_strict(self):
        """**写操作专用**：模板 id 显式给了但不存在 → 报错，绝不静默回落到模板一。

        ⚠ 2026-09-20 二次事故的根因之一（务必保留本方法）：
        原 `_tpl()` 对"不存在的模板 id"一律回落到 `main`。
        于是任何带着 `?tpl=<还没建出来的 id>` 的**保存请求都会写进 main 的真实数据**。
        当时一个测试脚本以为自己在往一个临时模板里写，实际把模板一的草稿清空了。

        读操作（GET /api/data 等）保持回落到 main 的宽容行为 —— 用户点了个失效链接
        不该看到 500，看到模板一内容是更合理的降级。
        但**写操作**绝不能这样：写错地方 = 静默丢数据，必须让调用方立刻知道。
        """
        raw = self.tpl_qs()
        if not raw or raw == LEGACY_TPL_ID or not TPL_ID_RE.match(raw):
            return LEGACY_TPL_ID
        if not tpl_exists(raw):
            return None      # 调用方据此返回 404，绝不写盘
        return raw
    def _export_template(self):
        # 导出模板：只含 Design / 版式（design.json），不含任何个人内容，也不含媒体本体。
        # 来源刻意不读 portfolio.json —— 那里全是个人信息，一行都不该进模板。
        tpl_id = self._tpl()
        template = build_template(tpl_id)
        raw = json.dumps(template, ensure_ascii=False, indent=2).encode('utf-8')
        fname = 'folioframe-template-' + (tpl_id or LEGACY_TPL_ID) + '.json'
        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Disposition', 'attachment; filename="' + fname + '"')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers(); self.wfile.write(raw)
    def _export_html(self):
        # 导出单文件 HTML：内联 published 数据 + Design + 内联 CSS + 内联 JS，可脱离服务器打开
        _p = tpl_paths(self._tpl())
        d = normalize(read(_p['published'] if _p['published'].exists() else _p['draft']))
        design = with_section_order(read(_p['designPublished']) or {}, read(_p['published']) or {})
        try:
            css = (ROOT / 'styles.css').read_text(encoding='utf-8') + '\n' + (ROOT / 'public-v2.css').read_text(encoding='utf-8') + '\n' + (ROOT / 'i18n.css').read_text(encoding='utf-8')
        except Exception:
            css = ''
        try:
            js = _public_app_js()
        except Exception:
            js = ''
        try:
            i18n_js = (ROOT / 'i18n.js').read_text(encoding='utf-8')
        except Exception:
            i18n_js = ''
        # 与 build_public_bundle 同口径（⑥）：单文件导出也要带上界面字典与内容译文表，
        # 否则导出的 HTML 语言切换同样形同虚设。
        try:
            i18n_dict_js = (ROOT / 'i18n-zh-en.js').read_text(encoding='utf-8')
        except Exception:
            i18n_dict_js = ''
        _tpl_id = self._tpl()
        _ci18n = {}
        _exp_mode = translation_mode(d)
        for _lang in CONTENT_I18N_LANGS:
            # Phase 3 门控：默认导出/预览只带已审核译文表；模式 'direct' 下机翻直接可用。
            _m = read_content_i18n(_tpl_id, _lang, require_reviewed=_exp_mode != 'direct')
            if _m:
                _ci18n[_lang] = _m
        _ci18n_json = json.dumps(_ci18n, ensure_ascii=False).replace('</', '<\\/')
        data_json = json.dumps(d, ensure_ascii=False).replace('"/media/', '"media/').replace("'/media/", "'media/")
        design_json = json.dumps(design, ensure_ascii=False).replace('"/media/', '"media/').replace("'/media/", "'media/")
        html = (
            '<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="UTF-8" />\n'
            '<meta name="viewport" content="width=device-width, initial-scale=1.0" />\n'
            '<title>' + str(d.get('profile', {}).get('name', 'FolioFold')) + ' — FolioFold</title>\n'
            '<style>\n' + css + '\n</style>\n'
            '</head>\n<body>\n<noscript>请启用 JavaScript 以浏览作品集。</noscript>\n<main id="app"></main>\n'
            '<script>window.__PUBLIC_VIEWER__=true;window.__PORTFOLIO_DATA__ = ' + data_json + ';'
            'window.__PORTFOLIO_DESIGN__ = ' + design_json + ';</script>\n'
            '<script>' + i18n_js + '</script>\n'
            '<script>' + i18n_dict_js + '</script>\n'
            '<script>window.__FF_STATIC_BUILD__=true;window.FF_CONTENT_I18N=' + _ci18n_json + ';</script>\n'
            '<script type="module">\n' + js + '\n</script>\n</body>\n</html>'
        )
        raw = html.encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Disposition', 'attachment; filename="portfolio.html"')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers(); self.wfile.write(raw)
    def _export_zip(self):
        """导出完整静态站点 ZIP（离线可用、可直接上传到任意静态托管）。

        关键设计：
          - **复用 build_public_bundle**：与「发布到 GitHub」走同一条打包链路，
            所以导出的东西 = 真正会发布的东西，不会出现"导出能看、发布不一样"。
          - 打包在临时目录里做，结束后清理，不污染项目目录。
          - **绝不含任何密钥**：只写入 index.html / 404.html / .nojekyll / media/ /
            manifest + README；凭证文件（github.json / cloudbase.json）从不参与打包。
          - 大媒体（超过阈值）默认不复制进 ZIP（避免几百 MB 的包），但**在 manifest
            和 README 里明确列出**，并给出可操作的说明 —— 不静默丢文件。
        """
        # include=all：连超阈值大媒体也一起打包（真·离线副本）。默认不这么做。
        include_all = str(parse_qs(urlparse(self.path).query).get('include', [''])[0]).strip().lower() in ('all', '1', 'true')
        tpl = self._tpl()
        _p = tpl_paths(tpl)
        pub = normalize(read(_p['published']) if _p['published'].exists() else read(_p['draft']))
        design = with_section_order(read(_p['designPublished']) or {}, read(_p['published']) or {})
        tmp = Path(tempfile.mkdtemp(prefix='_zip_', dir=DEPLOY_DIR))
        try:
            # ⚠ 必须真的把阈值传给 build_public_bundle，否则大媒体照样被复制进临时目录、
            # 最后原样进了 ZIP —— 清单里写着"已跳过"而文件其实在包里，等于骗自己。
            info = build_public_bundle(tmp, tpl,
                                       max_commit_bytes=(None if include_all else LARGE_MEDIA_SKIP_BYTES))
            large_rel = set(info.get('largeMedia') or [])
            refs = collect_media_refs(pub, design)
            included, skipped_large, missing_src, oversized = [], [], [], []
            for ref in refs:
                rel = ref[len('/media/'):]
                src = MEDIA / rel
                if not src.exists():
                    missing_src.append(ref); continue
                size = src.stat().st_size
                if rel in large_rel or (not include_all and size >= LARGE_MEDIA_SKIP_BYTES):
                    skipped_large.append({'path': ref, 'mb': format_mb(size)})
                else:
                    included.append(ref)
                    # 虽然打进来了，但超过国内平台常见的单文件上限（25MB），必须提前说清楚，
                    # 免得用户拖到 EdgeOne / 其他平台上才发现传不上去。
                    if size >= LARGE_MEDIA_WARN_BYTES:
                        oversized.append({'path': ref, 'mb': format_mb(size)})
            manifest = {
                'generator': 'FolioFold',
                'exportedAt': now_iso(),
                'tpl': tpl,
                'profile': {'name': (pub.get('profile') or {}).get('name') or '',
                            'role': (pub.get('profile') or {}).get('role') or ''},
                'files': info.get('files'),
                'mediaIncluded': included,
                'mediaSkippedTooLarge': skipped_large,
                'mediaOversizedForSomeHosts': oversized,
                'mediaMissing': missing_src,
                'externalVideoUrls': [v for v in _collect_external_video_urls(pub) if v],
                'includeAll': bool(include_all),
                'skipThresholdMB': None if include_all else format_mb(LARGE_MEDIA_SKIP_BYTES),
                'note': '此包为纯静态站点，不依赖 FolioFold 本地服务。双击 index.html 即可离线浏览。',
            }
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
                for f in sorted(tmp.rglob('*')):
                    if f.is_file():
                        zf.write(f, f.relative_to(tmp).as_posix())
                zf.writestr('folioframe-export.json', json.dumps(manifest, ensure_ascii=False, indent=2))
                zf.writestr('README.txt', _export_readme(manifest))
            raw = buf.getvalue()
        finally:
            _rmtree_forgiving(tmp)
        name = (pub.get('profile') or {}).get('name') or 'folioframe'
        fname = 'folioframe-site-%s.zip' % re.sub(r'[^A-Za-z0-9_-]', '', str(name))[:24]
        self.send_response(200)
        self.send_header('Content-Type', 'application/zip')
        self.send_header('Content-Disposition', 'attachment; filename="%s"' % (fname or 'folioframe-site.zip'))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('X-FolioFold-Media-Included', str(len(manifest['mediaIncluded'])))
        self.send_header('X-FolioFold-Media-Skipped', str(len(skipped_large)))
        self.end_headers(); self.wfile.write(raw)
        pub_log('导出 ZIP：%s（媒体 %d 个已包含，%d 个过大已跳过，%d 个缺失）'
                % (fname, len(included), len(skipped_large), len(missing_src)))
    def _handle_shutdown(self):
        # 本机-only 停止端点（产品化阶段新增）：服务只绑定 127.0.0.1，外部不可达；
        # 再加一层来源校验双保险。仅停 FolioFold 自己的 server，不影响其他项目，停后释放 3000。
        peer = self.client_address[0]
        if peer not in ('127.0.0.1', '::1', '::ffff:127.0.0.1'):
            return self.json({'error': 'forbidden'}, 403)
        self.json({'ok': True, 'shutting_down': True})
        # 先把响应刷出去，再在独立线程里停 serve_forever，避免阻塞当前 handler 导致响应发不出。
        try:
            self.wfile.flush()
        except Exception:
            pass
        def _stop():
            time.sleep(0.3)
            try:
                self.server.shutdown()
                self.server.server_close()
            except Exception:
                pass
        threading.Thread(target=_stop, daemon=True).start()
    def do_GET(self):
        parsed = urlparse(self.path)
        tpl = self._tpl()
        tp = tpl_paths(tpl)
        if parsed.path == '/api/templates':
            # 模板列表（统一 Studio 外壳的模板选择器用它）
            data = load_templates()
            return self.json({'ok': True, 'tpl': tpl, 'items': data['items']})
        if parsed.path == '/api/data':
            mode = parse_qs(parsed.query).get('mode', ['draft'])[0]
            p = tp['published'] if mode == 'published' else tp['draft']
            # Migration is visible to the editor immediately, but GET remains strictly read-only.
            return self.json(normalize(read(p), materialize_localization=True))
        if parsed.path == '/api/translation/status':
            # Provider configuration is local-only and deliberately excludes
            # credentials. Reading status does not create configuration files.
            status = translation_provider_status(DEPLOY_DIR).as_dict()
            return self.json({'ok': True, 'tpl': tpl, **status})
        if parsed.path == '/api/i18n/content':
            # 画布用：拿某个语言的「用户内容译文表」（{中文原文: 译文}）。
            # 没有译文时返回空表 —— 前台会照原文显示（不造假）。
            lang = (parse_qs(parsed.query).get('lang', ['']) or [''])[0].strip()
            if lang not in CONTENT_I18N_LANGS:
                return self.json({'ok': False, 'error': '不支持的语言：%s' % (lang or '(空)')}, 400)
            # Phase 3 门控：画布默认只拿**已审核**译文；创作端预览用 &draft=1 绕过。
            # 2026-09-26：模式 'direct'（机器翻译直接使用）下不要求已确认 —— 门控结构不变。
            draft = (parse_qs(parsed.query).get('draft', ['']) or [''])[0].strip() in ('1', 'true')
            _mode = translation_mode(read(tp['draft']))
            table = read_content_i18n(tpl, lang, require_reviewed=(not draft) and _mode != 'direct')
            return self.json({'ok': True, 'tpl': tpl, 'lang': lang, 'mode': _mode, 'count': len(table),
                              'reviewedOnly': (not draft) and _mode != 'direct', 'map': table})
        if parsed.path == '/api/i18n/content/status':
            # 文本编辑 →「设置 → 语言设置」用：每个语言有没有译文、多少条、什么时候生成的。
            # 2026-09-26：同时给 mode / stale（原文改过 → 旧译文「需要重新检查」）。
            content = read(tp['draft']) or {}
            try:
                content = normalize(content)
            except Exception:
                content = {}
            mode = translation_mode(content)
            pending = collect_translatable(content, read(tp['design']))
            langs = {}
            for lang in CONTENT_I18N_LANGS:
                table = read_content_i18n(tpl, lang)
                generated = ''
                reviewed = False
                stored_hash = ''
                try:
                    meta = json.loads(content_i18n_path(tpl, lang).read_text(encoding='utf-8'))
                    generated = str(meta.get('generatedAt') or '')
                    reviewed = meta.get('reviewed') is True
                    stored_hash = str(meta.get('sourceHash') or '')
                except Exception:
                    pass
                pairs_lang = collect_translatable(content, read(tp['design']), lang)
                current_hash = summary_hash(json.dumps([[pth, txt] for pth, txt in pairs_lang],
                                                        ensure_ascii=False)) if pairs_lang else ''
                # stale：译文生成时的原文清单 hash 与当前不一致 → 提示「需要重新检查」。
                # 绝不因此删除或隐藏旧译文（保留作回退来源），正式展示仍遵循当前模式。
                stale = bool(stored_hash and current_hash and stored_hash != current_hash)
                langs[lang] = {'count': len(table), 'generatedAt': generated, 'reviewed': reviewed,
                               'stale': stale, 'sourceHash': current_hash,
                               'pending': len(pairs_lang)}
            pins = content.get('localePins') if isinstance(content, dict) else {}
            pins = pins if isinstance(pins, dict) else {}
            return self.json({'ok': True, 'tpl': tpl, 'mode': mode, 'langs': langs,
                              'pending': len(pending),
                              'pinned': sorted(str(k) for k, v in pins.items() if v)})
        if parsed.path == '/api/previous': return self.json(normalize(read(tp['previous'])))
        # design 里若还没有 sectionOrder，用 content 里的旧顺序兜底后再返回
        # （区块顺序已归 Template，但老草稿存在 content.sections 里，这一步保证前台永远读到一份有顺序的 design）
        if parsed.path == '/api/design':
            return self.json(with_section_order(read(tp['design']) or {}, read(tp['draft']) or {}))
        if parsed.path == '/api/publish/status':
            # 草稿 vs 已发布：内容 + 设计 任一不同就算"有未发布的改动"。
            # 注意：这里必须和 _version_sig() 的口径一致（sectionOrder 归 Template，
            # 老草稿存在 content.sections 里，不能因此判成"内容有改动"）。
            try:
                content_dirty = content_sig(tp['draft']) != content_sig(tp['published'])
                # 排版对比要「已经把 sectionOrder 补出来」的口径：design_sig() 内部就是这么做的，
                # 而 designPublished 是文件路径，用 design_file_sig() 保持同一套去元数据规则。
                design_dirty = design_sig(tpl) != design_file_sig(tp['designPublished'])
                detail = []
                if content_dirty: detail.append('内容（文字/项目/章节）')
                if design_dirty: detail.append('排版（布局/主题）')
                return self.json({'ok': True, 'tpl': tpl, 'dirty': content_dirty or design_dirty,
                                  'contentDirty': content_dirty, 'designDirty': design_dirty,
                                  'detail': '、'.join(detail) + ' 有改动' if detail else ''})
            except Exception as e:
                return self.json({'ok': False, 'error': str(e)[:120]}, 500)
        if parsed.path == '/api/design/published':
            return self.json(with_section_order(read(tp['designPublished']) or {}, read(tp['published']) or {}))
        if parsed.path == '/api/design/previous': return self.json(read(tp['designPrevious']))
        # —— 视频压缩：媒体体检 / 试压 / 进度 / 组件自检 ——
        if parsed.path == '/api/media/probe':
            url = parse_qs(parsed.query).get('url', [''])[0]
            info = ff_probe_url(url)
            if not info:
                return self.json({'ok': False, 'error': '读不到这个媒体文件（可能是外部链接或文件已删除）'})
            # 已经压过一次的话，把产物告诉前端：用户可以直接复用，不必再压两分钟
            existing = ''
            try:
                cand = compress_out_path(Path(info['path']))
                if cand.is_file() and '-web' in cand.stem:
                    existing = media_ref(cand, 'video/mp4')
                    existing['mb'] = format_mb(cand.stat().st_size)
            except Exception:
                pass
            return self.json({'ok': True, 'info': info, 'warn': media_publish_warning(info),
                              'ffmpeg': bool(ffmpeg_path()), 'existing': existing,
                              'limitMB': format_mb(GH_REPO_MAX_BYTES, 0),
                              'presets': [{'id': k, 'label': v['label'], 'note': v['note']}
                                          for k, v in COMPRESS_PRESETS.items()]})
        if parsed.path == '/api/media/compress/status':
            st = dict(_COMPRESS)
            # 跨模板隔离：正在跑的任务属于别的模板时，绝不把它的进度/产物当成当前模板的。
            # 直接按"失败"返回（带说明），这样前端不会把别人的输出文件写进当前模板的数据里。
            want_tpl = self.tpl_qs() or ''
            if want_tpl and st.get('tpl') and st.get('tpl') != want_tpl and st.get('running'):
                return self.json({'ok': True, 'ffmpeg': bool(ffmpeg_path()), 'state': {
                    'running': False, 'done': True, 'percent': 0,
                    'error': '另一个模板正在压缩（同时只能跑一个任务），请等它结束或切回那个模板查看进度'}})
            if st.get('outRel'): st['outUrl'] = '/media/' + st['outRel']
            if st.get('running') and st.get('startedAt'):
                st['elapsed'] = round(time.time() - st['startedAt'], 1)
            return self.json({'ok': True, 'state': st, 'ffmpeg': bool(ffmpeg_path())})
        if parsed.path == '/api/media/ffmpeg/status':
            p = ffmpeg_path()
            return self.json({'ok': True, 'found': bool(p), 'path': p,
                              'env': FFMPEG_ENV, 'expect': str(FFMPEG_EXE)})
        if parsed.path == '/api/export/html': return self._export_html()
        # 「导出网站 ZIP」对外稳定入口是 /api/export/site-zip；
        # /api/export/zip 是历史路由（旧 Template ZIP 用的名字），保留以免打断已有链接/脚本。
        if parsed.path in ('/api/export/zip', '/api/export/site-zip'): return self._export_zip()
        if parsed.path == '/api/export/template': return self._export_template()
        if parsed.path == '/api/deploy/status':
            link = load_public_link()
            gh = load_gh_token()
            cbcfg = load_cb_cfg()
            cb_ok = PUBLISH_PROVIDERS['cloudbase'].configured(cbcfg)
            gh_ok = gh_configured()
            deployments = load_deployments()
            # 默认 Provider：已有发布记录就沿用；否则 GitHub Pages（唯一默认）。
            # CloudBase 只在"已配置过"时才作为默认，避免新用户一进面板就看到一堆要填的东西。
            current = (link.get('provider')
                       or ('github' if gh_ok else ('cloudbase' if cb_ok else 'github')))
            # 各 provider 已发布的所有子路径（面板用它列出「已发布的链接」，每个都能单独复制）。
            # tplName：让用户认得出"这条链接是哪个模板发的"，而不是只看到一个路径串。
            tpl_names = {LEGACY_TPL_ID: '模板一'}
            try:
                for it in load_templates()['items']:
                    tpl_names[str(it.get('id'))] = str(it.get('name') or it.get('id'))
            except Exception:
                pass
            def _dep_list(pid):
                out = []
                for d in deployments:
                    if d.get('provider') != pid: continue
                    t = d.get('tpl') or LEGACY_TPL_ID
                    # ⚠ provider 必须带回给前端（2026-09-28 修复）：
                    # 面板里「更新发布 / 改发布内容 / 删除」三个按钮都把 d.provider 原样塞进
                    # /api/deploy/{retarget,remove} 的请求体。这里漏了它 → JSON.stringify 丢键
                    # → 后端收不到 provider → 一律报「不支持的平台：(空)」，
                    # 表现为「有些链接更新得了、有些更新不了」（其实是所有列表按钮都发不出去）。
                    out.append({'provider': pid, 'tpl': t, 'tplName': tpl_names.get(t) or t,
                                'path': d.get('path') or '', 'url': d.get('url') or '',
                                'deployedAt': d.get('deployedAt') or ''})
                # ⚠「当前」必须由服务端裁定（2026-10-06 修复）：
                # 下面 out.sort 会把记录按 (path, tpl) 重排，**重排后位置不再等于时间顺序**。
                # 前端旧逻辑取「该模板最后出现的一条」当“当前”，结果标到了最旧那条上 ——
                # 而「更新当前发布」真正覆盖的目标是 find_deployment（写入顺序最后一条 = 最新），
                # 于是界面标红的「当前」和按钮真正改的记录是两条不同的东西。
                # 这里把权威结果一起下发，前端不再自己按位置猜。
                _cur_map = {}
                for _t in {x['tpl'] for x in out}:
                    _cur_map[_t] = find_deployment(deployments, pid, _t) or {}
                for x in out:
                    c = _cur_map.get(x['tpl']) or {}
                    x['current'] = ((c.get('path') or '') == x['path']
                                    and (c.get('url') or '') == x['url']
                                    and (c.get('deployedAt') or '') == x['deployedAt'])
                out.sort(key=lambda x: (x['path'] or '', x['tpl']))
                return out
            return self.json({'ok': True,
                              'network': net_refresh(),
                              'mediaUpload': gh_release_upload_state(),
                              'publish': pub_job_state(),
                              'configured': (current == 'github' and gh_ok) or (current == 'cloudbase' and cb_ok),
                              'provider': current,
                              'tpl': self._tpl(),
                              'projectName': (link.get('meta') or {}).get('repoName') or '',
                              'publicUrl': link.get('url') or '',
                              'deployedAt': link.get('deployedAt') or '',
                              'providers': {
                                'cloudbase': {'configured': cb_ok,
                                              'envId': cbcfg.get('envId') or '',
                                              'region': cbcfg.get('region') or 'ap-shanghai',
                                              'path': cbcfg.get('path') or '',
                                              'deployments': _dep_list('cloudbase'),
                                              'publicUrl': (find_deployment(deployments, 'cloudbase', self._tpl()) or {}).get('url') or ''},
                                'github': {'configured': gh_ok,
                                           'login': gh.get('login') or '',
                                           'deployments': _dep_list('github'),
                                           'publicUrl': (find_deployment(deployments, 'github', self._tpl()) or {}).get('url') or ''}
                              }})
        # 自愈入口：从历史找回可能被异常写入弄丢的发布记录（详见 heal_deployments）。
        # GET / POST 都支持，前端打开发布面板时触发一次；服务端启动也会后台跑一次。
        if parsed.path == '/api/deploy/heal':
            try:
                return self.json(heal_deployments())
            except Exception as e:
                return self.json({'healed': [], 'found': 0, 'error': str(e)[:200]})
        # 建议的子路径名：面板「新增发布」用它预填输入框（用户可改）。
        # 只读、不落盘 —— 真正的分配发生在发布时（避免只是点开面板就占掉一个名字）。
        if parsed.path == '/api/deploy/suggest-path':
            q = parse_qs(urlparse(self.path).query)
            provider = str((q.get('provider', [''])[0]) or '').strip() or 'github'
            if provider not in PUBLISH_PROVIDERS:
                return self.json({'ok': False, 'error': '未知 Provider：' + provider}, 400)
            tpl = self._tpl()
            prefer = str((q.get('path', [''])[0]) or '').strip()
            return self.json({'ok': True, 'provider': provider, 'tpl': tpl,
                              'suggested': suggest_deploy_path(tpl, provider, None, prefer=prefer or None)})
        # —— GitHub 授权 ——
        # 默认：Device Flow（RFC 8628），普通用户无需创建任何 GitHub App，全程无 client_secret。
        # 高级（可选）：自带 OAuth App + 回环回调（127.0.0.1）。
        if parsed.path == '/api/github/app':
            # 「开发者选项」用的配置。普通用户完全不需要碰这里（默认走内置公共 Client ID）。
            app = load_gh_app()
            cid = (app.get('client_id') or '').strip()
            return self.json({'ok': True,
                              'appConfigured': bool(cid),
                              'client_id': cid,
                              'defaultMethod': 'device',
                              'secretRequired': False,
                              'devMode': bool(cid),
                              'usingBuiltinClient': not cid,
                              'publicClientIdConfigured': bool(gh_client_id())})
        if parsed.path == '/api/github/status':
            # 关键：这里的 connected / canCreateRepo 都来自**真实 API 响应**（gh_check_access），
            # 不是靠令牌前缀猜。授权过期或类型不对会当场暴露，而不是等用户点了发布才报错。
            t = load_gh_token()
            tok = t.get('token') or ''
            info = {'ok': True, 'connected': bool(tok), 'login': t.get('login') or '',
                    'via': t.get('via') or ('oauth' if tok else ''), 'method': 'device',
                    'tokenKind': (t.get('kind') or gh_token_kind(tok)),
                    'expired': False, 'needsReauth': False, 'canCreateRepo': False,
                    'scopes': '', 'reposVisible': -1, 'warning': '', 'detail': '',
                    'publicClientIdConfigured': bool(gh_client_id())}
            if tok:
                # 读"上次探测的真实结论"，不打网络 → 面板秒开。
                # 结论由「连接 GitHub 时」和「每次发布前」写入，这里陈旧了就后台刷新。
                cap_at = float(t.get('capAt') or 0)
                info['probeAge'] = int(time.time() - cap_at) if cap_at else -1
                info['probeStale'] = (not cap_at) or (time.time() - cap_at > GH_CAP_TTL)
                info['scopes'] = t.get('scopes') or ''
                info['canCreateRepo'] = bool(t.get('canCreateRepo'))
                if t.get('capLogin'):
                    info['login'] = t['capLogin']
                if t.get('capError'):
                    info['needsReauth'] = True
                    info['detail'] = t['capError']
                elif not t.get('canCreateRepo'):
                    info['warning'] = t.get('canCreateRepoReason') or GH_APP_TOKEN_HINT
                if gh_token_expired(t):
                    info['expired'] = True
                    info['warning'] = ((info['warning'] + ' ') if info['warning'] else '') + \
                        'GitHub 授权已过期，请点「连接 GitHub」重新授权一次。'
                if info['probeStale']:
                    gh_probe_async(tok)
            elif not gh_client_id():
                info['detail'] = GH_NO_CLIENT_ID_HINT
            return self.json(info)
        if parsed.path == '/api/github/device/start':
            try:
                return self.json({'ok': True, **github_device_start()})
            except GHError as e:
                return self.json({'ok': False, 'error': gh_user_message(e, 'auth')}, 502)
        if parsed.path == '/api/github/device/poll':
            try:
                st = github_device_poll()
                return self.json({'ok': True, **st})
            except GHError as e:
                return self.json({'ok': False, 'error': gh_user_message(e, 'auth')}, 502)
        if parsed.path == '/api/github/connect':
            # 默认走 Device Flow：前端拿到 user_code 后自己轮询，不需要整页跳转。
            # 显式带 ?method=oauth 时才走自带 OAuth App 的回环回调（高级）。
            qs0 = parse_qs(parsed.query)
            method = (qs0.get('method') or ['device'])[0]
            if method == 'oauth':
                app = load_gh_app()
                if not (app.get('client_id') and app.get('client_secret')):
                    self.send_response(200); self.send_header('Content-Type', 'text/html; charset=utf-8')
                    self.send_header('Content-Length', str(len(GH_APP_HINT))); self.end_headers()
                    self.wfile.write(GH_APP_HINT.encode('utf-8')); return
                state = ''.join(random.choice('abcdef0123456789') for _ in range(24))
                save_gh_state({'state': state, 'at': time.time()})
                self.protocol_version = 'HTTP/1.1'
                self.send_response(302)
                self.send_header('Location', github_pages_auth_url())
                self.send_header('Cache-Control', 'no-store'); self.send_header('Content-Length', '0')
                self.end_headers(); return
            try:
                return self.json({'ok': True, **github_device_start()})
            except GHError as e:
                return self.json({'ok': False, 'error': gh_user_message(e, 'auth')}, 502)
        if parsed.path == '/api/github/callback':
            qs = parse_qs(parsed.query)
            code = (qs.get('code') or [None])[0]
            st = (qs.get('state') or [None])[0]
            saved = load_gh_state()
            if not code or st != saved.get('state'):
                self.send_response(400); self.send_header('Content-Type', 'text/plain; charset=utf-8')
                self.send_header('Content-Length', str(len(b'missing code or state mismatch')))
                self.end_headers(); self.wfile.write(b'missing code or state mismatch'); return
            try:
                github_exchange_code(code)
                self.protocol_version = 'HTTP/1.1'; self.send_response(302)
                self.send_header('Location', '/?github=connected')
                self.send_header('Cache-Control', 'no-store'); self.send_header('Content-Length', '0')
                self.end_headers(); return
            except GHError as e:
                msg = ('GitHub 授权失败：' + gh_user_message(e, 'auth') + '\n\n请关闭此页，回到 FolioFold 重新点「连接 GitHub」。').encode('utf-8')
                self.send_response(400); self.send_header('Content-Type', 'text/plain; charset=utf-8')
                self.send_header('Content-Length', str(len(msg))); self.end_headers(); self.wfile.write(msg); return
        if parsed.path == '/api/health':
            return self.json({'ok': True, 'pid': os.getpid(), 'time': time.time(), 'tpl': tpl,
                              'root': str(ROOT), 'versions': {'content': (read(tp['draft']) or {}).get('schemaVersion'),
                                                              'design': (read(tp['design']) or {}).get('schemaVersion')}})
        # —— Phase 4：环境检查（只读）。GET /api/env-check ——
        if parsed.path == '/api/env-check':
            try:
                rows = env_check_rows(port=self.server.server_address[1])
            except Exception as e:
                return self.json({'ok': False, 'error': '环境检查失败：%s' % str(e)[:160]}, 500)
            counts = {}
            for r in rows:
                counts[r['status']] = counts.get(r['status'], 0) + 1
            return self.json({'ok': True, 'rows': rows, 'counts': counts})
        # —— Phase 4：意外关闭恢复 —— 只读状态：抢救副本清单 + 当前草稿信息 ——
        if parsed.path == '/api/recovery/status':
            draft_st = None
            try:
                st = tp['draft'].stat()
                draft_st = {'mtime': int(st.st_mtime), 'size': st.st_size}
            except OSError:
                pass
            rescued = _recovery_list_rescued(tp)
            for r in rescued:
                r['newerThanDraft'] = bool(draft_st and r['mtime'] > draft_st['mtime'])
            return self.json({'ok': True, 'tpl': tpl, 'draft': draft_st, 'rescued': rescued,
                              'previousExists': tp['previous'].is_file()})
        # —— Phase 4：恢复前差异预览（只读，顶层摘要）——
        if parsed.path == '/api/recovery/diff':
            qs_r = parse_qs(urlparse(self.path).query)
            src = _recovery_resolve(tp, (qs_r.get('name') or [''])[0])
            if src is None:
                return self.json({'ok': False, 'error': '找不到这份备份文件（只支持 portfolio.rescued-*.json / portfolio.previous.json）'}, 404)
            try:
                rows = _recovery_diff(read(src) or {}, read(tp['draft']) or {})
            except Exception as e:
                return self.json({'ok': False, 'error': '读取失败：%s' % str(e)[:160]}, 500)
            return self.json({'ok': True, 'tpl': tpl, 'name': src.name, 'rows': rows})
        if parsed.path == '/api/version':
            # 极轻量的数据版本指纹：统一 Studio 外壳用它判断"另一个面板刚保存了"，从而刷新其余面板。
            # 只读文件 stat，不解析 JSON，轮询无负担。（按模板分别指纹，切换模板互不干扰。）
            stamps = {}
            for key, path in (('content', tp['draft']), ('design', tp['design']),
                              ('published', tp['published']), ('designPublished', tp['designPublished'])):
                try:
                    st = path.stat()
                    stamps[key] = f'{int(st.st_mtime_ns)}:{st.st_size}'
                except Exception:
                    stamps[key] = ''
            return self.json({'ok': True, 'tpl': tpl, **stamps})
        # 目录型入口：必须做真正的 301 重定向（而不是内部改写路径）。
        # 若只改 self.path，浏览器地址栏仍停在 /editor（无尾斜杠），
        # 相对路径的 <script src="themes.js"> 会被解析成 /themes.js → 404，
        # 编辑器因此永远卡在"正在加载"。这里让浏览器跳到带斜杠的地址。
        if parsed.path in ('/editor', '/visual-editor', '/portfolio'):
            self.protocol_version = 'HTTP/1.1'
            self.send_response(301)
            self.send_header('Location', parsed.path + '/')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        # /studio 是统一工作台入口的别名（工作台本体现在就在根路径）
        if parsed.path in ('/studio', '/studio/'):
            self.protocol_version = 'HTTP/1.1'
            self.send_response(301)
            self.send_header('Location', '/')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        # 日常工作入口只有 Studio（根目录）。编辑器 / 草稿 FolioFold 的独立地址
        # 只保留给 Studio 内部 iframe 使用，或给明确的发布版 / 打印 / 画布请求使用。
        # 这样用户从历史书签进入 /editor/、/visual-editor/ 时也不会再次绕开统一外壳。
        qs = parse_qs(parsed.query)
        if qs.get('studio', ['0'])[0] != '1':
            studio_tab = {'/editor/': 'editor', '/visual-editor/': 'visual', '/portfolio/': 'portfolio'}.get(parsed.path)
            # ?tpl= 也要算作"明确指定了模板"，此时保留 /portfolio/ 直出（这就是每个模板的独立入口）
            preserve_portfolio = parsed.path == '/portfolio/' and any(key in qs for key in ('mode', 'print', 've', 'tpl'))
            if studio_tab and not preserve_portfolio:
                _tq = self.tpl_qs()
                self.protocol_version = 'HTTP/1.1'
                self.send_response(302)
                self.send_header('Location', '/?tab=' + studio_tab + ('&tpl=' + _tq if _tq else ''))
                self.send_header('Cache-Control', 'no-store')
                self.send_header('Content-Length', '0')
                self.end_headers()
                return
        # 对静态文件（包括 media/）实现 Range request 支持（Chromium 视频 seek 需要）
        return self._serve_static_with_range()
    def _serve_static_with_range(self):
        path = self.translate_path(self.path)
        try:
            file_path = Path(path)
            # 目录 → index.html：自己发送（带 no-store）。
            # 若走 super().do_GET()，会返回 HTTP/1.0 + Last-Modified 且没有 Cache-Control，
            # 浏览器可能长期缓存旧版 HTML，导致改版后仍卡在"正在加载"。
            if file_path.is_dir():
                index_file = file_path / 'index.html'
                if index_file.is_file():
                    raw = index_file.read_bytes()
                    self.protocol_version = 'HTTP/1.1'
                    self.send_response(200)
                    self.send_header('Content-Type', 'text/html; charset=utf-8')
                    self.send_header('Cache-Control', 'no-store, must-revalidate')
                    self.send_header('Content-Length', str(len(raw)))
                    self.end_headers()
                    self.wfile.write(raw)
                    return
                return super().do_GET()
            if not file_path.is_file(): return super().do_GET()
            ctype = mimetypes.guess_type(str(file_path))[0] or 'application/octet-stream'
            file_size = file_path.stat().st_size
            range_header = self.headers.get('Range')
            # 使用 protocol_version + send_response_only 显式构造响应，避免 SimpleHTTPRequestHandler 干扰
            self.protocol_version = 'HTTP/1.1'
            m = re.match(r'bytes=(\d*)-(\d*)$', range_header) if range_header else None
            if m:
                start, end = m.group(1), m.group(2)
                start = int(start) if start else 0
                end = int(end) if end else file_size - 1
                if start >= file_size or end >= file_size or start > end:
                    self.send_response(416)
                    self.send_header('Content-Type', ctype)
                    self.send_header('Content-Range', f'bytes */{file_size}')
                    self.end_headers()
                    return
                self.send_response(206)
                self.send_header('Content-Type', ctype)
                self.send_header('Accept-Ranges', 'bytes')
                self.send_header('Cache-Control', 'public, max-age=3600' if ctype.startswith(('video/', 'audio/')) else 'no-store')
                self.send_header('Content-Range', f'bytes {start}-{end}/{file_size}')
                self.send_header('Content-Length', str(end - start + 1))
                self.end_headers()
                with file_path.open('rb') as f:
                    f.seek(start)
                    remaining = end - start + 1
                    while remaining > 0:
                        chunk = f.read(min(64 * 1024, remaining))
                        if not chunk: break
                        try: self.wfile.write(chunk)
                        except (BrokenPipeError, ConnectionResetError): return
                        remaining -= len(chunk)
                return
            # 非 range 请求：发送完整文件
            self.send_response(200)
            self.send_header('Content-Type', ctype)
            self.send_header('Accept-Ranges', 'bytes')
            self.send_header('Cache-Control', 'public, max-age=3600' if ctype.startswith(('video/', 'audio/')) else 'no-store')
            self.send_header('Content-Length', str(file_size))
            self.end_headers()
            with file_path.open('rb') as f:
                while True:
                    chunk = f.read(64 * 1024)
                    if not chunk: break
                    try: self.wfile.write(chunk)
                    except (BrokenPipeError, ConnectionResetError): return
        except BrokenPipeError:
            pass
        except ConnectionResetError:
            pass
        except Exception as e:
            try: self.send_error(500, str(e)[:100])
            except Exception: pass
    def _tpl_create_record(self, name, copy_from=''):
        """真正落盘建模板，返回新模板 id（不写 HTTP 响应，方便别的路由复用）。"""
        data = load_templates()
        n = len(data['items']) + 1
        while any(it.get('id') == 'tpl-%d' % n for it in data['items']):
            n += 1
        tid = 'tpl-%d' % n
        tp = tpl_paths(tid)
        if copy_from and tpl_exists(copy_from):
            src = tpl_paths(copy_from)
            for key in ('draft', 'design'):
                val = read(src[key], None)
                if isinstance(val, dict) and val:
                    write(tp[key], val)
            if not tp['draft'].exists(): write(tp['draft'], scaffold_template())
            if not tp['design'].exists(): write(tp['design'], blank_design())
        else:
            # 全新模板（含「导入为新模板」）落盘即带上占位脚手架，让结构可见、可填。
            write(tp['draft'], scaffold_template())
            write(tp['design'], blank_design())
        data['items'].append({'id': tid, 'name': name, 'createdAt': now_iso()})
        save_templates(data)
        return tid

    def _tpl_create(self, payload):
        """新建模板。默认全空；copyFrom 指定时复制该模板的草稿内容+排版。"""
        name = str((payload or {}).get('name') or '').strip()[:40] or '新模板'
        copy_from = str((payload or {}).get('copyFrom') or '').strip()
        tid = self._tpl_create_record(name, copy_from)
        return self.json({'ok': True, 'id': tid, 'name': name})
    def do_POST(self):
        route = urlparse(self.path).path
        if route == '/api/shutdown':
            return self._handle_shutdown()
        try:
            if route == '/api/deploy/heal':
                return self.json(heal_deployments())
            if route in ('/api/templates/create', '/api/templates/add'):
                payload = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))) or b'{}')
                return self._tpl_create(payload)
            if route == '/api/templates/rename':
                payload = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))) or b'{}')
                tid = str((payload or {}).get('id') or '').strip()
                name = str((payload or {}).get('name') or '').strip()[:40]
                if not name: return self.json({'error': '模板名不能为空'}, 400)
                data = load_templates()
                for it in data['items']:
                    if it.get('id') == tid:
                        it['name'] = name
                        save_templates(data)
                        return self.json({'ok': True, 'id': tid, 'name': name})
                return self.json({'error': '模板不存在'}, 404)
            if route == '/api/templates/delete':
                payload = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))) or b'{}')
                # ⚠ 历史坑（2026-10-04）：这里只认 payload['id']，而 export / import 走的是 payload['tpl']。
                #   传错键会得到 tid=''：不等于模板一、不在列表里，而 target=TEMPLATES_DIR/''
                #   （父目录本身，exists() 恒为 True）→ 既不删列表也不删目录，却照样返回 ok:true。
                #   一个"假装成功"的静默空操作，结果磁盘上越攒越多孤儿模板目录。
                #   现在 id / tpl 都认，并且空 id 直接报错——宁可明确失败，绝不假装成功。
                tid = str((payload or {}).get('id') or (payload or {}).get('tpl') or '').strip()
                if not tid:
                    return self.json({'error': '缺少模板 id（请传 id 或 tpl）'}, 400)
                if tid == LEGACY_TPL_ID:
                    return self.json({'error': '模板一是当前作品集本体，不能删除'}, 400)
                data = load_templates()
                in_list = any(it.get('id') == tid for it in data['items'])
                target = TEMPLATES_DIR / tid
                # 不在列表里也可能只是上次没删干净、磁盘上还在目录 → 仍尝试清理，
                # 避免「列表里已无此模板、磁盘上还留着孤儿目录」（实测曾经攒了一个挂好几天）。
                # 只有当「既不在列表、磁盘上也没有」时才报不存在。
                if not in_list and not target.exists():
                    return self.json({'error': '模板不存在'}, 404)
                if in_list:
                    data['items'] = [it for it in data['items'] if it.get('id') != tid]
                    save_templates(data)
                if TPL_ID_RE.match(tid):
                    # Windows + exFAT 上杀毒/索引会短暂持有目录句柄，一次 rmtree 删不掉。
                    # 重试约 6 秒吸收瞬时锁；还不行就如实回报 dirRemoved=false（绝不假装成功）。
                    for attempt in range(24):
                        _rmtree_forgiving(target)
                        if not target.exists():
                            break
                        time.sleep(0.25)
                # 如实回报目录是否真的删掉了。环境层的删除守卫失败时会留下孤儿目录，
                # 不能假装删除成功 —— 那样磁盘上会攒下一堆列表里看不见的模板目录。
                return self.json({'ok': True, 'id': tid,
                                  'dirRemoved': not target.exists()})
            if route == '/api/templates/export':
                # 生成可分享的模板：一份 JSON + 一个通用分享码。只含 Design，不含任何个人内容。
                payload = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))) or b'{}')
                tpl_id = str((payload or {}).get('tpl') or LEGACY_TPL_ID).strip() or LEGACY_TPL_ID
                if not tpl_exists(tpl_id): tpl_id = LEGACY_TPL_ID
                name = str((payload or {}).get('name') or '').strip()[:40]
                code, full_code, tpl = export_template_with_code(tpl_id, name)
                return self.json({'ok': True, 'code': code, 'fullCode': full_code,
                                  'template': tpl, 'name': tpl['name']})
            if route == '/api/templates/import':
                # 导入模板 = 只换版式，绝不碰个人内容（portfolio.json 一个字节都不写）
                payload = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))) or b'{}')
                tpl_id = str((payload or {}).get('tpl') or LEGACY_TPL_ID).strip() or LEGACY_TPL_ID
                if not tpl_exists(tpl_id): tpl_id = LEGACY_TPL_ID
                obj, err = resolve_import_payload(payload)
                if err: return self.json({'ok': False, 'error': err}, 400)
                # 二次保险：即便模板里混进了内容字段，也只取 design 与语言设置，其它一概丢弃。
                # ⚠ 个人内容（姓名 / 简介 / 经历 / 作品 / 联系方式 / 图片视频 / 译文）一律不进模板，
                #   导入时也绝不从模板里取 —— 这是「模板」与「复制粘贴」的分界线。
                safe = {'type': TEMPLATE_TYPE, 'templateVersion': TEMPLATE_VERSION,
                        'name': obj.get('name') or '', 'design': obj.get('design') or {}}
                inc = obj.get('settings') if isinstance(obj.get('settings'), dict) else {}
                tm = str(inc.get('translationMode') or '').strip().lower()
                if tm in ('review', 'direct'):
                    safe['settings'] = {'translationMode': tm}
                # mode='current'（默认）：只把 design 合进**当前模板**，一行内容都不动、也不新建模板。
                #   —— 用户实测反馈：「导入等于复制粘贴过来了」。因为旧实现会复制当前草稿去建新模板，
                #      看上去就是整站被克隆了一份。导入就该只换版式。
                # mode='new'：另存为一个新模板，**内容留空**（和顶栏「+ 新模板」同口径），只带版式。
                mode = str((payload or {}).get('mode') or '').strip().lower()
                target, created = tpl_id, False
                if mode == 'new':
                    # 「先命名再导入」：用户在导入弹窗里填的名字优先。
                    # 旧逻辑只认模板自带的 name，导入出来的模板可能和已有模板撞名，
                    # 两个同名模板混在列表里极易误删 —— 所以这里以用户填写的为准，回填到模板名。
                    nm = (str((payload or {}).get('name') or '').strip()
                          or str(safe.get('name') or '').strip())[:40] or '导入的模板'
                    target = self._tpl_create_record(nm, '')   # 不 copy_from：内容绝不跟着走
                    created = True
                    safe['name'] = nm   # 返回值要带用户的命名，前端 toast 才不会显示成模板自带名
                ok, res = apply_template(target, safe)
                if not ok: return self.json({'ok': False, 'error': res}, 400)
                # 语言设置（review / direct 两个开关，不含任何译文）—— 属于设置，可以跟着模板走
                if 'settings' in safe:
                    apply_content_settings(target, safe['settings'])
                return self.json({'ok': True, 'tpl': target, 'created': created,
                                  'name': safe.get('name') or tpl_display_name(target) or '未命名模板',
                                  'keys': sorted((safe.get('design') or {}).keys())})
            # —— ⚠ 写路由专用：模板 id 显式给了但不存在 → 404，绝不静默写进模板一 ——
            # 见 _tpl_strict() 的说明：静默回落 = 把内容写错地方 = 静默丢数据。
            tpl = self._tpl_strict()
            if tpl is None:
                return self.json({'ok': False, 'error': '模板不存在，已拒绝写入（避免误写进模板一）'}, 404)
            tp = tpl_paths(tpl)
            if route == '/api/translation/draft':
                try:
                    payload = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))) or b'{}')
                except Exception:
                    payload = {}
                kind = str((payload or {}).get('kind') or '')
                locale_key = str((payload or {}).get('localeKey') or '')
                # Provider availability is checked before an entity lookup so
                # old callers and the UI receive the truthful configuration
                # state, and no source field is ever accepted while disabled.
                provider = resolve_translation_provider(DEPLOY_DIR)
                provider_status = provider.status()
                if not provider_status.configured:
                    return self.json({
                        'ok': False, 'tpl': tpl, **provider_status.as_dict(),
                        'sourceAccepted': False,
                    }, 503)
                current = normalize(read(tp['draft']) or {}, materialize_localization=True)
                entity, record = localized_summary_record(current, kind, locale_key)
                if not entity:
                    return self.json({'ok': False, 'error': '未找到对应的翻译内容'}, 404)
                source = ((entity.get('structuredContent') or {}).get('summary') or '')
                if not isinstance(source, str) or not source:
                    return self.json({'ok': False, 'error': '原文项目介绍为空，无法生成英文 Draft'}, 400)
                try:
                    from translation_providers import TranslationRequest
                    translation = provider.translate(TranslationRequest(source=source,
                        content_kind='project-summary' if kind == 'projects' else 'experience-summary'))
                except TranslationProviderUnavailable as unavailable:
                    status = unavailable.status.as_dict()
                    return self.json({
                        'ok': False, 'tpl': tpl, **status,
                        'sourceAccepted': False,
                    }, 503)
                record['sourceHash'] = summary_hash(source)
                record['sourceLanguage'] = 'zh-CN'; record['targetLanguage'] = 'en'
                record['status'] = 'draft'; record['draft'] = translation; record['error'] = ''
                write(tp['draft'], current)
                return self.json({'ok': True, 'tpl': tpl, 'kind': kind, 'localeKey': locale_key,
                                  'status': 'draft', 'translation': translation,
                                  'provider': provider.provider_id})
            if route == '/api/translation/apply':
                try:
                    payload = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))) or b'{}')
                except Exception:
                    payload = {}
                kind = str((payload or {}).get('kind') or '')
                locale_key = str((payload or {}).get('localeKey') or '')
                current = normalize(read(tp['draft']) or {}, materialize_localization=True)
                entity, record = localized_summary_record(current, kind, locale_key)
                if not entity:
                    return self.json({'ok': False, 'error': '未找到对应的翻译内容'}, 404)
                current_hash = summary_hash(((entity.get('structuredContent') or {}).get('summary') or ''))
                if record.get('status') != 'draft' or not record.get('draft'):
                    return self.json({'ok': False, 'error': '没有可审核的英文 Draft'}, 409)
                if record.get('sourceHash') != current_hash:
                    record['status'] = 'stale'; write(tp['draft'], current)
                    return self.json({'ok': False, 'error': '中文原文已变化，请重新翻译'}, 409)
                record['reviewed'] = record.get('draft', ''); record['status'] = 'reviewed'; record['error'] = ''
                write(tp['draft'], current)
                return self.json({'ok': True, 'tpl': tpl, 'kind': kind, 'localeKey': locale_key,
                                  'status': 'reviewed', 'translation': record['reviewed']})
            if route == '/api/translation/cancel':
                try:
                    payload = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))) or b'{}')
                except Exception:
                    payload = {}
                kind = str((payload or {}).get('kind') or '')
                locale_key = str((payload or {}).get('localeKey') or '')
                current = normalize(read(tp['draft']) or {}, materialize_localization=True)
                entity, record = localized_summary_record(current, kind, locale_key)
                if not entity:
                    return self.json({'ok': False, 'error': '未找到对应的翻译内容'}, 404)
                current_hash = summary_hash(((entity.get('structuredContent') or {}).get('summary') or ''))
                record['draft'] = ''
                if record.get('reviewed') and record.get('sourceHash') == current_hash:
                    record['status'] = 'reviewed'
                else:
                    record['status'] = 'unconfigured'; record['sourceHash'] = current_hash
                record['error'] = ''
                write(tp['draft'], current)
                return self.json({'ok': True, 'tpl': tpl, 'kind': kind, 'localeKey': locale_key,
                                  'status': record['status']})
            if route == '/api/i18n/content/translate':
                # 整篇翻译：一次把作品集里所有「用户文案」翻成目标语言，落成平表下发画布。
                # 这是"不要一个个字段去调"的那条通道；逐条 Draft 通道保持不变（仍可在
                # 项目/经历里单独精修某一条并审核）。
                try:
                    payload = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))) or b'{}')
                except Exception:
                    payload = {}
                lang = str((payload or {}).get('lang') or '').strip()
                if lang not in CONTENT_I18N_LANGS:
                    return self.json({'ok': False, 'error': '不支持的语言：%s' % (lang or '(空)')}, 400)
                try:
                    provider = resolve_translation_provider(DEPLOY_DIR)
                except TranslationProviderUnavailable as error:
                    return self.json({'ok': False, 'error': error.status.message,
                                      'code': error.status.code}, 503)
                if not provider.status().configured:
                    state = provider.status()
                    return self.json({'ok': False, 'error': state.message, 'code': state.code}, 503)

                content = read(tp['draft']) or {}
                try:
                    content = normalize(content)
                except Exception:
                    pass
                pairs = collect_translatable(content, read(tp['design']), lang)
                if not pairs:
                    return self.json({'ok': True, 'tpl': tpl, 'lang': lang, 'count': 0,
                                      'map': {}, 'total': 0,
                                      'note': '没有需要翻译的内容（可能整份作品集都设成了「不跟随语言」）。'})
                texts = [text for _path, text in pairs]

                # ⚠ 增量复用（2026-09-22）：已经在译文表里的文案**直接复用**，只把新增文案送模型。
                # 两个理由：① 4B 模型跑 100+ 条要 20 分钟，每次全量重跑纯属浪费；
                # ② 用户验收过的译文必须**稳定** —— 全量重跑等于让已过关的文案再赌一次随机性，
                #    这正好违背「这次过关 = 以后都过关」的验收要求。
                old = read_content_i18n(tpl, lang)
                if not isinstance(old, dict):
                    old = {}
                pending_texts = []
                for _t in texts:
                    _cached = old.get(_t)
                    if isinstance(_cached, str) and _cached.strip():
                        continue
                    pending_texts.append(_t)

                # 分批：一批 16 条。批太大时小模型容易漏项/串行（返回条数不符就整批作废），
                # 批太小则调用次数太多、慢。16 条是实测的折中值。
                CHUNK = 16
                results, failures = [], 0
                for start in range(0, len(pending_texts), CHUNK):
                    chunk = pending_texts[start:start + CHUNK]
                    try:
                        got = provider.translate_batch(chunk, lang)
                        if len(got) != len(chunk):
                            raise ValueError('条数不符')
                    except TranslationProviderUnavailable:
                        # 整批失败 → 逐条重试，尽量把能翻的翻掉（一条坏句子不该毁掉整篇）
                        got = []
                        for one in chunk:
                            try:
                                got.append(provider.translate_batch([one], lang)[0] or '')
                            except Exception:
                                got.append('')
                                failures += 1
                    except Exception:
                        got = [''] * len(chunk)
                        failures += len(chunk)
                    results.extend(got)

                table, updated = {}, 0
                # 先铺复用的旧译文，再盖上本次新翻出来的 —— 顺序很重要：新结果优先。
                for text in texts:
                    value = (old.get(text) or '').strip()
                    if value and value != text:
                        table[text] = value
                for text, translated in zip(pending_texts, results):
                    value = (translated or '').strip()
                    if value and value != text:
                        table[text] = value
                        if old.get(text) != value:
                            updated += 1
                reused = len(texts) - len(pending_texts)
                out_path = content_i18n_path(tpl, lang)
                try:
                    out_path.parent.mkdir(parents=True, exist_ok=True)
                    # sourceHash：本表生成时「原文清单（路径+文本）」的指纹 —— 原文改了就判 stale，
                    # 提示「需要重新检查」；旧译文保留不删（status 端点同口径计算）。
                    write(out_path, {'schemaVersion': SCHEMA_VERSION, 'lang': lang, 'source': 'zh-CN',
                                     'generatedAt': now_iso(), 'provider': provider.provider_id,
                                     'model': getattr(provider, 'model', ''),
                                     'sourceHash': summary_hash(json.dumps(
                                         [[pth, txt] for pth, txt in pairs], ensure_ascii=False)),
                                     'reviewed': False,   # 机翻产物必须经创作者审核才能进画布/发布（Phase 3 门控）
                                     'map': table})
                except Exception as error:
                    return self.json({'ok': False, 'error': '译文写入失败：%s' % str(error)[:160]}, 500)
                return self.json({'ok': True, 'tpl': tpl, 'lang': lang,
                                  'count': len(table), 'updated': updated, 'total': len(texts),
                                  'reused': reused, 'pending': len(pending_texts),
                                  'failed': failures, 'map': table})
            if route == '/api/i18n/content/review':
                # Phase 3 审核闸：创作者确认某语言的整篇译文没问题后，把它标成 reviewed。
                # 只有 reviewed 的表才会被画布（GET 不带 draft=1）和发布内联采用。
                # 前置条件：该语言得先有一份译文（没生成过就谈不上审核）。
                try:
                    payload = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))) or b'{}')
                except Exception:
                    payload = {}
                lang = str((payload or {}).get('lang') or '').strip()
                if lang not in CONTENT_I18N_LANGS:
                    return self.json({'ok': False, 'error': '不支持的语言：%s' % (lang or '(空)')}, 400)
                out_path = content_i18n_path(tpl, lang)
                if not out_path.is_file():
                    return self.json({'ok': False, 'error': '该语言还没有译文，请先在「语言设置」里生成'}, 404)
                try:
                    meta = json.loads(out_path.read_text(encoding='utf-8'))
                    if not isinstance(meta, dict) or not isinstance(meta.get('map'), dict) or not meta.get('map'):
                        return self.json({'ok': False, 'error': '译文表是空的，请先生成译文'}, 409)
                    meta['reviewed'] = True
                    meta['reviewedAt'] = now_iso()
                    write(out_path, meta)
                except Exception as error:
                    return self.json({'ok': False, 'error': '审核标记写入失败：%s' % str(error)[:160]}, 500)
                return self.json({'ok': True, 'tpl': tpl, 'lang': lang, 'reviewed': True,
                                  'count': len(meta['map'])})
            if route == '/api/save':
                raw_bytes = self.rfile.read(int(self.headers.get('Content-Length', '0')))
                try:
                    raw_obj = json.loads(raw_bytes or b'{}')
                except Exception:
                    raw_obj = {}
                # Explicit save is the only operation that persists newly created locale keys/translation records.
                incoming = normalize(raw_obj, materialize_localization=True)
                # autosave=1：静默自动保存，写草稿但不覆盖"上一版"（恢复点保留用户手动保存时的状态）
                qs = parse_qs(urlparse(self.path).query)
                autosave = qs.get('autosave', ['0'])[0] == '1'
                # —— ⚠ 数据丢失防护（2026-09-19 事故后加；2026-09-20 修正，勿删）——
                # 原事故：前端在"数据还没加载成功"时自动保存，把空对象 `{}` POST 上来；
                # normalize({}) 恰好等于 blank_portfolio()，一落盘就是整站清空。
                #
                # ⚠ 2026-09-20 二次事故的修正要点（改前务必读完）：
                # 旧写法 `content_blank(incoming) and content_blank(existing)` 对两侧用了同一阈值，
                # 导致「用户删掉最后一项实质内容」时：incoming 判空（对）→ 再看 existing 也判空
                # → 于是**放行覆盖**，数据被写成空骨架。用户再次打开就"信息全没了"。
                #
                # 现在的判据把两个方向分开：
                #   · 拦不拦，只看 incoming 的**原始 payload**是不是真·空（content_blank_payload）。
                #     用户哪怕只留下一个区块标题 → 原始 payload 非空 → 不拦 → 删除正常生效。
                #   · 保不保护，只看 existing 是不是**彻底空骨架**（content_is_empty_shell）。
                #     只要 old 草稿还有任何东西，就不允许被「原始空 payload」覆盖。
                force = qs.get('force', ['0'])[0] == '1'
                incoming_is_dead_empty = content_blank_payload(raw_obj)
                if not force and incoming_is_dead_empty and tp['draft'].exists():
                    try:
                        existing = normalize(read(tp['draft']) or {})
                    except Exception:
                        existing = {}
                    # 「有数据要保护」= 不是彻底空骨架。用 content_is_empty_shell 判定，
                    # 而不是 content_blank —— 后者会把"用户刚删到接近空"误判成"没内容"。
                    if not content_is_empty_shell(existing):
                        rescue = None
                        try:
                            rescue = tp['draft'].with_name(
                                'portfolio.rescued-%s.json' % now_iso().replace(':', '').replace('-', ''))
                            write(rescue, existing)
                        except Exception:
                            rescue = None
                        return self.json({'ok': False, 'blocked': True, 'tpl': tpl,
                                          'error': '收到的是空内容，但该模板已有数据，为防止误删已拒绝保存。'
                                                   '（原内容已另存为 %s）' % (rescue.name if rescue else '(备份失败)')}, 409)
                if not autosave and tp['draft'].exists(): shutil.copy2(tp['draft'], tp['previous'])
                write(tp['draft'], incoming)
                return self.json({'ok': True, 'tpl': tpl, 'state': 'draft', 'autosave': autosave})
            if route == '/api/design/save':
                # 保存 GrapesJS Project Data 到独立 design.json，不覆盖 portfolio.json。
                # 支持部分更新：若 payload 未提供 project/html/css（如模板导入只传 theme），保留已有值。
                payload = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))))
                prev = read(tp['design']) or {}
                if tp['design'].exists() and prev:
                    write(tp['designPrevious'], prev)
                design = dict(prev)  # 基于已有 design 合并
                design.update({
                    'schemaVersion': SCHEMA_VERSION,
                    'designVersion': int((prev.get('designVersion') or 0)) + 1,
                    'savedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                })
                if payload.get('project') is not None: design['project'] = payload.get('project')
                if payload.get('html') is not None: design['html'] = payload.get('html')
                if payload.get('css') is not None: design['css'] = payload.get('css')
                if payload.get('theme') is not None: design['theme'] = payload.get('theme')
                if payload.get('typography') is not None: design['typography'] = payload.get('typography')
                # spacing 只接受「非空的字典」：空 {} 表示前端此刻没读到画布状态
                # （画布正在重载 / __veDirect 还没挂上），绝不是"用户想清空全部间距"。
                # 不加这道判断就会把用户辛苦调好的间距静默抹掉。
                _sp = payload.get('spacing')
                if isinstance(_sp, dict) and _sp: design['spacing'] = _sp
                if payload.get('imgSizes') is not None: design['imgSizes'] = payload.get('imgSizes')
                # 栏外散落图片的位置摆放（{ '<mediaPath>': {'place':'float-right'} }）：
                # 「这只缩不能挪」的补丁，同属排版决策，存 design 不碰 content。
                if payload.get('imgPos') is not None: design['imgPos'] = payload.get('imgPos')
                # 媒体栏左右位置（{ 'projects.0.media': {'side': 'left'} }）—— 之前漏在白名单外，
                # 前端一直在发但服务端丢弃，导致「放到左边」刷新后失效。
                if payload.get('mediaLayout') is not None: design['mediaLayout'] = payload.get('mediaLayout')
                # 单个媒体项的尺寸 / 顺序 / 摆放位置 / 对齐
                # （{ 'projects.0.media#image0': {widthPct, order, place, align} }），同属「排版」决策，存 design。
                if payload.get('mediaItems') is not None: design['mediaItems'] = payload.get('mediaItems')
                if payload.get('textStyles') is not None: design['textStyles'] = payload.get('textStyles')
                if payload.get('inlineStyles') is not None: design['inlineStyles'] = payload.get('inlineStyles')
                if payload.get('images') is not None: design['images'] = payload.get('images')
                # 静态元素移除记录（如 Selected Works 眉标、hero 横线）：属于「布局/设计」决策，存 design 不碰 content
                if payload.get('removedStatic') is not None: design['removedStatic'] = payload.get('removedStatic')
                # 静态元素的可编辑文案（如 Selected works 眉标）：没有 content 数据 backing 的固定文字，
                # 归 Template；{ 'eyebrow-selected-works': 'Selected works' }，空字符串 = 恢复默认。
                if payload.get('staticText') is not None: design['staticText'] = payload.get('staticText')
                # Pixel Character 的布局/可见性/动画：独立 Canvas Element，存 design 不碰 content
                if payload.get('pixel') is not None: design['pixel'] = payload.get('pixel')
                # 区块顺序（拖拽排序后写入）
                if payload.get('sectionOrder') is not None: design['sectionOrder'] = payload.get('sectionOrder')
                # 展示区（Display Zones）：哪些资料提到 hero / hero 下方的信息列。
                # ⚠ 一律过 norm_display_zones 校正再写盘 —— 这是防止脏数据（手改 / 旧模板 /
                # 其它机器导入）把渲染层搞崩的最后一道关，而不是照单全收。
                if payload.get('displayZones') is not None:
                    design['displayZones'] = norm_display_zones(payload.get('displayZones'))
                write(tp['design'], design)
                # 「纯排版」改动（间距 / 图片尺寸 / 媒体排版 / 文本样式 / 静态元素增删 / 区块顺序）
                # 自动同步进「已发布」的 design：这类改动属于「所见即所得」，用户拖完就应该立刻生效，
                # 不该再要求他手动点一次「更新到最新版本」——否则他刷新看过往的"最新版本"时
                # 会看到旧间距，误以为"改了没存"。（内容/主题这类会影响成品内容的，仍走手动发布。）
                layout_only = payload.get('syncLayout') or (
                    payload.get('spacing') is not None or payload.get('imgSizes') is not None
                    or payload.get('imgPos') is not None
                    or payload.get('mediaLayout') is not None or payload.get('mediaItems') is not None
                    or payload.get('textStyles') is not None or payload.get('inlineStyles') is not None
                    or payload.get('removedStatic') is not None or payload.get('staticText') is not None
                    or payload.get('sectionOrder') is not None or payload.get('pixel') is not None
                    or payload.get('displayZones') is not None)
                synced = sync_layout_to_published(tpl, design) if layout_only else False
                return self.json({'ok': True, 'tpl': tpl, 'state': 'design',
                                  'designVersion': design['designVersion'], 'layoutSynced': synced})
            if route == '/api/publish':
                if not tp['draft'].exists(): return self.json({'error': 'No draft'}, 404)
                # 同时发布 Content（portfolio.json）+ Design（design.json）
                write(tp['published'], normalize(read(tp['draft'])))
                if tp['design'].exists():
                    write(tp['designPublished'], read(tp['design']))
                return self.json({'ok': True, 'tpl': tpl, 'state': 'published', 'designPublished': tp['design'].exists()})
            if route == '/api/restore':
                if not tp['previous'].exists(): return self.json({'error': 'No previous version'}, 404)
                write(tp['draft'], normalize(read(tp['previous'])))
                # 成套恢复：Content + Design 一起回到上一版（若存在 design.previous.json）
                if tp['designPrevious'].exists():
                    write(tp['design'], read(tp['designPrevious']))
                return self.json({'ok': True, 'tpl': tpl, 'state': 'draft', 'designRestored': tp['designPrevious'].exists()})
            # —— Phase 4：安全修复。只做一件事：创建缺失的关键目录（mkdir -p 语义）。
            # 不删除、不覆盖、不写入任何文件；不碰凭据 / media / 备份。修改内容在响应里如实列出。
            if route == '/api/env-repair':
                _p = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0')) or b'{}') or b'{}')
                requested = _p.get('actions') if isinstance(_p.get('actions'), list) else None
                created, skipped = [], []
                for label, p in ENV_REQUIRED_DIRS:
                    action_id = 'dir:' + p.name
                    if requested is not None and action_id not in requested:
                        continue
                    if p.is_dir():
                        skipped.append({'id': action_id, 'reason': '已存在'})
                        continue
                    try:
                        p.mkdir(parents=True, exist_ok=True)
                        created.append({'id': action_id, 'path': str(p)})
                    except OSError as e:
                        return self.json({'ok': False, 'error': '创建目录失败 %s：%s' % (p, str(e)[:120])}, 500)
                return self.json({'ok': True, 'created': created, 'skipped': skipped})
            # —— Phase 4：恢复抢救副本。白名单文件名；恢复前先把当前草稿再备份一份
            # （portfolio.rescued-prerestore-<时间戳>.json，同样受清理器保护），绝不静默覆盖。——
            if route == '/api/recovery/restore':
                _p = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0')) or b'{}') or b'{}')
                src = _recovery_resolve(tp, (_p or {}).get('name'))
                if src is None:
                    return self.json({'ok': False, 'error': '找不到这份备份文件（只支持 portfolio.rescued-*.json / portfolio.previous.json）'}, 404)
                src_obj = read(src)
                if not isinstance(src_obj, dict) or not src_obj:
                    return self.json({'ok': False, 'error': '这份备份内容为空或已损坏，拒绝恢复（当前数据未改动）'}, 409)
                pre_backup = None
                if tp['draft'].exists():
                    pre_backup = tp['draft'].with_name(
                        'portfolio.rescued-prerestore-%s.json' % now_iso().replace(':', '').replace('-', ''))
                    try:
                        shutil.copy2(tp['draft'], pre_backup)
                    except Exception:
                        return self.json({'ok': False, 'error': '恢复前备份当前草稿失败，已中止（当前数据未改动）'}, 500)
                write(tp['draft'], normalize(src_obj))
                return self.json({'ok': True, 'tpl': tpl, 'restoredFrom': src.name,
                                  'preBackup': pre_backup.name if pre_backup else ''})
            if route == '/api/github/connect':
                # POST 版：默认返回设备码 JSON（前端自行展示 + 轮询），不整页跳转。
                qsm = parse_qs(urlparse(self.path).query).get('method', ['device'])[0]
                if qsm == 'oauth':
                    app = load_gh_app()
                    if not (app.get('client_id') and app.get('client_secret')):
                        return self.json({'ok': False, 'error': '尚未配置自带 OAuth App（client_id / client_secret）'}, 400)
                    state = ''.join(random.choice('abcdef0123456789') for _ in range(24))
                    save_gh_state({'state': state, 'at': time.time()})
                    return self.json({'ok': True, 'redirect': github_pages_auth_url()})
                try:
                    return self.json({'ok': True, **github_device_start()})
                except GHError as e:
                    return self.json({'ok': False, 'error': str(e)}, 502)
            if route == '/api/github/device/start':
                # 申请设备码（默认授权路径：无 secret）。
                # 默认**幂等**：磁盘上已有未过期的码就原样交回，避免重复点击产生两枚不同的码而错位死等；
                # 传 {"force":true} 才强制申请一枚全新的。
                _p = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))) or b'{}')
                _force = str((_p or {}).get('force') or '').lower() in ('1', 'true', 'yes')
                try:
                    return self.json({'ok': True, **github_device_start(force=_force)})
                except GHError as e:
                    return self.json({'ok': False, 'error': gh_user_message(e, 'auth')}, 502)
            if route == '/api/github/device/poll':
                # 轮询换取令牌；正常中间态返回 pending，不视为错误。
                # 前端可带上自己显示的那枚 device_code，兜底防止落盘被覆盖后轮询到另一枚。
                _p = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))) or b'{}')
                _dc = str((_p or {}).get('device_code') or '').strip()
                try:
                    return self.json({'ok': True, **github_device_poll(_dc)})
                except GHError as e:
                    return self.json({'ok': False, 'error': gh_user_message(e, 'auth')}, 502)
            if route == '/api/github/app':
                # 「开发者选项」：自带 OAuth App 身份时才需要。普通用户完全不需要。
                # 只填 client_id 即可（Device Flow 官方明确不需要 client_secret）；
                # client_id 是公开标识、不是机密。secret 若填了也只落本机 gitignored 文件。
                payload = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))) or b'{}')
                cid = str((payload or {}).get('client_id') or '').strip()
                csec = str((payload or {}).get('client_secret') or '').strip()
                old_cid = (load_gh_app().get('client_id') or '').strip()
                # client_id 变了 → 旧令牌是另一个 App 授出来的，必须作废，
                # 否则会出现"显示已连接，但发布时权限不对"的隐性故障。
                if old_cid != cid:
                    for f in (GH_TOKEN_FILE, GH_DEVICE_FILE):
                        try: f.unlink()
                        except Exception: pass
                    _GH_CAP_CACHE.update({'at': 0.0, 'token': '', 'res': None})
                if not cid:
                    try: GH_APP_FILE.unlink()
                    except Exception: pass
                    return self.json({'ok': True, 'appConfigured': False, 'cleared': True,
                                      'publicClientIdConfigured': bool(gh_client_id())})
                save_gh_app({'client_id': cid, 'client_secret': csec})
                return self.json({'ok': True, 'appConfigured': True, 'clientIdOnly': not csec,
                                  'note': '已保存。点「连接 GitHub」即可用这个 Client ID 走设备码授权。'})
            if route == '/api/github/disconnect':
                # 仅清除本机令牌；不影响已发布的仓库 / Pages（已发布的站点继续存在）
                try: GH_TOKEN_FILE.unlink()
                except Exception: pass
                return self.json({'ok': True, 'connected': False})
            if route == '/api/deploy/config':
                payload = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))))
                provider_id = str((payload or {}).get('provider') or '').strip()
                if provider_id == 'cloudbase':
                    # CloudBase 凭证：EnvId + SecretId + SecretKey（+ 可选 region / 子目录）
                    # ⚠ SecretKey 只写本机 .folioframe/cloudbase.json，不回显、不进 ZIP、
                    #    绝不写进作品集数据或网页。
                    env_id = str(payload.get('envId') or '').strip()
                    sid = str(payload.get('secretId') or '').strip()
                    skey = str(payload.get('secretKey') or '').strip()
                    region = str(payload.get('region') or 'ap-shanghai').strip() or 'ap-shanghai'
                    sub = str(payload.get('path') or '').strip().strip('/')
                    old = load_cb_cfg()
                    if not env_id:
                        return self.json({'ok': False, 'error': 'EnvId 不能为空'}, 400)
                    if not sid or not skey:
                        return self.json({'ok': False, 'error': 'SecretId 与 SecretKey 都不能为空'}, 400)
                    if not re.match(r'^[a-z0-9][a-z0-9-]{0,59}$', env_id):
                        return self.json({'ok': False, 'error': 'EnvId 格式不正确（应为小写字母/数字/连字符）'}, 400)
                    # provider 字段必须落盘：CloudBaseProvider.configured() 用它区分"这份配置属于哪个渠道"。
                    save_cb_cfg({'provider': 'cloudbase', 'envId': env_id, 'secretId': sid,
                                 'secretKey': skey, 'region': region, 'path': sub})
                    return self.json({'ok': True, 'configured': True, 'provider': 'cloudbase',
                                      'envId': env_id, 'region': region, 'path': sub,
                                      'note': '已保存到本机。密钥只存在这台电脑，不会进入作品集数据或导出的 ZIP。'})
                return self.json({'ok': False, 'error': '未知 Provider：' + (provider_id or '(空)')}, 400)
            # —— CloudBase 只读探测：先查再说，避免重复创建环境 / 重复问用户 ——
            # 允许用「请求里带的临时凭证」或「本机已保存的凭证」查询；纯只读，不改任何资源。
            if route == '/api/cloudbase/probe':
                payload = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))) or b'{}')
                sid = str((payload or {}).get('secretId') or '').strip()
                skey = str((payload or {}).get('secretKey') or '').strip()
                if not (sid and skey):
                    saved = load_cb_cfg()
                    sid = sid or (saved.get('secretId') or '')
                    skey = skey or (saved.get('secretKey') or '')
                res = cb_probe_impl({'secretId': sid, 'secretKey': skey,
                                     'region': str((payload or {}).get('region') or 'ap-shanghai').strip()})
                return self.json({'ok': not res.get('error'), **res})
            if route == '/api/cloudbase/quota':
                payload = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))) or b'{}')
                saved = load_cb_cfg()
                env_id = str((payload or {}).get('envId') or '').strip() or (saved.get('envId') or '')
                sid = str((payload or {}).get('secretId') or '').strip() or (saved.get('secretId') or '')
                skey = str((payload or {}).get('secretKey') or '').strip() or (saved.get('secretKey') or '')
                res = cb_quota_impl({'envId': env_id, 'secretId': sid, 'secretKey': skey,
                                     'region': str((payload or {}).get('region') or 'ap-shanghai').strip()})
                return self.json(res)
            # —— 发布前权限体检：查清"能读环境但上传 Access Denied"到底缺哪一层权限。
            # 只读探测 + 一次 0 字节写入自检（写入后立即删除），不改变任何业务数据。
            # ⚠ 与 probe 同样支持"请求里带的临时凭证"或"本机已保存的凭证"。
            if route == '/api/cloudbase/permcheck':
                payload = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))) or b'{}')
                saved = load_cb_cfg()
                sid = str((payload or {}).get('secretId') or '').strip() or (saved.get('secretId') or '')
                skey = str((payload or {}).get('secretKey') or '').strip() or (saved.get('secretKey') or '')
                env_id = str((payload or {}).get('envId') or '').strip() or (saved.get('envId') or '')
                res = cb_permcheck_impl({'envId': env_id, 'secretId': sid, 'secretKey': skey,
                                         'region': str((payload or {}).get('region') or saved.get('region') or 'ap-shanghai').strip()})
                return self.json(res)
            # —— 真删除一条发布记录：本机记录 + 线上路径一起删（用户在面板里点「删除」）——
            # payload: {provider, tpl, path, remote: bool}。
            # ⚠ 2026-10-06 事故回归：remote 不再默认 true。只有显式 remote=true 才会删线上；
            #   缺失/null 一律只删本机记录；类型错误直接 400 拒绝（见 _parse_remote_flag）。
            if route == '/api/deploy/remove':
                payload = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))) or b'{}')
                provider_id = str((payload or {}).get('provider') or '').strip()
                tpl = str((payload or {}).get('tpl') or '').strip() or LEGACY_TPL_ID
                path_name = str((payload or {}).get('path') if (payload or {}).get('path') is not None else '').strip().strip('/')
                rm_ok, do_remote, rm_err = _parse_remote_flag(payload)
                if not rm_ok:
                    return self.json({'ok': False, 'error': rm_err}, 400)
                # 老客户端可能漏传 provider（记录里原本就没带）→ 用 (模板, 路径) 反查，唯一才采信。
                provider_id = resolve_provider(provider_id, tpl, path_name)
                if provider_id not in ('github', 'cloudbase'):
                    return self.json({'ok': False, 'error': '无法判断这条发布属于哪个平台（GitHub Pages / 腾讯云 CloudBase）。请刷新发布面板后重试，或用面板上的主按钮重新发布。'}, 400)
                deps = load_deployments()
                _, removed = remove_deployment(deps, provider_id, tpl, path_name)
                if not removed:
                    return self.json({'ok': False, 'error': '没有找到匹配的发布记录（可能已被删除）。'}, 404)
                remote_msg, remote_ok = '', True
                if do_remote:
                    # 删除也要进发布状态机：CloudBase 的 hosting delete 动辄十几秒，
                    # 不报进度的话用户只能盯着一个没变化的按钮怀疑"到底删没删"。
                    pub_job_begin('删除中', '正在删除线上 /%s/ …' % (path_name or ''))
                    try:
                        if provider_id == 'github':
                            cfg = load_gh_token()
                            token = (cfg.get('token') or '').strip()
                            meta = removed.get('meta') or {}
                            owner = str(meta.get('owner') or '').strip()
                            repo = str(meta.get('repoName') or '').strip()
                            if token and owner and repo:
                                remote_ok, remote_msg = gh_delete_repo_dir(token, owner, repo, path_name)
                            else:
                                remote_ok = False
                                remote_msg = '本机缺少该仓库的授权/仓库名，已只删本机记录；线上目录请到 GitHub 手动删除。'
                        else:
                            remote_ok, remote_msg = cloudbase_delete_dir(load_cb_cfg(tpl), path_name)
                    except Exception as e:
                        remote_ok, remote_msg = False, '删除线上失败：' + str(e)[:200]
                    finally:
                        # ⚠ 2026-09-25 审计修复：删除作业也要如实记录结果，
                        # 线上删除失败时状态面板不能再显示「成功」。
                        pub_job_end(bool(remote_ok), '' if remote_ok else str(remote_msg or '')[:300])
                # 线上删不掉时，给一个**能直接点进去手动删**的地址 —— 绝不让人对着一句报错干瞪眼。
                manual_url = ''
                if do_remote and not remote_ok:
                    if provider_id == 'github':
                        meta = removed.get('meta') or {}
                        _o = str(meta.get('owner') or '').strip()
                        _r = str(meta.get('repoName') or '').strip()
                        if _o and _r:
                            manual_url = 'https://github.com/%s/%s/tree/main/%s' % (_o, _r, path_name)
                        else:
                            manual_url = 'https://github.com/'
                    else:
                        _cfg = load_cb_cfg(tpl) or {}
                        _env = str(_cfg.get('envId') or '').strip()
                        manual_url = ('https://console.cloud.tencent.com/tcb/hosting?envId=' + _env) if _env \
                            else 'https://console.cloud.tencent.com/tcb'
                # 本机记录：无论线上是否删成功都移除（记录留着只会让用户困惑）；
                # 但若线上没删掉，如实告知，让用户知道线上可能仍在。
                # ⚠ 用操作式删除（线程安全、且不会因传入"不完整列表"而误删别的渠道记录）。
                save_deployment_remove(provider_id, tpl, path_name)
                return self.json({'ok': True, 'removed': True, 'remoteOk': remote_ok,
                                  'remoteMessage': remote_msg, 'manualUrl': manual_url,
                                  'message': ('已删除记录' + ('，线上路径也已删除。' if (do_remote and remote_ok)
                                              else ('；但线上删除未完成：' + remote_msg if do_remote else '。')))})
            # —— 改发布目标：保留这条记录的地址与配置，把内容换成另一个模板更新发布 ——
            # payload: {provider, tpl(原), path, newTpl}
            if route == '/api/deploy/retarget':
                payload = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))) or b'{}')
                provider_id = str((payload or {}).get('provider') or '').strip()
                old_tpl = str((payload or {}).get('tpl') or '').strip() or LEGACY_TPL_ID
                path_name = str((payload or {}).get('path') if (payload or {}).get('path') is not None else '').strip().strip('/')
                new_tpl = str((payload or {}).get('newTpl') or '').strip()
                # 老客户端可能漏传 provider → 用 (模板, 路径) 反查，唯一才采信。
                provider_id = resolve_provider(provider_id, old_tpl, path_name)
                if provider_id not in ('github', 'cloudbase'):
                    return self.json({'ok': False, 'error': '无法判断这条发布属于哪个平台（GitHub Pages / 腾讯云 CloudBase）。请刷新发布面板后重试，或用面板上的主按钮重新发布。'}, 400)
                if not new_tpl or not tpl_exists(new_tpl):
                    return self.json({'ok': False, 'error': '目标模板不存在：' + (new_tpl or '(空)')}, 400)
                deps = load_deployments()
                # 精确找到这条记录
                idx = None
                for i, it in enumerate(deps):
                    if (str(it.get('provider') or '').strip() == provider_id
                            and (str(it.get('tpl') or LEGACY_TPL_ID).strip() or LEGACY_TPL_ID) == old_tpl
                            and str(it.get('path') if it.get('path') is not None else '').strip().strip('/') == path_name):
                        idx = i
                if idx is None:
                    return self.json({'ok': False, 'error': '没有找到匹配的发布记录。'}, 404)
                try:
                    _nm = next((it.get('name') for it in (load_templates().get('items') or [])
                                if it.get('id') == new_tpl), None) or new_tpl
                    pub_job_begin('发布中', '正在把 /%s/ 的内容更新为「%s」…' % (path_name, _nm))
                    # ⚠ force_path=path_name 是这次修复的关键：
                    # 旧实现只传 path_name（非强制），publish_core 会拿 new_tpl 去查它自己的记录，
                    # 于是内容被发到**新模板自己**的地址上，用户点名要改的地址一动不动
                    # —— 界面表现就是「点了按钮，什么都没发生」。
                    res = publish_core(provider_id, new_tpl, mode='update',
                                       path_name=path_name, force_path=path_name)
                    pub_job_end(bool(res.get('ok')))
                    if not res.get('ok'):
                        return self.json({'ok': False, 'error': res.get('error') or '更新失败'}, 502)
                    # 记录已由 publish_core 按 (provider, path) 就地覆盖成新模板，
                    # 这里再兜一次底：万一原模板在别的路径还挂着旧记录，不动它（那是它自己的地址）。
                    return self.json({'ok': True, 'url': res.get('url'), 'provider': provider_id,
                                      'tpl': new_tpl, 'tplName': _nm, 'path': path_name})
                except Exception as e:
                    pub_job_end(False, str(e)[:300])
                    return self.json({'ok': False, 'error': '更新失败：' + str(e)[:200]}, 500)
            if route == '/api/deploy/public':
                payload = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))) or b'{}')
                provider_id = str((payload or {}).get('provider') or '').strip()
                if not provider_id:
                    return self.json({'ok': False, 'error': '请指定要发布到的平台'}, 400)
                if provider_id not in PUBLISH_PROVIDERS:
                    return self.json({'ok': False, 'error': '未知 Provider：' + provider_id}, 400)
                # 未配置对应 Provider → 拦住，绝不触网、绝不误以为发布成功
                if provider_id == 'github' and not gh_configured():
                    return self.json({'ok': False, 'setupRequired': True, 'provider': 'github',
                                      'error': '尚未连接 GitHub。请在发布面板「③ 公开链接」选择 GitHub Pages 并点「连接 GitHub」。'})
                if provider_id == 'cloudbase' and not PUBLISH_PROVIDERS['cloudbase'].configured(load_cb_cfg()):
                    return self.json({'ok': False, 'setupRequired': True, 'provider': 'cloudbase',
                                      'error': '尚未配置 CloudBase。请在发布面板填入 EnvId 与 SecretId / SecretKey（需要自己的腾讯云账号）。'})
                # ⚠ tpl 优先取 payload.tpl，其次才回落 URL query（self._tpl 只认 query）。
                # 客户端曾漏传 tpl → 发布永远落到 'main'，表现为「选模板二却发成模板一」。
                _ptpl = str((payload or {}).get('tpl') or '').strip()
                if _ptpl and TPL_ID_RE.match(_ptpl) and tpl_exists(_ptpl):
                    tpl = _ptpl
                else:
                    tpl = self._tpl()
                mode = str((payload or {}).get('mode') or 'update').strip().lower()
                path_name = str((payload or {}).get('path') or '').strip()
                try:
                    pub_job_begin('发布中', '正在准备发布 FolioFold…')
                    res = publish_core(provider_id, tpl, mode=mode, path_name=path_name)
                    # ⚠ 2026-09-25 审计修复（BUG-1）：publish_core 捕获 GHError/CBError 后
                    # 返回 {'ok': False, ...} 而不是抛异常 —— 旧代码这里无条件 pub_job_end(True)，
                    # 结果是「HTTP 响应报了失败、作业状态却记录成功」：
                    # /api/deploy/status 的 publish.ok=true、error=''，面板状态与事实相反。
                    # 实测复现：无效 token 发布 → HTTP 502 + 状态面板 ok:true。
                    pub_job_end(bool(res.get('ok')), str(res.get('error') or '')[:300])
                    if not res.get('ok'):
                        code = 502 if res.get('code') in (401, 403, 404, 409, 422) else (500 if not res.get('mediaBlocked') else 200)
                        return self.json(res, code)
                    return self.json({'ok': True, 'url': res['url'], 'provider': provider_id,
                                      'subPath': res.get('subPath') or '',
                                      'mode': mode,
                                      'projectName': res.get('repoName') or res.get('projectName') or '',
                                      'files': res.get('files'), 'mediaCopied': res.get('mediaCopied'),
                                      'largeMedia': res.get('largeMedia', 0),
                                      'mediaPending': res.get('mediaPending', 0),
                                      'warnings': res.get('warnings') or [],
                                      'releaseFailed': res.get('releaseFailed') or []})
                except Exception as e:
                    pub_job_end(False, str(e)[:300])
                    return self.json({'ok': False, 'error': '发布失败：' + str(e)[:200]}, 500)
            if route == '/api/ai/parse':
                payload = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))))
                return self.json({'ok': True, 'result': parse_with_ai(payload)})
            if route == '/api/ai/category':
                payload = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))))
                return self.json({'ok': True, 'result': parse_category(payload)})
            if route == '/api/media/plan':
                payload = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))) or b'{}')
                return self.json(compress_sample_plan(payload.get('url') or '', payload.get('preset') or 'balanced'))
            if route == '/api/media/compress':
                payload = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))) or b'{}')
                return self.json(compress_start(payload.get('url') or '',
                                                payload.get('preset') or 'balanced',
                                                self.tpl_qs() or ''))
            if route == '/api/media/compress/cancel':
                _COMPRESS['cancelled'] = True
                return self.json({'ok': True})
            if route == '/api/media/web-previews':
                # 列出与当前媒体同目录下的所有 Web Preview 变体（*-web*.mp4），供编辑器「选择版本」。
                u = parse_qs(urlparse(self.path).query).get('url', [''])[0]
                if not u:
                    try:
                        _b = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0') or b'{}')) or b'{}')
                        u = (_b or {}).get('url') or ''
                    except Exception:
                        pass
                return self.json(list_web_previews(u))
            if route == '/api/media/ffmpeg/download':
                # 一键装压缩组件：从 PyPI 拉 imageio-ffmpeg 的 wheel（约 30MB，内含 ffmpeg 静态版），
                # 解出 ffmpeg.exe 放到 .folioframe/tools/。纯标准库实现，不需要用户装 Python 包。
                try:
                    req = urllib.request.Request('https://pypi.org/pypi/imageio-ffmpeg/json',
                                                 headers={'User-Agent': 'FolioFold'})
                    meta = json.loads(net_urlopen(req, timeout=45).read().decode())
                    wheel = ''
                    for f in meta.get('urls') or []:
                        n = f.get('filename') or ''
                        if n.endswith('.whl') and 'win_amd64' in n:
                            wheel = f.get('url') or ''
                            break
                    if not wheel: return self.json({'ok': False, 'error': '没找到适用于 Windows 的组件包'}, 502)
                    raw = net_urlopen(urllib.request.Request(wheel, headers={'User-Agent': 'FolioFold'}),
                                                timeout=300).read()
                    FFMPEG_DIR.mkdir(parents=True, exist_ok=True)
                    with zipfile.ZipFile(io.BytesIO(raw)) as z:
                        names = [n for n in z.namelist() if n.startswith('imageio_ffmpeg/binaries/ffmpeg-') and n.endswith('.exe')]
                        if not names: return self.json({'ok': False, 'error': '组件包里没有 ffmpeg 可执行文件'}, 502)
                        with z.open(names[0]) as srcf, FFMPEG_EXE.open('wb') as dstf:
                            shutil.copyfileobj(srcf, dstf, 1024 * 1024)
                    return self.json({'ok': True, 'path': str(FFMPEG_EXE), 'found': bool(ffmpeg_path())})
                except Exception as e:
                    return self.json({'ok': False, 'error': '组件下载失败：' + str(e)[:180]}, 502)
            if route == '/api/upload':
                form = cgi.FieldStorage(fp=self.rfile, headers=self.headers, environ={'REQUEST_METHOD': 'POST', 'CONTENT_TYPE': self.headers['Content-Type']})
                item = form['file']; kind = re.sub(r'[^a-zA-Z0-9_-]', '', form.getfirst('kind', 'projects')) or 'projects'
                if not getattr(item, 'filename', ''): return self.json({'error': 'No file selected'}, 400)
                folder = MEDIA / kind; folder.mkdir(parents=True, exist_ok=True); target = folder / Path(item.filename).name; stem = target.stem; n = 1
                while target.exists(): target = folder / f'{stem}-{n}{target.suffix}'; n += 1
                with target.open('wb') as out: shutil.copyfileobj(item.file, out, 1024 * 1024)
                ref = media_ref(target, item.type or '')
                # 浏览器无法解码的容器（ProRes/MOV 等）上传成功但前台会播不了，这里提前告知，
                # 前端据此给出明确提示，而不是插进去一个永远黑屏的播放器。
                warn = ''
                if target.suffix.lower() in BROWSER_UNPLAYABLE:
                    warn = f'{target.suffix.upper()} 这类封装浏览器无法直接播放，前台会显示为"格式不受支持"。建议改用 MP4 / WebM（或 H.264 编码的 MOV），也可用「外部视频链接」。'
                # 视频额外做一次真实体检：把"发布到公网会怎样"在上传那一刻就讲清楚。
                # 超 90MB → 会走 Release 附件 → 只能下载不能内联播放；这是最容易被误解成"上传失败"的情况。
                probe = None
                if target.suffix.lower() in ('.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi'):
                    probe = ff_probe_url(ref['url'])
                    if probe:
                        extra = media_publish_warning(probe)
                        if extra: warn = (warn + ' ' if warn else '') + extra
                return self.json({'ok': True, **ref, 'warn': warn, 'probe': probe})
        except Exception as error: return self.json({'error': str(error)}, 400)
        except SystemExit:
            # 环境里的 safe-delete 钩子在守卫失效时会 raise SystemExit(1)。SystemExit 不是
            # Exception，不接住它会让这个请求线程静默死掉，客户端只会看到
            # "Empty reply from server"（curl 报 HTTP 000）—— 比报错难查得多。
            # 如实回一个 500 文本，别装作没发生。
            return self.json({'error': '删除被环境安全层拦截（SystemExit），本次操作未完成'}, 500)
        return self.json({'error': 'Not found'}, 404)

if __name__ == '__main__':
    MEDIA.mkdir(parents=True, exist_ok=True)
    # Clone 开箱体验：首次启动且无个人 main 数据时，从内置 FolioFold Starter（tpl-3）初始化，保证开箱即见 Starter
    seed_main_from_demo()
    if DRAFT.exists(): write(DRAFT, normalize(read(DRAFT)))
    if not PUBLISHED.exists() and DRAFT.exists(): write(PUBLISHED, normalize(read(DRAFT)))
    # 播种模板注册表（首次启动会生成 content/templates.json，内含「模板一」= 现有数据）
    load_templates()
    try:
        cleanup_stale_bundles()
    except Exception:
        pass
    # 出网体检：先确认系统代理到底能不能用，不可达就立刻降级为直连。
    # 不做这一步的话，只要 Windows 代理设置里留着一个已经没在跑的端口，
    # GitHub Pages 与 CloudBase 就会同时全线发布失败（[WinError 10061]）。
    try:
        _ns = net_refresh(force=True)
        if _ns.get('downgraded'):
            print('FolioFold 出网：' + (_ns.get('note') or '已改为直连'))
    except Exception:
        pass
    print('FolioFold: http://localhost:3000  （模板一 ' + LEGACY_TPL_ID + ' 为现有数据，不改动）')
    # 启动即做一次发布记录自愈：从历史找回可能因异常写入弄丢的记录（详见 heal_deployments）。
    def _startup_heal():
        try:
            time.sleep(1)
            heal_deployments()
        except Exception:
            pass
    try:
        threading.Thread(target=_startup_heal, daemon=True).start()
    except Exception:
        pass
    # 写 PID 文件（仅本机运行态，gitignored），供启动/停止脚本精确识别本进程，避免误杀其他 Python。
    _pid_file = ROOT / '.foliofold.pid'
    try:
        _pid_file.write_text(str(os.getpid()), encoding='utf-8')
    except Exception:
        pass
    try:
        ThreadingHTTPServer(('127.0.0.1', 3000), Handler).serve_forever()
    finally:
        try:
            _pid_file.unlink(missing_ok=True)
        except Exception:
            pass
