#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""幂等迁移：清掉像素形象里**近白色的游离方块**（暗色主题下会变成刺眼的白点）。

背景（2026-09-25）：小恐龙预设的像素网格末尾原来是 `.ksssskttt`，palette 里多一个
`t:'#f4f4f4'` —— 尾巴右侧挂着 3 个近白方块。浅色页面上看不出来，暗色主题下就是
「形象周围有 3 个白的像素点」。源头已在 `visual-editor/visual-editor.js` 的 AVATAR_PRESETS
里删掉；**但已有数据存的是生成的 SVG 快照**（profile.avatar.src 是一整串 data URI），
所以还得把存量数据也清一遍 —— 否则老模板、老发布包里那 3 个点依旧在。

为什么走 /api/save 而不是直接改 content/*.json：
    项目铁律 —— 绝不直改 content/portfolio.json，必须走 API，让服务端自己 normalize。
    直改会绕过双闸门与 schema 归一，容易埋出"数据看着对、渲染不对"的坑。

幂等：只处理 `profile.avatar.src` 里**确实含近白色填充**的情况；处理完再跑一次，
匹配不到就什么都不做（脚本会明确打印 no-op）。
"""
import json
import re
import sys
import urllib.parse
import urllib.request

BASE = 'http://127.0.0.1:3000'
# ⚠ 只清"生成器用过的那个近白色"。#ffffff 不能碰 —— 机器人/小幽灵的**眼睛**是纯白，
#   那是形象内部的正常细节，清掉就把脸挖空了。
NEAR_WHITE = ('#f4f4f4', '#f5f5f5', '#fafafa', '#fefefe')
RECT_RE = re.compile(r'<rect\b[^>]*/>')


def api(path, method='GET', payload=None):
    data = json.dumps(payload, ensure_ascii=False).encode('utf-8') if payload is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode('utf-8'))


def clean_svg_data_uri(src):
    """返回 (新 src, 删掉几个方块)。不是 svg data URI 或没有近白方块 → 原样返回。"""
    if not isinstance(src, str) or not src.startswith('data:image/svg+xml'):
        return src, 0
    head, sep, body = src.partition(',')
    if not sep:
        return src, 0
    svg = urllib.parse.unquote(body)
    removed = 0

    def repl(m):
        nonlocal removed
        tag = m.group(0)
        fill = re.search(r'fill="([^"]+)"', tag)
        if fill and fill.group(1).strip().lower() in NEAR_WHITE:
            removed += 1
            return ''
        return tag

    svg = RECT_RE.sub(repl, svg)
    if not removed:
        return src, 0
    return head + ',' + urllib.parse.quote(svg, safe=''), removed


def main():
    tpls = [t['id'] for t in api('/api/templates')['items']]
    total = 0
    for tpl in tpls:
        data = api('/api/data?tpl=' + urllib.parse.quote(tpl))
        av = ((data.get('profile') or {}).get('avatar')) or {}
        src = av.get('src')
        new_src, removed = clean_svg_data_uri(src)
        if not removed:
            print('%-10s 无需处理（没有近白游离方块）' % tpl)
            continue
        av['src'] = new_src
        data.setdefault('profile', {})['avatar'] = av
        api('/api/save?tpl=' + urllib.parse.quote(tpl), 'POST', data)
        total += removed
        print('%-10s 清掉 %d 个近白方块' % (tpl, removed))
    print('---- 合计清理 %d 个方块（preset=%s）----' % (total, 'dino'))
    # 收尾自检：再读一次确认已经干净（幂等性的证明）
    for tpl in tpls:
        data = api('/api/data?tpl=' + urllib.parse.quote(tpl))
        src = (((data.get('profile') or {}).get('avatar')) or {}).get('src') or ''
        leftover = 0
        if src.startswith('data:image/svg+xml'):
            svg = urllib.parse.unquote(src.partition(',')[2])
            leftover = len([t for t in RECT_RE.findall(svg)
                            if (re.search(r'fill="([^"]+)"', t) or [None, ''])[1].lower() in NEAR_WHITE])
        print('  %-10s 复检残留 = %d' % (tpl, leftover))
    return 0


if __name__ == '__main__':
    sys.exit(main())
