import { buildAiNotes } from './ai.js';
import { state } from './state.js';
import { applyTheme, initTheme, setThemeSetting } from './theme.js';
import { buildCardCells, finalizeQuestion, formatQuestionsForExport, normalizeAnswerString, parseQuestionsText, questionDedupKey, shuffleArray, splitInlineOptions, splitBankSections, bankSectionHeader } from './parser.js';
import { deleteBankVersion, loadAutoNextSetting, loadBankVersions, loadCollapsedBanks, loadFromLocalStorage, loadMasterySetting, pushBankVersion, saveAutoNextSetting, saveCollapsedBanks, saveMasterySetting, saveToLocalStorage, recordImportBatch } from './storage.js';
import { downloadFile, hideModal, showModal } from './dom.js';
import { addToErrorBook, clearErrors, deleteError, updateErrorStreak } from './errorbook.js';
import { toggleFavorite } from './favorites.js';
import { advanceNext, backToQuizOptions, closeAnswerCard, collectUserAnswer, displayQuestion, endQuiz, finishExam, getSourcePool, isAnswerCardOpen, jumpToQuestion, openAnswerCard, readQuizSource, renderAnswerCard, resetGradingState, shouldAutoNext, shouldConfirmAnswer, syncNextButtonLabel, markEndButtonReady, nextQuestion, prevQuestion, renderAnswerReview, showQuizResult, showQuizStatus, showSection, startQuiz, submitAnswer, toggleAnswerCard, toggleFavoriteCurrent, updateFavoriteButton } from './quiz.js';
import { commitPreviewImport, createNewBank, currentEditBank, dedupBank, deleteBank, editBank, editorAddQuestion, editorClose, editorCollectOptions, editorGuard, editorTogglePendingOnly, editorToggleFilter, editorClearFilter, setPreviewBankMode, editorSelectAllVisible, editorClearSelection,
    editorBulkDelete, openQuestionCard, closeQuestionCard, saveQuestionCard, editorCardNavigate,
    questionMatchesFilter, visibleQuestions, activeFilterCount, isSelected, editorToggleSelect,
    setPreviewView, editorMutateOptions, openAiSettings, aiProviderChanged, testAiConnection, saveAiSettings, previewAiFallback,
    previewAiAnswerFill,
    bankColorOf,
        switchEditorTab,
    setBankColor,
    renderBankColorPicker,
    editorAiAnswer, cancelPreviewAi, rescueAiOrganize, updateAiSettingsBadge, editorNavigate, editorRenderForm, editorRenderOptions, editorSaveCurrent, exportAllBanks, exportBank, handleFileSelect, handlePasteEvent, htmlToLines, clearPasteInput, editorHistClick, keepCleanOnly, openImportPreview, parsePastedText, refreshQuestionBankView, togglePromptContent, copyOfficialPrompt, renameBank, renderBankEditor, renderPreview, restoreOverwriteSnapshot, showImportStatus, showRenameModal, togglePreviewSelectAll, undoLastImport, updateBankSelect, updateBanksList, updateLastImportInfo, updatePreviewSummary, updatePreviewTargetBanks, renderErrorsForBank, renderFavoritesForBank, renderRecycleBin, restoreRecycled, recycleBankEntry, restoreBankVersion } from './bank.js';

// Zquiz · 期末周刷题 —— 应用装配入口
// 依赖方向:main → 业务模块(quiz/errorbook/favorites/bank/dom)→ parser/storage/state。
// 禁止反向 import:业务模块不得引用 main。


// Zquiz · 期末周刷题 —— 应用装配入口
// 依赖方向:main → 业务模块(quiz/errorbook/favorites/bank/dom)→ parser/storage/state。
// 禁止反向 import:业务模块不得引用 main。


// Zquiz · 期末周刷题 —— 应用装配入口
// 依赖方向:main → 业务模块(quiz/errorbook/favorites/bank/dom)→ parser/storage/state。
// 禁止反向 import:业务模块不得引用 main。


// Zquiz · 期末周刷题 —— 应用装配入口
// 依赖方向:main → 业务模块(quiz/errorbook/favorites/bank/dom)→ parser/storage/state。
// 禁止反向 import:业务模块不得引用 main。


// Zquiz · 期末周刷题 —— 应用装配入口
// 依赖方向:main → 业务模块(quiz/errorbook/favorites/bank/dom)→ parser/storage/state。
// 禁止反向 import:业务模块不得引用 main。





// DOM 元素
const btnHome = document.getElementById('btn-home');
const btnQuiz = document.getElementById('btn-quiz');
const homeSection = document.getElementById('home-section');
const quizSection = document.getElementById('quiz-section');
const fileInput = document.getElementById('file-input');
const uploadBtn = document.getElementById('upload-btn');
const importStatus = document.getElementById('import-status');
const startQuizBtn = document.getElementById('start-quiz-btn');
const quizStatus = document.getElementById('quiz-status');
const quizContainer = document.getElementById('quiz-container');
const questionNumber = document.getElementById('question-number');
const questionType = document.getElementById('question-type');
const questionText = document.getElementById('question-text');
const questionExplanation = document.getElementById('question-explanation');
const nextQuestionBtn = document.getElementById('next-question-btn');
const endQuizBtn = document.getElementById('end-quiz-btn');
const answerFeedback = document.getElementById('answer-feedback');
const answerResult = document.getElementById('answer-result');
const answerExplanation = document.getElementById('answer-explanation');
const quizResult = document.getElementById('quiz-result');
const totalQuestions = document.getElementById('total-questions');
const correctAnswers = document.getElementById('correct-answers');
const wrongAnswers = document.getElementById('wrong-answers');
const accuracy = document.getElementById('accuracy');
const backToOptionsBtn = document.getElementById('back-to-options-btn');
const clearErrorsBtn = document.getElementById('clear-errors-btn');
const questionBankSelect = document.getElementById('question-bank-select');
const quizSettings = document.getElementById('quiz-settings');
const btnBanks = document.getElementById('btn-banks');
const createBankBtn = document.getElementById('create-bank-btn');
const exportAllBtn = document.getElementById('export-all-btn');
const banksList = document.getElementById('banks-list');
const createBankModal = document.getElementById('create-bank-modal');
const renameBankModal = document.getElementById('rename-bank-modal');
const newBankNameInput = document.getElementById('new-bank-name');
const renameBankNameInput = document.getElementById('rename-bank-name');
const confirmCreateBankBtn = document.getElementById('confirm-create-bank-btn');
const cancelCreateBankBtn = document.getElementById('cancel-create-bank-btn');
const confirmRenameBankBtn = document.getElementById('confirm-rename-bank-btn');
const cancelRenameBankBtn = document.getElementById('cancel-rename-bank-btn');

// 粘贴导入与预览向导
const pasteInput = document.getElementById('paste-input');
const pasteParseBtn = document.getElementById('paste-parse-btn');
const pasteClearBtn = document.getElementById('paste-clear-btn');
const importPreviewModal = document.getElementById('import-preview-modal');
const previewSummary = document.getElementById('preview-summary');
const previewSelectAll = document.getElementById('preview-select-all');
const previewCleanBtn = document.getElementById('preview-clean-btn');
const copyPromptBtn = document.getElementById('copy-prompt-btn');
const promptToggleBtn = document.getElementById('prompt-toggle-btn');
const viewAllBtn = document.getElementById('view-all-btn');
const viewWarnedBtn = document.getElementById('view-warned-btn');
const undoImportBtn = document.getElementById('undo-import-btn');
const previewSkipDupes = document.getElementById('preview-skip-dupes');
const previewList = document.getElementById('preview-list');
const previewTargetBankSelect = document.getElementById('preview-target-bank');
const previewBankModeInputs = Array.prototype.slice.call(document.querySelectorAll('input[name="preview-bank-mode"]'));
const recycleBinDetails = document.getElementById('recycle-bin');
const recycleMenu = document.querySelector('.recycle-menu');
const previewOverwrite = document.getElementById('preview-overwrite');
const previewConfirmBtn = document.getElementById('preview-confirm-btn');
const previewCancelBtn = document.getElementById('preview-cancel-btn');
// AI 设置与预览兜底
const aiSettingsBtn = document.getElementById('ai-settings-btn');
const rescueAiBtn = document.getElementById('rescue-ai-btn');
const aiSettingsModal = document.getElementById('ai-settings-modal');
const aiProviderSelect = document.getElementById('ai-provider-select');
const aiTestBtn = document.getElementById('ai-test-btn');
const aiSaveBtn = document.getElementById('ai-save-btn');
const aiCancelBtn = document.getElementById('ai-cancel-btn');
const previewAiBtn = document.getElementById('preview-ai-btn');
const previewAiCancelBtn = document.getElementById('preview-ai-cancel-btn');

// 套题模式与答题回顾
const prevQuestionBtn = document.getElementById('prev-question-btn');
const unansweredCountEl = document.getElementById('unanswered-count');
const answerReview = document.getElementById('answer-review');
const reviewOnlyWrong = document.getElementById('review-only-wrong');
const masteryNote = document.getElementById('mastery-note');
const favoriteBtn = document.getElementById('favorite-btn');
const autoNextToggle = document.getElementById('auto-next-toggle');
const masteryThresholdSelect = document.getElementById('mastery-threshold-select');
// 题库编辑器
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
const previewAiAnswerBtn = document.getElementById('preview-ai-answer-btn');
const editorAiAnswerBtn = document.getElementById('editor-ai-answer-btn');
// 编辑器重构(👤 2026-09-11):头部快捷动作 + 题号列表开合
const editorHeadCloseBtn = document.getElementById('editor-head-close-btn');
const editorTabQuestion = document.getElementById('editor-tab-question');
const editorTabBank = document.getElementById('editor-tab-bank');
const editorRemoveOption = document.getElementById('editor-remove-option');
const editorExplanation = document.getElementById('editor-explanation');
const editorAnalysis = document.getElementById('editor-analysis');
// 题目列表重构(👤 2026-09-12):筛选 / 批量操作栏 / 编辑卡片
const editorFilterToggle = document.getElementById('editor-filter-toggle');
const editorFilterPanel = document.getElementById('editor-filter-panel');
const editorFilterClear = document.getElementById('editor-filter-clear');
const editorBulkAll = document.getElementById('editor-bulk-all');
const editorBulkClear = document.getElementById('editor-bulk-clear');
const editorBulkDeleteBtn = document.getElementById('editor-bulk-delete');
const editorSaveBtn = document.getElementById('editor-save-btn');
const questionCardClose = document.getElementById('question-card-close');
const questionCardCancel = document.getElementById('question-card-cancel');
const questionCardPrev = document.getElementById('question-card-prev');
const questionCardNext = document.getElementById('question-card-next');
const editorHistRow = document.getElementById('editor-hist-row');
const bankRenameBtn = document.getElementById('bank-rename-btn');
const bankDedupBtn = document.getElementById('editor-dedup-btn');   // 去重已移到题目列表上方(👤 要求)
const bankExportBtn = document.getElementById('bank-export-btn');
const bankDeleteBtn = document.getElementById('bank-delete-btn');

// 首页:主题开关(hero 的开始刷题/导入题库按钮已移除,导航职责归底部 3 tab)
const themeSwitch = document.getElementById('theme-switch');

const SECTIONS = ['home', 'quiz', 'banks'];

// 统一切换分区:hash 已一致时直接切(否则赋相同 hash 不会触发 hashchange,按钮会失效)
function navigate(section) {
    if (!SECTIONS.includes(section)) return;
    if (typeof location !== 'undefined') {
        if (location.hash === '#' + section) {
            showSection(section);
        } else {
            location.hash = '#' + section;  // 触发 hashchange → showSection
        }
    } else {
        showSection(section);
    }
}

// 自动下一题按钮的开启态外观(带框按钮 + 主色高亮 + aria-pressed)
function syncAutoNextBtn() {
    if (!autoNextToggle) return;
    autoNextToggle.classList.toggle('is-on', !!state.autoNext);
    autoNextToggle.setAttribute('aria-pressed', state.autoNext ? 'true' : 'false');
}

// 题源 UI:「选择题库」常驻(👤 验收反馈:不让它消失,避免布局跳动)。
// 它对三种题源都生效——错题/收藏自带 bankName,可按库再收窄;
// 标签随题源改写,使"这里在选什么"始终明确。
function updateSourceUI() {
    const source = readQuizSource();   // 与 startQuiz 共用同一判定,杜绝两处口径不一致
    const hint = document.getElementById('source-hint');
    const bankLabel = document.getElementById('bank-select-label');
    if (bankLabel) {
        bankLabel.textContent = source === 'errors' ? '错题所在题库：'
            : source === 'favorites' ? '收藏题所在题库：'
            : '选择题库：';
    }
    updateBankSelect();
    if (!hint) return;
    if (source === 'bank') {
        hint.classList.add('hidden');
        hint.textContent = '';
        return;
    }
    const n = getSourcePool(source).length;
    const label = source === 'errors' ? '错题本' : '收藏夹';
    hint.textContent = n > 0
        ? `${label}共 ${n} 题（可用上方「${source === 'errors' ? '错题所在题库' : '收藏题所在题库'}」再收窄）`
        : `${label}还没有题目`;
    hint.classList.remove('hidden');
}

// 初始化
function init() {
    markStandalone();
    // 主题(暗色模式)先行,避免闪白
    initTheme();

    // hash 路由 + 跨模块导航事件(替代跨模块 import showSection,避免循环依赖)
    if (typeof window !== 'undefined' && window.addEventListener) {
        window.addEventListener('hashchange', () => {
            const hash = location.hash.slice(1);
            if (SECTIONS.includes(hash)) showSection(hash);
        });
    }
    if (typeof document !== 'undefined' && document.addEventListener) {
        document.addEventListener('zquiz:navigate', (e) => {
            const target = e && e.detail && e.detail.section;
            if (SECTIONS.includes(target)) navigate(target);
        });
    }

    // 加载本地存储的数据
    loadFromLocalStorage();
    loadCollapsedBanks();
    masteryThresholdSelect.value = String(loadMasterySetting());
    loadAutoNextSetting();
    syncAutoNextBtn();

    // 更新题库选择下拉框与最近导入信息;AI 连接徽章
    updateBankSelect();
    updateLastImportInfo();
    updateAiSettingsBadge();

    // 初始状态下拉框与实际加载的题库保持一致
    // （页面默认显示"全部题库"，但初始数据只加载了第一个题库，二者必须一致）
    if (Object.keys(state.questionBanks).length > 0) {
        state.isAllBanksView = false;
        questionBankSelect.value = state.currentBankName;
    }
    
    // 设置事件监听器
    setupEventListeners();
    
    // 显示首页;URL hash 深链(#banks/#quiz 等)直达对应分区
    const hash = typeof location !== 'undefined' && location.hash ? location.hash.slice(1) : '';
    showSection(['home', 'quiz', 'banks'].includes(hash) ? hash : 'home');
}

// 设置事件监听器
function setupEventListeners() {
    // 导航按钮
    btnHome.addEventListener('click', () => navigate('home'));
    btnQuiz.addEventListener('click', () => navigate('quiz'));
    btnBanks.addEventListener('click', () => navigate('banks'));
    
    // 文件上传
    uploadBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', handleFileSelect);

    // 题库选择变化
    questionBankSelect.addEventListener('change', function() {
        const selectedBank = this.value;
        if (selectedBank === 'all') {
            // 合并所有题库为临时视图（此视图下保存时不会回写题库数据）
            state.isAllBanksView = true;
            state.questionBank = [];
            Object.values(state.questionBanks).forEach(bank => {
                state.questionBank = [...state.questionBank, ...bank];
            });
        } else {
            // 选择特定题库
            state.isAllBanksView = false;
            state.currentBankName = selectedBank;
            state.questionBank = state.questionBanks[selectedBank];
        }
    });
    
    // 刷题
    startQuizBtn.addEventListener('click', startQuiz);
    // 「下一题」= 确认并前进(逐题模式下未作答的题按确认答案处理,👤 决定)
    nextQuestionBtn.addEventListener('click', advanceNext);
    endQuizBtn.addEventListener('click', endQuiz);
    backToOptionsBtn.addEventListener('click', backToQuizOptions);

    // 题源切换:选「错题本/收藏夹」时"选择题库"无意义 → 隐藏,并给出题数提示
    quizSettings.addEventListener('change', (e) => {
        if (e.target && e.target.name === 'question-source') updateSourceUI();
    });
    updateSourceUI();

    
    // 错题本

    // 收藏
    favoriteBtn.addEventListener('click', toggleFavoriteCurrent);

    // 自动下一题按钮(切换式,存本机);外观状态由 syncAutoNextBtn 统一维护
    if (autoNextToggle) {
        autoNextToggle.addEventListener('click', function() {
            saveAutoNextSetting(!state.autoNext);
            syncAutoNextBtn();
        });
    }

    // 错题移出规则设置
    masteryThresholdSelect.addEventListener('change', function() {
        saveMasterySetting(this.value);
    });

    // 清空错题本(在题库编辑面板里,是错题本的管理入口)
    if (clearErrorsBtn) clearErrorsBtn.addEventListener('click', clearErrors);

    // 题库编辑器
    editorAiAnswerBtn.addEventListener('click', editorAiAnswer);
    // 头部:题号列表开合 / 新增 / 关闭(与底部「关闭」同一处理路径,不另写一套)
    editorHeadCloseBtn.addEventListener('click', editorClose);
    // 标签页切换(radio 的 change 事件;用 change 而不是 click,键盘也能切)
    editorTabQuestion.addEventListener('change', () => switchEditorTab('question'));
    editorTabBank.addEventListener('change', () => switchEditorTab('bank'));
    // 「保存本题」已从动作行搬进列表里选中的那一行(bank.js 逐行渲染并绑事件),
    // 这里不再有全局保存键可绑。editorSaveCurrent 仍由预览/快捷键等路径调用。
    // 关闭键在标题栏(原底栏那颗已随底栏取消)
    editorHeadCloseBtn.addEventListener('click', editorClose);
    // 库级操作:作用于当前编辑中的题库(编辑器即该库的管理入口)
    bankRenameBtn.addEventListener('click', () => showRenameModal(state.editBankName));
    bankDedupBtn.addEventListener('click', () => {
        if (state.editBankName && confirm(`对"${state.editBankName}"一键去重?`)) {
            dedupBank(state.editBankName);
            renderBankEditor();
        }
    });
    bankExportBtn.addEventListener('click', () => exportBank(state.editBankName));
    bankDeleteBtn.addEventListener('click', () => {
        if (state.editBankName && confirm(`删除题库"${state.editBankName}"?(错题与收藏将移入回收站)`) && deleteBank(state.editBankName) !== false) {
            editorClose();
        }
    });
    editorHistRow.addEventListener('click', editorHistClick);
    // 回收站是个 <details> 悬浮菜单:点它外面应收起(👤 要求)。
    // 点击落在 .recycle-menu 里(摘要或面板)时不处理 —— 摘要的原生开合自己会管这件事。
    document.addEventListener('click', (e) => {
        if (!recycleBinDetails || !recycleBinDetails.open) return;
        const t = e && e.target;
        let p = t;
        while (p) { if (p === recycleMenu) return; p = p.parentNode; }   // 桩里没有 contains,用 parentNode 走
        if (t === recycleMenu) return;
        recycleBinDetails.open = false;
    });

    // 题目列表重构(👤 2026-09-12):筛选面板 / 批量操作栏 / 编辑卡片
    // 筛选按钮只负责开合面板;chip 的选中态由 renderBankEditor 统一回写(单一数据源 = state.editorFilter)
    editorFilterToggle.addEventListener('click', () => {
        const open = editorFilterPanel.classList.toggle('hidden') === false;
        editorFilterToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    // 筛选面板是**悬浮**的:点面板外面就收起(否则它会一直盖着列表)。
    // ⚠️ 用 within() 而不是 el.contains():测试桩的元素没有 contains 方法,直接调会 TypeError。
    const within = (el, node) => {
        if (!el || !node) return false;
        if (typeof el.contains === 'function') return el.contains(node);
        let p = node;
        while (p) { if (p === el) return true; p = p.parentNode; }
        return false;
    };
    document.addEventListener('click', (e) => {
        if (editorFilterPanel.classList.contains('hidden')) return;
        if (within(editorFilterToggle, e.target) || within(editorFilterPanel, e.target)) return;
        editorFilterPanel.classList.add('hidden');
        editorFilterToggle.setAttribute('aria-expanded', 'false');
    });
    document.querySelectorAll('.filter-chip').forEach(chip => {
        chip.addEventListener('click', () => editorToggleFilter(chip.dataset.filter, chip.dataset.value));
    });
    editorFilterClear.addEventListener('click', () => editorClearFilter());
    // 多题库导入:切「按题库分别导入 / 全部并入一个题库」
    previewBankModeInputs.forEach(inp => {
        inp.addEventListener('change', () => { if (inp.checked) setPreviewBankMode(inp.value); });
    });
    editorBulkAll.addEventListener('click', () => editorSelectAllVisible());
    editorBulkClear.addEventListener('click', () => editorClearSelection());
    editorBulkDeleteBtn.addEventListener('click', () => editorBulkDelete());
    // 编辑卡片:保存/取消/关闭/上一题/下一题
    editorSaveBtn.addEventListener('click', () => saveQuestionCard());
    questionCardCancel.addEventListener('click', () => closeQuestionCard());
    questionCardClose.addEventListener('click', () => closeQuestionCard());
    questionCardPrev.addEventListener('click', () => editorCardNavigate(-1));
    questionCardNext.addEventListener('click', () => editorCardNavigate(1));
    editorAddOption.addEventListener('click', () => editorMutateOptions(1));
    editorRemoveOption.addEventListener('click', () => editorMutateOptions(-1));
    editorType.addEventListener('change', () => { state.editorDirty = true; editorRenderOptions(); });
    editorStem.addEventListener('input', () => { state.editorDirty = true; });
    editorAnswer.addEventListener('input', () => { state.editorDirty = true; });
    editorExplanation.addEventListener('input', () => { state.editorDirty = true; });
    editorAnalysis.addEventListener('input', () => { state.editorDirty = true; });

    // 题库管理
    createBankBtn.addEventListener('click', () => showModal(createBankModal));
    cancelCreateBankBtn.addEventListener('click', () => hideModal(createBankModal));
    confirmCreateBankBtn.addEventListener('click', createNewBank);
    cancelRenameBankBtn.addEventListener('click', () => hideModal(renameBankModal));
    confirmRenameBankBtn.addEventListener('click', renameBank);
    exportAllBtn.addEventListener('click', exportAllBanks);

    // 粘贴导入
    pasteInput.addEventListener('paste', handlePasteEvent);
    pasteParseBtn.addEventListener('click', parsePastedText);
    copyPromptBtn.addEventListener('click', copyOfficialPrompt);
    promptToggleBtn.addEventListener('click', togglePromptContent);
    viewAllBtn.addEventListener('click', () => setPreviewView(false));
    viewWarnedBtn.addEventListener('click', () => setPreviewView(true));
    pasteClearBtn.addEventListener('click', clearPasteInput);

    // 导入预览向导
    previewSelectAll.addEventListener('change', togglePreviewSelectAll);
    previewCleanBtn.addEventListener('click', keepCleanOnly);

    // 导入撤销与覆盖快照恢复
    undoImportBtn.addEventListener('click', undoLastImport);
    previewConfirmBtn.addEventListener('click', commitPreviewImport);

    // AI 设置与预览兜底(0.9.0)
    aiSettingsBtn.addEventListener('click', openAiSettings);
    rescueAiBtn.addEventListener('click', rescueAiOrganize);
    aiProviderSelect.addEventListener('change', aiProviderChanged);
    aiTestBtn.addEventListener('click', testAiConnection);
    aiSaveBtn.addEventListener('click', saveAiSettings);
    aiCancelBtn.addEventListener('click', () => hideModal(aiSettingsModal));
    previewAiBtn.addEventListener('click', previewAiFallback);
    previewAiAnswerBtn.addEventListener('click', previewAiAnswerFill);
    previewAiCancelBtn.addEventListener('click', cancelPreviewAi);
    previewCancelBtn.addEventListener('click', () => hideModal(importPreviewModal));

    // 套题模式翻页与答题回顾
    prevQuestionBtn.addEventListener('click', prevQuestion);
    reviewOnlyWrong.addEventListener('change', renderAnswerReview);

    // 主题三档开关(事件委托)
    themeSwitch.addEventListener('click', (e) => {
        const opt = e.target && e.target.closest ? e.target.closest('.theme-opt') : null;
        if (opt) setThemeSetting(opt.dataset.themeOpt);
    });

    // 主题三档开关的绑定在 initTheme/theme.js 内完成
}





// ==================== 题目解析（批次1：多格式自动识别） ====================
//
// 支持的格式家族（自动识别，无需用户选择）：
//   A. 字段式：  题目：xxx / A：xxx / 答案：x（原有格式，完整保留）
//   B. 编号式：  1. 题干 / A. 选项（逐行）/ 答案：x（最常见的题库排版）
//   C. 混排式：  1. 题干 A.xx B.xx C.xx D.xx 答案：x（单行，常见于网页/微信复制）
//   D. 判断题：  答案为 对/错/√/×/正确/错误，自动配 A正确/B错误 两个选项
// 每题输出置信度，供导入预览向导提示需要人工确认的题。















// ==================== 收藏夹 ====================





// 更新错题列表






// 复习错题
// ==================== 题库编辑器 ====================




















// ==================== 粘贴导入 + 导入预览向导（批次1） ====================




// ---------- 导入预览向导 ----------







// 题库管理功能












// 页面加载完成后初始化
// 已在"装到主屏 / 独立窗口"里运行时,页面上那条"加到主屏"的引导就该消失(P0-1.4)。
// CSS 侧有 @media (display-mode: standalone);这里再判一次 navigator.standalone ——
// 老 iOS 不认那个媒体查询,只认这个私有属性,双保险。
function markStandalone() {
    const standalone = (typeof window !== 'undefined')
        && ((window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
            || window.navigator && window.navigator.standalone === true);
    if (standalone && document.documentElement && document.documentElement.classList) {
        document.documentElement.classList.add('is-standalone');
    }
}

document.addEventListener('DOMContentLoaded', init);

// ==================== 测试钩子(仅 Node vm 测试环境挂载) ====================
// 浏览器中 window 存在,本代码不执行,不污染任何全局。
if (typeof window === 'undefined') {
    globalThis.__zquiz = {
        state,
        addToErrorBook,
        backToQuizOptions,
        applyTheme,
        setThemeSetting,
        navigate,
        buildCardCells,
        openAnswerCard,
        closeAnswerCard,
        toggleAnswerCard,
        jumpToQuestion,
        isAnswerCardOpen,
        resetGradingState,
        clearPasteInput,
        collectUserAnswer,
        commitPreviewImport,
        keepCleanOnly,
        createNewBank,
        currentEditBank,
        dedupBank,
        deleteBank,
        restoreBankVersion,
        clearErrors,
        deleteError,
        displayQuestion,
        undoLastImport,
        updateLastImportInfo,
        downloadFile,
        editBank,
        editorAddQuestion,
        editorClose,
        editorCollectOptions,
        editorGuard,
        editorMutateOptions,
        editorNavigate,
        editorRenderForm,
        editorRenderOptions,
        editorSaveCurrent,
        editorTogglePendingOnly,
        editorHistClick,
        endQuiz,
        exportAllBanks,
        exportBank,
        finalizeQuestion,
        finishExam,
        getSourcePool,
        shouldAutoNext,
        shouldConfirmAnswer,
        markEndButtonReady,
        syncNextButtonLabel,
        advanceNext,
        updateSourceUI,
        readQuizSource,
        formatQuestionsForExport,
        handleFileSelect,
        handlePasteEvent,
        hideModal,
        htmlToLines,
        init,
        loadCollapsedBanks,
        loadFromLocalStorage,
        loadMasterySetting,
        loadAutoNextSetting,
        syncAutoNextBtn,
        saveAutoNextSetting,
        nextQuestion,
        normalizeAnswerString,
        openImportPreview,
        parsePastedText,
        parseQuestionsText,
        prevQuestion,
        questionDedupKey,
        refreshQuestionBankView,
        recordImportBatch,
        renameBank,
        renderAnswerReview,
        renderBankEditor,
        renderPreview,
        saveCollapsedBanks,
        saveMasterySetting,
        saveToLocalStorage,
        setupEventListeners,
        showImportStatus,
        showModal,
        showQuizResult,
        showQuizStatus,
        showRenameModal,
        showSection,
        shuffleArray,
        splitInlineOptions,
        startQuiz,
        submitAnswer,
        toggleFavorite,
        toggleFavoriteCurrent,
        togglePreviewSelectAll,
        openAiSettings,
        buildAiNotes,
        aiProviderChanged,
        testAiConnection,
        saveAiSettings,
        previewAiFallback,
        setPreviewView,
        rescueAiOrganize,
        updateAiSettingsBadge,
        cancelPreviewAi,
        updateBankSelect,
        updateBanksList,
        updateErrorStreak,
        renderErrorsForBank,
        renderFavoritesForBank,
        bankColorOf,
                switchEditorTab,
        editorToggleFilter,
        editorClearFilter,
        editorSelectAllVisible,
        editorClearSelection,
        editorBulkDelete,
        openQuestionCard,
        closeQuestionCard,
        saveQuestionCard,
        editorCardNavigate,
        questionMatchesFilter,
        splitBankSections,
        bankSectionHeader,
        setPreviewBankMode,
        visibleQuestions,
        activeFilterCount,
        isSelected,
        editorToggleSelect,
        setBankColor,
        renderBankColorPicker,
        pushBankVersion,
        loadBankVersions,
        deleteBankVersion,
        dedupBank,
        previewAiAnswerFill,
        editorAiAnswer,
        restoreRecycled,
        recycleBankEntry,
        restoreBankVersion,
        updateFavoriteButton,
        updatePreviewSummary,
        updatePreviewTargetBanks,
    };
}
