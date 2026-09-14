// 解析核心测试:真实 import,不经过 vm 桩
import test from 'node:test';
import assert from 'node:assert';
import {
    parseQuestionsText, finalizeQuestion, normalizeAnswerString, questionDedupKey, formatAnswerForDisplay,
    splitInlineOptions,
} from '../src/parser.js';

const P = (s) => parseQuestionsText(s);

test('答案规范化:大小写/分隔符/去重/排序', () => {
    assert.strictEqual(normalizeAnswerString('CA'), 'AC');
    assert.strictEqual(normalizeAnswerString('a、b'), 'AB');
    assert.strictEqual(normalizeAnswerString('AAB'), 'AB');
    assert.strictEqual(normalizeAnswerString('AC') === normalizeAnswerString('CA'), true);
    assert.strictEqual(normalizeAnswerString('b'), 'B');
});

test('家族A:字段式完整解析(解释/选项解释/解析/类型全保留)', () => {
    const qs = P(`# 单选题1
题目：福祸相依体现了（）
A：矛盾的同一性
A解释：矛盾双方相互依存
B：矛盾的斗争性
答案：A
解析：契合同一性定义
类型：单选`);
    assert.strictEqual(qs.length, 1);
    assert.strictEqual(qs[0].title, '单选题1');
    assert.strictEqual(qs[0].content, '福祸相依体现了'); // 空答题槽括号按噪音清除
    assert.strictEqual(qs[0].options.A, '矛盾的同一性');
    assert.strictEqual(qs[0].optionExplanations.A, '矛盾双方相互依存');
    assert.strictEqual(qs[0].answer, 'A');
    assert.strictEqual(qs[0].analysis, '契合同一性定义');
    assert.strictEqual(qs[0].type, '单选');
});

test('家族B:编号式逐行 + 多行题干', () => {
    const qs = P(`1. 下列哪个是编程语言？
A. Python
B. HTML
答案：A
解析：Python 是编程语言

2. 下列哪些属于前端技术？
A. HTML
B. CSS
答案：ABC`);
    assert.strictEqual(qs.length, 2);
    assert.strictEqual(qs[0].answer, 'A');
    assert.strictEqual(qs[0].type, '单选');
    assert.strictEqual(qs[1].type, '多选');
});

test('家族C:单行混排(题干+行内选项+行内答案)', () => {
    const qs = P(`1. 一年有几个月？A.10 B.11 C.12 D.13 答案：C
2. HTTPS使用的端口号是？
A. 21 B.80 C.443 D.22 答案：D`);
    assert.strictEqual(qs[0].content, '一年有几个月？');
    assert.strictEqual(qs[0].options.C, '12');
    assert.strictEqual(qs[1].options.D, '22');
    assert.strictEqual(qs[1].answer, 'D');
});

test('家族D:判断题自动配 A正确/B错误', () => {
    assert.strictEqual(P(`1. 中国的首都是北京。答案：对`)[0].answer, 'A');
    assert.strictEqual(P(`1. 地球是方的。答案：错误`)[0].answer, 'B');
    const q = P(`1. 水的化学式是H2O。答案：√`)[0];
    assert.strictEqual(q.type, '判断');
    assert.deepStrictEqual(q.options, { A: '正确', B: '错误' });
});

test('答案/解析来源标注:ai|manual 保留,非法值归 null,材料原文路径不产生新键', () => {
    const stem = '1. 测试题 A.甲 B.乙 答案：A';
    // 材料原文(旧数据形态):不得凭空多出字段 —— 字段缺失即等价 null,不触发数据格式迁移
    assert.strictEqual('answerSource' in P(stem)[0], false, '导入材料路径不应产生 answerSource 键');
    assert.strictEqual('analysisSource' in P(stem)[0], false, '导入材料路径不应产生 analysisSource 键');

    // 显式标注:保留
    const ai = finalizeQuestion({ content: '测试题', answer: 'A', options: { A: '甲', B: '乙' }, answerSource: 'ai', analysisSource: 'ai' });
    assert.strictEqual(ai.answerSource, 'ai');
    assert.strictEqual(ai.analysisSource, 'ai');

    // 人工录入即已核验,撤 🤖 标
    assert.strictEqual(finalizeQuestion({ content: '测试题', answer: 'A', options: { A: '甲' }, answerSource: 'manual' }).answerSource, 'manual');

    // 非法值(含 '', undefined, 任意字符串)一律归 null,不污染数据
    for (const bad of ['', 'guessed', 'AI', 'ai ', 0, true]) {
        const q = finalizeQuestion({ content: '测试题', answer: 'A', options: { A: '甲' }, answerSource: bad });
        assert.strictEqual(q.answerSource, null, `非法值 ${JSON.stringify(bad)} 应归 null`);
    }

    // 归 null 后仍须幂等(重复 finalize 不改变结果)
    const once = finalizeQuestion({ content: '测试题', answer: 'A', options: { A: '甲' }, answerSource: 'guessed' });
    assert.strictEqual(JSON.stringify(finalizeQuestion(once)), JSON.stringify(once));
});

test('finalizeQuestion 幂等 + 缺答案保留进预览', () => {
    const before = JSON.stringify(P(`1. 测试 A.1 B.2 答案：B`)[0]);
    const again = JSON.stringify(finalizeQuestion(P(`1. 测试 A.1 B.2 答案：B`)[0]));
    assert.strictEqual(again, before);
    const noAns = P(`1. 没有答案的题
A. 甲
B. 乙`);
    assert.strictEqual(noAns[0].answer, '');
    assert.ok(noAns[0].confidence < 0.6);
});

test('去重指纹:同题干同选项不同答案=重复;同题干不同选项=不同', () => {
    assert.strictEqual(questionDedupKey({ content: '题A', options: { A: '甲' } }),
                       questionDedupKey({ content: '题A ', options: { A: '甲' } }));   // 选项相同、答案不同 → 重复
    assert.notStrictEqual(questionDedupKey({ content: '题A', options: { A: '甲' } }),
                          questionDedupKey({ content: '题A', options: { A: '丙' } })); // 选项文本不同 → 不同题
});

// ==================== 真实语料驱动补强(corpus/ 强化练习×2) ====================

test('双行选项布局:第二行 C.x D.y 不再吞 D(splitInlineOptions startFromAny)', () => {
    // 直接单测:任意字母起始仍须连续
    assert.deepStrictEqual(splitInlineOptions('C.爆炸罪 D.故意杀人罪', { startFromAny: true }),
                           { stem: '', options: { C: '爆炸罪', D: '故意杀人罪' } });
    assert.strictEqual(splitInlineOptions('C.甲罪 E.乙罪', { startFromAny: true }), null); // 跳号拒绝
    assert.strictEqual(splitInlineOptions('C.单选项'), null); // 单标记拒绝
    // 端到端:选项排两行 → 4 个选项齐全,题干无污染
    const qs = P(`1. 甲的行为构成（ ）。
A.故意杀人罪和破坏交通工具罪 B.爆炸罪
C.爆炸罪和破坏交通工具罪 D.故意杀人罪
答案：C`);
    assert.strictEqual(qs.length, 1);
    assert.deepStrictEqual(qs[0].options, {
        A: '故意杀人罪和破坏交通工具罪', B: '爆炸罪',
        C: '爆炸罪和破坏交通工具罪', D: '故意杀人罪',
    });
    assert.strictEqual(qs[0].content, '甲的行为构成。'); // 空括号清除
});

test('括号内嵌答案:题末（x）/（B）/（ABD）提取,含实义括号与 f（x）不误判', () => {
    const j = P(`1. 某甲构成过失爆炸罪。（x ）`)[0];
    assert.strictEqual(j.type, '判断');
    assert.strictEqual(j.answer, 'B');
    assert.strictEqual(j.content, '某甲构成过失爆炸罪。');
    assert.strictEqual(P(`1. 下列正确的是（B）`)[0].answer, 'B');
    assert.strictEqual(P(`1. 下列正确的是（ABD）。`)[0].type, '多选');
    assert.strictEqual(P(`1. 计算f（x）`)[0].answer, '');          // 字母+括号=数学记号,不提取
    assert.strictEqual(P(`1. 张某（25周岁）饮酒`)[0].answer, '');   // 实义括号不动
    assert.strictEqual(P(`1. 张某（25周岁）饮酒`)[0].content, '张某（25周岁）饮酒');
    const empty = P(`1. 甲的行为构成（ ）。`)[0];                    // 真空括号:清除但缺答案如实保留
    assert.strictEqual(empty.content, '甲的行为构成。');
    assert.strictEqual(empty.answer, '');
});

test('文末答案表:逐行式/单行多对/区间式回填,垃圾题消失', () => {
    // 逐行式(带"参考答案:"头)
    const perLine = P(`1. 第一题
A. 甲 B. 乙
2. 第二题
A. 甲 B. 乙
3. 第三题
A. 甲 B. 乙

参考答案：
1.B
2.A
3.B`);
    assert.strictEqual(perLine.length, 3); // 不再生成"B"/"A"垃圾题
    assert.deepStrictEqual(perLine.map(q => q.answer), ['B', 'A', 'B']);
    // 单行多对
    const inline = P(`1. 一题 A.甲 B.乙
2. 二题 A.甲 B.乙
答案：1.B 2.A`);
    assert.deepStrictEqual(inline.map(q => q.answer), ['B', 'A']);
    // 区间式
    const range = P(`1. 一 A.甲 B.乙
2. 二 A.甲 B.乙
3. 三 A.甲 B.乙
1-3 BBA`);
    assert.deepStrictEqual(range.map(q => q.answer), ['B', 'B', 'A']);
    // 题干含"B超"不受答案表逻辑误伤
    const safe = P(`1. B超检查发现异常。A.对 B.错`);
    assert.strictEqual(safe.length, 1);
    assert.strictEqual(safe[0].content, 'B超检查发现异常。');
    // 显式答案优先,不被答案表覆盖
    const both = P(`1. 一题 A.甲 B.乙 答案：A
2. 二题 A.甲 B.乙

参考答案：
1.B
2.A`);
    assert.strictEqual(both[0].answer, 'A');
    assert.strictEqual(both[1].answer, 'A');
});

test('判断语境:空括号=对(只标错惯例;批内有括号判卷痕迹才生效)', () => {
    const qs = P(`1. 某甲构成过失爆炸罪。（x ）
2. 某乙构成放火罪。（ ）`);
    assert.strictEqual(qs[0].answer, 'B');
    assert.strictEqual(qs[1].type, '判断');
    assert.strictEqual(qs[1].answer, 'A');
    assert.strictEqual(qs[1].content, '某乙构成放火罪。');
    // 无判卷痕迹 → 不脑补,如实缺答案进预览
    const noEvidence = P(`1. 某甲构成放火罪。（ ）`);
    assert.strictEqual(noEvidence[0].answer, '');
    assert.strictEqual(noEvidence[0].content, '某甲构成放火罪。');
    // 有选项的选择题空括号不受影响
    const choice = P(`1. 甲构成何罪（ ）。
A. 盗窃罪
B. 抢劫罪
答案：A`);
    assert.strictEqual(choice[0].answer, 'A');
    assert.strictEqual(choice[0].type, '单选');
    assert.strictEqual(choice[0].options.B, '抢劫罪');
    // 显式"判断题:"提示,单题也兜
    const hinted = P(`判断题：某丙构成犯罪。（ ）`);
    assert.strictEqual(hinted[0].type, '判断');
    assert.strictEqual(hinted[0].answer, 'A');
});

test('答案表格式变体:【】包裹/带头区间式/对错判卷表', () => {
    const bracket = P(`1. 一 A.甲 B.乙
2. 二 A.甲 B.乙

参考答案：
1.【B】
2.【A】`);
    assert.deepStrictEqual(bracket.map(q => q.answer), ['B', 'A']);
    const rangeHead = P(`1. 一 A.甲 B.乙
2. 二 A.甲 B.乙
3. 三 A.甲 B.乙
参考答案：1-3 BBA`);
    assert.deepStrictEqual(rangeHead.map(q => q.answer), ['B', 'B', 'A']);
    const judgeSheet = P(`1. 一。A.对 B.错
2. 二。A.对 B.错
1.对 2.错`);
    assert.deepStrictEqual(judgeSheet.map(q => q.answer), ['A', 'B']);
});

test('选项折行归并:续行进选项文本,不污染题干;题干续行行为不变', () => {
    const wrapped = P(`1. 下列说法正确的是
A. 甲为了防止果园被盗拉设电网，导致
两个儿童触电身亡
B. 乙使用工业酒精勾兑白酒
答案：A`);
    assert.strictEqual(wrapped[0].content, '下列说法正确的是'); // 题干干净
    assert.strictEqual(wrapped[0].options.A, '甲为了防止果园被盗拉设电网，导致两个儿童触电身亡'); // 折行归并
    // 题干续行(选项未开始)仍归题干
    const stemWrap = P(`1. 甲潜入某机关大院
在乙家门口放火
A. 对 B. 错
答案：A`);
    assert.strictEqual(stemWrap[0].content, '甲潜入某机关大院\n在乙家门口放火');
});

test('展示用答案:判断题显示「对/错」而非 A/B,选择题附选项文本', () => {
    // 判断题:数据层统一存 A/B,展示必须映射回对错(👤 反馈:显示 A/B 没意义)
    assert.strictEqual(formatAnswerForDisplay('A', { type: '判断', options: { A: '正确', B: '错误' } }), '对');
    assert.strictEqual(formatAnswerForDisplay('B', { type: '判断', options: { A: '正确', B: '错误' } }), '错');
    // 判断题但选项为空(旧数据):按题型仍映射
    assert.strictEqual(formatAnswerForDisplay('A', { type: '判断' }), '对');

    // 选择题:附选项文本,便于「缺选项」的错题条目也看得懂
    const single = { type: '单选', options: { A: '甲选项内容', B: '乙选项内容' } };
    assert.strictEqual(formatAnswerForDisplay('A', single), 'A. 甲选项内容');
    // 选项文本过短(占位/模板)则只给字母,避免噪声
    assert.strictEqual(formatAnswerForDisplay('A', { type: '单选', options: { A: '甲' } }), 'A');
    // 多选:原样返回(不逐项展开)
    assert.strictEqual(formatAnswerForDisplay('AB', { type: '多选', options: { A: '甲甲甲', B: '乙乙乙' } }), 'AB');
    // 空答案 / 缺参数不得抛错
    assert.strictEqual(formatAnswerForDisplay('', single), '');
    assert.strictEqual(formatAnswerForDisplay(null, single), '');
    assert.strictEqual(formatAnswerForDisplay('A'), 'A');
});
test('行内选项:两栏排版首尾相接也要能切(A.xxxB.yyy → A/B 两项)', () => {
    // 👤 的真文件(《强化练习(二案例型选择题)》)由转换工具生成:选项原版式是两栏,
    // 抽出来 A 列文字正好接到 B 列,既没空格也没标点 —— 不把汉字当分隔符就只能认出 2 个选项。
    const one = splitInlineOptions('A.故意杀人罪和破坏交通工具罪B.爆炸罪', { startFromAny: true });
    assert.ok(one, '应能拆开首尾相接的选项');
    assert.deepStrictEqual(Object.keys(one.options), ['A', 'B']);
    assert.strictEqual(one.options.A, '故意杀人罪和破坏交通工具罪');
    assert.strictEqual(one.options.B, '爆炸罪');
    // 必须**从 A 开始且连续**,否则不许拆(防"C.xx D.yy"被误拆成别的东西)
    assert.strictEqual(splitInlineOptions('乙说B.这样C.那样'), null);
    // 整题:两行四选项
    const qs = parseQuestionsText([
        '1.甲的行为构成（）。',
        'A.故意杀人罪和破坏交通工具罪B.爆炸罪',
        'C.爆炸罪和破坏交通工具罪D.故意杀人罪',
    ].join('\n'));
    assert.strictEqual(qs.length, 1);
    assert.deepStrictEqual(Object.keys(qs[0].options), ['A', 'B', 'C', 'D']);
    assert.strictEqual(qs[0].options.D, '故意杀人罪');
});

