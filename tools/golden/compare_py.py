"""黄金样本比对器（Python 实现版）
====================================================================
用法：python tools/golden/compare_py.py

拿 `backend/services/prompt_assembly_service.py` 去回放 20 组冻结样本，
要求 **20/20 逐字节全等**。不等就打印第一处差异的确切位置，便于定位。

这是「组装搬到后端」唯一的验收依据：不是看着像，是一个字节都不许差。
"""
import io
import json
import os
import sys

# Windows 控制台默认 GBK，输出 ✓/✗ 会 UnicodeEncodeError
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, ROOT)

from backend.services.prompt_assembly_service import assemble  # noqa: E402

SAMPLES = os.path.join(HERE, "samples")


def first_diff(a, b):
    """返回第一处差异的描述（含行号与上下文）。"""
    la, lb = a.splitlines(), b.splitlines()
    for i, (x, y) in enumerate(zip(la, lb), 1):
        if x != y:
            return "第 %d 行不同\n  样本: %r\n  实现: %r" % (i, x[:160], y[:160])
    if len(la) != len(lb):
        return "行数不同：样本 %d 行，实现 %d 行" % (len(la), len(lb))
    if a != b:
        return "内容不同但逐行相同（差在换行符/尾部）"
    return "未知差异"


def run_case(path):
    with io.open(path, encoding="utf-8") as f:
        case = json.load(f)
    inp = case.get("input") or {}
    res = assemble(
        prompts=inp.get("prompts") or [],
        web_state=inp.get("webState") or "default",
        npc_id=inp.get("npcId"),
        player_info=inp.get("playerInfo"),
        env=inp.get("env") or {},
    )
    expected = case.get("output") or ""
    got = res["system_prompt"]
    return case.get("name") or os.path.basename(path), expected == got, expected, got


def main():
    if not os.path.isdir(SAMPLES):
        print("找不到样本目录：%s" % SAMPLES)
        return 2
    files = sorted(f for f in os.listdir(SAMPLES)
                   if f.endswith(".json") and not f.startswith("manifest"))
    if not files:
        print("样本目录是空的，先跑 node tools/golden/capture.js")
        return 2

    ok = 0
    fails = []
    for f in files:
        name, same, expected, got = run_case(os.path.join(SAMPLES, f))
        if same:
            ok += 1
            print("  ✓ %s" % name)
        else:
            fails.append((name, expected, got))
            print("  ✗ %s" % name)

    print("")
    print("=" * 60)
    print("%d/%d 通过" % (ok, len(files)))
    for name, expected, got in fails:
        print("")
        print("--- %s ---" % name)
        print(first_diff(expected, got))
        if len(got) < 400:
            print("  实现产出全文: %r" % got[:400])
    return 0 if ok == len(files) else 1


if __name__ == "__main__":
    sys.exit(main())
