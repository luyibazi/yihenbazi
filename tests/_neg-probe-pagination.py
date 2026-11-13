"""负向验证：把「记录页懒加载 / 分页」逐个改坏，确认 screens-check **真的报红**。

为什么非做不可：这次新加的 51 条断言里有**一大半是源码正则**，
而「文件里出现过某个词」几乎永远是假绿 —— 正则可能匹配到注释、匹配到别的分支、
或者干脆匹配了一个同名的字符串。只有把源码**逐个改坏**、看着它变红，
才能说这些断言真的在守东西。

纪律（与 _neg-probe-study-panes.py / _neg-probe-reader-hl.py 一致）：
  · 开跑前先扫残留备份，有就停下；
  · 锚点必须命中**恰好 1 次**，否则中止；
  · 判「注入生效」看**内容变了**；
  · 还原后先 md5 校验、再删备份。

用法：python tests/_neg-probe-pagination.py
"""
import hashlib
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
BAK = '.nv-backup'

NODE = r'C:\Users\luerse\.workbuddy\binaries\node\versions\22.22.2-6\node.exe'

VIEW = os.path.join(ROOT, 'src', 'screens', 'records', 'Records.tsx')
MODEL = os.path.join(ROOT, 'src', 'screens', 'records', 'model.js')
USTORE = os.path.join(ROOT, 'src', 'core', 'userStore.js')
LDB = os.path.join(ROOT, 'src', 'core', 'store', 'localdb.js')

PROBES = [
    # ---------- 视图：分页参数真的发出去了吗 ----------
    dict(
        name='P1  不给 limit（服务端按「全量」返回，懒加载白做）',
        path=VIEW,
        old='    const opt = model.pageOpt(offsetRef.current);',
        new='    const opt = undefined;',
        expect='每次请求都显式带 limit',
    ),
    dict(
        name='P2  拿 list.length 当位次（去重后更小 ⇒ 原地死循环）',
        path=VIEW,
        old='      offsetRef.current += got;',
        new='      offsetRef.current = list.length;',
        expect='位次按服务端返回条数推进',
    ),
    dict(
        name='P3  用「这次满没满一页」判有没有下一页（最后一页装满会多拉一次空页）',
        path=VIEW,
        old='      const nextMore = model.hasMore(offsetRef.current, total, res.paged);',
        new='      const nextMore = got >= model.PAGE_SIZE;',
        expect='判据交给 model.hasMore',
    ),
    dict(
        name='P4  去掉代次检查（上一份列表的一页会被追加到新列表尾巴上）',
        path=VIEW,
        old='      if (gen !== genRef.current) return;\n',
        new='',
        expect='续拉回来先比代次',
    ),
    dict(
        name='P5  替换型请求不把位次归零',
        path=VIEW,
        old='      offsetRef.current = 0;\n',
        new='',
        expect='就把位次归零',
    ),
    # ---------- 视图：续拉的两道闸 ----------
    dict(
        name='P6  续拉少了「同时只许一个在飞」那道闸',
        path=VIEW,
        old='    if (!moreRef.current || loadingMoreRef.current) return;',
        new='    if (!moreRef.current) return;',
        expect='续拉两道闸',
    ),
    dict(
        name='P7  闸门改用 state 记（同一帧连发时形同虚设）',
        path=VIEW,
        old='    loadingMoreRef.current = true;',
        new='    setLoadingMore(true);',
        expect='闸门用 **ref** 记',
    ),
    # ---------- 视图：滚动触发 ----------
    dict(
        name='P8  ScrollView 上没有 onScroll（续拉永远不触发）',
        path=VIEW,
        old='        onScroll={onListScroll}\n',
        new='',
        expect='真的挂了 onScroll',
    ),
    dict(
        name='P9  在视图里就地算「滚到底了没」（绕开 model.nearBottom）',
        path=VIEW,
        old='    if (!model.nearBottom(y, viewH, contentH, LOAD_MORE_GAP)) return;',
        new='    if (!(contentH - (y + viewH) <= LOAD_MORE_GAP)) return;',
        expect='判据走 model.nearBottom',
    ),
    # ---------- 视图：底部那行 ----------
    dict(
        name='P10 底部那行永远可点（「正在加载…」点了没反应）',
        path=VIEW,
        old='          disabled={!moreErr}',
        new='          disabled={false}',
        expect='只有失败态可点',
    ),
    dict(
        name='P11 续拉失败把已经显示出来的那一屏也打成失败态',
        path=VIEW,
        old='        if (append) {\n          setMoreErr(true);\n          return;\n        }\n',
        new='',
        expect='续拉失败只在底部写一句',
    ),
    # ---------- 视图：计数口径 ----------
    dict(
        name='P12 「共 N 例」的分子改回 list.length（200 条会说成「共 50 例」）',
        path=VIEW,
        old='  const shownCount = model.countShown(list.length, pageTotal);',
        new='  const shownCount = list.length;',
        expect='的分子走 model.countShown',
    ),
    # ---------- 视图：红线复述 ----------
    dict(
        name='P13 视图里就地 filter 去重（踩「过滤必须在服务端」那条红线）',
        path=VIEW,
        old='        setList((prev: Item[]) => model.appendUnique(prev, items));',
        new='        setList((prev: Item[]) => prev.concat(items.filter((it: Item) => !prev.some((p: Item) => p.id === it.id))));',
        expect='拼下一页走 model.appendUnique',
    ),
    # ---------- 模型：hasMore ----------
    dict(
        name='P14 hasMore 不看 paged（非分页驱动 ⇒ 无限拉同一页）',
        path=MODEL,
        old='  if (paged !== true) return false;\n',
        new='',
        expect='服务端没切片',
    ),
    dict(
        name='P15 hasMore 把「拉够 total」判成还有下一页（多拉一次空页）',
        path=MODEL,
        old='  return at < total;',
        new='  return at <= total;',
        expect='回到 total 了就是到底了',
    ),
    # ---------- 模型：footText ----------
    dict(
        name='P16 底部那行把「正在加载」排在失败前面（失败被盖住，只看见圈一直转）',
        path=MODEL,
        old="  if (x.err) return '加载失败 · 点此重试';\n  if (x.loading) return '正在加载…';",
        new="  if (x.loading) return '正在加载…';\n  if (x.err) return '加载失败 · 点此重试';",
        expect='失败态优先级最高',
    ),
    # ---------- 模型：countShown ----------
    dict(
        name='P17 countShown 忽略服务端 total（拿一页当总数）',
        path=MODEL,
        old='  if (typeof total === \'number\' && isFinite(total) && total >= 0) return total;\n',
        new='',
        expect='有服务端 total 时用它',
    ),
    # ---------- 模型：nearBottom ----------
    dict(
        name='P18 nearBottom 不认无穷大的滚动位置（-Infinity <= gap 恒真 ⇒ 抢跑，一次拉几页）',
        path=MODEL,
        old='  if (!isFinite(y) || !isFinite(viewH) || !isFinite(contentH)) return false;\n',
        new='',
        expect='无穷大的滚动位置',
    ),
    # ---------- 模型：appendUnique ----------
    dict(
        name='P19 appendUnique 就地改调用方那份数组（React 看不到变化）',
        path=MODEL,
        old='  const out = Array.isArray(prev) ? prev.slice() : [];',
        new='  const out = Array.isArray(prev) ? prev : [];',
        expect='不许就地改调用方那份数组',
    ),
    dict(
        name='P20 nearBottom 不认无穷大的提前量（永远判「到了」）',
        path=MODEL,
        old='  const g = (typeof gap === \'number\' && isFinite(gap) && gap > 0) ? gap : 0;',
        new='  const g = (typeof gap === \'number\' && gap > 0) ? gap : 0;',
        expect='提前量是无穷大',
    ),
    # ---------- 链路逐层透传（local-check 对分页零覆盖，只剩这几条源码断言） ----------
    dict(
        name='P21 userStore 收下 opt 却不转发（分页参数在这一跳蒸发）',
        path=USTORE,
        old='  return store.listRecords(uid, filter, opt).then(function (res) {',
        new='  return store.listRecords(uid, filter).then(function (res) {',
        expect='且必须把它**转给 store**',
    ),
    dict(
        name='P22 userStore 不把服务端的 total 带回来',
        path=USTORE,
        old='    if (typeof res.total === \'number\') out.total = res.total;\n',
        new='',
        expect='userStore 必须把 `total` 带回来',
    ),
    dict(
        name='P23 localdb 只发 limit 不发 offset（每次都在拉第一页）',
        path=LDB,
        old='      if (opt.offset != null) q.offset = String(opt.offset);\n',
        new='',
        expect='limit 与 offset 一起拼进 query',
    ),
    dict(
        name='P24 localdb 直接在调用方那份 filter 上改（污染组件 state 引用）',
        path=LDB,
        old='    const q = Object.assign({}, filter || {});',
        new='    const q = filter || {};',
        expect='拼在**新对象**上',
    ),
    dict(
        name='P25 localdb 用 !!d.paged（别的真值也当成分页返回）',
        path=LDB,
        old='        paged: d.paged === true',
        new='        paged: !!d.paged',
        expect='只有服务端**明说 true** 才算切片返回',
    ),
]


def md5(path):
    with open(path, 'rb') as f:
        return hashlib.md5(f.read()).hexdigest()


def read(path):
    with open(path, encoding='utf-8', newline='') as f:
        return f.read()


def write(path, text):
    with open(path, 'w', encoding='utf-8', newline='') as f:
        f.write(text)


def run_check():
    r = subprocess.run(
        [NODE, 'tools/run.js', 'tests/screens-check.js'],
        cwd=ROOT, capture_output=True, text=True, encoding='utf-8', errors='replace',
    )
    out = (r.stdout or '') + (r.stderr or '')
    m = re.search(r'通过 (\d+) / 失败 (\d+)', out)
    fails = [l for l in out.splitlines() if l.startswith('FAIL')]
    return (int(m.group(1)), int(m.group(2)), fails) if m else (-1, -1, fails)


def main():
    files = [VIEW, MODEL, USTORE, LDB]

    leftovers = []
    for p in files:
        d, b = os.path.dirname(p), os.path.basename(p)
        for name in os.listdir(d):
            if name.startswith(b + BAK):
                leftovers.append(os.path.join(d, name))
    if leftovers:
        print('!! 发现上次残留的备份，先人工处理，脚本不动任何文件：')
        for l in leftovers:
            print('   ', l)
        return 2

    orig = {p: read(p) for p in files}
    sums = {p: md5(p) for p in files}

    base_pass, base_fail, _ = run_check()
    print(f'[基线] 通过 {base_pass} / 失败 {base_fail}\n')
    if base_fail != 0 or base_pass < 0:
        print('!! 基线本身就不是全绿，先修好再谈负向验证')
        return 2

    bad = 0
    for pr in PROBES:
        p = pr['path']
        src = orig[p]
        hits = src.count(pr['old'])
        if hits != 1:
            print(f"!! {pr['name']}\n   锚点命中 {hits} 次（必须恰好 1 次）→ 中止，文件未改动")
            return 3
        injected = src.replace(pr['old'], pr['new'])
        if injected == src:
            print(f"!! {pr['name']}\n   注入后内容没变 → 中止")
            return 3

        write(p + BAK, src)
        write(p, injected)
        try:
            npass, nfail, fails = run_check()
        finally:
            write(p, src)
        restored = md5(p) == sums[p]
        os.remove(p + BAK)

        hit = [l for l in fails if pr['expect'] in l]
        good = nfail > 0 and bool(hit)
        if not good:
            bad += 1
        print(f'{"OK  拦住了" if good else "BAD  没拦住"}  {pr["name"]}')
        print(f'      失败 {nfail} 条' + (f'，命中：「{hit[0][:88]}」' if hit else '（没有一条命中预期断言！）'))
        print(f'      还原 {"md5 一致" if restored else "!!! md5 不一致 !!!"}')
        if not restored:
            return 4

    print()
    print(f'=== {len(PROBES)}/{len(PROBES)} 全部拦住 ===' if not bad
          else f'=== 有 {bad} 个探针没拦住，断言存在假绿 ===')
    return 0 if not bad else 1


if __name__ == '__main__':
    sys.exit(main())
