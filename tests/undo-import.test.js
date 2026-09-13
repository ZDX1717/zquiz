// 导入撤销/覆盖快照/预览防呆测试(vm 沙箱驱动 bank.js)
// 三组各自独立的 app 实例:必须用 describe 包裹 —— node:test 里同一层级的多个
// before 会在任何用例执行前全部跑完,若平铺会让后面的启动覆盖前面的状态。
import test, { describe, before } from 'node:test';
import assert from 'node:assert';
import { loadApp } from './helpers/vm-harness.mjs';

const mkQ = (content) => ({ content, type: '单选', options: { A: '甲', B: '乙' }, answer: 'A', confidence: 1, bankName: '刑法' });

describe('导入批次记录 + 「导入前」自动存版(👤 2026-09-13:撤销统一走版本记录)', () => {
    let run, elements, store;
    before(async () => {
        ({ run, elements, store } = await loadApp({ confirmResult: true }));

        run(`questionBanks = { '刑法': [${JSON.stringify(mkQ('OLD'))}] }; currentBankName = '刑法'; questionBank = questionBanks['刑法'];`);
        run(`errorQuestions = [{ ...${JSON.stringify(mkQ('NEW1'))}, userAnswer: 'B' }]; favoriteQuestions = [{ ...${JSON.stringify(mkQ('NEW2'))} }];`);
        run(`previewData = [
            { q: ${JSON.stringify(mkQ('NEW1'))}, include: true, warnings: [] },
            { q: ${JSON.stringify(mkQ('NEW2'))}, include: true, warnings: [] },
        ];`);
        elements['preview-target-bank'].value = '刑法';
        elements['preview-skip-dupes'].checked = true;
        elements['preview-overwrite'].checked = false;
        run('commitPreviewImport()');
    });

    test('导入成功且批次已记录(指纹 2 条,题库页信息栏刷新)', () => {
        assert.strictEqual(run(`questionBanks['刑法'].length`), 3);
        const batches = JSON.parse(store.get('importBatches'));
        assert.strictEqual(batches.length, 1);
        assert.strictEqual(batches[0].fingerprints.length, 2);
        assert.strictEqual(batches[0].bank, '刑法');
        // 批次记录现在只作**展示**(「上次导入:…」在题库页),不再承担撤销职责
        assert.ok(elements['last-import-info'].textContent.includes('刑法'));
    });

    test('导入**也**进版本记录:自动存了一版「导入前」,带题数与来源', () => {
        const versions = JSON.parse(run(`JSON.stringify(loadBankVersions()['刑法'] || [])`));
        assert.strictEqual(versions.length, 1, '导入前应自动存一版');
        assert.strictEqual(versions[0].action, '导入前');
        assert.strictEqual(versions[0].questions.length, 1, '存的是导入**前**的内容(1 题)');
        assert.strictEqual(versions[0].questions[0].content, 'OLD');
        assert.ok(versions[0].source, '版本条目要带来源,否则一列"导入前"认不出哪次是哪次');
    });

    test('恢复那一版 = 回到导入前;且恢复本身也可撤销(撤销栈)', () => {
        // 通过版本记录回退(这是 👤 定的统一入口)
        run('restoreBankVersion("刑法", 0)');
        assert.strictEqual(run(`questionBanks['刑法'].length`), 1);
        assert.strictEqual(run(`questionBanks['刑法'][0].content`), 'OLD');
        // 恢复会先自动存一版「恢复前自动存」,所以还能再退回来
        const versions = JSON.parse(run(`JSON.stringify(loadBankVersions()['刑法'] || [])`));
        assert.ok(versions.some(v => v.action === '恢复前自动存'), '恢复前应自动存一版(恢复可逆)');
        // 会话内撤销栈:一次撤销就回到导入后(3 题)的状态
        assert.strictEqual(run('editorUndo()'), true);
        assert.strictEqual(run(`questionBanks['刑法'].length`), 3, '撤销栈应能一步退回恢复之前');
        assert.strictEqual(run('editorRedo()'), true);
        assert.strictEqual(run(`questionBanks['刑法'].length`), 1, '重做回到恢复后的状态');
    });

    test('导入后手改过的题:版本记录照样能整库回退(不再有"半撤"这种状态)', () => {
        // ⚠️ 版本存在 localStorage 里(loadBankVersions 读的是它),不是 state 字段 —— 得直接清 store
        store.set('bankVersions', '{}');
        run(`questionBanks = { '刑法': [${JSON.stringify(mkQ('NEW1'))}] }; currentBankName = '刑法'; questionBank = questionBanks['刑法'];`);
        run(`pushBankVersion('刑法', '导入前', [], { source: '测试' })`);   // 导入前是空库
        run(`questionBanks['刑法'][0].content = 'NEW1-改'`);               // 用户手改
        run('restoreBankVersion("刑法", 0)');
        assert.strictEqual(run(`questionBanks['刑法'].length`), 0,
            '版本回退是整库回到那一刻 —— 手改也一并回退(这是它比"按指纹撤销"确定的地方)');
    });
});

describe('覆盖前快照与恢复', () => {
    let run, elements, store;
    before(async () => {
        ({ run, elements, store } = await loadApp({ confirmResult: true }));
        run(`questionBanks = { '英语': [${JSON.stringify(mkQ('OLD1'))}, ${JSON.stringify(mkQ('OLD2'))}] }; currentBankName = '英语'; questionBank = questionBanks['英语'];`);
        run(`previewData = [{ q: ${JSON.stringify(mkQ('REPLACED'))}, include: true, warnings: [] }];`);
        elements['preview-target-bank'].value = '英语';
        elements['preview-skip-dupes'].checked = true;
        elements['preview-overwrite'].checked = true;
        run('commitPreviewImport()');
    });

    test('覆盖导入成功且自动存"覆盖导入前"版本', () => {
        assert.strictEqual(run(`questionBanks['英语'].length`), 1);
        assert.strictEqual(run(`questionBanks['英语'][0].content`), 'REPLACED');
        const versions = JSON.parse(store.get('bankVersions'));
        assert.strictEqual(versions['英语'][0].action, '覆盖导入前');
        assert.strictEqual(versions['英语'][0].questions.length, 2);
    });

    test('恢复此版本:题库还原,当前内容先自动存版', () => {
        run(`restoreBankVersion('英语', 0)`);
        assert.strictEqual(run(`questionBanks['英语'].length`), 2);
        assert.strictEqual(run(`questionBanks['英语'][0].content`), 'OLD1');
        assert.strictEqual(store.get('overwriteSnapshot'), undefined);
    });
});

describe('预览防呆', () => {
    let run;
    before(async () => {
        ({ run } = await loadApp({ confirmResult: true }));
    });

    test('低置信度/缺答案题默认不勾选', () => {
        const good = mkQ('好题');
        const noAns = { ...mkQ('没答案'), answer: '', confidence: 0.1 }; // 真实形态:finalize 会因缺答案压低置信度
        run(`openImportPreview([${JSON.stringify(good)}, ${JSON.stringify(noAns)}]);`);
        assert.strictEqual(run('previewData[0].include'), true);
        assert.strictEqual(run('previewData[1].include'), false);
    });

    test('只保留无警告题(单向过滤,可手动勾回)', () => {
        const good = mkQ('好题');
        const noAns = { ...mkQ('没答案'), answer: '' };
        run(`openImportPreview([${JSON.stringify(good)}, ${JSON.stringify(noAns)}]);`);
        run(`previewData[1].include = true; keepCleanOnly();`);
        assert.strictEqual(run('previewData[0].include'), true);
        assert.strictEqual(run('previewData[1].include'), false);
    });
});

describe('版本记录:可删、不空存、挂在题库设置里(👤 2026-09-11)', () => {
    let run, store, sandbox, elements;
    before(async () => {
        ({ run, store, sandbox, elements } = await loadApp({ confirmResult: true }));
        run(`init()`);
    });

    test('删版本:列表少一条并落盘;删空了连键一起清掉', () => {
        run(`bankVersions = {}; questionBanks = { '甲库': [${JSON.stringify(mkQ('A'))}] }`);
        run(`pushBankVersion('甲库', '覆盖导入前', [${JSON.stringify(mkQ('X'))}])`);
        run(`pushBankVersion('甲库', '去重前', [${JSON.stringify(mkQ('Y'))}])`);
        assert.strictEqual(run(`loadBankVersions()['甲库'].length`), 2);
        // 删第 0 条(较早的那条)
        assert.strictEqual(run(`deleteBankVersion('甲库', 0)`), true);
        assert.strictEqual(run(`loadBankVersions()['甲库'].length`), 1);
        assert.strictEqual(run(`loadBankVersions()['甲库'][0].action`), '去重前', '删掉的应是指定下标那条');
        assert.strictEqual(JSON.parse(store.get('bankVersions'))['甲库'].length, 1, '应落盘');
        // 删掉最后一条 → 键一起清掉(不留空数组)
        run(`deleteBankVersion('甲库', 0)`);
        assert.ok(!('甲库' in run(`loadBankVersions()`)), '删空后不应留下空数组');
        // 越界与不存在的库:安全返回 false
        assert.strictEqual(run(`deleteBankVersion('甲库', 0)`), false);
        assert.strictEqual(run(`deleteBankVersion('没这库', 0)`), false);
    });

    test('版本随库名迁移(改个名,历史快照不该变成孤儿)', () => {
        run(`bankVersions = {}; questionBanks = { '旧库': [${JSON.stringify(mkQ('A'))}] }`);
        run(`pushBankVersion('旧库', '覆盖导入前', [${JSON.stringify(mkQ('X'))}])`);
        run(`pushBankVersion('旧库', '去重前', [${JSON.stringify(mkQ('Y'))}])`);
        elements['rename-bank-name'].value = '新库';
        run(`state.currentRenameBank = '旧库'; renameBank()`);   // 走真实重命名入口
        assert.strictEqual(run(`(loadBankVersions()['新库'] || []).length`), 2, '历史应跟着新库名走');
        assert.ok(!('旧库' in run('loadBankVersions()')), '旧键应清掉(不留孤儿)');
        assert.deepStrictEqual(
            JSON.parse(run(`JSON.stringify(loadBankVersions()['新库'].map(v => v.action))`)),
            ['覆盖导入前', '去重前'], '先后顺序按时间保持');
        assert.deepStrictEqual(
            JSON.parse(store.get('bankVersions'))['新库'].map(v => v.action),
            ['覆盖导入前', '去重前'], '应落盘');
    });

    test('版本迁移:目标库名已有历史则合并(不覆盖),且仍守每库 3 条上限', () => {
        run(`bankVersions = {}`);
        run(`pushBankVersion('旧', '旧1', []); pushBankVersion('旧', '旧2', []);`);
        run(`pushBankVersion('新', '新1', []); pushBankVersion('新', '新2', []);`);
        run(`questionBanks = { '旧': [${JSON.stringify(mkQ('A'))}] }`);
        elements['rename-bank-name'].value = '新';
        run(`state.currentRenameBank = '旧'; renameBank()`);
        const list = JSON.parse(run(`JSON.stringify((loadBankVersions()['新'] || []).map(v => v.action))`));
        assert.strictEqual(list.length, 3, '合并后仍只留 3 条(与 pushBankVersion 上限一致)');
        assert.ok(list.includes('新2') && list.includes('旧2'), '两边的历史都要在');
        assert.ok(!('旧' in run('loadBankVersions()')), '旧键应清掉');
    });

    test('去重:没有重复时不存版本(别让无意义的安全网占满 3 个槽)', () => {
        run(`bankVersions = {}`);
        run(`questionBanks = { '乙库': [${JSON.stringify(mkQ('P1'))}, ${JSON.stringify(mkQ('P2'))}] }`);
        run(`dedupBank('乙库')`);
        assert.strictEqual(run(`loadBankVersions()['乙库']`), undefined,
            '没有重复就不该产生版本(旧实现一进来就存版,空点一次也留一条)');
        // 真有重复时才存
        run(`questionBanks['乙库'].push(${JSON.stringify(mkQ('P1'))})`);
        run(`dedupBank('乙库')`);
        assert.strictEqual(run(`loadBankVersions()['乙库'].length`), 1);
        assert.strictEqual(run(`loadBankVersions()['乙库'][0].action`), '去重前');
    });

    test('版本面板在「题库设置」里渲染,每条都带恢复与删除', () => {
        run(`bankVersions = {}`);
        run(`questionBanks = { '丙库': [${JSON.stringify(mkQ('Q1'))}] }`);
        run(`pushBankVersion('丙库', '覆盖导入前', [${JSON.stringify(mkQ('Z1'))}])`);
        run(`state.editBankName = '丙库'; state.editIndex = 0; renderBankEditor()`);
        const mark = sandbox.__created.length;
        run(`renderBankEditor()`);
        const created = sandbox.__created.slice(mark);
        const rows = created.filter(c => String(c.el.className).includes('version-item'));
        assert.ok(rows.length >= 1, '版本面板应渲染出条目');
        const btns = created.filter(c => c.tag === 'BUTTON' && String(c.el.className).includes('version-del'));
        assert.ok(btns.length >= 1, '每条版本都要有删除键(👤 反馈的缺口)');
        const restore = created.filter(c => c.tag === 'BUTTON' && String(c.el.textContent).includes('恢复此版'));
        assert.ok(restore.length >= 1, '每条版本都要有恢复键');
        // 面板必须挂在题库设置容器里,而不是库卡上
        const admin = created.filter(c => String(c.el.className).includes('bank-versions-panel'));
        assert.ok(admin.length >= 1, '版本面板应渲染');
        assert.strictEqual(run(`document.getElementById('editor-bank-admin') ? 1 : 0`), 1);
    });
});

describe('删库后回收站立刻更新(👤 反馈的 bug)', () => {
    let run, store, elements, sandbox;
    before(async () => {
        ({ run, store, elements, sandbox } = await loadApp({ confirmResult: true }));
        run(`init()`);
    });

    test('删库:进回收站 + 计数与列表当场刷新(不用刷页面)', () => {
        run(`questionBanks = { '要删的库': [${JSON.stringify(mkQ('D1'))}, ${JSON.stringify(mkQ('D2'))}], '留下的库': [${JSON.stringify(mkQ('K1'))}] }`);
        run(`bankVersions = {}; bankColors = { '要删的库': 'blue' }`);
        elements['recycle-count'].textContent = '(0)';   // 先按"空回收站"起跑(不预热,免得依赖未挂钩子的函数)
        // 记录删库过程中新创建的元素:回收站条目会被重建 → 能观察到 renderRecycleBin 真的跑了
        const mark = sandbox.__created.length;
        run(`deleteBank('要删的库')`);
        const created = sandbox.__created.slice(mark);

        // ① 库里没了
        assert.ok(!('要删的库' in run(`questionBanks`)), '库应已删除');
        // ② 回收站里有了(题+错+藏整体打包)
        const bin = JSON.parse(store.get('recycledBanks'));
        assert.ok(bin['要删的库'], '应已进回收站');
        assert.strictEqual(bin['要删的库'].bank.length, 2, '题目应整体打包进回收站');
        // ③ **当场**刷新:回收站条目被重建 + 计数变了
        const recycleRows = created.filter(c => String(c.el.className).includes('recycle-item'));
        assert.ok(recycleRows.length >= 1,
            '删库后应重建回收站条目(旧实现漏了 renderRecycleBin,要刷页面才更新 —— 👤 反馈的 bug)');
        assert.strictEqual(elements['recycle-count'].textContent, '(1)', '回收站计数应当场变成 1');
        // ④ 顺带:配色不残留(库没了,按库名存的颜色也该清掉)
        assert.strictEqual(run(`Object.prototype.hasOwnProperty.call(bankColors, '要删的库')`), false,
            '删库应一并清掉它的卡片配色');
    });
});

// ==================== 编辑级撤销栈(👤 2026-09-13:会话内、内存、深度 50)====================
describe('编辑级撤销栈', () => {
    let run, elements, store;
    before(async () => {
        ({ run, elements, store } = await loadApp({ confirmResult: true }));
        store.set('bankVersions', '{}');
    });

    const fresh = (extra = '') => run(`questionBanks = { 'T': [${JSON.stringify(mkQ('甲'))}, ${JSON.stringify(mkQ('乙'))}] };
        currentBankName = 'T'; questionBank = questionBanks['T']; editBankName = 'T'; editIndex = 0;
        undoStack = []; redoStack = []; ${extra}`);

    test('改一道题:撤销回到旧内容,重做回到新内容(且不碰别的题)', () => {
        fresh();
        elements['editor-options']._setQueryAll([
            { dataset: { letter: 'A' }, value: '甲', disabled: false },
            { dataset: { letter: 'B' }, value: '乙', disabled: false },
        ]);
        run(`editorStem.value = '甲(改过)'; editorType.value = '单选'; editorAnswer.value = 'A'; editorSaveCurrent(true)`);
        assert.strictEqual(run(`questionBanks['T'][0].content`), '甲(改过)');
        assert.strictEqual(run('canUndo()'), true);
        assert.ok(/改第 1 题/.test(run('undoLabel()')), '标签要写清撤的是什么,实际:' + run('undoLabel()'));
        assert.strictEqual(run('editorUndo()'), true);
        assert.strictEqual(run(`questionBanks['T'][0].content`), '甲', '撤销应回到旧内容');
        assert.strictEqual(run(`questionBanks['T'][1].content`), '乙', '别的题不该被动');
        assert.strictEqual(run('editorRedo()'), true);
        assert.strictEqual(run(`questionBanks['T'][0].content`), '甲(改过)', '重做回到新内容');
    });

    test('原样保存不留步(不污染撤销栈)', () => {
        fresh();
        elements['editor-options']._setQueryAll([
            { dataset: { letter: 'A' }, value: '甲', disabled: false },
            { dataset: { letter: 'B' }, value: '乙', disabled: false },
        ]);
        run(`editorStem.value = '甲'; editorType.value = '单选'; editorAnswer.value = 'A'; editorSaveCurrent(true)`);
        assert.strictEqual(run('canUndo()'), false, '内容没变就不该记一步');
    });

    test('删题:撤销按原位放回;批量删是一次一步', () => {
        fresh();
        // 单题删(走批量删除的入口,只选中一道)
        run(`editorSelected.length = 0; editorSelected.push(questionBanks['T'][1]); editorBulkDelete()`);
        assert.strictEqual(run(`questionBanks['T'].length`), 1);
        assert.strictEqual(run('editorUndo()'), true);
        assert.deepStrictEqual(JSON.parse(run(`JSON.stringify(questionBanks['T'].map(q => q.content))`)), ['甲', '乙'],
            '撤销要把题放回**原来的位置**');
        // 批量删两道(先补一道)
        run(`questionBanks['T'].push(${JSON.stringify(mkQ('丙'))});`);
        run(`editorSelected.length = 0; editorSelected.push(questionBanks['T'][0], questionBanks['T'][1], questionBanks['T'][2]); editorBulkDelete()`);
        assert.strictEqual(run(`questionBanks['T'].length`), 0);
        assert.strictEqual(run('editorUndo()'), true);
        assert.strictEqual(run(`questionBanks['T'].length`), 3, '一次批量删除 = 一步撤销全回来');
    });

    test('新增题目:撤销移除、重做加回', () => {
        fresh();
        run('editorAddQuestion()');
        assert.strictEqual(run(`questionBanks['T'].length`), 3);
        assert.strictEqual(run('editorUndo()'), true);
        assert.strictEqual(run(`questionBanks['T'].length`), 2);
        assert.strictEqual(run('editorRedo()'), true);
        assert.strictEqual(run(`questionBanks['T'].length`), 3);
    });

    test('去重:一步撤销把删掉的重复题全拿回来', () => {
        run(`questionBanks = { 'D': [${JSON.stringify(mkQ('重复'))}, ${JSON.stringify(mkQ('重复'))}, ${JSON.stringify(mkQ('独一'))}] };
            currentBankName = 'D'; questionBank = questionBanks['D']; editBankName = 'D'; undoStack = []; redoStack = [];`);
        run('dedupBank("D")');
        assert.strictEqual(run(`questionBanks['D'].length`), 2);
        assert.strictEqual(run('editorUndo()'), true);
        assert.strictEqual(run(`questionBanks['D'].length`), 3, '去重也应能整体撤销');
        assert.strictEqual(run('editorRedo()'), true);
        assert.strictEqual(run(`questionBanks['D'].length`), 2);
    });

    test('栈语义:深度上限 50、新动作清空重做、库级操作清栈', () => {
        fresh();
        // 深度:塞 60 条
        run(`for (let i = 0; i < 60; i++) pushUndo({ label: 'x' + i, undo: () => {}, redo: () => {} })`);
        assert.strictEqual(run('undoStack.length'), 50, '超过上限要丢最旧的');
        // 新动作清空 redoStack
        run(`undoStack = []; redoStack = []; pushUndo({ label: 'a', undo: () => {}, redo: () => {} }); editorUndo();
             pushUndo({ label: 'b', undo: () => {}, redo: () => {} })`);
        assert.strictEqual(run('canRedo()'), false, '记了新动作之后就不该还能重做');
        // 库级操作清栈(条目会引用已不存在的库)
        run(`undoStack = []; redoStack = []; pushUndo({ label: 'z', undo: () => {}, redo: () => {} });`);
        run('clearUndo()');
        assert.strictEqual(run('canUndo()'), false);
        assert.strictEqual(run('canRedo()'), false);
    });

    test('撤销栈不落盘(刷新即清,跨会话回退靠版本记录)', () => {
        fresh();
        run(`pushUndo({ label: 'x', undo: () => {}, redo: () => {} })`);
        assert.strictEqual(run('canUndo()'), true);
        // 任何 localStorage 键里都不该出现撤销栈
        const keys = [...store.keys()];
        for (const k of ['undoStack', 'redoStack']) assert.ok(!keys.includes(k), `${k} 不该落盘`);
    });
});
