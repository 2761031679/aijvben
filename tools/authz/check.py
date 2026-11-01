"""校验「接口身份声明清单」与「代码实际签名」是否一致。

用法：
  python tools/authz/check.py              # 校验，不一致就退出码 1
  python tools/authz/check.py --selftest   # 额外跑反例，确认这个检查器真的会拦

为什么需要它：
身份级只写在函数签名的字符串里，没有别的地方能看见。改漏一个不会报错，
只会在某天变成越权。这个脚本把「声明」和「签名」绑死，不一致就红。
"""
import io
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from extract import GUARD_TO_LEVEL, LEVELS, extract

MANIFEST = os.path.join(os.path.dirname(__file__), '..', '..', 'docs', 'authz-manifest.json')


def implied_level(guards):
    """从代码里实际用到的鉴权依赖，推出它该属于哪一级。"""
    level = None
    for g in guards:
        lv = GUARD_TO_LEVEL[g]
        if level is None or LEVELS.index(lv) > LEVELS.index(level):
            level = lv
    return level or 'public'


def compare(routes, endpoints):
    """返回问题列表[(严重度, 说明)]。严重度：error / warn。"""
    problems = []
    seen = set()
    for r in routes:
        key = '%s %s' % (r['method'], r['path'])
        seen.add(key)
        if key not in endpoints:
            problems.append(('error', '未声明的端点：%s（%s:%s）—— 请在 docs/authz-manifest.json 里给它定性'
                             % (key, r['file'], r['line'])))
            continue
        want = endpoints[key].get('level')
        if want not in LEVELS:
            problems.append(('error', '%s 的 level 取值非法：%r' % (key, want)))
            continue
        # 主持证是另一个维度：不参与级别高低，单独核
        want_host = bool(endpoints[key].get('host_token'))
        got_host = bool(r.get('host_token'))
        if want_host != got_host:
            problems.append((
                'error',
                '%s 的「是否需要主持证」声明为 %s，但代码实际为 %s（%s:%s）—— '
                '主持证校验被加/删了却没更新清单' % (key, want_host, got_host, r['file'], r['line'])))

        got = implied_level(r['guards'])
        if want != got:
            problems.append((
                'error',
                '%s 声明为 %s，但代码实际是 %s（依赖：%s，位置 %s:%s）—— 两边必须一致'
                % (key, want, got, ','.join(r['guards']) or '无', r['file'], r['line'])))

    for key in sorted(set(endpoints) - seen):
        problems.append(('error', '清单里有、代码里没有：%s —— 端点被删了或路径改了，请更新清单' % key))
    return problems


def load_manifest():
    doc = json.load(io.open(MANIFEST, encoding='utf-8'))
    return doc.get('endpoints', {})


def selftest(real_routes, real_endpoints):
    """喂几种「故意弄错」的情况，确认检查器真的会报错。"""
    cases = []

    # 1) 代码里冒出一个新端点，清单里没有
    r = dict(real_routes[0])
    routes = list(real_routes) + [dict(r, path='/api/新端点', method='GET', guards=[])]
    cases.append(('新增端点未声明', routes, real_endpoints, True))

    # 2) 声明是 public，代码却要求登录
    key = next(k for k, v in real_endpoints.items() if v['level'] == 'public')
    m, p = key.split(' ', 1)
    routes = [dict(rr) for rr in real_routes]
    for rr in routes:
        if rr['method'] == m and rr['path'] == p:
            rr['guards'] = ['get_current_user']
    cases.append(('public 被偷偷加上登录要求', routes, real_endpoints, True))

    # 3) 声明是 admin，代码却降成了游客
    akey = next(k for k, v in real_endpoints.items() if v['level'] == 'admin')
    am, ap = akey.split(' ', 1)
    routes = [dict(rr) for rr in real_routes]
    for rr in routes:
        if rr['method'] == am and rr['path'] == ap:
            rr['guards'] = []
    cases.append(('admin 端点被降级成游客', routes, real_endpoints, True))

    # 4) 清单里留了一条已经删掉的端点
    eps = dict(real_endpoints)
    eps['GET /api/已经删掉的端点'] = {'level': 'public', 'file': 'x.py', 'func': 'f', 'line': 1,
                                      'code_guards': [], 'note': ''}
    cases.append(('清单里有幽灵条目', real_routes, eps, True))

    # 5) level 写成了不存在的级别
    eps2 = dict(real_endpoints)
    k = list(eps2)[0]
    eps2[k] = dict(eps2[k], level='superuser')
    cases.append(('level 取值非法', real_routes, eps2, True))

    # 6) 主持证校验被静默删掉（代码不再验，清单还说需要）
    hkey = next((k for k, v in real_endpoints.items() if v.get('host_token')), None)
    if hkey:
        hm, hp = hkey.split(' ', 1)
        routes = [dict(rr) for rr in real_routes]
        for rr in routes:
            if rr['method'] == hm and rr['path'] == hp:
                rr['host_token'] = False
        cases.append(('主持证校验被删掉', routes, real_endpoints, True))

    # 7) 完全一致的清单，必须通过
    cases.append(('原样的清单应当通过', real_routes, real_endpoints, False))

    bad = 0
    print('\n--- 反例自测 ---')
    for label, routes, eps, should_fail in cases:
        probs = compare(routes, eps)
        failed = len(probs) > 0
        if failed == should_fail:
            print('  [OK] %-28s -> %s' % (label, ('报错 %d 条' % len(probs)) if failed else '通过'))
        else:
            print('  [!!] %-28s -> 期望%s，实际%s' % (label, '报错' if should_fail else '通过',
                                                     '报错' if failed else '通过'))
            bad += 1
    return bad


def main():
    if not os.path.exists(MANIFEST):
        print('找不到清单：%s（先跑 python tools/authz/make_manifest.py）' % MANIFEST)
        return 1
    routes = extract()
    endpoints = load_manifest()
    problems = compare(routes, endpoints)

    print('代码里 %d 个端点 / 清单里 %d 条' % (len(routes), len(endpoints)))
    for sev, msg in problems:
        print('  [%s] %s' % ('!' if sev == 'error' else '?', msg))
    if not problems:
        print('  [OK] 声明与代码完全一致')

    bad = len(problems)
    if '--selftest' in sys.argv:
        bad += selftest(routes, endpoints)

    print('\n%s' % ('全部通过' if bad == 0 else '%d 处不通过' % bad))
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
