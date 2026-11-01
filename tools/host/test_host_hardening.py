"""主持通道加固的回归测试（服务层，不连 HTTP）。

这一份专门盯「审计打穿的那几个洞」，每一条都是实测可复现的，不是假想：

  M1  已收场的会话再喊 timeout 不能把 end_reason 覆写回 timeout
      （否则「settled 之后不再下发汤底」一句话就被推翻）
  M2  遗言轮只许用一次：consume_last_words 必须有调用方
  M3  空闲清扫必须记 end_reason=timeout，否则遗言轮静默失效
  M4  登录用户的 JWT 不能被当成主持证（否则 default/browsing 对登录用户恒 401）
  M5  status_uis 必须是浏览器注册序（mode→hp→conditions 三条）

用法：PYTHONIOENCODING=utf-8 python tools/host/test_host_hardening.py
"""
import os
import sys
from datetime import timedelta

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..')))

from fastapi import HTTPException  # noqa: E402

import backend.models  # noqa: F401,E402
from backend.core.database import SessionLocal, init_db  # noqa: E402
from backend.models.script import Script  # noqa: E402
from backend.services import host_session_service as hs  # noqa: E402
from backend.services import prompt_env_service as penv  # noqa: E402

FAILED = []


def check(label, got, want):
    ok = got == want
    print('  [%s] %-52s got=%r want=%r' % ('OK' if ok else '!!', label, got, want))
    if not ok:
        FAILED.append(label)


def main():
    init_db()
    db = SessionLocal()
    script = db.query(Script).filter(Script.is_deleted.is_(False)).first()
    if not script:
        print('开发库里没有剧本，先造一本再跑')
        return 1

    try:
        # ---------------- M4：JWT 不是主持证
        print('\n--- M4 登录令牌不能被当成主持证 ---')
        check('JWT 形状 → 不是主持证',
              hs.raw_from_headers('Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc', None), None)
        check('登录令牌（无 Bearer 前缀）→ 也不是',
              hs.raw_from_headers('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc', None), None)
        real = hs.create_session(db, script, owner_user_id=None, npc_id='dagou')
        raw = real[1]
        check('真主持证照常认', hs.raw_from_headers(None, raw), raw)
        check('真主持证放 Authorization 也认', hs.raw_from_headers('Bearer ' + raw, None), raw)
        check('X-Host-Token 优先', hs.raw_from_headers('Bearer ' + raw, 'other'), 'other')

        # ---------------- M3：清扫要写原因
        print('\n--- M3 空闲清扫必须记 end_reason ---')
        s2, _ = hs.create_session(db, script, owner_user_id=None, npc_id='dagou')
        s2.last_active_at = hs._now() - timedelta(seconds=hs.SESSION_IDLE_SECONDS + 60)
        db.commit()
        hs.sweep_if_idle(db, s2)
        db.refresh(s2)
        check('清扫后 phase', s2.phase, hs.PHASE_ENDED)
        check('清扫后 end_reason', (s2.payload or {}).get('end_reason'), 'timeout')
        check('清扫后是遗言证', hs.token_state(s2), 'last_words')

        # ---------------- M1：终态不可覆写
        print('\n--- M1 已收场不能被喊成 timeout ---')
        s3, _ = hs.create_session(db, script, owner_user_id=None, npc_id='dagou')
        hs.begin_settling(db, s3)
        hs.mark_narrated(db, s3)
        hs.end_session(db, s3, reason='settled')
        db.refresh(s3)
        check('settled 之后 end_reason', (s3.payload or {}).get('end_reason'), 'settled')
        s3.last_active_at = hs._now() - timedelta(seconds=hs.SESSION_IDLE_SECONDS + 60)
        db.commit()
        hs.end_session(db, s3, reason='timeout')   # 以前这里会把 settled 覆写成 timeout
        db.refresh(s3)
        check('再喊 timeout 也改不掉', (s3.payload or {}).get('end_reason'), 'settled')
        check('settled 之后不再是可用证', hs.token_state(s3) != 'ok', True)

        # ---------------- M2：遗言轮只许一次
        print('\n--- M2 遗言轮只许用一次 ---')
        s4, raw4 = hs.create_session(db, script, owner_user_id=None, npc_id='dagou')
        s4.last_active_at = hs._now() - timedelta(seconds=hs.SESSION_IDLE_SECONDS + 60)
        db.commit()
        hs.sweep_if_idle(db, s4)
        db.refresh(s4)
        check('第一次还没用过', int((s4.payload or {}).get('last_words_used') or 0), 0)
        hs.consume_last_words(db, s4)
        db.refresh(s4)
        check('用掉之后计数', (s4.payload or {}).get('last_words_used'), 1)
        check('用掉之后证被撤销', hs.token_state(s4), 'revoked')
        check('再取就是 410', hs.find_by_token(db, raw4) is not None, True)

        # ---------------- M5：status_uis 必须是浏览器注册序
        print('\n--- M5 status_uis 与浏览器注册序一致 ---')
        ids = [u['id'] for u in penv.STATUS_UIS]
        check('顺序', ids, ['mode', 'hp', 'conditions'])
        check('条数', len(ids), 3)
        hp = [u for u in penv.STATUS_UIS if u['id'] == 'hp'][0]
        check('hp 命令条数', len(hp['npcCmds']), 7)

    finally:
        # 清掉这次造的会话
        for s in db.query(hs.HostSession).all():
            db.delete(s)
        db.commit()
        db.close()

    print('\n%s' % ('全部通过' if not FAILED else '%d 项不通过：%s' % (len(FAILED), '、'.join(FAILED))))
    return 1 if FAILED else 0


if __name__ == '__main__':
    sys.exit(main())
