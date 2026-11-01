"""实名认证业务逻辑（国家网络身份认证公共服务 · 扫码认证 · 安全接入平台）。

流程（扫码认证 + R01 网络身份认证凭证）：
  1. 生码：组包 → 数字信封加密 qrcodeAuthData → P1 签名 requestSign → 请求安全接入平台 → 返回二维码
  2. 回调：平台推送认证结果 → 验签 → 解析 → 更新用户实名状态

参考官方 Java demo（secure-access-tools）实现，字段顺序与签名原文严格对齐。
"""
import base64
import hashlib
import io
import json
import logging
import os
import secrets
import urllib.request
import urllib.error
from datetime import datetime, timezone

import segno

from ..core.config import DATA_DIR
from ..models.user import User
from ..models.realname import RealnameRequest
from . import gm_crypto

logger = logging.getLogger(__name__)

_CONFIG_CACHE = {"ts": 0, "data": None}
_TIMEOUT = 30
# 回调用 bizSeq 的有效期。官方推送通常是秒级到分钟级，留 30 分钟足够，
# 又能挡住「很久以前那条 bizSeq 被翻出来重放」。
REALNAME_CALLBACK_MAX_AGE_SECONDS = 30 * 60


def load_config() -> dict:
    """加载实名认证配置（data/realname.json，带简单缓存）。"""
    path = os.path.join(DATA_DIR, "realname.json")
    try:
        mtime = os.path.getmtime(path)
        if _CONFIG_CACHE["data"] is not None and _CONFIG_CACHE["ts"] == mtime:
            return _CONFIG_CACHE["data"]
        with open(path, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        _CONFIG_CACHE["data"] = cfg
        _CONFIG_CACHE["ts"] = mtime
        return cfg
    except FileNotFoundError:
        raise RuntimeError("实名认证配置缺失：data/realname.json")
    except Exception as e:  # noqa: BLE001
        raise RuntimeError(f"实名认证配置加载失败：{e}")


def _trusted_pub_hex() -> str:
    """取「我们本来就信任的那把签名公钥」——验签的可信锚点。

    来源优先级：环境变量 REALNAME_VERIFY_PUBLIC_KEY（SPKI base64）→ data/realname.json 的 verify_public_key。
    取不到就返回空串，调用方必须据此**拒绝**（而不是放行）。
    """
    # 注意两种失败必须分开说（2026-11 审计二次意见）：
    #   「没配」→ 用户/运维还没填，该提示去填；
    #   「配了但解析不出来」→ 填错了（最常见：把 130 字符的点名 hex 或整段 PEM 当公钥贴进来，
    #   或者环境变量里填错一个字符）。原来两者回同一个"未配置"，会把排障方向带偏半小时。
    env_val = os.environ.get("REALNAME_VERIFY_PUBLIC_KEY", "").strip()
    if env_val:
        got = gm_crypto.spki_pub_hex(env_val)
        if got:
            return got
        logger.error(
            "[实名认证] 环境变量 REALNAME_VERIFY_PUBLIC_KEY 无法解析为 SPKI（长度=%d），"
            "回落到 realname.json.verify_public_key。它需要是 openssl 导出的 "
            "SubjectPublicKeyInfo（base64 或 PEM），不是点名 hex。",
            len(env_val),
        )
    try:
        cfg = load_config()
    except Exception as e:  # noqa: BLE001
        logger.error("[实名认证] 读取可信公钥时加载配置失败: %s", e)
        return ""
    raw = (cfg.get("verify_public_key") or "").strip()
    if not raw:
        logger.error("[实名认证] 可信公钥未配置：realname.json 里没有 verify_public_key")
        return ""
    got = gm_crypto.spki_pub_hex(raw)
    if not got:
        logger.error(
            "[实名认证] realname.json.verify_public_key 无法解析为 SPKI（长度=%d）。"
            "它需要是 SubjectPublicKeyInfo（base64 或 PEM），不是点名 hex。",
            len(raw),
        )
    return got


def _gen_biz_seq() -> str:
    """业务序列号：32 位随机 hex。"""
    return secrets.token_hex(16)


def _gen_timestamp() -> str:
    """时间戳：YYYYMMddHHmmssSSS（17 位，含毫秒）。"""
    return datetime.now().strftime("%Y%m%d%H%M%S%f")[:-3]


def _json_dumps(obj) -> str:
    """无空格 JSON（ensure_ascii=False 保证中文不转义，与 Jackson 一致）。"""
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def _post_json(url: str, body_str: str) -> dict:
    """POST JSON，返回解析后的 dict。"""
    req = urllib.request.Request(
        url,
        data=body_str.encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"安全接入平台返回 HTTP {e.code}: {body}")
    except urllib.error.URLError as e:
        raise RuntimeError(f"无法连接安全接入平台: {e.reason}")


def generate_qrcode(db, user_id: str) -> dict:
    """生成扫码认证二维码。返回 {bizSeq, bizSerialNo, qrCode}。"""
    cfg = load_config()
    biz_seq = _gen_biz_seq()
    timestamp = _gen_timestamp()

    # 1. qrcodeAuthData = 数字信封加密 {orgID, appID, notifyStrategy}
    auth_plain = _json_dumps({
        "orgID": cfg["org_id"],
        "appID": cfg["app_id"],
        "notifyStrategy": cfg.get("notify_strategy", 1),
    })
    envelop = gm_crypto.encode_envelop(cfg["encrypt_cert"], auth_plain.encode("utf-8"))
    qrcode_auth_data = base64.b64encode(envelop).decode()
    # 诊断日志（warning 级别：保证生产环境可见，便于排查 orgID/appID 是否传错）
    logger.warning("[实名认证] 生码请求 bizSeq=%s qrcodeAuthData明文=%s 数字信封字节数=%d",
                   biz_seq, auth_plain, len(envelop))

    # 2. 组包（字段顺序与官方 demo 严格一致）
    biz_package = {
        "appName": cfg.get("app_name", "AI剧本网"),
        "timestamp": timestamp,
        "bizSeq": biz_seq,
        "mode": "R01",
        "customerNo": cfg["customer_no"],
        "qrcodeAuthData": qrcode_auth_data,
    }
    request_package = {
        "bizPackage": biz_package,
        "customerNo": cfg["customer_no"],
        "forwardUrl": cfg["qrcode_forward_url"],
    }

    # 3. requestSign = SM2 签名（鉴权私钥，对 requestPackage JSON，含 ZA）
    request_package_json = _json_dumps(request_package)
    priv_hex = gm_crypto.pkcs8_private_key_to_hex(cfg["sign_private_key"])
    pub_hex = gm_crypto.pub_from_priv(priv_hex)
    sig_der = gm_crypto.sm2_sign(priv_hex, pub_hex, request_package_json.encode("utf-8"))
    request_sign = base64.b64encode(sig_der).decode()

    request_body = _json_dumps({
        "requestPackage": request_package,
        "requestSign": request_sign,
    })

    # 3.5 记录 bizSeq → user 关联（用于回调时定位用户）
    req = RealnameRequest(id=secrets.token_hex(8), user_id=user_id, biz_seq=biz_seq)
    db.add(req)
    db.commit()

    # 4. 请求安全接入平台
    url = cfg["sap_url"] + "/unified_auth/request"
    result = _post_json(url, request_body)

    # 5. 解析响应
    response_package = result.get("responsePackage") or {}
    platform_code = response_package.get("platformCode")
    if platform_code != "200":
        return {
            "bizSeq": biz_seq,
            "error": response_package.get("platformMsg") or f"平台错误码 {platform_code}",
        }

    platform_data = response_package.get("platformData")
    if not isinstance(platform_data, dict):
        return {"bizSeq": biz_seq, "error": "平台响应里 platformData 不是对象"}
    # 平台把 bizPackage 回成字符串时，原来会在 biz_resp.get() 上抛 AttributeError -> 500。
    # 这类报文本身就没法用，直接当平台错误返回，不要把异常漏到 HTTP 层。
    biz_resp = platform_data.get("bizPackage")
    if not isinstance(biz_resp, dict):
        return {"bizSeq": biz_seq, "error": "平台响应里 bizPackage 不是对象"}
    result_code = biz_resp.get("resultCode")
    if result_code != "C0000000":
        return {
            "bizSeq": biz_seq,
            "error": biz_resp.get("resultDesc") or f"生码失败 {result_code}",
        }

    qr_code = (biz_resp.get("data") or {}).get("qrCode") or ""
    # 诊断日志（warning 级别：生产环境 root logger 默认不输出 info）
    logger.warning("[实名认证] 生码成功 bizSeq=%s bizSerialNo=%s qrCode长度=%d",
                   biz_seq, biz_resp.get("bizSerialNo", ""), len(qr_code))
    # 二维码内容 = qrCode 字段值（Base64 字符串）本身，按文本编码生成二维码图像。
    # 依据：说明书"a) 二维码数据为 Base64 编码"——App 扫码读到的是该 Base64 文本并回传
    # 平台验码；若把 qrCode 解码成二进制再以 byte 模式编码，App 读到的是二进制而非
    # 平台预期的 Base64 文本，会提示「无效的二维码」。
    qr_image_b64 = ""
    if qr_code:
        try:
            buf = io.BytesIO()
            segno.make(qr_code, error="q").save(buf, kind="png", scale=8, border=4)
            qr_image_b64 = base64.b64encode(buf.getvalue()).decode()
        except Exception as e:  # noqa: BLE001
            logger.warning("[实名认证] 二维码图片生成失败: %s", e)

    return {
        "bizSeq": biz_seq,
        "bizSerialNo": biz_resp.get("bizSerialNo", ""),
        "qrCode": qr_code,
        "qrCodeImage": qr_image_b64,
    }


def handle_callback(db, raw_str: str, callback_token: str = "") -> dict:
    """处理扫码认证结果回调（平台 → 我方）。

    参数 raw_str 为官方推送的原始 JSON 报文（字节级保留），用于精确验签。
    返回 {"resultCode": "0", "resultDesc": "成功"} 或失败结果。
    """
    # 诊断日志只留"长度 + 摘要"，不再整段打印原始报文（审计 B2）：
    # 官方回调必然包含 PID / 姓名 / 证件号 / 手机号，整段进 journald 就会随备份外流。
    if not isinstance(raw_str, str) or not raw_str:
        logger.warning("[实名认证] 回调报文为空或不是文本，拒绝处理")
        return {"resultCode": "1", "resultDesc": "报文格式错误"}
    logger.warning(
        "[实名认证] 收到回调报文 %d 字节 sha256=%s",
        len(raw_str), hashlib.sha256(raw_str.encode("utf-8")).hexdigest()[:16],
    )
    try:
        payload = json.loads(raw_str)
    except Exception as e:  # noqa: BLE001
        logger.warning("[实名认证] 回调报文非 JSON: %s", e)
        return {"resultCode": "1", "resultDesc": "报文格式错误"}

    # 顶层必须是个对象（审计 A3）。原来只在 bizPackage 上做了 isinstance，
    # 顶层是数组 / null / 数字 / 字符串 / 布尔时 payload.get 会抛 AttributeError -> 500。
    if not isinstance(payload, dict):
        logger.warning(
            "[实名认证] 回调顶层不是对象（type=%s），拒绝处理", type(payload).__name__,
        )
        return {"resultCode": "1", "resultDesc": "报文格式错误"}

    # 回调报文里 bizPackage 必须是对象。原来写成 `payload.get("bizPackage") or {}`，
    # 平台/攻击者把它发成字符串时，下面 biz_package.get(...) 会抛 AttributeError，
    # 一路冒到路由层变成 500 + 整屏 traceback（2026-11 线上探针实测就是这个 500）。
    # 这里先按形状收口：不是对象就当报文格式错误拒掉 —— 反正业务字段一个都读不出来。
    biz_package = payload.get("bizPackage")
    if not isinstance(biz_package, dict):
        logger.warning(
            "[实名认证] 回调 bizPackage 不是对象（type=%s），拒绝处理",
            type(biz_package).__name__,
        )
        return {"resultCode": "1", "resultDesc": "报文格式错误"}
    sign = payload.get("sign") or ""

    # ⚠️ 这一组字段来自**未验签**的报文，只允许喂日志。
    # 验签通过后会用「验过的那段原文」重新解析一遍（见下面 verified_pkg），业务分支一律读那份。
    # 如果哪天有人拿这里的 biz_seq 去查库/写库，等于给伪造报文开了口子。
    biz_seq = biz_package.get("bizSeq", "")
    biz_serial_no = biz_package.get("bizSerialNo", "")
    result_code = str(biz_package.get("resultCode", ""))
    result_desc = biz_package.get("resultDesc", "")
    pid = biz_package.get("PID", "")
    event_type = biz_package.get("eventType", "")

    logger.warning(
        "[实名认证] 回调解析 bizSeq=%s bizSerialNo=%s resultCode=%s eventType=%s",
        biz_seq, biz_serial_no, result_code, event_type,
    )

    # ── 验签（强制）与业务校验，顺序不可调换：验签不过之前不许改任何状态 ──
    #
    # 历史教训（2026-11 安全审计 P0-5）：这里原本是 `if sign:` —— 也就是「不传 sign 就完全不验签」。
    # 于是任意登录用户只要 POST
    #     {"bizPackage":{"bizSeq":"<自己那条>","resultCode":"0"}}
    # 就能把自己标成 realname_verified=True，全程不碰「国家网络身份认证」App。
    # bizSeq 是生码接口的返回值，前端从 /api/auth/realname-verify 的响应里就能读到自己那一条，
    # 所以这不是理论风险，是一条照抄就能用的越权路径。代码一旦公开等于把利用步骤一起送出去。
    # 现改为：sign 缺失 / 为空 / base64 解不开 / 验签失败，一律拒绝，且不进行任何状态变更。
    if not sign:
        logger.warning(
            "[实名认证] 回调缺少 sign，拒绝处理 bizSeq=%s（未验签的报文不允许触发状态变更）",
            biz_seq,
        )
        return {"resultCode": "1", "resultDesc": "缺少签名，拒绝处理"}

    # 签名原文必须是官方推送时的【原始 bizPackage 子串】，不能重序列化 dict，
    # 否则字段顺序/转义/空格与签名时不一致会导致验签失败。
    # 审计 A1：验签必须拿"我们本来就信任的公钥"当锚点，否则报文自带的证书自己就能过。
    expected_pub = _trusted_pub_hex()
    if not expected_pub:
        logger.error(
            "[实名认证] 无可用的实名可信公钥（缺失或无法解析，详见上一条日志），"
            "拒绝处理 bizSeq=%s。当前行为是「宁可不认证，也不接受任何自签证书」。",
            biz_seq,
        )
        return {"resultCode": "1", "resultDesc": "服务端无可用的实名可信公钥，拒绝处理"}

    try:
        biz_raw = _extract_biz_package_raw(raw_str)
        sig_der = base64.b64decode(sign)
        if not gm_crypto.pkcs7_verify(sig_der, biz_raw.encode("utf-8"), expected_pub_hex=expected_pub):
            logger.warning(
                "[实名认证] 回调验签失败 bizSeq=%s（签名不匹配，或证书公钥不是可信公钥）", biz_seq,
            )
            return {"resultCode": "1", "resultDesc": "验签失败"}
    except Exception as e:  # noqa: BLE001
        logger.error("[实名认证] 回调验签异常: %s", e)
        return {"resultCode": "1", "resultDesc": "验签异常"}

    # 审计 B1：验签用的是"第一个 bizPackage 子串"，json.loads 取的是"最后一个重复键"。
    # 报文里出现两个 bizPackage 时，会出现"验的是一份、用的是另一份"。
    # 验签既然已经通过，业务对象一律从**验过的那段原文**重新解析，从根上抹掉分歧。
    try:
        verified_pkg = json.loads(biz_raw)
    except Exception as e:  # noqa: BLE001
        logger.error("[实名认证] 验签原文无法解析为对象: %s", e)
        return {"resultCode": "1", "resultDesc": "报文格式错误"}
    if not isinstance(verified_pkg, dict):
        logger.error("[实名认证] 验签原文不是对象（type=%s）", type(verified_pkg).__name__)
        return {"resultCode": "1", "resultDesc": "报文格式错误"}

    biz_package = verified_pkg
    biz_seq = biz_package.get("bizSeq", "")
    biz_serial_no = biz_package.get("bizSerialNo", "")
    result_code = str(biz_package.get("resultCode", ""))
    result_desc = biz_package.get("resultDesc", "")
    pid = biz_package.get("PID", "")
    event_type = biz_package.get("eventType", "")

    # 纵深防御（可选）：服务器 systemd unit 里注入 REALNAME_CALLBACK_TOKEN 后，回调必须带同一个头。
    # 不配置时保持现状（官方推送不带该头），避免把生产回调直接挡死。
    # 用 compare_digest 而不是 ==，避免按字节提前返回泄露口令长度信息。
    expected_token = os.environ.get("REALNAME_CALLBACK_TOKEN", "").strip()
    if expected_token:
        if not secrets.compare_digest((callback_token or "").strip(), expected_token):
            logger.warning("[实名认证] 回调共享口令不匹配 bizSeq=%s", biz_seq)
            return {"resultCode": "1", "resultDesc": "鉴权失败"}

    # 业务校验：bizSeq 必须是我们发出去、仍待认证、且在有效期内的那一条。
    # 三种情况都拒绝，任何一个放过去都等于把「自己造一条 bizSeq 反复认证」的口子留着。
    req = db.query(RealnameRequest).filter(RealnameRequest.biz_seq == biz_seq).first()
    if not req:
        # 保持原来的宽容返回（官方可能对同一结果重复推送，找不到就当作已处理），只记日志。
        logger.warning("[实名认证] 未找到 bizSeq=%s 对应的认证请求", biz_seq)
    elif req.status != "pending":
        logger.warning(
            "[实名认证] bizSeq=%s 状态已是 %s，拒绝重复消费（防重放）", biz_seq, req.status
        )
        return {"resultCode": "1", "resultDesc": "该认证请求已处理"}
    elif _callback_expired(req.created_at):
        logger.warning(
            "[实名认证] bizSeq=%s 已超过 %d 分钟有效期，拒绝",
            biz_seq, REALNAME_CALLBACK_MAX_AGE_SECONDS // 60,
        )
        return {"resultCode": "1", "resultDesc": "认证请求已过期"}
    else:
        req.status = "success" if result_code == "0" else "fail"
        req.result_code = result_code
        req.result_desc = result_desc
        req.biz_serial_no = biz_serial_no
        if result_code == "0":
            user = db.query(User).filter(User.id == req.user_id).first()
            if user:
                user.realname_verified = True
                user.realname_verified_at = datetime.now(timezone.utc)
        db.commit()
        logger.warning(
            "[实名认证] 认证%s bizSeq=%s code=%s",
            "成功" if result_code == "0" else "失败", biz_seq, result_code,
        )

    return {"resultCode": "0", "resultDesc": "成功"}


def _callback_expired(created_at) -> bool:
    """判断发起认证的时间是否已超过有效期。

    SQLite 读回来的 DateTime 是 naive UTC（写入时带 tz 也会退化成 naive），
    所以这里统一按 naive UTC 比较，两种形态都能处理。
    """
    if created_at is None:
        return False
    now = datetime.now(timezone.utc)
    ref = created_at
    if ref.tzinfo is None:
        ref = ref.replace(tzinfo=timezone.utc)
    return (now - ref).total_seconds() > REALNAME_CALLBACK_MAX_AGE_SECONDS


def _extract_biz_package_raw(raw_str: str) -> str:
    """从原始 JSON 报文里提取 bizPackage 字段的【原始子串】（字节级保留）。"""
    idx = raw_str.find('"bizPackage"')
    if idx == -1:
        raise ValueError("报文中缺少 bizPackage 字段")
    brace = raw_str.find("{", idx)
    if brace == -1:
        raise ValueError("bizPackage 后缺少对象起始符")
    decoder = json.JSONDecoder()
    _, end = decoder.raw_decode(raw_str[brace:])
    return raw_str[brace:brace + end]
