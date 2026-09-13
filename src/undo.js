// 编辑级撤销栈(👤 2026-09-13 定:只放内存、会话内、深度 50)
//
// 职责边界(与"题库版本记录"分工,别混):
//   · 撤销栈 = "刚才那一步"(逐次编辑:改题/加题/删题/批量删/去重/导入/恢复)
//   · 版本记录 = "几个小时前那个状态"(落盘快照,只在破坏性操作前存)
// 为什么撤销栈不落盘:一步只存**受影响的题**(改一道题 ≈0.6KB),整库快照要 ≈120KB ——
// 便宜 200 倍的东西才配"每次编辑都记";刷新后要跨会话回退,走版本记录。
//
// 允许依赖:state。禁止:document / localStorage / 其它业务模块。
import { state } from './state.js';

const LIMIT = 50;

// 记一步。entry = { label, undo, redo };undo/redo 是闭包,自己负责改 state 并落盘。
export function pushUndo(entry) {
    if (!entry || typeof entry.undo !== 'function') return false;
    state.undoStack.push(entry);
    while (state.undoStack.length > LIMIT) state.undoStack.shift();
    state.redoStack.length = 0;      // 新的动作让"重做"失效(标准编辑器语义)
    return true;
}

export function canUndo() { return state.undoStack.length > 0; }
export function canRedo() { return state.redoStack.length > 0; }
export function undoLabel() {
    const top = state.undoStack[state.undoStack.length - 1];
    return top ? String(top.label || '上一步') : '';
}
export function redoLabel() {
    const top = state.redoStack[state.redoStack.length - 1];
    return top ? String(top.label || '上一步') : '';
}

// 撤销一步:把这条移到 redoStack,执行它的 undo。返回是否真的撤了。
export function undo() {
    const entry = state.undoStack.pop();
    if (!entry) return false;
    try {
        entry.undo();
    } catch (err) {
        // 撤销失败(比如目标库已经不在了):把这条丢掉,别让栈卡在一个坏的条子上
        console.error('撤销失败:', err);
        return false;
    }
    state.redoStack.push(entry);
    return true;
}

export function redo() {
    const entry = state.redoStack.pop();
    if (!entry) return false;
    try {
        if (typeof entry.redo === 'function') entry.redo();
        else return false;
    } catch (err) {
        console.error('重做失败:', err);
        return false;
    }
    state.undoStack.push(entry);
    return true;
}

// 清空(库级操作——删库/改名/导入整库替换等——之后必须清:
// 栈里的条目还引用着已经不存在的库,留着只会在撤销时炸)
export function clearUndo() {
    state.undoStack.length = 0;
    state.redoStack.length = 0;
}

// 把 snapshot 精确写回 obj:先删掉 snapshot 里没有的键,再逐键赋值。
// ⚠️ 不能只做 Object.assign —— 被删掉的字段(如 answer/histMarks)会残留,撤销就不彻底。
export function assignExact(obj, snapshot) {
    Object.keys(obj).forEach(k => { if (!(k in snapshot)) delete obj[k]; });
    Object.keys(snapshot).forEach(k => { obj[k] = snapshot[k]; });
    return obj;
}

// 深拷贝一道题(打点用:只存**那一道题**的旧值,单题成本 ~0.6KB)
export function cloneQuestion(q) {
    return JSON.parse(JSON.stringify(q));
}
