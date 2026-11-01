"""实名认证回调的回归测试（2026-11 安全审计 P0-5）。

背景：`handle_callback` 原本写成 `if sign:` —— 不传 sign 就完全跳过验签。
于是任何人 POST 一个 {"bizPackage":{"bizSeq":"<自己那条>","resultCode":"0"}}
就能把账号标成已实名，前端从生码接口的响应里就能读到自己那条 bizSeq。

这个测试锁死那条路：**没有签名、签名错、已消费过、已过期，一律拒绝且不改任何状态。**

跑法：
    python tools/host/test_realname_callback.py

不需要起服务、不需要网络——验签函数被打桩，测的是"门"本身而不是国密实现。
"""
import os
import sys
import json
import base64
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.core.database import Base
from backend.models.user import User
from backend.models.realname import RealnameRequest
from backend.services import realname_service as svc

FAILED = []
PASSED = []


def check(name, got, want):
    if got == want:
        PASSED.append(name)
        print("  [ok]   %s" % name)
    else:
        FAILED.append("%s（got=%r want=%r）" % (name, got, want))
        print("  [FAIL] %s  got=%r want=%r" % (name, got, want))


def new_db():
    eng = create_engine("sqlite://", future=True)
    Base.metadata.create_all(eng)
    return sessionmaker(bind=eng, future=True)()


def seed(db, status="pending", age_minutes=0, biz_seq="bs_test_0001"):
    """造一个用户 + 一条实名请求，返回 (user, req)。"""
    u = User(id="u_probe0001", username="probe_realname_%s" % biz_seq,
             password_hash="x", role="normal")
    db.add(u)
    r = RealnameRequest(id="rr_%s" % biz_seq, user_id=u.id, biz_seq=biz_seq,
                        status=status,
                        created_at=datetime.now(timezone.utc) - timedelta(minutes=age_minutes))
    db.add(r)
    db.commit()
    return u, r


def body(biz_seq, result_code="0", sign=None):
    """组一个回调报文；sign=None 表示"不带签名字段"。"""
    payload = {"bizPackage": {"bizSeq": biz_seq, "resultCode": result_code,
                              "resultDesc": "ok", "eventType": "QRCODE_AUTH"}}
    if sign is not None:
        payload["sign"] = sign
    return json.dumps(payload, ensure_ascii=False)


GOOD_SIGN = base64.b64encode(b"fake-der").decode()

# 真的 pkcs7_verify，在任何人打桩之前先留一份引用 —— 换掉的是模块属性，
# 打桩后拿不回来，所以这里必须抢救性备份，否则组 10 测的是桩而不是实现。
_REAL_PKCS7_VERIFY = svc.gm_crypto.pkcs7_verify


def stub_verify(ok):
    """把验签打桩：ok=True 表示"这份签名有效"。

    注意：桩要吃掉 expected_pub_hex 这个新参数（审计 A1 加的），
    否则 handle_callback 传关键字参数时会 TypeError —— 那是测试自己坏掉，
    不是产品坏掉，很容易被误读成"验签又挂了"。
    """
    svc.gm_crypto.pkcs7_verify = lambda sig_der, data, expected_pub_hex=None: ok


def main():
    print("=" * 68)
    print("实名回调回归：未验签的报文绝不允许触发状态变更")
    print("=" * 68)

    # ── 组 1：攻击路径。缺 sign 必须拒绝，且用户不被实名 ──────────────
    print("\n[组 1] 攻击路径：伪造 / 缺签名")
    stub_verify(True)  # 即使验签函数"路过的都放过"，缺 sign 也必须挡在前面

    db = new_db()
    u, r = seed(db)
    out = svc.handle_callback(db, body("bs_test_0001"))  # 不带 sign
    db.refresh(u); db.refresh(r)
    check("缺 sign → 拒绝", out["resultCode"], "1")
    check("缺 sign → 用户未被实名", bool(u.realname_verified), False)
    check("缺 sign → 请求仍是 pending", r.status, "pending")

    db = new_db()
    u, r = seed(db)
    out = svc.handle_callback(db, body("bs_test_0001", sign=""))
    db.refresh(u)
    check("sign 为空串 → 拒绝", out["resultCode"], "1")
    check("sign 为空串 → 用户未被实名", bool(u.realname_verified), False)

    # 这里必须把验签打桩成"判定为无效"，否则测的是"有效签名"那条路（第一版就写错过一次）
    stub_verify(False)
    db = new_db()
    u, r = seed(db)
    out = svc.handle_callback(db, body("bs_test_0001", sign=GOOD_SIGN))
    db.refresh(u); db.refresh(r)
    check("验签失败 → 拒绝", out["resultCode"], "1")
    check("验签失败 → 用户未被实名", bool(u.realname_verified), False)
    check("验签失败 → 请求仍是 pending", r.status, "pending")

    # 伪造一条自己不存在的 bizSeq（攻击者没有 pending 记录）。签名有效也不该给别人实名。
    stub_verify(True)
    db = new_db()
    u, _ = seed(db)
    out = svc.handle_callback(db, body("bs_i_made_this_up", sign=GOOD_SIGN))
    db.refresh(u)
    check("自造 bizSeq + 有效签名 → 不给任何人实名", bool(u.realname_verified), False)

    # ── 组 2：正常路径 ────────────────────────────────────────────
    print("\n[组 2] 正常路径：签名有效 + pending + 未过期")
    stub_verify(True)
    db = new_db()
    u, r = seed(db)
    out = svc.handle_callback(db, body("bs_test_0001", result_code="0"), )
    # 上面故意不带 sign，必须还是拒绝
    db.refresh(u)
    check("（对照片）正常路径缺签名仍拒绝", bool(u.realname_verified), False)

    db = new_db()
    u, r = seed(db)
    out = svc.handle_callback(db, body("bs_test_0001", result_code="0", sign=GOOD_SIGN))
    db.refresh(u); db.refresh(r)
    check("签名有效 → 返回成功", out["resultCode"], "0")
    check("签名有效 → 用户已实名", bool(u.realname_verified), True)
    check("签名有效 → 请求转 success", r.status, "success")
    check("签名有效 → 备注了认证时间", u.realname_verified_at is not None, True)

    db = new_db()
    u, r = seed(db)
    svc.handle_callback(db, body("bs_test_0001", result_code="1", sign=GOOD_SIGN))
    db.refresh(u); db.refresh(r)
    check("签名有效但 resultCode=1 → 用户不实名", bool(u.realname_verified), False)
    check("签名有效但 resultCode=1 → 请求转 fail", r.status, "fail")

    # ── 组 3：重放与过期 ─────────────────────────────────────────
    print("\n[组 3] 重放与过期")
    stub_verify(True)
    db = new_db()
    u, r = seed(db)
    svc.handle_callback(db, body("bs_test_0001", sign=GOOD_SIGN))
    first_ok = bool(db.query(User).filter(User.id == u.id).first().realname_verified)
    out2 = svc.handle_callback(db, body("bs_test_0001", sign=GOOD_SIGN))
    check("第一次成功", first_ok, True)
    check("重放同一 bizSeq → 拒绝", out2["resultCode"], "1")

    db = new_db()
    u, r = seed(db, age_minutes=svc.REALNAME_CALLBACK_MAX_AGE_SECONDS // 60 + 10)
    out = svc.handle_callback(db, body("bs_test_0001", sign=GOOD_SIGN))
    db.refresh(u)
    check("超期 bizSeq → 拒绝", out["resultCode"], "1")
    check("超期 bizSeq → 用户未被实名", bool(u.realname_verified), False)

    db = new_db()
    u, r = seed(db, status="fail")
    out = svc.handle_callback(db, body("bs_test_0001", sign=GOOD_SIGN))
    db.refresh(u)
    check("已是终态（fail）→ 拒绝复用", out["resultCode"], "1")
    check("已是终态 → 用户未被实名", bool(u.realname_verified), False)

    # ── 组 4：共享口令（可选纵深防御） ───────────────────────────
    print("\n[组 4] REALNAME_CALLBACK_TOKEN 配置后必须带对头")
    stub_verify(True)
    os.environ["REALNAME_CALLBACK_TOKEN"] = "tok_probe_123"
    try:
        db = new_db()
        u, r = seed(db)
        out = svc.handle_callback(db, body("bs_test_0001", sign=GOOD_SIGN), callback_token="")
        db.refresh(u)
        check("配了口令但没带头 → 拒绝", out["resultCode"], "1")
        check("配了口令但没带头 → 不实名", bool(u.realname_verified), False)

        db = new_db()
        u, r = seed(db)
        out = svc.handle_callback(db, body("bs_test_0001", sign=GOOD_SIGN), callback_token="wrong")
        db.refresh(u)
        check("口令不对 → 拒绝", bool(u.realname_verified), False)

        db = new_db()
        u, r = seed(db)
        out = svc.handle_callback(db, body("bs_test_0001", sign=GOOD_SIGN), callback_token="tok_probe_123")
        db.refresh(u)
        check("口令正确 → 放行并实名", bool(u.realname_verified), True)
    finally:
        os.environ.pop("REALNAME_CALLBACK_TOKEN", None)

    # ── 组 9：畸形报文不许变成 500 ────────────────────────────────
    # 2026-11 线上探针打出来的：把 bizPackage 发成字符串时，
    # 原来 `payload.get("bizPackage") or {}` 拿到的是 str，接着 .get() 抛
    # AttributeError，一路冒到路由层变成 500 + 整屏 traceback。
    # 要求：按"报文格式错误"干净拒掉，不抛异常、不改状态。
    print("\n[组 9] 畸形报文：bizPackage 不是对象")
    stub_verify(True)
    db = new_db()
    u, r = seed(db)
    weird = json.dumps({"bizPackage": "not-an-object",
                        "sign": GOOD_SIGN}, ensure_ascii=False)
    out = svc.handle_callback(db, weird)
    db.refresh(u); db.refresh(r)
    check("bizPackage 是字符串 → 拒绝", out["resultCode"], "1")
    check("bizPackage 是字符串 → 提示报文格式错误", out.get("resultDesc"), "报文格式错误")
    check("bizPackage 是字符串 → 用户未被实名", bool(u.realname_verified), False)
    check("bizPackage 是字符串 → 请求仍是 pending", r.status, "pending")

    out = svc.handle_callback(db, json.dumps({"bizPackage": ["a"], "sign": GOOD_SIGN}))
    check("bizPackage 是数组 → 拒绝", out["resultCode"], "1")

    out = svc.handle_callback(db, json.dumps({"bizPackage": None}))
    check("bizPackage 为 null → 拒绝", out["resultCode"], "1")
    check("bizPackage 为 null → 提示报文格式错误", out.get("resultDesc"), "报文格式错误")

    out = svc.handle_callback(db, "这不是JSON")
    check("报文不是 JSON → 拒绝", out.get("resultDesc"), "报文格式错误")

    # ── 组 10：验签的可信锚点（审计 A1）─────────────────────────
    # 这一组测的正是原来的洞：公钥原来完全取自"待验报文里自带的证书"，
    # parse_cert 不做链校验、仓库里也没有任何证书指纹 —— 自签一张证书就能过。
    # 现在要求"报文证书里的公钥 == 我们本来就信任的那把"，对不上直接失败。
    print("\n[组 10] 可信锚点：自签证书必须被拒")
    import os as _os
    from backend.services import gm_crypto as gc

    real_spki = svc.load_config().get("verify_public_key") or ""
    anchored = gc.spki_pub_hex(real_spki)
    check("能从 realname.json 解出可信公钥", len(anchored), 130)
    check("可信公钥是 04 开头的非压缩点", anchored[:2], "04")
    check("同一个点比对通过", gc.pub_hex_matches(anchored, anchored), True)
    check("大小写不影响比对", gc.pub_hex_matches(anchored.upper(), anchored), True)

    other = "04" + "11" * 64          # 攻击者自签证书里的公钥
    check("自签证书的公钥 ≠ 可信公钥 → 不通过", gc.pub_hex_matches(other, anchored), False)
    check("空公钥一律不通过", gc.pub_hex_matches("", anchored), False)
    check("没有锚点时一律不通过", gc.pub_hex_matches(anchored, ""), False)

    # pkcs7_verify 的锚点参数：给一段垃圾 DER 也不会抛异常，只会返回 False
    check("垃圾签名 + 锚点 → False 而不是抛异常",
          _REAL_PKCS7_VERIFY(b"\x00\x01\x02", b"x", expected_pub_hex=anchored), False)
    check("垃圾签名 + 自签/不匹配锚点 → 也是 False",
          _REAL_PKCS7_VERIFY(b"\x00\x01\x02", b"x", expected_pub_hex=other), False)

    # 端到端：没配锚点时必须拒绝（不是放行）
    saved_env = _os.environ.pop("REALNAME_VERIFY_PUBLIC_KEY", None)
    saved_cfg = svc.load_config
    svc.load_config = lambda: {"org_id": "x"}          # 没有 verify_public_key
    try:
        stub_verify(True)                               # 就算签名"有效"也不许过
        db = new_db()
        u, r = seed(db)
        out = svc.handle_callback(db, body("bs_test_0001", sign=GOOD_SIGN))
        db.refresh(u)
        check("没配可信公钥 → 拒绝", out["resultCode"], "1")
        check("没配可信公钥 → 措辞点名「无可用的可信公钥」",
              "无可用的实名可信公钥" in (out.get("resultDesc") or ""), True)
        check("没配可信公钥 → 用户未被实名", bool(u.realname_verified), False)
    finally:
        svc.load_config = saved_cfg
        if saved_env is not None:
            _os.environ["REALNAME_VERIFY_PUBLIC_KEY"] = saved_env

    # 审计 B1：报文里两个 bizPackage，验过的必须是用的那份
    print("\n[组 11] 重复键：验的和用的必须是同一份")
    stub_verify(True)
    db = new_db()
    u, r = seed(db, biz_seq="bs_dup_0001")
    dup = ('{"bizPackage":{"bizSeq":"bs_dup_0001","resultCode":"0"},'
           '"bizPackage":{"bizSeq":"bs_dup_EVIL","resultCode":"0"},"sign":"%s"}') % GOOD_SIGN
    out = svc.handle_callback(db, dup)
    db.refresh(u); db.refresh(r)
    check("重复键报文不会把别人实名掉", bool(u.realname_verified), True)
    check("重复键时用的是验过的那一份（不是最后一个）", r.biz_seq, "bs_dup_0001")

    # ── 组 12：锚点参数必填 + 三种形态 + 环境变量配错时回落 ──────────
    print("\n[组 12] 锚点：必填、形态容忍、配错时回落")
    import os as _os2

    # 12.1 锚点参数必填：漏传必须 TypeError，不能安静地回到"自带证书自己过"
    try:
        _REAL_PKCS7_VERIFY(b"\x00", b"x")
        typed = False
    except TypeError:
        typed = True
    check("漏传锚点参数 → TypeError（不许静默放行）", typed, True)

    # 12.2 allow_untrusted=True 是具名逃生口：只跳过「比对」，不是跳过「解析」
    check("allow_untrusted=True + 垃圾 DER → 仍返回 False（解析不过）",
          _REAL_PKCS7_VERIFY(b"\x00\x01", b"x", "", allow_untrusted=True), False)

    # 12.3 形态容忍：PEM / 纯 base64 都能解出同一个点；点名 hex 解不出（这是常见误配）
    check("纯 base64 SPKI → 130 字符点", gc.spki_pub_hex(real_spki), anchored)
    pem = "-----BEGIN PUBLIC KEY-----\n" + real_spki + "\n-----END PUBLIC KEY-----"
    check("PEM 形态 → 与 base64 同一个点", gc.spki_pub_hex(pem), anchored)
    check("点名 hex 形态（常见误配）→ 解析为空", gc.spki_pub_hex(anchored), "")
    check("空串 → 解析为空", gc.spki_pub_hex(""), "")

    # 12.4 环境变量填错 → 回落 realname.json，而不是整体失效
    saved2 = _os2.environ.pop("REALNAME_VERIFY_PUBLIC_KEY", None)
    try:
        _os2.environ["REALNAME_VERIFY_PUBLIC_KEY"] = "这不是公钥"
        check("环境变量填错 → 回落到文件里的好钥匙", svc._trusted_pub_hex(), anchored)
        _os2.environ["REALNAME_VERIFY_PUBLIC_KEY"] = real_spki
        check("环境变量填对 → 直接用", svc._trusted_pub_hex(), anchored)
    finally:
        _os2.environ.pop("REALNAME_VERIFY_PUBLIC_KEY", None)
        if saved2 is not None:
            _os2.environ["REALNAME_VERIFY_PUBLIC_KEY"] = saved2

    print("\n" + "=" * 68)
    print("通过 %d 项，失败 %d 项" % (len(PASSED), len(FAILED)))
    if FAILED:
        for f in FAILED:
            print("  ✗ %s" % f)
        return 1
    print("全部通过 ✓")
    return 0


if __name__ == "__main__":
    sys.exit(main())
