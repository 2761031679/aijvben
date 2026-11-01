# -*- coding: utf-8 -*-
"""
提示词组装搬到后端（POST /api/host/context）的真实 HTTP 回归。

跑法：先起服务（python -m uvicorn backend.main:app --port 8020），再
    python tools/host/test_context_api.py http://127.0.0.1:8020

验四件事：
  1. 资料库能出（default / browsing 两个态，不带凭证）；
  2. 有证才出剧本内容（experience 态：无证 401）；
  3. 汤底的钥匙是「正持着这一场」——证对但场不对 403，收场后 410；
  4. bundle 自洽：sha256(system_prompt) 前 16 位 == prompt_hash，且 json 解析回来等于 root。

注意：这两个测试各自会开好几场主持会话，而开房是「按天限额」的（游客 20 次/天）。
反复跑会把自己的额度用光，第二次跑就红。起服务时放宽掉：
    HOST_START_LIMIT_GUEST=100000 HOST_START_LIMIT_MEMBER=100000 python -m uvicorn backend.main:app --port <端口>

════════════════════════════════════════════════════════════════════
这份测试**需要真实服务在跑**，所以它不在 deploy.sh 的闸门里（部署时没有服务可打）。
但它是「汤底不外泄 + 主持通道贯通」最接近现场的回归网 —— 改动涉及
  backend/routers/host.py、backend/routers/npc.py、backend/routers/game.py、
  backend/services/{host_session,prompt_assembly,prompt_env}_service.py
时必须手动跑一次；红了就是真的有问题，不要当成噪音重跑过去。

跑法：
  HOST_START_LIMIT_GUEST=100000 HOST_START_LIMIT_MEMBER=100000 \
    python -m uvicorn backend.main:app --host 127.0.0.1 --port 8071 --workers 1 &
  python tools/host/test_context_api.py http://127.0.0.1:8071
（环境变量是给「开房限额按天按 IP」放行的，否则连跑第二遍会撞 429 自伤。）
════════════════════════════════════════════════════════════════════
"""
import hashlib
import json
import sys
import time
import urllib.request
import urllib.error

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8020").rstrip("/")
FAILED = []


def _once(method, path, body=None, headers=None):
    url = BASE + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode() or "{}")
        except Exception:
            return e.code, {}


def call(method, path, body=None, headers=None):
    for _ in range(4):
        st, data = _once(method, path, body, headers)
        if st != 429:
            return st, data
        time.sleep(3)
    return st, data


# 冻结的结构锚：改装配配方就必须同步改这里，否则这条测试会红 —— 这正是它的作用。
# 以前这里用「解析回来等于自己」做断言，等于什么都没测（审计 M3）。
WORKFLOW_KEY = "工作流程（最高优先级，务必逐级严格遵循）"
LIBRARY_KEY = "资料库（按需查阅）"
EXPECTED_LIB_KEYS = [
    "A 角色设定", "B 铁律", "C 模式规则", "D 剧本内容", "E 线索/道具面板",
    "F 标记手册", "输出规范", "G 表情/动画清单", "H 状态栏 UI", "I 玩家信息",
]


def root_of(d):
    """从 system_prompt 解析出组装结果。
    响应里已经不再附带 root/sections（汤底只留一份，审计 A1），所以从提示词本身反解。"""
    try:
        return json.loads(d.get("system_prompt") or "{}") or {}
    except Exception:
        return {}


def check(name, got, want):
    ok = got == want
    print("  [%s] %-40s got=%r want=%r" % ("OK" if ok else "!!", name, got, want))
    if not ok:
        FAILED.append(name)


def pick_script():
    st, body = call("GET", "/api/scripts?review_status=approved&limit=50")
    ids = [x.get("id") for x in (body.get("scripts") or []) if x.get("id")]
    return ids[0] if ids else None


def main():
    sid = pick_script()
    if not sid:
        print("拿不到已过审剧本，跳过")
        return 0
    print("(用剧本 %s)" % sid)

    print("\n--- 1. default 态：不需要凭证 ---")
    st, d = call("POST", "/api/host/context", {"state": "default", "npc_id": "dagou"})
    check("200", st, 200)
    root = root_of(d)
    check("有工作流程节", bool(root.get("工作流程（最高优先级，务必逐级严格遵循）")), True)
    lib = root.get("资料库（按需查阅）") or {}
    check("有资料库", bool(lib), True)
    check("default 无剧本内容", "D 剧本内容" in lib, False)
    check("default 有表情清单", "G 表情/动画清单" in lib, True)
    check("契约版本", d.get("contract"), "aijuben.context/1.3")

    print("\n--- 2. browsing 态：侧边栏引导 ---")
    st, d = call("POST", "/api/host/context", {"state": "browsing", "npc_id": "dagou"})
    lib = root_of(d).get("资料库（按需查阅）") or {}
    check("200", st, 200)
    check("有侧边栏引导组", "C 侧边栏引导" in lib, True)
    check("browsing 无剧本内容", "D 剧本内容" in lib, False)

    print("\n--- 3. experience 态：没证一律 401（汤底不出去）---")
    st, d = call("POST", "/api/host/context",
                 {"state": "experience", "npc_id": "dagou", "session_id": "ps_fake"})
    check("无证 401", st, 401)
    check("错误码 no_actor", (d.get("detail") or {}).get("code"), "no_actor")

    print("\n--- 4. 开一场，持证取上下文：汤底到齐 ---")
    st, s = call("POST", "/api/host/session/start", {"script_id": sid, "npc_id": "dagou"})
    check("开房 200", st, 200)
    tok, hid = s.get("host_token"), s.get("session_id")
    H = {"X-Host-Token": tok}
    st, d = call("POST", "/api/host/context",
                 {"state": "experience", "npc_id": "dagou", "session_id": hid}, headers=H)
    check("200", st, 200)
    lib = root_of(d).get("资料库（按需查阅）") or {}
    check("有剧本内容组", "D 剧本内容" in lib, True)
    sp = d.get("system_prompt") or ""
    check("system_prompt 非空", len(sp) > 1000, True)
    check("响应里不再附带 root/sections（汤底只留一份）",
          ("root" in d, "sections" in d), (False, False))
    check("含汤底键名", "汤底/真相（仅主持人可见，禁止泄露）" in sp, True)
    check("prompt_hash 与 system_prompt 相符",
          hashlib.sha256(sp.encode("utf-8")).hexdigest()[:16], d.get("prompt_hash"))
    # 这里原来写的是 `json.loads(sp) == root_of(d)` —— 而 root_of 就是从 sp 解析的，
    # 于是它永远是 True（审计 M3：A1 把 root 字段删掉时，这条断言静默退化成同义反复）。
    # 改成拿「写死的结构名单」当锚：提示词能解析、顶层两个键、资料库九个分节一个不多一个不少。
    parsed = root_of(d)
    check("提示词可解析为 JSON 对象", isinstance(parsed, dict) and bool(parsed), True)
    check("顶层键只有 工作流程 + 资料库",
          sorted(parsed.keys()), sorted([WORKFLOW_KEY, LIBRARY_KEY]))
    # 注意：空分节会被跳过（例如「E 线索/道具面板」在没有线索时的确不出现，这是设计），
    # 所以判据不是「完全等于配方」，而是「是配方的有序子序列，且该在的都在」。
    _got_keys = list((parsed.get(LIBRARY_KEY) or {}).keys())
    check("资料库分节都在配方里且相对顺序一致",
          _got_keys, [k for k in EXPECTED_LIB_KEYS if k in _got_keys])
    check("必有分节齐全（含剧本内容与标记手册）",
          all(k in _got_keys for k in ("A 角色设定", "B 铁律", "C 模式规则", "D 剧本内容",
                                       "F 标记手册", "输出规范", "G 表情/动画清单", "I 玩家信息")),
          True)
    check("有 H 状态栏 UI", "H 状态栏 UI" in lib, True)
    check("有 I 玩家信息", "I 玩家信息" in lib, True)
    check("capabilities 含主持", "script:host" in (d.get("capabilities") or []), True)

    print("\n--- 5. 证对但场不对：403 ---")
    st, d = call("POST", "/api/host/context",
                 {"state": "experience", "npc_id": "dagou", "session_id": "ps_other"}, headers=H)
    check("403", st, 403)
    check("错误码 capability_denied", (d.get("detail") or {}).get("code"), "capability_denied")

    print("\n--- 6. 收场之后：410 ---")
    call("POST", "/api/host/session/%s/settling" % hid, headers=H)
    call("POST", "/api/host/session/%s/narrated" % hid, headers=H)
    call("POST", "/api/host/session/end", {"session_id": hid, "reason": "settled"}, headers=H)
    st, d = call("POST", "/api/host/context",
                 {"state": "experience", "npc_id": "dagou", "session_id": hid}, headers=H)
    # 收场后主持证转「遗言证」，仍有效一轮，但 phase=ended 的会话不能再组装体验上下文
    check("收场后取上下文 = 403", st, 403)
    check("收场后错误码", (d.get("detail") or {}).get("code"), "capability_denied")

    print("\n--- 6b. 已结算的场不能被一句话喊回 timeout（审计 M1）---")
    # 把最后活动时间往前拨，让它「看起来」安静超时过
    import sqlite3, os
    db_path = os.path.join(os.path.dirname(__file__), '..', '..', 'data', 'turtlesoup.db')
    con = sqlite3.connect(os.path.abspath(db_path))
    con.execute("UPDATE host_sessions SET last_active_at = datetime('now','-400 seconds') "
                "WHERE id = ?", (hid,))
    con.commit()
    con.close()
    st, d = call("POST", "/api/host/session/end", {"session_id": hid, "reason": "timeout"}, headers=H)
    check("终态不会被覆写", st, 200)
    st, d = call("POST", "/api/host/context",
                 {"state": "experience", "npc_id": "dagou", "session_id": hid}, headers=H)
    check("仍然拿不到汤底", st, 403)
    check("仍然是 capability_denied", (d.get("detail") or {}).get("code"), "capability_denied")

    print("\n--- 7. 契约版本不符：400 ---")
    st, d = call("POST", "/api/host/context", {"contract": "aijuben.context/9.9", "state": "default"})
    check("400", st, 400)
    check("错误码 contract_mismatch", (d.get("detail") or {}).get("code"), "contract_mismatch")

    print("\n%s" % ("全部通过" if not FAILED else "%d 项不通过：%s" % (len(FAILED), "、".join(FAILED))))
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
