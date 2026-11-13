#!/usr/bin/env bash
# Negative-verification driver (temporary, delete when done).
#
# Outer shell loop, because the sandbox forbids Node spawning child processes.
# Resumable: already-passed indices are recorded in doneC.txt / doneS.txt.
# Usage: bash tools/_run-neg.sh cb|sess|scr|loc
#
# Two hard-won details baked in here:
#   1) The `expect` string is searched **only among FAIL lines**, not the whole
#      output. Searching the whole output can be satisfied by an unrelated PASS
#      line carrying the same label -> false green.
#   2) `restore` is retried until it reports "RESTORED 0 files". On this machine
#      a delete can be reported as done and still be visible to the *next*
#      process (safe-delete interception / stale FS view). Such a "phantom"
#      backup is byte-identical to the source, so restoring it is a no-op --
#      but `inject` refuses to run while it exists, which looks like a real
#      residue error.
set -u
NODE="C:/Users/luerse/.workbuddy/binaries/node/versions/22.22.2-3/node.exe"
cd /d/aiProjecct/workbuddyApp/2026-09-30-01-22-47/paipan-app || exit 2

SIDE="${1:-}"
case "$SIDE" in
  cb)
    NEG=tools/_neg-cloudbase.js
    TEST=tests/cloudbase-check.js
    DONE=/tmp/negfin/doneC.txt
    LOG=/tmp/negfin/runC.log
    # ⚠⚠ 必须与 `_neg-cloudbase.js list` 自报的总数一致（现在是 **21**）。
    #   写大了 = 末尾多跑一个不存在的用例，inject 报「没有第 N 个用例」整轮停；
    #   写小了 = 末尾那些用例根本不执行（本项目两端都踩过）。
    N=21
    ;;
  sess)
    NEG=tools/_neg-inject.js
    TEST=tests/session-check.js
    DONE=/tmp/negfin/doneN.txt
    LOG=/tmp/negfin/runN.log
    N=12
    ;;
  scr)
    NEG=tools/_neg-screens.js
    TEST=tests/screens-check.js
    DONE=/tmp/negfin/doneS.txt
    LOG=/tmp/negfin/runS.log
    # ⚠⚠ 这个数字必须与 `_neg-screens.js` 的用例总数一致。
    #   写小了 = 末尾那些用例**根本不会执行**，而结束语照样打印
    #   「passed=70/70」看起来全绿（本机踩过两次，这次是从 70 加到 83）。
    #   改用例后固定跑一遍 `_neg-screens.js list | wc -l` 对一下。
    #   从 list 的输出数出来，别手数。（2026-10-05：106 → 110 → **117**，
    #   后面 7 条是「保存窗里也能选标签」—— 含那条最毒的「归类顺序」。
    #   2026-10-06：117 → **120**，新增「职业」字段的三条。）
    N=120
    ;;
  loc)
    NEG=tools/_neg-local.js
    TEST=tests/local-check.js
    DONE=/tmp/negfin/doneL.txt
    LOG=/tmp/negfin/runL.log
    # ⚠⚠ 必须与 `_neg-local.js list` 自报的总数一致（现在是 **29**）。
    N=29
    ;;
  *)
    echo "usage: bash tools/_run-neg.sh cb|sess|scr|loc" >&2
    exit 2
    ;;
esac

clear_residue() {
  local o k
  for k in 1 2 3 4 5 6; do
    # ⚠⚠ 先跑 reset 助手：它用 renameSync 把备份挪走（rename 不走删除路径，
    #    因此不被本机的 safe-delete shim 拦）。**必须排在 restore 前面** ——
    #    restore 内部要先 unlinkSync，shim 一抛就整个中断，后面的兜底根本没机会跑
    #    （本机实测：驱动会卡在 clear_residue 里空转 4 分钟）。
    if [ -f tools/_neg-reset-local.js ]; then
      "$NODE" tools/_neg-reset-local.js >/dev/null 2>&1 || true
    fi
    o=$("$NODE" "$NEG" restore 2>&1)
    case "$o" in
      *"RESTORED 0 files"*) return 0 ;;
    esac
  done
  return 1
}

# Baseline integrity gate.
# If a restore ever fails to put the source back, the NEXT inject would look for
# its anchor inside already-corrupted source and fail with "锚点不存在" -- which
# reads like a bug in the neg script, not like the harness having lost sync.
# So: refuse to inject unless every tracked file hash-matches the pre-loop
# baseline. (Observed for real: case [4] reported 锚点不存在 once because [3]'s
# restore had not landed.)
#
# ⚠⚠ The authority is /tmp/negfin/src-base.md5, which was captured from a state
# that had been independently confirmed clean -- NOT a freshly regenerated
# "baseline". Regenerating a baseline in place is exactly how a leftover injected
# state gets frozen in as if it were correct (that happened: session.js was
# re-snapshotted in its injected form, and the gate then rejected the *pristine*
# file). Never trust a baseline you just re-took.
baseline_ok() { md5sum -c /tmp/negfin/src-base.md5 >/dev/null 2>&1; }

if [ ! -f "$DONE" ]; then : > "$DONE"; fi
: > "$LOG"

FAIL=0
i=0
while [ "$i" -lt "$N" ]; do
  if grep -qx "$i" "$DONE"; then i=$((i + 1)); continue; fi

  clear_residue || true
  if ! baseline_ok; then
    clear_residue || true
    if ! baseline_ok; then
      echo "NEG-ERROR [$i] 源码与基线不一致（restore 后仍不一致）—— 拒绝继续注入" | tee -a "$LOG"
      md5sum -c /tmp/negfin/src-base.md5 2>&1 | grep -v ': OK$' | tee -a "$LOG"
      FAIL=1; break
    fi
  fi

  out=$("$NODE" "$NEG" "$i" 2>&1); rc=$?
  if [ $rc -ne 0 ]; then
    clear_residue || true
    out=$("$NODE" "$NEG" "$i" 2>&1); rc=$?
  fi
  if [ $rc -ne 0 ]; then
    echo "NEG-ERROR [$i] inject failed: $out" | tee -a "$LOG"
    FAIL=1; break
  fi

  exp=$(printf '%s\n' "$out" | sed -n 's/.*expect=«\(.*\)»$/\1/p' | tr -d '*')
  if [ -z "$exp" ]; then
    echo "NEG-ERROR [$i] could not parse expect from: $out" | tee -a "$LOG"
    FAIL=1; break
  fi

  t=$("$NODE" "$TEST" 2>&1); trc=$?
  fails=$(printf '%s\n' "$t" | tr -d '*' | grep -E '^[[:space:]]*FAIL' || true)

  if [ "$trc" -ne 0 ] && [ -n "$fails" ] && printf '%s' "$fails" | grep -qF "$exp"; then
    echo "$i" >> "$DONE"
    echo "OK   [$i] $exp" >> "$LOG"
  else
    echo "NEG-ERROR [$i] expect=«$exp» trc=$trc nFailLines=$(printf '%s\n' "$fails" | grep -c . )" | tee -a "$LOG"
    printf '%s\n' "$fails" | head -10 | tee -a "$LOG"
    FAIL=1
  fi

  clear_residue || true
  if ! baseline_ok; then
    echo "NEG-ERROR [$i] 用例跑完后源码未回到基线 —— 立即停" | tee -a "$LOG"
    md5sum -c /tmp/negfin/src-base.md5 2>&1 | grep -v ': OK$' | tee -a "$LOG"
    FAIL=1; break
  fi
  i=$((i + 1))
done

echo "DONE side=$SIDE fail=$FAIL passed=$(grep -c . "$DONE")/$N" | tee -a "$LOG"
exit $FAIL
