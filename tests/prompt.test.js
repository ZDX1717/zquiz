// 官方提示词模块测试:触发判定 + 提示词内容关键约束
import assert from 'node:assert';
import test from 'node:test';
import { OFFICIAL_PROMPT, PDF_EXTRACT_PROMPT, needsPromptHelp, LOW_CONF_RATIO_THRESHOLD, buildCopyText } from '../src/prompt.js';
import { parseQuestionsText } from '../src/parser.js';

test('触发判定:0 题 → 建议;低置信占比达标 → 建议;健康批次 → 不建议', () => {
    assert.strictEqual(needsPromptHelp([]), true);
    const healthy = parseQuestionsText(`1. 题 A.甲 B.乙 答案：A
2. 题 B.甲 丙.乙 答案：B`.replace('B.甲 丙.乙', 'A.甲 B.乙'));
    assert.strictEqual(needsPromptHelp(healthy), false);
    const messy = parseQuestionsText(`1. 好题 A.甲 B.乙 答案：A
2. 缺答案
3. 也缺答案`);
    // 3 题中 2 题缺答案 → 低置信占比 2/3 ≥ 0.4 → 建议
    assert.strictEqual(needsPromptHelp(messy), true);
    assert.strictEqual(LOW_CONF_RATIO_THRESHOLD, 0.4);
});

test('提示词内容:关键约束齐备(不猜答案/不改内容/格式对齐 parser 字段式)', () => {
    assert.ok(OFFICIAL_PROMPT.includes('题库格式整理助手'));
    assert.ok(OFFICIAL_PROMPT.includes('绝对不许猜答案'));
    assert.ok(OFFICIAL_PROMPT.includes('只调整格式,不改内容'));
    assert.ok(OFFICIAL_PROMPT.includes('多选字母连写'));
    assert.ok(OFFICIAL_PROMPT.includes('判断题写"对"或"错"'));
    assert.ok(OFFICIAL_PROMPT.includes('题目：'));
    assert.ok(OFFICIAL_PROMPT.includes('不要给题目加编号'));
});

test('buildCopyText:无原文仅提示词;有原文自动合成(分隔线隔开)', () => {
    assert.strictEqual(buildCopyText('P', ''), 'P');
    assert.strictEqual(buildCopyText('P', '   '), 'P');
    const combined = buildCopyText('PROMPT', '1.题目原文\n2.第二题');
    assert.ok(combined.startsWith('PROMPT'));
    assert.ok(combined.includes('以下是需要整理的题目原文'));
    assert.ok(combined.endsWith('1.题目原文\n2.第二题'));
});

test('OFFICIAL_PROMPT(识别不出题目时用):补齐真机上最痛的两条规则', () => {
    // 折行合并:真材料里题干/选项被文档折成多行,是"解析不出题"的头号原因
    assert.ok(/折行必须合并/.test(OFFICIAL_PROMPT), '要明确要求合并被折开的题干与选项');
    assert.ok(/一道题只写一个"题目："|一道题只写一个/.test(OFFICIAL_PROMPT), '要防止一道题被拆成两题');
    assert.ok(/案例/.test(OFFICIAL_PROMPT) && /每道小题各算一道题/.test(OFFICIAL_PROMPT), '案例/材料题要按小题拆');
    assert.ok(/【原文含图】/.test(OFFICIAL_PROMPT) && /【原文含公式】/.test(OFFICIAL_PROMPT), '图/公式要标注而不是编');
});

test('PDF_EXTRACT_PROMPT(PDF 读不出文字时用):先要文件,收到就直接提取(👤 定)', () => {
    // 👤 要的效果:助手让用户发送文件 → 用户发完 → 助手直接提取并整理
    assert.ok(/请把这个 PDF 文件发给我/.test(PDF_EXTRACT_PROMPT), '没收到文件时要先要文件');
    assert.ok(/不要再确认、不要再问任何问题/.test(PDF_EXTRACT_PROMPT), '收到文件后要直接干活,不许再确认');
    assert.ok(/不要让我自己复制文字|不要.*让我自己复制文字/.test(PDF_EXTRACT_PROMPT), '不许反过来让用户自己复制文字');
    // 输出格式与第一条一致(parser 字段式)
    for (const line of ['题目：', 'A：', '答案：', '解析：']) {
        assert.ok(PDF_EXTRACT_PROMPT.includes(line), `输出格式要与 parser 对齐:${line}`);
    }
    assert.ok(/只搬运,不创作/.test(PDF_EXTRACT_PROMPT), '同一条底线:只搬运不创作');
    assert.ok(/直接省略"答案："这一行/.test(PDF_EXTRACT_PROMPT), '没答案的题不许编');
    assert.ok(/有密码保护/.test(PDF_EXTRACT_PROMPT), '打不开的文件要说明原因,不许编内容');
    assert.ok(/水印/.test(PDF_EXTRACT_PROMPT), '页眉页脚水印目录不要输出');
});

test('两条提示词不许混用:PDF 那条**不带材料**,整理那条带', () => {
    assert.ok(!PDF_EXTRACT_PROMPT.includes('以下是需要整理的题目原文'), 'PDF 提示词不该含材料分隔线');
    assert.strictEqual(buildCopyText(PDF_EXTRACT_PROMPT, ''), PDF_EXTRACT_PROMPT);
    assert.ok(buildCopyText(OFFICIAL_PROMPT, '题目：x').includes('以下是需要整理的题目原文'));
});
