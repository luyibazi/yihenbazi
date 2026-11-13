# 负向验证：把「下拉刷新 = 松手才刷（components/PullRefresh.tsx + 两页同一套接法）」这套改坏
#           → 跑 screens-check → 必须报红 → 逐字节还原
#
# 用法：python tests/_neg-probe-pullrefresh.py
# ⚠⚠ 改源码必须走 read_bytes / write_bytes：read_text / write_text 在 Windows 上会做
#    LF↔CRLF 转换，「还原」之后整个文件行尾被换掉、md5 对不上（= 悄悄改了源码）。
import hashlib
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
CHECK = ROOT / 'tests' / 'screens-check.js'
NODE = r'C:/Users/luerse/.workbuddy/binaries/node/versions/22.22.2-6/node.exe'

RECORDS = 'src/screens/records/Records.tsx'
STUDY = 'src/screens/study/QueryPane.tsx'
BOOKS = 'src/screens/study/BooksPane.tsx'
APP = 'App.tsx'
PULL = 'src/components/PullRefresh.tsx'

PROBES = [
    # ★ 最核心的一条：松手才刷被破坏（把 onRefresh 挪进拖动过程中）
    ('M1 onRefresh 被挪进 onTouchMove（=「过阈值即刷」回来了，且外表看不出来）',
     dict(mode='edit', path=PULL,
          old='      const raw = Math.max(0, dy - slop);',
          new='      onRefreshRef.current && onRefreshRef.current();\n'
              '      const raw = Math.max(0, dy - slop);')),

    ('M2 PullRefresh 里引回 RN 的 RefreshControl（走回头路 → 安卓过阈值即刷）',
     dict(mode='edit', path=PULL,
          old='import {\n  ActivityIndicator,',
          new="import { RefreshControl } from 'react-native';\nimport {\n  ActivityIndicator,")),

    ('M3 PullRefresh 里引回手势库（跟列表抢同一个原生视图 ⇒ 拉不动）',
     dict(mode='edit', path=PULL,
          old="import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';",
          new="import { GestureDetector } from 'react-native-gesture-handler';\n"
              "import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';")),

    ('M4 atTop 判据被删（改成永远认为在顶部 ⇒ 列表滚在中间也会整块被拽下来）',
     dict(mode='edit', path=PULL,
          old='        atTopRef.current = !(y > 1);\n',
          new='')),

    ('M5 漏注入 overScrollMode / bounces（安卓辉光 / iOS 橡皮筋与我们的位移叠加 = 两倍位移）',
     dict(mode='edit', path=PULL,
          old="      overScrollMode: 'never',\n      bounces: false,\n",
          new='')),

    ('M6 记录页退回 RefreshControl（两页接法漂了）',
     dict(mode='edit', path=RECORDS,
          old='      <PullRefresh refreshing={refreshing} onRefresh={onRefresh}>',
          new='      <PullRefresh refreshing={refreshing} onRefresh={onRefresh} '
              'refreshControl={<RefreshControl />}>')),

    ('M7 学堂页不再用 PullRefresh 包（修一个漏一个）',
     dict(mode='edit', path=STUDY,
          old='      <PullRefresh refreshing={refreshing} onRefresh={onRefresh}>\n      <FlatList',
          new='      <FlatList')),

    ('M8 学堂页 onRefresh 不再交 promise（指示器只能靠定时器蒙时长）',
     dict(mode='edit', path=STUDY,
          old='    return loadPage(0, true)?.finally(() => setRefreshing(false));',
          new='    loadPage(0, true)?.finally(() => setRefreshing(false));')),

    ('M9 App.tsx 偷偷把手势库根容器加回来（本该零手势用法）',
     dict(mode='edit', path=APP,
          old='import Records from',
          new="import { GestureHandlerRootView } from 'react-native-gesture-handler';\n"
              "import Records from")),

    ('M10 松手才刷的唯一实现被删（组件不在仓库里了）',
     dict(mode='delete', path=PULL)),

    # ===== ★ 2026-10-11 用户报：「我下刷新抬起手如果手在某本书籍上，这本书就会打开」=====
    # 这一组盯的是「抬手那一拍不许顺带触发点击」那套修法本身 —— 它最容易做成人畜无害的样子。
    ('M11 下拉标记不再复位（标记再也回不了位 ⇒ 之后**所有**点击全哑）',
     dict(mode='edit', path=PULL,
          old='    PULL.active = false;\n',
          new='')),

    ('M12 标记立早了（写在 onTouchMove 开头 ⇒ 斜着划一下也会把底下的点击吞掉）',
     dict(mode='edit', path=PULL,
          old='      if (pinnedRef.current || !atTopRef.current) return;\n'
              '      const { pageY, pageX } = e.nativeEvent;',
          new='      PULL.active = true;\n'
              '      if (pinnedRef.current || !atTopRef.current) return;\n'
              '      const { pageY, pageX } = e.nativeEvent;')),

    ('M13 isPulling 不再导出（列表项 import 到 undefined ⇒ 首屏崩，tsc 也未必看出来）',
     dict(mode='edit', path=PULL,
          old='export function isPulling(): boolean {',
          new='function isPulling(): boolean {')),

    ('M14 书籍封面的守卫被删（用户报的那一条原样复发）',
     dict(mode='edit', path=BOOKS,
          old='          if (isPulling()) return;\n'
              '          onOpenBook?.(model.bookTarget(item.file));',
          new='          onOpenBook?.(model.bookTarget(item.file));')),

    ('M15 守卫**挪到最后一句**（词还在、看着像拦住了，其实书已经打开了）',
     dict(mode='edit', path=BOOKS,
          old='          if (isPulling()) return;\n'
              '          onOpenBook?.(model.bookTarget(item.file));',
          new='          onOpenBook?.(model.bookTarget(item.file));\n'
              '          if (isPulling()) return;')),
]


def md5(path):
    return hashlib.md5(path.read_bytes()).hexdigest()


def run_check():
    p = subprocess.run(
        [NODE, str(CHECK)], cwd=str(ROOT), capture_output=True, text=True, encoding='utf-8'
    )
    out = (p.stdout or '') + (p.stderr or '')
    m = re.search(r'通过 (\d+) / 失败 (\d+)', out)
    if not m:
        return None, None
    return int(m.group(1)), int(m.group(2))


def main():
    files = sorted({pr['path'] for _, pr in PROBES})
    before = {f: md5(ROOT / f) for f in files if (ROOT / f).exists()}
    bad = 0

    for name, pr in PROBES:
        target = ROOT / pr['path']
        original = target.read_bytes() if target.exists() else None

        if pr['mode'] == 'edit':
            if original is None or pr['old'] not in original.decode('utf-8'):
                print(f'[SKIP] {name} —— 锚点没找到（源码已变？）')
                bad += 1
                continue
            text = original.decode('utf-8').replace(pr['old'], pr['new'], 1)
            target.write_bytes(text.encode('utf-8'))
        elif pr['mode'] == 'delete':
            if original is None:
                print(f'[SKIP] {name} —— 文件本来就不在')
                bad += 1
                continue
            target.unlink()
        else:  # create
            target.write_bytes(pr['content'].encode('utf-8'))

        okc, failc = run_check()

        if original is None:
            target.unlink()
        else:
            target.write_bytes(original)

        if okc is None:
            print(f'[ERR ] {name} —— 没解析到结果行')
            bad += 1
        elif failc and failc > 0:
            print(f'[OK  ] {name} → 通过 {okc} / 失败 {failc}')
        else:
            print(f'[MISS] {name} → 通过 {okc} / 失败 {failc}  ← 哑断言！')
            bad += 1

    after = {f: md5(ROOT / f) for f in files if (ROOT / f).exists()}
    same = before == after
    print(f'\n还原校验：{"逐字节一致 OK" if same else "不一致 !!"}')
    if not same:
        for f in files:
            if before.get(f) != after.get(f):
                print(f'  x {f}: {before.get(f)} -> {after.get(f)}')
        bad += 1
    print('负向验证' + ('全部通过' if bad == 0 else f'有问题 {bad} 处'))
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
