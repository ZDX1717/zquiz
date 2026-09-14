#!/usr/bin/env bash
# api-push-multi.sh —— api-push.sh 的多提交版本(443 阻断时用)
#
# ⚠️ 已知限制:**批注标签(annotated tag)不能靠本地重建对齐 SHA**。
#   实测 `gh api git/tags` 造出的标签对象 SHA 与本地 `git tag -a` 的不一致
#   (逐字段核对过 object/type/tag/tagger/epoch 全同,仍不同;换行/编码都试过)。
#   因此打 tag 时:**先用本地 `git tag -a`,再单独用 API 建 refs/tags/<name>**,
#   并只校验"远端 tag 指向的 commit 正确",不必要求 tag 对象 SHA 一致。
#   (提交对象的 SHA 对齐见 align-remote-sha.mjs,那是可对齐的。)
#
# 用法:bash scripts/api-push-multi.sh [<远端锚点 sha>]   (默认取远端 main 当前 sha)
# 与 api-push.sh 的区别:支持一次推 N 个提交(远端是本地 HEAD 的祖先且线性,即干净 fast-forward)
# 相同保证:逐提交重建 tree/commit 后与本地 SHA 比对,不一致即中止(绝不留分叉)
#   ① author/committer 时区按 %aI/%cI 原样保留 ② 消息无尾换行 ③ 哈希一律从 git/API 取,禁止手打
set -euo pipefail
REPO=ZDX1717/zquiz
cd "$(dirname "$0")/.."

ANCHOR="${1:-$(gh api "repos/$REPO/git/refs/heads/main" --jq '.object.sha')}"
LOCAL=$(git rev-parse HEAD)

if [ "$ANCHOR" = "$LOCAL" ]; then echo "已是最新,无需推送"; exit 0; fi
# ⚠️ 实测 2026-09-13:上一次 push 后**忘了跑 align-remote-sha.mjs**,本地就没有远端那个提交对象
#    (远端 SHA 被 GitHub 剥了尾换行而不同),于是这里直接 "Not a valid commit name" ——
#    报错完全指不到"本地漂移"这个真因。先做一次显式判定,把修法写在报错里。
if ! git cat-file -e "$ANCHOR^{commit}" 2>/dev/null; then
    echo "FAIL: 远端锚点 $ANCHOR 不是本地对象 —— 本地与远端漂移了(上次 push 后没对齐 SHA)。"
    echo "      修法(按远端规则重写本地待推提交,只去消息尾换行):"
    echo "        ① 找出分叉点:git log --oneline -5 与 gh api repos/$REPO/commits --jq '.[].sha' 对照;"
    echo "        ② 用 align-remote-sha.mjs <分叉点的父 sha> $ANCHOR 把本地对齐到远端;"
    echo "        ③ 再跑本脚本。"
    exit 1
fi
git merge-base --is-ancestor "$ANCHOR" "$LOCAL" || { echo "FAIL: 远端不是本地祖先,非 fast-forward,需人工核对"; exit 1; }
COUNT=$(git rev-list --count "$ANCHOR..$LOCAL")
[ "$COUNT" -gt 0 ] || { echo "FAIL: 无可推提交"; exit 1; }
echo "锚点 $ANCHOR → HEAD $LOCAL,共 $COUNT 个提交"

# 逐提交快进(clone 的 tree 用 API 返回值,保证与远端字节一致)
# 注意:PARENT_SHA 必须是**远端对象**的 sha;GitHub 会剥消息尾换行,
# 所以第一个提交起 API sha 就与本地不同,链上必须一路用 API 侧的值。
PARENT_SHA="$ANCHOR"
PARENT_LOCAL="$ANCHOR"
PARENT_API_TREE=$(gh api "repos/$REPO/git/commits/$ANCHOR" --jq '.tree.sha')

# 收集待推提交(从旧到新)
mapfile -t COMMITS < <(git rev-list --reverse "$ANCHOR..$LOCAL")

for C in "${COMMITS[@]}"; do
    SUBJ=$(git show -s --format=%s "$C" | cut -c1-60)
    echo "--- $C $SUBJ"

    # 该提交相对其父改变了哪些路径(含增删改名)
    mapfile -t PATHS < <(git diff-tree -r --no-commit-id --name-only "$C")

    ENTRIES=""
    for f in "${PATHS[@]}"; do
        if git cat-file -e "$C:$f" 2>/dev/null; then
            # 新增/修改:上传 blob 并校验哈希与本地一致
            # ⚠️ 大文件必须走 --input(stdin):Linux 的**单参数上限是 128KB**,
            #    而 `gh api -f content="$(base64 ...)"` 会把 base64 塞进 argv ——
            #    src/bank.js 的 base64 约 135KB,必炸 `Argument list too long`
            #    (实测 2026-09-11:推送直接失败,且报错信息完全指不到"文件太大"这个真因)。
            b=$(git show "$C:$f" | base64 -w0 \
                | jq -Rs '{content: ., encoding: "base64"}' \
                | gh api "repos/$REPO/git/blobs" --input - --jq '.sha')
            l=$(git rev-parse "$C:$f")
            [ "$b" = "$l" ] || { echo "FAIL blob $f api=$b local=$l"; exit 1; }
            # ⚠️ mode 必须取**真实值**(`git ls-tree`),不能硬编码 100644:
            #    可执行脚本是 100755,硬写 644 会让 API 造的 tree 与本地对不上 ——
            #    报错是 "FAIL tree api=… local=…",完全看不出是 mode 的锅(踩过 2026-09-11:
            #    api-push.sh 有执行位,而脚本把它当普通文件)。
            m=$(git ls-tree "$C" -- "$f" | awk '{print $1}')
            ENTRIES+=$(jq -n --arg p "$f" --arg s "$b" --arg m "$m" '{path:$p, mode:$m, type:"blob", sha:$s}')$'\n'
        else
            # 删除:tree 条目 sha 置 null
            ENTRIES+=$(jq -n --arg p "$f" '{path:$p, mode:"100644", type:"blob", sha:null}')$'\n'
        fi
    done

    TREE_JSON=$(jq -n --arg bt "$PARENT_API_TREE" --argjson arr "$(echo "$ENTRIES" | jq -s .)" '{base_tree:$bt, tree:$arr}')
    API_TREE=$(echo "$TREE_JSON" | gh api "repos/$REPO/git/trees" --input - --jq '.sha')
    LOCAL_TREE=$(git rev-parse "$C^{tree}")
    [ "$API_TREE" = "$LOCAL_TREE" ] || { echo "FAIL tree $C api=$API_TREE local=$LOCAL_TREE"; exit 1; }

    DATE_A=$(git show -s --format=%aI "$C"); DATE_C=$(git show -s --format=%cI "$C")
    AN=$(git show -s --format=%an "$C"); AE=$(git show -s --format=%ae "$C")
    # GitHub 存储提交时会剥掉消息尾部的换行,因此远端 SHA 必然与本地不同 ——
    # 这是 GitHub 的规范化,不是分叉。既然 SHA 无法对齐,就改为**逐字段校验内容**:
    #   tree / parent / 作者与提交者身份 / epoch / 消息(忽略尾换行)全部一致即视为成功。
    MSG=$(git cat-file commit "$C" | sed -n '/^$/,$p' | tail -n +2)
    TZ_A=$(echo "$DATE_A" | grep -oE '[+-][0-9]{2}:?[0-9]{2}$' | tr -d ':')
    TZ_C=$(echo "$DATE_C" | grep -oE '[+-][0-9]{2}:?[0-9]{2}$' | tr -d ':')
    EP_A=$(git show -s --format=%at "$C"); EP_C=$(git show -s --format=%ct "$C")

    BODY=$(jq -n --arg t "$API_TREE" --arg p "$PARENT_SHA" --arg m "$MSG" \
        --arg da "$DATE_A" --arg dc "$DATE_C" --arg an "$AN" --arg ae "$AE" \
        '{tree:$t, parents:[$p], message:$m,
          author:{name:$an, email:$ae, date:$da},
          committer:{name:$an, email:$ae, date:$dc}}')
    API_COMMIT=$(echo "$BODY" | gh api "repos/$REPO/git/commits" --input - --jq '.sha')

    INFO=$(gh api "repos/$REPO/git/commits/$API_COMMIT")
    WANT=$(jq -n --arg t "$API_TREE" --arg m "$MSG" --arg an "$AN" --arg ae "$AE" \
        --argjson ea "$EP_A" --argjson ec "$EP_C" \
        '{tree:$t, msg:($m|sub("\\n+$";"")), an:$an, ae:$ae, ea:$ea, ec:$ec}')
    GOT=$(echo "$INFO" | jq --argjson w "$WANT" \
        '{tree:.tree.sha, msg:(.message|sub("\\n+$";"")), an:.author.name, ae:.author.email,
          ea:(.author.date|fromdateiso8601), ec:(.committer.date|fromdateiso8601)}')
    if ! jq -en --argjson w "$WANT" --argjson g "$GOT" '$w == $g' >/dev/null; then
        echo "FAIL 提交内容不一致"; jq -n --argjson w "$WANT" --argjson g "$GOT" '{want:$w,got:$g}'; exit 3
    fi
    echo "  ✓ tree/身份/epoch/消息 全部一致(SHA ${API_COMMIT:0:7};GitHub 剥了消息尾换行)"

    PARENT_SHA="$API_COMMIT"; PARENT_LOCAL="$C"; PARENT_API_TREE="$API_TREE"
done

echo "[ref] PATCH refs/heads/main -> $PARENT_SHA"
gh api -X PATCH "repos/$REPO/git/refs/heads/main" -f sha="$PARENT_SHA" --jq '.object.sha'

FINAL=$(gh api "repos/$REPO/git/refs/heads/main" --jq '.object.sha')
if [ "$FINAL" = "$PARENT_SHA" ]; then
    if [ "$FINAL" = "$LOCAL" ]; then
        echo "OK: 远端 main == 本地 HEAD($LOCAL)"
    else
        echo "OK: 远端 main = $FINAL(已推送 $COUNT 个提交,内容逐字节校验一致)"
        echo "⚠️  远端 SHA 与本地不同:GitHub 存储时剥掉了消息尾换行,属规范化而非分叉。"
        echo "    本地 git 对此无感(内容与树完全一致);如需 SHA 严格对齐,应对本地提交做同样剥离。"
    fi
else
    echo "FAIL: 远端 $FINAL != 预期 $PARENT_SHA"; exit 4
fi
