# -*- coding: utf-8 -*-
"""国密工具模块：SM2/SM3/SM4 + PKCS#7 数字信封（对接国家网络身份认证公共服务·安全接入平台）。

参考官方 Java demo（secure-access-tools）实现，算法与 OID 完全对齐：
  - SM2 签名/验签（DER 格式）
  - SM2 加密（C1C3C2 模式，GB/T 32918 新国标）
  - SM4-ECB 加解密（PKCS7 填充）
  - SM3 摘要
  - 数字信封 encode_envelop / decode_envelop（PKCS#7 EnvelopedData，国密 CMS）
"""
import base64
import hashlib
import hmac
import logging
import os

logger = logging.getLogger(__name__)

from gmssl import sm2, sm3, sm4, func

# ==================== 国密 OID ====================
OID_EC_PUBLIC_KEY = "1.2.840.10045.2.1"
OID_SM2P256V1 = "1.2.156.10197.1.301"
OID_SM2_ENC = "1.2.156.10197.1.301.3"       # keyEncryptionAlgorithm
OID_SM4 = "1.2.156.10197.1.104"             # contentEncryptionAlgorithm
OID_ENVELOPED_DATA = "1.2.156.10197.6.1.4.2.3"
OID_SIGNED_DATA = "1.2.156.10197.6.1.4.2.2"
OID_DATA = "1.2.156.10197.6.1.4.2.1"


# ==================== ASN.1 DER 工具 ====================
def der_len(n: int) -> bytes:
    if n < 128:
        return bytes([n])
    b = n.to_bytes((n.bit_length() + 7) // 8, 'big')
    return bytes([0x80 | len(b)]) + b


def tlv(tag: int, content: bytes) -> bytes:
    return bytes([tag]) + der_len(len(content)) + content


def seq(*items: bytes) -> bytes:
    return tlv(0x30, b"".join(items))


def integer(n: int) -> bytes:
    if n == 0:
        return b"\x02\x01\x00"
    b = n.to_bytes((n.bit_length() + 7) // 8, 'big')
    if b[0] & 0x80:
        b = b"\x00" + b
    return tlv(0x02, b)


def octet_string(data: bytes) -> bytes:
    return tlv(0x04, data)


def encode_oid(oid_str: str) -> bytes:
    parts = [int(x) for x in oid_str.split(".")]
    first = 40 * parts[0] + parts[1]
    enc = [first]
    for v in parts[2:]:
        stack = [v & 0x7F]
        v >>= 7
        while v:
            stack.append((v & 0x7F) | 0x80)
            v >>= 7
        enc.extend(reversed(stack))
    return tlv(0x06, bytes(enc))


def algo_identifier(oid_str: str) -> bytes:
    """AlgorithmIdentifier ::= SEQUENCE { algorithm OID }"""
    return seq(encode_oid(oid_str))


def context_tag(num: int, content: bytes, explicit: bool = True) -> bytes:
    if explicit:
        return tlv(0xA0 | num, content)
    return bytes([0x80 | num]) + der_len(len(content)) + content


def parse_tlv(data: bytes, idx: int = 0):
    """解析单个 TLV，返回 (tag, value_bytes, next_idx)。"""
    tag = data[idx]
    idx += 1
    b = data[idx]
    idx += 1
    if b < 0x80:
        length = b
    else:
        n = b & 0x7F
        length = int.from_bytes(data[idx:idx + n], "big")
        idx += n
    value = data[idx:idx + length]
    return tag, value, idx + length


def parse_seq_elements(seq_content: bytes):
    """解析 SEQUENCE 内容，返回子元素列表 [(tag, value), ...]。"""
    elems = []
    idx = 0
    while idx < len(seq_content):
        tag, val, idx = parse_tlv(seq_content, idx)
        elems.append((tag, val))
    return elems


def parse_elems_full(content: bytes):
    """解析 SEQUENCE 内容，返回 [(tag, full_der, value), ...]（保留完整 DER）。"""
    elems = []
    idx = 0
    while idx < len(content):
        start = idx
        tag, value, idx = parse_tlv(content, idx)
        full_der = content[start:idx]
        elems.append((tag, full_der, value))
    return elems


# ==================== 密钥解析 ====================
def pkcs8_private_key_to_hex(priv_b64: str) -> str:
    """从 PKCS#8 私钥（base64）提取裸 32 字节私钥 hex。"""
    der = base64.b64decode(priv_b64)
    tag, seq_content, _ = parse_tlv(der, 0)
    assert tag == 0x30
    elems = parse_seq_elements(seq_content)
    # elems[0]=INTEGER 0, elems[1]=algo, elems[2]=OCTET STRING(ECPrivateKey 完整DER)
    ec_der = elems[2][1]
    tag, ec_content, _ = parse_tlv(ec_der, 0)
    assert tag == 0x30
    ec_elems = parse_seq_elements(ec_content)
    # ec_elems[0]=INTEGER 1, ec_elems[1]=OCTET STRING d
    return ec_elems[1][1].hex()


def x509_public_key_to_hex(pub_b64: str) -> str:
    """从 X.509 SubjectPublicKeyInfo（base64）提取公钥点（04||x||y）hex。"""
    der = base64.b64decode(pub_b64)
    tag, seq_content, _ = parse_tlv(der, 0)
    assert tag == 0x30
    elems = parse_seq_elements(seq_content)
    bitstr = elems[1][1]
    return bitstr[1:].hex()  # 跳过未使用位数


def parse_cert(cert_b64: str) -> dict:
    """解析 SM2 证书，提取公钥点 / issuer(DER) / serialNumber。"""
    der = base64.b64decode(cert_b64)
    tag, cert_content, _ = parse_tlv(der, 0)
    assert tag == 0x30
    cert_elems = parse_elems_full(cert_content)
    tbs_der = cert_elems[0][1]  # tbsCertificate 完整 DER

    tag, tbs_content, _ = parse_tlv(tbs_der, 0)
    assert tag == 0x30
    elems = parse_elems_full(tbs_content)

    idx = 0
    # version [0] EXPLICIT（可选）
    if elems[idx][0] == 0xA0:
        idx += 1
    # serialNumber INTEGER
    serial_der = elems[idx][1]
    serial = int.from_bytes(elems[idx][2], "big")
    idx += 1
    # signature AlgorithmIdentifier（跳过）
    idx += 1
    # issuer Name（SEQUENCE）—— 原样保留完整 DER
    issuer_der = elems[idx][1]
    idx += 1
    # validity（跳过）
    idx += 1
    # subject Name（跳过）
    idx += 1
    # subjectPublicKeyInfo SEQUENCE { algorithm, BIT STRING }
    spki_content = elems[idx][2]
    spki_elems = parse_seq_elements(spki_content)
    bitstr = spki_elems[1][1]
    pub_point = bitstr[1:]  # 04||x||y

    return {
        "public_key_hex": pub_point.hex(),
        "issuer_der": issuer_der,
        "serial": serial,
        "serial_der": serial_der,
    }


# ==================== SM3 / SM4 ====================
def sm3_hash(data: bytes) -> bytes:
    return bytes.fromhex(sm3.sm3_hash(func.bytes_to_list(data)))


def sm4_ecb_encrypt(key: bytes, data: bytes) -> bytes:
    """SM4-ECB 加密（PKCS7 填充）。"""
    pad_len = 16 - len(data) % 16
    data = data + bytes([pad_len]) * pad_len
    c = sm4.CryptSM4()
    c.set_key(list(key), sm4.SM4_ENCRYPT)
    ct = c.crypt_ecb(func.bytes_to_list(data))
    return bytes(ct)


def sm4_ecb_decrypt(key: bytes, data: bytes) -> bytes:
    """SM4-ECB 解密（去除 PKCS7 填充）。"""
    c = sm4.CryptSM4()
    c.set_key(list(key), sm4.SM4_DECRYPT)
    pt = c.crypt_ecb(func.bytes_to_list(data))
    pt = bytes(pt)
    pad = pt[-1]
    return pt[:-pad]


# ==================== SM2 曲线参数与 ZA ====================
_SM2_P = 0xFFFFFFFEFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF00000000FFFFFFFFFFFFFFFF
_SM2_A = 0xFFFFFFFEFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF00000000FFFFFFFFFFFFFFFC
_SM2_B = 0x28E9FA9E9D9F5E344D5A9E4BCF6509A7F39789F515AB8F92DDBCBD414D940E93
_SM2_N = 0xFFFFFFFEFFFFFFFFFFFFFFFFFFFFFFFF7203DF6B21C6052B53BBF40939D54123
_SM2_GX = 0x32C4AE2C1F1981195F9904466A39C9948FE30BBFF2660BE1715A4589334C74C7
_SM2_GY = 0xBC3736A2F4F6779C59BDCEE36B692153D0A9877CC62A474002DF32E52139F0A0
_SM2_IDA = "1234567812345678"  # GB/T 32918 默认用户标识（16 字节）


def _point_add(p1, p2):
    if p1 is None:
        return p2
    if p2 is None:
        return p1
    x1, y1 = p1
    x2, y2 = p2
    if x1 == x2 and (y1 + y2) % _SM2_P == 0:
        return None
    if p1 == p2:
        lam = (3 * x1 * x1 + _SM2_A) * pow(2 * y1, -1, _SM2_P) % _SM2_P
    else:
        lam = (y2 - y1) * pow(x2 - x1, -1, _SM2_P) % _SM2_P
    x3 = (lam * lam - x1 - x2) % _SM2_P
    y3 = (lam * (x1 - x3) - y1) % _SM2_P
    return (x3, y3)


def _point_mul(k, p):
    r = None
    while k:
        if k & 1:
            r = _point_add(r, p)
        p = _point_add(p, p)
        k >>= 1
    return r


def pub_from_priv(private_key_hex: str) -> str:
    """从私钥推导公钥点（04||x||y，130 hex）。"""
    d = int(private_key_hex, 16)
    x, y = _point_mul(d, (_SM2_GX, _SM2_GY))
    return "04" + x.to_bytes(32, "big").hex() + y.to_bytes(32, "big").hex()


def _sm2_za(public_key_hex: str) -> bytes:
    """计算 ZA = SM3(ENTLA || IDA || a || b || Gx || Gy || Px || Py)。"""
    entl = (len(_SM2_IDA) * 8).to_bytes(2, "big")
    za_input = (
        entl + _SM2_IDA.encode() +
        _SM2_A.to_bytes(32, "big") + _SM2_B.to_bytes(32, "big") +
        _SM2_GX.to_bytes(32, "big") + _SM2_GY.to_bytes(32, "big") +
        bytes.fromhex(public_key_hex[2:66]) + bytes.fromhex(public_key_hex[66:130])
    )
    return sm3_hash(za_input)


def _sm2_e(public_key_hex: str, data: bytes) -> bytes:
    """计算 e = SM3(ZA || M)。"""
    return sm3_hash(_sm2_za(public_key_hex) + data)


# ==================== SM2 签名 / 验签 ====================
def sm2_sign(private_key_hex: str, public_key_hex: str, data: bytes) -> bytes:
    """标准 SM2 签名（含 ZA），返回 DER 格式（SEQUENCE { r, s }）字节。"""
    e = _sm2_e(public_key_hex, data)
    crypt = sm2.CryptSM2(public_key="", private_key=private_key_hex)
    # gmssl sign 期望传入"消息的 hash"（即 e 值），返回裸 r||s（64字节 hex）
    r_s_hex = crypt.sign(e, func.random_hex(64))
    r_s = bytes.fromhex(r_s_hex)
    r = int.from_bytes(r_s[:32], "big")
    s = int.from_bytes(r_s[32:], "big")
    return seq(integer(r), integer(s))


def sm2_verify(public_key_hex: str, data: bytes, signature_der: bytes) -> bool:
    """标准 SM2 验签（含 ZA，signature_der 为 DER 格式字节）。"""
    e = _sm2_e(public_key_hex, data)
    tag, seq_content, _ = parse_tlv(signature_der, 0)
    assert tag == 0x30
    elems = parse_seq_elements(seq_content)
    r = int.from_bytes(elems[0][1], "big")
    s = int.from_bytes(elems[1][1], "big")
    r_s_hex = r.to_bytes(32, "big").hex() + s.to_bytes(32, "big").hex()
    crypt = sm2.CryptSM2(public_key=public_key_hex, private_key="")
    return crypt.verify(r_s_hex, e)


def spki_pub_hex(spki_b64_or_der) -> str:
    """把 SubjectPublicKeyInfo（base64 文本或 DER bytes）转成 SM2 点名 hex（04||x||y）。

    data/realname.json 里的 verify_public_key 就是一段 SPKI base64，
    它和 X.509 证书里抠出来的公钥是同一个点。验签前用它做「可信锚点」比对，
    这样「报文里自带一张自签证书」就不再能通过验签。
    解析失败一律返回空串 —— 空串在调用方等价于「没有锚点」，一律拒绝。
    """
    try:
        if isinstance(spki_b64_or_der, str):
            # 容忍 PEM 形态（-----BEGIN PUBLIC KEY----- ... -----END PUBLIC KEY-----）：
            # 运维最常把 openssl 导出的 PEM 整段贴进配置，不剥头尾就会解析失败，
            # 而解析失败等于「拒绝一切回调」，线上表现为实名认证整体失效。
            text = spki_b64_or_der.strip()
            if "-----BEGIN" in text:
                lines = [ln.strip() for ln in text.splitlines()]
                text = "".join(ln for ln in lines if ln and not ln.startswith("-----"))
            der = base64.b64decode(text, validate=False)
        else:
            der = bytes(spki_b64_or_der)
        tag, content, _ = parse_tlv(der, 0)
        if tag != 0x30:
            return ""
        elems = parse_seq_elements(content)
        if len(elems) < 2:
            return ""
        bitstr = elems[1][1]
        point = bitstr[1:]  # 去掉 unused-bits 那个字节
        return point.hex().lower()
    except Exception:  # noqa: BLE001
        return ""


def pub_hex_matches(got: str, expected: str) -> bool:
    """比对两个 SM2 点名。空值一律不通过（宁可拒绝，也不要"没配锚点就放行"）。"""
    g = (got or "").strip().lower()
    e = (expected or "").strip().lower()
    if not g or not e:
        return False
    if len(g) != len(e):
        return False
    return hmac.compare_digest(g, e)


def pkcs7_verify(sign_der: bytes, data: bytes, expected_pub_hex: str,
                 *, allow_untrusted: bool = False) -> bool:
    """验签 PKCS#7 SignedData（国密 detach 模式）。

    结构（参考官方 demo 的 pkcs7Sign）：
      ContentInfo { OID signedData, [0] EXPLICIT SignedData }
      SignedData { version, digestAlgorithms, contentInfo, [0] IMPLICIT certificates, signerInfos }
    从 certificates 提取签名证书公钥，从 signerInfos 提取签名值，验签原文 data。
    """
    tag, ci_content, _ = parse_tlv(sign_der, 0)
    if tag != 0x30:
        return False
    ci_elems = parse_seq_elements(ci_content)
    if len(ci_elems) < 2:
        return False
    # ci_elems[0]=OID, ci_elems[1]=[0] EXPLICIT SignedData
    sd_wrap = ci_elems[1][1]
    tag, sd_content, _ = parse_tlv(sd_wrap, 0)
    if tag != 0x30:
        return False
    sd_elems = parse_seq_elements(sd_content)
    if len(sd_elems) < 5:
        return False
    # sd_elems[3] = certificates [0] IMPLICIT SET；sd_elems[4] = signerInfos SET
    certs_content = sd_elems[3][1]
    signer_infos = sd_elems[4][1]

    # 提取第一个证书（Certificate 完整 DER）
    tag, cert_der, _ = parse_tlv(certs_content, 0)
    if tag != 0x30:
        return False
    cert_info = parse_cert(base64.b64encode(cert_der).decode())
    pub_hex = cert_info["public_key_hex"]

    # ── 可信锚点（2026-11 审计 A1）──────────────────────────────
    # 原来公钥完全取自"待验报文里自带的那张证书"，而 parse_cert 不做链校验、
    # 全仓库也没有任何证书指纹或 CA 常量 —— 所以攻击者自签一张证书、
    # 用同一对密钥签一份 PKCS#7，验签就会返回 True。等于绕过验签只多一步。
    # 现在要求调用方给出"我们本来就信任的那把公钥"，对不上直接 False。
    # 锚点参数是**必填**（2026-11 审计二次意见）：留默认值时，将来任何人漏传
    # 都会安静地回到"报文自带证书自己就能过"的旧行为并返回 True —— 那正是刚修掉的洞，
    # 而测试也发现不了。改成必填后，漏传在第一次调用就 TypeError。
    # 确有"不信任任何锚点"的离线用途时，必须显式写 allow_untrusted=True，
    # 让"没有锚点"成为一个可 grep、可 review 的决定，而不是参数缺省的副作用。
    if not allow_untrusted:
        if not expected_pub_hex or not pub_hex_matches(pub_hex, expected_pub_hex):
            return False

    # 提取第一个 SignerInfo 的签名值（encryptedDigest OCTET STRING）
    tag, si_content, _ = parse_tlv(signer_infos, 0)
    if tag != 0x30:
        return False
    si_elems = parse_seq_elements(si_content)
    # si_elems[0]=version, [1]=issuerAndSerial, [2]=digestAlg, [3]=digestEncAlg, [4]=encryptedDigest
    if len(si_elems) < 5:
        return False
    encrypted_digest = si_elems[4][1]

    ok = sm2_verify(pub_hex, data, encrypted_digest)
    if not ok:
        # 「锚点配错」和「有人伪造」在现象上一模一样（都是验签失败）。
        # 把两边的公钥指纹一起打出来，才能一眼分辨：
        #   指纹相同 → 锚点正确，是签名本身不对（伪造或数据被改）
        #   指纹不同 → 报文章的不是我们信任的那张证书（多半是锚点配错，或真被冒名）
        logger.warning(
            "[实名认证] 验签未通过：报文证书公钥 sha8=%s / 锚点 sha8=%s（相同=签名不对；不同=证书不对）",
            hashlib.sha256((pub_hex or "").encode()).hexdigest()[:8],
            hashlib.sha256((expected_pub_hex or "").encode()).hexdigest()[:8],
        )
    return ok


# ==================== SM2 加密（C1C3C2） ====================
def sm2_encrypt(public_key_hex: str, data: bytes) -> bytes:
    """SM2 加密（C1C3C2）。gmssl 输出 C1 为 64 字节（x||y，不含 04 前缀）。"""
    crypt = sm2.CryptSM2(public_key=public_key_hex, private_key="", mode=1)
    return crypt.encrypt(data)


def sm2_decrypt(private_key_hex: str, cipher: bytes) -> bytes:
    """SM2 解密（C1C3C2）。gmssl 期望 C1 为 64 字节（x||y，不含 04 前缀）。"""
    crypt = sm2.CryptSM2(public_key="", private_key=private_key_hex, mode=1)
    return crypt.decrypt(cipher)


# ==================== 数字信封 ====================
def _c1c3c2_to_asn1(c1c3c2: bytes) -> bytes:
    """将 gmssl 的 C1C3C2（C1 为 64 字节 x||y，不含 04）拆成 SEQUENCE { x, y, c3, c2 }。"""
    c1 = c1c3c2[:64]   # x||y（64 字节）
    c3 = c1c3c2[64:96]
    c2 = c1c3c2[96:]
    x = int.from_bytes(c1[:32], "big")
    y = int.from_bytes(c1[32:64], "big")
    return seq(integer(x), integer(y), octet_string(c3), octet_string(c2))


def encode_envelop(cert_b64: str, data: bytes) -> bytes:
    """数字信封加密（PKCS#7 EnvelopedData，国密 SM2+SM4）。返回 DER 字节。

    对应官方 demo 的 SM2Utils.encodeEnvelop：
      1. 生成随机 SM4 密钥，SM4-ECB-PKCS7 加密数据
      2. 用证书 SM2 公钥（C1C3C2）加密 SM4 密钥
      3. 组装 PKCS#7 EnvelopedData
    """
    cert_info = parse_cert(cert_b64)
    pub_hex = cert_info["public_key_hex"]

    # 1. SM4 加密数据
    sm4_key = os.urandom(16)
    enc_data = sm4_ecb_encrypt(sm4_key, data)

    # 2. SM2 加密 SM4 密钥（C1C3C2）
    enc_key = sm2_encrypt(pub_hex, sm4_key)

    # 3. 组装 RecipientInfo
    encrypted_key_seq = _c1c3c2_to_asn1(enc_key)
    der_enc_key = octet_string(encrypted_key_seq)
    issuer_and_serial = seq(cert_info["issuer_der"], cert_info["serial_der"])
    recipient_info = seq(
        integer(1),                       # version
        issuer_and_serial,                # issuerAndSerialNumber
        algo_identifier(OID_SM2_ENC),     # keyEncryptionAlgorithm SM2
        der_enc_key,                      # encryptedKey
    )
    recipient_infos = tlv(0x31, recipient_info)  # SET OF

    # 4. 组装 EncryptedContentInfo
    encrypted_content = context_tag(0, enc_data, explicit=False)  # [0] IMPLICIT
    enc_content_info = seq(
        encode_oid(OID_DATA),             # contentType data
        algo_identifier(OID_SM4),         # contentEncryptionAlgorithm SM4
        encrypted_content,                # encryptedContent [0]
    )

    # 5. 组装 EnvelopedData
    enveloped_data = seq(
        integer(1),                       # version
        recipient_infos,                  # recipientInfos
        enc_content_info,                 # encryptedContentInfo
    )

    # 6. 组装 ContentInfo
    content_info = seq(
        encode_oid(OID_ENVELOPED_DATA),   # contentType envelopedData
        context_tag(0, enveloped_data, explicit=True),  # [0] EXPLICIT
    )
    return content_info


def decode_envelop(private_key_hex: str, envelop: bytes) -> bytes:
    """数字信封解密。对应官方 demo 的 SM2Utils.decodeEnvelop。"""
    # 解析 ContentInfo -> EnvelopedData
    tag, ci_content, _ = parse_tlv(envelop, 0)
    assert tag == 0x30
    ci_elems = parse_seq_elements(ci_content)
    # ci_elems[0]=OID, ci_elems[1]=[0] EXPLICIT EnvelopedData
    env_wrap = ci_elems[1][1]
    tag, env_data, _ = parse_tlv(env_wrap, 0)
    assert tag == 0x30
    env_elems = parse_seq_elements(env_data)
    # env_elems[0]=version, env_elems[1]=recipientInfos(SET), env_elems[2]=encryptedContentInfo
    recipient_infos = env_elems[1][1]
    enc_content_info = env_elems[2][1]

    # 解析 recipientInfo -> encryptedKey
    # recipient_infos 是 SET 的内容 = [RecipientInfo 完整 DER]
    tag, ri_content, _ = parse_tlv(recipient_infos, 0)  # (0x30, RecipientInfo 内容)
    assert tag == 0x30
    ri_elems = parse_seq_elements(ri_content)
    # ri_elems[0]=version, ri_elems[1]=issuerAndSerial, ri_elems[2]=algo, ri_elems[3]=encryptedKey OCTET STRING
    der_enc_key = ri_elems[3][1]  # OCTET STRING 内容 = SEQUENCE {x,y,c3,c2}

    # 解析 encryptedKey 的 SEQUENCE {x,y,c3,c2}
    tag, ek_content, _ = parse_tlv(der_enc_key, 0)
    ek_elems = parse_seq_elements(ek_content)
    x = int.from_bytes(ek_elems[0][1], "big")
    y = int.from_bytes(ek_elems[1][1], "big")
    c3 = ek_elems[2][1]
    c2 = ek_elems[3][1]
    # 还原 C1C3C2（gmssl 期望 C1 为 64 字节 x||y，不含 04 前缀）
    c1 = x.to_bytes(32, "big") + y.to_bytes(32, "big")
    c1c3c2 = c1 + c3 + c2

    # SM2 解密得到 SM4 密钥
    sm4_key = sm2_decrypt(private_key_hex, c1c3c2)

    # 解析 encryptedContentInfo -> encryptedContent
    eci_elems = parse_seq_elements(enc_content_info)
    # eci_elems[0]=OID data, eci_elems[1]=algo SM4, eci_elems[2]=[0] IMPLICIT encryptedContent
    enc_content = eci_elems[2][1]

    # SM4 解密
    return sm4_ecb_decrypt(sm4_key, enc_content)
