#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
FolioFold 维护工具（Workstream C，2026-09-26 起独立推进）

设计原则（写死在代码里，避免以后被"顺手"改坏）：

1. **默认只读**。不带 --apply 的命令一律只扫描、只报告，不删任何东西。
2. **Preview / Dry Run 先行**。任何删除动作都必须先跑 preview 看清清单。
3. **受保护目录永不删除**，且**不做"按引用关系推断"的删除**：
   - 用户 media（public/media/**）—— 绝不会因为"代码/数据里没引用"就被删。
     这是产品内容，不是垃圾文件。
   - 正式 portfolio 数据（content/**）—— 同上。
   - 凭据（.folioframe/gh.json、cloudbase.json 等）—— 只报告存在与否，
     绝不删、绝不打印内容、绝不进 Git。
   - _repo_gh（持久 git clone，用来加速重新发布）、.folioframe/tools（ffmpeg）
   - _backups/**（含 GOLDEN 黄金备份）
   - **/*.previous.json、**/*.rescued-*.json（写盘异常时的救命副本）
   - .folioframe/deploy-history.jsonl（发布审计记录）
4. **可安全删除的只有"过程产物"**：Python 字节码缓存、孤儿发布打包目录、
   测试产物、临时日志。这些的共同点是「随时可重建、丢了不损失任何用户内容」。

与 Visual Editor 完全无耦合：本脚本不 import server.py，不读业务数据，
只做文件系统扫描。

用法：
    python tools/maintenance/cleaner.py check           # 健康检查（只读）
    python tools/maintenance/cleaner.py preview         # 全量预览（只读，默认命令）
    python tools/maintenance/cleaner.py clean-cache     # 清缓存（需 --apply）
    python tools/maintenance/cleaner.py clean-safe      # 清安全文件（需 --apply）
    python tools/maintenance/cleaner.py menu            # 交互式菜单
    python tools/maintenance/cleaner.py preview --json  # 机器可读输出
"""
from __future__ import annotations

import argparse
import fnmatch
import json
import os
import sys
import time
from pathlib import Path

# 默认扫 G:\Portfolio；--root 可指向别处（自动化安全测试用，避免真删项目文件）
ROOT = Path(os.environ.get("FF_CLEANER_ROOT") or Path(__file__).resolve().parent.parent.parent)

# ---------------------------------------------------------------- 类别定义
SAFE = "safe"           # 可安全删除（过程产物）
CACHE = "cache"         # 缓存（可安全删除）
PROTECTED = "protected" # 受保护（只报告，永不删）

CATEGORY_LABEL = {
    SAFE: "可安全删除",
    CACHE: "缓存",
    PROTECTED: "受保护（永不删除）",
}

# 受保护的路径（相对 ROOT 的 glob），命中即永不删除
PROTECTED_GLOBS = [
    "content/**",                       # 正式作品集数据
    "public/media/**",                  # 用户真实媒体
    "public/resume.pdf",
    "_backups/**",                      # 备份（含 GOLDEN）
    "**/*.previous.json",               # 写盘前一份快照
    "**/*.rescued-*.json",              # 抢救副本
    ".folioframe/gh.json",              # GitHub token
    ".folioframe/cloudbase.json",       # CloudBase 凭据
    ".folioframe/translation-provider.json",
    ".folioframe/translation-glossary.json",
    ".folioframe/deploy-history.jsonl", # 发布审计
    ".folioframe/_repo_gh/**",          # 持久 git clone（加速重新发布）
    ".folioframe/tools/**",             # ffmpeg
    ".git/**",
]

# 可删除的规则：(类别, 说明, 匹配函数)
def _is_pycache(p: Path, rel: str) -> bool:
    return p.is_dir() and p.name == "__pycache__"

def _is_pyc(p: Path, rel: str) -> bool:
    return p.is_file() and p.suffix == ".pyc"

def _is_orphan_bundle(p: Path, rel: str) -> bool:
    # 发布时生成的临时打包目录，发布完就没用了（历史上一度堆到 1GB）
    return p.is_dir() and p.name.startswith("_bundle_")

def _is_temp_log(p: Path, rel: str) -> bool:
    return p.is_file() and p.suffix == ".log" and rel.startswith(".folioframe" + os.sep)

def _is_test_artifact(p: Path, rel: str) -> bool:
    if not p.is_file():
        return False
    if rel.startswith("qa" + os.sep) and p.suffix in (".png", ".jpg", ".jpeg"):
        return True
    # 测试跑批留在项目根的临时输出
    if p.parent == ROOT and p.name.startswith("_") and p.suffix in (".out", ".log", ".tmp"):
        return True
    return False

DELETE_RULES = [
    (CACHE, "Python 字节码缓存目录（随时可重建）", _is_pycache),
    (CACHE, "Python 字节码文件（随时可重建）", _is_pyc),
    (SAFE,  "孤儿发布打包目录（发布过程产物，发布完即无用）", _is_orphan_bundle),
    (SAFE,  "临时日志（.folioframe 下的 *.log）", _is_temp_log),
    (SAFE,  "测试产物（qa 下的截图、跑批临时输出）", _is_test_artifact),
]

# ---------------------------------------------------------------- 工具函数
def human(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f}{unit}" if unit == "B" else f"{n:.1f}{unit}"
        n /= 1024.0
    return str(n)

def dir_size(p: Path) -> int:
    total = 0
    try:
        for root, dirs, files in os.walk(p):
            for f in files:
                try:
                    total += (Path(root) / f).stat().st_size
                except OSError:
                    pass
    except OSError:
        pass
    return total

def size_of(p: Path) -> int:
    return dir_size(p) if p.is_dir() else (p.stat().st_size if p.is_file() else 0)

def matches_protected(rel: str) -> bool:
    r = rel.replace("\\", "/")
    for g in PROTECTED_GLOBS:
        if fnmatch.fnmatch(r, g) or r.startswith(g.rstrip("/**").rstrip("*").rstrip("/") + "/"):
            return True
    return False

def scan() -> dict:
    """扫描整个项目，返回分类清单。只读，不做任何修改。"""
    items = []
    skip_dirs = {".git"}
    for root, dirs, files in os.walk(ROOT):
        dirs[:] = [d for d in dirs if d not in skip_dirs]
        for name in list(dirs) + list(files):
            p = Path(root) / name
            rel = str(p.relative_to(ROOT))
            if rel.startswith(".git" + os.sep):
                continue
            hit = None
            for cat, why, fn in DELETE_RULES:
                try:
                    if fn(p, rel):
                        hit = (cat, why)
                        break
                except OSError:
                    pass
            if hit:
                # 二次保险：即使规则命中，只要落在受保护路径里就绝不删
                if matches_protected(rel):
                    continue
                items.append({"path": rel, "kind": "dir" if p.is_dir() else "file",
                              "category": hit[0], "reason": hit[1],
                              "size": size_of(p), "mtime": int(p.stat().st_mtime)})
                if p.is_dir():
                    dirs[:] = [d for d in dirs if (Path(root) / d) != p]
    items.sort(key=lambda x: -x["size"])
    return {"root": str(ROOT), "scanned_at": time.strftime("%Y-%m-%d %H:%M:%S"), "items": items}

def protected_inventory() -> list:
    """受保护资产的现状清单（体积、条目数），只报告不删除。"""
    out = []
    checks = [
        ("用户媒体 public/media", "public/media", "dir"),
        ("作品集数据 content", "content", "dir"),
        ("备份 _backups（含 GOLDEN）", "_backups", "dir"),
        ("持久 git clone .folioframe/_repo_gh", ".folioframe/_repo_gh", "dir"),
        ("ffmpeg .folioframe/tools", ".folioframe/tools", "dir"),
        ("GitHub token .folioframe/gh.json", ".folioframe/gh.json", "file"),
        ("CloudBase 凭据 .folioframe/cloudbase.json", ".folioframe/cloudbase.json", "file"),
        ("发布审计 .folioframe/deploy-history.jsonl", ".folioframe/deploy-history.jsonl", "file"),
    ]
    for label, rel, kind in checks:
        p = ROOT / rel
        if not p.exists():
            out.append({"label": label, "path": rel, "exists": False, "size": 0, "count": 0})
            continue
        cnt = 0
        if kind == "dir":
            for _, _, fs in os.walk(p):
                cnt += len(fs)
        out.append({"label": label, "path": rel, "exists": True,
                    "size": size_of(p), "count": cnt})
    return out

def check() -> list:
    """健康检查（只读）。返回 (项目, 状态, 说明) 三元组列表。"""
    rows = []
    gi = ROOT / ".gitignore"
    rows.append((".gitignore 存在", gi.exists(), str(gi)))
    need = ["_backups/", "public/media/**", "**/*.previous.json", "**/*.rescued-*.json",
            ".folioframe/", ".folioframe/_bundle_*/"]
    txt = gi.read_text(encoding="utf-8", errors="ignore") if gi.exists() else ""
    for n in need:
        rows.append((f".gitignore 覆盖 {n}", n in txt, ""))
    for label, rel, _ in [("gh.json", ".folioframe/gh.json", "f"),
                          ("cloudbase.json", ".folioframe/cloudbase.json", "f")]:
        p = ROOT / rel
        rows.append((f"凭据 {label} 存在（只确认存在，不读内容）", p.exists(), "不应出现在 Git 里"))
    # 凭据是否会被 Git 跟踪
    staged_bad = []
    if (ROOT / ".git").exists():
        import subprocess
        try:
            r = subprocess.run(["git", "ls-files"], cwd=str(ROOT), capture_output=True, text=True, timeout=30)
            for line in r.stdout.splitlines():
                low = line.replace("\\", "/")
                if "gh.json" in low or "cloudbase.json" in low or low.startswith("public/media/"):
                    staged_bad.append(line)
        except Exception:
            pass
    rows.append(("Git 未跟踪任何凭据/媒体", not staged_bad, "、".join(staged_bad[:5])))
    rows.append(("孤儿发布打包目录已清理", not list(ROOT.glob(".folioframe/_bundle_*")), ""))
    rows.append(("Python 字节码缓存为 0 或很少",
                 len(list(ROOT.rglob("__pycache__"))) <= 2,
                 f"{len(list(ROOT.rglob('__pycache__')))} 个 __pycache__"))
    return rows

# ---------------------------------------------------------------- 删除执行
def do_delete(items, apply: bool, assume_yes: bool, quiet: bool = False) -> dict:
    removed, failed, freed = [], [], 0
    if not items:
        return {"removed": removed, "failed": failed, "freed": 0, "dry_run": not apply}
    if not quiet:
        print(f"\n{'【实际删除】' if apply else '【Dry Run · 不会真正删除】'} 共 {len(items)} 项")
    if apply and not assume_yes:
        ans = input("确认删除？输入 yes 继续：").strip().lower()
        if ans != "yes":
            print("已取消。")
            return {"removed": [], "failed": [], "freed": 0, "dry_run": True, "cancelled": True}
    for it in items:
        p = ROOT / it["path"]
        rel = it["path"]
        if matches_protected(rel):
            failed.append({"path": rel, "error": "受保护路径，拒绝删除"})
            continue
        try:
            if apply:
                if p.is_dir():
                    import shutil
                    shutil.rmtree(p)
                else:
                    p.unlink()
                removed.append(rel)
                freed += it["size"]
            else:
                removed.append(rel)
                freed += it["size"]
        except Exception as e:
            failed.append({"path": rel, "error": str(e)})
    return {"removed": removed, "failed": failed, "freed": freed, "dry_run": not apply}

# ---------------------------------------------------------------- 输出
def print_report(rep: dict):
    items = rep["items"]
    by = {}
    for it in items:
        by.setdefault(it["category"], []).append(it)
    print(f"\n扫描根目录：{rep['root']}")
    print(f"扫描时间  ：{rep['scanned_at']}\n")
    if not items:
        print("  ✅ 没有发现任何可清理项，仓库很干净。\n")
    for cat in (CACHE, SAFE):
        lst = by.get(cat, [])
        tot = sum(i["size"] for i in lst)
        print(f"【{CATEGORY_LABEL[cat]}】{len(lst)} 项  合计 {human(tot)}")
        for it in lst[:40]:
            print(f"   - {it['path']}  ({human(it['size'])})  {it['reason']}")
        if len(lst) > 40:
            print(f"   … 另有 {len(lst) - 40} 项")
        print()
    print(f"【{CATEGORY_LABEL[PROTECTED]}】以下只报告，本工具永不删除：")
    for inv in protected_inventory():
        if not inv["exists"]:
            print(f"   - {inv['label']}：不存在")
        else:
            extra = f"，{inv['count']} 个文件" if inv["count"] else ""
            print(f"   - {inv['label']}：{human(inv['size'])}{extra}")

def print_check():
    print("\n=== 健康检查（只读）===")
    bad = 0
    for name, okv, note in check():
        print(f"  {'✅' if okv else '❌'} {name}" + (f"  — {note}" if note else ""))
        if not okv:
            bad += 1
    print(f"\n{'✅ 全部通过' if bad == 0 else f'❌ {bad} 项需要注意'}")

def menu():
    while True:
        print("\n" + "=" * 52)
        print("  FolioFold 维护工具")
        print("=" * 52)
        print("  1) Check            健康检查（只读）")
        print("  2) Preview          全量预览 / Dry Run（只读）")
        print("  3) Cleanup          扫描并列出可清理项（只读）")
        print("  4) Clean Safe Files 删除「可安全删除」项")
        print("  5) Clean Cache      仅清理缓存")
        print("  6) Exit             退出")
        print("=" * 52)
        c = input("请选择 (1-6)：").strip()
        if c == "1":
            print_check()
        elif c in ("2", "3"):
            print_report(scan())
        elif c == "4":
            rep = scan()
            r = do_delete([i for i in rep["items"] if i["category"] == SAFE], True, False)
            print(f"\n删除 {len(r['removed'])} 项，释放 {human(r['freed'])}；失败 {len(r['failed'])}")
        elif c == "5":
            rep = scan()
            r = do_delete([i for i in rep["items"] if i["category"] == CACHE], True, False)
            print(f"\n删除 {len(r['removed'])} 项，释放 {human(r['freed'])}；失败 {len(r['failed'])}")
        elif c == "6":
            print("已退出。")
            return
        else:
            print("无效选择。")

def main():
    ap = argparse.ArgumentParser(description="FolioFold 维护工具（默认只读）")
    ap.add_argument("command", nargs="?", default="preview",
                    choices=["check", "preview", "cleanup", "clean-safe", "clean-cache", "menu"])
    ap.add_argument("--apply", action="store_true", help="真正执行删除（默认只做 dry run）")
    ap.add_argument("--yes", action="store_true", help="跳过交互确认")
    ap.add_argument("--json", action="store_true", help="机器可读输出")
    a = ap.parse_args()

    if a.command == "menu":
        menu()
        return
    if a.command == "check":
        if a.json:
            print(json.dumps([{"name": n, "ok": bool(o), "note": t} for n, o, t in check()],
                             ensure_ascii=False, indent=1))
        else:
            print_check()
        return

    rep = scan()
    if a.command in ("preview", "cleanup"):
        if a.json:
            print(json.dumps(rep, ensure_ascii=False, indent=1))
        else:
            print_report(rep)
        return

    want = SAFE if a.command == "clean-safe" else CACHE
    items = [i for i in rep["items"] if i["category"] == want]
    r = do_delete(items, a.apply, a.yes, quiet=a.json)
    if a.json:
        print(json.dumps(r, ensure_ascii=False, indent=1))
    else:
        mode = "实际删除" if a.apply and not r.get("cancelled") else "Dry Run"
        print(f"\n{mode}：{len(r['removed'])} 项，释放 {human(r['freed'])}")
        if r["failed"]:
            print("失败：")
            for f in r["failed"]:
                print(f"   - {f['path']}：{f['error']}")
        if not a.apply:
            print("（这是 Dry Run。加 --apply 才会真正删除。）")

if __name__ == "__main__":
    main()
