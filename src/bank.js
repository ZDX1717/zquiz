import { state } from './state.js';
import { finalizeQuestion, formatAnswerForDisplay, formatQuestionsForExport, normalizeAnswerString, parseQuestionsText, questionDedupKey, splitBankSections, bankSectionHeader, BANK_SECTION_RE } from './parser.js';
import { deleteBankVersion, renameBankVersions, VERSIONS_PER_BANK, saveToLocalStorage, loadImportBatches, recordImportBatch, loadOverwriteSnapshot, clearOverwriteSnapshot, loadBankVersions, pushBankVersion, loadCollapsedBanks, saveCollapsedBanks } from './storage.js';
import { downloadFile, hideModal, showModal } from './dom.js';
import { pushUndo, undo as undoStep, redo as redoStep, canUndo, canRedo, undoLabel, redoLabel, clearUndo, assignExact, cloneQuestion } from './undo.js';
import { docxToText } from './docx.js';
import { pdfToText } from './pdf.js';
import { decodeTextBytes, scoreText } from './decode.js';
import { OFFICIAL_PROMPT, PDF_EXTRACT_PROMPT, buildCopyText, copyText } from './prompt.js';
import { toggleFavorite } from './favorites.js';
import { aiConfigReady, aiFixQuestions, aiAnswerQuestions, aiBaseUrlProblem, aiFormatMaterial, aiMatchKey, aiDiffParts, buildAiNotes, getProvider, mergeAiAnswers, normalizeAiConfig, questionsNeedingAi, testConnection } from './ai.js';
import { isAiTested, loadAiConfig, loadRecycledBanks, markAiTested, purgeRecycledBank, recycleBank, restoreRecycledBank, saveAiConfig, saveRecycledBanks, recordAiUsage } from './storage.js';

// 本次预览的来源标签(撤销记录展示用),由导入入口设置
let previewSourceLabel = '导入';
// 最近一次导入的原始文本(粘贴内容或上传文档抽取结果),供"提示词+原文"一键合成
let lastRawContent = '';
// 文件填框后的待用来源标签(解析时转正,撤销记录展示用)
let pendingSourceLabel = '';
// 已成功填框的文件:再次点「解析并预览」直接解析输入框,不重读文件
let lastFilledFile = null;

// ==================== bank.js ====================
// 自动拆分自 main.js;依赖方向见各 import。


const fileInput = document.getElementById('file-input');
const importStatus = document.getElementById('import-status');
const questionBankSelect = document.getElementById('question-bank-select');
const banksList = document.getElementById('banks-list');
const createBankModal = document.getElementById('create-bank-modal');
const renameBankModal = document.getElementById('rename-bank-modal');
const newBankNameInput = document.getElementById('new-bank-name');
const renameBankNameInput = document.getElementById('rename-bank-name');
const pasteInput = document.getElementById('paste-input');
const importPreviewModal = document.getElementById('import-preview-modal');
const previewSummary = document.getElementById('preview-summary');
const previewSelectAll = document.getElementById('preview-select-all');
const previewSkipDupes = document.getElementById('preview-skip-dupes');
const previewList = document.getElementById('preview-list');
const previewTargetBankSelect = document.getElementById('preview-target-bank');
// 多题库导入(👤 要求:导出分库、导入自动认出来)
const previewMultiBanner = document.getElementById('preview-multi-banner');
const previewMultiBannerText = document.getElementById('preview-multi-text');
const previewTargetRow = document.getElementById('preview-target-row');
const previewOverwriteLabel = document.getElementById('preview-overwrite-label');
const previewModeInputs = Array.prototype.slice.call(document.querySelectorAll('input[name="preview-bank-mode"]'));
const previewOverwrite = document.getElementById('preview-overwrite');
const editBankModal = document.getElementById('edit-bank-modal');
const editBankTitle = document.getElementById('edit-bank-title');
const editorQuestionList = document.getElementById('editor-question-list');
const editorForm = document.getElementById('editor-form');
const editorEmpty = document.getElementById('editor-empty');
const editorStem = document.getElementById('editor-stem');
const editorType = document.getElementById('editor-type');
const editorAnswer = document.getElementById('editor-answer');
const editorOptions = document.getElementById('editor-options');
const editorAddOption = document.getElementById('editor-add-option');
const editorRemoveOption = document.getElementById('editor-remove-option');
const editorExplanation = document.getElementById('editor-explanation');
const editorAnalysis = document.getElementById('editor-analysis');
const recycleCount = document.getElementById('recycle-count');
const editorAiAnswerBtn = document.getElementById('editor-ai-answer-btn');
const bankColorPicker = document.getElementById('bank-color-picker');
// 编辑器重构后新增的元素(👤 2026-09-11)
const editorBody = document.querySelector('.editor-body');
const editorTabQuestion = document.getElementById('editor-tab-question');
const editorTabBank = document.getElementById('editor-tab-bank');
const editorTabQuestionCount = document.getElementById('editor-tab-question-count');
// 题目列表重构(👤 2026-09-12):筛选面板 / 批量操作栏 / 编辑卡片
const editorFilterToggle = document.getElementById('editor-filter-toggle');
const editorFilterPanel = document.getElementById('editor-filter-panel');
const editorFilterCount = document.getElementById('editor-filter-count');
const editorFilterClear = document.getElementById('editor-filter-clear');
const editorBulkBar = document.getElementById('editor-bulk-bar');
const editorBulkCount = document.getElementById('editor-bulk-count');
const questionCardModal = document.getElementById('question-card-modal');
const questionCardTitle = document.getElementById('question-card-title');
const questionCardPrev = document.getElementById('question-card-prev');
const questionCardNext = document.getElementById('question-card-next');
const editorUndoBtn = document.getElementById('editor-undo-btn');
const bankColorNote = document.getElementById('bank-color-note');
const editorAiAnswerNote = document.getElementById('editor-ai-answer-note');
const lastImportInfo = document.getElementById('last-import-info');
const copyPromptBtn = document.getElementById('copy-prompt-btn');
const viewAllBtn = document.getElementById('view-all-btn');
const viewWarnedBtn = document.getElementById('view-warned-btn');
const viewAllCount = document.getElementById('view-all-count');
const viewWarnedCount = document.getElementById('view-warned-count');
const promptToggleBtn = document.getElementById('prompt-toggle-btn');
const promptContent = document.getElementById('prompt-content');
// 按需提示区 = 「📋 复制提示词和题目」+ 一句说明(👤 2026-09-14:救援区整块删掉后收进状态行下方)。
// 平时 hidden(占 0 高度);解析不出题 / 没配 AI Key / AI 整理失败时才由 revealAiFallback() 一起露出来。
const aiFallback = document.getElementById('ai-fallback');
const aiFallbackNote = document.getElementById('ai-fallback-note');
// AI 设置与预览兜底
const aiSettingsBtn = document.getElementById('ai-settings-btn');
const rescueAiBtn = document.getElementById('rescue-ai-btn');
const aiSettingsModal = document.getElementById('ai-settings-modal');
const aiProviderSelect = document.getElementById('ai-provider-select');
const aiBaseUrl = document.getElementById('ai-base-url');
const aiApiKey = document.getElementById('ai-api-key');
const aiModelInput = document.getElementById('ai-model-input');
const aiTestStatus = document.getElementById('ai-test-status');
const aiTestBtn = document.getElementById('ai-test-btn');
const previewAiBtn = document.getElementById('preview-ai-btn');
const previewAiAnswerBtn = document.getElementById('preview-ai-answer-btn');
const previewAiCancelBtn = document.getElementById('preview-ai-cancel-btn');
const previewAiProgress = document.getElementById('preview-ai-progress');
const previewAiProgressFill = document.getElementById('preview-ai-progress-fill');
const previewAiProgressText = document.getElementById('preview-ai-progress-text');
// AI 兜底运行状态(模块级:取消控制器 + 防重入)
let previewAiAbort = null;
let previewAiRunning = false;
// 编辑器:AI 填入的草稿台账(值 → 保存时比对;人一改就视为人工内容,不打 AI 标)
let editorAiAnsweredAnswer = null;
let editorAiAnsweredAnalysis = null;
// 「🤖 AI 整理输入框」的运行状态;第二次点击 = 取消
let rescueAiAbort = null;
let rescueAiRunning = false;
// 输入框内容由 AI 接口生成(解析入预览时打 🤖 标记;手动编辑即失效)
let aiSourcedContent = false;

// 导入题目(按扩展名分流:txt 直读;docx 走零依赖抽取;.doc 明确引导另存)
// 文件选择即读取(0.9.1 重构):所有文件先变文字进输入框,人工过目可编辑,再点「解析并预览」;
// 读不了的(pdf/老版 doc)给两个具体动作:①复制提示词发给 AI ②转换格式/复制文字。
function readFileIntoBox(file) {
    const name = file.name.toLowerCase();

    if (name.endsWith('.pdf')) {
        lastRawContent = '';
        file.arrayBuffer()
            .then(buf => pdfToText(buf))
            .then(({ text, gate }) => {
                // 闸门说不行就不导入:扫描件/乱码硬塞进输入框,用户得逐题核对才发现问题,
                // 比"什么都没有"更害人 —— 这里给原因 + 两条替代路。
                if (!gate.ok) { showPdfNotice(gate.reason, gate.detail); return; }
                // 闸门给的"小毛病"提醒(如"个别字可能不对")不拦人,只写在状态行里
                const warn = gate.warn ? ` · ${gate.warn}` : '';
                fillBox(text, 'PDF 文档', {
                    status: (n) => `PDF 已读出 ${n} 字并填入输入框 · 版式可能与原文不同,核对后点「解析并预览」${warn}`,
                    warn: !!gate.warn,
                });
            })
            .catch(err => {
                const msg = err && err.message ? err.message : '文件可能损坏';
                showPdfNotice(/密码/.test(msg) ? 'encrypted' : (/不是 PDF/.test(msg) ? 'notpdf' : 'broken'), msg);
            });
        return;
    }
    if (name.endsWith('.doc') && !name.endsWith('.docx')) {
        lastRawContent = '';
        showLegacyDocNotice();
        return;
    }
    if (file === lastFilledFile && (pasteInput.value || '').trim()) {
        return parsePastedText();  // 已在框里(用户可能改过),点解析就是解析
    }

    // 文字进框(不自动解析:这一眼是人工审查抽取质量的机会)
    // ⚠️ 必须是**函数声明**(会提升),不能写成 `const fillBox = …`:
    //    PDF 分支在上面就 return 了,而它的 async 回调里要调 fillBox ——
    //    用 const 的话那个绑定永远没初始化,回调一跑就 TDZ 报
    //    "Cannot access 'fillBox' before initialization",表现是**状态行一直停在"正在读取…"**
    //    (没有报错弹窗、没有日志,只有异步回调静默失败 —— 这种坑只能靠"断言文字真的进了输入框"抓)
    // 状态文案默认一句到底;PDF 那条因为要提醒"版式可能不同",给自己一条完整句子
    // (拼在默认句子里会出现"……请核对——可直接编辑……"两个破折号连着的怪句子)
    function fillBox(text, label, opts = {}) {
        lastFilledFile = file;
        aiSourcedContent = false;
        pasteInput.value = text;
        lastRawContent = text;
        pendingSourceLabel = `文件：${file.name}`;
        hideFileNotice();
        const msg = opts.status
            ? opts.status(text.length)
            : `${label}已读出 ${text.length} 字并填入输入框——可直接编辑，点「解析并预览」继续`;
        showImportStatus(msg, opts.warn ? 'warning' : 'success');
    }

    if (name.endsWith('.docx')) {
        file.arrayBuffer()
            .then(buf => docxToText(buf))
            .then(text => fillBox(text, 'Word 文档'))
            .catch(err => showImportStatus(`docx 读取失败：${err && err.message ? err.message : '文件可能损坏'}。可改存为 .txt,或直接复制文字粘贴`, 'error'));
        return;
    }

    const reader = new FileReader();
    reader.onload = function(event) {
        // ⚠️ 必须按**字节**读、自己解码:`readAsText` 一律按 UTF-8 解,而中文 Windows 存的
        //    txt / csv 多是 GBK ⇒ 整篇乱码(👤 想法 P1-9 记的那条)。见 src/decode.js。
        const { text, encoding } = decodeTextBytes(event.target.result);
        if (scoreText(text) > 60) {
            // 二进制文件被改名成 .txt 之类:读出来是一堆控制字符,别往输入框里倒
            showImportStatus('这个文件不像文本文件,读出来是乱码 —— 换一个文件试试', 'warning');
            return;
        }
        if (encoding === 'utf-8') { fillBox(text, '文件'); return; }
        fillBox(text, '文件', {
            status: (n) => `文件已读出 ${n} 字 · 按 ${encoding.toUpperCase()} 解码 · 核对后点「解析并预览」`,
        });
    };
    reader.onerror = function() {
        showImportStatus('读取失败：文件读取出错', 'error');
    };
    reader.readAsArrayBuffer(file);
}


// 处理文件选择:按扩展名当场给出指引(PDF/doc 不可解析,第一时间说清替代路径)
export function handleFileSelect(event) {
    const file = event.target.files[0];
    if (!file) {
        setStatusNeutral();
        return;
    }
    const name = file.name.toLowerCase();
    if (name.endsWith('.doc') && !name.endsWith('.docx')) {
        showLegacyDocNotice();
    } else {
        // 选中即读:文字立刻进输入框,「解析并预览」按钮从此只有一个职责 = 解析
        showImportStatus(`正在读取 ${file.name}…`, 'success');
        readFileIntoBox(file);
    }
}


// 更新题库选择下拉框
export function updateBankSelect() {
    // 保存当前选中的值
    const currentValue = questionBankSelect.value;

    // 清空下拉框
    questionBankSelect.innerHTML = '<option value="all">全部题库</option>';

    // 添加所有题库选项
    Object.keys(state.questionBanks).forEach(bankName => {
        const option = document.createElement('option');
        option.value = bankName;
        option.textContent = bankName;
        questionBankSelect.appendChild(option);
    });

    // 恢复之前选中的值（如果还存在）
    if (currentValue && (currentValue === 'all' || state.questionBanks[currentValue])) {
        questionBankSelect.value = currentValue;
    }
}


// ==================== 官方提示词引导(解析失败的自救通道) ====================

// 展开/收起提示词全文(懒渲染)
export function togglePromptContent() {
    if (!promptContent.textContent) promptContent.textContent = OFFICIAL_PROMPT;
    promptContent.classList.toggle('hidden');
    promptToggleBtn.textContent = promptContent.classList.contains('hidden') ? '查看提示词 ▾' : '收起 ▴';
}

// ==================== 状态区(唯一反馈面:绿=成功 黄=注意 红=错误 灰=中性提示) ====================

// 中性提示:根据当前状态给出下一步指引
function setStatusNeutral() {
    if (!importStatus) return;
    const len = (pasteInput.value || '').trim().length;
    importStatus.textContent = len
        ? `已就绪:${len} 字,点「解析并预览」`
        : '还没有内容：粘贴文字，或点「选择文件」';
    importStatus.className = 'status-line';
}

// 选择文件场景的 HTML 引导(双选项等)也进状态行
function showFileNotice(html, type = 'warning') {
    if (!importStatus) return;
    importStatus.innerHTML = html;
    importStatus.className = 'status-line ' + type;
}
function hideFileNotice() {
    setStatusNeutral();
}

// PDF 读不准时的提示(`reason` 来自 pdf.js 的质量闸门或它抛出的错误)。
// ⚠️ 四种原因给的**替代路不一样**,不能一句"读不了"打包:
//   scanned 扫描件 → AI 提取图片文字,或系统自带的「提取文字」
//   fontmap 字体没映射 → 抽出来是乱码,同样走 AI 或阅读器导出文本
//   encrypted 有密码 → 聊天 AI 也读不了加密件,所以**不给 AI 按钮**,先解锁另存
//   notpdf/broken 不是 PDF 或已损坏 → 换文件,给 AI 兜底
function showPdfNotice(reason, detail) {
    const AI_BTN = '<div class="file-notice-actions"><button type="button" id="file-ai-copy-btn" class="action-btn secondary">📋 复制提示词，去豆包/Kimi 让 AI 提取</button></div>';
    const AI_STEPS = '<p class="file-notice-hint">① 点上方按钮复制提示词 → 打开豆包 / Kimi / DeepSeek 粘贴发送 → <b>它会让你把这份 PDF 发过去</b> → 发完它直接提取整理 → 把结果粘回输入框。注意:材料会上传给该 AI 服务。</p>';
    if (reason === 'encrypted') {
        // ⚠️ 这里**不重复 detail**:抛出的错误消息本身就是"这份 PDF 有密码保护…",
        //    和标题一模一样 —— 实测线上会渲染成"这份 PDF 有密码保护这份 PDF 有密码保护,先解锁…"
        showFileNotice(
            '<b>📄 这份 PDF 有密码保护</b>' +
            '<p class="file-notice-hint">① 用它打开:要密码就输密码;不用密码也能打开的话,说明只是「权限密码」,另存一份不加密的副本,再选那个副本。</p>' +
            '<p class="file-notice-hint">② 或者打开后直接选中文字复制,粘到输入框。</p>',
            'warning'
        );
        return;
    }
    if (reason === 'scanned') {
        showFileNotice(
            '<b>📄 这份 PDF 是图片,读不出文字</b>' +
            `<p class="file-notice-hint">${detail || ''}</p>` +
            AI_BTN + AI_STEPS +
            '<p class="file-notice-hint">② 不想用 AI:用手机截图或扫描 App 的「提取文字」,也可以直接在阅读器里选中复制。</p>',
            'warning'
        );
        return;
    }
    if (reason === 'overlay') {
        // 水印/叠加层:抽出来的文字与正文交错,分不开 → 别硬导入,给两条可走的路
        showFileNotice(
            '<b>📄 这份 PDF 里叠着水印或另一层文字</b>' +
            `<p class="file-notice-hint">${detail || ''}</p>` +
            AI_BTN +
            '<p class="file-notice-hint">① 点上方按钮复制提示词 → 发给豆包 / Kimi / DeepSeek → 它会让你把这份 PDF 发过去 → 发完它直接提取整理。注意:材料会上传给该 AI 服务。</p>' +
            '<p class="file-notice-hint">② 也可以在本机用「AI 整理成标准格式」试(需要先配 Key);或换一份没有水印的源文件。</p>',
            'warning'
        );
        return;
    }
    if (reason === 'fontmap') {
        showFileNotice(
            '<b>📄 这份 PDF 的字体没带文字映射</b>' +
            `<p class="file-notice-hint">${detail || ''}</p>` +
            AI_BTN + AI_STEPS +
            '<p class="file-notice-hint">② 不想用 AI:用 PDF 阅读器的「导出为文本」,或选中复制。</p>',
            'warning'
        );
        return;
    }
    showFileNotice(
        '<b>📄 这个文件读不出来</b>' +
        `<p class="file-notice-hint">${detail || '文件可能已损坏'}</p>` +
        '<p class="file-notice-hint">① 换一个版本或重新下载,再选一次。</p>' +
        AI_BTN +
        '<p class="file-notice-hint">② 也可以点上方按钮,把文件附给聊天 AI 试试提取。</p>',
        'warning'
    );
}

// 老版 .doc:AI 聊天也读不了 .doc,不存在"发给 AI"选项 → ① 另存为 .docx 重选 ② 直接复制文字。
function showLegacyDocNotice() {
    showFileNotice(
        '<b>📄 老版 .doc 不能直接读，两个办法：</b>' +
        '<p class="file-notice-hint">① <b>首选转格式</b>：用 Word / WPS 打开 → 另存为 <b>.docx</b> → 回来重新选择文件，文字会自动读进输入框。</p>' +
        '<p class="file-notice-hint">② <b>复制文字</b>：直接在 .doc 里选中文字，粘到输入框就行。</p>' +
        '<p class="file-notice-hint">提示：转成 .docx 后若格式仍乱，预览页的 AI 整理可一键清理；认不出题目就点「🤖 AI 整理输入框」。</p>',
        'warning'
    );
}

// 状态行内动态按钮的事件委托(innerHTML 重建不丢监听)
importStatus.addEventListener('click', (e) => {
    if (e && e.target && e.target.id === 'file-ai-copy-btn') copyOfficialPrompt(true);
});

// ⚠️ `forcePromptOnly` 用**严格等于 true** 判断,不用真值判断:这个函数曾经被裸挂成点击监听器,
//    事件对象(MouseEvent)一进来就被当成 true → 静默变成"只复制提示词"。严格判断 + 监听器包箭头,双保险。
export async function copyOfficialPrompt(forcePromptOnly) {
    const promptOnly = forcePromptOnly === true;
    // forcePromptOnly:PDF/doc 场景没有文字可合并,只要提示词(防止误合并上一次的原文)
    const material = promptOnly ? '' : ((pasteInput.value || '').trim() || lastRawContent);
    // ⚠️ 两条提示词分工不同:
    //   · 有原文(粘贴/文件读出来了但解析不出题)⇒ OFFICIAL_PROMPT + 原文;
    //   · **没有原文**(PDF 读不出文字,文件在用户手上)⇒ PDF_EXTRACT_PROMPT(不带材料):
    //     它先让 AI 索要文件,收到文件后直接提取整理(👤 2026-09-14 定的效果)。
    const prompt = promptOnly ? PDF_EXTRACT_PROMPT : OFFICIAL_PROMPT;
    const ok = await copyText(buildCopyText(prompt, material));
    if (ok) {
        copyPromptBtn.textContent = material
            ? `✓ 已复制提示词+题目(${material.length} 字)`
            : '✓ 已复制提示词';
        setTimeout(() => { copyPromptBtn.textContent = '📋 复制提示词和题目'; }, 2500);
        showImportStatus(material
            ? '已复制提示词+题目原文:整段粘贴给豆包 / Kimi / DeepSeek,把整理结果粘回这里'
            : '提示词已复制 —— 粘贴发给豆包 / Kimi / DeepSeek,它会先让你把 PDF 发过去;发完它就自己提取整理,把结果粘回输入框', 'success');
    } else {
        showImportStatus('复制失败:请长按提示词文字手动复制', 'error');
    }
}


// 露出按需提示区(复制提示词那条路)。解析失败 / 没配 Key / AI 整理失败时调用。
// ⚠️ 桩里没有 scrollIntoView,必须先 typeof 判一下;老浏览器不认 options,要能退回无参调用。
export function revealAiFallback() {
    if (!aiFallback || !aiFallback.classList) return;
    aiFallback.classList.remove('hidden');
    if (typeof aiFallback.scrollIntoView === 'function') {
        try { aiFallback.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
        catch (e) { aiFallback.scrollIntoView(); }
    }
}
function hideAiFallback() {
    if (aiFallback && aiFallback.classList) aiFallback.classList.add('hidden');
}


export function parsePastedText() {
    const text = pasteInput.value;
    if (!text.trim()) {
        showImportStatus('请先粘贴题目内容', 'error');
        return;
    }
    // 来源:文件填框的用文件名,纯粘贴用"粘贴导入"(撤销记录展示用)
    previewSourceLabel = pendingSourceLabel || '粘贴导入';
    pendingSourceLabel = '';
    const sections = splitBankSections(text);
    // ⚠️ 顺序要紧:先按分节标记切库,再逐节解析。否则 `# ===== 题库：甲 =====` 会被当成题目标题,
    //    所有库的题混进同一库(👤 反馈的 bug)。
    const multi = sections.length >= 2;
    const sectionsData = multi
        ? sections.map(sec => ({ name: sec.name, questions: parseQuestionsText(sec.text) }))
        : [];
    const importedQuestions = multi
        ? sectionsData.flatMap(sec => sec.questions.map(q => ({ q, bank: sec.name })))
        : parseQuestionsText(text);
    if (importedQuestions.length === 0) {
        // 🚨 解析不出来 = 一句话提示 + **把兜底路摊在眼前**(👤 2026-09-13 定的口径;2026-09-14 从"展开救援区"
        //    改成"露出按需提示区",因为救援区整块删了)。
        // ⚠️ 提示**不要**把按钮逐个念一遍:提示区就在下面、已经自动露出来,
        //    状态行再复述一遍只会变成一堵字(👤:"太啰嗦、重点不清楚")。状态行只负责"出了什么事 + 往哪走"。
        // ⚠️ 只点名一个按钮:复制提示词那条**就在下面刚露出来**,提示词里再念一遍 = 一堵字(👤 反复提过)
        showImportStatus('没认出题目 —— 用「AI 整理输入框」理顺后再点解析', 'error');
        revealAiFallback();
        return;
    }
    const aiSource = aiSourcedContent;
    aiSourcedContent = false;
    updatePreviewTargetBanks();
    if (multi) {
        // 只有真的解析出东西的库才算数(空节不进清单)
        const kept = sectionsData.filter(sec => sec.questions.length > 0);
        openImportPreview(importedQuestions.map(x => x.q), aiSource, {
            banks: kept.map(sec => ({ name: sec.name, count: sec.questions.length })),
            assign: importedQuestions.map(x => x.bank),
        });
    } else {
        openImportPreview(importedQuestions, aiSource);
    }
}


// 把剪贴板里的富文本 HTML 按块级元素拆成行（Word/网页/PDF 复制时保留结构）
export function htmlToLines(html) {
    if (typeof DOMParser === 'undefined') {
        // 无 DOMParser 环境的兜底
        return html.replace(/<[^>]+>/g, '\n').split('\n').map(s => s.trim()).filter(Boolean);
    }
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const lines = [];
    const BLOCK = new Set(['P', 'DIV', 'LI', 'TR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'BLOCKQUOTE']);
    const pushText = (t) => {
        const s = (t || '').replace(/\s+/g, ' ').trim();
        if (s) lines.push(s);
    };
    const walk = (node) => {
        for (const child of node.children) {
            const tag = child.tagName;
            if (tag === 'TR') {
                const cells = Array.from(child.children)
                    .map(td => (td.textContent || '').replace(/\s+/g, ' ').trim())
                    .filter(Boolean);
                if (cells.length) lines.push(cells.join(' '));
            } else if (tag === 'UL' || tag === 'OL' || tag === 'TABLE' || tag === 'THEAD' || tag === 'TBODY' || tag === 'TFOOT' ||
                       (BLOCK.has(tag) && child.querySelector('p, div, li, tr'))) {
                walk(child); // 容器元素继续下钻
            } else if (BLOCK.has(tag)) {
                pushText(child.textContent);
            }
            // 行内元素（span/b/i 等）的文本已包含在最近的块级祖先里
        }
    };
    walk(doc.body);
    if (lines.length === 0) {
        return (doc.body.textContent || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    }
    return lines;
}


// 显示导入状态:所有提示常驻显示,直到下一个动作覆盖它(绿色读不完的问题即此修)
// 中性态只在明确"回到起点"时出现(清空/读取完成后的初始指引)
export function showImportStatus(message, type) {
    if (!importStatus) return;
    importStatus.textContent = message;
    importStatus.className = 'status-line' + (type ? ' ' + type : '');
}


// 打开预览：questions 为解析结果数组
// 视图切换(双 tab):全部 / 问题题;只切换镜片,不动勾选
export function setPreviewView(warned) {
    state.previewFilterWarned = !!warned;
    renderPreview();
    updatePreviewSummary();
}

// ==================== AI 设置面板(0.9.0 · BYO key) ====================

// 设置面板状态行(.status-message 默认 display:none,必须带 success/error 类才可见)
function setAiTestStatus(message, type) {
    if (!aiTestStatus) return;
    aiTestStatus.textContent = message;
    aiTestStatus.className = 'status-message' + (type ? ' ' + type : '');
}

// 打开设置:把已存配置回填进表单(缺省按当前厂商预设)
export function openAiSettings() {
    const cfg = normalizeAiConfig(loadAiConfig());
    aiProviderSelect.value = cfg.providerId;
    aiBaseUrl.value = cfg.baseUrl;
    aiApiKey.value = cfg.apiKey;
    aiModelInput.value = cfg.model;
    setAiTestStatus('');
    showModal(aiSettingsModal);
}

// 厂商切换:自定义保留手填;预设厂商回填官方地址与默认模型(key 不动)
export function aiProviderChanged() {
    if (aiProviderSelect.value === 'custom') return;
    const p = getProvider(aiProviderSelect.value);
    aiBaseUrl.value = p.baseUrl;
    aiModelInput.value = p.model;
}

// 表单 → 配置;成功返回配置对象,不完整返回 null 并提示
function collectAiConfigFromForm() {
    const cfg = normalizeAiConfig({
        providerId: aiProviderSelect.value,
        baseUrl: aiBaseUrl.value,
        apiKey: aiApiKey.value,
        model: aiModelInput.value,
    });
    if (!aiConfigReady(cfg)) {
        setAiTestStatus('⚠ 接口地址、API Key、模型名都需要填写', 'error');
        return null;
    }
    // 🔒 地址校验:**填谁就等于把 API Key 交给谁**,故非 https 一律拦住(本机回环地址除外)
    const problem = aiBaseUrlProblem(cfg.baseUrl);
    if (problem) {
        setAiTestStatus('⚠ ' + problem, 'error');
        return null;
    }
    return cfg;
}

// 测试连接(不保存):极短消息往返验证 key/地址/模型;全程按钮禁用 + 状态可见
export async function testAiConnection() {
    const cfg = collectAiConfigFromForm();
    if (!cfg) return false;
    if (aiTestBtn) aiTestBtn.disabled = true;
    setAiTestStatus('⏳ 正在连接,请稍候(最多 15 秒)…', 'success');
    try {
        const r = await testConnection(cfg);
        markAiTested(cfg);
        updateAiSettingsBadge();
        setAiTestStatus(`✅ 连接成功（模型回复：${r.sample}）`, 'success');
        return true;
    } catch (e) {
        setAiTestStatus('❌ ' + e.message, 'error');
        return false;
    } finally {
        if (aiTestBtn) aiTestBtn.disabled = false;
    }
}

// 保存设置(存本机 localStorage)
export function saveAiSettings() {
    const cfg = collectAiConfigFromForm();
    if (!cfg) return false;
    saveAiConfig(cfg);
    updateAiSettingsBadge();
    setAiTestStatus('✅ 已保存到本机', 'success');
    setTimeout(() => hideModal(aiSettingsModal), 400);
    return true;
}

// 「⚙ AI 已连接 ✓」徽章:配置就绪且与最近一次测试成功的指纹一致才亮
export function updateAiSettingsBadge() {
    if (!aiSettingsBtn) return;
    const cfg = normalizeAiConfig(loadAiConfig());
    const ok = aiConfigReady(cfg) && isAiTested(cfg);
    const autoReady = aiConfigReady(cfg);   // 一键整理能不能跑,只看"配没配",与测没测无关
    aiSettingsBtn.textContent = ok ? '⚙ AI 已连接 ✓' : '⚙ AI 设置';
    aiSettingsBtn.classList.toggle('ai-connected', ok);
    // 按需提示区里的那句说明随 Key 状态换(👤 2026-09-14:按钮的逻辑与提示区的逻辑合成一处)——
    // 没配 Key 时说清"这条路不用配 Key 也能走",配好了就说清"结果要粘回哪"。
    // ⚠️ 判据用 aiConfigReady(**配没配好 Key**),不是开头的 ok(那是"配好且测通过"):
    //    "AI 整理输入框"能不能跑起来只取决于配没配,与测没测无关。
    if (aiFallbackNote) {
        aiFallbackNote.textContent = autoReady
            ? '也可以把提示词和题目发给豆包 / Kimi / DeepSeek，把整理结果粘回输入框'
            : '不用配 Key 也能用：发给豆包 / Kimi / DeepSeek，把整理结果粘回输入框';
    }
}

// ==================== 预览 AI 兜底(分块/进度/取消 → 复用预览确认管道) ====================

// 预览页 AI 兜底(0.9.1 重构):只整理**已勾选的题** —— 视图是镜片,勾选是真相。
// 勾选题序列化成官方格式分块发 AI → 解析回填 → 逐题 🤖 徽章写明改动;进度按"已整理 x/N 题"。
// ==================== 模式二:批量补答案·解析(P1-1.3)====================
// 与模式一的区别只有一件事:**模式一不许改内容,模式二可以给答案**。
// 因此这里的每一步都要守住"只补缺失、绝不覆盖":
//   ① 只把缺答案/缺解析的勾选题送去问;
//   ② 合并时只填空白(mergeAiAnswers 保证),已有答案连问都不问;
//   ③ 补上的字段打 answerSource/analysisSource = 'ai',导入时落库为永久标注。
export async function previewAiAnswerFill() {
    if (previewAiRunning) return;
    const checkedSlots = state.previewData
        .map((item, idx) => ({ item, idx }))
        .filter(({ item }) => item.include);
    if (checkedSlots.length === 0) {
        showPreviewAiText('先勾选要补答案的题(可用「问题题」视图快速定位缺答案的题)');
        return;
    }
    const todo = checkedSlots.filter(({ item }) => questionsNeedingAi([item.q]).length > 0);
    if (todo.length === 0) {
        showPreviewAiText('勾选的题都已带答案与解析,无需补');
        return;
    }
    const cfg = normalizeAiConfig(loadAiConfig());
    if (!aiConfigReady(cfg)) {
        alert('请先在「⚙ AI 设置」里配置服务商与 API Key(自带 key,仅存本机)');
        openAiSettings();
        return;
    }

    previewAiRunning = true;
    if (typeof AbortController !== 'undefined') previewAiAbort = new AbortController();
    const signal = previewAiAbort ? previewAiAbort.signal : undefined;
    if (previewAiAnswerBtn) previewAiAnswerBtn.disabled = true;
    if (previewAiCancelBtn) previewAiCancelBtn.classList.remove('hidden');
    if (previewAiProgress) previewAiProgress.classList.remove('hidden');
    if (previewAiProgressFill) previewAiProgressFill.style.width = '5%';
    if (previewAiProgressText) previewAiProgressText.textContent = `连接 AI…(共 ${todo.length} 题待补)`;

    try {
        const { questions: produced, total } = await aiAnswerQuestions(cfg, todo.map(({ item }) => item.q), {
            signal,
            onProgress: (done, t) => {
                if (previewAiProgressFill) previewAiProgressFill.style.width = Math.round(done / t * 100) + '%';
                if (previewAiProgressText) previewAiProgressText.textContent = `已补 ${done}/${t} 题`;
            },
        });
        if (previewAiProgressFill) previewAiProgressFill.style.width = '100%';
        // ⚠️ 合并会**就地改** todo 里的 q,而它们是 previewData 的同一对象引用 → 预览立即反映结果
        const r = mergeAiAnswers(todo.map(({ item }) => item.q), produced);
        recordAiUsage({ trigger: 'preview-answer', total, answerFilled: r.answerFilled, analysisFilled: r.analysisFilled, undetermined: r.undetermined });

        // 逐题打"AI 拟答"标记:预览里明确标出哪些字段是 AI 填的,确认前必须先看见
        const byContent = new Map();
        r.details.forEach(d => byContent.set(d.content, d.parts.join('，')));
        todo.forEach(({ item }) => {
            const note = byContent.get(item.q.content);
            if (!note) return;
            item.aiNote = '✍️ AI 拟答：' + note;
            item.aiAnswer = true;   // 供 renderPreview 高亮
        });

        renderPreview();
        let msg = `完成:补入答案 ${r.answerFilled} 题、解析 ${r.analysisFilled} 题`;
        if (r.undetermined) msg += `;${r.undetermined} 题 AI 说「无法确定」,已如实保留缺答案`;
        if (r.filled < total) msg += `;${total - r.filled} 题无需改动`;
        showPreviewAiText(msg + '。请逐题核对后再导入');
        if (previewSummary) previewSummary.textContent = `✍️ AI 补答案完成(${total} 题待补,已标 🤖 拟答),请确认后导入`;
    } catch (e) {
        recordAiUsage({ trigger: 'preview-answer', ok: false, total: todo.length, error: String(e.message || e).slice(0, 120) });
        if (e && /取消/.test(e.message)) {
            showPreviewAiText('已取消');
        } else {
            alert('AI 补答案失败：' + (e.message || e));
            showPreviewAiText('失败：' + String(e.message || e).slice(0, 60));
        }
        renderPreview();
    } finally {
        previewAiRunning = false;
        previewAiAbort = null;
        if (previewAiAnswerBtn) previewAiAnswerBtn.disabled = false;
        if (previewAiBtn) previewAiBtn.disabled = false;
        if (previewAiCancelBtn) previewAiCancelBtn.classList.add('hidden');
        setTimeout(() => { if (previewAiProgress) previewAiProgress.classList.add('hidden'); }, 2000);
    }
}

export async function previewAiFallback() {
    if (previewAiRunning) return;
    const checkedSlots = state.previewData
        .map((item, idx) => ({ item, idx }))
        .filter(({ item }) => item.include);
    if (checkedSlots.length === 0) {
        showPreviewAiText('先勾选要整理的题(可用「问题题」视图快速定位)');
        return;
    }
    const cfg = normalizeAiConfig(loadAiConfig());
    if (!aiConfigReady(cfg)) {
        alert('请先在「⚙ AI 设置」里配置服务商与 API Key(自带 key,仅存本机)');
        openAiSettings();
        return;
    }

    // 快照勾选题(用于按题号匹配回填与改动对比)
    const originals = checkedSlots.map(({ item }) => JSON.parse(JSON.stringify(item.q)));
    const total = originals.length;

    previewAiRunning = true;
    if (typeof AbortController !== 'undefined') previewAiAbort = new AbortController();
    const signal = previewAiAbort ? previewAiAbort.signal : undefined;
    if (previewAiBtn) previewAiBtn.disabled = true;
    if (previewAiCancelBtn) previewAiCancelBtn.classList.remove('hidden');
    if (previewAiProgress) previewAiProgress.classList.remove('hidden');
    if (previewAiProgressFill) previewAiProgressFill.style.width = '5%';
    if (previewAiProgressText) previewAiProgressText.textContent = `连接 AI…(共 ${total} 题)`;

    try {
        const { questions: parsed } = await aiFixQuestions(cfg, originals, {
            signal,
            onProgress: (done, t) => {
                if (previewAiProgressFill) previewAiProgressFill.style.width = Math.round(done / t * 100) + '%';
                if (previewAiProgressText) previewAiProgressText.textContent = `已整理 ${done}/${t} 题`;
            },
        });
        if (previewAiProgressFill) previewAiProgressFill.style.width = '100%';
        recordAiUsage({ trigger: 'preview-fix', total, aiQuestions: parsed.length });

        // 回填:题干+选项精确匹配 → 题干宽松匹配;匹配上的替换并写改动徽章
        const pool = originals.map(q => ({ q, used: false }));
        let replaced = 0, changed = 0;
        parsed.forEach(nu => {
            const hit = pool.find(p => !p.used && aiMatchKey(p.q) === aiMatchKey(nu))
                || pool.find(p => !p.used && p.q && aiMatchKey(p.q, true) === aiMatchKey(nu, true));
            if (!hit) return; // AI 多返回的题:不是用户勾选的内容,忽略
            hit.used = true;
            const slot = checkedSlots[pool.indexOf(hit)];
            const parts = aiDiffParts(hit.q, nu);
            if (parts.length) changed++;
            slot.item.q = nu;
            slot.item.aiNote = parts.length ? 'AI 修改：' + parts.join('，') : (slot.item.aiNote || '');
            replaced++;
        });
        // AI 没回的题:保留原样并明示,不让题目无声消失
        let missing = 0;
        pool.forEach((p, i) => {
            if (!p.used) {
                missing++;
                checkedSlots[i].item.aiNote = 'AI 未返回此题（保留原样）';
            }
        });

        renderPreview();
        let msg = `完成：AI 更新 ${replaced}/${total} 题，其中 ${changed} 题有改动（🤖 标记）`;
        if (missing) msg += `，${missing} 题 AI 未返回已保留原样`;
        showPreviewAiText(msg);
        if (previewSummary) previewSummary.textContent = `🤖 AI 整理完成（${total} 题已处理），请确认后导入`;
    } catch (e) {
        recordAiUsage({ trigger: 'preview-fix', ok: false, total, error: String(e.message || e).slice(0, 120) });
        if (e && /取消/.test(e.message)) {
            showPreviewAiText('已取消');
        } else {
            alert('AI 兜底失败：' + (e.message || e));
            showPreviewAiText('失败：' + String(e.message || e).slice(0, 60));
        }
        renderPreview();
    } finally {
        previewAiRunning = false;
        previewAiAbort = null;
        if (previewAiBtn) previewAiBtn.disabled = false;
        if (previewAiCancelBtn) previewAiCancelBtn.classList.add('hidden');
        setTimeout(() => { if (previewAiProgress) previewAiProgress.classList.add('hidden'); }, 2000);
    }
}

// 进度/结果文字(留在进度条旁,不随 renderPreview 刷掉)
function showPreviewAiText(text) {
    if (previewAiProgress) previewAiProgress.classList.remove('hidden');
    if (previewAiProgressText) previewAiProgressText.textContent = text;
}

// ==================== 「🤖 AI 整理输入框」:AI 接口整理原文 → 自动入输入框 ====================

// 手动编辑输入框即视为脱离 AI 生成状态(程序化赋值不触发 input,不受影响)
pasteInput.addEventListener('input', () => { aiSourcedContent = false; });

export async function rescueAiOrganize() {
    if (rescueAiRunning) {  // 第二次点击 = 取消
        if (rescueAiAbort) {
            rescueAiAbort.abort();
        } else {
            // 没有 AbortController 的旧环境:按钮文案答应过"点击取消",就得有句实话,不能装死
            showImportStatus('这次整理没法中途取消 —— 等它跑完,或刷新页面', 'warning');
        }
        return;
    }
    const material = (pasteInput.value || '').trim() || (lastRawContent || '').trim();
    if (!material) {
        showImportStatus('没有可整理的内容：先粘贴题目，或点「选择文件」', 'warning');
        return;
    }
    const cfg = normalizeAiConfig(loadAiConfig());
    if (!aiConfigReady(cfg)) {
        // 👤 2026-09-14:没配 Key 时**同时**把免费的那条路摊出来 —— 只弹设置面板等于把人堵在门口。
        showImportStatus('还没有配置 AI 接口：点标题栏中间的「⚙ AI 设置」配好再来,也可以直接复制提示词交给聊天 AI', 'warning');
        revealAiFallback();
        openAiSettings();
        return;
    }

    rescueAiRunning = true;
    if (typeof AbortController !== 'undefined') rescueAiAbort = new AbortController();
    const signal = rescueAiAbort ? rescueAiAbort.signal : undefined;
    // 🚨 运行中**绝不许 disable 这个按钮**(👤 2026-09-14 报"点了没反应,并不能取消"):
    //    被 disabled 的按钮**不再派发 click 事件**,而它的文案正写着"点击取消" —— 于是取消永远点不到。
    //    (单元测试里桩子不看 disabled,监听器照样能被调用,所以一直没暴露;真机上才现形。)
    //    正确做法:按钮始终可点,用 `.is-busy` 表示"正在进行";再点一次走上面的 abort 分支。
    if (rescueAiBtn) {
        rescueAiBtn.classList.add('is-busy');
        rescueAiBtn.setAttribute('aria-busy', 'true');
        rescueAiBtn.textContent = '🤖 整理中…（点击取消）';
    }
    showImportStatus('🤖 AI 整理中…', 'success');

    try {
        const { text, chunks } = await aiFormatMaterial(cfg, material, {
            signal,
            onProgress: (done, total) => showImportStatus(`🤖 AI 整理中 ${done}/${total} 块…再点一次按钮可取消`, 'success'),
        });
        const parsed = parseQuestionsText(text);
        recordAiUsage({ trigger: 'rescue-organize', chunks, aiQuestions: parsed.length });
        if (parsed.length === 0) {
            // 一键整理没结果 → 只能走手动那条路。⚠️ 提示区平时是收着的,
            // 这里必须**先把它露出来**再让文案去指它 —— 否则提示让用户"点复制提示词",
            // 而屏幕上根本没有那个按钮(文案与界面不一致的经典坑)。
            revealAiFallback();
            showImportStatus('AI 没整理出题目 —— 试试点「📋 复制提示词和题目」发给聊天 AI 整理', 'error');
            return;
        }
        // 结果替换输入框内容,标记 AI 生成;点解析后逐题带 🤖
        aiSourcedContent = true;
        lastFilledFile = null;
        pendingSourceLabel = '';
        pasteInput.value = text;
        lastRawContent = text;
        hideAiFallback();   // 整理成功 = 不用兜底了,提示区收回去(别让卡片一直挂着一段说明)
        showImportStatus(`✅ AI 已整理出 ${parsed.length} 题 · ${chunks} 块原文,已放进输入框 —— 过目后点「解析并预览」`, 'success');
    } catch (e) {
        if (e && /取消/.test(e.message)) {
            showImportStatus('已取消 AI 整理', 'warning');
        } else {
            // 同"没整理出题目"那一支:失败也只能走手动路 → 先把提示区露出来,再让文案指它
            revealAiFallback();
            showImportStatus('AI 整理失败：' + (e.message || e) + ' —— 可以用「📋 复制提示词和题目」发给聊天 AI', 'error');
        }
    } finally {
        rescueAiRunning = false;
        rescueAiAbort = null;
        if (rescueAiBtn) {
            rescueAiBtn.classList.remove('is-busy');
            rescueAiBtn.removeAttribute('aria-busy');
            rescueAiBtn.textContent = '🤖 AI 整理输入框';
        }
    }
}

// 清空输入框 + 复位文件选择与 AI 生成标记
export function clearPasteInput() {
    pasteInput.value = '';
    lastRawContent = '';
    aiSourcedContent = false;
    pendingSourceLabel = '';
    lastFilledFile = null;
    if (fileInput) fileInput.value = '';
    hideAiFallback();   // 回到初始态:提示区也跟着收起来(它只对"眼前这批文字"有意义)
    setStatusNeutral();
}

// 取消进行中的 AI 兜底
export function cancelPreviewAi() {
    if (previewAiAbort) {
        previewAiAbort.abort();
        if (previewSummary) previewSummary.textContent = '⛔ 已取消 AI 整理';
    }
}

export function openImportPreview(questions, aiSource = false, meta) {
    state.previewFilterWarned = false; // 新一批导入重置筛选
    // 预览防呆:缺答案/选项不足/低置信度(conf ≤ 0.6)的题默认不勾选,用户确认后可手动勾回
    // aiSource:整批来自 AI 接口整理 → 逐题 🤖 生成标记(AI 动过要留痕)
    // meta.banks/assign:「导出题库」那种**带分节标记**的文件 → 每个题库归到哪个库(list)
    state.previewData = questions.map((q, i) => ({
        q,
        include: (q.confidence || 0) > 0.6,
        warnings: [],
        aiNote: aiSource ? 'AI 生成' : '',
        bank: meta && meta.assign ? meta.assign[i] : null,
    }));
    state.previewBanks = (meta && meta.banks) || [];
    // 多题库文件默认**按题库分开导入**(👤 要的就是这个);单库文件没有这回事
    state.previewBankMode = state.previewBanks.length >= 2 ? 'separate' : 'merge';
    renderPreview();
    showModal(importPreviewModal);
}

// 切换「按题库分别导入 / 全部并入一个题库」
export function setPreviewBankMode(mode) {
    if (!state.previewBanks || state.previewBanks.length < 2) return;
    state.previewBankMode = mode === 'merge' ? 'merge' : 'separate';
    renderPreview();
}


export function updatePreviewTargetBanks() {
    previewTargetBankSelect.innerHTML = '';
    Object.keys(state.questionBanks).forEach(name => {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = `${name}（${(state.questionBanks[name] || []).length} 题）`;
        previewTargetBankSelect.appendChild(opt);
    });
    const newOpt = document.createElement('option');
    newOpt.value = '__new__';
    newOpt.textContent = '＋ 新建题库…';
    previewTargetBankSelect.appendChild(newOpt);
    if (Object.keys(state.questionBanks).length === 0) {
        previewTargetBankSelect.value = '__new__';
    }
}


export function renderPreview() {
    // 多题库文件:顶部横幅说清查到了几个库、怎么导;「导入到」下拉在"分开导入"时没有意义 → 隐藏
    const banks = state.previewBanks || [];
    const multi = banks.length >= 2;
    const separate = multi && state.previewBankMode === 'separate';
    if (previewMultiBanner) {
        previewMultiBanner.classList.toggle('hidden', !multi);
        if (multi) {
            const list = banks.map(b => `${b.name}(${b.count} 题)`).join(' · ');
            previewMultiBannerText.textContent = `检测到 ${banks.length} 个题库:${list}`;
            Array.from(previewModeInputs).forEach(inp => { inp.checked = inp.value === state.previewBankMode; });
        }
    }
    if (previewTargetRow) previewTargetRow.classList.toggle('hidden', separate);
    if (previewOverwriteLabel) {
        previewOverwriteLabel.textContent = separate ? '覆盖同名题库(清空后导入)' : '覆盖目标题库';
    }
    previewList.innerHTML = '';
    const bankKeys = new Set();
    Object.values(state.questionBanks).forEach(bank => (bank || []).forEach(q => bankKeys.add(questionDedupKey(q))));

    // 第一遍:全量计算警告(筛选只是视图层,不改变勾选与统计)
    state.previewData.forEach(item => {
        const q = item.q;
        const warnings = [];
        if (!q.answer) warnings.push('缺答案');
        if (Object.keys(q.options).length < 2) warnings.push('选项不足');
        if (bankKeys.has(questionDedupKey(q))) warnings.push('与现有题库重复');
        if ((q.confidence || 0) < 0.6) warnings.push('低置信度');
        item.warnings = warnings;
    });

    // 第二遍:按筛选渲染(只看问题题时隐藏无警告项)
    const warnCount = state.previewData.filter(i => i.warnings.length).length;
    state.previewData
        .map((item, idx) => ({ item, idx }))
        .filter(({ item }) => !state.previewFilterWarned || item.warnings.length > 0)
        .forEach(({ item, idx }) => {
        const q = item.q;
        const warnings = item.warnings;

        const box = document.createElement('div');
        box.className = 'preview-item' + (warnings.length ? ' warn' : '') + (item.aiNote ? ' ai-touched' : '');
        const clearAiMark = () => {
            if (!item.aiNote) return;
            item.aiNote = '';
            item.histAI = true;  // 痕迹:导入后记入历史日志
            box.classList.remove('ai-touched');
            const badge = box.querySelector('.ai-badge');
            if (badge && badge.remove) badge.remove();
        };

        const head = document.createElement('div');
        head.className = 'preview-item-head';

        const chk = document.createElement('input');
        chk.type = 'checkbox';
        chk.checked = item.include;
        chk.addEventListener('change', () => { item.include = chk.checked; updateSelectAllState(); updatePreviewSummary(); });
        head.appendChild(chk);

        const num = document.createElement('span');
        num.className = 'preview-num';
        num.textContent = `#${idx + 1}`;
        head.appendChild(num);

        const typeBadge = document.createElement('span');
        typeBadge.className = 'badge';
        typeBadge.textContent = q.type || '未知';
        head.appendChild(typeBadge);

        // 多题库文件:每道题标出它属于哪个库 —— 用户能一眼核对"切分对不对",而不是盲信
        if (item.bank && (state.previewBanks || []).length >= 2) {
            const bankBadge = document.createElement('span');
            bankBadge.className = 'badge bank-badge';
            bankBadge.textContent = `📚 ${item.bank}`;
            head.appendChild(bankBadge);
        }

        warnings.forEach(w => {
            const b = document.createElement('span');
            b.className = 'badge warn-badge';
            b.textContent = w;
            head.appendChild(b);
        });

        // AI 改动标注(🤖 紫徽章):只有真变了才显示,写明改了什么
        if (item.aiNote) {
            const aiB = document.createElement('span');
            // AI 拟答用**待核验**琥珀色,与模式一的紫标区分:紫=AI 改过格式,琥珀=AI 给了内容
            aiB.className = 'badge ' + (item.aiAnswer ? 'ai-answer-badge' : 'ai-badge');
            aiB.textContent = item.aiAnswer ? item.aiNote : '🤖 ' + item.aiNote;
            head.appendChild(aiB);
        }

        const conf = document.createElement('span');
        conf.className = 'preview-conf';
        conf.textContent = `${Math.round((q.confidence || 0) * 100)}%`;
        head.appendChild(conf);
        box.appendChild(head);

        const stem = document.createElement('textarea');
        stem.className = 'preview-stem';
        stem.rows = 2;
        stem.value = q.content;
        stem.addEventListener('input', () => { q.content = stem.value; clearAiMark(); });
        box.appendChild(stem);

        const optsDiv = document.createElement('div');
        optsDiv.className = 'preview-options';
        const optKeys = Object.keys(q.options).sort();
        optsDiv.textContent = optKeys.length
            ? optKeys.map(k => `${k}. ${q.options[k]}`).join('　')
            : '（未解析到选项）';
        box.appendChild(optsDiv);

        const editRow = document.createElement('div');
        editRow.className = 'preview-edit-row';

        const ansLabel = document.createElement('span');
        ansLabel.className = 'preview-answer-label';
        ansLabel.textContent = '答案：';
        editRow.appendChild(ansLabel);

        const ansInput = document.createElement('input');
        ansInput.className = 'preview-answer';
        ansInput.value = q.answer;
        ansInput.placeholder = '如 A / ABC / 对';
        ansInput.addEventListener('input', () => { q.answer = ansInput.value; clearAiMark(); });
        editRow.appendChild(ansInput);

        if (q.analysis) {
            const ana = document.createElement('span');
            ana.className = 'preview-analysis';
            ana.textContent = `解析：${q.analysis}`;
            editRow.appendChild(ana);
        }
        box.appendChild(editRow);

        previewList.appendChild(box);
    });

    // 双 tab 视图:高亮当前 + 计数
    if (viewAllBtn && viewWarnedBtn) {
        viewAllBtn.classList.toggle('active', !state.previewFilterWarned);
        viewWarnedBtn.classList.toggle('active', state.previewFilterWarned);
    }
    if (viewAllCount) viewAllCount.textContent = String(state.previewData.length);
    if (viewWarnedCount) viewWarnedCount.textContent = String(warnCount);
    updateSelectAllState();
    updatePreviewSummary(warnCount);
}


// 三态全选:全勾 → 点击清空;未全勾(含部分/全不选)→ 点击全勾;勾选框本体只作状态显示(粗体横杠=部分选中)
export function togglePreviewSelectAll() {
    const allSelected = state.previewData.length > 0 && state.previewData.every(i => i.include);
    state.previewData.forEach(i => { i.include = !allSelected; });
    renderPreview();
}

// 把预览数据的选择状态同步回"全选"勾选框(checked/indeterminate 双属性)
function updateSelectAllState() {
    if (!previewSelectAll) return;
    const total = state.previewData.length;
    const inc = state.previewData.filter(i => i.include).length;
    previewSelectAll.checked = total > 0 && inc === total;
    previewSelectAll.indeterminate = inc > 0 && inc < total;
}


export function updatePreviewSummary(warnCount) {
    const total = state.previewData.length;
    const included = state.previewData.filter(i => i.include).length;
    const warns = (typeof warnCount === 'number')
        ? warnCount
        : state.previewData.filter(i => i.warnings && i.warnings.length).length;
    previewSummary.textContent = `共解析 ${total} 题，已勾选 ${included} 题，${warns} 题含警告需要留意`;
}


// 确认导入：收集勾选项 → 重新规范化 → 去重 → 写入目标题库
export function commitPreviewImport() {
    // ① 多题库 + 分开导入:每个题库各进各的库(同名追加;勾了「覆盖」则清空后导入,并逐库存版)
    const banks = state.previewBanks || [];
    if (banks.length >= 2 && state.previewBankMode === 'separate') {
        commitSeparateImport();
        return;
    }
    let targetName = previewTargetBankSelect.value;
    if (targetName === '__new__') {
        const name = (prompt('请输入新题库名称：') || '').trim();
        if (!name) return;
        targetName = name;
    }
    if (!state.questionBanks[targetName]) state.questionBanks[targetName] = [];

    const overwrite = previewOverwrite.checked;
    if (overwrite && state.questionBanks[targetName].length > 0 &&
        !confirm(`确定清空题库"${targetName}"并导入新题目吗？（覆盖前会自动快照，可恢复）`)) {
        return;
    }

    // 收集勾选项（重新规范化保证答案/题型一致）；缺答案题不再丢弃,入库为"待补"
    const items = [];
    const seen = new Set();
    for (const item of state.previewData) {
        if (!item.include) continue;
        const clone = JSON.parse(JSON.stringify(item.q));
        const finalized = finalizeQuestion(clone);
        if (!finalized) continue;
        if (item.aiNote) {
            finalized.aiSource = 'ai';  // AI 动过 → 永久标注,编辑器可见
        } else if (item.histAI) {
            pushHistMark(finalized, 'ai');  // 预览中已人工改掉 AI 痕迹 → 直接进历史
        }
        const key = questionDedupKey(finalized);
        if (seen.has(key)) continue; // 批内去重
        seen.add(key);
        items.push(finalized);
    }

    // 与目标题库查重
    const existingKeys = new Set((overwrite ? [] : state.questionBanks[targetName]).map(questionDedupKey));
    const finalItems = previewSkipDupes.checked
        ? items.filter(q => !existingKeys.has(questionDedupKey(q)))
        : items;

    if (finalItems.length === 0) {
        alert('没有可导入的题目（均与目标题库重复）');
        return;
    }

    // 撤销打点:导入前先留一版库内容(👤 2026-09-13:导入也进版本记录,它是最该有安全网的动作)
    const beforeImport = (state.questionBanks[targetName] || []).slice();
    if (beforeImport.length > 0) {
        pushBankVersion(targetName, overwrite ? '覆盖导入前' : '导入前', beforeImport, { source: previewSourceLabel });
    }
    if (overwrite) {
        state.questionBanks[targetName] = finalItems;
    } else {
        state.questionBanks[targetName].push(...finalItems);
    }
    const afterImport = state.questionBanks[targetName].slice();
    const setBankArr = (arr) => {
        state.questionBanks[targetName] = arr;
        if (state.currentBankName === targetName) state.questionBank = arr;
    };
    trackUndo(`导入 ${finalItems.length} 题到「${targetName}」`,
        () => setBankArr(beforeImport.slice()),
        () => setBankArr(afterImport.slice()));

    // 切换到目标题库
    state.isAllBanksView = false;
    state.currentBankName = targetName;
    state.questionBank = state.questionBanks[targetName];

    saveToLocalStorage();
    updateBankSelect();
    questionBankSelect.value = targetName;
    updateBanksList();

    hideModal(importPreviewModal);
    hideFileNotice();
    fileInput.value = '';
    pasteInput.value = '';

    const dupeNote = (items.length - finalItems.length) > 0 ? `（跳过 ${items.length - finalItems.length} 题重复）` : '';
    const pendingImported = finalItems.filter(q => !q.answer).length;
    const pendingNote = pendingImported > 0 ? `，其中 ${pendingImported} 题待补答案（编辑器中可补，刷题时自动排除）` : '';
    showImportStatus(`成功导入 ${finalItems.length} 道题目到题库：${targetName}${dupeNote}${pendingNote}`, 'success');

    // 记录导入批次(供"撤销上次导入"按指纹回滚;手改过的题指纹变化后自动跳过)
    recordImportBatch({
        time: new Date().toISOString(),
        source: previewSourceLabel,
        bank: targetName,
        fingerprints: finalItems.map(questionDedupKey),
        imported: finalItems.length,
    });
    updateLastImportInfo();
}


// 多题库分开导入:一个文件里的每个题库各自入库。
// ⚠️ 逐库都走同一套纪律:覆盖前存版、批内去重、与目标库去重(勾了"跳过重复题")、逐库记账(撤销才有据可依)。
function commitSeparateImport() {
    const overwrite = previewOverwrite.checked;
    const skipDupes = previewSkipDupes.checked;

    // 先按库分组(只收勾选的题),组内按原顺序
    const groups = [];
    const byName = new Map();
    for (const item of state.previewData) {
        if (!item.include) continue;
        const name = item.bank || '未命名题库';
        if (!byName.has(name)) { const g = { name, items: [] }; byName.set(name, g); groups.push(g); }
        byName.get(name).items.push(item);
    }
    if (groups.length === 0) {
        alert('没有勾选任何题目');
        return;
    }

    const summary = [];
    const touched = [];
    const undoGroups = [];
    for (const g of groups) {
        const items = [];
        const seen = new Set();
        for (const item of g.items) {
            const finalized = finalizeQuestion(JSON.parse(JSON.stringify(item.q)));
            if (!finalized) continue;
            if (item.aiNote) finalized.aiSource = 'ai';
            else if (item.histAI) pushHistMark(finalized, 'ai');
            const key = questionDedupKey(finalized);
            if (seen.has(key)) continue;
            seen.add(key);
            items.push(finalized);
        }
        if (items.length === 0) continue;
        const existing = state.questionBanks[g.name] || [];
        const kept = skipDupes && !overwrite
            ? items.filter(q => !new Set(existing.map(questionDedupKey)).has(questionDedupKey(q)))
            : items;
        if (kept.length === 0) { summary.push(`${g.name} 0 题(全重复)`); continue; }
        if (overwrite && existing.length > 0) pushBankVersion(g.name, '覆盖导入前', existing, { source: previewSourceLabel });
        else if (existing.length > 0) pushBankVersion(g.name, '导入前', existing, { source: previewSourceLabel });
        const beforeArr = existing.slice();
        state.questionBanks[g.name] = overwrite ? kept : existing.concat(kept);
        undoGroups.push({ name: g.name, before: beforeArr, after: state.questionBanks[g.name].slice() });
        touched.push(g.name);
        summary.push(`${g.name} ${kept.length} 题`);
        recordImportBatch({
            time: new Date().toISOString(),
            source: previewSourceLabel,
            bank: g.name,
            fingerprints: kept.map(questionDedupKey),
            imported: kept.length,
        });
    }

    if (touched.length === 0) {
        alert('没有可导入的题目（均与目标题库重复）');
        return;
    }

    // 一次导入涉及多个库 → 一条撤销条目把它们一起回退(用户按一次撤销 = 回到导入前)
    if (undoGroups.length) {
        const setAll = (which) => {
            undoGroups.forEach(g => {
                const arr = g[which].slice();
                state.questionBanks[g.name] = arr;
                if (state.currentBankName === g.name) state.questionBank = arr;
            });
        };
        trackUndo(`导入 ${undoGroups.reduce((n, g) => n + g.after.length - g.before.length, 0)} 题(${undoGroups.length} 个库)`,
            () => setAll('before'), () => setAll('after'));
    }

    // 停在第一个导入的库上,用户接着就能看到结果
    state.isAllBanksView = false;
    state.currentBankName = touched[0];
    state.questionBank = state.questionBanks[touched[0]];
    saveToLocalStorage();
    updateBankSelect();
    questionBankSelect.value = touched[0];
    updateBanksList();

    hideModal(importPreviewModal);
    hideFileNotice();
    fileInput.value = '';
    pasteInput.value = '';
    showImportStatus(`成功导入 ${touched.length} 个题库:${summary.join(' · ')}`, 'success');
    updateLastImportInfo();
}


// ==================== 导入撤销与覆盖快照恢复 ====================

// 「撤销上次导入」已删除(👤 2026-09-13):批次级撤销语义脆弱(手改过的题指纹变了就撤不掉 → "半撤"),
// 导入的撤销统一走**题库版本记录** —— 导入前会自动存一版「导入前」,在库卡的版本记录里一键恢复。
// 恢复覆盖模式导入前的题库快照
export function restoreOverwriteSnapshot() {
    const snap = loadOverwriteSnapshot();
    if (!snap) {
        showImportStatus('没有可恢复的快照 —— 只有"覆盖导入"时会自动存一版', 'error');
        return;
    }
    if (!state.questionBanks[snap.bank]) {
        showImportStatus(`快照对应的题库"${snap.bank}"已被删除，无法恢复`, 'error');
        return;
    }
    if (!confirm(`把题库"${snap.bank}"恢复到覆盖前状态（${snap.questions.length} 题，当前 ${(state.questionBanks[snap.bank] || []).length} 题）？`)) {
        return;
    }
    state.questionBanks[snap.bank] = JSON.parse(JSON.stringify(snap.questions));
    if (state.currentBankName === snap.bank) state.questionBank = state.questionBanks[snap.bank];
    clearOverwriteSnapshot();
    saveToLocalStorage();
    updateBankSelect();
    updateBanksList();
    showImportStatus(`已恢复覆盖前快照：${snap.bank} · ${snap.questions.length} 题`, 'success');
}

// 预览一键"只保留无警告题"(单向过滤,被滤掉的仍可手动勾回)
// 「推荐选择」:无警告题勾上、有警告题取消——与导入默认防呆规则一致,可再手动微调
export function keepCleanOnly() {
    state.previewData.forEach(item => {
        item.include = !(item.warnings && item.warnings.length);
    });
    renderPreview();
    updatePreviewSummary();
}

// 题库管理页展示最近一次导入信息
export function updateLastImportInfo() {
    const batches = loadImportBatches();
    const last = batches[batches.length - 1];
    if (!last) {
        lastImportInfo.textContent = '暂无导入记录';
        return;
    }
    lastImportInfo.textContent = `上次导入：${last.time.replace('T', ' ').slice(0, 16)} · ${last.source} → ${last.bank}（${last.imported} 题）`;
}


// 创建新题库
export function createNewBank() {
    const bankName = newBankNameInput.value.trim();

    if (!bankName) {
        alert('请输入题库名称');
        return;
    }

    if (state.questionBanks[bankName]) {
        alert('该题库已存在');
        return;
    }

    state.questionBanks[bankName] = [];
    state.currentBankName = bankName;
    state.questionBank = state.questionBanks[bankName];
    state.isAllBanksView = false;

    saveToLocalStorage();
    updateBankSelect();
    questionBankSelect.value = bankName;
    updateBanksList();

    hideModal(createBankModal);
    alert('题库创建成功');
}


// 显示重命名模态框
export function showRenameModal(bankName) {
    state.currentRenameBank = bankName;
    renameBankNameInput.value = bankName;
    showModal(renameBankModal);
}


// 重命名题库
export function renameBank() {
    const newName = renameBankNameInput.value.trim();

    if (!newName) {
        alert('请输入新名称');
        return;
    }

    if (newName === state.currentRenameBank) {
        hideModal(renameBankModal);
        return;
    }

    if (state.questionBanks[newName]) {
        alert('该题库名称已存在');
        return;
    }

    state.questionBanks[newName] = state.questionBanks[state.currentRenameBank];
    delete state.questionBanks[state.currentRenameBank];
    clearUndo();   // 改名/删库这类库级操作会把栈里的引用变成悬空,直接清栈(库级回退走回收站)

    // 归属同步(P0-1.9):错题/收藏跟随新库名,避免漂进"杂项"
    const oldName = state.currentRenameBank;
    state.errorQuestions.forEach(q => { if (q.bankName === oldName) q.bankName = newName; });
    state.favoriteQuestions.forEach(q => { if (q.bankName === oldName) q.bankName = newName; });
    // 卡片配色同样跟着走(它按库名存;不迁就会"改个名颜色就丢了")
    if (state.bankColors && state.bankColors[oldName]) {
        state.bankColors[newName] = state.bankColors[oldName];
        delete state.bankColors[oldName];
    }
    // 版本记录也按库名存:不迁,改个名历史快照就成了孤儿(库里明明有,面板却显示"暂无记录")
    renameBankVersions(oldName, newName);

    if (state.currentBankName === state.currentRenameBank) {
        state.currentBankName = newName;
        state.questionBank = state.questionBanks[state.currentBankName];
    }

    // ⚠️ 编辑器正开着这一库时必须同时改状态里的库名 + 重渲染(bug 2026-09-12:改名后
    //    编辑器标题还挂着旧名,而旧名在 questionBanks 里已经不存在 —— currentEditBank()
    //    直接返回空数组,表现为"改个名,这库的题全没了")。改名入口就在编辑器的库里,
    //    所以这条路径是主线,不是边角。
    const wasEditing = state.editBankName === oldName;
    if (wasEditing) {
        state.editBankName = newName;
        setEditBankTitle(newName);
    }

    saveToLocalStorage();
    refreshQuestionBankView();
    updateBankSelect();
    updateBanksList();
    if (wasEditing) renderBankEditor();   // 标题/配色/版本面板一起按新库名重画

    hideModal(renameBankModal);
    alert('题库重命名成功');
}


// 删除题库
export function deleteBank(bankName) {
    // 库删了,配色也要跟着清 —— 否则将来重建同名库会莫名其妙带上旧颜色
    if (state.bankColors && state.bankColors[bankName]) {
        delete state.bankColors[bankName];
        saveToLocalStorage();
    }
    if (!confirm(`确定删除题库"${bankName}"吗？\n该库的错题与收藏将一并移入回收站,可随时恢复。`)) {
        return;
    }

    clearUndo();   // 库级操作(删库)→ 清栈:栈里的条目还引着这个库,留着只会在撤销时炸
    // 整体打包入回收站(题 + 该库错题 + 该库收藏)
    recycleBank(bankName, {
        bank: state.questionBanks[bankName] || [],
        errors: state.errorQuestions.filter(q => (q.bankName || '未知题库') === bankName),
        favorites: state.favoriteQuestions.filter(q => (q.bankName || '未知题库') === bankName),
    });
    state.errorQuestions = state.errorQuestions.filter(q => (q.bankName || '未知题库') !== bankName);
    state.favoriteQuestions = state.favoriteQuestions.filter(q => (q.bankName || '未知题库') !== bankName);

    if (state.currentBankName === bankName) {
        const bankNames = Object.keys(state.questionBanks).filter(name => name !== bankName);
        if (bankNames.length > 0) {
            state.currentBankName = bankNames[0];
            state.questionBank = state.questionBanks[state.currentBankName];
        } else {
            state.currentBankName = '默认题库';
            state.questionBank = [];
            state.questionBanks[state.currentBankName] = state.questionBank;
        }
    }

    delete state.questionBanks[bankName];

    saveToLocalStorage();
    refreshQuestionBankView();
    updateBankSelect();
    updateBanksList();
    // ⚠️ 必须一并刷新回收站:它就挂在题库页那一行,不刷新的话计数与列表会停在旧值,
    //    表现为"删了库要刷页面才看得到"(👤 反馈的 bug)。
    renderRecycleBin();

    alert(`题库"${bankName}"已移入回收站(可恢复)`);
}

// ==================== 库级版本快照 UI(P0-1.11) ====================

// ==================== 回收站 UI(P0-1.10) ====================






// 导出文件名 = 名字 + 时间戳(👤 要求)。
// 为什么:`所有题库.txt` 同一天导两次,浏览器只会给你 `(1)(2)` 这种含糊后缀,
// 过几天回头看根本分不清哪份是哪份;时间戳让文件名自带"这是一次快照"的信息。
// 格式:所有题库-20260912-1523.txt(纯数字 + 连字符,Windows / macOS / 安卓都不挑;时间戳按本地时间)。
function exportFileName(base) {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${base}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.txt`;
}

// 导出单个题库
export function exportBank(bankName) {
    const questions = state.questionBanks[bankName];
    if (!questions || questions.length === 0) {
        alert('该题库为空，无法导出');
        return;
    }

    const content = formatQuestionsForExport(questions);
    downloadFile(exportFileName(bankName), content);
}


// 导出所有题库
export function exportAllBanks() {
    const bankNames = Object.keys(state.questionBanks);
    if (bankNames.length === 0) {
        alert('暂无题库可导出');
        return;
    }

    let allContent = '';
    bankNames.forEach(bankName => {
        const questions = state.questionBanks[bankName];
        if (questions && questions.length > 0) {
            // 分节标记:**人一眼看得出边界,导入时能自动认出每个题库**(见 splitBankSections)。
            // 旧写法 `# 题库：X` 会被解析器当成"一道题的标题",于是各库的题混成一库(👤 反馈的根因)。
            allContent += bankSectionHeader(bankName) + '\n\n';
            allContent += formatQuestionsForExport(questions);
            allContent += '\n\n';
        }
    });

    if (!allContent) {
        alert('所有题库都为空，无法导出');
        return;
    }

    downloadFile(exportFileName('所有题库'), allContent);
}


// 题库一键去重：按"题干+选项"指纹清理重复题（保留最早导入的版本）
export function dedupBank(bankName) {
    const questions = state.questionBanks[bankName] || [];
    // ⚠️ 顺序要紧:先算出**到底有没有重复**,没有就什么都不做。
    //    旧实现一进来就存版,空点一次也留一条「去重前」;每库只有 3 个槽,几下就被无意义的安全网占满。
    const seen = new Set();
    const kept = [];
    questions.forEach(q => {
        const key = questionDedupKey(q);
        if (seen.has(key)) return;
        seen.add(key);
        kept.push(q);
    });
    const removed = questions.length - kept.length;
    if (removed === 0) {
        alert('该题库没有重复题目');
        return;
    }
    if (!confirm(`发现 ${removed} 道重复题目（按题干+选项判断，保留最早导入的版本），确定清理吗？\n当前内容会先存为一版，可随时恢复。`)) {
        return;
    }
    pushBankVersion(bankName, '去重前', questions);   // 确认真的会改,才值得占一个版本槽
    // 去重 = 整库替换:撤销/重做只需把数组换回去(元素是同一批对象引用,不复制数据)
    const beforeArr = questions.slice();
    const afterArr = kept.slice();
    const setBankArr = (arr) => {
        state.questionBanks[bankName] = arr;
        if (state.currentBankName === bankName) state.questionBank = arr;
    };
    trackUndo(`去重(删 ${removed} 题)`, () => setBankArr(beforeArr.slice()), () => setBankArr(afterArr.slice()));
    state.questionBanks[bankName] = kept;
    if (state.currentBankName === bankName) {
        state.questionBank = kept;
    }
    saveToLocalStorage();
    refreshQuestionBankView();
    updateBanksList();
    updateBankSelect();
    alert(`已清理 ${removed} 道重复题目`);
}


// 打开题库编辑器
export function editBank(bankName) {
    if (!state.questionBanks[bankName]) return;
    state.editBankName = bankName;
    state.editIndex = 0;
    state.editorDirty = false;
    setEditBankTitle(bankName);
    renderBankEditor();
    showModal(editBankModal);
}

// 编辑器标题里的库名(打开时写一次、改名后要跟着改 —— 见 renameBank)
function setEditBankTitle(bankName) {
    if (editBankTitle) editBankTitle.textContent = `编辑题库：${bankName}`;
}


// 新增题目（空题，未保存前关闭会被清理）
export function editorAddQuestion() {
    if (!editorGuard()) return;
    const questions = currentEditBank();
    const created = {
        content: '', type: '单选', options: { A: '', B: '', C: '', D: '' }, answer: '',
        explanation: '', analysis: '', optionExplanations: {}, confidence: 1, raw: ''
    };
    questions.push(created);
    const addBank = state.editBankName;
    trackUndo('新增题目',
        () => { const arr = state.questionBanks[addBank] || []; const i = arr.indexOf(created); if (i !== -1) arr.splice(i, 1); },
        () => { const arr = state.questionBanks[addBank] || []; arr.push(created); });
    state.editIndex = questions.length - 1;
    // ⚠️ 新增前先清掉筛选:刚加的题很可能不满足当前筛选条件,那样它会"加进去了但列表里看不见",
    //    用户只会以为没加上。清筛选是一次点击就能恢复的代价,比"看不见"轻得多(👤 反馈过同类困惑)。
    editorClearFilterSelectionOnly();
    renderBankEditor();
    state.editorDirty = false;   // 空题不算"未保存的修改":它已经在库里了,卡片只负责填
    if (editorAiAnswerNote) editorAiAnswerNote.textContent = `已新增第 ${questions.length} 题,填好后点「保存本题」`;
    openQuestionCard(questions.length - 1);
}

// 清筛选 + 清多选(供"新增题目"这类需要"看得见"的路径复用)
function editorClearFilterSelectionOnly() {
    FILTER_GROUPS.forEach(g => { state.editorFilter[g] = []; });
    syncPendingAlias();
    state.editorSelected.length = 0;
}


// 保存当前题（silent=true 时不弹提示），返回是否成功
// ==================== 模式二:编辑器单题补答案/解析(P1-1.4)====================
// 只填进**表单草稿区**,不直接落库 —— 用户过目并点保存才生效。
// 保存时:AI 填的字段落 answerSource/analysisSource='ai'(永久标注);用户改过的字段转人工。
export async function editorAiAnswer() {
    const questions = currentEditBank();
    const q = questions[state.editIndex];
    if (!q) return;
    const cfg = normalizeAiConfig(loadAiConfig());
    if (!aiConfigReady(cfg)) {
        alert('请先在「⚙ AI 设置」里配置服务商与 API Key(自带 key,仅存本机)');
        openAiSettings();
        return;
    }
    // 快照:用表单当前内容当"原题"来问,避免把用户刚改还没保存的内容丢掉
    const draft = JSON.parse(JSON.stringify(q));
    draft.content = editorStem.value.trim() || q.content;
    // 选项以表单为准;表单读不到时退回内存里的原选项。
    // ⚠️ 这个兜底有真实价值:vm 测试桩的 querySelectorAll 恒返回 [],editorCollectOptions() 会得到空对象,
    //    于是"没选项就不许补答案"会把这条路径整条堵死;而测试桩**存在本身**就说明代码路径依赖了 DOM 细节。
    draft.options = editorCollectOptions();
    if (Object.keys(draft.options || {}).length === 0) draft.options = q.options || {};
    draft.explanation = editorExplanation.value.trim();
    draft.answer = (editorAnswer.value || '').trim();
    draft.analysis = (editorAnalysis.value || '').trim();

    // ⚠️ 顺序要紧:"已经完整"的判断必须**先于**确认框。
    //    否则一道答案解析都齐的题会先弹"要覆盖吗"、点了才发现根本无需补 —— 白打扰用户一次。
    if (questionsNeedingAi([draft]).length === 0) {
        if (editorAiAnswerNote) editorAiAnswerNote.textContent = '本题已有答案与解析,无需补';
        return;
    }
    // 表单里已有答案(但缺解析)时:AI 只会补空白,先说明再动手
    if (draft.answer && !confirm('表单里已经填了答案。\nAI 只补空白字段,**不会覆盖你已填的答案**,继续吗？')) return;
    if (Object.keys(draft.options || {}).length < 2) {
        if (editorAiAnswerNote) editorAiAnswerNote.textContent = '本题还没有选项,先填好选项(至少 2 个)再补答案';
        return;
    }

    if (editorAiAnswerBtn) editorAiAnswerBtn.disabled = true;
    if (editorAiAnswerNote) editorAiAnswerNote.textContent = '⏳ AI 正在补…(单题,通常几秒)';
    try {
        const { questions: produced, total } = await aiAnswerQuestions(cfg, [draft]);
        const r = mergeAiAnswers([draft], produced);
        recordAiUsage({ trigger: 'editor-answer', total, answerFilled: r.answerFilled, analysisFilled: r.analysisFilled, undetermined: r.undetermined });
        if (r.filled === 0) {
            if (editorAiAnswerNote) editorAiAnswerNote.textContent = 'AI 没能给出可用的答案(AI 没返回或说无法确定)';
            return;
        }
        // 只把 AI 真正补出来的字段写进表单
        if (r.answerFilled > 0) { editorAnswer.value = draft.answer; editorAiAnsweredAnswer = draft.answer; }
        if (r.analysisFilled > 0) { editorAnalysis.value = draft.analysis; editorAiAnsweredAnalysis = draft.analysis; }
        const bits = [];
        if (r.answerFilled) bits.push(`答案 ${draft.answer}`);
        if (r.analysisFilled) bits.push('解析');
        if (editorAiAnswerNote) {
            editorAiAnswerNote.textContent = `✍️ AI 已填入${bits.join(' + ')}(🤖 未核验,请核对后点保存)`
                + (r.undetermined ? ';AI 对答案表示「无法确定」' : '');
        }
    } catch (e) {
        recordAiUsage({ trigger: 'editor-answer', ok: false, error: String(e.message || e).slice(0, 120) });
        if (editorAiAnswerNote) editorAiAnswerNote.textContent = 'AI 失败：' + String(e.message || e).slice(0, 60);
    } finally {
        if (editorAiAnswerBtn) editorAiAnswerBtn.disabled = false;
    }
}

export function editorSaveCurrent(silent) {
    const questions = currentEditBank();
    const q = questions[state.editIndex];
    if (!q) return false;

    const stem = editorStem.value.trim();
    const type = editorType.value;
    let answer = (editorAnswer.value || '').toUpperCase().replace(/\s+/g, '');
    let options;

    if (type === '判断') {
        options = { A: '正确', B: '错误' };
        // 允许填 对/错/√/× 等写法
        if (/^(对|正确|√|T|Y)$/.test(answer) || answer === '') answer = 'A';
        else if (/^(错|错误|×|X|F|N)$/.test(answer)) answer = 'B';
        answer = answer.replace(/[^AB]/g, '') || 'A';
    } else {
        options = editorCollectOptions();
        Object.keys(options).forEach(l => {
            if (!options[l].trim()) delete options[l];
        });
        answer = normalizeAnswerString(answer).split('').filter(l => options[l]).join('');
    }

    if (!stem) {
        if (!silent) alert('题干不能为空');
        return false;
    }
    if (!answer) {
        if (!silent) alert('答案无效：请填写有效选项字母（如 A 或 ABC）');
        return false;
    }

    // 撤销打点:存**这一道题**的旧值(改前);保存完成后在末尾比对,真变了才记一步
    const beforeSnapshot = cloneQuestion(q);
    const undoLabelText = `改第 ${state.editIndex + 1} 题的答案/题干`;
    const wasAi = q.aiSource === 'ai';
    const wasPending = !q.answer;
    // AI 是否动过这一题:答案或解析的**内容仍等于 AI 当初填的值** → AI 出的;
    // 用户改过就转人工(改过就是人的,这是本功能的诚实性底线)
    const answerFromAi = editorAiAnsweredAnswer !== null && editorAiAnsweredAnswer === answer;
    const analysisFromAi = editorAiAnsweredAnalysis !== null && editorAiAnsweredAnalysis === (editorAnalysis.value || '').trim();
    // 保存前对齐题型与答案:答案是多个字母就必须是多选。
    // 否则会出现"单选 + 答案 AC"——刷题时按单选渲染(只能选一个字母)而永远判不对。
    // 先落值,再归一化 —— 顺序不能反:finalizeQuestion 要读的就是刚采集的 options/answer
    q.content = stem;
    q.options = options;
    q.answer = answer;
    q.explanation = editorExplanation.value.trim();
    q.analysis = editorAnalysis.value.trim();
    // 用户在下拉框里的选择是明确意图,打标记让 finalize 不要用答案长度覆盖它
    q._typeExplicit = true;
    q.type = type;
    finalizeQuestion(q);   // 归一化,并按答案长度纠正题型(多字母 → 多选)
    const finalType = q.type;
    // 字段级来源标注:AI 填的标 'ai',人填的标 null(= 未标注 = 人工)
    // ⚠️ 这是"永久标注"的落点:刷题反馈、错题卡、导出文件都读它来显示 🤖
    q.answerSource = answerFromAi ? 'ai' : null;
    q.analysisSource = (q.analysis && analysisFromAi) ? 'ai' : null;
    // 人工保存 = 人工核验完成:撤销 AI 标记,并把消散的自动标记记入历史日志
    if (wasAi) {
        delete q.aiSource;
        pushHistMark(q, 'ai');
    }
    if (wasPending && q.answer) pushHistMark(q, 'pending');

    // 真改过才记一步(静默保存/原样保存不该污染撤销栈)
    const afterSnapshot = cloneQuestion(q);
    if (editableSignature(beforeSnapshot) !== editableSignature(afterSnapshot)) {
        trackUndo(undoLabelText,
            () => assignExact(q, beforeSnapshot),
            () => assignExact(q, afterSnapshot));
    }
    saveToLocalStorage();
    state.editorDirty = false;
    // keepList = true:保存不该把用户拉开的题号列表又合上(他可能正靠着列表连续核对)
    renderBankEditor();
    // 让下拉框反映真正落库的类型(被自动纠正时给出可见反馈)
    editorType.value = finalType;
    if (!silent) {
        alert(finalType !== type
            ? `已按答案自动改为「${finalType}」并保存`
            : '本题已保存');
    }
    return true;
}


// 关闭编辑器（清理未保存的空题）
export function editorClose() {
    if (!editorGuard()) return;
    const questions = currentEditBank();
    const kept = questions.filter(q => (q.content || '').trim() || (q.answer || '').trim());
    if (kept.length !== questions.length) {
        state.questionBanks[state.editBankName] = kept;
        if (state.currentBankName === state.editBankName) state.questionBank = kept;
        saveToLocalStorage();
        refreshQuestionBankView();
    }
    state.editBankName = null;
    state.editIndex = 0;
    state.editorDirty = false;
    state.editorPendingOnly = false;
    // 筛选/多选/卡片都是"这一次编辑会话"的东西,关编辑器时一并归零 ——
    // 否则下次打开会带着上次的筛选,看到空列表还以为题库空了(踩过同类"状态残留"坑)
    FILTER_GROUPS.forEach(g => { state.editorFilter[g] = []; });
    state.editorSelected.length = 0;
    hideModal(questionCardModal);
    hideModal(editBankModal);
    updateBanksList();
}


// 编辑器/卡片内切换题目:只在**当前筛选下看得见**的题之间走。
// 「只看待补」因此自动成立(它就是一条筛选),不必再写一套跳过逻辑 ——
// 而"筛过之后点下一题跳到屏幕外的题上"这种怪事也不会发生。返回是否真的移动了。
export function editorNavigate(delta) {
    const ids = visibleQuestions().map(v => v.idx);
    const here = ids.indexOf(state.editIndex);
    let target;
    if (here !== -1) {
        target = ids[here + delta];
    } else {
        // 当前题被筛掉了:朝方向找最近的一道可见题
        target = delta > 0
            ? ids.find(i => i > state.editIndex)
            : ids.slice().reverse().find(i => i < state.editIndex);
    }
    if (target === undefined) return false;   // 到边界:原地不动(不静默改状态)
    if (!editorGuard()) return false;
    state.editIndex = target;
    renderBankEditor();
    return true;
}

// ==================== 题目列表:筛选 / 多选 / 批量操作 / 编辑卡片(👤 2026-09-12 重构)====================
// 设计要点(为什么是这套):
//   ① 列表只负责"看与选":每行 = 复选框 + 序号 + 题干 + 标签徽章;点整行即勾选(不用去戳 13px 的小方块)。
//   ② 动作只在**选中之后**出现(批量操作栏):没选中时界面上就一个多余按钮都没有。
//   ③ 编辑一律进**卡片**(题干/题型/答案/选项/解释/解析)—— 列表不再兼任编辑器,一屏只干一件事。
const FILTER_GROUPS = ['type', 'status', 'ai', 'marks', 'scope'];

// 筛选项定义(键 → 判定)。新增一个筛选维度 = 在这里加一行 + HTML 里加一个 chip。
const FILTER_STATUS = {
    pending: (q) => !q.answer,
    noAnalysis: (q) => !(q.analysis || '').trim(),
    noExplanation: (q) => !(q.explanation || '').trim(),
    fewOptions: (q) => Object.keys(q.options || {}).length < 2,
};
const FILTER_AI = {
    touched: (q) => q.aiSource === 'ai',
    answer: (q) => q.answerSource === 'ai',
    analysis: (q) => q.analysisSource === 'ai',
};
const FILTER_MARKS = {
    hist: (q) => Array.isArray(q.histMarks) && q.histMarks.length > 0,
};

// 单题是否命中筛选(纯函数,便于单测)。语义:**组内任一、组间同时** ——
//   「题型:单选或多选」+「缺什么:待补」能自然组合;空组 = 不约束。
export function questionMatchesFilter(q, filter) {
    const f = filter || {};
    const hit = (list, table) => {
        const keys = list || [];
        return keys.length === 0 || keys.some(k => (table[k] ? table[k](q) : false));
    };
    // 题型不是"查表命中",而是直接比较字面值
    const types = f.type || [];
    if (types.length && types.indexOf(q.type) === -1) return false;
    if (!hit(f.status, FILTER_STATUS)) return false;
    if (!hit(f.ai, FILTER_AI)) return false;
    if (!hit(f.marks, FILTER_MARKS)) return false;
    return true;
}

// 当前生效的筛选条件个数(0 = 没筛)
export function activeFilterCount() {
    const f = state.editorFilter || {};
    return FILTER_GROUPS.reduce((n, g) => n + ((f[g] || []).length), 0);
}

// 筛选后的可见题目 = [{ q, idx }]。idx 是题库里的**真实下标**(定位/删除都靠它,
// 列表显示序号也用它 —— 筛过之后仍能让用户对上"这是第几题")。
export function visibleQuestions() {
    // 「只看勾选」的范围条件单独判:`questionMatchesFilter` 是纯函数(只认题目自身),
    // 而"勾选集"在 state 里 —— 混进去会让那个纯函数变成"要传一整个世界"的函数。
    const focusChecked = (state.editorFilter.scope || []).indexOf('checked') !== -1;
    return currentEditBank()
        .map((q, idx) => ({ q, idx }))
        .filter(({ q }) => (focusChecked ? isSelected(q) : true))
        .filter(({ q }) => questionMatchesFilter(q, state.editorFilter));
}

// 「只看待补答案」= status 里的 pending,保留成独立开关:它同时是"在待补题之间跳"的依据
function syncPendingAlias() {
    state.editorPendingOnly = (state.editorFilter.status || []).indexOf('pending') !== -1;
}

// force 省略 = 反转当前状态(点击 chip 的语义);给了 true/false = 直接置位
function setFilterValue(group, value, force) {
    const f = state.editorFilter;
    if (FILTER_GROUPS.indexOf(group) === -1) return false;
    const list = f[group] || (f[group] = []);
    const at = list.indexOf(value);
    const on = force === undefined ? at === -1 : !!force;
    if (on && at === -1) list.push(value);
    if (!on && at !== -1) list.splice(at, 1);
    syncPendingAlias();
    return on;
}

// 切一个筛选条件(force 给定时 = 直接置位)
export function editorToggleFilter(group, value, force) {
    const on = setFilterValue(group, value, force);
    afterFilterChange(group === 'scope');
    return on;
}

export function editorClearFilter() {
    FILTER_GROUPS.forEach(g => { state.editorFilter[g] = []; });
    syncPendingAlias();
    afterFilterChange(true);   // 清筛选不等于清勾选:勾选是用户的"圈选",筛选项才是临时的
}

// 筛选一变:① 清空多选 —— 绝不让"看不见的题"留在选中集里(否则批量删除会删掉屏幕外的东西);
//          ② 把当前题收窄到还看得见的那一道,编辑卡片不会停在"筛没了"的题上。
function afterFilterChange(keepSelection) {
    // 切「只看勾选」时**保留**勾选集:勾选集正是这条筛选条件的输入,清掉等于把条件清空
    if (!keepSelection) state.editorSelected.length = 0;
    const vis = visibleQuestions();
    if (!vis.some(v => v.idx === state.editIndex)) state.editIndex = vis.length ? vis[0].idx : 0;
    renderBankEditor();
}

// 切换"只看待补答案"(保留老接口:HTML 里的旧复选框/老测试都还能用)
export function editorTogglePendingOnly(checked) {
    setFilterValue('status', 'pending', !!checked);
    afterFilterChange();
}

// ---- 多选 ----
export function isSelected(q) {
    return state.editorSelected.indexOf(q) !== -1;
}

export function editorToggleSelect(q, force) {
    const list = state.editorSelected;
    const at = list.indexOf(q);
    const on = force === undefined ? at === -1 : !!force;
    if (on && at === -1) list.push(q);
    if (!on && at !== -1) list.splice(at, 1);
    renderBankEditor();
    return on;
}

// 全选 = 选中**当前筛选下看得见的**题(不是整个库):"筛出来 → 全选 → 处理"才是这条流水线的本意
export function editorSelectAllVisible() {
    visibleQuestions().forEach(({ q }) => { if (!isSelected(q)) state.editorSelected.push(q); });
    renderBankEditor();
    return state.editorSelected.length;
}

export function editorClearSelection() {
    state.editorSelected.length = 0;
    renderBankEditor();
}

// 选中集里已经被删/被去重掉的题,渲染时顺手剔除(存的是题目对象,不是下标 —— 不会串号)
function pruneSelection() {
    const alive = new Set(currentEditBank());
    const kept = state.editorSelected.filter(q => alive.has(q));
    state.editorSelected.length = 0;
    state.editorSelected.push(...kept);
}

// ---- 批量动作 ----
// 批量删除:选中几道删几道。
// ⚠️ **≥2 道时先存一版**:一次删多道是"一下手就难回头"的操作;单删保留"确认即删"——
//    每库只有 3 个版本槽,删一道也存一版会把槽位挤爆(与去重的存版纪律一致:只在真会大改时存)。
export function editorBulkDelete() {
    const questions = currentEditBank();
    const targets = state.editorSelected.filter(q => questions.indexOf(q) !== -1);
    if (targets.length === 0) return false;
    if (state.editorDirty && !confirm('当前题目的修改尚未保存，确定放弃并删除吗？')) return false;
    if (!confirm(`确定删除选中的 ${targets.length} 道题吗？此操作不可恢复！`)) return false;
    if (targets.length >= 2) pushBankVersion(state.editBankName, '批量删除前', questions);
    // 撤销要"原位放回":记下每道被删的题与其原下标(升序插回才不会错位)
    const removedItems = questions.map((q, idx) => ({ q, idx })).filter(({ q }) => targets.indexOf(q) !== -1);
    const delBank = state.editBankName;
    const applyDelete = () => {
        const set = new Set(removedItems.map(r => r.q));
        const arr = (state.questionBanks[delBank] || []).filter(q => !set.has(q));
        state.questionBanks[delBank] = arr;
        if (state.currentBankName === delBank) state.questionBank = arr;
    };
    trackUndo(removedItems.length > 1 ? `删除 ${removedItems.length} 道题` : '删除题目',
        () => {
            const arr = state.questionBanks[delBank] || [];
            removedItems.forEach(({ q, idx }) => arr.splice(Math.min(idx, arr.length), 0, q));
            if (state.currentBankName === delBank) state.questionBank = arr;
        },
        applyDelete);
    const kept = questions.filter(q => targets.indexOf(q) === -1);
    state.questionBanks[state.editBankName] = kept;
    if (state.currentBankName === state.editBankName) state.questionBank = kept;
    state.editorSelected.length = 0;
    state.editorDirty = false;
    if (state.editIndex >= kept.length) state.editIndex = Math.max(0, kept.length - 1);
    saveToLocalStorage();
    refreshQuestionBankView();
    updateBanksList();
    updateBankSelect();
    renderBankEditor();
    return true;
}

// ---- 编辑卡片 ----
export function openQuestionCard(index) {
    const questions = currentEditBank();
    if (index !== undefined && index !== null) state.editIndex = index;
    if (!questions[state.editIndex]) return false;
    state.editorDirty = false;
    renderBankEditor();            // 顺带把表单字段按这一题填好(表单就在卡片里)
    updateQuestionCardHead();
    showModal(questionCardModal);
    if (editorStem && typeof editorStem.focus === 'function') editorStem.focus();
    return true;
}

// 关闭卡片:有未保存修改时先问一句(复用 editorGuard 的口径)
export function closeQuestionCard(force) {
    if (!force && !editorGuard()) return false;
    if (editorAiAnswerNote) editorAiAnswerNote.textContent = '';
    hideModal(questionCardModal);
    return true;
}

// 保存并关闭(卡片底部那颗「保存本题」)
export function saveQuestionCard() {
    if (!editorSaveCurrent(false)) return false;   // 校验失败(题干/答案不合法)时留在卡片里改
    closeQuestionCard(true);                        // 保存成功 → dirty 已清零,不必再问
    return true;
}

// 卡片内上一题/下一题:走既有的 editorNavigate(它会过"未保存"守卫,并在边界处原地不动的)
export function editorCardNavigate(delta) {
    const before = state.editIndex;
    editorNavigate(delta);
    if (state.editIndex === before) return false;
    updateQuestionCardHead();
    return true;
}

function updateQuestionCardHead() {
    const questions = currentEditBank();
    if (questionCardTitle) {
        questionCardTitle.textContent = questions.length
            ? `第 ${state.editIndex + 1} / ${questions.length} 题`
            : '编辑题目';
    }
    // 到边界就禁用,不让用户点了没反应(比静默失败诚实)
    if (questionCardPrev) questionCardPrev.disabled = state.editIndex <= 0;
    if (questionCardNext) questionCardNext.disabled = state.editIndex >= questions.length - 1;
}


// 增删末尾选项
export function editorMutateOptions(delta) {
    if (editorType.value === '判断') return;
    const q = currentEditBank()[state.editIndex];
    if (!q) return;
    const opts = editorCollectOptions();
    const letters = Object.keys(opts).sort();
    if (delta > 0) {
        if (letters.length >= 8) {
            alert('选项最多 8 个（A-H）');
            return;
        }
        opts[String.fromCharCode(65 + letters.length)] = '';
    } else {
        if (letters.length <= 2) {
            alert('至少保留 2 个选项');
            return;
        }
        const removedLetter = letters[letters.length - 1];
        delete opts[removedLetter];
        editorAnswer.value = normalizeAnswerString(editorAnswer.value)
            .split('').filter(l => opts[l]).join('');
    }
    q.options = opts;
    state.editorDirty = true;
    editorRenderOptions();
}


// 渲染选项编辑行（判断题固定 A正确/B错误）
export function editorRenderOptions() {
    const q = currentEditBank()[state.editIndex];
    if (!q) return;

    editorOptions.innerHTML = '';
    if (editorType.value === '判断') {
        ['正确', '错误'].forEach((text, i) => {
            const row = document.createElement('div');
            row.className = 'editor-option-row';
            const label = document.createElement('span');
            label.className = 'editor-option-letter';
            label.textContent = i === 0 ? 'A' : 'B';
            const input = document.createElement('input');
            input.className = 'editor-option-input';
            input.value = text;
            input.disabled = true;
            row.appendChild(label);
            row.appendChild(input);
            editorOptions.appendChild(row);
        });
        editorAddOption.classList.add('hidden');
        editorRemoveOption.classList.add('hidden');
        return;
    }

    editorAddOption.classList.remove('hidden');
    editorRemoveOption.classList.remove('hidden');
    const source = (q.options && Object.keys(q.options).length > 0)
        ? q.options
        : { A: '', B: '', C: '', D: '' };
    Object.keys(source).sort().forEach(letter => {
        const row = document.createElement('div');
        row.className = 'editor-option-row';
        const label = document.createElement('span');
        label.className = 'editor-option-letter';
        label.textContent = letter;
        const input = document.createElement('input');
        input.className = 'editor-option-input';
        input.dataset.letter = letter;
        input.value = source[letter] || '';
        input.addEventListener('input', () => { state.editorDirty = true; });
        row.appendChild(label);
        row.appendChild(input);
        editorOptions.appendChild(row);
    });
}


// 渲染当前题表单
export function editorRenderForm() {
    // 换题即清 AI 草稿台账与提示(否则会把上一题的 AI 值当成这题的)
    editorAiAnsweredAnswer = null;
    editorAiAnsweredAnalysis = null;
    if (editorAiAnswerNote) editorAiAnswerNote.textContent = '';
    if (bankColorNote) bankColorNote.textContent = '';
    renderBankColorPicker();
    // 版本记录挂在「题库设置」块里(👤 定调):它与配色/重命名一样属于整库设置,不属于某一道题
    const bankName = state.editBankName;
    // 版本面板挂在**宿主容器**里(#editor-versions-host,位于「错题本」与「危险操作」两块之间)。
    // 不能直接挂在 #editor-bank-admin 末尾:那会跑到危险区下面去 —— 而 DOM 只有 appendChild,
    // 没有"插到某个兄弟前面"的便捷写法(insertBefore 在测试桩里也没有)。
    if (bankName) {
        const host = document.getElementById('editor-versions-host')
            || document.getElementById('editor-bank-admin');
        // ⚠️ 用 removeChild 而不是 el.remove():vm 测试桩的元素桩没有 remove 方法,
        //    用它会直接 TypeError(踩过)。这里只摘掉上一次渲染的版本面板,其余兄弟节点保留。
        if (host) {
            const prev = host.querySelector('.bank-versions-panel');
            if (prev) host.removeChild(prev);
            const verPanel = renderVersionsForBank(bankName);
            if (verPanel) host.appendChild(verPanel);
        }
    }
    const q = currentEditBank()[state.editIndex];
    if (!q) return;

    editorStem.value = q.content || '';
    editorType.value = q.type === '多选' ? '多选' : (q.type === '判断' ? '判断' : '单选');
    editorAnswer.value = q.answer || '';
    editorExplanation.value = q.explanation || '';
    editorAnalysis.value = q.analysis || '';
    editorRenderOptions();
    state.editorDirty = false;
    // 列表的"当前行"高亮由 renderBankEditor 建行时直接给(每行都带 dataset.idx 对号),
    // 这里不再做二次扫描 —— 旧版那段"按 children 下标点亮"的代码在筛选下会点亮错的题(已删)。
}


// 从表单 DOM 收集当前选项
export function editorCollectOptions() {
    const opts = {};
    editorOptions.querySelectorAll('input.editor-option-input').forEach(inp => {
        if (!inp.disabled) opts[inp.dataset.letter] = inp.value;
    });
    return opts;
}


// ==================== 编辑级撤销(👤 2026-09-13:会话内、内存、深度 50)====================
// 打点纪律:**动 state 之前**先把旧值抓下来;闭包只负责改回 state,
// 落盘 + 刷新视图由这里统一做(调用点就不必各写一遍)。
function trackUndo(label, undoFn, redoFn) {
    pushUndo({
        label,
        undo: () => { undoFn(); saveToLocalStorage(); refreshQuestionBankView(); },
        redo: () => { redoFn(); saveToLocalStorage(); refreshQuestionBankView(); },
    });
}

// "内容真的变了吗"只看**用户可见的字段**:保存会顺手写内部标记(_typeExplicit)与来源标注
// (answerSource=null 之类),拿整对象比会把"原样保存"也当成一步 —— 撤销栈里就全是噪音。
function editableSignature(q) {
    // ⚠️ 缺键、null、空串要归一成同一个值:保存会顺手补齐 explanation/analysis 这些空字段,
    //    不归一的话"原样保存"也会被判定成改过(踩过)。
    const txt = (v) => (v === undefined || v === null ? '' : String(v));
    const opts = (q.options && Object.keys(q.options).length) ? q.options : {};
    return JSON.stringify([txt(q.content), txt(q.type), opts, txt(q.answer), txt(q.explanation), txt(q.analysis)]);
}

function afterUndoRedo() {
    state.editorDirty = false;
    if (state.editBankName) renderBankEditor();
    updateBanksList();
    updateBankSelect();
}

export function editorUndo() {
    if (!undoStep()) return false;
    afterUndoRedo();
    return true;
}

export function editorRedo() {
    if (!redoStep()) return false;
    afterUndoRedo();
    return true;
}

// 未保存修改守卫：返回 true 表示可以继续（已放弃或无修改）
export function editorGuard() {
    if (!state.editorDirty) return true;
    if (confirm('当前题目的修改尚未保存，确定放弃吗？')) {
        state.editorDirty = false;
        return true;
    }
    return false;
}


export function currentEditBank() {
    return (state.editBankName && state.questionBanks[state.editBankName]) || [];
}


// 重建当前题目视图：在"全部题库"合并视图下题库发生增删改后调用
export function refreshQuestionBankView() {
    if (!state.isAllBanksView) return;
    state.questionBank = [];
    Object.values(state.questionBanks).forEach(bank => {
        state.questionBank = [...state.questionBank, ...bank];
    });
}


// 更新题库列表

// ==================== 按库内嵌渲染(P0-1.9:错题归题库卡手风琴) ====================

// ==================== 题目卡片(错题 / 收藏 共用一套结构)====================
// 👤 定调 2026-09-11:错题卡与收藏卡**统一设计**,且题型/收藏/删除一律放在**题干上方一行**。
// 结构:`.q-card > .q-card-tags(题型 + 状态徽章 + 收藏 + 删除) + 题干 + 选项 + details(答案/解析)`。
// 与刷题页的 `.question-tags` 同一条规矩:标签行在题干之上、自成一行,不影响题干宽度。

// 题库卡配色(👤 2026-09-11 选定):'grey' = 缺省(白底,与其他卡片一致)。
// ⚠️ 这里的 value 必须与 styles.css 的 .bank-item[data-color="..."] 一一对应。
export const BANK_COLORS = [
    { value: 'grey', name: '灰(默认)' },
    { value: 'blue', name: '蓝' },
    { value: 'green', name: '绿' },
    { value: 'red', name: '红' },
    { value: 'amber', name: '琥珀' },
    { value: 'teal', name: '青' },
];
export const BANK_COLOR_VALUES = BANK_COLORS.map(c => c.value);

// 取某库的配色(非法/缺省 → grey)
export function bankColorOf(bankName) {
    const v = state.bankColors && state.bankColors[bankName];
    return BANK_COLOR_VALUES.includes(v) ? v : 'grey';
}

// 设置某库配色并落盘
export function setBankColor(bankName, color) {
    if (!BANK_COLOR_VALUES.includes(color)) return false;
    state.bankColors = state.bankColors || {};
    if (color === 'grey') delete state.bankColors[bankName];   // 缺省即灰,不留冗余字段
    else state.bankColors[bankName] = color;
    saveToLocalStorage();
    return true;
}

// 切换编辑标签页(编辑题目 / 题库设置)。选中态由 CSS 的 :has(input:checked) 表达,
// 这里只把状态同步到主体上,供 CSS 选择要显示哪一页。
export function switchEditorTab(tab) {
    const t = tab === 'bank' ? 'bank' : 'question';
    if (editorBody) editorBody.setAttribute('data-tab', t);
    if (editorTabQuestion) editorTabQuestion.checked = t === 'question';
    if (editorTabBank) editorTabBank.checked = t === 'bank';
}

// 删除某一道题(按下标;题号列表里的 ✕ 用)。与「删除本题」共用同一套语义。
// 渲染配色色板(编辑器内)。每个色块 = 一个按钮,点一下即改并立即落盘 ——
// 配色是"看一眼就想调"的东西,不值得为它走一遍保存流程。
export function renderBankColorPicker() {
    if (!bankColorPicker) return;
    // ⚠️ 取一次库名并守卫:editorClose() 会把 editBankName 置 null,
    //    关闭动画期间的重绘不该去读一个已失效的库名(否则渲染出空壳,看着像"功能坏了")
    const bankName = state.editBankName;
    if (!bankName) { bankColorPicker.innerHTML = ''; return; }
    const current = bankColorOf(bankName);
    bankColorPicker.innerHTML = '';
    BANK_COLORS.forEach(c => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'bank-color-swatch' + (c.value === current ? ' active' : '');
        btn.dataset.color = c.value;
        btn.setAttribute('aria-pressed', c.value === current ? 'true' : 'false');
        btn.title = c.value === 'grey' ? '与其它卡片一致的默认样式' : `把本库卡片染成${c.name}`;
        const dot = document.createElement('span');
        dot.className = 'bank-color-dot';
        btn.appendChild(dot);
        const label = document.createElement('span');
        label.textContent = c.name;
        btn.appendChild(label);
        btn.addEventListener('click', () => {
            if (!setBankColor(state.editBankName, c.value)) return;
            renderBankColorPicker();
            updateBanksList();   // 库卡上的颜色立刻跟着变
            if (bankColorNote) bankColorNote.textContent = c.value === 'grey' ? '已恢复默认' : `已设为${c.name}`;
        });
        bankColorPicker.appendChild(btn);
    });
}

// 题干上方那一行。返回元素,调用方自行 append 到卡片最前。
function buildCardTagRow(question, opts = {}) {
    const row = document.createElement('div');
    row.className = 'question-card-tags';

    // 题型:仍用 ［单选］ 全角括号文案(沿用原有约定,用户与测试都已熟悉)
    const type = document.createElement('span');
    type.className = 'error-type-line';
    type.textContent = `［${question.type || '未知'}］`;
    row.appendChild(type);

    // 状态徽章(收藏卡标"在错题本";错题卡标"已收藏"由按钮本身表达)
    if (opts.statusBadge) {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = opts.statusBadge;
        row.appendChild(badge);
    }

    row.appendChild(buildFavoriteButton(question, opts.favoriteText));
    row.appendChild(buildDeleteButton(opts.onDelete));
    return row;
}

// 收藏按钮:两处卡片共用。onClick 缺省即"切换收藏",传入时用调用方的(收藏卡里就是取消收藏)
function buildFavoriteButton(question, text) {
    const isFav = state.favoriteQuestions.some(fq => fq.content === question.content);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'question-card-btn question-card-fav';
    btn.textContent = text !== undefined ? text : (isFav ? '★ 已收藏' : '☆ 收藏');
    btn.addEventListener('click', () => {
        toggleFavorite(question, question.bankName);
        // 跨模块通知:库卡内嵌面板需要整块重绘,但不允许互相 import(见架构铁律 4)
        if (typeof CustomEvent !== 'undefined' && document.dispatchEvent) {
            document.dispatchEvent(new CustomEvent('zquiz:embeds-dirty'));
        }
    });
    return btn;
}

// 删除按钮:onDelete 由调用方给(错题本=移出错题本;收藏=取消收藏)
function buildDeleteButton(onDelete) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'question-card-btn question-card-del';
    btn.textContent = '删除';
    if (onDelete) btn.addEventListener('click', onDelete);
    return btn;
}

// AI 生成标注的统一写法(P1-1.5):展示位一律用它,不要各处自己拼字符串。
// 诚实呈现:用户看到 🤖 就知道这个答案/解析不是来自材料原文,可信度自行判断。
export function aiMark(source) {
    return source === 'ai' ? '(🤖 AI 生成,未核验)' : '';
}

// 判断题按对错展示、选择题给「A. 选项原文」(唯一展示入口)
function answerText(answer, question) {
    return answer ? formatAnswerForDisplay(answer, question) : '(未答)';
}

// 生成单个遮挡式错题条目:默认只显示题干;「查看答案」展开后红绿对比 + 解析
// index = 该错题在 state.errorQuestions 中的真实下标(删除用);bankName = 归属库
function buildErrorItem(question, index) {
    const item = document.createElement('div');
    item.className = 'question-card error-card';

    // 题型 + 收藏 + 删除:题干上方一行(👤 定调)
    item.appendChild(buildCardTagRow(question, {
        onDelete: () => {
            state.errorQuestions.splice(index, 1);
            saveToLocalStorage();
            updateBanksList();
        },
    }));

    const title = document.createElement('h4');
    title.textContent = question.content;
    item.appendChild(title);

    // 选项裸露:错题常是"选项没印象了",不列选项无法复盘(👤 反馈:错题本缺选项)
    // 注意**不标注哪个是用户选错的** —— 选错本身没有信息量,且会提前泄底;
    // 正确答案在下方 details 里,靠主动回忆遮挡。
    const optKeys = Object.keys(question.options || {}).sort();
    if (optKeys.length) {
        const opts = document.createElement('p');
        opts.className = 'error-options';
        opts.textContent = optKeys.map(k => `${k}. ${question.options[k]}`).join('　');
        item.appendChild(opts);
    }

    // 主动回忆遮挡:答案/解析藏进 details,展开才见红绿对比
    const reveal = document.createElement('details');
    reveal.className = 'answer-reveal';
    const summary = document.createElement('summary');
    summary.textContent = '查看答案';
    reveal.appendChild(summary);

    const yourAnswer = document.createElement('p');
    yourAnswer.className = 'your-answer';
    yourAnswer.textContent = `你的答案:${answerText(question.userAnswer, question)}`;
    reveal.appendChild(yourAnswer);

    const correctAnswer = document.createElement('p');
    correctAnswer.className = 'correct-answer';
    correctAnswer.textContent = `正确答案${aiMark(question.answerSource)}:${formatAnswerForDisplay(question.answer, question)}`;
    reveal.appendChild(correctAnswer);

    const analysis = document.createElement('p');
    analysis.textContent = `解析${aiMark(question.analysisSource)}:${question.analysis || question.explanation || '暂无解析'}`;
    reveal.appendChild(analysis);
    item.appendChild(reveal);

    if ((question.correctStreak || 0) > 0 && state.masteryThreshold > 0) {
        const mastery = document.createElement('p');
        mastery.className = 'mastery-note';
        mastery.textContent = `已连对 ${question.correctStreak} 次,再答对 ${state.masteryThreshold - question.correctStreak} 次自动移出错题本`;
        item.appendChild(mastery);
    }

    return item;
}


// 某题库的错题手风琴面板(空库返回 null)
export function renderErrorsForBank(bankName) {
    const indices = [];
    state.errorQuestions.forEach((q, i) => {
        if ((q.bankName || '未知题库') === bankName) indices.push(i);
    });
    if (indices.length === 0) return null;
    const wrap = document.createElement('div');
    wrap.className = 'bank-errors-panel';
    const head = document.createElement('h4');
    head.className = 'bank-panel-title';
    head.textContent = `错题(${indices.length})`;
    wrap.appendChild(head);
    indices.forEach(i => wrap.appendChild(buildErrorItem(state.errorQuestions[i], i)));
    return wrap;
}

// 某题库的收藏面板(空返回 null)
export function renderFavoritesForBank(bankName) {
    const favs = state.favoriteQuestions.filter(fq => (fq.bankName || '未知题库') === bankName);
    if (favs.length === 0) return null;
    const wrap = document.createElement('div');
    wrap.className = 'bank-favorites-panel';
    const head = document.createElement('h4');
    head.className = 'bank-panel-title';
    head.textContent = `收藏(${favs.length})`;
    wrap.appendChild(head);
    favs.forEach(fq => wrap.appendChild(buildFavoriteItem(fq)));
    return wrap;
}

// 单个收藏条目。**与错题卡同一套结构与样式**(👤 定调:两卡统一),
// 差别只有:左条用收藏色、展开区多一行"正确答案"、下方多一个「取消收藏」。
function buildFavoriteItem(fq) {
    const item = document.createElement('div');
    item.className = 'question-card fav-item';

    const inErrors = state.errorQuestions.some(eq => eq.content === fq.content);
    item.appendChild(buildCardTagRow(fq, {
        statusBadge: inErrors ? '📕 在错题本' : '',
        onDelete: () => {
            toggleFavorite(fq, fq.bankName);
            if (typeof CustomEvent !== 'undefined' && document.dispatchEvent) {
                document.dispatchEvent(new CustomEvent('zquiz:embeds-dirty'));
            }
        },
    }));

    const title = document.createElement('h4');
    title.textContent = fq.content;
    item.appendChild(title);

    const optKeys = Object.keys(fq.options || {}).sort();
    if (optKeys.length) {
        const opts = document.createElement('p');
        opts.className = 'error-options';
        opts.textContent = optKeys.map(k => `${k}. ${fq.options[k]}`).join('　');
        item.appendChild(opts);
    }

    // 与错题卡一样走主动回忆遮挡:先自己回忆,再展开对答案
    const reveal = document.createElement('details');
    reveal.className = 'answer-reveal';
    const summary = document.createElement('summary');
    summary.textContent = '查看答案';
    reveal.appendChild(summary);

    const correctAnswer = document.createElement('p');
    correctAnswer.className = 'correct-answer';
    correctAnswer.textContent = `正确答案${aiMark(fq.answerSource)}:${answerText(fq.answer, fq)}`;
    reveal.appendChild(correctAnswer);

    const analysis = document.createElement('p');
    analysis.textContent = `解析${aiMark(fq.analysisSource)}:${fq.analysis || fq.explanation || '暂无解析'}`;
    reveal.appendChild(analysis);
    item.appendChild(reveal);

    return item;
}

export function updateBanksList() {
    const bankNames = Object.keys(state.questionBanks);

    if (bankNames.length === 0) {
        banksList.innerHTML = '<p class="empty-message">暂无题库:点右上角「＋ 创建题库」,或回首页导入</p>';
        return;
    }

    banksList.innerHTML = '';

    bankNames.forEach(bankName => {
        const questions = state.questionBanks[bankName] || [];
        const errCount = state.errorQuestions.filter(q => (q.bankName || '未知题库') === bankName).length;
        const favCount = state.favoriteQuestions.filter(q => (q.bankName || '未知题库') === bankName).length;
        const pendingCount = questions.filter(q => !q.answer).length;

        const bankItem = document.createElement('div');
        bankItem.className = 'bank-item';
        const color = bankColorOf(bankName);
        if (color !== 'grey') bankItem.setAttribute('data-color', color);   // 灰色是缺省,不写属性

        // 标题行:库名 + 状态徽章
        // 左上:库名 + 状态徽章
        const bankInfo = document.createElement('div');
        bankInfo.className = 'bank-info';
        const bankTitle = document.createElement('h3');
        bankTitle.textContent = bankName;
        bankInfo.appendChild(bankTitle);
        const badges = document.createElement('div');
        badges.className = 'bank-badges';
        const mkBadge = (text, cls) => { const b = document.createElement('span'); b.className = 'badge ' + (cls || ''); b.textContent = text; badges.appendChild(b); };
        mkBadge(`${questions.length} 题`);
        if (pendingCount > 0) mkBadge(`待补 ${pendingCount}`, 'warn-badge');
        if (errCount > 0) mkBadge(`错 ${errCount}`, 'err-badge');
        if (favCount > 0) mkBadge(`藏 ${favCount}`, 'fav-badge');
        bankInfo.appendChild(badges);

        // 右上:编辑(「开始刷题」已移出题库页;刷题入口统一在刷题页的"题源/选择题库")
        const bankActions = document.createElement('div');
        bankActions.className = 'bank-actions';

        const editBtn = document.createElement('button');
        editBtn.className = 'action-btn small secondary';
        editBtn.textContent = '✎ 编辑';
        editBtn.addEventListener('click', () => editBank(bankName));
        bankActions.appendChild(editBtn);

        // 左下:错题按钮;右下:收藏按钮
        const cardFoot = document.createElement('div');
        cardFoot.className = 'bank-card-foot';

        const errToggle = document.createElement('button');
        errToggle.className = 'foot-toggle' + (state.expandedBanks['err:' + bankName] ? ' open' : '');
        errToggle.innerHTML = `📕 错题 <b>${errCount}</b>`;
        errToggle.addEventListener('click', () => {
            const open = !state.expandedBanks['err:' + bankName];
            state.expandedBanks['err:' + bankName] = open;
            if (open) state.expandedBanks['fav:' + bankName] = false;  // 互斥:收起收藏
            saveCollapsedBanks();
            updateBanksList();
        });
        cardFoot.appendChild(errToggle);

        const favToggle = document.createElement('button');
        favToggle.className = 'foot-toggle fav' + (state.expandedBanks['fav:' + bankName] ? ' open' : '');
        favToggle.innerHTML = `⭐ 收藏 <b>${favCount}</b>`;
        favToggle.addEventListener('click', () => {
            const open = !state.expandedBanks['fav:' + bankName];
            state.expandedBanks['fav:' + bankName] = open;
            if (open) state.expandedBanks['err:' + bankName] = false;  // 互斥:收起错题
            saveCollapsedBanks();
            updateBanksList();
        });
        cardFoot.appendChild(favToggle);

        bankItem.appendChild(bankInfo);
        bankItem.appendChild(bankActions);
        bankItem.appendChild(cardFoot);

        banksList.appendChild(bankItem);

        // 展开面板(默认折叠):错题在下、收藏在其下,仅点了对应按钮才出现
        if (state.expandedBanks['err:' + bankName]) {
            const errPanel = renderErrorsForBank(bankName);
            if (errPanel) banksList.appendChild(errPanel);
            else {
                const empty = document.createElement('p');
                empty.className = 'empty-message';
                empty.textContent = '本库暂无错题 🎉';
                banksList.appendChild(empty);
            }
        }
        if (state.expandedBanks['fav:' + bankName]) {
            const favPanel = renderFavoritesForBank(bankName);
            if (favPanel) banksList.appendChild(favPanel);
            else {
                const empty = document.createElement('p');
                empty.className = 'empty-message';
                empty.textContent = '本库暂无收藏';
                banksList.appendChild(empty);
            }
        }

    });

    // 杂项兜底:错题/收藏的 bankName 已不在题库列表(库被删等)
    const liveNames = new Set(bankNames);
    const miscNames = new Set();
    state.errorQuestions.forEach(q => { const n = q.bankName || '未知题库'; if (!liveNames.has(n)) miscNames.add(n); });
    state.favoriteQuestions.forEach(q => { const n = q.bankName || '未知题库'; if (!liveNames.has(n)) miscNames.add(n); });
    miscNames.forEach(name => {
        const miscItem = document.createElement('div');
        miscItem.className = 'bank-item misc-bank';
        const info = document.createElement('div');
        info.className = 'bank-info';
        const t = document.createElement('h3');
        t.textContent = `杂项 · ${name}`;
        info.appendChild(t);
        miscItem.appendChild(info);
        miscItem.addEventListener('click', () => {
            state.expandedBanks['misc:' + name] = !state.expandedBanks['misc:' + name];
            saveCollapsedBanks();
            updateBanksList();
        });
        banksList.appendChild(miscItem);
        if (state.expandedBanks['misc:' + name]) {
            const errPanel = renderErrorsForBank(name);
            if (errPanel) banksList.appendChild(errPanel);
            const favPanel = renderFavoritesForBank(name);
            if (favPanel) banksList.appendChild(favPanel);
        }
    });

    if (typeof window !== 'undefined' && !window.__embedsListener) {
        window.__embedsListener = true;  // 仅浏览器注册(vm 沙箱无 window)
        document.addEventListener('zquiz:embeds-dirty', () => updateBanksList());
    }
}// ==================== 库级版本快照 UI(P0-1.11) ====================
// ==================== 库级版本快照 UI(P0-1.11) ====================
// 逻辑:破坏性操作**之前**自动存一份(覆盖导入 / 去重 / 恢复前);每库 3 版、全站 10 版,超出按时间淘汰。
// 它是**自动安全网、不是备份系统** —— 所以每条都必须能单独删掉(👤 反馈的缺口):
// 存错了、不想留了就得立刻清掉,否则只能干等它被淘汰。
// ==================== 库级版本快照 UI(P0-1.11) ====================
export function renderVersionsForBank(bankName) {
    const versions = (bankName ? loadBankVersions()[bankName] : []) || [];
    const wrap = document.createElement('div');
    wrap.className = 'bank-versions-panel';

    const head = document.createElement('p');
    head.className = 'editor-panel-title';
    head.textContent = `版本记录（${versions.length} / ${VERSIONS_PER_BANK}）`;
    wrap.appendChild(head);

    // 会话内撤销/重做(👤 2026-09-13):细活走撤销栈,大安全网走下面的版本列表 —— 两者分工写在这里
    const stepRow = document.createElement('div');
    stepRow.className = 'version-step-row';
    const undoBtn = document.createElement('button');
    undoBtn.type = 'button';
    undoBtn.className = 'action-btn small secondary';
    undoBtn.textContent = '↩︎ 撤销上一步';
    undoBtn.disabled = !canUndo();
    undoBtn.title = canUndo() ? `撤销:${undoLabel()}` : '本次会话还没有可撤销的编辑';
    undoBtn.addEventListener('click', () => editorUndo());
    const redoBtn = document.createElement('button');
    redoBtn.type = 'button';
    redoBtn.className = 'action-btn small secondary';
    redoBtn.textContent = '↪︎ 重做';
    redoBtn.disabled = !canRedo();
    redoBtn.title = canRedo() ? `重做:${redoLabel()}` : '没有可重做的步骤';
    redoBtn.addEventListener('click', () => editorRedo());
    stepRow.appendChild(undoBtn);
    stepRow.appendChild(redoBtn);
    const stepNote = document.createElement('span');
    stepNote.className = 'meta-note';
    stepNote.textContent = '撤销栈只在本次会话有效(刷新即清);跨会话回退用下面的版本列表';
    stepRow.appendChild(stepNote);
    wrap.appendChild(stepRow);

    const note = document.createElement('p');
    note.className = 'meta-note';
    note.textContent = versions.length
        ? `导入 / 覆盖导入 / 去重 / 批量删除 / 恢复前都会自动存一份;每库保留最近 ${VERSIONS_PER_BANK} 版。`
        : `暂无版本。导入、覆盖导入、去重、批量删除、恢复等操作都会自动存一份,可随时回退(每库 ${VERSIONS_PER_BANK} 版)。`;
    wrap.appendChild(note);
    if (versions.length === 0) return wrap;

    // 新的在上。⚠️ 闭包里用的是**原数组下标**(恢复/删除都按它定位),不是显示顺序 —— 别改成 forEach 的序号。
    versions.map((v, i) => ({ v, i })).reverse().forEach(({ v, i }) => {
        const when = new Date(v.time);
        const pad = (n) => String(n).padStart(2, '0');
        const label = `${v.action} · ${when.getMonth() + 1}/${when.getDate()} ${pad(when.getHours())}:${pad(when.getMinutes())} · ${(v.questions || []).length} 题`
            + (v.source ? ` · ${v.source}` : '');

        const item = document.createElement('div');
        item.className = 'version-item';

        const info = document.createElement('span');
        info.className = 'version-info';
        info.textContent = label;
        item.appendChild(info);

        const restoreBtn = document.createElement('button');
        restoreBtn.type = 'button';
        restoreBtn.className = 'action-btn small';
        restoreBtn.textContent = '恢复此版';
        restoreBtn.addEventListener('click', () => {
            if (confirm(`把「${bankName}」恢复到这一版？\n（${label}）\n当前内容会先自动存为一版,可再回退。`)) {
                restoreBankVersion(bankName, i);
                renderBankEditor();
            }
        });
        item.appendChild(restoreBtn);

        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'delete-btn version-del';
        delBtn.textContent = '✕';
        delBtn.title = '删除这条版本';
        delBtn.setAttribute('aria-label', `删除版本：${label}`);
        delBtn.addEventListener('click', () => {
            if (!confirm(`删除这条版本记录？\n（${label}）`)) return;
            deleteBankVersion(bankName, i);
            renderBankEditor();
        });
        item.appendChild(delBtn);

        wrap.appendChild(item);
    });
    return wrap;
}

// ==================== 回收站 UI(P0-1.10) ====================

export function renderRecycleBin() {
    const list = document.getElementById('recycle-list');
    const binWrap = document.getElementById('recycle-bin');
    if (!list || !binWrap) return;
    const bin = loadRecycledBanks();
    const entries = Object.entries(bin).sort((a, b) => (b[1].deletedAt || '').localeCompare(a[1].deletedAt || ''));
    // 计数只改**独立的 span**:整条 summary 重写会把里面的图标/结构一起冲掉
    // (而且 summary 现在是悬浮菜单的触发器,文本结构要稳住)
    if (recycleCount) recycleCount.textContent = `(${entries.length})`;
    list.innerHTML = '';
    if (entries.length === 0) {
        list.innerHTML = '<p class="empty-message">回收站为空</p>';
        return;
    }
    entries.forEach(([name, pkg]) => {
        const item = document.createElement('div');
        item.className = 'recycle-item';
        const when = new Date(pkg.deletedAt);
        const info = document.createElement('span');
        info.textContent = `${name} · ${((pkg.bank) || []).length} 题 · ${when.getMonth() + 1}/${when.getDate()} 删除`;
        item.appendChild(info);
        const restoreBtn = document.createElement('button');
        restoreBtn.className = 'action-btn small';
        restoreBtn.textContent = '恢复';
        restoreBtn.addEventListener('click', () => restoreRecycled(name));
        const purgeBtn = document.createElement('button');
        purgeBtn.className = 'action-btn small secondary';
        purgeBtn.textContent = '彻底删除';
        purgeBtn.addEventListener('click', () => {
            if (confirm(`彻底删除"${name}"?此操作不可恢复!`)) {
                purgeRecycledBank(name);
                renderRecycleBin();
            }
        });
        item.appendChild(restoreBtn);
        item.appendChild(purgeBtn);
        list.appendChild(item);
    });
}

export function restoreBankVersion(name, index) {
    const versions = loadBankVersions()[name] || [];
    const v = versions[index];
    if (!v) return false;
    pushBankVersion(name, '恢复前自动存', state.questionBanks[name] || []);
    const beforeRestore = (state.questionBanks[name] || []).slice();
    state.questionBanks[name] = JSON.parse(JSON.stringify(v.questions));
    const afterRestore = state.questionBanks[name].slice();
    const setBankArr = (arr) => {
        state.questionBanks[name] = arr;
        if (state.currentBankName === name) state.questionBank = arr;
    };
    trackUndo(`恢复到「${v.action}」那一版`, () => setBankArr(beforeRestore.slice()), () => setBankArr(afterRestore.slice()));
    // 先对齐当前视图引用,再落盘(否则旧引用会把恢复结果覆盖回去)
    if (state.currentBankName === name) state.questionBank = state.questionBanks[name];
    saveToLocalStorage();
    refreshQuestionBankView();
    updateBanksList();
    return true;
}

export function recycleBankEntry(name, pkg) {
    return recycleBank(name, pkg);
}

export function restoreRecycled(name) {
    let target = name;
    if (state.questionBanks[target]) target = `${name}·恢复`;
    const pkg = restoreRecycledBank(name);
    if (!pkg) return;
    state.questionBanks[target] = pkg.bank || [];
    (pkg.errors || []).forEach(e => { e.bankName = target; state.errorQuestions.push(e); });
    (pkg.favorites || []).forEach(f => { f.bankName = target; state.favoriteQuestions.push(f); });
    saveToLocalStorage();
    updateBankSelect();
    updateBanksList();
    renderRecycleBin();
    alert(`已恢复为"${target}"`);
}


// 导出单个题库
function pushHistMark(q, type) {
    if (!q) return;
    q.histMarks = Array.isArray(q.histMarks) ? q.histMarks : [];
    if (q.histMarks.some(m => m.type === type)) return;
    q.histMarks.push({ type, time: new Date().toISOString() });
}


// 行内渲染:走事件委托,innerHTML 重建不丢监听
function renderEditorHistRow(q) {
    const row = document.getElementById('editor-hist-row');
    if (!row) return;
    const marks = (q && Array.isArray(q.histMarks)) ? q.histMarks : [];
    if (marks.length === 0) {
        row.innerHTML = '';
        row.style.display = 'none';
        return;
    }
    row.style.display = '';
    const label = { ai: '🤖 曾 AI 整理', pending: '⏳ 曾待补' };
    row.innerHTML = marks.map((m, i) =>
        `<span class="hist-chip">${label[m.type] || m.type}<button type="button" data-hist-del="${i}" title="删除这条历史标记">×</button></span>`
    ).join('');
}

// 委托处理:删除某条历史标记(即时生效并落盘)
export function editorHistClick(e) {
    const target = e && e.target;
    if (!target || target.dataset.histDel === undefined) return;
    const questions = currentEditBank();
    const q = questions[state.editIndex];
    if (!q || !Array.isArray(q.histMarks)) return;
    q.histMarks.splice(parseInt(target.dataset.histDel, 10), 1);
    if (q.histMarks.length === 0) delete q.histMarks;
    saveToLocalStorage();
    renderEditorHistRow(q);
}

export function renderBankEditor() {
    renderBankColorPicker();
    // 撤销键的状态跟着栈走(卡片里那颗)
    if (editorUndoBtn) {
        editorUndoBtn.disabled = !canUndo();
        editorUndoBtn.title = canUndo() ? `撤销:${undoLabel()}（⌘/Ctrl+Z）` : '本次会话还没有可撤销的编辑';
    }
    // 首次渲染时把标签页定到"编辑题目"(HTML 里也有默认值,这里是双保险 ——
    // 缺了它首屏会出现"两页都隐藏"的空壳,实测踩过)
    if (!editorBody || !editorBody.getAttribute('data-tab')) switchEditorTab('question');
    pruneSelection();
    const questions = currentEditBank();
    const visible = visibleQuestions();
    const filterOn = activeFilterCount() > 0;

    // ---------- 列表:每行 = 复选框 + 序号 + 题干 + 标签徽章(只有复选框能选中) ----------
    editorQuestionList.innerHTML = '';
    visible.forEach(({ q, idx }) => {
        // 行 = 普通容器,**只有复选框能选中**(👤 要求)。
        // 早先做成 <label> 包住复选框、点题干也等于勾选 —— 用户明确不要:
        // 扫读题干时手一碰就选上了,想改主意还得再点一次「取消选择」。
        const row = document.createElement('div');
        // 待修改(缺答案/选项不足)用**淡黄底**标记;当前题淡主色底;**左条一律不加**(👤:"那根蓝条很丑")
        const needsFix = !q.answer || Object.keys(q.options || {}).length < 2;
        row.className = 'q-row'
            + (idx === state.editIndex ? ' current' : '')
            + (isSelected(q) ? ' picked' : '')
            + (needsFix ? ' needs-fix' : '');
        row.dataset.idx = String(idx);

        const box = document.createElement('input');
        box.type = 'checkbox';
        box.className = 'q-row-check';
        box.checked = isSelected(q);
        box.setAttribute('aria-label', `选择第 ${idx + 1} 题`);
        // 唯一的选中入口。用 change(而不是 click):键盘空格、脚本置位都能走到
        box.addEventListener('change', () => { editorToggleSelect(q, box.checked); });
        // 复选框只负责**圈选**(喂给"只看勾选"筛选与批量删除),它不该顺带把编辑卡片掀开
        box.addEventListener('click', (e) => { if (e && e.stopPropagation) e.stopPropagation(); });
        row.appendChild(box);

        const no = document.createElement('span');
        no.className = 'q-row-no';
        no.textContent = String(idx + 1);   // 用**真实下标**+1:筛过之后仍能让用户对上"这是第几题"
        row.appendChild(no);

        const text = document.createElement('span');
        text.className = 'q-row-text';
        text.textContent = (q.content || '（无题干）').slice(0, 48);
        row.appendChild(text);

        row.appendChild(rowBadges(q));
        // **单击 = 高亮(设为当前题),双击 = 选中并翻开编辑卡片**(👤 定调)。
        // 复选框留给"圈选/筛选",两条通道各管一件事:
        //   单击 → 我正看着这一道(只高亮,不打扰)
        //   双击 → 我要改这一道(进卡片)
        //   勾复选框 → 我要圈出一批(只看勾选 / 批量删除)
        row.addEventListener('click', (e) => {
            if (isRowCheckboxEvent(e)) return;         // 点复选框不算"点题目"
            if (state.editIndex === idx) return;
            // ⚠️ 这里**只换高亮,不重画列表**:重画会把这一行节点换掉,紧接着的第二次点击就落到了
            //    新节点上 —— 浏览器判定"两次点击不同目标",dblclick 永远不触发(实测踩过)。
            state.editIndex = idx;
            highlightCurrentRow();
            updateQuestionCardHead();
        });
        row.addEventListener('dblclick', (e) => {
            if (isRowCheckboxEvent(e)) return;
            if (!editorGuard()) return;
            openQuestionCard(idx);
        });
        editorQuestionList.appendChild(row);
    });

    // 列表末尾的「＋」(👤 要求):新增入口就是列表最后一行 —— 位置本身在说"往这里再加一道"
    const addRow = document.createElement('button');
    addRow.type = 'button';
    addRow.className = 'editor-list-add';
    addRow.title = '新增题目';
    addRow.setAttribute('aria-label', '新增题目');
    addRow.textContent = '＋';
    addRow.addEventListener('click', () => editorAddQuestion());
    editorQuestionList.appendChild(addRow);

    // ---------- 标签页角标(唯一的计数处)+ 筛选按钮角标 ----------
    // ⚠️ 工具行里**不再**有"共 N 题"文案:与标签页的「编辑题目 N」重复(👤 要求删掉)。
    //    筛选时标签页角标自动变成 "3/28",信息一点没少。
    if (editorTabQuestionCount) {
        editorTabQuestionCount.textContent = filterOn ? `${visible.length}/${questions.length}` : `${questions.length}`;
    }
    const activeCount = activeFilterCount();
    if (editorFilterCount) {
        editorFilterCount.textContent = activeCount ? ` ${activeCount}` : '';
        editorFilterCount.classList.toggle('hidden', activeCount === 0);
    }
    if (editorFilterToggle) editorFilterToggle.classList.toggle('active', activeCount > 0);
    // chip 的选中态在这里**统一回写**(单一数据源 = state.editorFilter):
    // 点击只改状态,谁都不许自己加类 —— 否则"点了没用/状态对不上"这类 bug 迟早出现。
    document.querySelectorAll('.filter-chip').forEach(chip => {
        const on = (state.editorFilter[chip.dataset.filter] || []).indexOf(chip.dataset.value) !== -1;
        chip.classList.toggle('active', on);
        chip.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    // 「只看勾选」这条条件的输入就是勾选集:数量写进文案,没勾选时禁用(点它只会得到空列表)
    const scopeChip = document.getElementById('editor-filter-scope');
    if (scopeChip) {
        const n = state.editorSelected.length;
        scopeChip.textContent = n ? `只看勾选的 ${n} 题` : '只看勾选(先勾题)';
        scopeChip.disabled = n === 0;
        if (n === 0 && (state.editorFilter.scope || []).indexOf('checked') !== -1) {
            scopeChip.classList.remove('active');
            scopeChip.setAttribute('aria-pressed', 'false');
        }
    }

    // ---------- 批量操作栏:没选中就一个按钮都不出现(👤 要求) ----------
    const selCount = state.editorSelected.length;
    if (editorBulkBar) editorBulkBar.classList.toggle('hidden', selCount === 0);
    if (editorBulkCount) editorBulkCount.textContent = selCount ? `已选 ${selCount} 题` : '';
    // 勾選集是"圈选":它同时是「只看勾选」筛选条件的输入和批量删除的目标。
    // ⚠️ 这里刻意**不再放「编辑」按钮** —— 点题目本身就会翻开编辑卡片(👤 补充逻辑),
    //    再放一个编辑键是同一个动作的第二个入口,只会占掉这一行的宽度(👤 正抱怨删除被挤到第二行)。

    // ---------- 空态:分两种 —— "库里没题"和"筛没了",说法不同(不然用户以为题目丢了) ----------
    if (questions.length === 0) {
        if (editorEmpty) {
            editorEmpty.textContent = '该题库暂无题目，点列表末尾的「＋」添加';
            editorEmpty.classList.remove('hidden');
        }
    } else if (visible.length === 0) {
        if (editorEmpty) {
            editorEmpty.textContent = '没有符合筛选的题目 —— 换个条件,或点「清除筛选」';
            editorEmpty.classList.remove('hidden');
        }
    } else if (editorEmpty) {
        editorEmpty.classList.add('hidden');
    }

    // ---------- 当前题(编辑卡片里的表单 + 提示行) ----------
    updateQuestionCardHead();
    const cur = questions[state.editIndex];
    if (!cur) {
        editorForm.classList.add('hidden');
        return;
    }
    editorForm.classList.remove('hidden');
    renderEditorHistRow(cur);
    const aiNoteEl = document.getElementById('editor-ai-note');
    if (aiNoteEl) {
        const aiTouched = cur && cur.aiSource === 'ai';
        const fixes = [];
        if (cur && !cur.answer) fixes.push('缺答案（待补）');
        if (cur && Object.keys(cur.options || {}).length < 2) fixes.push('选项不足');
        const lines = [];
        if (aiTouched) lines.push({ text: '🤖 此题经 AI 整理导入；保存修改后标记自动消除', cls: 'editor-ai-note' });
        if (fixes.length) lines.push({ text: '⚠ 此题' + fixes.join('、') + '；补全并保存后黄色高亮自动消失', cls: 'editor-ai-note fix-note' });
        // 双状态并存(AI 整理但仍缺答案)时,两行提示都显示
        aiNoteEl.innerHTML = lines.map(l => `<div class="${l.cls}">${l.text}</div>`).join('');
        aiNoteEl.className = lines.length ? 'editor-ai-note stacked' : 'editor-ai-note';
    }
    editorRenderForm();
}

// 点击是否落在该行的复选框上(复选框只负责圈选,不该被当成"点题目")
function isRowCheckboxEvent(e) {
    const t = e && e.target;
    return !!(t && t.classList && t.classList.contains('q-row-check'));
}

// 只把"当前题"的高亮换掉,不重建列表节点(重建会让双击的第二下落到新节点上 → dblclick 丢失)
function highlightCurrentRow() {
    Array.from(editorQuestionList.children).forEach(el => {
        if (!el.classList || !el.classList.contains('q-row')) return;
        el.classList.toggle('current', parseInt(el.dataset.idx, 10) === state.editIndex);
    });
}

// 行内标签徽章:让"这道题什么状态"在列表里一眼可见 —— 它同时是筛选面板的视觉词典
// (筛选项与徽章一一对应,用户看久了就知道 ⏳ 是什么)。最多 4 个,其余进 title 提示,免得行变成横幅。
function rowBadges(q) {
    const wrap = document.createElement('span');
    wrap.className = 'q-row-badges';
    const all = [];
    if (q.type) all.push({ text: q.type, cls: 'type' });
    if (!q.answer) all.push({ text: '⏳ 待补', cls: 'warn', title: '还没有答案' });
    else if (Object.keys(q.options || {}).length < 2) all.push({ text: '⚠ 选项不足', cls: 'warn', title: '选项少于 2 个' });
    if (!(q.analysis || '').trim()) all.push({ text: '缺解析', cls: 'dim', title: '还没有解析' });
    if (q.aiSource === 'ai') all.push({ text: '🤖', cls: 'ai', title: 'AI 整理过' });
    if (q.answerSource === 'ai') all.push({ text: '✍️ 答案', cls: 'ai', title: '答案是 AI 补的(未核验)' });
    else if (q.analysisSource === 'ai') all.push({ text: '✍️ 解析', cls: 'ai', title: '解析是 AI 补的(未核验)' });
    if (Array.isArray(q.histMarks) && q.histMarks.length) {
        all.push({ text: '🕘', cls: 'dim', title: `有 ${q.histMarks.length} 条历史标记` });
    }
    all.slice(0, 4).forEach(b => {
        const el = document.createElement('span');
        el.className = 'q-badge' + (b.cls ? ' ' + b.cls : '');
        el.textContent = b.text;
        if (b.title) el.title = b.title;
        wrap.appendChild(el);
    });
    if (all.length > 4) wrap.title = all.map(b => b.text).join(' · ');
    return wrap;
}


// 粘贴事件：优先按富文本 HTML 读取（保留段落/表格结构），纯文本走默认行为
export function handlePasteEvent(event) {
    const html = event.clipboardData && event.clipboardData.getData('text/html');
    if (!html) return;
    event.preventDefault();
    pasteInput.value = htmlToLines(html).join('\n');
    showImportStatus('已按富文本结构读取剪贴板内容', 'success');
}
