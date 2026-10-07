# -*- coding: utf-8 -*-
"""把界面文案字典编译成项目根目录的 i18n-zh-en.js（多语言版）。

输入（都在本目录）：
  zh.json          中文 -> 英文（精确匹配）。**主要维护的就是这个文件。**
  zh.<lang>.json   中文 -> 该语言（精确匹配）。目前有 ja / ko，由 mt_fill.py 生成后人工过一遍。
  patterns.json    带变量的句子：一条一段落 {src, en, ja, ko?}，顺序即匹配顺序（越具体越靠前）。
  dom-snapshot.txt 真实界面抓下来的文案快照，用来做覆盖率体检（可选）。

输出：
  <项目根>/i18n-zh-en.js
    window.FF_ZH_I18N = { en:{...}, ja:{...}, ko:{...} };
    window.FF_ZH_PATTERNS_I18N = { en:[[re,repl],...], ja:[...], ko:[...] };
    window.FF_ZH_EN / window.FF_ZH_PATTERNS  —— 旧名字，保留给外部脚本。

约定（很重要，别破坏）：
  · 只收「产品界面文案」。用户自己写的作品内容一律不进 —— 运行时的查表是整串精确匹配，
    一旦把用户内容放进来就会把人家写的东西翻掉。用户内容的翻译走另一条链路
    （服务端整篇翻译，见 /api/translate/content）。
  · 某个语言缺词时**整段回退**：ja/ko 先退英文 patterns，再退中文原文。
    所以宁可整份不翻（显示英文）也不要半份翻（中英混排）。
  · 正则一律用 new RegExp(JSON 字符串) 生成，不写 /.../  字面量 ——
    模式里出现斜杠（例如「大小 / 移动」）会当场截断字面量，生成语法错误的文件，
    症状是"字典整份没加载"，极难查。

用法：python tools/i18n/build_dict.py
改完记得 bump 四个 html 里 i18n-zh-en.js 与 i18n.js 的 ?v=。
"""
import io
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))          # tools/i18n -> 项目根
SRC = os.path.join(HERE, 'zh.json')
PATTERNS = os.path.join(HERE, 'patterns.json')
OUT = os.path.join(ROOT, 'i18n-zh-en.js')
DOM = os.path.join(HERE, 'dom-snapshot.txt')
# 除英文外的其它语言（精确表 + 正则表都按这个列表找）
# 2026-09-23：日语 / 韩语正式启用。数据源：zh.ja.json / zh.ko.json（433 条）+ patterns.json 的 ja/ko 字段（119 条）。
# 2026-09-26：10 语言正式实施 —— 增 zh-TW / fr / es / it / de / pt（zh.*.json 由 gen_langs.py 生成，patterns 由 gen_patterns.py 扩列）。
EXTRA_LANGS = ['zh-TW', 'ja', 'ko', 'fr', 'es', 'it', 'de', 'pt']

# 明确不进字典的界面文案：
#   · 由键值层（UI['zh-CN']/['en'] + data-i18n）负责的导航文案 —— 它们同时也出现在
#     用户作品内容里，放进字典会把用户写的内容一起翻掉。
NEVER = {'排版编辑', '文本编辑'} | {
    # 快照里混进来的**用户自己写的内容**（技能 / 技术栈 textarea 里的词表）。
    # 它们不该进词典：运行时查表是整串精确匹配，混进来会把用户写的简历正文翻掉。
    # 由 tools/i18n/collect_dom_strings.cjs 抓界面文案时一并抓进来的，这里显式排除。
    # 2026-09-26：语言自名 —— 语言下拉里的选项在任何界面语言下都保持自己的写法，不翻。
    "中文", "English", "日本語", "한국어", "繁體中文",
    "Français", "Español", "Italiano", "Deutsch", "Português",
    # 文件名（不该翻、也不该进词典）
    "FolioFold 修复.bat",
    "FolioFold 启动.bat",
}
# ⚠ 隐私红线：本集合**只允许放中性的界面文案 / 语言名 / 程序文件名**。
#    曾经这里混进了创作者本人的简历正文（学校、GPA、课程、技能词表），
#    而本仓库是公开的 —— 等于把私人资料发上了 GitHub。
#    用户自己的内容应由用户本机处理，**绝不可**把真实内容写进这里。


def load_json(path, default=None):
    try:
        return json.load(io.open(path, encoding='utf-8'))
    except FileNotFoundError:
        return default
    except Exception as e:
        print('!! 读取 %s 失败：%s' % (path, e))
        return default


def emit_table(rows):
    """rows: [(key, value)] -> JS 对象字面量行"""
    out = []
    for k, v in sorted(rows, key=lambda kv: (len(kv[0]), kv[0])):
        out.append('    %s: %s,' % (json.dumps(k, ensure_ascii=False), json.dumps(v, ensure_ascii=False)))
    return '\n'.join(out)


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    zh = {k: v for k, v in (load_json(SRC, {}) or {}).items() if not k.startswith('_')}
    patterns = load_json(PATTERNS, []) or []

    # —— 精确表：每个语言一份 ——
    exact_by_lang = {'en': zh}
    for lang in EXTRA_LANGS:
        extra = load_json(os.path.join(HERE, 'zh.%s.json' % lang), {}) or {}
        # 只收源键在英文表里存在的条目，避免出现"翻了一条没人在用的中文"
        exact_by_lang[lang] = {k: v for k, v in extra.items() if k in zh and isinstance(v, str) and v.strip()}

    tables = []
    for lang in ['en'] + EXTRA_LANGS:
        rows = exact_by_lang[lang]
        tables.append('  %s: {\n%s\n  },' % (json.dumps(lang), emit_table(rows.items())))

    # —— 正则表：按语言。某个语言没翻全就整份不发（运行时自动回退到英文表）——
    pat_blocks = []
    for lang in ['en'] + EXTRA_LANGS:
        rows = []
        complete = True
        for it in patterns:
            if lang == 'en':
                rep = it.get('en') or ''
            else:
                rep = it.get(lang) or ''
                if not rep.strip():
                    complete = False
                    break
            rows.append(it['src'] + '\x00' + rep)
        if not complete:
            print('  · %s 的正则表没翻全 -> 整份不生成，运行时回退英文' % lang)
            pat_blocks.append('  %s: [],' % json.dumps(lang))
            continue
        body = []
        for row in rows:
            src, rep = row.split('\x00', 1)
            body.append('    [new RegExp(%s), %s],' % (json.dumps(src, ensure_ascii=False), json.dumps(rep, ensure_ascii=False)))
        pat_blocks.append('  %s: [\n%s\n  ],' % (json.dumps(lang), '\n'.join(body)))

    js = (
        '/* FolioFold 界面文案字典（中文当 key，多语言）。**生成物，不要手改。**\n'
        ' *\n'
        ' * 由 tools/i18n/build_dict.py 从 tools/i18n/{zh.json, zh.ja.json, zh.ko.json, patterns.json} 生成。\n'
        ' * 改中文文案 -> 改 zh.json；改日韩 -> 改 zh.ja.json / zh.ko.json（或跑 tools/i18n/mt_fill.py 先用\n'
        ' * 本地 Ollama 机翻一遍再人工校对）；改带变量的句子 -> 改 patterns.json。\n'
        ' *\n'
        ' * 运行时怎么用（见 i18n.js）：\n'
        ' *   z("主题")            -> 按当前语言翻一个字符串；查不到原样返回中文。\n'
        ' *   FF_ZH_I18N[lang]     精确表；FF_ZH_PATTERNS_I18N[lang] 正则表（顺序敏感）。\n'
        ' *   日韩缺词自动回退英文表，绝不出现空白或乱码。\n'
        ' */\n'
        '(function (global) {\n'
        "  'use strict';\n"
        '  global.FF_ZH_I18N = {\n' + '\n'.join(tables) + '\n  };\n'
        '  global.FF_ZH_PATTERNS_I18N = {\n' + '\n'.join(pat_blocks) + '\n  };\n'
        '  // 旧名字（外部脚本可能单独取英文表）\n'
        '  global.FF_ZH_EN = global.FF_ZH_I18N.en;\n'
        '  global.FF_ZH_PATTERNS = global.FF_ZH_PATTERNS_I18N.en;\n'
        '})(window);\n'
    )
    io.open(OUT, 'w', encoding='utf-8', newline='\n').write(js)
    counts = '，'.join('%s %d 条' % (l, len(exact_by_lang[l])) for l in ['en'] + EXTRA_LANGS)
    print('已写出 %s：精确 %s；正则 %d 条' % (OUT, counts, len(patterns)))

    # —— 覆盖率检查：真实界面收到的文案里，还有多少没翻 ——
    raw = None
    try:
        raw = io.open(DOM, encoding='utf-8').read()
    except Exception as e:
        print('（跳过覆盖率检查：%s）' % e)
    if raw:
        try:
            rows = json.loads(re.search(r'JSON=(\[.*\])\s*$', raw, re.S).group(1))
        except Exception as e:
            print('（覆盖率快照解析失败：%s）' % e)
            return
        blob = '\n'.join(io.open(p, encoding='utf-8').read() for p in [
            os.path.join(ROOT, 'content', 'portfolio.json'),
            os.path.join(ROOT, 'content', 'templates', 'tpl-2', 'portfolio.json')] if os.path.exists(p))

        # ⚠ 排除「用户自己写的内容」必须精确，不能只看长度。
        # 旧判据是「长度 >= 8 且整串能在内容 JSON 里找到」—— 于是**短的用户内容**
        # （片名《示例作品》、公司名「示例公司」、导演名）全都落到「缺失」里，
        # 报告里真缺的界面文案被这些噪声淹掉（2026-09-23 实测：154 条"缺失"里一多半是用户内容）。
        # 现在先做一次「精确等于内容 JSON 里某个字符串值」的判定（任意长度），
        # 再用原来的前缀启发式兜住「界面文案 + 用户内容」拼接出来的长句。
        def collect_strings(paths):
            vals = set()

            def walk(x):
                if isinstance(x, str):
                    vals.add(x.strip())
                elif isinstance(x, dict):
                    for v in x.values():
                        walk(v)
                elif isinstance(x, list):
                    for v in x:
                        walk(v)
            for p in paths:
                try:
                    walk(json.load(io.open(p, encoding='utf-8')))
                except Exception:
                    pass
            return vals

        content_values = collect_strings([p for p in [
            os.path.join(ROOT, 'content', 'portfolio.json'),
            os.path.join(ROOT, 'content', 'templates', 'tpl-2', 'portfolio.json')] if os.path.exists(p)])

        # 还有一层翻译机制：i18n.js 里的键值表 UI['zh-CN']/['en'] + data-i18n（导航、状态、
        # 翻译面板、底部状态条…）。这些文案**故意不进字典**（它们同时会出现在用户作品内容里，
        # 放进字典会连用户写的内容一起翻掉）。但界面抓取抓到的是渲染后的中文，
        # 于是它们全被算成"缺失"，把真缺口淹掉（2026-09-23 实测：128 条"缺失"里 100+ 条是这类）。
        # 这里把键值表的 zh-CN 值整体读出来，判定为"已由另一层覆盖"。
        def ui_layer_values():
            try:
                src = io.open(os.path.join(ROOT, 'i18n.js'), encoding='utf-8').read()
            except Exception:
                return set()
            m = re.search(r'const UI = \{(.*?)\n  \};', src, re.S)
            if not m:
                return set()
            zh_seg = m.group(1).split("'en'")[0]
            return set(re.findall(r"'[^']*'\s*:\s*'([^']*[\u4e00-\u9fff][^']*)'", zh_seg))

        ui_covered = ui_layer_values()
        miss = []
        for item in rows:
            k, where = item[0], item[-1]
            core = k.strip()
            if core in NEVER:
                continue
            # ① 精确等于用户内容里的某个字符串 → 是用户自己写的，不进字典（任意长度）
            if core in content_values:
                continue
            # ② 由 i18n.js 的键值表（data-i18n）负责 —— 不算缺
            if core in ui_covered:
                continue
            flat = re.sub(r'[\\\s]+', '', core)      # 连 JSON 里字面的 \n 与反斜杠一起去掉
            flatblob = re.sub(r'[\\\s]+', '', blob)
            # 判定「这是用户自己写的内容」：整串能在数据里找到；长句则看前 12 字
            # （长句在数据里夹着换行与转义，整串比对会失手）。
            if (len(flat) >= 8 and flat in flatblob) or (len(flat) >= 20 and flat[:12] in flatblob):
                continue
            if core in zh:
                continue
            try:
                if any(re.search(it['src'], core) for it in patterns):
                    continue
            except re.error:
                pass
            miss.append((core, where))
        print('界面文案覆盖率：%d/%d 已覆盖，剩 %d 条' % (len(rows) - len(miss), len(rows), len(miss)))
        for c, w in miss:
            print('   缺 [%s] %s' % (w, c))


if __name__ == '__main__':
    main()
