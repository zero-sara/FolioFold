# -*- coding: utf-8 -*-
"""UI 语言覆盖检测（B 线 i18n）。

扫各 UI surface 的 JS/HTML 源码，提取「会被翻译管线看到」的中文候选串：
  · JS 字符串字面量 / 模板串静态片段（剥掉 ${...}；剥 HTML 标签取文本节点片段）
  · HTML 文本节点 + title/placeholder/aria-label 属性
对照「精确表 zh.json + 正则表 patterns.json」输出缺词清单（供补词），
并统计 zh.json 各语言键覆盖率（供报告）。

用法：python tools/i18n/check_coverage.py [--json OUT]
退出码：有缺词 = 2，全绿 = 0。

已知局限（有意为之）：
  · 静态扫描不知道「这句会不会真的渲染」，会多报（动态拼接整句以 patterns 覆盖为准）；
    真值以运行时采集（collect_dom_strings.cjs → build_dict.py）+ qa/i18n-language-sweep.cjs 为准。
  · i18n.js 自身是词典（UI 表的 key 就是中文），不扫。
"""
import io
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))

SURFACES = {
    'Studio外壳':      ['index.html', 'studio/studio.html', 'studio/studio.js'],
    'ContentEditor':   ['editor/index.html', 'editor/editor-v3.js'],
    'VisualEditor':    ['visual-editor/index.html', 'visual-editor/visual-editor-fix.js', 'visual-editor/ve-runtime.js'],
    'Portfolio画布':   ['portfolio/index.html', 'app-v3.js'],
    '共享组件':        ['sections.js'],
}

CJK = re.compile(r'[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af\u3000-\u303f\uff01-\uff5e]')
# 看起来像代码而不是文案的片段（在剥掉 ${...} 与 HTML 标签之后）
CODEY = re.compile(r'(=>|;\s|\bconst\b|\breturn\b|\bif\b|\bfunction\b|===|&&|\|\||\bnew\b|`|\{|\})')
STR_LIT = re.compile(r'"((?:[^"\\\n]|\\.)*)"|\'((?:[^\'\\\n]|\\.)*)\'|`((?:[^`])*)`')
TAG = re.compile(r'<[^>]+>')


def strip_comments_js(text):
    out, i, n = [], 0, len(text)
    in_block = False
    while i < n:
        if in_block:
            j = text.find('*/', i)
            if j < 0:
                out.append('\n' * text[i:].count('\n'))
                break
            out.append(' ')
            out.append('\n' * text[i:j + 2].count('\n'))
            i = j + 2
            in_block = False
            continue
        c = text[i]
        if c == '/' and i + 1 < n and text[i + 1] == '*':
            in_block = True
            i += 2
            continue
        if c == '/' and i + 1 < n and text[i + 1] == '/':
            j = text.find('\n', i)
            if j < 0:
                break
            i = j
            continue
        if c == '"' or c == "'" or c == '`':
            q = c
            out.append(c)
            i += 1
            while i < n:
                if text[i] == '\\':
                    out.append(text[i:i + 2])
                    i += 2
                    continue
                out.append(text[i])
                if text[i] == q:
                    i += 1
                    break
                i += 1
            continue
        out.append(c)
        i += 1
    return ''.join(out)


def text_frags(raw):
    """把候选串（可能含 HTML 标签）拆成文本节点片段。"""
    parts = []
    if '<' in raw and '>' in raw:
        # HTML 串：剥标签取文本节点（与 MutationObserver 的视角一致）
        for seg in TAG.split(raw):
            seg = seg.strip()
            if seg and CJK.search(seg):
                parts.append(seg)
    else:
        parts.append(raw.strip())
    return parts


def extract_frags_js(text):
    text = strip_comments_js(text)
    frags = []
    for m in STR_LIT.finditer(text):
        line = text[:m.start()].count('\n') + 1
        raw = m.group(1) if m.group(1) is not None else (m.group(2) if m.group(2) is not None else m.group(3))
        if not raw or not CJK.search(raw):
            continue
        for part in re.split(r'\$\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}', raw):
            for frag in text_frags(part):
                if CODEY.search(frag):
                    continue
                frags.append((frag, line))
    return frags


def extract_frags_html(text):
    text = re.sub(r'<!--.*?-->', ' ', text, flags=re.S)
    frags = []
    for m in re.finditer(r'(?:title|placeholder|aria-label)="([^"]*)"', text):
        v = m.group(1)
        if CJK.search(v):
            frags.append((v.strip(), text[:m.start()].count('\n') + 1))
    for m in re.finditer(r'<script[^>]*>([\s\S]*?)</script>', text):
        frags.extend(extract_frags_js(m.group(1)))
    body = re.sub(r'<script[\s\S]*?</script>', ' ', text)
    for m in TAG.finditer(body):
        pass
    # 文本节点 = 标签之间的内容
    pos = 0
    for m in TAG.finditer(body):
        seg = body[pos:m.start()]
        pos = m.end()
        seg = seg.strip()
        if seg and CJK.search(seg):
            frags.append((seg, body[:m.start()].count('\n') + 1))
    return frags


def main():
    zh = json.load(io.open(os.path.join(HERE, 'zh.json'), encoding='utf-8'))
    pats = json.load(io.open(os.path.join(HERE, 'patterns.json'), encoding='utf-8'))
    pat_srcs = [p['src'] for p in pats]

    def covered(s):
        if s in zh:
            return True
        return any(re.search(src, s) for src in pat_srcs)

    total_missing = 0
    out_json = {}
    for name, files in sorted(SURFACES.items()):
        misses = {}
        for rel in files:
            path = os.path.join(ROOT, rel)
            if not os.path.exists(path):
                continue
            text = io.open(path, encoding='utf-8').read()
            frags = extract_frags_html(text) if rel.endswith('.html') else extract_frags_js(text)
            for frag, line in frags:
                if not covered(frag):
                    misses.setdefault(frag, []).append('%s:%d' % (rel, line))
        out_json[name] = sorted(misses)
        if misses:
            print('\n[%s] 缺词 %d 条' % (name, len(misses)))
            for frag, locs in sorted(misses.items(), key=lambda x: -len(x[1])):
                print('  ✗ %s   ← %s' % (frag[:66].replace('\n', '⏎'), ', '.join(locs[:2])))
            total_missing += len(misses)
        else:
            print('[%s] ✓ 全覆盖' % name)

    # 各语言键覆盖率
    langs = ['en', 'zh-TW', 'ja', 'ko', 'fr', 'es', 'it', 'de', 'pt']
    keys = [k for k in zh if not k.startswith('_')]
    print('\n===== zh.json 键覆盖率（%d 键）=====' % len(keys))
    for l in langs:
        if l == 'en':
            print('  %-6s %d/%d = 100.0%%（zh.json 值本身）' % (l, len(keys), len(keys)))
            continue
        d = json.load(io.open(os.path.join(HERE, 'zh.%s.json' % l), encoding='utf-8'))
        have = sum(1 for k in keys if d.get(k))
        print('  %-6s %d/%d = %.1f%%' % (l, have, len(keys), 100.0 * have / len(keys)))
    print('\n===== 静态扫描总缺词： %d 条 =====' % total_missing)
    if '--json' in sys.argv:
        outp = sys.argv[sys.argv.index('--json') + 1]
        io.open(outp, 'w', encoding='utf-8').write(json.dumps(out_json, ensure_ascii=False, indent=1))
        print('缺词清单已写 ' + outp)
    sys.exit(2 if total_missing else 0)


if __name__ == '__main__':
    main()
