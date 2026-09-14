import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadApp, makeEl } from './helpers/vm-harness.mjs';

const { run, elements, store, alerts, sandbox, domContentLoadedCount } = await loadApp({ promptValue: 'AI题库' });

const P = (s) => run(`parseQuestionsText(${JSON.stringify(s)})`);

test('DOMContentLoaded 只注册一次', () => assert.strictEqual(domContentLoadedCount.n, 1));
test("normalizeAnswerString('CA')==='AC'", () => assert.strictEqual(run("normalizeAnswerString('CA')"), 'AC'));
test('损坏 JSON 不崩溃', () => {
    store.set('questionBanks', '{bad');
    run('loadFromLocalStorage()');
    assert.strictEqual(Object.keys(run('questionBanks')).length, 0);
});

test('完整字段(解释/选项解释/解析/类型)全部保留', () => {
    const qs = P(`# 单选题1
题目：福祸相依体现了（）
A：矛盾的同一性
A解释：矛盾双方相互依存
B：矛盾的斗争性
答案：A
解析：契合同一性定义
类型：单选`);
    assert.strictEqual(qs.length, 1);
    const q = qs[0];
    assert.strictEqual(q.title, '单选题1');
    assert.strictEqual(q.content, '福祸相依体现了'); // 空答题槽括号按噪音清除
    assert.strictEqual(q.options.A, '矛盾的同一性');
    assert.strictEqual(q.optionExplanations.A, '矛盾双方相互依存');
    assert.strictEqual(q.answer, 'A');
    assert.strictEqual(q.analysis, '契合同一性定义');
    assert.strictEqual(q.type, '单选');
});
test('连续多题(无#分隔)', () => {
    const qs = P(`题目：第一题
A：甲
B：乙
答案：A
题目：第二题
A：丙
B：丁
答案：B`);
    assert.strictEqual(qs.length, 2);
    assert.strictEqual(qs[0].content, '第一题');
    assert.strictEqual(qs[1].content, '第二题');
});

test('多题+选项+答案+解析', () => {
    const qs = P(`1. 下列哪个是编程语言？
A. Python
B. HTML
C. HTTP
D. TCP
答案：A
解析：Python 是编程语言

2. 下列哪些属于前端技术？
A. HTML
B. CSS
C. JavaScript
D. SQL
答案：ABC`);
    assert.strictEqual(qs.length, 2);
    assert.strictEqual(qs[0].content, '下列哪个是编程语言？');
    assert.strictEqual(qs[0].options.A, 'Python');
    assert.strictEqual(qs[0].options.D, 'TCP');
    assert.strictEqual(qs[0].answer, 'A');
    assert.strictEqual(qs[0].type, '单选');
    assert.strictEqual(qs[0].analysis, 'Python 是编程语言');
    assert.strictEqual(qs[1].type, '多选');
    assert.strictEqual(qs[1].answer, 'ABC');
});
test('多行题干保留换行', () => {
    const qs = P(`1. 下列关于马克思主义的说法
正确的是哪一个？
A. 选项一
B. 选项二
答案：A`);
    assert.strictEqual(qs[0].content, '下列关于马克思主义的说法\n正确的是哪一个？');
});

test('题干+行内选项+行内答案', () => {
    const qs = P(`1. 一年有几个月？A.10 B.11 C.12 D.13 答案：C
2. 光速约为每秒多少公里？A.3万 B.30万 C.300万 答案：B`);
    assert.strictEqual(qs.length, 2);
    assert.strictEqual(qs[0].content, '一年有几个月？');
    assert.deepStrictEqual(Object.keys(qs[0].options), ['A', 'B', 'C', 'D']);
    assert.strictEqual(qs[0].options.C, '12');
    assert.strictEqual(qs[0].answer, 'C');
    assert.strictEqual(qs[1].options.B, '30万');
});
test('选项前是中文标点(？A.10)', () => {
    const qs = P(`1. 地球绕太阳转吗？A.是 B.否 答案：A`);
    assert.strictEqual(qs[0].content, '地球绕太阳转吗？');
    assert.strictEqual(qs[0].options.B, '否');
});
test('题干含"A、B"文字不被误拆', () => {
    const qs = P(`1. 下列说法A、B正确的是哪个？答案：A`);
    assert.strictEqual(qs[0].content, '下列说法A、B正确的是哪个？');
    assert.deepStrictEqual(Object.keys(qs[0].options), []);
});

test('答案"对"→ 判断题,A正确B错误', () => {
    const qs = P(`1. 中国的首都是北京。
答案：对`);
    const q = qs[0];
    assert.strictEqual(q.type, '判断');
    assert.strictEqual(q.options.A, '正确');
    assert.strictEqual(q.options.B, '错误');
    assert.strictEqual(q.answer, 'A');
});
test('答案"错误"/"√"→ B/A', () => {
    assert.strictEqual(P(`1. 地球是方的。答案：错误`)[0].answer, 'B');
    assert.strictEqual(P(`1. 水的化学式是H2O。答案：√`)[0].answer, 'A');
});
test('"判断题："开头 + 答案A', () => {
    const qs = P(`判断题：太阳从东边升起。
答案：A`);
    assert.strictEqual(qs[0].type, '判断');
    assert.strictEqual(qs[0].answer, 'A');
});

test('类型提示与答案矛盾时以答案推断为准(判分自洽)', () => {
    const qs = P(`题目：测试
A：甲
B：乙
答案：A
类型：多选`);
    assert.strictEqual(qs[0].type, '单选'); // 答案 A 是单字母 → 单选,判分以答案为根本
});
test('缺答案 → 保留进预览并降低置信度', () => {
    const qs = P(`1. 没有答案的题
A. 甲
B. 乙`);
    assert.strictEqual(qs.length, 1);
    assert.strictEqual(qs[0].answer, '');
    assert.ok(qs[0].confidence < 0.6);
});
test('finalizeQuestion 幂等', () => {
    const before = JSON.stringify(P(`1. 测试 A.1 B.2 答案：B`)[0]);
    const q2 = run(`(() => { const q = parseQuestionsText(${JSON.stringify('1. 测试 A.1 B.2 答案：B')})[0]; return JSON.stringify(finalizeQuestion(q)); })()`);
    assert.strictEqual(q2, before);
});

test('HTML 标签转行', () => {
    const lines = run(`htmlToLines('<p>1. 题目一</p><p>A. 甲</p>答案：A')`);
    assert.ok(lines.some(l => l.includes('题目一')));
    assert.ok(!lines.some(l => l.includes('<p>')));
});

test('批内去重 + 目标题库查重 + 正确入库', () => {
    run(`
        questionBanks = { '目标': [{ content: '已存在的题', options: {A:'甲',B:'乙'}, answer: 'A', type: '单选', confidence: 1, raw: '' }] };
        previewData = [
            { include: true, q: parseQuestionsText('1. 全新题目？A.甲 B.乙 答案：A')[0] },
            { include: true, q: parseQuestionsText('2. 全新题目？A.甲 B.乙 答案：A')[0] },  // 与第1题批内重复(同题干同答案? 不同题干,不重复)
            { include: true, q: parseQuestionsText('3. 已存在的题 A.甲 B.乙 答案：A')[0] }, // 与目标题库重复
            { include: true, q: parseQuestionsText('4. 缺答案的题 A.甲 B.乙')[0] },        // 缺答案被丢弃
            { include: false, q: parseQuestionsText('5. 未勾选 A.甲 B.乙 答案：A')[0] },
        ];
        previewData[1].q.content = '全新题目？'; // 改成和第1题完全一样 → 批内重复
        previewTargetBankSelect.value = '目标';
        previewOverwrite.checked = false;
        previewSkipDupes.checked = true;
        commitPreviewImport();
    `);
    const target = JSON.parse(run('JSON.stringify(questionBanks["目标"])'));
    // 第1题入库;第2题批内重复跳过;第3题与目标重复跳过;第4题缺答案入库为"待补";第5题未勾选
    assert.strictEqual(target.length, 3);
    assert.strictEqual(target.filter(q => q.content === '全新题目？').length, 1);
    assert.ok(target.some(q => q.content === '已存在的题'));
    const pending = target.find(q => q.content === '缺答案的题');
    assert.ok(pending && pending.answer === ''); // 待补答案,不判分不出题
});
test('新建题库(prompt) + 导入后切换当前题库', () => {
    run(`
        previewData = [{ include: true, q: parseQuestionsText('1. 新题？A.甲 B.乙 答案：A')[0] }];
        previewTargetBankSelect.value = '__new__';
        previewOverwrite.checked = false;
        previewSkipDupes.checked = true;
        commitPreviewImport();
    `);
    assert.ok(run('questionBanks["AI题库"]').length === 1);
    assert.strictEqual(run('currentBankName'), 'AI题库');
    assert.strictEqual(run('isAllBanksView'), false);
});
test('覆盖模式(overwrite)清空目标后导入', () => {
    run(`
        previewData = [{ include: true, q: parseQuestionsText('1. 覆盖后的题 A.甲 B.乙 答案：B')[0] }];
        previewTargetBankSelect.value = 'AI题库';
        previewOverwrite.checked = true;
        commitPreviewImport();
    `);
    const bank = JSON.parse(run('JSON.stringify(questionBanks["AI题库"])'));
    assert.strictEqual(bank.length, 1);
    assert.strictEqual(bank[0].content, '覆盖后的题');
});


// ==================== 多题库导出/导入往返(👤 2026-09-12)====================
// 本文件的 loadApp 在模块顶层(共享实例),故这里不另开 describe/before —— 直接复用 run/elements/sandbox。

// 抓住「导出题库」真正写出去的那段文本 + 文件名:替换 Blob / createObjectURL / a.click 三个出口
function captureExport(call = 'exportAllBanks()') {
    let text = null;
    let filename = null;
    const origCreate = sandbox.document.createElement;
    sandbox.Blob = class { constructor(parts) { text = String(parts.join('')); } };
    sandbox.URL.createObjectURL = () => 'blob:test';
    sandbox.URL.revokeObjectURL = () => {};
    sandbox.document.createElement = (tag) => {
        const el = origCreate(tag);
        el.click = () => { filename = el.download; };
        return el;
    };
    try { run(call); } finally { sandbox.document.createElement = origCreate; }
    return { text, filename };
}

test('导出:逐库写分节标题;解析回来仍是分好的多库', () => {
    run(`questionBanks = {
        '甲库': [{ content: '甲一', type: '单选', options: { A: '甲', B: '乙' }, answer: 'A' }],
        '乙库': [{ content: '乙一', type: '单选', options: { A: '甲', B: '乙' }, answer: 'B' },
                 { content: '乙二', type: '判断', options: { A: '正确', B: '错误' }, answer: 'A' }]
    }`);
    const { text } = captureExport();
    assert.ok(text && text.includes('题库：甲库') && text.includes('题库：乙库'), '导出内容应含两个分节标题');
    const names = JSON.parse(run(`JSON.stringify(splitBankSections(${JSON.stringify(text)}).map(s => s.name))`));
    assert.deepStrictEqual(names, ['甲库', '乙库'], '解析回来应仍是两个库');
    const counts = JSON.parse(run(`JSON.stringify(splitBankSections(${JSON.stringify(text)}).map(s => parseQuestionsText(s.text).length))`));
    assert.deepStrictEqual(counts, [1, 2], '每节的题数要对得上');
});

test('导出文件名带时间戳(👤 要求):同一天导多次也分得清', () => {
    run(`questionBanks = { '甲库': [{ content: '甲一', type: '单选', options: { A: '甲', B: '乙' }, answer: 'A' }] }`);
    const all = captureExport('exportAllBanks()').filename;
    const one = captureExport(`exportBank('甲库')`).filename;
    // 形如 所有题库-20260912-1523.txt / 甲库-20260912-1523.txt
    assert.ok(/^所有题库-\d{8}-\d{4}\.txt$/.test(all), '导出题库的文件名应带时间戳,实际:' + all);
    assert.ok(/^甲库-\d{8}-\d{4}\.txt$/.test(one), '导出本库的文件名应带时间戳,实际:' + one);
    // 时间戳就是"当下":年月日时分,且两位补零(排序友好)
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
    assert.ok(all.includes(stamp), `时间戳应是当前时刻(${stamp}),实际:${all}`);
});

test('导入:多库文件自动切库,默认"按题库分别导入"', () => {
    const text = ['# ===== 题库：甲库 =====', '题目：甲一', 'A：甲', 'B：乙', '答案：A', '类型：单选',
        '# ===== 题库：乙库 =====', '题目：乙一', 'A：甲', 'B：乙', '答案：B', '类型：单选'].join('\n');
    elements['paste-input'].value = text;
    run('parsePastedText()');
    assert.strictEqual(run('previewBanks.length'), 2, '应认出两个库');
    assert.deepStrictEqual(JSON.parse(run('JSON.stringify(previewBanks.map(b => b.name + ":" + b.count))')),
        ['甲库:1', '乙库:1'], '每库题数要对');
    assert.strictEqual(run('previewBankMode'), 'separate', '默认按题库分开导入');
    assert.deepStrictEqual(JSON.parse(run('JSON.stringify(previewData.map(d => d.bank))')), ['甲库', '乙库'],
        '每道题都记着自己属于哪个库');
});

test('确认导入:分开建库、逐库记账(撤销有据可依)', () => {
    run(`questionBanks = {}; bankVersions = {}`);
    const text = ['# ===== 题库：甲库 =====', '题目：甲一', 'A：甲', 'B：乙', '答案：A', '类型：单选',
        '# ===== 题库：乙库 =====', '题目：乙一', 'A：甲', 'B：乙', '答案：B', '类型：单选',
        '题目：乙二', 'A：正确', 'B：错误', '答案：A', '类型：判断'].join('\n');
    elements['paste-input'].value = text;
    run('parsePastedText()');
    // 这个桩实例是共享的,前面用例也会记批次 → 只看**这一次**新增的那几条
    const beforeCount = JSON.parse(store.get('importBatches') || '[]').length;
    run('commitPreviewImport()');
    assert.deepStrictEqual(Object.keys(JSON.parse(run('JSON.stringify(questionBanks)'))).sort(), ['乙库', '甲库'], '两个库都要建出来');
    assert.strictEqual(run(`questionBanks['甲库'].length`), 1);
    assert.strictEqual(run(`questionBanks['乙库'].length`), 2, '乙库两道题都要进乙库');
    assert.strictEqual(run('currentBankName'), '甲库', '导入后停在第一个库');
    // 直接读落盘(localStorage 里就是 importBatches),免得再往测试钩子里挂一个 storage 函数
    const batches = JSON.parse(store.get('importBatches') || '[]').slice(beforeCount).map(b => b.bank);
    assert.deepStrictEqual(batches, ['甲库', '乙库'], '逐库记账:撤销才撤得掉');
    // 撤销:👤 2026-09-13 起统一走"撤销栈一步"(会话内)与版本记录(跨会话),不再有批次级撤销
    assert.strictEqual(run('editorUndo()'), true, '一次导入 = 一步撤销');
    assert.strictEqual(run(`questionBanks['乙库'].length`), 0, '乙库回到导入前(导入前它是空的)');
    assert.strictEqual(run(`questionBanks['甲库'].length`), 0, '甲库同样回到导入前(一次导入涉及的库一起回退)');
    assert.strictEqual(run('editorRedo()'), true);
    assert.strictEqual(run(`questionBanks['乙库'].length`), 2, '重做恢复导入了的 2 题');
});

test('改成"全部并入一个题库"时,回到旧的单库导入行为', () => {
    run(`questionBanks = { '总库': [] }; importBatches = []`);
    const text = ['# ===== 题库：甲库 =====', '题目：甲一', 'A：甲', 'B：乙', '答案：A', '类型：单选',
        '# ===== 题库：乙库 =====', '题目：乙一', 'A：甲', 'B：乙', '答案：B', '类型：单选'].join('\n');
    elements['paste-input'].value = text;
    run('parsePastedText(); setPreviewBankMode("merge")');
    assert.strictEqual(run('previewBankMode'), 'merge');
    elements['preview-target-bank'].value = '总库';
    run('commitPreviewImport()');
    assert.strictEqual(run(`questionBanks['总库'].length`), 2, '两库的题合并到目标库');
    assert.strictEqual(run(`!!questionBanks['甲库']`), false, '合并模式下不该另建库');
});

test('分开导入 + 覆盖同名库:先存一版(可回退)', () => {
    run(`questionBanks = { '甲库': [{ content: '旧题', type: '单选', options: { A: '甲', B: '乙' }, answer: 'A' }] };
        bankVersions = {}; importBatches = []`);
    const text = ['# ===== 题库：甲库 =====', '题目：新题', 'A：甲', 'B：乙', '答案：A', '类型：单选',
        '# ===== 题库：乙库 =====', '题目：乙一', 'A：甲', 'B：乙', '答案：B', '类型：单选'].join('\n');
    elements['paste-input'].value = text;
    run('parsePastedText()');
    elements['preview-overwrite'].checked = true;
    run('commitPreviewImport()');
    elements['preview-overwrite'].checked = false;
    assert.strictEqual(run(`questionBanks['甲库'].length`), 1, '覆盖后只剩新题');
    assert.strictEqual(run(`questionBanks['甲库'][0].content`), '新题');
    const vers = JSON.parse(run(`JSON.stringify((loadBankVersions()['甲库'] || []).map(v => v.action))`));
    assert.deepStrictEqual(vers, ['覆盖导入前'], '覆盖前应存一版');
    assert.strictEqual(run(`(loadBankVersions()['乙库'] || []).length`), 0, '乙库是新库,不该凭空存版');
});

test('单库文件(没有分节标记)仍走原来的单库流程', () => {
    run(`questionBanks = { '总库': [] }; previewBanks = []; previewBankMode = 'merge'`);
    elements['paste-input'].value = ['题目：单库题', 'A：甲', 'B：乙', '答案：A', '类型：单选'].join('\n');
    run('parsePastedText()');
    assert.strictEqual(run('previewBanks.length'), 0, '没有标记就不该冒出多库');
    assert.strictEqual(run('previewBankMode'), 'merge');
    assert.strictEqual(run('previewData.length'), 1);
});

// ==================== 首页导入流程对齐(👤 2026-09-13 定口径)====================
// 生成的流程:提示词给出两条路(粘贴 / 选文件)→ 选到 doc/pdf 给专门提示 →
// 解析不出题目时**必须**提示 + 自动展开救援区。三件事,少一件用户就找不到路。
const HTML_SRC = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8');

test('解析不出题目 → 提示 + 自动展开「AI 格式整理」救援区(不能只在状态行里提一句)', () => {
    elements['ai-rescue'].open = false;
    elements['paste-input'].value = '今天天气不错，我去公园散步，看到很多花，心情很好。';
    run('parsePastedText()');
    const st = elements['import-status'];
    assert.ok(String(st.className).includes('error'), '应是错误态提示');
    assert.strictEqual(elements['ai-rescue'].open, true,
        '解析不出来必须**自动展开**救援区 —— 光提示"上方有…"而那段是收起的,等于什么都没给');
    assert.ok(!/复制官方提示词/.test(String(st.textContent)),
        '不许再引用界面上不存在的名字「复制官方提示词」');
    assert.ok(/AI 格式整理/.test(String(st.textContent)), '提示要点名救援区里真正能点的按钮');
});

test('提示文案里引用的按钮名必须真实存在于界面(文案与界面不许各说各话)', () => {
    const quoted = (text) => [...String(text).matchAll(/「([^」]+)」/g)].map(m => m[1]);
    // ① 解析失败提示
    elements['paste-input'].value = 'zzz 这也不是题目';
    run('parsePastedText()');
    const msg = String(elements['import-status'].textContent);
    const names = quoted(msg);
    assert.ok(names.length >= 2, '提示里应点名救援区的按钮,实际:' + msg);
    for (const n of names) {
        assert.ok(HTML_SRC.includes(n), `提示引用了界面上不存在的「${n}」—— 文案必须用真按钮名`);
    }
    // ② 老版 .doc 提示里引用的预览页按钮
    run(`handleFileSelect({ target: { files: [{ name: '卷子.doc' }] } })`);
    const docNotice = String(elements['import-status'].innerHTML);
    assert.ok(!/AI 兜底整理/.test(docNotice), '「AI 兜底整理」是旧名,界面上的按钮叫「🤖 AI 格式整理(不改内容)」');
    for (const n of quoted(docNotice).filter(x => /AI/.test(x))) {
        assert.ok(HTML_SRC.includes(n), `提示引用了界面上不存在的「${n}」`);
    }
});

test('文件流程:PDF 给 AI 提取入口 + 隐私说明;.doc 走"转格式 / 复制文字"', () => {
    run(`handleFileSelect({ target: { files: [{ name: '卷子.pdf' }] } })`);
    const pdfNotice = String(elements['import-status'].innerHTML);
    assert.ok(pdfNotice.includes('file-ai-copy-btn'), 'PDF 要给"复制提示词去 AI 提取"的入口');
    assert.ok(pdfNotice.includes('上传给该 AI 服务'), 'PDF 走 AI 要把隐私说清');
    assert.ok(pdfNotice.includes('选中文字复制'), 'PDF 还要给不用 AI 的那条路');
    run(`handleFileSelect({ target: { files: [{ name: '卷子.doc' }] } })`);
    const docNotice = String(elements['import-status'].innerHTML);
    assert.ok(docNotice.includes('另存为') && docNotice.includes('.docx'), '.doc 首选"另存为 .docx 再选一次"');
    assert.ok(!docNotice.includes('file-ai-copy-btn'), '.doc 不该出现 AI 提取按钮(AI 聊天也读不了 .doc)');
    // ⚠️ 「选 txt/Word → 文字读进输入框」这条路由 ai.test.js 用同步 FileReader 桩覆盖,这里不重复
});
