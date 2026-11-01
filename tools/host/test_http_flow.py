# -*- coding: utf-8 -*-
"""
网页端主持链路的真实 HTTP 回归（M1）。

跑法：先起服务（python -m uvicorn backend.main:app --port 8016），再
    python tools/host/test_http_flow.py http://127.0.0.1:8016

验的是「浏览器那一侧到底能不能拿到汤底」——这一层以前完全没验，导致服务端闸门
装好了、网上却是哑的（审计 M1）。

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
  python tools/host/test_http_flow.py http://127.0.0.1:8071
（环境变量是给「开房限额按天按 IP」放行的，否则连跑第二遍会撞 429 自伤。）
════════════════════════════════════════════════════════════════════
"""
import json
import os
import sys
import time
import urllib.request
import urllib.error

# 这个测试要直连 dev 库核对「汤底到底有没有进提示词」，所以要能 import backend。
# 不加这一行的话，下面几处 `from backend... import` 会全被 except 吞掉，
# 那条最有价值的断言（汤底真进了服务端提示词）会**静默跳过**，看上去还是绿的。
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8016").rstrip("/")
FAILED = []


class Throttled(RuntimeError):
    """重试到头还是 429。这**不是**被测功能有问题，是这个测试自己把限流打满了。
    必须单独抛出来，否则会退化成一堆「got=False」的假失败，把人引向错误的代码。"""


def call(method, path, body=None, headers=None):
    """发请求。撞到限流（30 请求/10 秒）就退避重试——这个测试本身请求密集。"""
    st, data = 0, {}
    for _ in range(8):
        st, data = _call_once(method, path, body, headers)
        if st != 429:
            return st, data
        time.sleep(2)
    raise Throttled("%s %s 连续 8 次 429（16 秒）——限流没退，不是被测功能的问题，隔一会儿再跑"
                    % (method, path))


def _call_once(method, path, body=None, headers=None):
    url = BASE + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode() or "{}")
        except Exception:
            return e.code, {}


def check(name, got, want):
    ok = got == want
    print("  [%s] %-34s got=%r want=%r" % ("OK" if ok else "!!", name, got, want))
    if not ok:
        FAILED.append(name)


def pick_script():
    """挑一本「有条件表」的已过审剧本，并开好一场。

    注意：不是每本剧本都有条件表（旧剧本走 ending_condition，没有 endings），
    所以不能拿第一本就算数——否则这个测试本身会误报。
    """
    st, body = call("GET", "/api/scripts?review_status=approved&limit=50")
    ids = [x.get("id") for x in (body.get("scripts") or []) if x.get("id")]
    if not ids:
        return None
    fallback = None
    for sid in ids[:12]:
        st, s = call("POST", "/api/host/session/start", {"script_id": sid, "npc_id": ""})
        if st != 200:
            continue
        tok, hid = s.get("host_token"), s.get("session_id")
        st, d = call("GET", "/api/npc/scripts/" + sid, headers={"X-Host-Token": tok})
        sc = d.get("script") or {}
        if sc.get("endings"):
            # 找到了：先把备用的那场收掉，别留没人收的会话
            if fallback is not None:
                call("POST", "/api/host/session/end",
                     {"session_id": fallback[2], "reason": "aborted"},
                     headers={"X-Host-Token": fallback[1]})
            return sid, tok, hid, True
        if fallback is None:
            # 备用那场要**留着**，后面整段测试都靠它的主持证；收掉再测就只剩 410
            fallback = (sid, tok, hid, False)
        else:
            call("POST", "/api/host/session/end", {"session_id": hid, "reason": "aborted"},
                 headers={"X-Host-Token": tok})
    return fallback


def _inject_fixture(sid):
    """库里没有任何一本带条件表的剧本时，临时给一本装上「条件表」再测，跑完还原。

    为什么不再「没有就跳过」：跳过等于「条件表能不能跟着主持证一起下来」这条
    永远没人验，而它正是「前端拿不到条件表就判定不了通关」的根。开发库里的
    三本旧剧本都只有 ending_condition、没有 endings，所以必须自己造一个。
    """
    import json as _json
    from backend.core.database import SessionLocal
    from backend.models.script import Script
    # 注意：这两列是 **Text 存 JSON 字符串**（不是 JSON 列），直接塞 list 会报
    # "type 'list' is not supported"。
    fx_endings = _json.dumps({"endings": [
        {"id": "e1", "name": "测试结局", "type": "win", "note": "这是测试用的结局备注",
         "conditions": [{"id": "c1", "name": "测试条件", "threshold": 1}]}]}, ensure_ascii=False)
    fx_tasks = _json.dumps({"tasks": [
        {"id": "t1", "name": "测试任务", "conditions": [{"id": "c1", "name": "测试条件"}]}]},
        ensure_ascii=False)
    db = SessionLocal()
    try:
        row = db.query(Script).filter(Script.id == sid).first()
        if not row:
            return None
        backup = {"endings": row.endings, "tasks": row.tasks,
                  "ending_condition": row.ending_condition}
        row.endings, row.tasks, row.ending_condition = fx_endings, fx_tasks, ""
        db.commit()
        return backup
    finally:
        db.close()


def _restore_fixture(sid, backup):
    from backend.core.database import SessionLocal
    from backend.models.script import Script
    db = SessionLocal()
    try:
        row = db.query(Script).filter(Script.id == sid).first()
        if row:
            row.endings = backup.get("endings")
            row.tasks = backup.get("tasks")
            row.ending_condition = backup.get("ending_condition")
            db.commit()
    finally:
        db.close()


def main():
    picked = pick_script()
    if not picked:
        print("拿不到已过审剧本，跳过"); return 0
    sid = picked[0]
    backup = None
    if not picked[3]:
        try:
            backup = _inject_fixture(sid)
            if backup is not None:
                print("(库里没有带条件表的剧本，已临时给 %s 装上一份测试条件表，跑完还原)" % sid)
                # 装完之后重新开一场，让新开的会话读到带条件表的版本
                call("POST", "/api/host/session/end",
                     {"session_id": picked[2], "reason": "aborted"},
                     headers={"X-Host-Token": picked[1]})
                picked = pick_script() or picked
                sid = picked[0]
        except Exception as e:
            print("  (装测试条件表失败: %s)" % e)
    print("(用剧本 %s，%s条件表)" % (sid, "有" if picked[3] else "无"))

    print("--- 1. 没证：只有公开字段 ---")
    st, d = call("GET", "/api/npc/scripts/" + sid)
    sc = d.get("script") or {}
    check("匿名拿到标题", bool(sc.get("title")), True)
    check("匿名没有汤底", bool(sc.get("explanation")), False)
    check("匿名没有条件表", bool(sc.get("endings")), False)

    print("\n--- 2. 开一场，拿主持证 ---")
    tok, hid = picked[1], picked[2]
    H = {"X-Host-Token": tok}
    check("拿到主持证", bool(tok), True)
    st, s = call("GET", "/api/host/session/" + hid, headers=H)
    check("相位=hosting", s.get("phase"), "hosting")

    print("\n--- 3. 带证：条件表下来、汤底正文不下来（汤底只留在服务端）---")
    st, d = call("GET", "/api/npc/scripts/" + sid, headers=H)
    # 这道 check 不能省：没有它，请求失败时 d 变成 {"detail":…}，下面几条
    # 「xx 不在 sc 里」的断言会全部自动成立 —— 请求没成功这件事在断言里看不见（审计 S5）。
    check("详情接口 200", st, 200)
    sc = d.get("script") or {}
    check("持证拿不到汤底正文", "explanation" in sc, False)
    check("持证拿不到主持指导词", "host_guide" in sc, False)
    # 不能写 `if picked[3]:` —— 取不到就直接算失败，否则「没有条件表的剧本」会让这条静默消失
    check("持证拿到条件表", bool(picked[3]) and bool(sc.get("endings")), True)
    st, ctx = call("POST", "/api/host/context",
                   {"contract": "aijuben.context/1.3", "state": "experience",
                    "npc_id": "deepseek"}, headers=H)
    check("/host/context 200", st, 200)
    # 这一条原来断言「system_prompt 非空」——光是 NPC 人设就几千字，恒真，等于没验。
    # 真正要验的是「汤底确实参与了推理、但只出现在服务端组装出来的提示词里」。
    sp = ctx.get("system_prompt") or ""
    check("响应里不再附带 root/sections（汤底只留一份）",
          ("root" in ctx, "sections" in ctx), (False, False))
    # 取不到汤底原文时**记为失败**，不再静默跳过 —— 这条是「汤底到底进没进服务端提示词」
    # 的唯一证据，跳过等于把最要紧的回归网拆了（审计 S5）。
    _tail = ""
    try:
        from backend.models.script import Script as _S
        from backend.core.database import SessionLocal as _SL
        _db = _SL()
        _sc = _db.query(_S).filter(_S.id == sid).first()
        _tail = "".join((_sc.explanation or "").split())[-12:]
        _db.close()
    except Exception as e:
        print("  (取汤底失败: %s)" % e)
    check("取到了汤底原文（否则下一条无从判断）", len(_tail) >= 8, True)
    check("汤底原文进了服务端提示词", bool(_tail) and _tail in "".join(sp.split()), True)

    print("\n--- 4. 结算相位 → 解说 → 收场 ---")
    st, r = call("POST", "/api/host/session/%s/settling" % hid, headers=H)
    check("进结算相位", r.get("phase"), "settling")
    st, r = call("POST", "/api/host/session/end", {"session_id": hid, "reason": "settled"}, headers=H)
    check("没解说就收场被拒", st, 409)
    st, r = call("POST", "/api/host/session/%s/narrated" % hid, headers=H)
    check("标记解说讲完", r.get("narrated"), True)
    st, r = call("POST", "/api/host/session/end", {"session_id": hid, "reason": "settled"}, headers=H)
    check("讲完后收场成功", r.get("phase"), "ended")

    print("\n--- 5. 收场之后连条件表也不再下发 ---")
    st, d = call("GET", "/api/npc/scripts/" + sid, headers=H)
    sc = d.get("script") or {}
    # 原来断言的是「explanation 不在」——可这一场里 explanation 从头到尾对任何人都不下发，
    # 也就是说遗言轮在不在，这条都成立（假绿）。收场之后真正该没的是**条件表**。
    check("收场后条件表不再下发", "endings" in sc, False)
    check("收场后仍是未解锁态", sc.get("full_locked"), True)

    print("\n--- 6. 证过期之后还能重开一场（前端「补证」链路的服务端前提）---")
    # 前端补证的链路是：hostSession() 判过期返回 null → ensureHostSession → _openHostSession
    # → 先关旧场 → 再开新场。这里验服务端确实允许「过期证 → 重开 → 新证可用」，
    # 否则补证就是在原地打转（审计 必改-1 的根因）。
    st, d = call("POST", "/api/host/session/start", {"script_id": sid, "npc_id": ""})
    tok2 = d.get("host_token") or ""
    hid2 = d.get("session_id") or ""
    check("重开拿到新证", bool(tok2), True)
    check("换了一张新证", tok2 != tok, True)
    check("换了一个新场", hid2 != hid, True)
    st, ctx2 = call("POST", "/api/host/context",
                    {"contract": "aijuben.context/1.3", "state": "experience",
                     "npc_id": "deepseek", "session_id": hid2},
                    headers={"X-Host-Token": tok2})
    check("新证能取到主持上下文", st, 200)

    # 把这张证强制过期，验证服务端会拒 —— 前端因此必须去补新证，而不是拿旧证硬发
    try:
        from backend.core.database import SessionLocal as _SL2
        from backend.models.host_session import HostSession as _HS
        import datetime as _dt
        _db2 = _SL2()
        _s2 = _db2.query(_HS).filter(_HS.id == hid2).first()
        _s2.token_issued_at = _dt.datetime.now(_dt.timezone.utc) - _dt.timedelta(hours=5)
        _db2.commit()
        _db2.close()
        _forced = True
    except Exception as e:
        _forced = False
        print("  (强制过期失败，跳过: %s)" % e)
    if _forced:
        st, r = call("POST", "/api/host/context",
                     {"contract": "aijuben.context/1.3", "state": "experience",
                      "npc_id": "deepseek", "session_id": hid2},
                     headers={"X-Host-Token": tok2})
        # 注意是 410 不是 403：require_token 对「过期」统一按契约 §9.3 报 410 host_token_expired，
        # 403 capability_denied 那条留给「证是真的但不属于这一场」。
        check("过期证被拒（410，不是静默放行）", st, 410)
        check("错误码是 host_token_expired", (r.get("detail") or {}).get("code")
              if isinstance(r.get("detail"), dict) else None, "host_token_expired")
        st, d3 = call("POST", "/api/host/session/start", {"script_id": sid, "npc_id": ""})
        tok3 = d3.get("host_token") or ""
        check("过期之后还能再开一场", bool(tok3), True)
        st, ctx3 = call("POST", "/api/host/context",
                        {"contract": "aijuben.context/1.3", "state": "experience",
                         "npc_id": "deepseek", "session_id": d3.get("session_id")},
                        headers={"X-Host-Token": tok3})
        check("补到的新证真的能用", st, 200)

    if backup is not None:
        try:
            _restore_fixture(sid, backup)
            print("(测试条件表已还原)")
        except Exception as e:
            print("  (还原测试条件表失败，请手动检查 %s: %s)" % (sid, e))
    print("\n%s" % ("全部通过" if not FAILED else "%d 项不通过：%s" % (len(FAILED), "、".join(FAILED))))
    return 1 if FAILED else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Throttled as e:
        print("\n[SKIP] %s" % e)
        print("这不是回归失败；隔 10 秒重跑，或按文件头的说明放宽 HOST_START_LIMIT_* 起服务。")
        sys.exit(2)
