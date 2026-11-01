"""越权收口的回归测试（契约 §10.1）。

盯住三件「改回一行就悄悄失效、而界面上完全看不出来」的事：
  1. 匿名调 NPC 取剧本接口，拿不到汤底；按标题模糊搜照样能搜到，但也拿不到汤底。
  2. 未过审的稿子，非作者看不到详情、也开不了体验。
  3. 提示不再从汤底里抄句子。

用法：PYTHONIOENCODING=utf-8 python tools/host/test_leak_gates.py
"""
import os
import sys

from datetime import timedelta as _td

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..')))

from fastapi import HTTPException  # noqa: E402

import backend.models  # noqa: F401,E402
from backend.core.database import SessionLocal, init_db  # noqa: E402
from backend.models.script import Script, REVIEW_APPROVED  # noqa: E402
from backend.services import npc_service, script_service, host_session_service as hs  # noqa: E402
from backend.routers.game import HINT_TEMPLATES  # noqa: E402

FAILED = []
SECRET_KEYS = ('explanation', 'endings', 'tasks', 'ending_condition', 'host_guide')


def check(label, got, want):
    ok = got == want
    print('  [%s] %-44s got=%r want=%r' % ('OK' if ok else '!!', label, got, want))
    if not ok:
        FAILED.append(label)


def main():
    init_db()
    db = SessionLocal()
    script = db.query(Script).filter(Script.review_status == REVIEW_APPROVED).first()
    if not script:
        print('本地库里没有已过审剧本，跳过。')
        return 0

    print('\n--- 1. 匿名取详情：公开字段有，汤底没有 ---')
    d = npc_service.get_script(db, script.id, None)
    check('匿名能拿到标题', bool(d.get('title')), True)
    check('匿名能拿到谜面', bool(d.get('story')), True)
    check('汤底类字段一个都不给', [k for k in SECRET_KEYS if k in d], [])
    check('明确标记为未解锁', d.get('full_locked'), True)

    print('\n--- 2. 主持人拿条件表、拿不到汤底正文（汤底只留在服务端） ---')
    d2 = npc_service.get_script(db, script.id, None, can_full=lambda s: True)
    check('主持人拿不到汤底正文', 'explanation' in d2, False)
    check('主持人拿到条件表', 'endings' in d2, True)
    print('\n--- 2b. 主持人拿条件表，但拿不到汤底正文（汤底不应出现在浏览器侧） ---')
    s_host, tok_host = hs.create_session(db, script, owner_user_id=None, npc_id='')
    d_host = npc_service.get_script(
        db, script.id, None,
        can_full=lambda s: hs.has_script_access(db, s.id, raw_token=tok_host))
    check('主持人拿到条件表 endings', 'endings' in d_host, True)
    check('主持人拿不到汤底正文 explanation', 'explanation' in d_host, False)
    check('主持人拿不到主持指导词 host_guide', 'host_guide' in d_host, False)
    check('主持人不是「未解锁」态', d_host.get('full_locked'), None)
    hs.end_session(db, s_host, reason='aborted')

    d3 = npc_service.get_script(db, script.title[:2], None)
    check('按标题模糊搜仍能命中（只给公开字段）', (bool(d3), 'explanation' in (d3 or {})),
          (True, False))

    print('\n--- 3. 「正在主持这一场」的判定 ---')
    check('没会话时无权', hs.has_script_access(db, script.id), False)
    s, tok = hs.create_session(db, script, owner_user_id=None, npc_id='')
    check('拿到主持证后有权', hs.has_script_access(db, script.id, raw_token=tok), True)
    check('别的剧本不给', hs.has_script_access(db, 'not-this-script', raw_token=tok), False)
    hs.end_session(db, s, reason='aborted')
    check('撤销后无权', hs.has_script_access(db, script.id, raw_token=tok), False)

    print('\n--- 4. 未过审的稿子 ---')
    pending = Script(id='tmppending01', title='临时未过审稿', story='谜面', explanation='汤底原文',
                     category='hai-gui-tang', review_status='pending',
                     user_id=script.user_id)
    db.merge(pending)
    db.commit()
    try:
        def _detail_none():
            script_service.get_script_detail(db, 'tmppending01', None)
        try:
            _detail_none()
            check('匿名看未过审详情', '没报错', '404')
        except HTTPException as e:
            check('匿名看未过审详情', e.status_code, 404)
        d4 = npc_service.get_script(db, 'tmppending01', None)
        check('匿名走 NPC 接口拿未过审', d4, None)
    finally:
        db.delete(db.query(Script).filter(Script.id == 'tmppending01').first())
        db.commit()

    print('\n--- 5. 提示不得从汤底里抄句子 ---')
    expl = (script.explanation or '')
    sentences = [x.strip() for x in expl.replace('。', '。\n').split('\n') if len(x.strip()) > 6]
    hit = [t for t in HINT_TEMPLATES if sentences and any(s in t for s in sentences)]
    check('提示模板不含汤底原句', hit, [])
    check('提示模板数量覆盖 5 档', len(HINT_TEMPLATES) >= 5, True)

    print('\n--- 6. 客户端自报的通关不算数（审计 M3） ---')
    from backend.core.permission import can_view_full_script
    from backend.models.user import User
    from backend.services import user_service, stats_service
    probe = User(username='leakprobe', email='leakprobe@example.com', password_hash='x',
                 role='normal', email_verified=True)
    db.add(probe)
    db.commit()
    db.refresh(probe)
    try:
        # 6a 客户端自己往 play_data 里写 completed —— 以前这就是「通关」
        user_service.save_play_data(db, probe, script.id,
                                    {"completed": True, "hints_used": 0})
        check('自报通关不给汤底', can_view_full_script(probe, script, db), False)

        # 6b 服务端写下的通关记录才算
        stats_service.on_script_completed(db, str(probe.id), script.id, 'e1', '真相大白')
        check('服务端见证的通关给汤底', can_view_full_script(probe, script, db), True)

        # 6c 没记录之前不通过（换一个干净用户）
        probe2 = User(username='leakprobe2', email='leakprobe2@example.com', password_hash='x',
                      role='normal', email_verified=True)
        db.add(probe2)
        db.commit()
        db.refresh(probe2)
        check('没通关过的用户不给汤底', can_view_full_script(probe2, script, db), False)
        db.delete(probe2)
        db.commit()
    finally:
        from backend.models.stats import Completion
        from backend.models.user_data import PlaySession
        db.query(Completion).filter(Completion.user_id == str(probe.id)).delete()
        db.query(PlaySession).filter(PlaySession.user_id == str(probe.id)).delete()
        db.delete(db.query(User).filter(User.id == probe.id).first())
        db.commit()

    print('\n--- 7. 问句匹配不是恒「无关」（审计 M5） ---')
    from backend.routers.game import _match_question
    check('能认出汤底里有的东西', _match_question('他是不是自杀的', '他是自杀，因为妻子出轨')[0], '是')
    check('不认识的仍答无关', _match_question('外面天气怎么样', '他是自杀，因为妻子出轨')[0], '无关')

    print('\n--- 8. 不能自己喊超时换遗言证（审计 M6） ---')
    sess, tok = hs.create_session(db, script, owner_user_id=None, npc_id='')
    try:
        hs.end_session(db, sess, reason='timeout')
        check('刚开的场不能按超时结束', '没拦住', '409')
    except HTTPException as e:
        check('刚开的场不能按超时结束', e.status_code, 409)
    # 真的闲置够了，才允许转遗言证
    sess.last_active_at = hs._now() - _td(seconds=hs.SESSION_IDLE_SECONDS + 1)
    db.commit()
    hs.end_session(db, sess, reason='timeout')
    check('遗言证不再等于汤底权限', hs.has_script_access(db, script.id, raw_token=tok), False)

    db.close()
    print('\n%s' % ('全部通过' if not FAILED else '%d 项不通过：%s' % (len(FAILED), '、'.join(FAILED))))
    return 1 if FAILED else 0


if __name__ == '__main__':
    sys.exit(main())
