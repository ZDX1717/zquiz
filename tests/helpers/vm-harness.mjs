// vm 沙箱测试装置:在带 DOM/localStorage 桩的上下文中加载全部 src 模块(ESM)。
// 需以 node --experimental-vm-modules 运行。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const { SourceTextModule } = vm;
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

export function makeEl() {
    const qCache = {};          // 每个元素自己的 querySelector 缓存(同一选择器返回同一桩)
    const el = {
        _listeners: {},
        addEventListener(type, fn) { this._listeners[type] = fn; },
        // 属性记录:让 aria-* 等断言可读(原先 setAttribute 是空操作,getAttribute 都不存在)
        _attrs: {},
        setAttribute(k, v) { this._attrs[k] = String(v); },
        getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; },
        removeAttribute(k) { delete this._attrs[k]; },
        hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k); },
        // classList 记录状态而非空操作:让"类有没有真的加上/去掉"可断言。
        // 这不追求视觉保真(那是真机验收的事),只防"状态没生效"这类逻辑 bug。
        _classes: new Set(),
        classList: {
            add: (...c) => { c.forEach(x => el._classes.add(x)); },
            remove: (...c) => { c.forEach(x => el._classes.delete(x)); },
            toggle: (c, force) => {
                const on = force === undefined ? !el._classes.has(c) : !!force;
                if (on) el._classes.add(c); else el._classes.delete(c);
                return on;
            },
            contains: (c) => el._classes.has(c),
        },
        // ⚠️ className 必须与 classList 共用同一个账本:真实 DOM 里两者本就是同一份数据。
        // 桩里若只记 classList,那么用 `el.className = 'a b'` 建出来的元素在断言里
        // `classList.contains('a')` 恒为 false —— 测试写得像在验证,实际什么都没验证。
        // (真实踩坑:答题卡格子用 className 组装三态类,三态断言全落空。)
        get className() { return [...el._classes].join(' '); },
        set className(v) {
            el._classes.clear();
            String(v).split(/\s+/).filter(Boolean).forEach(x => el._classes.add(x));
        },
        // appendChild 记录子元素:DOM 结构类断言(如"标签行是不是卡片的第一个子元素")需要它。
        // 原先要求"测试只断数据层",但卡片结构本身就是产品要求,不记子节点就无法断言。
        style: {},
        appendChild(child) { this.children.push(child); return child; },
        // remove / removeChild:标准 DOM 方法,**桩里必须有** ——
        // 否则产品代码里再正常不过的"摘掉旧节点"会在测试里 TypeError,
        // 而单元测试是唯一能覆盖这类逻辑的地方(踩过:版本面板重建时 remove/removeChild 都缺)。
        removeChild(child) {
            const i = this.children.indexOf(child);
            if (i !== -1) this.children.splice(i, 1);
            child.parentNode = null;
            return child;
        },
        remove() {
            if (this.parentNode && typeof this.parentNode.removeChild === 'function') this.parentNode.removeChild(this);
            return undefined;
        },
        textContent: '', value: '', innerHTML: '', files: [],
        checked: false, placeholder: '', rows: 0, dataset: {},
        // querySelectorAll 默认返回空数组;但**编辑器选项**这类"表单内容即数据来源"的场景
        // 必须能喂进去(editorCollectOptions 靠它读选项)。用 _setQueryAll 显式注入,
        // 比在桩里造真实 DOM 树便宜得多,也避免"因为读不到就放宽产品逻辑"这种坏修法。
        // ⚠️ 按选择器缓存:同一个选择器要拿到**同一个**桩。
        //    以前每次调用都新建一个,于是产品代码里的
        //    `const panel = document.querySelector('#ai-rescue .rescue-route[data-route="manual"]')`
        //    在测试里**改完就丢** —— 后续 classList.toggle(...) 断言不到任何东西。
        //    真实 DOM 里同一选择器本就返回同一个节点,缓存反而更保真。
        querySelector: (sel) => (qCache[String(sel)] ||= makeEl()),
        querySelectorAll: () => [],
        _setQueryAll(items) { this.querySelectorAll = () => items; return this; },
        type: '', children: [], disabled: false,
        focus() {},
    };
    return el;
}

// 扫描 src/*.js 收集所有 DOM 常量(名字 → 元素 id),供注入 __zquiz 供测试驱动
function collectDomPairs() {
    const pairs = [];
    for (const f of ['state.js', 'parser.js', 'storage.js', 'main.js', 'dom.js', 'errorbook.js', 'favorites.js', 'quiz.js', 'bank.js']) {
        const srcText = readFileSync(path.join(SRC, f), 'utf8');
        for (const m of srcText.matchAll(/const (\w+) = document\.getElementById\('([\w-]+)'\)/g)) {
            pairs.push([m[1], m[2]]);
        }
    }
    return pairs;
}

export async function loadApp({ confirmResult = true, promptValue = 'x', sandboxExtras = {} } = {}) {
    const alerts = [];
    const elements = {};
    const qCache = {};              // document.querySelector 的按选择器缓存(理由见下)
    const store = new Map();
    const domContentLoadedCount = { n: 0 };
    const created = [];

    const docListeners = {};
    const sandbox = {
        // 最小 CustomEvent + document 事件总线(供事件通道导航测试)
        CustomEvent: class { constructor(type, opts = {}) { this.type = type; if (opts.detail !== undefined) this.detail = opts.detail; } },
        // vm 上下文**没有** Node 的 URL 全局。产品代码要校验接口地址就必须用它
        // (aiBaseUrlProblem),故这里补上 —— 否则一调就 ReferenceError,
        // 表现为"AI 请求压根没发出去",而报错信息完全指不到沙箱头上(踩过)。
        URL,
        URLSearchParams,
        // vm 上下文里**没有** TextDecoder/TextEncoder。产品的编码识别(src/decode.js)要用它们,
        // 缺了就会在"选择文件"那条路上抛 ReferenceError —— 报错还指不到沙箱头上(与当初补 URL 同一个坑)。
        TextDecoder,
        TextEncoder,
        ...sandboxExtras,
        document: {
            getElementById: (id) => (elements[id] ||= makeEl()),
            querySelector: (sel) => (qCache[String(sel)] ||= makeEl()),   // 同上:同一选择器同一桩
            querySelectorAll: () => [],
            createElement: (tag) => { const el = makeEl(); created.push({ tag: String(tag || '').toUpperCase(), el }); return el; },
            createTextNode: (t) => ({ text: t }),
            addEventListener(type, fn) {
                if (type === 'DOMContentLoaded') domContentLoadedCount.n++;
                (docListeners[type] = docListeners[type] || []).push(fn);
            },
            dispatchEvent(evt) {
                (docListeners[evt && evt.type] || []).forEach(fn => fn(evt));
                return true;
            },
            body: makeEl(),
        },
        localStorage: {
            getItem: (k) => (store.has(k) ? store.get(k) : null),
            setItem: (k, v) => store.set(k, String(v)),
            removeItem: (k) => store.delete(k),
        },
        alert(msg) { alerts.push(msg); },
        confirm() { return confirmResult; },
        prompt() { return promptValue; },
        setTimeout() { return 0; },
        console,
    };
    // 用 index.html 的真实 class 初始化各元素的 classList。
    // 否则 makeEl() 的 _classes 是空集合,contains('hidden') 恒为 false ——
    // 于是"某按钮初始带 hidden、代码却没移除 hidden"这类 bug 会被测试**静默放过**
    // (真实发生:套题模式「上一题」带了 hidden,断言却通过了)。
    {
        const htmlPath = path.join(SRC, '..', 'index.html');
        const html = readFileSync(htmlPath, 'utf8');
        for (const m of html.matchAll(/<[^>]*id="([\w-]+)"[^>]*>/g)) {
            const tag = m[0];
            const id = m[1];
            const cls = (tag.match(/class="([^"]*)"/) || [])[1];
            if (!cls) continue;
            const el = (elements[id] ||= makeEl());
            cls.split(/\s+/).filter(Boolean).forEach((c) => el._classes.add(c));
        }
    }

    // 文档级注入(如 documentElement),供主题等访问 document.documentElement 的模块测试
    if (sandboxExtras.document) Object.assign(sandbox.document, sandboxExtras.document);
    const context = vm.createContext(sandbox);

    const loaded = new Map();
    async function loadModule(spec) {
        if (loaded.has(spec)) return loaded.get(spec);
        const mod = new SourceTextModule(
            readFileSync(path.join(SRC, spec), 'utf8'),
            { identifier: spec, context }
        );
        loaded.set(spec, mod); // 先占位,防循环依赖死递归
        await mod.link(async (specifier) => loadModule(specifier.replace('./', '')));
        await mod.evaluate();
        return mod;
    }
    await loadModule('main.js');

    // 把模块内部的 DOM 常量对象挂到 __zquiz(与模块共享同一实例,测试可直接驱动)
    const domConsts = {};
    for (const [name, id] of collectDomPairs()) {
        if (elements[id]) domConsts[name] = elements[id];
    }
    sandbox.__created = created;
    sandbox.__inject = domConsts;
    vm.runInContext('Object.assign(globalThis.__zquiz, __inject)', context);

    // with(state) 让测试表达式继续用迁移前的裸状态名;with(__zquiz) 提供内部函数。
    // 表达式模式失败(含 let/const 的多语句)时回退到语句模式。
    const run = (expr) => {
        try {
            return vm.runInContext(
                `(function(){ with (globalThis.__zquiz) { with (__zquiz.state) { return (${expr}); } } })()`,
                context
            );
        } catch (e) {
            if (e?.name !== 'SyntaxError') throw e; // vm 上下文的 SyntaxError 不是宿主实例
            return vm.runInContext(
                `(function(){ with (globalThis.__zquiz) { with (__zquiz.state) { ${expr} } } })()`,
                context
            );
        }
    };

    return { run, elements, store, alerts, sandbox, domContentLoadedCount, qCache };
}
