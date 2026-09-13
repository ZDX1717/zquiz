// ==================== 存储层(唯一允许触碰 localStorage 的模块) ====================
// 职责:读写 localStorage + 损坏降级 + schema 迁移点。允许依赖:state。禁止:DOM。

import { state } from './state.js';

// 从本地存储加载数据
export function loadFromLocalStorage() {
    // 容错：存储数据损坏时重置对应部分，而不是让整个应用崩溃
    try {
        // 题库卡配色(与题库同期加载;损坏则退回空表 = 全灰)
        try {
            const rawColors = JSON.parse(localStorage.getItem('bankColors') || '{}');
            state.bankColors = (rawColors && typeof rawColors === 'object' && !Array.isArray(rawColors)) ? rawColors : {};
        } catch (e) { state.bankColors = {}; }

        const savedBanks = localStorage.getItem('questionBanks');
        if (savedBanks) {
            const parsed = JSON.parse(savedBanks);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                state.questionBanks = parsed;
                // 加载第一个题库作为当前题库
                const bankNames = Object.keys(state.questionBanks);
                if (bankNames.length > 0) {
                    state.currentBankName = bankNames[0];
                    state.questionBank = state.questionBanks[state.currentBankName];
                }
            }
        } else {
            // 向后兼容：如果有旧的questionBank数据，迁移到新的结构
            const savedQuestions = localStorage.getItem('questionBank');
            if (savedQuestions) {
                const parsedQuestions = JSON.parse(savedQuestions);
                if (Array.isArray(parsedQuestions)) {
                    state.questionBank = parsedQuestions;
                    state.questionBanks[state.currentBankName] = state.questionBank;
                }
            }
        }
    } catch (e) {
        console.error('题库数据损坏，已重置：', e);
        localStorage.removeItem('questionBanks');
        localStorage.removeItem('questionBank');
        state.questionBanks = {};
        state.questionBank = [];
    }

    try {
        const savedErrors = localStorage.getItem('errorQuestions');
        if (savedErrors) {
            const parsedErrors = JSON.parse(savedErrors);
            if (Array.isArray(parsedErrors)) {
                state.errorQuestions = parsedErrors;
            }
        }
    } catch (e) {
        console.error('错题本数据损坏，已重置：', e);
        localStorage.removeItem('errorQuestions');
        state.errorQuestions = [];
    }

    try {
        const savedFavorites = localStorage.getItem('favoriteQuestions');
        if (savedFavorites) {
            const parsedFavorites = JSON.parse(savedFavorites);
            if (Array.isArray(parsedFavorites)) {
                state.favoriteQuestions = parsedFavorites;
            }
        }
    } catch (e) {
        console.error('收藏数据损坏，已重置：', e);
        localStorage.removeItem('favoriteQuestions');
        state.favoriteQuestions = [];
    }
}

// 保存数据到本地存储
export function saveToLocalStorage() {
    // 仅在选定具体题库时回写当前题库，
    // 避免"全部题库"合并视图把合并结果覆盖写进某个真实题库（数据污染）
    if (!state.isAllBanksView) {
        state.questionBanks[state.currentBankName] = state.questionBank;
    }
    localStorage.setItem('questionBanks', JSON.stringify(state.questionBanks));
    if (state.bankColors && Object.keys(state.bankColors).length) {
        localStorage.setItem('bankColors', JSON.stringify(state.bankColors));
    } else {
        localStorage.removeItem('bankColors');   // 全灰就不留空表
    }
    localStorage.setItem('errorQuestions', JSON.stringify(state.errorQuestions));
    localStorage.setItem('favoriteQuestions', JSON.stringify(state.favoriteQuestions));
}

export function loadCollapsedBanks() {
    try {
        const saved = localStorage.getItem('errorBookExpandedBanks');
        if (saved) {
            const parsed = JSON.parse(saved);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                state.expandedBanks = parsed;
            }
        }
    } catch (e) {
        state.expandedBanks = {};
    }
}

export function saveCollapsedBanks() {
    try {
        localStorage.setItem('errorBookExpandedBanks', JSON.stringify(state.expandedBanks));
    } catch (e) { /* 存储异常时静默降级：展开状态不持久化 */ }
}

// 加载错题移出规则设置
export function loadMasterySetting() {
    const saved = parseInt(localStorage.getItem('masteryThresholdSetting'), 10);
    state.masteryThreshold = [0, 1, 2, 3].includes(saved) ? saved : 2;
    return state.masteryThreshold;
}

// 保存错题移出规则设置(白名单校验必须与 loadMasterySetting 对称:
// 非法值一律落回默认 2,防止把"任意整数"写进本机后再被读成 0=关闭自动移出)
export function saveMasterySetting(value) {
    const n = parseInt(value, 10);
    state.masteryThreshold = [0, 1, 2, 3].includes(n) ? n : 2;
    try {
        localStorage.setItem('masteryThresholdSetting', String(state.masteryThreshold));
    } catch (e) { /* 存储异常时静默降级:本次会话内仍生效,仅不持久化 */ }
    return state.masteryThreshold;
}

// 自动下一题开关:默认关闭。非法值一律落回 false(与 loadMasterySetting 同样的白名单思路)
export function loadAutoNextSetting() {
    state.autoNext = localStorage.getItem('autoNextSetting') === '1';
    return state.autoNext;
}

export function saveAutoNextSetting(on) {
    state.autoNext = !!on;
    try {
        localStorage.setItem('autoNextSetting', state.autoNext ? '1' : '0');
    } catch (e) { /* 存储异常时静默降级:本次会话内仍生效,仅不持久化 */ }
    return state.autoNext;
}

// ==================== 导入批次记录(撤销)与覆盖前快照 ====================

// 批次记录:最近 5 次;损坏时静默降级为无记录(仅失去撤销能力,不影响题库数据)
export function loadImportBatches() {
    try {
        const arr = JSON.parse(localStorage.getItem('importBatches') || '[]');
        return Array.isArray(arr) ? arr : [];
    } catch (e) {
        return [];
    }
}

// ⚠️ 自 2026-09-13 起，批次记录**只作展示**（题库页的「上次导入:…」），不再有"批次级撤销"。
// 仍然保留容量上限，避免它无限长下去。
export function saveImportBatches(batches) {
    try {
        while (batches.length > 5) batches.shift();
        localStorage.setItem('importBatches', JSON.stringify(batches));
    } catch (e) { /* 静默降级 */ }
}

export function recordImportBatch(batch) {
    const batches = loadImportBatches();
    batches.push(batch);
    saveImportBatches(batches);
}

export function saveOverwriteSnapshot(bankName, questions) {
    try {
        localStorage.setItem('overwriteSnapshot', JSON.stringify({ bank: bankName, time: new Date().toISOString(), questions }));
    } catch (e) { /* 题库过大等异常时静默降级:快照不可用,覆盖流程不受影响 */ }
}

export function loadOverwriteSnapshot() {
    try {
        const s = JSON.parse(localStorage.getItem('overwriteSnapshot') || 'null');
        return (s && s.bank && Array.isArray(s.questions)) ? s : null;
    } catch (e) {
        return null;
    }
}

export function clearOverwriteSnapshot() {
    try { localStorage.removeItem('overwriteSnapshot'); } catch (e) { /* 静默 */ }
}

// ==================== AI 配置(BYO key)与触发埋点 ====================

// 读取 AI 配置;损坏/缺字段由 ai.js 的 normalizeAiConfig 兜底,这里只保证 JSON 安全
export function loadAiConfig() {
    try {
        return JSON.parse(localStorage.getItem('aiConfig') || 'null') || {};
    } catch (e) {
        return {};
    }
}

export function saveAiConfig(cfg) {
    try {
        localStorage.setItem('aiConfig', JSON.stringify(cfg || {}));
    } catch (e) { /* 静默降级:配置不持久化,本次会话仍可用 */ }
}

// 「AI 已连接 ✓」徽章:保存最近一次测试成功的配置指纹;配置变更未复测则失配(徽章熄灭)
export function markAiTested(cfg) {
    try {
        localStorage.setItem('aiConfigTested', JSON.stringify(cfg || {}));
    } catch (e) { /* 静默 */ }
}

export function isAiTested(cfg) {
    try {
        return !!cfg && localStorage.getItem('aiConfigTested') === JSON.stringify(cfg);
    } catch (e) {
        return false;
    }
}

// AI 兜底触发埋点:最近 50 条;用于统计"多少导入需要 AI 救"(规则算法投入决策依据)
export function loadAiUsage() {
    try {
        const arr = JSON.parse(localStorage.getItem('aiUsage') || '[]');
        return Array.isArray(arr) ? arr : [];
    } catch (e) {
        return [];
    }
}

export function recordAiUsage(entry) {
    try {
        const arr = loadAiUsage();
        arr.push({ time: new Date().toISOString(), ...(entry || {}) });
        while (arr.length > 50) arr.shift();
        localStorage.setItem('aiUsage', JSON.stringify(arr));
    } catch (e) { /* 埋点失败不影响主流程 */ }
}

// ==================== 主题设置(暗色模式) ====================

export function loadThemeSetting() {
    const v = localStorage.getItem('themeSetting');
    return ['auto', 'light', 'dark'].includes(v) ? v : 'auto';
}

export function saveThemeSetting(v) {
    try {
        localStorage.setItem('themeSetting', ['auto', 'light', 'dark'].includes(v) ? v : 'auto');
    } catch (e) { /* 静默 */ }
}

// ==================== 回收站(P0-1.10:删除题库整体打包,上限 10 条 LRU) ====================

export function loadRecycledBanks() {
    try {
        const obj = JSON.parse(localStorage.getItem('recycledBanks') || '{}');
        return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : {};
    } catch (e) {
        return {};
    }
}

export function saveRecycledBanks(obj) {
    try {
        localStorage.setItem('recycledBanks', JSON.stringify(obj || {}));
    } catch (e) { /* 超容量等异常:保留内存态,本次不入站 */ }
}

// 入站 + LRU 淘汰(按 deletedAt 保留最近 10 条)
export function recycleBank(name, pkg) {
    const bin = loadRecycledBanks();
    bin[name] = { ...pkg, deletedAt: new Date().toISOString() };
    const entries = Object.entries(bin).sort((a, b) => (b[1].deletedAt || '').localeCompare(a[1].deletedAt || ''));
    while (entries.length > 10) { const [old] = entries.pop(); delete bin[old]; }
    saveRecycledBanks(bin);
    return bin;
}

export function purgeRecycledBank(name) {
    const bin = loadRecycledBanks();
    delete bin[name];
    saveRecycledBanks(bin);
}

export function restoreRecycledBank(name) {
    const bin = loadRecycledBanks();
    const pkg = bin[name];
    if (!pkg) return null;
    delete bin[name];
    saveRecycledBanks(bin);
    return pkg;
}

// ==================== 库级版本快照(P0-1.11:破坏性操作自动存版,每库 3 版全站 10 版) ====================

export function loadBankVersions() {
    try {
        const obj = JSON.parse(localStorage.getItem('bankVersions') || '{}');
        return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : {};
    } catch (e) {
        return {};
    }
}

export function saveBankVersions(obj) {
    try {
        localStorage.setItem('bankVersions', JSON.stringify(obj || {}));
    } catch (e) { /* 超容量:版本不入盘 */ }
}

// 存版:每库保留 5 版;全站超 20 版时按时间 LRU 淘汰最旧(👤 2026-09-13 扩容)。
// ⚠️ 调用纪律(2026-09-11 理顺):
//   ① **只在真的会改动题目的操作之前存**(去重空点、库为空这类"本来就没得改"的情况不要存,
//      否则每库只有 3 个槽,几下就被无意义的安全网占满);
//   ② 恢复前**必须**存一份当前状态 —— 恢复本身也要可逆(否则"恢复"成了不可撤销的破坏性操作)。
// 题库改名:版本快照按**库名**存,不迁就是孤儿 —— 库里历史还在,面板却显示"暂无记录"。
// 目标名已有记录时**追加**而不是覆盖(两库合并到一个名字的可能性虽小,丢历史却是真丢)。
export function renameBankVersions(oldName, newName) {
    if (!oldName || !newName || oldName === newName) return false;
    const all = loadBankVersions();
    if (!all[oldName]) return false;
    const merged = (all[oldName] || []).concat(all[newName] || []);
    // 按时间排序后每库只留 3 条(与 pushBankVersion 的上限一致),再清掉旧键
    merged.sort((a, b) => String(a && a.time).localeCompare(String(b && b.time)));
    while (merged.length > 3) merged.shift();
    all[newName] = merged;
    delete all[oldName];
    saveBankVersions(all);
    return true;
}

export function deleteBankVersion(name, index) {
    const all = loadBankVersions();
    const list = all[name] || [];
    if (!list[index]) return false;
    list.splice(index, 1);
    // 删空了就把这个库的键一起清掉,别留空数组(与 setBankColor 的"缺省不留冗余"一致)
    if (list.length === 0) delete all[name];
    else all[name] = list;
    saveBankVersions(all);
    return true;
}


// 槽位(👤 2026-09-13 扩容):导入也进版本记录之后,3 个槽会被"导入前/去重前"几下占满,
// 于是把"去重前/覆盖前"这些真正的安全网挤掉。每库 3→5、全站 10→20。
export const VERSIONS_PER_BANK = 5;
export const VERSIONS_TOTAL = 20;

export function pushBankVersion(name, action, questions, meta) {
    const all = loadBankVersions();
    const time = new Date().toISOString();
    const entry = { time, action, questions: JSON.parse(JSON.stringify(questions || [])) };
    // meta:{ source } —— 版本列表里显示"这是哪次导入",否则一列"导入前 09-13 15:02"认不出谁是谁
    if (meta && meta.source) entry.source = String(meta.source).slice(0, 40);
    const list = all[name] || [];
    list.push(entry);
    while (list.length > VERSIONS_PER_BANK) list.shift();
    all[name] = list;
    // 全站 LRU(排除刚存的那条)
    const flat = [];
    Object.entries(all).forEach(([bank, versions]) => {
        versions.forEach(v => { if (!(v === entry && bank === name)) flat.push([bank, v]); });
    });
    flat.sort((a, b) => (b[1].time || '').localeCompare(a[1].time || ''));
    let overflow = flat.length + 1 - VERSIONS_TOTAL;
    if (overflow > 0) {
        for (const [bank, v] of flat) {
            if (overflow <= 0) break;
            const versions = all[bank];
            const idx = versions.indexOf(v);
            if (idx !== -1) { versions.splice(idx, 1); overflow--; }
            if (versions.length === 0) delete all[bank];
        }
    }
    saveBankVersions(all);
    return entry;
}
