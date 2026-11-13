"""负向验证：把「学堂页 = 切换栏 + 两个常驻面板」逐个改坏，确认 screens-check **真的报红**。

纪律（与 _neg-probe-reader-hl.py 一致）：
  · 开跑前先扫残留备份，有就停下；
  · 锚点必须命中**恰好 1 次**，否则中止；
  · 判「注入生效」看**内容变了**；
  · 还原后先 md5 校验、再删备份。

用法：python tests/_neg-probe-study-panes.py
"""
import hashlib
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
BAK = '.nv-backup'

SHELL = os.path.join(ROOT, 'src', 'screens', 'study', 'Study.tsx')
QUERY = os.path.join(ROOT, 'src', 'screens', 'study', 'QueryPane.tsx')
BOOKS = os.path.join(ROOT, 'src', 'screens', 'study', 'BooksPane.tsx')
MODEL = os.path.join(ROOT, 'src', 'screens', 'study', 'model.js')
SEG = os.path.join(ROOT, 'src', 'components', 'SegTabs.tsx')

PROBES = [
    dict(
        name='N1  壳里把 QueryPane 改成条件渲染（切走就卸载）',
        path=SHELL,
        old='        <View style={[s.pane, showQuery ? null : s.hidden]}>\n'
            '          <QueryPane active={showQuery} onOpenBookmark={onOpenBookmark} />\n'
            '        </View>',
        new='        {showQuery ? <QueryPane active={showQuery} onOpenBookmark={onOpenBookmark} /> : null}',
        expect='绝不条件渲染',
    ),
    dict(
        name='N2  漏掉书籍面板的 display 切换',
        path=SHELL,
        old='        <View style={[s.pane, showBooks ? null : s.hidden]}>',
        new='        <View style={s.pane}>',
        expect='都**按选中态切 display',
    ),
    dict(
        name='N3  active 不再与选中项相与（一进学堂就发查询请求）',
        path=SHELL,
        old="  const showQuery = active && pane === 'query';\n"
            "  const showBooks = active && pane === 'books';",
        new='  const showQuery = active;\n  const showBooks = active;',
        expect='active 语义',
    ),
    dict(
        name='N4  PANE_TABS 里的文案被改掉（等于 JSX 另写一份的下场）',
        path=SHELL,
        old="  { key: 'query', label: '查询' },\n  { key: 'books', label: '书籍' },",
        new="  { key: 'query', label: 'Q' },\n  { key: 'books', label: 'B' },",
        expect='页签文案只在 PANE_TABS',
    ),
    dict(
        name='N5  QueryPane 里塞进 SegTabs（面板复用时不该自带切换栏）',
        path=QUERY,
        old="import { PullRefresh, isPulling } from '../../components/PullRefresh';",
        new="import { PullRefresh, isPulling } from '../../components/PullRefresh';\n"
            "import { SegTabs } from '../../components/SegTabs';",
        expect='QueryPane 里不许出现 SegTabs',
    ),
    dict(
        name='N6  SegTabs 自己存一份选中值（受控变非受控）',
        path=SEG,
        old='  const rpx = useRpx();',
        new='  const rpx = useRpx();\n  const [dummy, setDummy] = useState<T>(value);',
        expect='不存**选中值',
    ),

    # ============================================================
    # 书籍面板 = 书架（★ 2026-10-11「从后端获取书籍列表，显示书籍」）
    # ⚠ 原来是「N5 加了占位文案」那条（书架填上内容后，那条锚点已经不存在了）
    # ============================================================
    dict(
        name='S1  bookTarget 的 sec 写成 0（会被阅读页当成「第一章」而不是整本）',
        path=MODEL,
        old="  return { name: '', chapter: [], book: file, sec: null, para: null };",
        new="  return { name: '', chapter: [], book: file, sec: 0, para: null };",
        expect='整本打开时 sec 必须是',
    ),
    dict(
        name='S2  书架取了 items 而不是 books（书架上摆出一堆书签）',
        path=BOOKS,
        old='      setList(Array.isArray(res.books) ? res.books : []);',
        new='      setList(Array.isArray(res.items) ? res.items : []);',
        expect='清单取的是响应里的 **books**',
    ),
    dict(
        name='S3  去掉懒加载闸门（每次切回书籍面板都重拉一次）',
        path=BOOKS,
        old='    if (startedRef.current) return;\n',
        new='',
        expect='懒加载闸门',
    ),
    dict(
        name='S4  下拉刷新 / 重试不再作废在飞的请求（旧结果会盖掉已画好的书架）',
        path=BOOKS,
        old='  const bumpGen = useCallback(() => { genRef.current += 1; }, []);',
        new='  const bumpGen = useCallback(() => { genRef.current += 0; }, []);',
        expect='作废在飞请求只有一处实现',
    ),
    dict(
        name='S5  坏文件也能点（点进去只会看见一个失败页）',
        path=BOOKS,
        old='        disabled={bad}',
        new='        disabled={false}',
        expect='读不了的书**不可点**',
    ),
    # ---- 2026-10-11 用户：「将书签等提示字移除，将书本缩小，太大了」----
    # ⚠ 原来 S6/S7 是「坏文件说成还没有书签」「没有书也显示共 0 本」—— 那两个函数
    #   （bookMetaText / shelfSummaryText）已经整块删掉了，锚点不存在 ⇒ 换成盯「移除」本身。
    dict(
        name='S6  封面下面那行小字又加回来（用户明确要求移除的提示字）',
        path=BOOKS,
        old='        </View>\n      </Pressable>\n    );\n  }, [s, onOpenBook]);',
        new='        </View>\n'
            "        <Text style={[s.meta, bad ? s.metaBad : null]} numberOfLines={1}>{'750 条书签'}</Text>\n"
            '      </Pressable>\n    );\n  }, [s, onOpenBook]);',
        # ⚠⚠ expect 是**按原文子串**比的（本脚本不剥 `*`，与 tools/_run-neg.sh 那套不同）
        #    ⇒ 断言文案里带 `**` 的，这里必须把 `**` 一起写上，否则「明明红了」也会被报成假绿。
        expect='书架视图里**一个「书签」字样都不该有**',
    ),
    dict(
        name='S7  顶部汇总行又加回来（「共 13 本 · 3717 条书签」）',
        path=BOOKS,
        old='      <PullRefresh refreshing={refreshing} onRefresh={onRefresh}>',
        new="      {list.length ? <View style={s.bar}><Text style={s.barText}>{'共 13 本'}</Text></View> : null}\n"
            '      <PullRefresh refreshing={refreshing} onRefresh={onRefresh}>',
        expect='封面下那行小字 / 顶部汇总行的样式与渲染都不许再加回来',
    ),
    dict(
        name='S8  列数退回两列（用户嫌太大，改回去了）',
        path=BOOKS,
        old='          numColumns={3}',
        new='          numColumns={2}',
        expect='书架一行**三本**',
    ),
    dict(
        name='S9  封面只改宽不改高（比例被压扁）',
        path=BOOKS,
        old='      height: rpx(280),',
        new='      height: rpx(220),',
        expect='封面 220 × 280',
    ),
    dict(
        name='S10 汇总文案函数被接回 model 的导出里（看着像「留着备用」，其实就是没清干净）',
        path=MODEL,
        old='  SHELF_LIMIT: SHELF_LIMIT,\n  shelfEmptyText: shelfEmptyText,',
        new="  SHELF_LIMIT: SHELF_LIMIT,\n"
            "  shelfSummaryText: function () { return '共 1 本'; },\n"
            '  shelfEmptyText: shelfEmptyText,',
        expect='汇总行那套文案函数已删除',
    ),

    # ---- 2026-10-11 用户：「学堂页面下拉刷新时，要将列表数据清空，等待新数据」----
    dict(
        name='S11 查询面板下拉不再清空列表（旧数据挂在屏上 ⇒ 看不出刷新有没有生效）',
        path=QUERY,
        old='    itemsRef.current = [];\n'
            '    setItems([]);\n'
            '    setTotal(0);        // ⚠ 不清的话工具栏那句「共 N 个 · 已加载 M 个」会挂着上一份的旧数字\n'
            '    setRefreshing(true);',
        new='    setRefreshing(true);',
        expect='下拉**必须清空列表**',
    ),
    dict(
        name='S12 工具栏判据去掉 loading（清空那一瞬间工具栏消失 ⇒ 整屏跳一下再跳回来）',
        path=QUERY,
        old="  const showTools = canBooks && (items.length > 0 || filtered || phase === 'loading');",
        new='  const showTools = canBooks && (items.length > 0 || filtered);',
        expect='清空那一瞬间工具栏**不许跟着消失**',
    ),
    dict(
        name='S13 书架下拉不再清空（学堂页里两个面板只改了一个）',
        path=BOOKS,
        old='    setList([]);\n    setRefreshing(true);',
        new='    setRefreshing(true);',
        expect='书架下拉刷新也要**先清空**',
    ),

    # ---- 2026-10-11 用户：「把 .docx 放进登记的书籍文件夹即可 —— 移除这种提示文字」----
    dict(
        name='S14 书架空态又把「怎么做」的小字加回来',
        path=BOOKS,
        old='        <Text style={s.emptyText}>{model.shelfEmptyText(phase, errText)}</Text>',
        new='        <Text style={s.emptyText}>{model.shelfEmptyText(phase, errText)}</Text>\n'
            '        <Text style={s.emptyTip}>把 .docx 放进登记的书籍文件夹即可</Text>',
        expect='书架空态里不许再有',
    ),
    dict(
        name='S15 查询面板空态又把「怎么做」的小字加回来',
        path=QUERY,
        old='        <Text style={s.emptyText}>{model.emptyText(phase, errText, filtered)}</Text>\n'
            '      </View>\n'
            '    );\n'
            '  }, [canBooks, phase, errText, filtered, s, onRetry, onResetFilter]);',
        new='        <Text style={s.emptyText}>{model.emptyText(phase, errText, filtered)}</Text>\n'
            '        <Text style={s.emptyTip}>换个干支再试，或清除筛选看全部</Text>\n'
            '      </View>\n'
            '    );\n'
            '  }, [canBooks, phase, errText, filtered, s, onRetry, onResetFilter]);',
        expect='查询面板空态里不许再有',
    ),

    # ---- 2026-10-11 用户：「书籍封面上要显示：共计多少案例。数量就是书签的数量」----
    dict(
        name='S16 封面上那行案例数整块被删掉（用户要的「共计多少案例」没了）',
        path=BOOKS,
        old='          {item.count > 0 ? (\n'
            '            <View style={s.count}>\n'
            '              <Text style={s.countText} numberOfLines={1}>\n'
            '                共计 {item.count} 案例\n'
            '              </Text>\n'
            '            </View>\n'
            '          ) : null}\n',
        new='',
        expect='封面底部那行「共计 N 案例」的数量必须来自',
    ),
    dict(
        name='S17 案例数改成前端写死的数字（不从 item.count 来）',
        path=BOOKS,
        old='                共计 {item.count} 案例',
        new='                共计 750 案例',
        expect='封面底部那行「共计 N 案例」的数量必须来自',
    ),
    dict(
        name='S18 数量改成恒显示（count=0 的书也写「共计 0 案例」）',
        path=BOOKS,
        old='          {item.count > 0 ? (',
        new='          {true ? (',
        expect='count=0（一条都没命中',
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
        ['node', 'tools/run.js', 'tests/screens-check.js'],
        cwd=ROOT, capture_output=True, text=True, encoding='utf-8', errors='replace',
    )
    out = (r.stdout or '') + (r.stderr or '')
    m = re.search(r'通过 (\d+) / 失败 (\d+)', out)
    fails = [l for l in out.splitlines() if l.startswith('FAIL')]
    return (int(m.group(1)), int(m.group(2)), fails) if m else (-1, -1, fails)


def main():
    files = [SHELL, QUERY, BOOKS, MODEL, SEG]

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
