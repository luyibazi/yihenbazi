"""负向验证：把**阅读页**逐个改坏，确认 screens-check **真的报红**。

⚠ 文件名保留历史名字（README / 记忆里都引它），内容已从「书签段落高亮」扩到
   整个阅读页（高亮 + 目录 2026-10-11 引入 / 2026-10-12 **整块移除** —— 探针由
   「目录不能坏」改成「目录不许回流」；双向续拉的对称 —— 量 / 提示 / 阈值 2026-10-12）。

纪律（与 _neg-probe-pullrefresh.py 一致）：
  · 开跑前先扫残留备份（上一次被强杀留下的），有就停下；
  · 锚点**先全量自检**：必须命中**恰好 1 次**，否则中止（且此时还没写备份，不留残留）——
    宁可没测，也不许改到别处；
  · 判「注入生效」看**内容变了**，不看长度（true→false 长度一样）；
  · 每条探针还原后 md5 校验；**全部**一致才删备份（不一致就留着并大声报错）。
  · ⚠⚠ 备份**只在开跑前写一次、全部跑完才删**（不是每条写/删一份）——
    一轮 50+ 次删除会撞宿主的批量删除保护（SAFE_DELETE_BULK_CONFIRM_REQUIRED），
    跑到一半被掐死（2026-10-13 连踩两次）。
  · ⚠⚠⚠ `expect` 必须是那条断言 **desc 的连续子串**。最容易错的是**加粗标记**
    （断言 desc 写的是「必须**按目标行**分组」，expect 写成「按**目标行**分组」就不匹配 ——
    星号位置挪了一下，字面就不同了）。后果：断言明明拦住了，探针却报「没拦住」= **假阴**。
    2026-10-14 真踩过（Z20），排查了半天。**写完 expect，先拿它去 desc 里搜一遍。**

用法：python tests/_neg-probe-reader-hl.py
"""
import hashlib
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
BAK = '.nv-backup'

MODEL = os.path.join(ROOT, 'src', 'screens', 'reader', 'model.js')
VIEW = os.path.join(ROOT, 'src', 'screens', 'reader', 'Reader.tsx')
STUDY_MODEL = os.path.join(ROOT, 'src', 'screens', 'study', 'model.js')

PROBES = [
    # ================================================================
    # 2026-10-19：阅读页照 demo `docx-book/demo/index.html` **清空重做**，
    # 探针清单随之**整份重写**（老那 46 条守的是「连续段落流 + 双向续拉 + 点屏幕呼出
    # 工具栏」那一代形态，机器已经不存在，锚点命中 0 次 —— 留着只会每次跑都中止）。
    #
    # 新清单守的是这一代的**不变量**，分四组：
    #   ① 定位换算只此一处（offset → 块 → 实测行高 → scrollToOffset）；
    #   ② 高亮常亮、且只在该亮时亮；
    #   ③ 阅读位置只认「从书架来」那一趟；
    #   ④ 新形态本身（常驻头部 / 侧栏抽屉 / 一次一章）不许回流成旧形态。
    # ================================================================

    # ---- ① 定位：换算只此一处，且必须经过那两个纯函数 ----
    dict(name='N1  定位丢掉 `jump` 那一半（不要定位的来路也会滚 ⇒ 翻章/恢复位置全乱）',
         path=VIEW,
         old='const want = jump && params && params.seek ? params.seek : null;',
         new='const want = params && params.seek ? params.seek : null;',
         expect='「要不要定位」看 `params.seek`'),
    dict(name='N2  定位换算内联进视图（同一判据散两处，将来必有一处忘了改）',
         path=VIEW,
         old='const bi = want ? model.bookmarkBlock(res.blocks, want.offset, want.text) : -1;',
         new='const bi = want ? res.blocks.findIndex(function (b) { return b && b.text; }) : -1;',
         expect='定位换算只此一处'),
    dict(name='N3  定位滚回 scrollToIndex（估算那一代又回来了）',
         path=VIEW,
         old="try { ref.scrollToOffset({ offset: y, animated: false }); } catch (e) { /* 列表已卸 */ }",
         new="try { ref.scrollToIndex({ index: idx, animated: false }); } catch (e) { /* 列表已卸 */ }",
         expect='老机制整族'),
    dict(name='N4  不再整份重挂列表（改 props 里的 initialScrollIndex —— 那只在挂载时起作用）',
         path=VIEW,
         old="key={'L' + listId}\r\n            data={layout.rows}",
         new="key={'reader-list'}\r\n            data={layout.rows}",
         expect='整份重挂**列表'),
    dict(name='N5  定位判据丢掉 `!settled` 那一半（量那几轮里用户眼看着它跳）',
         path=VIEW,
         old="const loadingBox = phase === 'loading' || !settled;",
         new="const loadingBox = phase === 'loading';",
         expect='定位还没落位'),
    dict(name='N6  「到位」的容差放到 2px 以上（永远等不到落位 ⇒ 加载框挂死）',
         path=VIEW,
         old='if (Math.abs(off - plan.y) <= 2) setSettledNow(true);',
         new='if (Math.abs(off - plan.y) <= 40) setSettledNow(true);',
         expect='≤ 2px 才算到位'),
    dict(name='N7  有缺口也直接冲目标 y（下界当位置用 = 老版滚过头的同一个错）',
         path=MODEL,
         old='  if (gaps.length === 0) return y > 0 ? y : 0;',
         new='  if (gaps.length === 0) return y > 0 ? y : 0;\n  if (gaps.length) return y;',
         expect='有缺口 ⇒ 只滚到**第一个缺口**'),

    # ---- ② 高亮：常亮、只在该亮时亮、样式不影响尺寸 ----
    dict(name='N8  高亮不再看 hl（翻章 / 从书架恢复位置也亮 ⇒ 满屏金色）',
         path=VIEW,
         old='      const segs: Array<{ bi: number; start: number; end: number }> = [];\r\n'
             '      if (hl && seek != null && want) {',
         new='      const segs: Array<{ bi: number; start: number; end: number }> = [];\r\n'
             '      if (seek != null && want) {',
         expect='满屏金色'),
    dict(name='N9  段内高亮不切（segText 丢了 s.hlText ⇒ 点了书签什么都看不见）',
         path=VIEW,
         old='<Text style={s.hlText}>{t.slice(seg.start, seg.end)}</Text>',
         new='<Text>{t.slice(seg.start, seg.end)}</Text>',
         expect='segText'),
    dict(name='N10 高亮加"1.8s 后淡出"（用户明确否掉过：让这个高亮一直存在啊）',
         path=VIEW,
         old="      setHlSegs(segs);",
         new="      setHlSegs(segs);\r\n      if (hl) setTimeout(function () { setHlSegs([]); }, 1800);",
         expect='高亮**不许自动撤**'),
    dict(name='N11 高亮样式混进 padding（行高变了 ⇒ 按未高亮量出来的定位当场算错）',
         path=VIEW,
         old="hlText: { backgroundColor: COLORS.goldPale, borderRadius: rpx(4) },",
         new="hlText: { backgroundColor: COLORS.goldPale, borderRadius: rpx(4), padding: rpx(6) },",
         expect='只许底色/圆角'),
    dict(name='N12 highlightRange 不夹 local（越界时算出负区间，<Text> 直接崩）',
         path=MODEL,
         old='  if (start >= len) return null;',
         new='  if (start > len) return null;',
         expect='local 越界 ⇒ null'),
    dict(name='N13 位置行不看章序取没取到（数据没到也显示「第 1/0 章」）',
         path=MODEL,
         old="  if (typeof chIdx !== 'number') return '';",
         new='',
         expect='⇒ **空串**'),

    # ---- ③ 阅读位置：只认「从书架点封面」那一趟 ----
    dict(name='N14 退场不看来路（冲着书签来的也记位置 ⇒ 下次点封面跳到他没读过的地方）',
         path=VIEW,
         old='if (model.fromShelf(target) && readPosRef.current) {',
         new='if (readPosRef.current) {',
         expect='退场**只有从书架进来才**'),
    dict(name='N15 readPos.set 退回两参（offset 塞进 chapter 位，下次跳到不存在的章）',
         path=VIEW,
         old='readPos.set(book, readPosRef.current.chapter, readPosRef.current.offset);',
         new='readPos.set(book, readPosRef.current.chapter);',
         expect='必须是**三参**的 set'),
    dict(name='N16 fromShelf 判据写成 truthy（第一章 / 章首的书签被误判成"从书架来"）',
         path=MODEL,
         old='  return target.chapter == null && target.offset == null;',
         new='  return !target.chapter && !target.offset;',
         expect='判据写成 truthy 会把它误判成'),
    dict(name='N17 fromShelf 多出第三处判据（同一意思散两处，迟早有一处忘了改）',
         path=VIEW,
         old='    if (params) load(params, true, !model.fromShelf(target));',
         new='    const shelfIn = model.fromShelf(target);\n    if (params) load(params, true, !model.fromShelf(target));\n    if (shelfIn) loadToc();',
         expect='**只许两处**'),
    dict(name='N18 取位置多一处（滚动 / 翻章里反复读本地）',
         path=VIEW,
         old='    const params = model.openParams(target, readPos.get(book));',
         new='    const params = model.openParams(target, readPos.get(book));\n    const again = readPos.get(book);',
         expect='取位置也只有一处'),

    # ---- ④ 新形态本身：常驻头部 / 侧栏抽屉 / 一次一章，不许回流成旧形态 ----
    dict(name='N19 翻章自己 idx ± 1（服务端按 total 判过的边界被绕开）',
         path=VIEW,
         old='  const prevSec = model.prevChapter(data);',
         new='  const prevSec = data && data.chapter && data.chapter.idx > 0 ? data.chapter.idx - 1 : null;',
         expect='翻章目标走服务端的 prev / next'),
    dict(name='N20 首章 / 末章的按钮不禁（点下去发一个 chapter=null 的请求）',
         path=VIEW,
         old='          disabled={!prevSec}',
         new='          disabled={false}',
         expect='按钮 disabled（不是「灰按钮」'),
    dict(name='N21 目录喂的是未筛的 tocList（搜索框成了摆设）',
         path=VIEW,
         old='                data={tocArr}',
         new='                data={tocList}',
         expect='搜索筛过的 tocArr'),
    dict(name='N22 侧栏点书签自己拼 params（"这一趟从哪开始"有了第二处算法）',
         path=VIEW,
         old="""    const p = model.openParams(\r
      { book: book, chapter: bm.chapter, offset: bm.offset, text: bm.text, name: bm.name },\r
      null\r
    );""",
         new="    const p = { book: book, chapter: bm.chapter, seek: { offset: bm.offset, text: bm.name } };",
         expect='侧栏点书签也走 `model.openParams`'),
    dict(name='N23 书签那一栏改成启动就取（只读书的人白背一个请求）',
         path=VIEW,
         old="    if (k === 'bm' && bmPhase === 'idle') loadBookmarks();",
         new='    setSideTab(k);',
         expect='侧栏「书签」页签是**懒加载**的'),
    dict(name='N24 书签只取一页（搜索漏掉 90% 的书签，且不报错）',
         path=VIEW,
         old='const BM_PAGE = 1000;',
         new='const BM_PAGE = 50;',
         expect='BM_PAGE = 1000'),
    dict(name='N25 头部那枚「目录」不开抽屉（形态回流成旧那套）',
         path=VIEW,
         old='        <Pressable style={s.sideBtn} onPress={onOpenSide}>',
         new='        <Pressable style={s.sideBtn} onPress={() => setSideOn(false)}>',
         expect='头部那枚「目录」开的是**侧栏抽屉**'),
    dict(name='N26 抽屉没了背面遮罩（只能点里面那枚关闭，手势上很别扭）',
         path=VIEW,
         old='          <Pressable style={s.scrim} onPress={() => setSideOn(false)} />',
         new='          <View style={s.scrim} />',
         expect='背面遮罩**点一下即关**'),
    dict(name='N27 正文列表加回 contentContainerStyle（padding 让实测 y 整体偏一截）',
         path=VIEW,
         old='                 "May have bugs (missing content)"）。 */\r\n            style={{ flex: 1 }}\r\n          />',
         new='                 "May have bugs (missing content)"）。 */\r\n            contentContainerStyle={{ paddingTop: rpx(16) }}\r\n            style={{ flex: 1 }}\r\n          />',
         expect='不许有 contentContainerStyle'),
    dict(name='N28 搜索框占位文案改字（与 demo 的那份逐字对齐是有意的）',
         path=MODEL,
         old="const SEARCH_PLACEHOLDER = '搜索标题 / 书签';",
         new="const SEARCH_PLACEHOLDER = '搜索';",
         expect='一字不改'),

    # ---- ⑤ 2026-10-19 实测 bug 的回归：**量到的高度必须等于行占的高度** ----
    #   根因：`onLayout` 只报自己的 border-box、**不含自己的 margin**；而 VirtualizedList 的
    #   cell 是一层裸 View，子节点的 margin **算进 cell 占位** ⇒ 每行差一个 marginBottom，
    #   误差随行数线性涨（实测第 582 块的书签早滚 7.85 屏）。用户报「点击书签没滚到相应位置」。
    dict(name='N29 onLayout 挪回内层 <Text>（量的不含 margin、占的含 ⇒ 每行差 18rpx，实测早滚 7.85 屏）',
         path=VIEW,
         old="""      <View\r
        style={item && item.type === 'source' ? s.srcRow : s.paraRow}\r
        onLayout={onRowLayout}\r
      >\r
        <Text style={item && item.type === 'source' ? s.srcPara : s.para}>\r
          {segText(item.text, seg)}\r
        </Text>\r
      </View>""",
         new="""      <Text\r
        style={item && item.type === 'source' ? s.srcPara : s.para}\r
        onLayout={onRowLayout}\r
      >\r
        {segText(item.text, seg)}\r
      </Text>""",
         expect='外壳 View 量高度**」这一形态'),
    dict(name='N30 段距挪回 margin（同一个 bug 的另一种长相：量到的不等于占到的）',
         path=VIEW,
         old='    paraRow: { paddingBottom: rpx(18) },',
         new='    paraRow: { marginBottom: rpx(18) },',
         expect='段距是外壳的 **paddingBottom**'),
    dict(name='N31 正文列表退回虚拟化挂载 / 开 removeClippedSubviews（行高报不上来 ⇒ 定位循环走不完 = 点书签不跳）',
         path=VIEW,
         old='            initialNumToRender={layout.rows.length || RENDER_FIRST}',
         new='            initialNumToRender={RENDER_FIRST}\r\n            windowSize={21}\r\n            removeClippedSubviews',
         expect='整章全量挂载'),
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
    files = [MODEL, VIEW, STUDY_MODEL]

    # 0) 残留备份
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

    # 1) 锚点**先全量自检**（每条必须恰好命中 1 次）—— 放在写备份之前：
    #    锚点漂了是最常见的中止原因，这样中止时不会留下残留备份。
    for pr in PROBES:
        hits = orig[pr['path']].count(pr['old'])
        if hits != 1:
            print(f"!! {pr['name']}\n   锚点命中 {hits} 次（必须恰好 1 次）→ 中止，文件未改动")
            return 3

    # 2) 备份**只在开跑前写一次**（不是每跑一条探针写/删一份）：
    #    内容就是 orig[p]，整个跑动过程中不变 ⇒ 语义与「每条探针各写一份」完全一样
    #    （被硬杀时照样能在源码旁找到完整原档，启动时的残留扫描照样能发现）。
    # ⚠⚠ 为什么改：每条探针「写一份 + 删一份」= 一轮 50+ 次删除，会被宿主的
    #    **批量删除保护**（SAFE_DELETE_BULK_CONFIRM_REQUIRED）在第 50 次掐死 ——
    #    跑到一半停住、还留下残留备份（2026-10-13 连踩两次）。
    for p in files:
        write(p + BAK, orig[p])

    bad = 0
    for pr in PROBES:
        p = pr['path']
        src = orig[p]
        injected = src.replace(pr['old'], pr['new'])
        if injected == src:
            print(f"!! {pr['name']}\n   注入后内容没变 → 中止")
            for p2 in files:
                os.remove(p2 + BAK)      # 还没注入任何东西 ⇒ 备份可清
            return 3

        write(p, injected)           # 注入（备份已在开跑前写好，见上）
        try:
            npass, nfail, fails = run_check()
        finally:
            write(p, src)            # 还原
        restored = md5(p) == sums[p]

        hit = [l for l in fails if pr['expect'] in l]
        # ⚠ nfail < 0 = screens-check 自己**跑崩了**（断言太脆 / 注入把模块弄挂）：
        #   那也是「注入生效且被撞到」，同样算拦住 —— 否则会把真拦住误报成假绿。
        crashed = nfail < 0
        caught = (nfail > 0 and bool(hit)) or crashed
        verdict = 'OK  拦住了' if caught else 'BAD  没拦住'
        if not caught:
            bad += 1
        print(f'{verdict}  {pr["name"]}')
        if crashed:
            print('      失败 -1 条（screens-check 跑崩了 —— 注入生效且撞到东西，算拦住）')
        else:
            print(f'      失败 {nfail} 条' + (f'，命中：「{hit[0][:88]}」' if hit else '（没有一条命中预期断言！）'))
        print(f'      还原 {"md5 一致" if restored else "!!! md5 不一致 !!!"}')
        if not restored:
            print('      备份**留着**（不删）—— 先人工比对修复，再重跑')
            return 4

    # 全部还原且 md5 一致 ⇒ 才删备份（只删 3 份，见开头那段说明）
    for p in files:
        os.remove(p + BAK)

    print()
    print(f'=== {len(PROBES) - bad}/{len(PROBES)} 全部拦住 ===' if not bad
          else f'=== 有 {bad} 个探针没拦住，断言存在假绿 ===')
    return 0 if not bad else 1


if __name__ == '__main__':
    sys.exit(main())
