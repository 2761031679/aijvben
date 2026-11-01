"""生成/刷新 docs/authz-manifest.json 的初稿。

只在「新增了端点、要给它定性」时手工跑一次；平时用 check.py 校验。
已有的条目**不会被覆盖**（保留人工写的 level 和 note）。
"""
import io
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from extract import extract

MANIFEST = os.path.join(os.path.dirname(__file__), '..', '..', 'docs', 'authz-manifest.json')

# 已经定性过、要写清楚为什么的端点（游客可读，但必须是有意为之）
NOTES = {
    'GET /api/admin/site-settings': '游客：前端启动要读 BGM/轮播图/可见分类。已剔除密钥字段（SECRET_FIELDS）。',
    'GET /api/admin/npc-configs': '游客：前端初始化要读 NPC 定义与表情/动画效果池。',
    'GET /api/game/mode-prompt': '游客：各玩法模式的开场提示词模板，不含剧本内容。',
    'GET /api/npc/prompts': '游客：读的是已废弃的 npc_prompts 表，改了不生效（见 P1-BLOCKERS §3-1）。',
    'GET /api/review/flagged-pool': '游客：公开举报池，只含公开信息与聚合数字，不含汤底。',
    'GET /api/review/{script_id}/report-votes': '游客：举报投票统计，只有数字不含投票人。',
    'GET /api/review/{script_id}/community-votes': '游客：社区点赞/点踩统计。',
    'GET /api/npc/scripts/{script_id}': (
        '汤底/条件表**不再无条件下发**（§10.1 收口）。公开字段人人可读；'
        '汤底全套只给：该作者/管理员/站长，或有这一场的有效主持证，或登录且在该剧本有未结束会话。'
        '按标题模糊搜照旧可用，只回公开字段。'),
    'GET /api/scripts/{script_id}': '未过审的稿子只有作者本人与管理员/站长可见，其余 404（原来只判 is_deleted）。',
    'GET /api/game/{script_id}/start': '未过审 423（作者/管理员可试玩）。',
    'POST /api/game/{script_id}/ask': '未过审 423（作者/管理员可试玩）。',
    'POST /api/game/{script_id}/hint': (
        '只回通用盘问方向，**不再回吐汤底原句**；游客同样计数（5 次上限，落 guest_counters 表，按 IP 哈希）。'),
    'GET /api/admin/npc-prompts': (
        '**已废弃**：返回的 deprecated=true。读的是 npc_prompts 表（线上 28 行历史数据），'
        '而提示词的可信源是文件系统，改表不生效。仅为兼容脚本保留。'),
    'POST /api/admin/npc-prompts': '**已废弃**：固定 410，指到 PUT /api/admin/npc-configs/{npc_id}/prompts/{prompt_type}。',
    'DELETE /api/admin/npc-prompts/{prompt_id}': '**已废弃**：固定 410，同上。',
    'POST /api/host/session/start': '游客可开房（匿名会话 owner_user_id=null）。主持证不能开新场，会被 403。',
    'GET /api/host/session/{session_id}': '该场主持证，或会话主人自己的长期钥匙；其余一律 403。',
    'POST /api/host/session/{session_id}/heartbeat': '只认主持证。报活不消耗遗言轮。',
    'POST /api/host/session/end': '只认主持证。settled 要先 narrated=true，否则 409。',
    'GET /api/host/status': '带主持证回本场相位，不带只回 alive+时间；不暴露跨会话聚合数。',
}


def main():
    routes = extract()
    existing = {}
    if os.path.exists(MANIFEST):
        existing = json.load(io.open(MANIFEST, encoding='utf-8')).get('endpoints', {})

    endpoints = {}
    added = 0
    for r in routes:
        key = '%s %s' % (r['method'], r['path'])
        if key in existing:
            # 保留人工定性，但把代码事实（文件/函数/行号/实际依赖）刷新
            e = existing[key]
            e['file'] = r['file']
            e['func'] = r['func']
            e['line'] = r['line']
            e['code_guards'] = r['guards']
            e['host_token'] = r['host_token']
            if key in NOTES:
                e['note'] = NOTES[key]
            endpoints[key] = e
        else:
            endpoints[key] = {
                'level': r['level'],
                'file': r['file'],
                'func': r['func'],
                'line': r['line'],
                'code_guards': r['guards'],
                'host_token': r['host_token'],
                'note': NOTES.get(key, ''),
            }
            added += 1

    doc = {
        '$comment': [
            '本文件是「每个接口归谁」的唯一声明处。',
            'level 取值：public（游客可读）/ user（须登录）/ admin / admin_or_sm / owner。',
            'host_token：该端点是否强制校验「主持证」——另一个维度，不进 level 比较。',
            'code_guards / host_token 由 tools/authz/make_manifest.py 从源码刷出，不要手改。',
            '改完代码请跑：python tools/authz/check.py  —— 声明与代码不一致它会报错。',
        ],
        'endpoints': endpoints,
    }
    io.open(MANIFEST, 'w', encoding='utf-8', newline='\n').write(
        json.dumps(doc, ensure_ascii=False, indent=2, sort_keys=True) + '\n')
    print('清单已写入 %s：共 %d 条（本次新增 %d 条）' % (MANIFEST, len(endpoints), added))


if __name__ == '__main__':
    main()
