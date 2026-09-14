// ==================== 主题(暗色模式) ====================
// 职责:读设置 → 给 <html> 打 data-theme → 变量层自动换肤。
// 允许依赖:storage。禁止:parser/state。
import { loadThemeSetting, saveThemeSetting } from './storage.js';

function systemDark() {
    return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches;
}

// 应用当前设置到 <html data-theme>;auto 档跟随系统
export function applyTheme() {
    if (typeof document === 'undefined' || !document.documentElement) return;  // vm 沙箱无 documentElement
    const pref = loadThemeSetting();
    const theme = pref === 'auto' ? (systemDark() ? 'dark' : 'light') : pref;
    document.documentElement.dataset.theme = theme;
    // 手机状态栏颜色跟随
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#121417' : '#f5f7fa');
    // 同步那个"一键主题键":三枚图标靠 data-theme-pref 切(CSS 负责显示哪一枚),
    // 顺带把可读文案写进 title / aria-label —— 图标本身说不清"现在是哪一档"。
    syncThemeToggle(pref);
}

// 档位顺序 = 点一下换一档的顺序(自动 → 亮 → 暗 → 自动)
export const THEME_CYCLE = ['auto', 'light', 'dark'];
const THEME_LABEL = { auto: '自动', light: '亮', dark: '暗' };

function syncThemeToggle(pref) {
    if (typeof document === 'undefined' || !document.querySelector) return;
    const btn = document.querySelector('#theme-toggle-btn');
    if (!btn) return;
    const cur = THEME_CYCLE.includes(pref) ? pref : 'auto';
    if (btn.dataset) btn.dataset.themePref = cur;
    const text = `主题：${THEME_LABEL[cur]}（点击切换）`;
    if (btn.setAttribute) {
        btn.setAttribute('title', text);
        btn.setAttribute('aria-label', `主题：${THEME_LABEL[cur]}，点击切换`);
    }
}

// 点一下换一档(👤 2026-09-14:三格分段控件收成一个简约按钮)
export function cycleThemeSetting() {
    const cur = loadThemeSetting();
    const i = THEME_CYCLE.indexOf(THEME_CYCLE.includes(cur) ? cur : 'auto');
    setThemeSetting(THEME_CYCLE[(i + 1) % THEME_CYCLE.length]);
    return loadThemeSetting();
}

// 用户切换设置(自动/亮/暗),立即生效并持久化
export function setThemeSetting(pref) {
    saveThemeSetting(pref);
    applyTheme();
}

// 初始化:应用 + 监听系统切换(auto 档实时跟随)
export function initTheme() {
    if (typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').addEventListener) {
        matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme());
    }
    applyTheme();
}
