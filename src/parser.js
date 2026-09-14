// ==================== 纯函数解析核心(无 DOM / 无存储依赖) ====================
// 职责:任意格式文本 → 标准题目对象;答案规范化;判分指纹。
// 允许依赖:无。禁止:document / localStorage / state。

export const OPTION_LINE_RE = /^\s*([A-Ha-h])\s*[.、:：．)）,，]\s*(.+)$/;

export const OPTION_EXPLAIN_RE = /^\s*([A-Ha-h])\s*解释\s*[:：]\s*(.+)$/;

export const QUESTION_NUM_RE = /^(\d{1,3})\s*[.、)）．]\s*(.*)$/;

export const JUDGE_QUESTION_RE = /^判断题\s*[:：]\s*(.*)$/;

export const TITLE_RE = /^#\s*(.*)$/;

// 多题库文件的分节标记。导出「导出题库」时逐库加一行:
//   # ===== 题库：甲 =====
// 兼容三种写法(老版本只写 `# 题库：甲`,用户手写可能用全角冒号/多个等号):
//   # 题库：甲 / ## 题库:甲 / ===== 题库：甲 =====
// ⚠️ 它必须**先于** TITLE_RE 判定,否则这行会被当成"一道题的标题",
//    于是所有题库的题混成一库(👤 反馈的正是这个)。
export const BANK_SECTION_RE = /^\s*#*\s*[=＝\-—]{0,8}\s*题库\s*[：:]\s*(.+?)\s*[=＝\-—]{0,8}\s*$/;

// 导出「导出题库」时用的分节标题。导出与导入**共用这一个来源** ——
// 各写各的字符串,迟早会一边改了一边没改(那时导出的文件导不回来)。
export function bankSectionHeader(name) {
    return `# ===== 题库：${name} =====`;
}

// 把整份文本按分节标记切成 [{ name, text }]。**没有标记时返回 [](保持旧的单库导入路径不变)**。
export function splitBankSections(content) {
    const lines = String(content).replace(/\r\n?/g, '\n').split('\n');
    const sections = [];
    let cur = null;
    for (const line of lines) {
        const m = line.match(BANK_SECTION_RE);
        if (m) {
            const name = m[1].trim();
            cur = { name, lines: [] };
            sections.push(cur);
            continue;
        }
        if (cur) cur.lines.push(line);
        // 标记之前的内容**丢弃**:那只能是文件头注释之类的噪音
    }
    return sections
        .filter(s => s.name)
        .map(s => ({ name: s.name, text: s.lines.join('\n') }));
}

// "(AI 生成)" 后缀:导出时给 AI 拟的答案/解析加的来源标记(P1-1.5),
// 解析器必须认它,否则"导出 → 再导入"会丢答案/解析(自己写的格式自己读不回 = 数据损失)。
// 捕获组 2 = 'AI 生成' 或 undefined,用于把来源标记一起带回来。
export const ANALYSIS_RE = /^(?:答案解析|解析)(?:\((AI 生成)\))?\s*[:：]\s*(.+)$/;

export const EXPLAIN_RE = /^(?:题目解释|题干解释)\s*[:：]\s*(.+)$/;

export const TYPE_RE = /^(?:类型|题型)\s*[:：]\s*(.+)$/;

export const QUESTION_FIELD_RE = /^题目\s*[:：]\s*(.*)$/;

export const FULL_ANSWER_RE = /^(?:【?参考答案】?|【?标准答案】?|【?正确答案】?|【?答案】?|答案)(?:\((AI 生成)\))?\s*[:：]\s*(.+?)\s*[。.]?$/;

export const FULL_ANSWER_SPACED_RE = /^(?:【?参考答案】?|【?标准答案】?|【?正确答案】?|【?答案】?|答案)\s+((?:[A-Ha-h√×对错]+)(?:[\s、,，]+[A-Ha-h√×对错]+)*)\s*[。.]?$/;

export const INLINE_ANSWER_RE = /(^|[\s(（,，;；。？！：、])(?:【?参考答案】?|【?标准答案】?|【?正确答案】?|【?答案】?|答案)\s*[:：]?\s*((?:正确|错误)|[A-Ha-h√×对错](?:[\s、,，]*[A-Ha-h√×对错])*)\s*[。.]?\s*$/;

export const JUDGE_TRUE_RE = /^(对|正确|√|T|Y)$/i;

export const JUDGE_FALSE_RE = /^(错|错误|×|X|F|N)$/i;


// 整行答案（必须带冒号，避免把普通句子误判成答案行）
// 空格分隔的纯答案行，如"答案 A" / "参考答案 B"
// 行尾行内答案（家族C），要求"答案"前是行首、空白或中文标点，避免误伤选项文字
// 分组1=前导字符(裁剪时保留),分组2=答案内容（支持多字母，如"答案：AB"）
// 拆分行内选项："题干 A.xx B.yy C.zz D.ww" → { stem, options }
// 要求至少两个选项且连续编号，避免把题干中"A、B两类"这类文字误拆
// startFromAny=true 用于"选项行的续行"(如双行布局第二行 "C.xx D.yy"):
//   起始字母不必是 A,但仍须连续,防误拆
export function splitInlineOptions(text, { startFromAny = false } = {}) {
    // 分组1=前导字符(题干裁剪时保留),分组2=选项字母
    // 分隔符含全/半角逗号(与 OPTION_LINE_RE 一致)——真实语料存在 "C.xxx D,yyy" 混排布局
    // ⚠️ 分隔符里**必须有 CJK 汉字**:PDF 抽出来的卷子常常两个选项首尾相接
    //(原版式是两栏,A 列文字正好接到 B 列),既没有空格也没有标点 ——
    // 只有把它们当成分隔才能切出 4 个选项(👤 的真文件就是这样)。
    // 安全性由后面的两条校验兜着:必须从 A 开始、必须连续(A/B/C/D)。
    const re = /(^|[\s(（,，;；。？！：、…""''「」『』（）【】《》<>\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])\s*([A-Ha-h])\s*[.、:：．)）,，,]\s*/g;
    const markers = [];
    let m;
    while ((m = re.exec(text)) !== null) {
        markers.push({
            key: m[2].toUpperCase(),
            stemEnd: m.index + m[1].length,
            textStart: re.lastIndex,
        });
    }
    if (markers.length < 2) return null;
    if (!startFromAny && markers[0].key !== 'A') return null;
    for (let i = 0; i < markers.length; i++) {
        if (markers[i].key !== String.fromCharCode(markers[0].key.charCodeAt(0) + i)) return null;
    }
    const options = {};
    markers.forEach((mk, i) => {
        const end = i + 1 < markers.length ? markers[i + 1].stemEnd : text.length;
        options[mk.key] = text.slice(mk.textStart, end).replace(/\s+/g, ' ').trim();
    });
    const stem = text.slice(0, markers[0].stemEnd).replace(/\s+/g, ' ').trim();
    return { stem, options };
}

// 题末括号内嵌答案："（x ）"/"（B）"/"（ABD）" → 提取为答案(仅当无显式答案行时)。
// 只认"纯答案 token"的括号且必须位于题干末尾;括号前不得是字母/数字,防"计算f（x）"误判
// 注意:判断题的 x/X 不在 [A-Ha-h] 内(a-h 不含 x),须单列
const EMBEDDED_ANSWER_RE = /([^A-Za-z0-9])[（(]\s*([A-Ha-h]{1,4}|√|×|对|错|正确|错误|T|F|Y|N|[xX])\s*[)）]\s*[。.]?\s*$/;
// 空答题括号"（）"/"(  )":题末形态用于判断语境推断,全部形态按噪音清除
const EMPTY_PAREN_AT_END_RE = /[（(]\s*[)）]\s*[。.]?\s*$/;
const EMPTY_PAREN_RE = /[（(]\s*[)）]/g;
// 判卷痕迹 token:出现即说明本批材料使用"只标错、不标对"的判卷惯例
const JUDGE_TOKEN_RE = /^(?:√|×|对|错|正确|错误|T|F|Y|N|[xX])$/;

// 题型/答案/选项的最终规范化（导入与预览提交时都会调用，幂等）
export function finalizeQuestion(q) {
    q.title = (q.title || '').trim();
    q.content = (q.content || '').trim();
    q.analysis = (q.analysis || '').trim();
    q.explanation = (q.explanation || '').trim();
    const hint = (q.type || '').replace(/题$/, '');
    if (!q.answer) {
        const em = q.content.match(EMBEDDED_ANSWER_RE);
        if (em) {
            q.answer = em[2];
            if (JUDGE_TOKEN_RE.test(em[2])) q._parenJudge = true; // 判卷痕迹,供批内空括号推断
            q.content = q.content.slice(0, em.index + 1).trimEnd();
        } else if (EMPTY_PAREN_AT_END_RE.test(q.content)) {
            q._hadEmptyParen = true;
            // 显式标注"判断题:"的题,空括号按惯例兜底为对
            if (hint === '判断') q.answer = '对';
        }
    }
    q.content = q.content.replace(EMPTY_PAREN_RE, '').replace(/\s+$/g, '').trim();
    const rawAnswer = (q.answer || '').toUpperCase().replace(/\s+/g, '');

    const isJudge = hint === '判断' || JUDGE_TRUE_RE.test(rawAnswer) || JUDGE_FALSE_RE.test(rawAnswer);

    if (isJudge) {
        q.type = '判断';
        const meaningful = Object.values(q.options).some(v => v && v.length > 2);
        if (!meaningful) {
            // 统一选项为 A正确 / B错误，保证刷题界面与判分一致
            q.options = { A: '正确', B: '错误' };
        }
        if (JUDGE_TRUE_RE.test(rawAnswer)) q.answer = 'A';
        else if (JUDGE_FALSE_RE.test(rawAnswer)) q.answer = 'B';
        else if (/^[AB]$/.test(rawAnswer)) q.answer = rawAnswer;
        else q.answer = '';
    } else {
        q.answer = rawAnswer.replace(/[^A-H]/g, '');
        // 题型按答案长度推导。两种情形要区分:
        //  · 导入路径:材料里的「类型:多选」只是**提示**,与答案矛盾时以答案为准(判分自洽)——
        //    见 import-pipeline 的『类型提示与答案矛盾时以答案推断为准』。
        //  · 编辑器保存:用户在表单里**亲手选**的类型是明确意图,单字母答案不该把它改掉
        //    (多选题只有一个正确项是合法形态)。由 editorSaveCurrent 打 `_typeExplicit` 标记区分。
        // 反向必须纠正:答案是多字母时一定是多选,否则刷题按单选渲染会永远判不对。
        q.type = q.answer.length > 1
            ? '多选'
            : (q._typeExplicit && q.type === '多选' ? '多选' : '单选');
        delete q._typeExplicit;   // 内部标记不落库
    }

    // 置信度：预览时用于提示"需要人工看一眼"的题
    let conf = 1.0;
    const optCount = Object.keys(q.options).length;
    if (!q.answer) conf -= 0.5;
    if (optCount === 0) conf -= 0.4;
    else if (optCount < 2) conf -= 0.3;
    if (!q.analysis) conf -= 0.1;
    q.confidence = Math.max(0, Math.min(1, conf));
    q.raw = Array.isArray(q.raw) ? q.raw.join('\n') : (q.raw || '');

    // 来源标注(0.11.0 AI 双模式地基):记录答案/解析是谁给的。
    normalizeSourceField(q, 'answerSource');
    normalizeSourceField(q, 'analysisSource');

    if (!q.content) return null; // 没有题干的散行直接丢弃
    return q;
}

// 来源标注标准化:'ai'(🤖 AI 生成,未经权威核验)/ 'manual'(人工录入即已核验)/ null(材料原文,缺省)。
// 关键约束:仅当调用方已显式带该键时才写回,因此导入材料这条老路径不会凭空多出新键
// (旧数据无此字段 → 字段缺失,语义等价于 null;不触发数据格式迁移)。
function normalizeSourceField(q, key) {
    if (!(key in q)) return;
    q[key] = q[key] === 'ai' || q[key] === 'manual' ? q[key] : null;
}

// 展示用答案文案:判断题显示「对/错」而不是 A/B(👤 反馈:错题本/结果页显示 A/B 没意义)。
// 判断题在数据层统一存 A/B(见 finalizeQuestion,保证判分一致),只在**展示时**映射回对错。
// 非判断题返回原答案字母;带选项文本时附带选项内容,便于「缺选项」的错题/收藏条目仍看得懂。
// ⚠️ 这是**唯一**的答案展示入口:新增展示位必须走它,不要直接拼接 question.answer。
export function formatAnswerForDisplay(answer, question) {
    const a = String(answer == null ? '' : answer).trim();
    if (!a) return '';
    const q = question || {};
    if (q.type === '判断') return a === 'A' ? '对' : a === 'B' ? '错' : a;
    const opts = q.options || {};
    const text = (opts[a] || '').trim();
    // 只有"真实选项文本"才附加(过短的占位文本只会制造噪声)
    return text.length > 2 ? `${a}. ${text}` : a;
}

// 查重指纹：题干（去空白）+ 全部选项文本。同一题重新导入（即使改了答案）会被识别为重复；
// 题干相同但选项不同的题（如"下列说法正确的是()"）不会被误判
export function questionDedupKey(q) {
    const stem = (q.content || '').replace(/\s+/g, '');
    const opts = Object.keys(q.options || {}).sort()
        .map(k => k + ':' + (q.options[k] || '').replace(/\s+/g, ''))
        .join('');
    return stem + '|' + opts;
}

// 文末答案表整行判定:可选"答案:"头 + 一串 题号.答案 对,必须吃满整行
// ("1.B 超检查…"这类真题干因吃不满而被排除,防"B超"误伤)
// 支持变体:答案 token 可被【】包裹;对错判卷题;字母含 x(判断标记)
export const ANSWER_LINE_RE = /^(?:【?(?:参考|标准|正确)?答案】?\s*[:：]?\s*)?\d{1,3}\s*[.、:：]?\s*【?\s*(?:[A-Ha-h√×xX]{1,4}|对|错|正确|错误)\s*】?(?:[\s,，、;；.。]+\d{1,3}\s*[.、:：]?\s*【?\s*(?:[A-Ha-h√×xX]{1,4}|对|错|正确|错误)\s*】?)*\s*[。.]?\s*$/;
const ANSWER_RANGE_RE = /^(?:【?(?:参考|标准|正确)?答案】?\s*[:：]?\s*)?(\d{1,3})\s*[-—–~至]\s*(\d{1,3})\s*[:：]?\s*【?\s*([A-Ha-h√×xX]{2,40})\s*】?\s*$/;
const ANSWER_HEADER_RE = /^\s*【?(?:参考|标准|正确)?答案】?\s*[:：]?\s*$/;

// 自文档底部收集连续答案行 → {num: answer} 映射,并剥离这些行(含"参考答案:"头行)
// 映射按题号回填;若文档题号有重号(多套题各自从头编号)映射可能歧义,由预览人工确认兜底
export function extractAnswerSheet(lines) {
    const map = new Map();
    let blockStart = lines.length;
    let i = lines.length - 1;
    while (i >= 0) {
        const line = lines[i].trim();
        if (!line) { i--; continue; } // 块内允许空行
        const rangeM = line.match(ANSWER_RANGE_RE);
        if (rangeM) {
            const from = parseInt(rangeM[1], 10), to = parseInt(rangeM[2], 10);
            const seq = rangeM[3].split('');
            if (to >= from && to - from < 100) {
                for (let n = from; n <= to; n++) {
                    const a = seq[n - from];
                    if (a) map.set(n, a);
                }
                blockStart = i; i--; continue;
            }
            break;
        }
        if (ANSWER_LINE_RE.test(line)) {
            const pairRe = /(\d{1,3})\s*[.、:：]?\s*【?\s*([A-Ha-h√×xX]{1,4}|对|错|正确|错误)\s*】?/g;
            let pm;
            while ((pm = pairRe.exec(line)) !== null) map.set(parseInt(pm[1], 10), pm[2]);
            blockStart = i; i--; continue;
        }
        if (ANSWER_HEADER_RE.test(line)) {
            if (map.size > 0) { blockStart = i; i--; continue; } // 头行下确有答案对才并入
            break;
        }
        break;
    }
    if (map.size < 2) return { map: new Map(), lines }; // 少于 2 个答案不像答案表,保守放弃
    return { map, lines: lines.slice(0, blockStart) };
}

// 主解析器：逐行状态机，同时覆盖家族 A/B/C/D
export function parseQuestionsText(content) {
    const questions = [];
    const rawLines = String(content).replace(/\r\n?/g, '\n').split('\n');
    const { map: sheetMap, lines } = extractAnswerSheet(rawLines);
    let cur = null;

    const newQuestion = () => {
        cur = {
            title: '', content: '', explanation: '', options: {}, optionExplanations: {},
            answer: '', analysis: '', type: '', confidence: 1.0, raw: [], num: null
        };
    };
    const flush = () => {
        if (!cur) return;
        // 文末答案表按题号回填(在 finalize 之前,保证题型/置信度正确)
        if (!cur.answer && cur.num != null && sheetMap.has(cur.num)) {
            cur.answer = sheetMap.get(cur.num);
        }
        questions.push(cur);
        cur = null;
    };

    for (const rawLine of lines) {
        const line = rawLine.replace(/\s+$/, '').trim();
        if (!line) continue;

        // 1. "# 标题" → 新题开始
        const titleM = line.match(TITLE_RE);
        if (titleM) {
            flush();
            newQuestion();
            cur.title = titleM[1].trim();
            cur.raw.push(rawLine);
            continue;
        }

        // 2. 剥离行尾行内答案（家族C："…… 答案：B"）
        let body = line;
        let inlineAnswer = null;
        const ansM = body.match(INLINE_ANSWER_RE);
        if (ansM) {
            inlineAnswer = ansM[2];
            // 裁剪时保留前导字符（如"？"），避免题干丢失标点
            body = body.slice(0, ansM.index + ansM[1].length).trim();
        }

        // 3. 字段行（顺序重要：题目解释/解析 必须先于 题目/答案 判断）
        const explainM = body.match(EXPLAIN_RE);
        if (explainM) {
            if (!cur) newQuestion();
            cur.explanation = explainM[1].trim();
            cur.raw.push(rawLine);
            continue;
        }
        const analysisM = body.match(ANALYSIS_RE);
        if (analysisM) {
            if (!cur) newQuestion();
            cur.analysis = analysisM[2].trim();
            if (analysisM[1]) cur.analysisSource = 'ai';   // 导出标记带回来的来源
            cur.raw.push(rawLine);
            continue;
        }
        const typeM = body.match(TYPE_RE);
        if (typeM) {
            if (!cur) newQuestion();
            cur.type = typeM[1].trim();
            cur.raw.push(rawLine);
            continue;
        }
        const fieldM = body.match(QUESTION_FIELD_RE);
        if (fieldM) {
            if (cur && cur.content) flush(); // 家族A连续两题之间靠"题目："分隔
            if (!cur) newQuestion();
            cur.content = fieldM[1].trim();
            if (inlineAnswer) cur.answer = inlineAnswer;
            cur.raw.push(rawLine);
            continue;
        }

        // 3.5 整行答案
        // ⚠️ 注意 FULL_ANSWER_RE 的组序:(组1)= 可选的 "(AI 生成)" 标记,(组2)= 答案本体;
        //    而 FULL_ANSWER_SPACED_RE 没有那个可选组,答案仍是一个组 —— 故按正则分别取值。
        const fullAnsM = body.match(FULL_ANSWER_RE);
        const fullAnsSpacedM = fullAnsM ? null : body.match(FULL_ANSWER_SPACED_RE);
        if (fullAnsM || fullAnsSpacedM) {
            if (!cur) newQuestion();
            cur.answer = (fullAnsM ? fullAnsM[2] : fullAnsSpacedM[1]).trim();
            // 导出文件里的 "(AI 生成)" 来源标记要带回来,否则导出再导入会丢掉 AI 标注
            if (fullAnsM && fullAnsM[1]) cur.answerSource = 'ai';
            cur.raw.push(rawLine);
            continue;
        }

        // 4. "1. 题干"编号行 → 新题（家族B/C）
        const numM = body.match(QUESTION_NUM_RE);
        if (numM) {
            const afterNum = numM[2].trim();
            const split = splitInlineOptions(afterNum);
            flush();
            newQuestion();
            cur.raw.push(rawLine);
            cur.num = parseInt(numM[1], 10); // 供文末答案表按题号回填
            if (split) {
                cur.content = split.stem;   // 家族C：题干 + 行内选项
                cur.options = split.options;
            } else {
                cur.content = afterNum;     // 家族B：仅题干，选项在后续行
            }
            if (inlineAnswer) cur.answer = inlineAnswer;
            continue;
        }

        // 5. "判断题：xxx" 开头
        const judgeM = body.match(JUDGE_QUESTION_RE);
        if (judgeM) {
            flush();
            newQuestion();
            cur.raw.push(rawLine);
            cur.content = judgeM[1].trim();
            cur.type = '判断';
            if (inlineAnswer) cur.answer = inlineAnswer;
            continue;
        }

        // 6. 选项解释行（A解释：xxx）
        const opExM = body.match(OPTION_EXPLAIN_RE);
        if (opExM) {
            if (!cur) newQuestion();
            cur.optionExplanations[opExM[1].toUpperCase()] = opExM[2].trim();
            cur.raw.push(rawLine);
            continue;
        }

        // 7. 选项行（A. xxx / A：xxx / A、xxx）
        const opM = body.match(OPTION_LINE_RE);
        if (opM) {
            if (!cur) newQuestion();
            // 选项行内还跟着更多选项时（如"A. 21 B.80 C.443 D.22"），按行内选项拆分;
            // startFromAny 兼容双行布局的第二行（"C.xx D.yy"）,否则 D 会被吞进 C
            const lineSplit = splitInlineOptions(body, { startFromAny: true });
            if (lineSplit && Object.keys(lineSplit.options).length > 1) {
                Object.assign(cur.options, lineSplit.options);
                if (!cur.content && lineSplit.stem) cur.content = lineSplit.stem;
            } else {
                cur.options[opM[1].toUpperCase()] = opM[2].trim();
            }
            if (inlineAnswer) cur.answer = inlineAnswer;
            cur.raw.push(rawLine);
            continue;
        }

        // 7.5 空格分隔选项行:"A 盗窃罪"(字母后无标点,仅空格)。
        // 须已有题干且字母接续上一选项,防"A 股行情"这类题干续行误判
        if (cur && cur.content) {
            const spM = body.match(/^([A-Ha-h])\s+([^\s].*)$/);
            if (spM) {
                const letter = spM[1].toUpperCase();
                const keys = Object.keys(cur.options);
                const expected = keys.length === 0 ? 'A' : String.fromCharCode(keys[keys.length - 1].charCodeAt(0) + 1);
                if (letter === expected) {
                    const normalized = letter + '. ' + spM[2].trim();
                    const lineSplit = splitInlineOptions(normalized, { startFromAny: true });
                    if (lineSplit && Object.keys(lineSplit.options).length > 1) {
                        Object.assign(cur.options, lineSplit.options);
                    } else {
                        cur.options[letter] = spM[2].trim();
                    }
                    if (inlineAnswer) cur.answer = inlineAnswer;
                    cur.raw.push(rawLine);
                    continue;
                }
            }
        }

        // 8. 整行就是答案（行内答案剥离后 body 为空）
        if (inlineAnswer) {
            if (!cur) newQuestion();
            cur.answer = inlineAnswer;
            cur.raw.push(rawLine);
            continue;
        }

        // 9. 其他 → 续行。选项已开始 → 折行归并进最后一个选项(不污染题干);
        //    题干续行(含行内选项的也支持);没有当前题的散行丢弃
        if (cur) {
            const contSplit = splitInlineOptions(line);
            if (contSplit && Object.keys(contSplit.options).length > 1) {
                // 续行形如"其中正确的是 A. 21 B.80 C.443 D.22"
                Object.assign(cur.options, contSplit.options);
                if (contSplit.stem) {
                    cur.content = cur.content ? cur.content + '\n' + contSplit.stem : contSplit.stem;
                }
            } else if (Object.keys(cur.options).length > 0 && cur.content) {
                const lastKey = Object.keys(cur.options).pop();
                const prev = cur.options[lastKey];
                // CJK 相邻直接拼接,西文/数字接半角空格
                const glue = (/[\u4e00-\u9fff。）)”》】%]$/.test(prev) || /^[\u4e00-\u9fff（(“《【]/.test(line)) ? '' : ' ';
                cur.options[lastKey] = prev + glue + line;
            } else if (cur.content) {
                cur.content += '\n' + line;
            } else if (!cur.answer && Object.keys(cur.options).length === 0) {
                cur.content = line;
            }
            cur.raw.push(rawLine);
        }
    }
    flush();
    // 第一遍 finalize:提取括号答案、清除空括号、打判卷痕迹/空括号标记
    const finalized = [];
    for (const q of questions) {
        const fq = finalizeQuestion(q);
        if (fq) finalized.push(fq);
    }
    // 判断语境推断:批内存在括号判卷痕迹(（x）/（√）等)说明材料遵循"只标错、不标对"惯例,
    // 此时空括号且无选项的题视为对;选择题与无痕迹批次不脑补(如实缺答案进预览)
    if (finalized.some(q => q._parenJudge)) {
        for (const q of finalized) {
            if (q._hadEmptyParen && !q.answer && Object.keys(q.options).length === 0) {
                q.answer = '对';
                finalizeQuestion(q); // 原地重算题型/选项/置信度(幂等)
            }
        }
    }
    for (const q of finalized) {
        delete q._parenJudge;
        delete q._hadEmptyParen;
    }
    return finalized;
}

// 规范化选项答案：统一大写、只保留选项字母、去重并排序（用于判分比较，
// 避免"CA"vs"AC"、"A、B"vs"AB"这类写法差异导致误判）
export function normalizeAnswerString(answer) {
    return (answer || '')
        .toUpperCase()
        .replace(/[^A-H]/g, '')
        .split('')
        .filter((ch, idx, arr) => arr.indexOf(ch) === idx)
        .sort()
        .join('');
}

// 打乱数组
export function shuffleArray(array) {
    const newArray = [...array];
    for (let i = newArray.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [newArray[i], newArray[j]] = [newArray[j], newArray[i]];
    }
    return newArray;
}

// ==================== 答题卡(刷题中快速跳题,P0-6.1)====================
// 「一题一格」的数据:**纯函数**(不读 DOM、不读全局 state),谁调用谁传状态 —— 于是能脱离浏览器直接断言。
// 四态定义(👤 定调):
//   blank   = 没做过
//   picked  = **套题模式专用**:选了但还没交卷 —— 只显示"选过了",绝不显示对错
//   correct = 判过分且答对
//   wrong   = 判过分且答错
// ⚠️ **套题模式交卷前不得出现 correct/wrong**(👤 报的 bug):
//    套题是"整卷一次判分",交卷前用户仍可回改,却把对错标在卡上 = 直接泄题。
//    故判分事实由调用方决定(`graded` 映射在套题交卷前恒为空),
//    本函数再对"选了但未判分"给出中性的 picked 态。
// graded:index → bool 的"是否已判分"映射(逐题模式来自 q_graded;套题模式交卷后才全为真)
// ⚠️ 刻意**不输出题干与答案**:答题卡只暴露"做没做、对不对、什么题型",防止跳题前偷看答案。
export const CARD_TYPE_SHORT = { 单选: '单', 多选: '多', 判断: '判' };

export function buildCardCells(questions, userAnswers = [], graded = {}, currentIndex = 0) {
    const list = Array.isArray(questions) ? questions : [];
    const cells = list.map((question, index) => {
        const q = question || {};
        const userAnswer = userAnswers[index] || '';
        const isGraded = !!graded[index];
        const isCorrect = isGraded && !!userAnswer
            && normalizeAnswerString(userAnswer) === normalizeAnswerString(q.answer || '');
        const status = isGraded ? (isCorrect ? 'correct' : 'wrong') : (userAnswer ? 'picked' : 'blank');
        return {
            index,
            number: index + 1,
            type: q.type || '',
            typeShort: CARD_TYPE_SHORT[q.type] || '',
            status,
            current: index === currentIndex,
        };
    });

    return {
        cells,
        summary: {
            total: cells.length,
            correct: cells.filter(c => c.status === 'correct').length,
            wrong: cells.filter(c => c.status === 'wrong').length,
            blank: cells.filter(c => c.status === 'blank').length,
            picked: cells.filter(c => c.status === 'picked').length,
        },
    };
}

// 格式化题目用于导出
export function formatQuestionsForExport(questions) {
    return questions.map(q => {
        let text = '';
        if (q.title) text += `# ${q.title}\n`;
        text += `题目：${q.content}\n`;

        Object.keys(q.options || {}).sort().forEach(key => {
            text += `${key}：${q.options[key]}\n`;
        });

        // AI 生成的字段必须在导出文件里**明示来源**(P1-1.5):否则这份 txt 二次传播出去,
        // 别人会把它当成"原始题库",AI 拟答就被当成权威答案了。
        text += `${q.answerSource === 'ai' ? '答案(AI 生成)' : '答案'}：${q.answer}\n`;

        if (q.explanation) text += `题目解释：${q.explanation}\n`;
        if (q.analysis) text += `${q.analysisSource === 'ai' ? '解析(AI 生成)' : '解析'}：${q.analysis}\n`;
        if (q.type) text += `类型：${q.type}\n`;

        Object.keys(q.optionExplanations || {}).sort().forEach(key => {
            text += `${key}解释：${q.optionExplanations[key]}\n`;
        });

        return text;
    }).join('\n');
}
