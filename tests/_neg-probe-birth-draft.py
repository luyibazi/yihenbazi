# -*- coding: utf-8 -*-
"""
负向验证：证明「更新排盘 = 只改草稿」这套断言真的拦得住。

用法： python tests/_neg-probe-birth-draft.py
做法：每次只把源码改坏一处 → 跑 tests/screens-check.js → 看报的 FAIL 文案是否正中要害
      → 还原 → 比对 md5（必须一致）。
"""
import hashlib
import io
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RESULT = os.path.join(ROOT, 'src', 'screens', 'result', 'Result.tsx')
MODEL = os.path.join(ROOT, 'src', 'screens', 'result', 'model.js')
CHECK = os.path.join(ROOT, 'tests', 'screens-check.js')


def md5(path):
    with open(path, 'rb') as f:
        return hashlib.md5(f.read()).hexdigest()


def read(path):
    # newline='' 保住 CRLF 原样
    with io.open(path, 'r', encoding='utf-8', newline='') as f:
        return f.read()


def write(path, s):
    with io.open(path, 'w', encoding='utf-8', newline='') as f:
        f.write(s)


def run_check():
    p = subprocess.run(['node', CHECK], cwd=ROOT, capture_output=True)
    out = (p.stdout or b'').decode('utf-8', 'replace') + \
          (p.stderr or b'').decode('utf-8', 'replace')
    fails = [ln.strip() for ln in out.splitlines() if ln.strip().startswith('FAIL')]
    return p.returncode, fails, out


CASES = [
    # (编号, 说明, 文件, 原文, 改成, 期望命中的文案片段)
    (
        'B1',
        '「确定」又偷偷写后端（把 history.push 塞回 onBirthCommit）',
        RESULT,
        "    setBirthOn(false);\n"
        "    showToast('已选中新的出生时间，点「保存」后生效');",
        "    history.push(model.mergePatch(cur.rec, d));\n"
        "    setBirthOn(false);\n"
        "    showToast('已选中新的出生时间，点「保存」后生效');",
        '点了「更新排盘」不写后端',
    ),
    (
        'B2',
        '性别比较退回 Number(r.gender)（rec 缺字段 ⇒ NaN ⇒ 空 patch 失效）',
        MODEL,
        "  if (nextGender !== prevGender) patch.gender = nextGender;",
        "  if (Number(nextGender) !== Number(r.gender)) patch.gender = nextGender;",
        '缺 gender 时草稿默认 1',
    ),
    (
        'B3',
        '出生时间那一行的农历退回读记录（改了日期，农历不动 ⇒ 两行字打架）',
        MODEL,
        "  if (!lunarText && !draft) lunarText = String(r.lunarText || '').trim();",
        "  if (true) lunarText = String(r.lunarText || '').trim();",
        '跟着草稿日期重算',
    ),
    (
        'B4',
        '出生时间那一行的性别只看草稿（未进修改态时把女命显示成男）',
        MODEL,
        "  const gender = (draft && (e.gender === 0 || e.gender === 1) ? e.gender : r.gender) === 0 ? 0 : 1;",
        "  const gender = (e.gender === 0 || e.gender === 1) && e.gender === 0 ? 0 : 1;",
        '未进修改态时性别取',
    ),
    (
        'B5',
        '浮层预填退回读记录（不保存再点开 ⇒ 回到旧时间，像白选了一遍）',
        RESULT,
        "                  gender: birth.gender,\n"
        "                  date: birth.date,\n"
        "                  time: birth.time,",
        "                  gender: panel.rec && typeof panel.rec.gender === 'number' ? panel.rec.gender : 1,\n"
        "                  date: (panel.rec && (panel.rec.date || '')) || '',\n"
        "                  time: (panel.rec && (panel.rec.time || '')) || '',",
        '预填读 `birth`',
    ),
]


def main():
    total = 0
    caught = 0
    for code, desc, path, old, new, want in CASES:
        total += 1
        before = md5(path)
        src = read(path)
        if old not in src:
            print('!! %s 锚点没找到：%s' % (code, desc))
            print('   ---- 锚点 ----\n%s\n   ------------' % old)
            return 1
        try:
            write(path, src.replace(old, new, 1))
            rc, fails, out = run_check()
            hit = [f for f in fails if want in f]
            if rc != 0 and hit:
                caught += 1
                print('OK  拦住了  %s %s' % (code, desc))
                print('      失败 %d 条，命中：「%s」' % (len(fails), hit[0][:80]))
            else:
                print('!! 没拦住  %s %s' % (code, desc))
                print('      rc=%s  失败 %d 条' % (rc, len(fails)))
                for f in fails[:5]:
                    print('      %s' % f[:120])
        finally:
            write(path, src)
            assert md5(path) == before, '%s 还原后 md5 不一致！' % path
            print('      还原 md5 一致')
    print()
    print('=== %d/%d 全部拦住 ===' % (caught, total))
    return 0 if caught == total else 1


if __name__ == '__main__':
    sys.exit(main())
