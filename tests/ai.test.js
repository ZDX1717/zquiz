// AI 模块测试(0.9.x):预设/配置 + chat 客户端(假 fetch) + 分块 + 编排 + 存储 + 预览兜底/救援/B 路线集成
import assert from 'node:assert';
import test from 'node:test';
import { AI_PROVIDERS, normalizeAiConfig, aiConfigReady, aiBaseUrlProblem, chatCompletion, testConnection, splitIntoChunks, aiFormatMaterial, aiFixQuestions, serializeQuestion, groupQuestionChunks, buildAiNotes } from '../src/ai.js';
import { loadAiConfig, saveAiConfig, loadAiUsage, recordAiUsage } from '../src/storage.js';

// ---------- 厂商预设与配置 ----------
test('厂商预设:三家直连厂商在列', () => {
    const ids = AI_PROVIDERS.map(p => p.id);
    assert.deepStrictEqual(ids, ['zhipu', 'siliconflow', 'deepseek', 'custom']);
    assert.strictEqual(AI_PROVIDERS[0].model, 'glm-4-flash');
    assert.ok(AI_PROVIDERS[0].name.includes('免费'));
});

test('normalizeAiConfig:按厂商预设补齐 baseUrl/model;去尾斜杠;apiKey 永不默认', () => {
    const cfg = normalizeAiConfig({ providerId: 'zhipu', apiKey: 'k1', baseUrl: 'https://x.example/v4/' });
    assert.strictEqual(cfg.baseUrl, 'https://x.example/v4');
    assert.strictEqual(cfg.model, 'glm-4-flash');
    assert.strictEqual(normalizeAiConfig(null).apiKey, '');
    assert.strictEqual(aiConfigReady(cfg), true);
    assert.strictEqual(aiConfigReady({ ...cfg, apiKey: '' }), false);
});

// ---------- chat 客户端(假 fetch) ----------
function fakeFetch(response) {
    const calls = [];
    const fn = async (url, init) => {
        calls.push({ url, init });
        if (typeof response === 'function') return response(url, init);
        return response;
    };
    fn.calls = calls;
    return fn;
}
const okResp = () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '题目：测试题\nA：甲\nB：乙\n答案：A' } }] }) });
const CFG = { providerId: 'zhipu', apiKey: 'k-test', baseUrl: 'https://api.example/v4', model: 'glm-4-flash' };

test('chatCompletion:POST baseUrl+/chat/completions,Bearer 头,非流式,返回 content', async () => {
    const f = fakeFetch(okResp());
    const content = await chatCompletion(CFG, [{ role: 'user', content: 'hi' }], { fetchImpl: f, timeoutMs: 0 });
    assert.match(content, /题目：测试题/);
    const { url, init } = f.calls[0];
    assert.strictEqual(url, 'https://api.example/v4/chat/completions');
    assert.strictEqual(init.method, 'POST');
    assert.strictEqual(init.headers.Authorization, 'Bearer k-test');
    const body = JSON.parse(init.body);
    assert.strictEqual(body.model, 'glm-4-flash');
    assert.strictEqual(body.stream, false);
});

test('chatCompletion:HTTP 错误带状态码;网络异常归类为网络/CORS;配置缺失快速失败', async () => {
    const f = fakeFetch({ ok: false, status: 401, text: async () => 'bad key' });
    await assert.rejects(() => chatCompletion(CFG, [], { fetchImpl: f, timeoutMs: 0 }), /401/);
    const f2 = fakeFetch(async () => { throw new Error('ECONNREFUSED'); });
    await assert.rejects(() => chatCompletion(CFG, [], { fetchImpl: f2, timeoutMs: 0 }), /网络\/CORS/);
    await assert.rejects(() => chatCompletion({ ...CFG, apiKey: '' }, [], { fetchImpl: f, timeoutMs: 0 }), /API Key/);
});

test('testConnection:连通返回 sample', async () => {
    const f = fakeFetch({ ok: true, json: async () => ({ choices: [{ message: { content: 'OK' } }] }) });
    const r = await testConnection(CFG, { fetchImpl: f });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.sample, 'OK');
});

test('chatCompletion:传入 signal 时原样透传给 fetch(取消能力)', async () => {
    const f = fakeFetch(okResp());
    const ctrl = new AbortController();
    await chatCompletion(CFG, [{ role: 'user', content: 'x' }], { fetchImpl: f, signal: ctrl.signal, timeoutMs: 0 });
    assert.strictEqual(f.calls[0].init.signal, ctrl.signal);
});

// ---------- 分块 ----------
test('splitIntoChunks:按空行分段累积,不超 maxChars,内容零丢失零重排', () => {
    const blocks = [];
    for (let i = 1; i <= 30; i++) blocks.push(`1、第${i}题题干\nA：甲 B：乙 C：丙 D：丁 答案：A`);
    const material = blocks.join('\n\n');
    const chunks = splitIntoChunks(material, { maxChars: 300 });
    assert.ok(chunks.length > 1);
    assert.ok(chunks.every(c => c.length <= 300));
    assert.strictEqual(chunks.join('\n\n').replace(/\n{2,}/g, '\n\n'), material.replace(/\n{2,}/g, '\n\n'));
});

test('splitIntoChunks:超长单段按行硬切;空材料为空', () => {
    const long = Array.from({ length: 20 }, (_, i) => '第' + i + '行这是一条很长很长的题目内容用来撑爆单块限制').join('\n');
    const chunks = splitIntoChunks(long, { maxChars: 120 });
    assert.ok(chunks.length > 1);
    assert.strictEqual(chunks.join('\n'), long);
    assert.deepStrictEqual(splitIntoChunks(''), []);
});

// ---------- 编排(整篇原文 → 整理文本,「🤖 AI 整理输入框」用) ----------
test('aiFormatMaterial:官方提示词作 system,逐块带进度,结果按块拼回', async () => {
    const f = fakeFetch((url, init) => {
        const body = JSON.parse(init.body);
        assert.strictEqual(body.messages[0].role, 'system');
        assert.ok(body.messages[0].content.includes('题库格式整理助手'));
        return { ok: true, json: async () => ({ choices: [{ message: { content: '题目：' + body.messages[1].content.slice(0, 10) + ' 答案：A' } }] }) };
    });
    const progress = [];
    const material = Array.from({ length: 8 }, (_, i) => `1、题干${i} A：甲 B：乙 答案：A`).join('\n\n');
    const r = await aiFormatMaterial(CFG, material, { fetchImpl: f, maxChars: 120, timeoutMs: 0, onProgress: (d, t) => progress.push(d + '/' + t) });
    assert.ok(r.chunks >= 2);
    assert.strictEqual(progress[progress.length - 1], r.chunks + '/' + r.chunks);
    assert.ok(r.text.includes('题目：'));
});

test('aiFormatMaterial:空材料快速失败', async () => {
    await assert.rejects(() => aiFormatMaterial(CFG, '   ', { fetchImpl: fakeFetch(okResp()), timeoutMs: 0 }), /没有可整理的内容/);
});

// ---------- 按题修复(预览页 AI 兜底用) ----------
test('aiFixQuestions 基元:序列化/分块上限/进度按题数', async () => {
    const q = { content: '题?', options: { A: '甲', B: '乙' }, answer: 'A', explanation: '因为' };
    assert.ok(serializeQuestion(q).includes('题目：题?'));
    assert.ok(serializeQuestion(q).includes('解析：因为'));
    const many = Array.from({ length: 25 }, (_, i) => ({ content: '第' + i + '题很长很长很长很长', options: { A: '甲', B: '乙' }, answer: 'A' }));
    const chunks = groupQuestionChunks(many);
    assert.ok(chunks.length >= 3);
    assert.strictEqual(chunks.reduce((a, c) => a + c.count, 0), 25);
    assert.ok(chunks.every(c => c.count <= 10));
    let last = null;
    const r = await aiFixQuestions(CFG, many.slice(0, 12), { fetchImpl: fakeFetch(okResp()), timeoutMs: 0, onProgress: (d, t) => { last = d + '/' + t; } });
    assert.strictEqual(r.total, 12);
    assert.strictEqual(last, '12/12');
    assert.ok(r.questions.length >= 1);
});

// ---------- 存储层(全局 localStorage 桩) ----------
test('AI 配置与埋点:roundtrip、损坏兜底、埋点上限 50', () => {
    const store = new Map();
    globalThis.localStorage = {
        getItem: k => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: k => store.delete(k),
    };
    try {
        assert.deepStrictEqual(loadAiConfig(), {});
        saveAiConfig(CFG);
        assert.deepStrictEqual(loadAiConfig(), CFG);
        store.set('aiConfig', '{broken');
        assert.deepStrictEqual(loadAiConfig(), {});
        for (let i = 0; i < 55; i++) recordAiUsage({ trigger: 'preview-fix', chunks: 1, aiQuestions: i });
        const usage = loadAiUsage();
        assert.strictEqual(usage.length, 50);
        assert.strictEqual(usage[49].aiQuestions, 54);
    } finally {
        delete globalThis.localStorage;
    }
});

// ---------- buildAiNotes(改动对比) ----------
test('buildAiNotes:改动逐项写明;未变不标;题干同选项变可宽松匹配', () => {
    const orig = { content: '天空是什么颜色?', options: { A: '红', B: '绿', C: '蓝' }, type: '单选', answer: '' };
    const [noteSame] = buildAiNotes([JSON.parse(JSON.stringify(orig))], [{ ...orig, answer: 'C' }]);
    assert.strictEqual(noteSame, 'AI 修改：补入答案 C');
    const tweaked = { content: '天空是什么颜色?', options: { A: '红', B: '绿', C: '蓝色' }, type: '单选', answer: 'C' };
    const [noteTweak] = buildAiNotes([JSON.parse(JSON.stringify(orig))], [tweaked]);
    assert.ok(noteTweak.includes('选项调整'));
    const identical = { content: '天空是什么颜色?', options: { A: '红', B: '绿', C: '蓝' }, type: '单选', answer: 'C' };
    const [noteNone] = buildAiNotes([{ ...identical }], [JSON.parse(JSON.stringify(identical))]);
    assert.strictEqual(noteNone, '');
});

// ---------- vm 沙箱集成 ----------
const AI_TEXT = `题目：1+1等于几?
A：1
B：2
C：3
D：4
答案：B

题目：天空是什么颜色?
A：红
B：绿
C：蓝
答案：C`;

test('previewAiFallback(勾选语义):未勾选题不进请求;内容没变不打徽章', async () => {
    const calls = [];
    const { run, store, elements } = await import('./helpers/vm-harness.mjs').then(h => h.loadApp({
        sandboxExtras: {
            fetch: async (url, init) => {
                calls.push(JSON.parse(init.body).messages[1].content);
                return { ok: true, json: async () => ({ choices: [{ message: { content: AI_TEXT } }] }) };
            },
            AbortController,
        },
    }));
    store.set('aiConfig', JSON.stringify(CFG));
    run(`Q3 = ['1. 1+1等于几? A.1 B.2 C.3 D.4 答案：B', '2. 天空是什么颜色? A.红 B.绿 C.蓝 答案：C', '3. AI 漏掉的题 A.甲 B.乙 答案：A']`);
    run(`init()`);
    run(`openImportPreview(parseQuestionsText(Q3.join(String.fromCharCode(10))))`);
    assert.strictEqual(run(`previewData.length`), 3);
    run(`previewData[2].include = false; renderPreview()`);
    await run(`(async () => { await previewAiFallback(); })()`);
    assert.strictEqual(calls.length, 1);
    assert.ok(calls[0].includes('1+1等于几'), '勾选题要进请求');
    assert.ok(!calls[0].includes('AI 漏掉的题'), '未勾选题不进请求');
    assert.strictEqual(run(`previewData[2].q.content`), 'AI 漏掉的题');
    assert.strictEqual(run(`previewData[2].aiNote`), '');
});

test('previewAiFallback:改动写明差异;AI 未返回的题标注保留原样(不无声消失)', async () => {
    const { run, store, elements } = await import('./helpers/vm-harness.mjs').then(h => h.loadApp({
        sandboxExtras: {
            fetch: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '题目：1+1等于几?\nA：1\nB：二\nC：3\nD：4\n答案：B' } }] }) }),
            AbortController,
        },
    }));
    store.set('aiConfig', JSON.stringify(CFG));
    run(`Q2 = ['1. 1+1等于几? A.1 B.2 C.3 D.4 答案：B', '2. 被漏掉的题 A.甲 B.乙 答案：A']`);
    run(`init()`);
    run(`openImportPreview(parseQuestionsText(Q2.join(String.fromCharCode(10))))`);
    await run(`(async () => { await previewAiFallback(); })()`);
    assert.ok(String(run(`previewData[0].aiNote`)).includes('选项调整'), '改动要写明');
    assert.ok(String(run(`previewData[1].aiNote`)).includes('AI 未返回'), '漏答题要有说明');
    assert.strictEqual(run(`previewData[1].q.content`), '被漏掉的题');
});

test('previewAiFallback:0 勾选 → 引导提示,不发请求', async () => {
    let fetched = 0;
    const { run } = await import('./helpers/vm-harness.mjs').then(h => h.loadApp({
        sandboxExtras: { fetch: async () => { fetched++; return { ok: true, json: async () => ({ choices: [{ message: { content: '' } }] }) }; }, AbortController },
    }));
    run(`init()`);
    run(`openImportPreview(parseQuestionsText('1. 题 A.甲 B.乙 答案：A'))`);
    run(`previewData[0].include = false; renderPreview()`);
    await run(`(async () => { await previewAiFallback(); })()`);
    assert.strictEqual(fetched, 0);
});

test('设置面板回归:测试连接点击后状态可见且成功(锁死静默故障)', async () => {
    const { run, store, elements } = await import('./helpers/vm-harness.mjs').then(h => h.loadApp({
        sandboxExtras: { fetch: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'OK' } }] }) }) },
    }));
    store.set('aiConfig', JSON.stringify(CFG));
    run(`init()`);
    run(`openAiSettings()`);
    const btn = elements['ai-test-btn'];
    assert.ok(btn._listeners.click, '测试连接按钮必须已绑定 click');
    await btn._listeners.click();
    const st = elements['ai-test-status'];
    assert.ok(st.textContent.includes('连接成功'));
    assert.ok(st.className.includes('success'));
});

test('AI 已连接徽章:测试成功后 ✓;配置变更未复测则熄灭', async () => {
    const { run, store, elements } = await import('./helpers/vm-harness.mjs').then(h => h.loadApp({
        sandboxExtras: { fetch: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'OK' } }] }) }) },
    }));
    store.set('aiConfig', JSON.stringify(CFG));
    run(`init()`);
    const btn = elements['ai-settings-btn'];
    assert.strictEqual(btn.textContent, '⚙ AI 设置');
    run(`openAiSettings()`);
    await elements['ai-test-btn']._listeners.click();
    assert.strictEqual(btn.textContent, '⚙ AI 已连接 ✓');
    run(`aiModelInput.value = 'glm-4-plus'`);
    run(`saveAiSettings()`);
    assert.strictEqual(btn.textContent, '⚙ AI 设置');
});

test('「复制提示词和题目」必须把题目原文一起复制(👤 2026-09-13 报"只复制了提示词")', async () => {
    // 🚨 这个 bug 的形态很典型:监听器写成 `addEventListener('click', copyOfficialPrompt)`,
    //    浏览器**照例把事件对象当第一个实参传进去**,而那个参数是 forcePromptOnly 开关 ——
    //    MouseEvent 是真值 → 每次都走"只要提示词"的分支。所以这里必须**照浏览器的样子**触发:
    //    传事件对象,而不是"不带参数地调一下"(那样测不出任何东西)。
    const copied = [];
    const { run, elements } = await import('./helpers/vm-harness.mjs').then(h => h.loadApp({
        sandboxExtras: {
            navigator: { clipboard: { writeText: async (t) => { copied.push(String(t)); } } },
        },
    }));
    run('init()');
    elements['paste-input'].value = '题目：1+1等于几\nA：1\nB：2\n答案：B';
    await elements['copy-prompt-btn']._listeners.click({ type: 'click', target: elements['copy-prompt-btn'] });
    assert.strictEqual(copied.length, 1, '应复制一次');
    assert.ok(copied[0].includes('1+1等于几'), '复制内容里必须带题目原文,实际只拿到:' + copied[0].slice(-60));
    assert.ok(copied[0].includes('需要整理的题目原文'), '应有分隔标题');
    assert.ok(/已复制提示词\+题目/.test(String(elements['copy-prompt-btn'].textContent)),
        '按钮应报"已复制提示词+题目",实际:' + elements['copy-prompt-btn'].textContent);

    // 反向:PDF 那条路(file-ai-copy-btn)明确只要提示词,不能被顺手带上原文
    copied.length = 0;
    elements['import-status']._listeners.click({ target: { id: 'file-ai-copy-btn' } });
    await new Promise(r => setImmediate(r));
    assert.strictEqual(copied.length, 1, 'PDF 那条路也要复制一次');
    assert.ok(!copied[0].includes('1+1等于几'), 'PDF 场景只要提示词(没有文字可合并),不许带上一位用户的原文');
    // 👤 2026-09-14:PDF 那条要用**PDF 专用提示词**(先让 AI 索要文件,收到就直接提取),不是整理那条
    assert.ok(/请把这个 PDF 文件发给我/.test(copied[0]), 'PDF 场景应复制 PDF 专用提示词,实际:' + copied[0].slice(0, 40));
});

test('选一个 GBK 编码的 txt:文字正确进输入框,并说明按什么编码解的', async () => {
    const { run, elements } = await import('./helpers/vm-harness.mjs').then(h => h.loadApp({
        sandboxExtras: {
            // ⚠️ 这个类是**宿主 realm** 的(定义在测试文件里),它的方法看不到沙箱全局,
            //    所以字节直接写死在这里,不能引用沙箱里的变量(踩过:__gbk is not defined)。
            FileReader: class {
                readAsArrayBuffer() {
                    // GBK 字节("题目：1+1 等于几"):用平台解码器反查得到,已核对
                    this.result = Uint8Array.from([0xCC, 0xE2, 0xC4, 0xBF, 0xA3, 0xBA,
                        0x31, 0x2B, 0x31, 0x20, 0xB5, 0xC8, 0xD3, 0xDA, 0xBC, 0xB8]).buffer;
                    this.onload({ target: { result: this.result } });
                }
            },
        },
    }));
    run('init()');
    run(`handleFileSelect({ target: { files: [{ name: '题目.txt' }] } })`);
    assert.strictEqual(String(run(`pasteInput.value`)), '题目：1+1 等于几', 'GBK 文本要解对');
    const status = String(elements['import-status'].textContent);
    assert.ok(/GB18030/.test(status), '要说明按什么编码解的,实际:' + status);
    assert.ok(String(elements['import-status'].className).includes('success'));
});

test('「🤖 AI 整理输入框」:AI 接口整理 → 结果入输入框 → 解析后逐题带 AI 生成标记;手动编辑即失效', async () => {
    const { run, store, elements } = await import('./helpers/vm-harness.mjs').then(h => h.loadApp({
        sandboxExtras: {
            fetch: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: AI_TEXT } }] }) }),
            AbortController,
        },
    }));
    store.set('aiConfig', JSON.stringify(CFG));
    run(`init()`);
    run(`pasteInput.value = '一坨乱原文'`);
    await run(`(async () => { await rescueAiOrganize(); })()`);
    assert.ok(String(run(`pasteInput.value`)).includes('1+1等于几'), '输入框应为 AI 整理结果');
    run(`parsePastedText()`);
    assert.strictEqual(run(`previewData.length`), 2);
    assert.strictEqual(run(`previewData[0].aiNote`), 'AI 生成');
    run(`pasteInput.value = '1. 手写题 A.甲 B.乙 答案：A'`);
    elements['paste-input']._listeners.input();
    run(`parsePastedText()`);
    assert.strictEqual(run(`previewData[0].aiNote`), '');
});

test('「🤖 AI 整理输入框」运行中:按钮仍然可点(再点一次 = 取消),绝不许 disable', async () => {
    // 🚨 回归(👤 2026-09-14 报"「🤖 整理中…（点击取消）」点了没反应,并不能取消"):
    //    被 disabled 的按钮**不再派发 click 事件**,而文案写着"点击取消" → 取消永远点不到。
    //    ⚠️ 这个 bug 单元测试本来抓不到:桩子不看 disabled,`_listeners.click()` 照样能调到监听器。
    //    所以这条测试断的是**契约**——"运行中按钮不许是 disabled,忙态只能用类表示"。
    let signal = null;
    const { run, store, elements } = await import('./helpers/vm-harness.mjs').then(h => h.loadApp({
        sandboxExtras: {
            AbortController,
            // 卡住不返回的 fetch;abort 时 reject 一个 AbortError(与真实 fetch 同款行为)
            fetch: (url, opts) => new Promise((resolve, reject) => {
                signal = opts && opts.signal;
                if (signal) signal.addEventListener('abort', () => reject(new DOMException('信号已中止', 'AbortError')));
            }),
        },
    }));
    store.set('aiConfig', JSON.stringify(CFG));
    run(`init()`);
    run(`pasteInput.value = '一坨乱原文'`);
    const pending = run(`(async () => { await rescueAiOrganize(); })()`);   // 故意不 await:停在请求里
    await new Promise((r) => setImmediate(r));                              // 让 async 函数跑到 await

    const btn = elements['rescue-ai-btn'];
    assert.strictEqual(btn.disabled, false,
        '运行中**不许** disable —— 被 disabled 的按钮收不到 click,"点击取消"就成了空话');
    assert.strictEqual(btn._classes.has('is-busy'), true, '运行中应打 .is-busy 表示"正在进行"');
    assert.strictEqual(btn.getAttribute('aria-busy'), 'true', '无障碍上也标成忙态');
    assert.ok(/点击取消/.test(String(btn.textContent)), '文案要写明再点一次就能取消,实际:' + btn.textContent);

    // 再点一次 = 取消
    btn._listeners.click();
    await pending;
    assert.ok(signal && signal.aborted === true, '取消必须真的把 abort 信号发出去');
    assert.strictEqual(btn._classes.has('is-busy'), false, '取消后要去掉忙态');
    assert.strictEqual(btn.getAttribute('aria-busy'), null, 'aria-busy 也要摘掉');
    assert.strictEqual(String(btn.textContent), '🤖 AI 整理输入框', '取消后按钮文案复原');
    assert.ok(/已取消/.test(String(elements['import-status'].textContent)),
        '状态行要说"已取消",实际:' + elements['import-status'].textContent);
});

test('统一导入管道回归:PDF 能读就读进输入框,读不准按原因提示;.doc 双路不混;委托可用', async () => {
    const { onePagePdf, buildPdf } = await import('./helpers/pdf-fixture.mjs');
    const textPdf = onePagePdf('BT /F1 12 Tf 72 720 Td (Question: 1+1?) Tj T* (A. 1) Tj T* (B. 2) Tj T* (Answer: B) Tj ET');
    const scanned = onePagePdf('BT /F1 12 Tf ET');
    const encrypted = buildPdf([
        { num: 1, dict: '<< /Type /Catalog /Pages 2 0 R >>' },
        { num: 2, dict: '<< /Type /Pages /Kids [] /Count 0 >>' },
    ], { encrypt: true });
    // ⚠️ 字节要**以纯数组**过沙箱:vm 上下文里 Uint8Array 是另一个 realm 的构造器,
    //    直接塞 Buffer 进去 instanceof 会判假(跨 realm 的经典坑)
    const { run, elements, alerts } = await import('./helpers/vm-harness.mjs').then(h => h.loadApp({
        sandboxExtras: {
            __pdfBytes: {
                text: [...new Uint8Array(textPdf)],
                scanned: [...new Uint8Array(scanned)],
                encrypted: [...new Uint8Array(encrypted)],
            },
        },
    }));
    run(`init()`);
    const notice = elements['import-status'];
    const pick = (name, key) => `handleFileSelect({ target: { files: [{ name: ${JSON.stringify(name)}, arrayBuffer: async () => new Uint8Array(__pdfBytes.${key}) }] } })`;
    const settle = () => new Promise(r => setTimeout(r, 30));

    // ① 文字版 PDF → 抽出的文字进输入框(与 txt/docx 同一条路)
    run(pick('卷子.pdf', 'text'));
    await settle();
    assert.ok(String(run(`pasteInput.value`)).includes('Question: 1+1?'),
        'PDF 文字应进输入框,实际输入框:' + JSON.stringify(String(run(`pasteInput.value`))) + ' / 状态行:' + String(notice.textContent).slice(0, 120));
    assert.strictEqual(run(`previewData.length`), 0, '读取本身不触发预览');
    assert.ok(String(notice.className).includes('success'), '状态行应报成功');
    assert.ok(String(notice.textContent).includes('PDF 已读出'), '状态行要说清是 PDF 读出来的:' + String(notice.textContent).slice(0, 60));

    // ② 扫描件(抽不到文字)→ 按原因提示:AI 提取入口 + 隐私说明 + 不用 AI 的路
    run(pick('扫描.pdf', 'scanned'));
    await settle();
    const scanNotice = String(notice.innerHTML);
    assert.ok(scanNotice.includes('图片'), '要说清"这是图片,读不出文字",实际:' + scanNotice.slice(0, 80));
    assert.ok(scanNotice.includes('file-ai-copy-btn'), '要给 AI 提取的入口');
    assert.ok(scanNotice.includes('上传给该 AI 服务'), '要让用户知道材料会上传');
    assert.ok(scanNotice.includes('提取文字') || scanNotice.includes('选中复制'), '还要给不用 AI 的路');

    // ③ 加密 PDF → 明说密码,且**不给** AI 按钮(聊天 AI 也读不了加密件)
    run(pick('加密.pdf', 'encrypted'));
    await settle();
    const encNotice = String(notice.innerHTML);
    assert.ok(encNotice.includes('密码'), '要说清有密码保护,实际:' + encNotice.slice(0, 80));
    assert.ok(/不加密的副本|权限密码/.test(encNotice), '要给出"另存为不加密副本"这条可执行的路(很多文件只是权限密码)');
    // 🚨 标题与错误消息是同一句话时不许重复渲染(线上实测出现过"这份 PDF 有密码保护这份 PDF 有密码保护…")
    // ⚠️ 必须看 innerHTML:桩元素的 textContent 与 innerHTML 是两本账(showFileNotice 只写 innerHTML)
    assert.strictEqual(encNotice.split('有密码保护').length - 1, 1, '同一句话不许出现两次:' + encNotice.slice(0, 90));
    assert.ok(!encNotice.includes('file-ai-copy-btn'), '加密件不该给 AI 提取按钮');

    // ④ .doc 仍然两路,且不出现 AI 按钮
    run(`handleFileSelect({ target: { files: [{ name: '试卷.doc' }] } })`);
    const docNotice = String(notice.innerHTML);
    assert.ok(!docNotice.includes('file-ai-copy-btn'), '.doc 不应出现 AI 提取按钮');
    assert.ok(docNotice.includes('另存为') && docNotice.includes('.docx'), '① 必须是转格式');
    assert.ok(docNotice.includes('选中文字'), '② 必须是复制文字');

    // ⑤ 委托还活着:点 AI 提取按钮要有反馈
    run(`lastRawContent = '旧的残留原文'`);
    notice._listeners.click({ target: { id: 'file-ai-copy-btn' } });
    await new Promise(r => setTimeout(r, 0));
    assert.ok(String(elements['import-status'].textContent).length > 0, '点击后必须有状态反馈');
    run(`pasteInput.value = ''`);
    run(`parsePastedText()`);
    assert.ok(alerts.length === 0);
});

test('预览全选三态:未全勾→点一次全勾;再点→全不选;部分选中→indeterminate', async () => {
    const { run, elements } = await import('./helpers/vm-harness.mjs').then(h => h.loadApp());
    run(`init()`);
    run(`Q3b = ['1. 甲题 A.一 B.二 答案：A', '2. 乙题 A.一 B.二 答案：B', '3. 丙题(缺答案)']`);
    run(`openImportPreview(parseQuestionsText(Q3b.join(String.fromCharCode(10))))`);
    const all = elements['preview-select-all'];
    assert.strictEqual(run(`previewData.filter(i => i.include).length`), 2);
    assert.strictEqual(all.indeterminate, true);
    assert.strictEqual(all.checked, false);
    all._listeners.change();
    assert.strictEqual(run(`previewData.every(i => i.include)`), true);
    assert.strictEqual(all.checked, true);
    assert.strictEqual(all.indeterminate, false);
    all._listeners.change();
    assert.strictEqual(run(`previewData.some(i => i.include)`), false);
    assert.strictEqual(all.checked, false);
    run(`previewData[0].include = true; renderPreview()`);
    assert.strictEqual(all.indeterminate, true);
});

test('暗色模式:三档切换打 data-theme、持久化、auto 跟随系统', async () => {
    const { run, store, elements } = await import('./helpers/vm-harness.mjs').then(h => h.loadApp({
        sandboxExtras: {
            document: { documentElement: { dataset: {} } },  // 沙箱补 html 元素
            matchMedia: () => ({ matches: true, addEventListener() {} }),  // 系统暗色
        },
    }));
    run(`init()`);
    // auto + 系统暗 → dark
    assert.strictEqual(run(`document.documentElement.dataset.theme`), 'dark');
    // 手动选亮 → light 且持久
    run(`setThemeSetting('light')`);
    assert.strictEqual(run(`document.documentElement.dataset.theme`), 'light');
    assert.strictEqual(store.get('themeSetting'), 'light');
    // 手动选暗
    run(`setThemeSetting('dark')`);
    assert.strictEqual(run(`document.documentElement.dataset.theme`), 'dark');
    // 回 auto → 跟随系统(暗)
    run(`setThemeSetting('auto')`);
    assert.strictEqual(run(`document.documentElement.dataset.theme`), 'dark');
    // 👤 2026-09-14:三格分段控件收成**一个**简约键,点一下换一档(自动 → 亮 → 暗 → 自动)
    assert.strictEqual(run(`cycleThemeSetting()`), 'light', '自动 → 亮');
    assert.strictEqual(run(`document.documentElement.dataset.theme`), 'light');
    assert.strictEqual(run(`cycleThemeSetting()`), 'dark', '亮 → 暗');
    assert.strictEqual(run(`document.documentElement.dataset.theme`), 'dark');
    assert.strictEqual(run(`cycleThemeSetting()`), 'auto', '暗 → 自动(回到循环起点)');
    assert.strictEqual(run(`document.documentElement.dataset.theme`), 'dark', 'auto 档跟随系统(暗)');
    assert.strictEqual(store.get('themeSetting'), 'auto', '每一档都要落盘');
});

test('导入按钮职责分离回归:选文件即读进框;解析按钮单监听纯解析;清空复位一切', async () => {
    const { run, elements, alerts } = await import('./helpers/vm-harness.mjs').then(h => h.loadApp({
        sandboxExtras: {
            // 同步版 FileReader:构造即回调 onload
            // 同步版 FileReader:构造即回调 onload。⚠️ bank.js 现在用 readAsArrayBuffer
            //    (要按字节自己解码,GBK/编码识别 —— 见 src/decode.js),桩必须跟着提供它。
            FileReader: class {
                readAsArrayBuffer() {
                    this.result = new TextEncoder().encode('1. 试卷题 A.甲 B.乙 答案：A').buffer;
                    this.onload({ target: { result: this.result } });
                }
            },
        },
    }));
    run(`init()`);
    run(`handleFileSelect({ target: { files: [{ name: '期试卷.txt' }] } })`);
    // 选完即读:文字应已在输入框,来源标签待用
    assert.ok(String(run(`pasteInput.value`)).includes('试卷题'), '选文件后文字应立即进输入框');
    assert.strictEqual(run(`previewData.length`), 0, '读取本身不触发预览');
    // 点解析(按钮监听=parsePastedText) → 出预览
    elements['paste-parse-btn']._listeners.click();
    assert.strictEqual(run(`previewData.length`), 1);
    // 解析按钮:确认只挂了一个监听且指向解析
    const parseBtn = elements['paste-parse-btn'];
    const listeners = parseBtn._listeners ? Object.keys(parseBtn._listeners) : [];
    assert.strictEqual(listeners.filter(k => k === 'click').length, 1, '解析按钮只允许一个 click 监听');
    // 清空:复位输入框与 AI 标记
    run(`pasteInput.value = '有内容'; aiSourcedContent = true`);
    run(`clearPasteInput()`);
    assert.strictEqual(run(`pasteInput.value`), '');
    assert.strictEqual(String(elements['import-status'].className), 'status-line');
    assert.ok(alerts.length === 0);
});

test('AI 标记持久化:确认导入后 aiSource=ai 写进题库数据(编辑器可见的前提)', async () => {
    const { run, store, elements } = await import('./helpers/vm-harness.mjs').then(h => h.loadApp({
        sandboxExtras: {
            fetch: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: AI_TEXT } }] }) }),
            AbortController,
        },
    }));
    store.set('aiConfig', JSON.stringify(CFG));
    run(`init()`);
    run(`pasteInput.value = '一坨乱原文'`);
    await run(`(async () => { await rescueAiOrganize(); })()`);
    run(`parsePastedText()`);
    run(`previewTargetBankSelect.value = '__new__'`);
    run(`previewConfirmBtn__fake = true`);
    run(`prompt = () => 'AI测试库'`);
    run(`commitPreviewImport()`);
    assert.strictEqual(run(`questionBanks['AI测试库'][0].aiSource`), 'ai');
    // 对照:非 AI 路径导入的题不带标记
    run(`openImportPreview(parseQuestionsText('1. 普通题 A.甲 B.乙 答案：A'))`);
    run(`previewTargetBankSelect.value = 'AI测试库'`);
    run(`commitPreviewImport()`);
    assert.strictEqual(run(`questionBanks['AI测试库'].some(q => q.content === '普通题' && q.aiSource)`), false);
});

test('编辑器:AI 题人工保存后消标;待修题说明行随状态切换', async () => {
    const { run, store, elements } = await import('./helpers/vm-harness.mjs').then(h => h.loadApp({
        sandboxExtras: {
            fetch: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: AI_TEXT } }] }) }),
            AbortController,
        },
    }));
    store.set('aiConfig', JSON.stringify(CFG));
    run(`init()`);
    run(`pasteInput.value = '一坨乱原文'`);
    await run(`(async () => { await rescueAiOrganize(); })()`);
    run(`parsePastedText()`);
    run(`prompt = () => 'AI测试库'`);
    run(`previewTargetBankSelect.value = '__new__'`);
    run(`commitPreviewImport()`);
    run(`editBank('AI测试库')`);
    assert.strictEqual(run(`questionBanks['AI测试库'][0].aiSource`), 'ai');
    // 人工保存 → aiSource 消除
    run(`editorStem.value = '人工改过的题'; editorType.value = '判断'; editorAnswer.value = 'A'`);
    run(`editorSaveCurrent(true)`);
    assert.strictEqual(run(`questionBanks['AI测试库'][0].aiSource`), undefined);
    // 待修题(导入一题缺答案) → 说明行走橙字分支
    run(`openImportPreview(parseQuestionsText('1. 缺答案的题 A.甲 B.乙'))`);
    run(`previewData[0].include = true; renderPreview()`);
    run(`previewTargetBankSelect.value = 'AI测试库'`);
    run(`commitPreviewImport()`);
    run(`editBank('AI测试库')`);
    run(`state.editIndex = 2; renderBankEditor()`);
    const note = String(elements['editor-ai-note'].innerHTML);
    assert.ok(note.includes('缺答案'), '待修题要有橙色说明');
});

test('历史标记日志:AI 题人工保存后转"曾AI整理";待补题补答后转"曾待补";仅 × 删除', async () => {
    let noAns = false;  // 宿主侧开关:第二次 AI 调用返回无答案输出
    const h = await import('./helpers/vm-harness.mjs').then(m => m.loadApp({
        sandboxExtras: {
            fetch: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: noAns ? '题目：AI整理但仍无答案\nA：甲\nB：乙' : AI_TEXT } }] }) }),
            AbortController,
        },
    }));
    const { run, store, elements } = h;
    store.set('aiConfig', JSON.stringify(CFG));
    run(`init()`);
    run(`pasteInput.value = '一坨乱原文'`);
    await run(`(async () => { await rescueAiOrganize(); })()`);
    run(`parsePastedText()`);
    run(`previewTargetBankSelect.value = '__new__'`);
    run(`prompt = () => '史库'`);
    run(`commitPreviewImport()`);
    // 补一题缺答案进来,人工补答 → pending 历史
    run(`openImportPreview(parseQuestionsText('1. 待补的题 A.甲 B.乙'))`);
    run(`previewData[0].include = true; renderPreview()`);
    run(`previewTargetBankSelect.value = '史库'`);
    run(`commitPreviewImport()`);
    run(`editBank('史库')`);
    run(`state.editIndex = 2; renderBankEditor()`);
    // 人工补答保存 → 待补标记消散 → 转历史
    run(`editorStem.value = '待补的题'; editorType.value = '判断'; editorAnswer.value = 'A'`);
    run(`editorSaveCurrent(true)`);
    assert.strictEqual(run(`questionBanks['史库'][2].answer`), 'A');
    const marks = h.run(`JSON.stringify(questionBanks['史库'][2].histMarks || [])`);
    assert.ok(marks.includes('pending'), '消散的待补要进历史日志');
    assert.ok(String(elements['editor-hist-row'].innerHTML).includes('曾待补'), '出现"曾待补"chip');
    assert.ok(String(elements['editor-hist-row'].innerHTML).includes('data-hist-del'), 'chip 带 × 删除');
    // 双状态并存:AI 整理但仍缺答案 → 紫橙两行同时显示(第二次 B 路线,输出故意无答案行)
    noAns = true;
    run(`pasteInput.value = '再来一坨乱原文'`);
    await run(`(async () => { await rescueAiOrganize(); })()`);
    run(`parsePastedText()`);
    run(`previewData[0].include = true; renderPreview()`);
    run(`previewTargetBankSelect.value = '史库'`);
    run(`commitPreviewImport()`);
    run(`editBank('史库')`);
    run(`state.editIndex = 3; renderBankEditor()`);
    const both = String(elements['editor-ai-note'].innerHTML);
    assert.ok(both.includes('AI 整理导入') && both.includes('缺答案'), '双状态要两行提示都显示');
    // AI 题人工保存 → ai 标记消散转历史
    run(`state.editIndex = 0; renderBankEditor()`);
    run(`editorType.value = '判断'; editorAnswer.value = 'A'`);
    run(`editorSaveCurrent(true)`);
    const marks0 = h.run(`JSON.stringify(questionBanks['史库'][0].histMarks || [])`);
    assert.ok(marks0.includes('"ai"'), '消散的 AI 标记要进历史日志');
    assert.ok(String(elements['editor-hist-row'].innerHTML).includes('曾 AI 整理'), '出现"曾 AI 整理"chip');
    // × 删除对应条目
    h.elements['editor-hist-row']._listeners.click({ target: { dataset: { histDel: '0' }, id: 'x' } });
    const after = h.run(`JSON.stringify(questionBanks['史库'][0].histMarks || [])`);
    assert.ok(!after.includes('"ai"'), '× 删除对应历史条目');
});


test('错题卡上的收藏按钮:★/☆ 文案与数据互通(走库卡内嵌面板的真实渲染路径)', async () => {
    const { run, sandbox } = await import('./helpers/vm-harness.mjs').then(h => h.loadApp());
    run(`init()`);
    run(`errorQuestions = [{ content: '易错题一', type: '单选', options: {A:'甲',B:'乙'}, answer: 'A', userAnswer: 'B', bankName: '错题源' }]`);
    // ⚠️ 断言必须走**生产里真正在跑的**渲染路径。
    // 历史教训:这条用例原先调 updateErrorsList() —— 那是独立列表页的渲染,
    // 该页面早已下线(#errors-list 不在 index.html),测试桩会自动建出容器,
    // 于是"测试一直绿着,代码却永不执行"(2026-09-11 已清掉那段死代码)。
    const mark = sandbox.__created.length;
    run(`renderErrorsForBank('错题源')`);
    const btn = () => sandbox.__created.slice(mark)
        .filter(c => c.tag === 'BUTTON' && String(c.el.className).includes('question-card-fav'))
        .pop();
    assert.strictEqual(String(btn().el.textContent), '☆ 收藏', '未收藏时应显示 ☆ 收藏');
    // 点它 → 入收藏夹(与刷题页共用同一 toggleFavorite,按题干匹配)
    btn().el._listeners.click();
    assert.strictEqual(run(`favoriteQuestions.length`), 1);
    assert.strictEqual(run(`favoriteQuestions[0].content`), '易错题一');
    // 重绘后文案应变 ★(按钮文案由渲染时按 isFav 生成)
    const mark2 = sandbox.__created.length;
    run(`renderErrorsForBank('错题源')`);
    const btn2 = sandbox.__created.slice(mark2)
        .filter(c => c.tag === 'BUTTON' && String(c.el.className).includes('question-card-fav')).pop();
    assert.strictEqual(String(btn2.el.textContent), '★ 已收藏', '收藏后应显示 ★ 已收藏');
    // 再点 → 取消收藏
    btn2.el._listeners.click();
    assert.strictEqual(run(`favoriteQuestions.length`), 0);
});

test('按库内嵌(P0-1.9):错题/收藏按 bankName 归入库卡手风琴;杂项兜底;遮挡默认藏答案', async () => {
    const { run, elements } = await import('./helpers/vm-harness.mjs').then(h => h.loadApp());
    run(`init()`);
    run(`questionBanks['史库'] = [{ content: '库内题', type: '单选', options: { A: '甲', B: '乙' }, answer: 'A' }]`);
    run(`errorQuestions = [
        { content: '史库错题', type: '单选', options: { A: '甲', B: '乙' }, answer: 'A', userAnswer: 'B', bankName: '史库', analysis: '因为甲' },
        { content: '孤儿错题', type: '单选', options: { A: '甲', B: '乙' }, answer: 'A', userAnswer: 'B', bankName: '已删除的库' },
    ]`);
    run(`favoriteQuestions = [{ content: '史库收藏', type: '单选', options: { A: '甲', B: '乙' }, answer: 'A', bankName: '史库' }]`);
    run(`updateBanksList()`);
    // 遮挡:错题条目里没有直接的"正确答案"文字(details 内不算外层文本)
    const frag = run(`renderErrorsForBank('史库')`);
    assert.ok(frag, '史库有错题面板');
    // 遮挡:错题条目存在 details/summary("查看答案"),且渲染树顶层不含正确答案文字
    const created = run(`__created`);
    const summary = created.filter(c => c.tag === 'SUMMARY' && String(c.el.textContent).includes('查看答案'));
    assert.ok(summary.length >= 1, '遮挡由 details/summary 承载');
    // 杂项兜底
    run(`updateBanksList()`);
    const created2 = run(`__created`);
    assert.ok(created2.some(c => c.tag === 'H3' && String(c.el.textContent).includes('杂项')), '孤儿错题归入杂项卡');
});

test('重命名题库同步错题/收藏归属(不漂进杂项)', async () => {
    const { run } = await import('./helpers/vm-harness.mjs').then(h => h.loadApp());
    run(`init()`);
    run(`questionBanks['旧名'] = [{ content: '题', type: '单选', options: { A: '甲', B: '乙' }, answer: 'A' }]`);
    run(`errorQuestions = [{ content: '题', type: '单选', options: { A: '甲', B: '乙' }, answer: 'A', userAnswer: 'B', bankName: '旧名' }]`);
    run(`favoriteQuestions = [{ content: '题', type: '单选', options: { A: '甲', B: '乙' }, answer: 'A', bankName: '旧名' }]`);
    run(`state.currentRenameBank = '旧名'`);
    run(`renameBankNameInput.value = '新名'`);
    run(`renameBank()`);
    assert.strictEqual(run(`errorQuestions[0].bankName`), '新名');
    assert.strictEqual(run(`favoriteQuestions[0].bankName`), '新名');
    assert.strictEqual(run(`!!questionBanks['新名']`), true);
});

test('回收站:删库打包题+错+藏;恢复完整(同名自动改名);彻底删除;LRU 上限 10', async () => {
    const { run, store } = await import('./helpers/vm-harness.mjs').then(h => h.loadApp());
    run(`init()`);
    run(`questionBanks['要删的库'] = [{ content: '题1', type: '单选', options: { A: '甲', B: '乙' }, answer: 'A' }]`);
    run(`errorQuestions = [{ content: '错1', type: '单选', options: {}, answer: 'A', userAnswer: 'B', bankName: '要删的库' }]`);
    run(`favoriteQuestions = [{ content: '藏1', type: '单选', options: {}, answer: 'A', bankName: '要删的库' }]`);
    run(`state.currentBankName = '要删的库'; questionBank = questionBanks['要删的库']`);
    run(`confirm = () => true`);
    run(`deleteBank('要删的库')`);
    assert.strictEqual(run(`!!questionBanks['要删的库']`), false);
    const bin = JSON.parse(store.get('recycledBanks'));
    assert.ok(bin['要删的库'], '入站');
    assert.strictEqual(bin['要删的库'].errors.length, 1);
    assert.strictEqual(bin['要删的库'].favorites.length, 1);
    assert.strictEqual(run(`errorQuestions.length`), 0);
    // 恢复:无同名 → 原名回归,错/藏合并回
    run(`restoreRecycled('要删的库')`);
    assert.strictEqual(run(`!!questionBanks['要删的库']`), true);
    assert.strictEqual(run(`errorQuestions[0].bankName`), '要删的库');
    assert.strictEqual(run(`favoriteQuestions.length`), 1);
    // 再次删除后,若同名库已重建 → 恢复自动改名避免覆盖
    run(`deleteBank('要删的库')`);
    run(`questionBanks['要删的库'] = []`);
    run(`restoreRecycled('要删的库')`);
    assert.strictEqual(run(`!!questionBanks['要删的库·恢复']`), true);
    // LRU:塞 11 条,最旧被淘汰
    for (let i = 0; i < 11; i++) run(`recycleBankEntry('库${i}', { bank: [] })`);
    const bin2 = JSON.parse(store.get('recycledBanks'));
    assert.ok(Object.keys(bin2).length <= 10, '上限 10 条');
});

test('导航一致性:hash 已相同时也能切换(navigate 不再依赖 hashchange)', async () => {
    const { run, elements, sandbox } = await import('./helpers/vm-harness.mjs').then(h => h.loadApp({
        sandboxExtras: { location: { hash: '#quiz' } },
    }));
    run(`init()`);
    // hash 已是 #quiz,再点「题库」→ hash 变 #banks,视图应切到题库
    run(`navigate('banks')`);
    assert.strictEqual(run(`location.hash`), '#banks');
    // hash 已是 #banks,再点「题库」→ 不产生 hashchange,但视图仍需切到题库
    run(`navigate('banks')`);
    assert.strictEqual(run(`location.hash`), '#banks');
});

test('题库页只负责管理:库卡不再有「开始刷题」,刷题入口统一在刷题页', async () => {
    const { run } = await import('./helpers/vm-harness.mjs').then(h => h.loadApp());
    run(`init()`);
    run(`questionBanks['T'] = [{ content: '题', type: '单选', options: { A: '甲', B: '乙' }, answer: 'A' }]`);
    run(`updateBanksList()`);
    const created = run(`__created`);
    const startBtns = created.filter(c => String(c.el.textContent).includes('开始刷题'));
    assert.strictEqual(startBtns.length, 0, '库卡不应再有「开始刷题」(它属于刷题页)');
    // 编辑入口仍在(题库页的职责)
    const editBtns = created.filter(c => String(c.el.textContent).includes('编辑'));
    assert.ok(editBtns.length >= 1, '库卡应保留「编辑」入口');
});

test('错题条目渲染:题型在题干前、选项裸露、不泄露用户错选、判断题显对错', async () => {
    const { run } = await import('./helpers/vm-harness.mjs').then(h => h.loadApp());
    run(`init()`);
    run(`questionBanks['T'] = [{ content: '选择题', type: '单选', options: { A: '甲甲甲', B: '乙乙乙' }, answer: 'A' }]`);
    run(`errorQuestions = [
        { content: '选择题', type: '单选', options: { A: '甲甲甲', B: '乙乙乙' }, answer: 'A', userAnswer: 'B', bankName: 'T' },
        { content: '判断题', type: '判断', options: { A: '正确', B: '错误' }, answer: 'A', userAnswer: 'B', bankName: 'T' },
    ]`);
    run(`expandedBanks['err:T'] = true`);   // 错题面板需展开才渲染
    run(`updateBanksList()`);
    const created = run(`__created`);

    // ① 题型标在题干之前
    const types = created.filter(c => /^［.+］$/.test(String(c.el.textContent)));
    assert.ok(types.length >= 2, '题型标应存在(［单选］/［判断］)');

    // ② 选项裸露(错题复盘要能看到选项)
    const optionLines = created.filter(c => String(c.el.className).includes('error-options'));
    assert.ok(optionLines.length >= 2, '选择题与判断题都应列出选项');

    // ③ 折叠态不得泄露用户错选:题型行不得出现"你答"
    const typeTexts = created
        .filter(c => String(c.el.className).includes('error-type-line'))
        .map(c => String(c.el.textContent));
    assert.ok(typeTexts.every(t => !t.includes('你答')), '题型行不得带"你答"');

    // ④ 判断题答案显示对错而非 A/B
    const revealTexts = created
        .filter(c => String(c.el.className).includes('correct-answer') || String(c.el.className).includes('your-answer'))
        .map(c => String(c.el.textContent));
    assert.ok(revealTexts.some(t => t.includes('对')), '判断题正确答案应显示"对"');
    assert.ok(!revealTexts.some(t => /答案[：:]\s*[AB]\s*$/.test(t)), '不得显示裸 A/B');
});

// ==================== 接口地址安全校验(安全审计 §4.3)====================
// 背景:请求会带 `Authorization: Bearer <API Key>` 发往 baseUrl —— 填谁就等于把 Key 交给谁。
// 从他人处抄来一份含"自定义地址"的配置,Key 就会被发到对方服务器。
// (aiBaseUrlProblem / chatCompletion 已在文件顶部 import)

test('接口地址校验:明文 http 拒绝,https 与本机 http 放行', () => {
    assert.strictEqual(aiBaseUrlProblem('https://api.deepseek.com/v1'), null, 'https 应放行');
    assert.ok(aiBaseUrlProblem('http://api.example.com/v1'), '公网明文 http 应拒绝(Key 会裸奔)');
    assert.strictEqual(aiBaseUrlProblem('http://localhost:8080/v1'), null, '本机调试应放行');
    assert.strictEqual(aiBaseUrlProblem('http://127.0.0.1:11434/v1'), null, '本机(127.0.0.1)应放行');
    assert.strictEqual(aiBaseUrlProblem('http://[::1]:8080/v1'), null, '本机(IPv6 回环)应放行');
});

test('接口地址校验:格式错误与非 http(s) 协议都要拒绝', () => {
    assert.ok(aiBaseUrlProblem(''), '空地址应拒绝');
    assert.ok(aiBaseUrlProblem('api.example.com/v1'), '缺协议头应拒绝(不是完整网址)');
    assert.ok(aiBaseUrlProblem('file:///etc/passwd'), 'file:// 应拒绝');
    assert.ok(aiBaseUrlProblem('data:text/plain,hi'), 'data: 应拒绝');
});

test('出口守卫:地址不安全时绝不发起请求(Key 连发都不发出去)', async () => {
    let called = false;
    const spy = async () => { called = true; return { ok: true, json: async () => ({}) }; };
    await assert.rejects(
        () => chatCompletion({ baseUrl: 'http://evil.example.com/v1', apiKey: 'sk-xxx', model: 'm' },
            [{ role: 'user', content: 'hi' }], { fetchImpl: spy }),
        /接口地址不安全/,
    );
    assert.strictEqual(called, false, '地址不安全时不得调用 fetch(否则 Key 已经泄漏了)');
});

test('出口守卫不误伤正常 https 地址', async () => {
    let url = '';
    const spy = async (u) => { url = u; return { ok: true, json: async () => ({ choices: [{ message: { content: 'OK' } }] }) }; };
    const out = await chatCompletion({ baseUrl: 'https://api.deepseek.com/v1/', apiKey: 'sk-x', model: 'deepseek-chat' },
        [{ role: 'user', content: 'hi' }], { fetchImpl: spy });
    assert.strictEqual(out, 'OK');
    assert.strictEqual(url, 'https://api.deepseek.com/v1/chat/completions', '应正常拼接路径(并去掉尾斜杠)');
});

test('表单侧也走同一套校验(设置面板里填 http 会被拦住)', async () => {
    // 保存与「测试连接」都先经 collectAiConfigFromForm():它在 aiConfigReady 之后校验地址。
    // 这里直接驱动表单元素 + saveAiSettings(),断言"只加了校验函数却没接线"这种情况会被抓住。
    // (saveAiSettings 是同步的,返回 false 表示被拦下未保存)
    const { run, store, elements } = await import('./helpers/vm-harness.mjs').then(h => h.loadApp());
    run(`init()`);
    // 表单里填一个明文 http 地址
    elements['ai-provider-select'].value = 'custom';
    elements['ai-base-url'].value = 'http://evil.example.com/v1';
    elements['ai-api-key'].value = 'k-test';
    elements['ai-model-input'].value = 'm';
    const saved = run(`saveAiSettings()`);
    assert.strictEqual(saved, false, '明文 http 地址应被拦下,不保存');
    assert.ok(!/evil\.example\.com/.test(store.get('aiConfig') || ''), '不安全地址不得落盘');
    assert.ok(String(elements['ai-test-status'].textContent).includes('不安全') ||
              String(elements['ai-test-status'].textContent).includes('https'),
        '应给出可读的拒绝原因,实际:' + elements['ai-test-status'].textContent);
    // 换成合法 https 地址 → 应能保存
    elements['ai-base-url'].value = 'https://api.example.com/v1';
    assert.strictEqual(run(`saveAiSettings()`), true, '合法 https 地址应能保存');
    assert.ok(/api\.example\.com/.test(store.get('aiConfig') || ''), '合法地址应落盘');
});

// ⚠️ `await btn._listeners.click()` **不会**等监听器内部的 async 流程 —— 它返回 undefined,
//    于是断言在 AI 结果落盘前就跑了(踩过:"填不进去"其实是没等)。故轮询等待条件成立。
// ⚠️ 等待条件要选"**只会在终态出现**"的信号:editorAiAnswer 会先同步写"⏳ 正在补…",
//    再异步填值 —— 若等"提示非空",第一帧就满足,等于没等(踩过第二次)。
// 造一组"表单里的选项输入"喂给桩:editorCollectOptions 靠 querySelectorAll 读它们。
// 不注入的话它恒返回 {},编辑器保存/补答案都会被判成"没选项" —— 那是桩的限制,不是产品 bug。
function feedEditorOptions(elements, pairs) {
    elements['editor-options']._setQueryAll(pairs.map(([letter, value]) => {
        const inp = { dataset: { letter }, value, disabled: false };
        return inp;
    }));
}
async function waitFor(fn, { timeoutMs = 2000, label = '条件' } = {}) {
    const t0 = Date.now();
    for (;;) {
        if (fn()) return true;
        if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时:${label}`);
        await new Promise(r => setTimeout(r, 5));
    }
}

// ==================== P1-1.3 / P1-1.4:两个 UI 入口的编排与落库 ====================
// 这一层用 vm 桩驱动真实 UI 流程(勾选 → 点按钮 → 合并 → 预览/表单),验证"接线"没问题。

test('P1-1.3 预览「✍️ AI 补答案·解析」:只补缺的题、标 AI 拟答、已有答案不动', async () => {
    const calls = [];
    const { run, store, elements } = await import('./helpers/vm-harness.mjs').then(h => h.loadApp({
        sandboxExtras: {
            fetch: async (url, init) => {
                const body = JSON.parse(init.body);
                calls.push(body.messages);
                // 回显每题的题干与选项,答案给 ABD
                const echoed = body.messages[1].content.split('\n\n')
                    .map(b => b + '\n答案：ABD\n解析：AI 补的解析').join('\n\n');
                return { ok: true, json: async () => ({ choices: [{ message: { content: echoed } }] }) };
            },
            AbortController,
        },
    }));
    store.set('aiConfig', JSON.stringify(CFG));
    run(`init()`);
    // 三题:①全缺 ②有答案缺解析 ③全齐
    // ⚠️ 别用 `const src = ...` 再另起一次 run():run() 的表达式模式带 `return (...)`、
    //    语句模式又是独立作用域,局部 const 不会跨调用留存(踩过:ReferenceError src is not defined)
    run(`openImportPreview(parseQuestionsText('题目：甲题 A：x B：y\\n题目：乙题 A：x B：y\\n答案：A\\n题目：丙题 A：x B：y\\n答案：B\\n解析：人工解析'))`);
    assert.strictEqual(run(`previewData.length`), 3, '应解析出三题');
    run(`previewData.forEach(i => i.include = true); renderPreview()`);

    elements['preview-ai-answer-btn']._listeners.click();
    await waitFor(() => run(`previewData[0].q.answer`) === 'ABD', { label: '预览补答案完成' });
    assert.strictEqual(calls.length, 1, '应发出一次请求(三题一块)');
    const sent = calls[0][1].content;
    assert.ok(/无法确定/.test(calls[0][0].content), 'system 必须是模式二提示词(允许给答案)');
    assert.ok(!sent.includes('答案：A'), '已有答案的题内容不得被送出(避免被改写)');
    // ① 全缺的题:补上答案与解析,并打 AI 拟答徽章
    assert.strictEqual(run(`previewData[0].q.answer`), 'ABD');
    assert.strictEqual(run(`previewData[0].q.answerSource`), 'ai');
    assert.strictEqual(run(`previewData[0].q.analysisSource`), 'ai');
    assert.ok(/AI 拟答/.test(run(`previewData[0].aiNote`)), '预览要标出"AI 拟答"');
    assert.strictEqual(run(`previewData[0].aiAnswer`), true, '供预览高亮用的标记');
    // ② 有答案缺解析:答案一字不动,只补解析
    assert.strictEqual(run(`previewData[1].q.answer`), 'A', '已有答案绝不被覆盖');
    assert.strictEqual(run(`previewData[1].q.answerSource`), undefined, '答案没被 AI 碰过 → 不该有 AI 标');
    assert.strictEqual(run(`previewData[1].q.analysisSource`), 'ai');
    // ③ 全齐的题:一点没动
    assert.strictEqual(run(`previewData[2].q.analysis`), '人工解析');
    assert.strictEqual(run(`previewData[2].q.analysisSource`), undefined);
    assert.strictEqual(run(`previewData[2].aiNote`), '', '全齐的题不该被标记');
});

test('P1-1.3 导入后 AI 来源落库(永久标注的前提)', async () => {
    const { run, store, elements } = await import('./helpers/vm-harness.mjs').then(h => h.loadApp({
        sandboxExtras: {
            fetch: async (url, init) => {
                const body = JSON.parse(init.body);
                const echoed = body.messages[1].content.split('\n\n').map(b => b + '\n答案：A\n解析：AI 解析').join('\n\n');
                return { ok: true, json: async () => ({ choices: [{ message: { content: echoed } }] }) };
            },
            AbortController,
        },
    }));
    store.set('aiConfig', JSON.stringify(CFG));
    run(`init()`);
    run(`questionBanks = { '目标库': [] }; questionBanks['目标库'] = []`);
    run(`openImportPreview(parseQuestionsText('题目：待补题 A：x B：y'))`);
    run(`previewData.forEach(i => i.include = true)`);
    elements['preview-ai-answer-btn']._listeners.click();
    await waitFor(() => run(`previewData[0].q.answer`) === 'A', { label: '预览补答案完成(mock 回 A)' });
    run(`previewTargetBankSelect.value = '目标库'`);
    run(`commitPreviewImport()`);
    const saved = JSON.parse(store.get('questionBanks'))['目标库'][0];
    assert.strictEqual(saved.answer, 'A');
    assert.strictEqual(saved.answerSource, 'ai', 'AI 拟答必须永久标注(否则下次打开就分不清是谁给的)');
    assert.strictEqual(saved.analysisSource, 'ai');
});

test('P1-1.4 编辑器「✍️ 补答案/解析」:填进草稿区并落 AI 标注;人改过则转人工', async () => {
    const { run, store, elements } = await import('./helpers/vm-harness.mjs').then(h => h.loadApp({
        sandboxExtras: {
            fetch: async (url, init) => {
                const body = JSON.parse(init.body);
                const echoed = body.messages[1].content + '\n答案：B\n解析：AI 给的理由';
                return { ok: true, json: async () => ({ choices: [{ message: { content: echoed } }] }) };
            },
            AbortController,
        },
    }));
    store.set('aiConfig', JSON.stringify(CFG));
    run(`init()`);
    run(`questionBanks['库'] = [{ content: '待补题', type: '单选', options: {A:'x',B:'y'}, answer: '', analysis: '' }]`);
    run(`state.editBankName = '库'; state.editIndex = 0; renderBankEditor()`);
    feedEditorOptions(elements, [['A', 'x'], ['B', 'y']]);
    assert.strictEqual(elements['editor-answer'].value, '', '前置:答案是空的');

    elements['editor-ai-answer-btn']._listeners.click();
    // 终态信号:提示里出现"AI 已填入"(⏳ 正在补… 是中间态,不能当等待条件)
    await waitFor(() => /AI 已填入/.test(String(elements['editor-ai-answer-note'].textContent)), { label: '编辑器补答案完成' });
    assert.strictEqual(elements['editor-answer'].value, 'B', 'AI 答案应填进草稿区(不直接落库)');
    assert.strictEqual(elements['editor-analysis'].value, 'AI 给的理由');
    assert.ok(String(elements['editor-ai-answer-note'].textContent).includes('AI'), '要提示"AI 已填入、未核验"');
    // 未保存 → 数据未变
    assert.strictEqual(run(`questionBanks['库'][0].answer`), '', '未点保存前不得落库');

    // 保存 → 落 AI 标注
    const saved = run(`editorSaveCurrent(true)`);
    assert.strictEqual(run(`questionBanks['库'][0].answer`), 'B');
    assert.strictEqual(run(`questionBanks['库'][0].answerSource`), 'ai');
    assert.strictEqual(run(`questionBanks['库'][0].analysisSource`), 'ai');

    // 第二次:AI 再补一题后人工改答案 → 该字段转人工(不打 AI 标)
    run(`questionBanks['库'].push({ content: '待补题2', type: '单选', options: {A:'x',B:'y'}, answer: '', analysis: '' })`);
    run(`state.editIndex = 1; renderBankEditor()`);
    feedEditorOptions(elements, [['A', 'x'], ['B', 'y']]);
    elements['editor-ai-answer-btn']._listeners.click();
    // ⚠️ 必须等 AI 流程**整条**结束再改表单:否则人的改动会被随后完成的 AI 回填覆盖,
    //    测试就会看到 AI 的 'B' 而不是人写的 'A'(踩过 —— 表现为"人改过却没转人工")。
    await waitFor(() => /AI 已填入/.test(String(elements['editor-ai-answer-note'].textContent)), { label: '第二次补答案完成' });
    elements['editor-answer'].value = 'A';   // 人把 AI 给的 B 改成 A

    run(`editorSaveCurrent(true)`);
    assert.strictEqual(run(`questionBanks['库'][1].answer`), 'A');
    assert.strictEqual(run(`questionBanks['库'][1].answerSource`), null, '人工改过的答案不得标成 AI');
    assert.strictEqual(run(`questionBanks['库'][1].analysisSource`), 'ai', '解析仍是 AI 给的 → 保留标注');
});

test('P1-1.4 全齐的题不浪费一次请求', async () => {
    let called = false;
    const { run, store, elements } = await import('./helpers/vm-harness.mjs').then(h => h.loadApp({
        sandboxExtras: { fetch: async () => { called = true; return { ok: true, json: async () => ({ choices: [] }) }; }, AbortController },
    }));
    store.set('aiConfig', JSON.stringify(CFG));   // 不种配置的话函数会在"未配置"处就返回,测不到本题意图
    run(`init()`);
    run(`questionBanks['库2'] = [{ content: '已齐', type: '单选', options: {A:'x',B:'y'}, answer: 'A', analysis: '有人工解析' }]`);
    run(`state.editBankName = '库2'; state.editIndex = 0; renderBankEditor()`);
    elements['editor-ai-answer-btn']._listeners.click();
    // 等提示出现终态文案(这题有答案有解析,函数会同步写入"无需补"后返回)
    await waitFor(() => String(elements['editor-ai-answer-note'].textContent).length > 0, { label: '得到提示' });
    assert.strictEqual(called, false, '已有答案与解析的题不该发请求');
    assert.ok(String(elements['editor-ai-answer-note'].textContent).includes('无需补'),
        '应给出可读提示,实际:' + elements['editor-ai-answer-note'].textContent);
});
