"""会话引擎的回归测试（不连 HTTP，直接打服务层）。

覆盖三件「靠手点是点不出来」的事：
  1. 安静超时后主持证要降级成遗言证，而不是直接撤销——这是「真相被切成半句」的修法。
  2. 遗言轮只能用一次，用完立刻 410。
  3. settled 结束必须先 narrated=true，否则就是把没讲完的解说当成讲完了。

用法：PYTHONIOENCODING=utf-8 python tools/host/test_session_engine.py
"""
import os
import sys
from datetime import timedelta

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..')))

from fastapi import HTTPException  # noqa: E402

import backend.models  # noqa: F401,E402  确保模型注册
from backend.core.database import SessionLocal, init_db  # noqa: E402
from backend.models.script import Script  # noqa: E402
from backend.services import host_session_service as hs  # noqa: E402

FAILED = []


def check(label, got, want):
    ok = got == want
    print('  [%s] %-46s got=%r want=%r' % ('OK' if ok else '!!', label, got, want))
    if not ok:
        FAILED.append(label)


def expect_error(label, want_status, want_code, fn):
    try:
        fn()
    except HTTPException as e:
        code = (e.detail or {}).get('code') if isinstance(e.detail, dict) else None
        check('%s（%s/%s）' % (label, want_status, want_code), (e.status_code, code), (want_status, want_code))
        return
    check(label, '没有报错', '应当报错')


def main():
    init_db()
    db = SessionLocal()
    script = db.query(Script).first()
    if not script:
        print('本地库里没有剧本，跑不了。先造一条 approved 剧本。')
        return 1

    print('\n--- 1. 安静超时 → 遗言证，不是直接撤销 ---')
    s, tok = hs.create_session(db, script, owner_user_id=None, npc_id='jingyuniang')
    check('刚建会话的相位', s.phase, hs.PHASE_HOSTING)
    check('刚建会话的证状态', hs.token_state(s), 'ok')
    s.last_active_at = s.last_active_at - timedelta(seconds=hs.SESSION_IDLE_SECONDS + 60)
    db.commit()
    hs.sweep_if_idle(db, s)
    check('超时后相位', s.phase, hs.PHASE_ENDED)
    check('超时后仍是遗言证（不是 revoked）', hs.token_state(s), 'last_words')
    check('遗言轮还没用', hs.snapshot(s)['last_words_left'], 1)

    print('\n--- 2. 遗言轮只能一次 ---')
    hs.consume_last_words(db, s)
    check('用掉遗言轮后证状态', hs.token_state(s), 'revoked')
    check('用掉后剩余遗言轮', hs.snapshot(s)['last_words_left'], 0)
    expect_error('已撤销的证再取会话', 410, 'host_token_expired',
                 lambda: hs.require_token(db, tok))

    print('\n--- 3. 4 小时封顶 ---')
    s2, tok2 = hs.create_session(db, script, owner_user_id=None, npc_id='')
    s2.token_issued_at = s2.token_issued_at - timedelta(hours=hs.TOKEN_MAX_HOURS, minutes=1)
    db.commit()
    check('签发超 4 小时', hs.token_state(db.get(type(s2), s2.id)), 'expired')
    expect_error('过期的证取会话', 410, 'host_token_expired', lambda: hs.require_token(db, tok2))

    print('\n--- 4. settled 必须先 narrated ---')
    s3, tok3 = hs.create_session(db, script, owner_user_id=None, npc_id='')
    expect_error('主持中直接 settled', 409, 'session_phase_conflict',
                 lambda: hs.end_session(db, s3, reason='settled'))
    s3.phase = hs.PHASE_SETTLING
    db.commit()
    expect_error('进入 settling 但没讲完就 settled', 409, 'session_phase_conflict',
                 lambda: hs.end_session(db, s3, reason='settled'))
    payload = dict(s3.payload or {})
    payload['narrated'] = True
    s3.payload = payload
    db.commit()
    hs.end_session(db, s3, reason='settled')
    check('讲完再 settled 的相位', s3.phase, hs.PHASE_ENDED)
    check('settled 后仍是遗言证', hs.token_state(s3), 'last_words')

    print('\n--- 5. 并发锁 ---')
    s4, tok4 = hs.create_session(db, script, owner_user_id=None, npc_id='')
    hs.acquire_turn_lock(db, s4, 'a')
    expect_error('同一场第二个请求', 409, 'session_busy', lambda: hs.acquire_turn_lock(db, s4, 'b'))
    hs.acquire_turn_lock(db, s4, 'a')
    check('同一持有者重复拿锁不算冲突', (s4.payload or {}).get('turn_lock', {}).get('holder'), 'a')
    hs.release_turn_lock(db, s4, 'a')
    hs.acquire_turn_lock(db, s4, 'b')
    check('释放后别人能拿到', (s4.payload or {}).get('turn_lock', {}).get('holder'), 'b')
    hs.release_turn_lock(db, s4, 'b')

    db.close()
    print('\n%s' % ('全部通过' if not FAILED else '%d 项不通过：%s' % (len(FAILED), '、'.join(FAILED))))
    return 1 if FAILED else 0


if __name__ == '__main__':
    sys.exit(main())
