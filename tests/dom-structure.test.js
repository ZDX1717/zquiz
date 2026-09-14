// DOM 结构回归:所有模态框必须位于任何 section/main 之外
// (复习范围弹窗曾被隐藏 section 连带隐藏,点复习错题"没反应"的根因)
// 注:review-scope-modal 已随"题源"改造退役(复习不再走范围弹窗),此处不再列入;
// 但这条守卫对**现存**模态框继续有效——新增模态框请一并加进下面的清单。
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(root, 'index.html'), 'utf8');
const css = readFileSync(path.join(root, 'styles.css'), 'utf8');

test('所有模态框均在 <main> 之外', () => {
    const mainEnd = html.indexOf('</main>');
    for (const id of ['create-bank-modal', 'rename-bank-modal', 'import-preview-modal', 'edit-bank-modal', 'ai-settings-modal']) {
        const pos = html.indexOf(`id="${id}"`);
        assert.ok(pos !== -1, `模态框 ${id} 不存在`);
        assert.ok(pos > mainEnd, `模态框 ${id} 仍在 <main> 内,会被隐藏 section 连带隐藏`);
    }
});

test('每个 section 内不得残留模态框', () => {
    for (const m of html.matchAll(/<section id="([^"]+)"/g)) {
        const secStart = html.indexOf(m[0]);
        const secEnd = html.indexOf('</section>', secStart);
        assert.ok(!html.slice(secStart, secEnd).includes('class="modal'), `${m[1]} 内残留模态框`);
    }
});

// 断言 CSS 前先去掉注释:否则"不要写 overflow:hidden"这类注释本身会被当成规则命中
const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, '');

test('标题栏悬浮(sticky)的前提:container 不得有 overflow 裁剪', () => {
    // position:sticky 会被祖先的 overflow:hidden/auto/scroll 裁剪而静默失效。
    // 这里守卫该前提,否则有人为了"圆角裁切"加回 overflow:hidden 就会悄悄破坏吸顶。
    const containerRule = cssNoComments.match(/\.container\s*\{[^}]*\}/);
    assert.ok(containerRule, '应有 .container 规则');
    assert.ok(
        !/overflow\s*:\s*(hidden|auto|scroll)/.test(containerRule[0]),
        '.container 不得设置 overflow 裁剪,否则 header 的 sticky 会失效',
    );

    const headerRule = cssNoComments.match(/^header\s*\{[^}]*\}/m);
    assert.ok(headerRule, '应有 header 规则');
    assert.ok(/position\s*:\s*sticky/.test(headerRule[0]), 'header 应 position: sticky');
    assert.ok(/top\s*:/.test(headerRule[0]), 'header 应设置吸顶偏移 top');
    assert.ok(/z-index\s*:.+/.test(headerRule[0]), 'header 应设置 z-index 以浮在内容之上');
});

test('主题开关住在标题栏里(每个 tab 都能切主题)', () => {
    const header = html.slice(html.indexOf('<header>'), html.indexOf('</header>'));
    assert.ok(header.includes('id="theme-switch"'), '主题开关应在 header 内');
    assert.ok(header.includes('data-theme-opt="dark"'), '暗色档位应在 header 内');
    // 首页不得再有第二个开关
    assert.strictEqual((html.match(/id="theme-switch"/g) || []).length, 1, 'theme-switch 只能有一个');
});

test('品牌块:logo + 右下小字,tagline 是 h1 的嵌套 small', () => {
    const header = html.slice(html.indexOf('<header>'), html.indexOf('</header>'));
    assert.ok(/<h1[^>]*class="brand"/.test(header), 'h1 应带 class="brand"(保留一级标题语义)');
    assert.ok(header.includes('Zquiz'), '应显示 Zquiz');
    assert.ok(/<small class="brand-tagline">期末周刷题助手<\/small>/.test(header), 'tagline 应是 h1 内的 small');
});

test('开始刷题按钮必须全屏宽隐藏(不能只写在手机媒体查询里)', () => {
    // 回归:该规则原先只写在 @media (max-width:768px) 内,
    // 导致桌面上"结果页上方还挂着一个开始刷题按钮"(👤 反馈)。
    // 判据:把所有媒体查询整体剔除后,该规则仍应存在 —— 剔除后不存在即说明它是手机专属。
    const stripMedia = (cssText) => {
        let out = '', i = 0;
        while (i < cssText.length) {
            const at = cssText.indexOf('@media', i);
            if (at === -1) { out += cssText.slice(i); break; }
            out += cssText.slice(i, at);
            const open = cssText.indexOf('{', at);
            let depth = 1, j = open + 1;
            while (j < cssText.length && depth > 0) {
                if (cssText[j] === '{') depth++;
                else if (cssText[j] === '}') depth--;
                j++;
            }
            i = j;
        }
        return out;
    };
    const noMedia = stripMedia(String(cssNoComments));
    assert.ok(
        noMedia.includes('#start-quiz-btn'),
        '#start-quiz-btn 的隐藏规则必须有一条不在任何媒体查询内(否则桌面端失效)',
    );
    assert.ok(
        /#quiz-result:not\(\.hidden\)\)\s*#start-quiz-btn/.test(String(cssNoComments)),
        '隐藏规则需覆盖 #quiz-result 显示时的状态(结果页也要隐藏该按钮)',
    );
});

test('内容区内边距统一:三页共用一套值(含手机小档)', () => {
    // 演进:先是有 32px 上内边距(模块上方空白太大)→ 改成 0(内容贴住标题栏)→
    // 现在统一为一套令牌。守的是"统一"与"顶部有呼吸位"这两点。
    const cssText = String(cssNoComments);

    // ① 令牌存在且有值
    for (const tok of ['--pad-x', '--pad-top', '--pad-bottom']) {
        assert.ok(new RegExp(`^\\s*${tok}\\s*:\\s*\\d+px`, 'm').test(cssText), `应定义 ${tok}`);
    }

    // ② 桌面 main 使用令牌,而不是写死像素(写死就没法"统一")
    const mainRule = cssText.match(/(?:^|[\s,])main\s*\{([^}]*)\}/);
    assert.ok(mainRule, '应有 main 规则');
    assert.ok(
        /padding\s*:\s*var\(--pad-top\)\s+var\(--pad-x\)\s+var\(--pad-bottom\)/.test(mainRule[1]),
        'main 的 padding 应使用统一令牌',
    );

    // ③ 手机端只覆盖令牌值,不再另写一套 main padding
    const mobileTokens = (cssText.match(/@media[^{]*max-width:\s*768px[^{]*\{[\s\S]*?:root\s*\{([^}]*)\}/) || [])[1];
    assert.ok(mobileTokens, '手机端应覆盖 :root 的间距令牌');
    assert.ok(/--pad-top\s*:\s*\d+px/.test(mobileTokens), '手机端应给 --pad-top 一个非零小档');

    // ④ 顶部不得为 0 —— 曾被设成 0,导致刷题/题库页内容直接贴住标题栏(👤 反馈)
    const top = cssText.match(/--pad-top\s*:\s*(\d+)px/);
    assert.ok(Number(top[1]) > 0, '顶部必须有呼吸位(不得为 0)');
});

test('品牌小字紧随 logo 的右下角(在同一行,不单独占一行)', () => {
    const cssText = String(cssNoComments);
    const brand = cssText.match(/h1\.brand\s*\{([^}]*)\}/);
    assert.ok(brand, '应有 h1.brand 规则');
    // 不得再用"纵向堆叠 + 右对齐"的旧方案(会让小字多占一行)
    assert.ok(!/flex-direction\s*:\s*column/.test(brand[1]), 'h1.brand 不应为 column 布局');
    const tagline = cssText.match(/\.brand-tagline\s*\{([^}]*)\}/);
    assert.ok(tagline, '应有 .brand-tagline 规则');
    assert.ok(/font-size\s*:\s*10px/.test(tagline[1]), '小字应为 10px');
});

test('宽度档位唯一来源:不得在别处写死 max-width 像素', () => {
    // 👤 反馈"首页明显比后俩页宽"。根因是首页卡片没有 max-width,撑满 1000px 页面档,
    // 而刷题/结果页走 640px 阅读档。为了让"三页同宽"成为可守的不变量,
    // 四档宽度全部提为令牌;任何地方再写死 max-width 像素都会破坏一致性。
    const cssText = String(cssNoComments);
    // 排除 :root 里的令牌定义行
    // 只匹配"声明的属性",不匹配 @media 条件(它们不是属性,写法上带括号)
    const offenders = cssText
        .split('\n')
        .filter(l => /(^|[;{\s])max-width\s*:\s*\d+px/.test(l) && !/^\s*--/.test(l) && !/@media/.test(l));
    assert.deepStrictEqual(offenders, [], `不得写死 max-width 像素,应使用档位令牌:\n${offenders.join('\n')}`);

    for (const tok of ['--reading-width', '--modal-sm', '--modal-lg', '--page-width']) {
        assert.ok(new RegExp(`^\\s*${tok}\\s*:\\s*\\d+px`, 'm').test(cssText), `应定义 ${tok}`);
    }
});

test('首页:三层结构 + 全页只有一个主色实心按钮(👤 2026-09-13 重构)', () => {
    const home = html.slice(html.indexOf('id="home-section"'), html.indexOf('id="quiz-section"'));
    // ① 只有一张主卡片:撤销不再是独立卡片(它与主任务不是一回事,却曾和它等重)
    assert.strictEqual((home.match(/class="operation-card/g) || []).length, 1,
        '首页只该有一张 operation-card(导入撤销应并进来,不再单列一张)');
    // 「撤销上次导入」已删(👤 2026-09-13:导入的撤销统一走**题库版本记录**);
    // 「上次导入」信息挪到题库页,只作展示
    assert.ok(!home.includes('undo-import-btn') && !home.includes('last-import-info'),
        '首页不该再有撤销按钮,也不该再显示"上次导入"(它搬去题库页了)');
    assert.ok(html.indexOf('id="last-import-info"') > html.indexOf('id="banks-section"'),
        '「上次导入」信息应在题库页');
    // ② 主次:唯一的主色实心按钮 = 解析并预览;其余动作一律 secondary
    const btnClasses = [...home.matchAll(/class="action-btn([^"]*)"/g)].map(m => m[1].trim());
    const primary = btnClasses.filter(c => !c.includes('secondary'));
    assert.strictEqual(primary.length, 1, `首页只该有一个实心主按钮,实际 ${primary.length} 个:${JSON.stringify(btnClasses)}`);
    assert.ok(home.includes('id="paste-parse-btn" class="action-btn paste-primary"'),
        '主键应是「解析并预览」');
    for (const id of ['upload-btn', 'paste-clear-btn', 'copy-prompt-btn', 'rescue-ai-btn']) {
        const re = new RegExp(`id="${id}" class="action-btn[^"]*secondary`);
        assert.ok(re.test(home), `${id} 应是次要按钮(描边),不与主键争视觉重量`);
    }
    // ③ 补救路径默认**收起**(它不是主任务,常驻会占掉手机半屏)。
    //    参考材料(格式说明)不再走折叠块 —— 它收成了卡片右上角的「?」悬浮面板(见下一个测试)。
    assert.ok(/<details id="ai-rescue" class="home-fold">/.test(home), 'ai-rescue 应是折叠块');
    assert.ok(!/<details id="ai-rescue"[^>]*\sopen/.test(home), '折叠块默认不展开');
    assert.ok(!home.includes('home-fold-summary">支持的题目格式'),
        '格式说明不该再是首页底部那个常驻折叠块');
    // ④ 折叠块也走阅读档宽度(与首页卡片同宽,不然桌面上一宽一窄)
    assert.ok(/#home-section > \.home-fold[^{]*\{[^}]*max-width\s*:\s*var\(--reading-width\)/.test(cssNoComments),
        '首页折叠块应走阅读档宽度');
    assert.ok(/#home-section > \.install-hint[^{]*\{[^}]*max-width\s*:\s*var\(--reading-width\)/.test(cssNoComments),
        '「加到主屏」引导也走阅读档宽度(否则与首页其它模块不同宽)');
    // 引导必须在**最后**:它是最不重要的内容,不许挤到主任务前面
    assert.ok(home.indexOf('install-hint') > home.indexOf('id="ai-rescue"'),
        '「加到主屏」引导应是首页最后一块(排在主任务/补救之后)');
    // ⑤ 手机档:主键 ≥48px、次键 ≥40px —— 主次也体现在尺寸上
    const media = cssNoComments.slice(cssNoComments.indexOf('max-width: 768px'));
    assert.ok(/\.paste-primary\s*\{[^}]*min-height\s*:\s*48px/.test(cssNoComments),
        '主键应 48px(手机拇指目标)');
    assert.ok(/\.paste-actions-minor \.action-btn\s*\{[^}]*min-height\s*:\s*40px/.test(cssNoComments),
        '次键应 40px(比主键小一号)');
    assert.ok(/\.home-fold > summary\s*\{[^}]*min-height\s*:\s*44px/.test(cssNoComments),
        '折叠摘要应 44px 触达');
    // ⑥ CSS 里也不许有"第二个主色实心按钮":#upload-btn 曾被 id 特判染成主色,
    //    类写对了也会被压过去(id 特指度更高)—— 这种"暗桩"必须由测试兜住
    for (const id of ['upload-btn', 'paste-clear-btn', 'copy-prompt-btn', 'rescue-ai-btn']) {
        const re = new RegExp(`#${id}\\s*\\{[^}]*background-color\\s*:\\s*var\\\(--c-primary\\\)`);
        assert.ok(!re.test(cssNoComments), `#${id} 被单独染成主色了 —— 首页只许有一个实心主键`);
    }
    // ⑦ 老规则不许复活:它把所有按钮拉成等宽,主次就没了
    assert.ok(!/\.paste-actions \.action-btn\s*\{[^}]*flex\s*:\s*1 1 auto/.test(cssNoComments),
        '「所有按钮等宽」的老规则会把主次抹平,不许复活');
});

test('首页「?」= 支持的题目格式悬浮面板(👤 2026-09-13:去掉底部折叠块,改挂输入框模块右上角)', () => {
    const home = html.slice(html.indexOf('id="home-section"'), html.indexOf('id="quiz-section"'));
    // ① 位置:在**导入卡片**的 head 里、输入框之前;且在「⚙ AI 设置」右侧(右上角区域)
    const headIdx = home.indexOf('class="card-head"');
    const helpIdx = home.indexOf('id="format-help-btn"');
    const textareaIdx = home.indexOf('id="paste-input"');
    assert.ok(headIdx > -1 && helpIdx > headIdx && helpIdx < textareaIdx,
        '「?」应在导入卡片的头部(输入框模块右上角),不是页面底部');
    assert.ok(helpIdx > home.indexOf('id="ai-settings-btn"'),
        '「?」应排在「⚙ AI 设置」右侧 —— 那一行才是右上角');
    // ② ⚠️ 两个行内控件必须包一组:`.card-head` 是 space-between,三个孩子会被平摊到左/中/右
    const actions = home.slice(home.indexOf('class="card-head-actions"'), home.indexOf('id="format-help-btn"'));
    assert.ok(actions.includes('ai-settings-btn'), '「⚙ AI 设置」与「?」应在同一个 .card-head-actions 组里');
    assert.ok(/\.card-head-actions\s*\{[^}]*display\s*:\s*flex/.test(cssNoComments),
        '.card-head-actions 应是 flex 行');
    // ③ 内容搬过来了(格式说明的正文不许丢)
    const panel = home.slice(home.indexOf('class="home-help-panel"'), home.indexOf('</details>'));
    for (const kw of ['支持的题目格式', '字段式', '判断题', '参考答案', '自动识别']) {
        assert.ok(panel.includes(kw), `悬浮面板里应有「${kw}」`);
    }
    // ④ 默认收起 + 悬浮(不占文档流):[open] 控制 + 闭合显式 display:none + absolute + 悬浮菜单档 z-index
    assert.ok(/<details id="format-help" class="home-help">/.test(home), '应是 details.home-help,且默认不带 open');
    assert.ok(/\.home-help:not\(\[open\]\) > \.home-help-panel \{ display: none; \}/.test(cssNoComments),
        '闭合态必须显式 display:none(闭合的 details 在本机 chromium 上仍会渲染 children)');
    const panelRule = cssNoComments.match(/\n\.home-help-panel \{([^}]*)\}/);
    assert.ok(panelRule, '应有 .home-help-panel 的规则');
    assert.ok(/position\s*:\s*absolute/.test(panelRule[1]), '面板应 absolute 悬浮,不占文档流');
    assert.ok(/z-index\s*:\s*60/.test(panelRule[1]), '面板走「悬浮菜单」档 z-index:60(见 DESIGN §3.8)');
    assert.ok(/max-height\s*:\s*60vh/.test(panelRule[1]) && /overflow-y\s*:\s*auto/.test(panelRule[1]),
        '面板不许撑高页面:60vh + 自己滚');
    assert.ok(/right\s*:\s*0/.test(panelRule[1]), '贴触发器右边,避免往右溢出屏幕');
    // ⑤ 触发器是圆形小键,**不是**第二个主色实心按钮(首页只许有一个)
    const btnRule = cssNoComments.match(/\n\.home-help-btn \{([^}]*)\}/);
    assert.ok(btnRule && /border-radius\s*:\s*50%/.test(btnRule[1]), '问号键应是圆形');
    assert.ok(/width\s*:\s*24px/.test(btnRule[1]) && /height\s*:\s*24px/.test(btnRule[1]), '问号键 24×24');
    assert.ok(!/background\s*:\s*var\(--c-primary\)/.test(btnRule[1]),
        '问号键不许染主色实心 —— 首页只有一个实心主键');
    assert.ok(/::\-webkit\-details\-marker \{ display: none; \}/.test(cssNoComments),
        '要去掉 summary 默认的三角标记');
    // ⑥ 点外面收起 + Esc 收起(浮层不能点不掉)
    const main = readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    assert.ok(/formatHelpDetails/.test(main) && /formatHelpWrap/.test(main), 'main.js 应持有这两个引用');
    assert.ok(/!formatHelpDetails \|\| !formatHelpDetails\.open\) return;/.test(main) && /formatHelpDetails\.open = false;/.test(main),
        'main.js 应有点击外部 / Esc 的收起逻辑');
    assert.ok(/'Escape'/.test(main), 'Esc 也应能关掉这个悬浮面板');
    // ⑦ 🚨 卡头规则各归各家:`.card-head` 两处共用,弹窗那条写在文件后面会**整条泄漏**到首页卡头
    //    (实测:justify-content:center + padding:0 48px 0 8px → 控件被挤在中间、右边空出 48px,
    //     那是给弹窗 ✕ 留的位置 —— 于是"右上角按钮"永远贴不到右上角)
    assert.ok(/\.edit-card \.card-head \{/.test(cssNoComments),
        '弹窗卡头规则必须限定在 .edit-card 里(不然会漏到首页卡头)');
    assert.ok(!/\n\.card-head \{\n\s*position: relative;/.test(cssNoComments),
        '不许再有裸 .card-head { position: relative } —— 那是弹窗那条的泄漏源');
    const homeHead = cssNoComments.match(/\n\.home-import \.card-head \{([^}]*)\}/);
    assert.ok(homeHead, '首页卡头应有自己的规则');
    assert.ok(/justify-content\s*:\s*space-between/.test(homeHead[1]), '首页卡头:h3 在左、动作组贴右');
    assert.ok(/padding\s*:\s*0;/.test(homeHead[1]), '首页卡头不许留弹窗 ✕ 的那 48px 右侧留白');
    assert.ok(/position\s*:\s*relative/.test(homeHead[1]),
        '首页卡头要 relative —— 手机档(此时 .home-help 是 static)的悬浮面板靠它定位');
});

test('导入输入框:必须自动换行(👤 2026-09-13 报"提示字显示不全")', () => {
    const rule = cssNoComments.match(/\n#paste-input \{([^}]*)\}/);
    assert.ok(rule, '应有 #paste-input 的规则');
    // ✅ pre-wrap = 保留粘贴进来的原始换行 + 超宽行自动折行(正是 👤 要的"自动换行")
    assert.ok(/white-space\s*:\s*pre-wrap/.test(rule[1]), '必须是 pre-wrap');
    assert.ok(/overflow-wrap\s*:\s*anywhere/.test(rule[1]) && /word-break\s*:\s*break-word/.test(rule[1]),
        '超长英文/连续串也要能断行');
    // 🚨 `white-space: pre` 会**关掉自动换行** —— 长行横向溢出、右边被裁。
    //    实测(2026-09-13):框宽 340px,一行内容 760px,每行只看得到前半截,提示字与粘贴的长行都被切。
    //    ⚠️ 只能按"选择器涉及 textarea / 输入框"来判 —— CSS 里的 <pre> 示例块合法地使用 pre。
    const blocks = [...cssNoComments.matchAll(/([^{}]+)\{([^}]*)\}/g)];
    const offenders = blocks
        .filter(m => /textarea|paste-input/.test(m[1]) && /white-space\s*:\s*pre\s*;/.test(m[2]))
        .map(m => m[1].trim().split('\n').pop().trim());
    assert.deepStrictEqual(offenders, [], `输入框上不许写 white-space: pre(会关掉自动换行):${offenders.join(' / ')}`);
});

test('导入输入框的提示词:两条路都要说清(粘贴 / 选文件)(👤 2026-09-13 对齐流程)', () => {
    const m = html.match(/id="paste-input"[^>]*placeholder="([^"]*)"/);
    assert.ok(m, '输入框应有提示词');
    const ph = m[1];
    // ① 👤 2026-09-13 定稿的写法:两条路各占一行,用「方式一 / 方式二」标出来
    assert.ok(ph.includes('方式一') && ph.includes('方式二'),
        '提示词要用「方式一 / 方式二」把两条路并列写清,实际:' + ph);
    assert.ok(ph.includes('粘贴'), '方式一要写明可以直接粘贴');
    assert.ok(ph.includes('选择文件'), '方式二要写明也可以选文件导入');
    // ② 说清哪些文件能吃(旧文案只提 txt/docx,用户以为 PDF/Word 不行)
    assert.ok(/Word/.test(ph), '要提到 Word');
    assert.ok(/PDF/.test(ph), '要提到 PDF(PDF 会在选择后给出专门提示)');
    assert.ok(/txt/.test(ph), '要提到 txt');
    assert.ok(ph.includes('目前支持'), '用"目前支持…"交代格式范围');
    // ③ 手机上不许被框裁掉:占行数 ≤ 框能显示的行数(见「导入输入框:必须自动换行」那条的教训)
    assert.ok(!/[（(]/.test(ph), '提示词里不该有括号补充');
});

test('AI 整理成标准格式:两条路都显示 + 按情况分主次 + 文案有预算(👤 2026-09-13 定)', () => {
    const start = html.indexOf('id="ai-rescue"');
    const sec = html.slice(start, html.indexOf('</details>', start));
    // ① 名字:👤 定的区名
    assert.ok(sec.includes('<summary class="home-fold-summary">AI 整理成标准格式</summary>'),
        '折叠标题应是「AI 整理成标准格式」');
    // ② 文案预算:整块可见文字 ≤190 字(历史上两栏并列 272 字、占手机 57% 屏,👤 说读完不知道点哪个)
    const text = sec.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, '');
    assert.ok(text.length <= 190, `文案要短(≤190 字),实际 ${text.length} 字 —— 别再往里加解释`);
    assert.ok(!/A ·|B ·/.test(sec), '不许再有「A · 手动整理…」这种标题墙(它占了最多字数)');
    // ③ **两条路都在**(不再隐藏任何一条 —— 只铺一条时另一条用户根本发现不了)
    assert.ok(sec.includes('data-route="manual"') && sec.includes('data-route="auto"'), '两条路都要在');
    assert.ok(!/rescue-route\[data-route=[^\]]*\][^{]*\{[^}]*display:\s*none/.test(cssNoComments),
        '不许用 display:none 藏掉整条路 —— 主次靠样式,不靠隐藏');
    assert.ok(/\.rescue-route\s*\{[^}]*order:\s*2/.test(cssNoComments) &&
        /\.rescue-route\.is-primary\s*\{[^}]*order:\s*1/.test(cssNoComments),
        '主次靠 order:主的那条排最前');
    assert.ok(/\.rescue-route\.is-primary\s*\{[^}]*background:\s*var\(--c-surface-alt\)/.test(cssNoComments),
        '主的那条要有浅底,与次要那条一眼分开');
    assert.ok(/\.rescue-route\.is-primary \.rescue-route-name\s*\{[^}]*font-weight:\s*600/.test(cssNoComments),
        '主那条的路线名要加粗');
    // ④ 主 = 整行 48px(手机),次 = 40px;颜色都还是 secondary —— 首页只许一个主色实心键
    assert.ok(/\.rescue-main\s*\{[^}]*min-height:\s*40px/.test(cssNoComments), '次要那条按钮 40px');
    assert.ok(/\.rescue-route\.is-primary \.rescue-main\s*\{[^}]*width:\s*100%;\s*min-height:\s*44px/.test(cssNoComments),
        '主那条按钮应整行');
    const mobileBlocks = [...cssNoComments.matchAll(/@media \(max-width: 768px\) \{([\s\S]*?)\n\}/g)].map(m => m[1]);
    assert.ok(mobileBlocks.some(b => /\.rescue-route\.is-primary \.rescue-main \{ min-height: 48px; \}/.test(b)),
        '手机档主按钮应 48px(拇指目标)');
    for (const id of ['copy-prompt-btn', 'rescue-ai-btn']) {
        assert.ok(new RegExp(`id="${id}" class="action-btn secondary rescue-main"`).test(html),
            `${id} 应是 secondary + rescue-main(不许染主色)`);
    }
    // ⑤ HTML 默认(JS 还没跑)= 没配 Key 的情形:手动那条在主位
    assert.ok(/class="rescue-route is-primary" data-route="manual"/.test(sec),
        '默认应把手动那条写成 is-primary(与"没配 Key 的人占多数"一致)');
    // ⑥ 一键整理那句说明随 Key 状态换
    assert.ok(sec.includes('data-when="needkey"') && sec.includes('data-when="ready"'), '两种说明都要在');
    assert.ok(/#ai-rescue:not\(\.auto-ready\) \.rescue-route-hint\[data-when="ready"\] \{ display: none; \}/.test(cssNoComments),
        '没配 Key 时不该显示"结果会怎样",该显示"先去配 Key"');
});

test('首页主卡片与救援区:文案里不许再塞括号补充(👤 2026-09-13:"去掉括号里的废话")', () => {
    // 👤 点名的三处:（网页 / 微信 / Word 直接复制）（只改格式，不改内容）（材料里没答案的题留空）
    // 规律:括号里的补充说明基本都是"写了也没人看"的废话;要说的信息就直说,别往括号里塞。
    // ⚠️ 例外:格式示例那段 <pre> 里的括号是**语法本身**(如"……（B）""（多选连写：答案：ABC）"),必须保留。
    const card = html.slice(html.indexOf('operation-card home-import'),
        html.indexOf('</details>', html.indexOf('id="ai-rescue"')));
    const noPre = card.replace(/<pre>[\s\S]*?<\/pre>/g, '');
    const text = noPre.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, '|');
    const offenders = text.split('|').map(t => t.trim()).filter(t => /[（(][^）)]*[）)]/.test(t));
    assert.deepStrictEqual(offenders, [], '首页文案里不许有括号补充,实际:\n' + offenders.join('\n'));
    // 顺带:提示词也不能靠括号补信息(它最容易又长回去)
    const ph = (html.match(/id="paste-input"[^>]*placeholder="([^"]*)"/) || [])[1] || '';
    assert.ok(!/[（(]/.test(ph), '提示词里不许有括号,实际:' + ph);
});

test('监听器不许把"首参是开关"的函数裸挂上去(👤 报"只复制了提示词"就是这么来的)', () => {
    // ⚠️ 先剥注释:解释这条坑的注释里**原样写着**那行坏代码,不剥掉会把自己判红(踩过)
    const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    const main = strip(readFileSync(path.join(root, 'src', 'main.js'), 'utf8'));
    const bank = strip(readFileSync(path.join(root, 'src', 'bank.js'), 'utf8'));
    // 🚨 曾经:`copyPromptBtn.addEventListener('click', copyOfficialPrompt)`。
    //    浏览器把 **MouseEvent** 当第一个实参传进去,而那个参数是 forcePromptOnly 开关 ——
    //    事件对象是真值 → 每次点击都走"只要提示词"分支:按钮写着"和题目",却只复制了提示词。
    assert.ok(!/addEventListener\(\s*'click'\s*,\s*copyPromptBtn|addEventListener\(\s*'click'\s*,\s*copyOfficialPrompt\s*\)/.test(main),
        'copyOfficialPrompt 不许裸挂成监听器(会把事件对象当开关参数)');
    assert.ok(/copyPromptBtn\.addEventListener\('click', \(\) => copyOfficialPrompt\(\)\)/.test(main),
        '应包一层箭头函数,不传任何开关');
    // 第二道防线:开关参数本身必须严格判断 —— 万一别处又传了个事件对象,也不会静默降级
    assert.ok(/const promptOnly = forcePromptOnly === true;/.test(bank),
        'forcePromptOnly 必须严格等于 true 才算"只要提示词"');
});

test('三页内容同宽:首页与题库页的模块走阅读档', () => {
    const cssText = String(cssNoComments);
    for (const sel of ['#home-section > .operation-card', '#banks-section > .banks-list']) {
        const re = new RegExp(sel.replace(/[.#>]/g, (c) => '\\' + c) + '[^{]*\\{([^}]*)\\}');
        const m = cssText.match(re);
        assert.ok(m, `应有 ${sel} 的宽度规则`);
        assert.ok(/max-width\s*:\s*var\(--reading-width\)/.test(m[1]), `${sel} 应走阅读档宽度`);
    }
});

test('三个页面内容同宽:首页/题库页模块与刷题配置区都走阅读档', () => {
    // 实测教训:首页卡片与 .quiz-settings 都没有 max-width,桌面上撑满 952px(页面档),
    // 而刷题容器/结果页走 640px 阅读档 → "首页明显比后俩页宽"(👤 反馈)。
    // 同宽靠档位令牌保证,不靠逐页调。
    const cssText = String(cssNoComments);
    const want = [
        '#home-section > .operation-card',
        '#banks-section > .banks-list',
        '.quiz-settings',
    ];
    for (const sel of want) {
        const re = new RegExp(sel.replace(/[.#>]/g, (c) => '\\' + c) + '[^{]*\\{([^}]*)\\}');
        const m = cssText.match(re);
        assert.ok(m, `应有 ${sel} 的规则`);
        assert.ok(
            /max-width\s*:\s*var\(--reading-width\)/.test(m[1]),
            `${sel} 应走阅读档宽度(否则与其它页不同宽)`,
        );
    }
    // 刷题容器与结果页原本就走阅读档,一并对齐验证
    for (const sel of ['.quiz-container', '.quiz-result']) {
        const re = new RegExp(sel.replace(/[.#]/g, (c) => '\\' + c) + '[^{]*\\{([^}]*)\\}');
        assert.ok(/max-width\s*:\s*var\(--reading-width\)/.test(cssText.match(re)[1]), `${sel} 应走阅读档`);
    }
});

test('按钮类必须显式声明 border(否则露出浏览器默认黑边)', () => {
    // 回归:合并重复的 .nav-btn 规则时漏掉了 border:none,
    // 结果导航按钮戴上浏览器默认边框,表现为"按钮周围出现黑边"。
    // 判据:每个"作为按钮用"的类,其规则里必须出现 border 声明(border:none 或自定义边框)。
    const cssText = String(cssNoComments);
    const buttonClasses = ['\.nav-btn', '\.action-btn', '\.theme-opt', '\.card-link',
        '\.prompt-toggle', '\.favorite-btn', '\\.delete-btn', '\.foot-toggle'];
    const missing = [];
    for (const cls of buttonClasses) {
        // 取该类的**基础**规则:选择器的第一项必须正好是该类(不含伪类/祖先选择器),
        // 否则会误命中 `.question-tags .favorite-btn` 这类复合规则(其 body 里自然没有 border)
        const re = new RegExp('(?:^|\\})[^{}]*?(?:^|[\\n,])\\s*' + cls + '\\s*\\{([^}]*)\\}', 'm');
        const m = cssText.match(re);
        if (!m) continue;                       // 该类可能只在复合选择器里出现
        // 注意:必须排除 border-radius —— 它含 'border' 子串,会让判据形同虚设
        const hasBorderDecl = /(^|[;{\s])border(-width|-style|-color|-top|-right|-bottom|-left)?\s*:/.test(m[1]);
        if (!hasBorderDecl) missing.push(cls.replace('\\', ''));
    }
    assert.deepStrictEqual(missing, [], `这些按钮类缺少 border 声明,会露出默认黑边: ${missing.join(', ')}`);
});

test('刷题元信息并入下方操作区:进度条已移除,手机单行且按钮收窄', () => {
    // 👤 要求:删进度条,把「1/45 判断 收藏 连对」放到下一题/结束刷题按钮左边。
    const cssText = String(cssNoComments);

    // ① 进度条元素与其样式都已移除
    assert.ok(!html.includes('quiz-progress'), '进度条元素应已移除');
    assert.ok(!/quiz-progress/.test(cssText), '进度条样式应已移除');
    assert.ok(!html.includes('question-header'), '题目头部元素应已移除');

    // ② 操作区内只剩「智能切题」;进度/答题卡/题型/收藏都已移出(👤 定调 2026-09-11)
    const controls = html.slice(html.indexOf('class="quiz-controls"'), html.indexOf('</div>', html.indexOf('class="quiz-actions"')));
    assert.ok(controls.includes('class="quiz-meta"'), '操作区内应有 .quiz-meta');
    assert.ok(controls.indexOf('quiz-meta') < controls.indexOf('quiz-actions'), '元信息应在按钮组之前(左侧)');
    assert.ok(controls.includes('id="auto-next-toggle"'), '状态栏应包含智能切题');
    for (const id of ['favorite-btn', 'question-type', 'answer-card-open', 'question-number']) {
        assert.ok(!controls.includes(`id="${id}"`), `#${id} 不应再留在状态栏(已移到题干上方)`);
    }
    // 题型/答题卡/收藏都应在题干之前(👤 定调:从左到右 答题卡 → 题型 → 收藏)
    const tagsRow = html.slice(html.indexOf('class="question-tags"'), html.indexOf('</div>', html.indexOf('class="question-tags"')));
    for (const id of ['answer-card-open', 'question-type', 'favorite-btn']) {
        assert.ok(tagsRow.includes(`id="${id}"`), `标签行应包含 #${id}`);
    }
    assert.ok(!controls.includes('id="question-type"'), '题型不应再留在状态栏');
    assert.ok(
        html.indexOf('id="question-type"') < html.indexOf('id="question-text"'),
        '题型应出现在题干之前',
    );
    // 连对(🔥)展示功能已按 👤 要求整体删除,不得残留元素/样式/代码
    assert.ok(!html.includes('streak-badge'), '连对徽标元素应已删除');
    assert.ok(!/streak-badge/.test(cssText), '连对徽标样式应已删除');
    assert.ok(!/updateStreakBadge/.test(readFileSync(path.join(root, 'src', 'quiz.js'), 'utf8')),
        'updateStreakBadge 代码应已删除');

    // ③ 收藏按钮移出状态栏后,必须清掉自带的 margin-left:auto(它原在题目头部靠右),
    //    否则在题型徽章旁会把整行撑开、与徽章拉出巨大间隙
    const favOverride = cssText.match(/\.question-tags \.favorite-btn\s*\{([^}]*)\}/);
    assert.ok(favOverride, '应有 .question-tags .favorite-btn 覆盖规则');
    assert.ok(/margin-left\s*:\s*0/.test(favOverride[1]), '收藏按钮在新位置必须清掉 margin-left:auto');

    // ④ 手机端:元信息另起一行(column),按钮行保持单行不换行
    // 手机端:操作条必须是**单行**(row + nowrap),元信息在左、按钮在右。
    const mediaIdx = cssText.indexOf('max-width: 768px');
    assert.ok(mediaIdx > -1, '应有手机媒体查询');
    const after = cssText.slice(mediaIdx);
    // ⚠️ 必须取"位于手机媒体查询之后"的那条规则:文件里 .quiz-controls 还有桌面版本(更靠前),
    // 直接用 after 段匹配会命中桌面规则(判据错位)。这里按出现位置过滤。
    const rulesFrom = (re) => {
        const out = [];
        let m;
        const rx = new RegExp(re.source, 'g');
        while ((m = rx.exec(cssText)) !== null) {
            if (m.index >= mediaIdx) out.push(m[1]);
        }
        return out;
    };
    const mcList = rulesFrom(/\.quiz-controls\s*\{([^}]*)\}/);
    assert.ok(mcList.length > 0, '手机端应有 .quiz-controls 规则');
    const mc = mcList[mcList.length - 1];
    assert.ok(/flex-direction\s*:\s*row/.test(mc), '手机端操作条应为单行(row)');
    assert.ok(/flex-wrap\s*:\s*nowrap/.test(mc), '手机端操作条不得换行');
    const maList = rulesFrom(/\.quiz-actions\s*\{([^}]*)\}/);
    assert.ok(maList.some(b => /flex-wrap\s*:\s*nowrap/.test(b)), '手机端按钮组不得换行');
    // 按钮必须自然宽度(收窄),不能再 flex:1 平分或 width:100% 撑满。
    // ⚠️ 覆盖必须用 #id 选择器:上方"拇指热区"规则用 id 给了 width:100%,
    // 类选择器特异性不够、会被压住(实测三键各 236px → 换行 → "只看得到一个按钮")。
    const mobileBtnRules = rulesFrom(/\.quiz-actions #(?:prev-question|submit-answer|next-question|end-quiz)-btn[^{]*\{([^}]*)\}/);
    assert.ok(mobileBtnRules.length > 0, '手机端应用 #id 选择器覆盖按钮宽度');
    assert.ok(mobileBtnRules.some(b => /width\s*:\s*auto/.test(b)), '按钮须覆盖为 width:auto');
    assert.ok(mobileBtnRules.some(b => /flex\s*:\s*0 0 auto/.test(b)), '按钮应 flex:0 0 auto');
    // 翻页键允许压缩,保证三键同处一行
    const shrink = rulesFrom(/flex\s*:\s*0 1 auto/);
    assert.ok(shrink.length > 0, '翻页键应允许压缩(flex:0 1 auto)以保持单行');
});

test('状态栏按钮:智能切题在,确认答案已删', () => {
    assert.ok(html.includes('智能切题'), '按钮文案应为「智能切题」');
    assert.ok(!html.includes('submit-answer-btn'), '「确认答案」按钮元素应已移除');
    assert.ok(!html.includes('确认答案'), '「确认答案」文案应已移除');
});

test('状态栏左区:只剩智能切题(进度/答题卡已移到题干上方)', () => {
    const i = html.indexOf('class="quiz-meta"');
    const meta = html.slice(i, html.indexOf('class="quiz-actions"'));
    assert.ok(meta.includes('class="quiz-status"'), '左区应有状态行');
    assert.ok(!meta.includes('quiz-meta-row'), '左区不应再有第二行容器 quiz-meta-row');
    assert.ok(meta.includes('auto-next-toggle'), '左区应含智能切题');
    assert.ok(!meta.includes('answer-card-open'), '答题卡入口不应再在状态栏里');
    // 👤 报的 bug:状态栏变高的根因是左区会被「确认答案」挤窄后折行。
    // 根治:左区只留一个按钮 + 给「下一题」预留固定宽度,两者都要在。
    const cssText = String(cssNoComments);
    const nextRule = cssText.match(/\.quiz-actions #next-question-btn\s*\{([^}]*)\}/);
    assert.ok(nextRule, '「下一题」应有固定宽度规则');
    assert.ok(/min-width\s*:\s*\d+px/.test(nextRule[1]),
        '「下一题」必须预留能装下「确认答案」的最小宽度,否则变文案时按钮变宽、把左区挤窄折行');
    assert.ok(/text-align\s*:\s*center/.test(nextRule[1]), '两种文案宽度一致后,文字应居中(否则「下一题」偏左)');
});

test('标签行按钮的宽窄不影响题干宽度(👤 定调)', () => {
    const cssText = String(cssNoComments);
    const tags = cssText.match(/\.question-tags\s*\{([^}]*)\}/);
    assert.ok(tags, '缺 .question-tags 规则');
    assert.ok(/display\s*:\s*flex/.test(tags[1]), '标签行应为 flex');
    assert.ok(/flex-wrap\s*:\s*nowrap/.test(tags[1]),
        '标签行必须 nowrap:折行会让它变高并把题干往下推');
    const childRule = cssText.match(/\.question-tags\s*>\s*\*\s*\{([^}]*)\}/);
    assert.ok(childRule, '标签行子项应有规则');
    assert.ok(/flex\s*:\s*0 0 auto/.test(childRule[1]),
        '标签行子项必须 flex:0 0 auto:否则按钮会互相挤、宽度随内容漂移');
    // 手机档不得把标签行改回可换行
    const mediaIdx = cssText.indexOf('max-width: 768px');
    if (mediaIdx > -1) {
        const tail = cssText.slice(mediaIdx);
        const m = tail.match(/\.question-tags[^{]*\{([^}]*)\}/);
        if (m) assert.ok(!/flex-wrap\s*:\s*wrap/.test(m[1]), '手机档不得让标签行换行');
    }
});

test('收藏按钮住在题型徽章之后、题干之前(👤 定调)', () => {
    const tagsStart = html.indexOf('class="question-tags"');
    const tagsEnd = html.indexOf('</div>', tagsStart);
    const tags = html.slice(tagsStart, tagsEnd);
    assert.ok(tags.includes('id="question-type"'), '标签行应含题型徽章');
    assert.ok(tags.includes('id="favorite-btn"'), '标签行应含收藏按钮');
    assert.ok(tags.indexOf('question-type') < tags.indexOf('favorite-btn'), '收藏应在题型徽章之后');
    // 题干仍在标签行之后(收藏不得插到题干后面去)
    assert.ok(html.indexOf('id="question-text"') > tagsEnd, '题干应在标签行之后');
});

// CSS 断言小工具。
// 三条踩过的坑(每次都是"断言读到了错的值"而不是"解析器崩了",所以格外难查):
//   ① 不能假设媒体查询都在文件后半段 —— 本文件有 20+ 个 @media,基础规则反而在后面;
//   ② 解析必须连**花括号前的选择器前缀**一起收 —— 只取 `{...}` 内部的话,选择器就丢了;
//   ③ @media 是**嵌套**的(里面有内层规则),要把内层规则也收进来并标成"媒体查询内",
//      否则要么丢掉手机档覆盖、要么把手机档的值当成桌面基准值(两种错都踩过)。
function buildIndex(cssText) {
    const index = new Map();      // 选择器 → [{body, inMedia}]
    const stack = [];
    let buf = '';
    for (let i = 0; i < cssText.length; i++) {
        const ch = cssText[i];
        if (ch === '{') {
            const sel = buf.trim();
            if (sel.startsWith('@media')) { stack.push('media'); buf = ''; continue; }
            const inMedia = stack.includes('media');
            if (!index.has(sel)) index.set(sel, []);
            // 花括号配对后回填 body
            let depth = 1, j = i + 1;
            while (j < cssText.length && depth > 0) {
                if (cssText[j] === '{') depth++;
                else if (cssText[j] === '}') depth--;
                if (depth === 0) break;
                j++;
            }
            index.get(sel).push({ body: cssText.slice(i + 1, j), inMedia });
            i = j; buf = '';
            continue;
        }
        if (ch === '}') { stack.pop(); buf = ''; continue; }
        buf += ch;
    }
    return index;
}
// 声明值:必须剥掉行尾/行内注释,否则 `padding: 0 10px;   /* … */` 整段注释都算进值里(→ NaN)
const decl = (body, prop) => {
    const raw = (body.match(new RegExp(prop + '\\s*:\\s*([^;]+)')) || [])[1];
    return raw === undefined ? undefined : raw.replace(/\/\*[\s\S]*?\*\//g, '').trim();
};
// 基准形态 = 文件里第一条(媒体查询之外的)规则 —— 后面的 @media 只算覆盖
const baseRule = (index, sel) => {
    const hits = (index.get(sel) || []).filter(h => !h.inMedia);
    return hits.length ? hits[0].body : '';
};
const baseMinHeight = (index, sel) => decl(baseRule(index, sel), 'min-height');
const baseToken = (index, name) => {
    const hits = index.get(':root') || [];
    let value;
    for (const h of hits) {
        const hit = decl(h.body, name);
        if (hit !== undefined) value = hit;
    }
    return value;
};
// 合并同名规则(后者胜,含媒体查询覆盖)—— 用于"某处声明过就算"的宽松断言
const mergedRule = (index, sel) => (index.get(sel) || []).map(h => h.body).join(';');

test('答题卡与智能切题按钮已放大到中号(👤 要求"合理放大")', () => {
    const index = buildIndex(String(cssNoComments));
    for (const sel of ['.answer-card-open', '.auto-next']) {
        const base = baseRule(index, sel);
        const raw = baseMinHeight(index, sel) || '';
        // 高度可以写成令牌:令牌本身也要 >= 26px,否则"等同"也等于一起变小
        const value = /var\(--tag-row-h\)/.test(raw) ? (baseToken(index, '--tag-row-h') || '') : raw;
        const minH = parseInt(value, 10);
        assert.ok(minH >= 26, `${sel} 高度至少 26px(迷你版点不准),实际 ${raw} → ${value}`);
        const font = parseFloat(decl(base, 'font-size') || '');   // ⚠️ 带单位,必须 parseFloat 不能 Number
        assert.ok(font >= 12, `${sel} 基准字号至少 12px(不得靠继承父级的 16px),实际 ${decl(base, 'font-size')}`);
        assert.ok(/(^|[;\s])border\s*:/.test(base), `${sel} 必须有边框(否则看不出可点)`);
    }
});

test('标签行三件(答题卡/题型/收藏)必须等高(👤 要求"统一高度")', () => {
    // 事故:三件各自硬编码高度 → 28 / 20 / 22,排一行高低参差,手机档还漏改一个。
    // 根治:高度只从单一令牌 --tag-row-h 取 —— 手机档只改令牌,三件一起变。
    const cssText = String(cssNoComments);
    const index = buildIndex(cssText);
    // ⚠️ 用**基础选择器**取基准值:三件的基础规则分别是 .answer-card-open / .question-type-badge /
    //    .question-tags .favorite-btn(收藏是复合的,因为它只在标签行里用)。手机档的覆盖写在
    //    `.question-tags ...` 复合选择器里,解析时会被媒体查询过滤掉,不会污染基准值。
    const sels = {
        '答题卡': '.answer-card-open',
        '题型徽章': '.question-type-badge',
        '收藏': '.question-tags .favorite-btn',
    };
    for (const [name, sel] of Object.entries(sels)) {
        const v = baseMinHeight(index, sel);
        assert.ok(v, `${name} 缺 min-height(${sel})`);
        assert.ok(/var\(--tag-row-h\)/.test(v),
            `${name} 的 min-height 必须取自 --tag-row-h,不得写死(实际 ${v}):各自写死就会重新漂移成不等高`);
    }
    // 令牌:基准 28px,手机档只覆盖这一个值
    const base = Number((baseToken(index, '--tag-row-h') || '').replace('px', ''));
    assert.ok(base >= 26, `--tag-row-h 基准值至少 26px,实际 ${baseToken(index, '--tag-row-h')}`);
    const mediaIdx = cssText.indexOf('max-width: 768px');
    assert.ok(/--tag-row-h\s*:\s*\d+px/.test(cssText.slice(mediaIdx)),
        '手机档应只改 --tag-row-h 一个值(而不是挨个改三件)');
    // 三件水平内边距一致,宽度节奏才齐
    const pads = Object.values(sels).map(sel => decl(mergedRule(index, sel), 'padding'));
    assert.ok(pads.every(p => p), '三件都应有 padding:' + JSON.stringify(pads));
    assert.strictEqual(new Set(pads).size, 1, '三件内边距应一致(否则一行里宽度节奏不齐):' + JSON.stringify(pads));
    // 字号也要一致,否则三件里的文字视觉大小不齐
    const fonts = Object.values(sels).map(sel => decl(mergedRule(index, sel), 'font-size'));
    assert.ok(fonts.every(f => f && parseFloat(f) >= 12), '三件字号都应 >= 12px:' + JSON.stringify(fonts));
    assert.strictEqual(new Set(fonts).size, 1, '三件字号应一致(等高之外还要等视觉重量):' + JSON.stringify(fonts));
});

test('模块引用的 DOM id 必须真实存在于 index.html(防"死渲染路径"复活)', () => {
    // 🚨 这条守卫来自一次真实事故(2026-09-11):
    // errorbook.js / favorites.js 里各留着一段"独立列表渲染",它们靠 `if (!el) return` 自我屏蔽
    // (#errors-list / #favorites-list 早已不在 index.html)。**但它们仍在被测试覆盖** ——
    // 因为 vm 测试桩的 getElementById 会自动建出任何被请求的元素,守卫形同虚设。
    // 结果是"测试绿着、代码死了",而且那两段还是与新规范相反的旧卡片设计。
    // 判据:src 里以 getElementById 取的常量 id,必须都能在 index.html 里找到。
    const srcDir = path.join(root, 'src');
    const htmlIds = new Set([...html.matchAll(/id="([\w-]+)"/g)].map(m => m[1]));
    const missing = [];
    for (const f of readdirSync(srcDir).filter(n => n.endsWith('.js'))) {
        const text = readFileSync(path.join(srcDir, f), 'utf8');
        for (const m of text.matchAll(/document\.getElementById\('([\w-]+)'\)/g)) {
            if (!htmlIds.has(m[1])) missing.push(`${f}: #${m[1]}`);
        }
    }
    assert.deepStrictEqual(missing, [],
        '这些 id 在 index.html 里不存在,对应的渲染代码永远不会执行(要么补回 HTML,要么删掉代码):\n  '
        + missing.join('\n  '));
});

test('错题/收藏的渲染只有一处(库卡内嵌面板),不得再有独立列表渲染', () => {
    // 同上:同一份 UI 只留一条渲染路径,避免"两条路径各自漂移"或被死代码掩盖
    const bank = readFileSync(path.join(root, 'src', 'bank.js'), 'utf8');
    assert.ok(/export function renderErrorsForBank/.test(bank), '库卡错题面板渲染应在 bank.js');
    assert.ok(/export function renderFavoritesForBank/.test(bank), '库卡收藏面板渲染应在 bank.js');
    for (const f of ['errorbook.js', 'favorites.js']) {
        const text = readFileSync(path.join(root, 'src', f), 'utf8');
        assert.ok(!/createElement\(/.test(text),
            `${f} 不应再有 DOM 渲染代码(渲染已并入库卡内嵌面板)`);
        assert.ok(!/innerHTML/.test(text), `${f} 不应再写 innerHTML`);
    }
});

test('配色卡片的脚部按钮:展开态必须实心主色 + 白字(👤 反馈:点开后字和背景分不开)', () => {
    // 根因:为"适配任意底色"给配色卡片的脚部键加了半透明白底,但那条覆盖**连 .open 一起盖了** ——
    // 展开态本来要变成实心主色 + 白字,结果成了"白字压在半透明白底上",浅色卡片上完全看不见。
    const lightAt = cssNoComments.indexOf('.bank-item[data-color] .bank-card-foot .foot-toggle');
    assert.ok(lightAt > -1, '应有"配色卡片脚部键"的覆盖规则');
    for (const m of cssNoComments.matchAll(/\n\.bank-item\[data-color\] \.bank-card-foot \.foot-toggle([^{]*)\{/g)) {
        assert.ok(/:not\(\.open\)/.test(m[1]), '这条覆盖必须带 :not(.open),否则会盖掉展开态的主色底');
    }
    for (const m of cssNoComments.matchAll(/\nhtml\[data-theme="dark"\] \.bank-item\[data-color\] \.bank-card-foot \.foot-toggle([^{]*)\{/g)) {
        assert.ok(/:not\(\.open\)/.test(m[1]), '暗色那条同样要带 :not(.open)');
    }
    // 展开态:实心主色 + 白字(含 <b> 里的计数)
    const openRule = cssNoComments.match(/\n\.bank-card-foot \.foot-toggle\.open \{([^}]*)\}/)[1];
    assert.ok(/background\s*:\s*var\(--c-primary\)/.test(openRule), '展开态应是实心主色');
    assert.ok(/color\s*:\s*#fff/.test(openRule), '展开态应是白字');
    assert.ok(/color\s*:\s*#fff/.test(cssNoComments.match(/\n\.bank-card-foot \.foot-toggle\.open b \{([^}]*)\}/)[1]),
        '展开态里的计数 <b> 也要白字');
    // 未展开态:配色卡片用半透明白底(适配任意底色),灰卡用面板底色
    const base = cssNoComments.match(/\n\.bank-card-foot \.foot-toggle \{([^}]*)\}/)[1];
    assert.ok(/background\s*:\s*var\(--c-panel-bg\)/.test(base), '默认(灰卡)用面板底色');
});

test('题库卡不得再出现左侧主色装饰条(👤 2026-09-11 改成配色底)', () => {
    // 历史:库卡曾是 `border-left: 4px solid var(--c-primary)`,👤 要求改成"低饱和彩色底+框"。
    // 这条守卫防止旧样式被顺手恢复 —— 那种 4px 主色竖条是上一代的视觉语言。
    const rule = cssNoComments.match(/\.bank-item\s*\{([^}]*)\}/);
    assert.ok(rule, '应有 .bank-item 规则');
    assert.ok(!/border-left\s*:/.test(rule[1]), '.bank-item 不得再有 border-left 装饰条');
    assert.ok(/border\s*:\s*1px\s*solid/.test(rule[1]), '应改为 1px 整圈边框');
    // 配色必须走 data-color + 成对令牌(而不是内联样式或硬编码颜色)
    for (const c of ['blue', 'green', 'red', 'amber', 'teal']) {
        assert.ok(new RegExp(`\\.bank-item\\[data-color="${c}"\\]`).test(cssNoComments),
            `缺 .bank-item[data-color="${c}"] 配色规则`);
    }
});

// ==================== 题库编辑器重构(👤 2026-09-11:手机优先)====================
test('编辑器:题目级操作与题库级操作彻底分开', () => {
    const modal = html.slice(html.indexOf('id="edit-bank-modal"'), html.indexOf('id="question-card-modal"'));
    assert.ok(!modal.includes('editor-foot'), '底栏应已取消');
    const toolbar = modal.slice(modal.indexOf('editor-toolbar'), modal.indexOf('editor-list-block'));
    assert.ok(toolbar.includes('editor-filter-toggle'), '「筛选」应在列表上方的工具行里');
    // 去重从「题库设置」搬到了列表上方(👤 要求:它作用于整库,但要在改题时随手可用)
    assert.ok(toolbar.includes('editor-dedup-btn'), '「去重」应在工具行里');
    // 👤 要求删掉工具行里的"共 N 题":标签页的「编辑题目 N」已经写着同一个数(同一屏两处计数是噪音)
    assert.ok(!toolbar.includes('editor-list-count'), '工具行里不该再有"共 N 题"计数');
    // (这里的 bank 源码要单独读一次:本用例后半段才声明 const bank,提前引用会 TDZ 报错)
    const bankSrc = readFileSync(path.join(root, 'src', 'bank.js'), 'utf8');
    assert.ok(!html.includes('editor-list-count') && !/editorListCount/.test(bankSrc), '那个计数元素与代码应一并删除');
    // 计数没有丢:筛选时标签页角标会变成 "3/28"
    assert.ok(/visible\.length\}\/\$\{questions\.length\}/.test(bankSrc), '标签页角标应在筛选时显示"筛出/总数"');
    // 👤 要求:选中后的编辑栏放到筛选/去重**后面**(同一行,不再单独占一条底栏)
    assert.ok(toolbar.includes('editor-bulk-bar'), '批量栏应在工具行里');
    assert.ok(toolbar.indexOf('editor-bulk-bar') > toolbar.indexOf('editor-dedup-btn'), '批量栏应排在筛选/去重之后');
    assert.ok(!modal.includes('bank-dedup-btn'), '「去重」不应再留在题库设置里');
    // 新增题目不是工具行按钮,而是**列表末尾的加号**(👤 要求)
    assert.ok(!toolbar.includes('editor-add-btn'), '「新增题目」按钮应已从工具行移除');
    const bank = readFileSync(path.join(root, 'src', 'bank.js'), 'utf8');
    assert.ok(/editor-list-add/.test(bank), '列表末尾应渲染一个加号按钮');
    assert.ok(/editorQuestionList.appendChild\(addRow\)/.test(bank), '加号必须追加在列表最后');
    // 删除/编辑**只在选中之后**出现(👤 要求):它们在批量栏里,而批量栏整条由 .hidden 控制显隐
    for (const id of ['editor-bulk-delete', 'editor-bulk-all', 'editor-bulk-clear']) {
        assert.ok(toolbar.includes(id), `${id} 应随批量栏出现在工具行里`);
    }
    // 「✎ 编辑」按钮已去掉:点题目本身就翻开编辑卡片(👤 补充逻辑),它是同一个动作的第二个入口
    assert.ok(!toolbar.includes('editor-bulk-edit'), '批量栏里不该再有「编辑」键');
    assert.ok(/editorBulkBar\.classList\.toggle\('hidden', selCount === 0\)/.test(bankSrc),
        '批量栏整条"选中才出现" —— 没选中时这一行一个多余按钮都没有');
    assert.ok(!modal.includes('editor-delete-btn'), '「删除本题」按钮应已移除(改用批量删除)');
    // 题库级动作仍在独立的「题库设置」标签页里,不与单题编辑混排
    const bankPanelStart = modal.indexOf('editor-bank-panel');
    const bankPanel = modal.slice(bankPanelStart, modal.indexOf('</section>', bankPanelStart));
    for (const id of ['bank-rename-btn', 'bank-delete-btn', 'bank-color-picker']) {
        assert.ok(bankPanel.includes(id), `${id} 应在「题库设置」标签页内`);
    }
    const qPanelStart = modal.indexOf('editor-question-panel');
    const qPanel = modal.slice(qPanelStart, modal.indexOf('editor-bank-panel'));
    assert.ok(!qPanel.includes('bank-delete-btn'), '「删除题库」不得出现在题目编辑页(防误点)');
    // 👤 要求删掉「当前题库:xxx」那行:库名在编辑器标题栏已经写着,同一屏再挂一遍是噪音
    assert.ok(!html.includes('editor-bank-name-current'), '「当前题库:xxx」那行应已从 HTML 删除');
    assert.ok(!bankPanel.includes('当前题库'), '题库设置页不该再有「当前题库」字样');
});

test('题库设置:按作用对象分块,「删除题库」独占最底部的危险区(👤 2026-09-12 重新规划)', () => {
    const modal = html.slice(html.indexOf('id="edit-bank-modal"'), html.indexOf('id="question-card-modal"'));
    const panelStart = modal.indexOf('editor-bank-panel');
    const panel = modal.slice(panelStart, modal.indexOf('</section>', panelStart));
    // ① 结构 = 若干块,每块 = 小标题 + 该块自己的控件;标题连顺序就是这份信息架构。
    //    ⚠️ 位置一律取**标题标签**的下标,不能拿关键词 indexOf 去搜 —— 说明性注释里也会提到
    //       「危险操作」,搜串会得到"注释的位置"(踩过)。
    const marks = [...panel.matchAll(/<h4 class="admin-block-title">([^<]+)<\/h4>/g)]
        .map(m => ({ k: m[1], i: m.index }));
    const order = marks.concat([{ k: '版本记录', i: panel.indexOf('editor-versions-host') }])
        .sort((a, b) => a.i - b.i).map(x => x.k);
    assert.deepStrictEqual(order, ['卡片配色', '本库', '错题本', '版本记录', '危险操作'],
        '块的顺序应为 配色 → 本库 → 错题本 → 版本记录 → 危险操作');
    assert.ok(marks.length >= 4, '设置页至少要分四块');
    // 「导出全部」已搬到题库页(👤 要求):设置页里不该再有一整块只为它存在
    assert.ok(!panel.includes('export-all-btn'), '「导出全部」不该还留在题库设置里');
    for (const m of marks) assert.ok(m.i > -1 && m.k.trim(), '每块都要有小标题');

    // ② 版本记录宿主夹在「错题本」与「危险操作」之间(标题由 JS 渲染,故不在 marks 里)
    const hostAt = panel.indexOf('editor-versions-host');
    assert.ok(hostAt > -1 && hostAt < panel.indexOf('admin-danger-block'), '版本记录块应在危险区**之前**');

    // ③ 「删除题库」独占危险区,与任何日常动作都不在同一块里(👤 反复强调防误点)
    const dangerAt = panel.indexOf('admin-danger-block');
    assert.ok(dangerAt > -1, '应有危险区');
    const danger = panel.slice(dangerAt);
    assert.ok(danger.includes('bank-delete-btn'), '「删除题库」应在危险区里');
    assert.ok(!/bank-rename-btn|bank-export-btn|export-all-btn|clear-errors-btn|bank-color-picker/.test(danger),
        '危险区里不得混进日常动作');
    assert.ok(!panel.slice(0, dangerAt).includes('bank-delete-btn'),
        '日常动作块里不得出现「删除题库」');
    assert.ok(!/bank-delete-btn/.test(panel.slice(0, panel.lastIndexOf('admin-block-title'))), '危险区必须是最后一块');

    // ④ 设置页按钮统一用 .admin-btn(尺寸/形状由设置页自己定,不再借主操作区的 .action-btn)
    for (const [id, isDanger] of [['bank-rename-btn', false], ['bank-export-btn', false],
        ['clear-errors-btn', true], ['bank-delete-btn', true]]) {
        const m = panel.match(new RegExp(`id="${id}"[^>]*class="([^"]*)"`));
        assert.ok(m, `${id} 应在设置页里`);
        assert.ok(m[1].split(/\s+/).includes('admin-btn'), `${id} 应用 .admin-btn`);
        assert.strictEqual(m[1].split(/\s+/).includes('danger'), isDanger, `${id} 的危险态标记不对`);
    }
    assert.ok(!/action-btn/.test(panel), '设置页不该再混用 .action-btn(尺寸散在两套样式里最难维护)');

    // ⑤ 版本记录挂在宿主里,而不是直接挂在容器末尾 —— 否则它会被 appendChild 甩到危险区下面
    const bank = readFileSync(path.join(root, 'src', 'bank.js'), 'utf8');
    assert.ok(/editor-versions-host/.test(bank), '版本面板应挂进 #editor-versions-host');
    assert.ok(!/bankAdmin\.appendChild\(verPanel\)/.test(bank), '不该再直接挂在 #editor-bank-admin 末尾');
    assert.ok(panel.indexOf('editor-versions-host') < dangerAt, '版本记录块应在危险区**之前**');

    // ⑥ 样式:块/标题/动作行/按钮四件套齐备;桌面 40px、手机 44px
    for (const sel of ['.admin-block', '.admin-block-title', '.admin-btn-row', '.admin-btn']) {
        assert.ok(cssNoComments.includes(sel), `缺 ${sel} 样式`);
    }
    const row = cssNoComments.match(/\.admin-btn-row\s*\{([^}]*)\}/)[1];
    assert.ok(/display\s*:\s*flex/.test(row) && /flex-wrap\s*:\s*wrap/.test(row),
        '动作行应是可换行的 flex(装不下就换行,不做横向滚动)');
    const btn = cssNoComments.match(/\.admin-btn\s*\{([^}]*)\}/)[1];
    assert.ok(/min-height\s*:\s*40px/.test(btn), '桌面档设置按钮 40px');
    assert.ok(/border-radius/.test(btn) && /border\s*:\s*1px/.test(btn), '设置按钮为描边圆角方框');
    // 桌面档按钮**不撑满整行**:按内容宽 + 统一下限(否则单颗按钮会拉成 700px 宽的"主操作")
    assert.ok(/flex\s*:\s*0 0 auto/.test(btn) && /min-width\s*:\s*150px/.test(btn),
        '桌面档按钮应按内容宽 + 统一下限,不撑满整行');
    const dangerBtn = cssNoComments.match(/\.admin-btn\.danger\s*\{([^}]*)\}/)[1];
    assert.ok(/--c-danger/.test(dangerBtn), '危险按钮要用危险色令牌');
    // 手机档:要注意样式表里有多处 @media(max-width:768px),而设置页的规则在文件后段 ——
    // 只取"第一处媒体查询之后的片段"再 match 会匹到桌面档那条(踩过),故对所有同名规则求存在性。
    const rules = (re) => [...String(cssNoComments).matchAll(re)].map(m => m[1]);
    assert.ok(rules(/\.admin-btn\s*\{([^}]*)\}/g).some(b => /min-height\s*:\s*44px/.test(b)),
        '手机档设置按钮应 ≥44px');
    assert.ok(rules(/\.admin-btn\s*\{([^}]*)\}/g).some(b => /flex\s*:\s*1 1/.test(b)),
        '手机档按钮应改为填满整行(拇指友好)');
    assert.ok(rules(/\.admin-field select\s*\{([^}]*)\}/g).some(b => /min-height\s*:\s*44px[\s\S]*font-size\s*:\s*16px/.test(b)),
        '手机档下拉应 44px 且字号 ≥16px(防 iOS 聚焦缩放)');
});

test('工具条吸顶:负向抵消滚动容器的内边距(👤 反馈:悬浮时上面有个缝)', () => {
    // 缝的来源:滚动容器有上内边距,`top:0` 只贴到内容区顶部,那 12px 会把滚过去的列表透出来。
    // 修法 = 负 top + 负横向边距 + 同值自身内边距(底色铺满整条),且内边距必须**同源**(变量)。
    const bodyRules = [...cssNoComments.matchAll(/\.editor-body\s*\{([^}]*)\}/g)].map(m => m[1]);
    const body = bodyRules.find(r => /--editor-pad-top/.test(r));
    assert.ok(body, '滚动容器应把内边距提成变量(--editor-pad-top / --editor-pad-x)');
    assert.ok(/--editor-pad-x\s*:/.test(body), '横向内边距也要提成变量(否则左右也露缝)');
    assert.ok(/padding\s*:\s*var\(--editor-pad-top\)\s+var\(--editor-pad-x\)/.test(body),
        '滚动容器的 padding 必须引用这两个变量');

    const wrap = cssNoComments.match(/\n\.editor-toolbar-wrap\s*\{([^}]*)\}/)[1];
    assert.ok(/position\s*:\s*sticky/.test(wrap), '工具条外层应吸顶');
    assert.ok(/top\s*:\s*calc\(-1 \* var\(--editor-pad-top/.test(wrap),
        'top 要负向抵消上内边距 —— 否则滚动区顶部露出一条缝(👤 反馈)');
    assert.ok(/margin\s*:[^;]*calc\(-1 \* var\(--editor-pad-top[^;]*calc\(-1 \* var\(--editor-pad-x/.test(wrap),
        'margin 要同时负向抵消上下左右(用变量),否则左右也露缝');
    assert.ok(/background\s*:/.test(wrap), '吸顶条要有底色,否则列表从它下面透出来');
    assert.ok(/z-index\s*:/.test(wrap), '吸顶条要压在列表之上');

    // 手机档的横向内边距必须同步进变量(两处各写各的数字,缝就回来了)
    assert.ok(/\.editor-body\s*\{\s*--editor-pad-x\s*:\s*12px/.test(cssNoComments),
        '手机档的横向内边距也要写进变量');
});

test('编辑器:题目页的顺序 = 工具行 → 筛选面板 → 列表 → 批量栏(👤 2026-09-12 重构)', () => {
    const modal = html.slice(html.indexOf('id="edit-bank-modal"'), html.indexOf('id="question-card-modal"'));
    const order = ['editor-toolbar', 'editor-filter-panel', 'editor-list-block', 'editor-empty']
        .map(k => modal.indexOf(k));
    assert.ok(order.every(i => i > -1), '四个区块都要存在:' + JSON.stringify(order));
    assert.deepStrictEqual([...order].sort((a, b) => a - b), order,
        '顺序必须是:工具行(含批量栏)→ 筛选面板 → 列表 → 空态');
    // 题目表单**不在**题目页里了:整块搬进编辑卡片(列表只负责选,编辑只发生在卡片里)
    assert.ok(!modal.includes('id="editor-form"'), '表单不该还留在题库编辑器里');
    assert.ok(modal.indexOf('editor-bulk-bar') < modal.indexOf('editor-list-block'),
        '批量栏在**列表之前**(它就在工具行里,不再是一条占高度的底栏)');
    // 题号导航行与底栏都已取消(👤 要求):列表本身就是导航
    assert.ok(!modal.includes('editor-nav-row'), '「上一题/下一题」导航行应已取消');
    assert.ok(!modal.includes('editor-foot'), '底栏应已取消');
    // 标题栏:库名居中 + 右上角关闭,不放其他文字
    const head = modal.slice(modal.indexOf('class="editor-head"'), modal.indexOf('class="editor-tabs"'));
    assert.ok(head.includes('edit-bank-title'), '标题栏应有库名');
    assert.ok(head.includes('editor-head-close-btn'), '标题栏应有右上角关闭');
    assert.ok(!head.includes('editor-head-position'), '标题栏不该再有进度等多余文字');
    // 库名要**真正居中**:靠 flex 的"左右元素等宽"做不到(关闭键只有一个),
    // 故标题占满整宽居中、关闭键绝对定位。这里从 CSS 侧钉死这个结构。
    const headCss = cssNoComments.match(/\.editor-head\s*\{([^}]*)\}/)[1];
    assert.ok(/position\s*:\s*relative/.test(headCss), '标题栏应为定位参照(关闭键绝对定位用)');
    const h3Css = cssNoComments.match(/\.editor-head h3\s*\{([^}]*)\}/)[1];
    assert.ok(/justify-content\s*:\s*center/.test(h3Css), '库名应占满整宽居中');
    const closeCss = cssNoComments.match(/\.editor-close-x\s*\{([^}]*)\}/)[1];
    assert.ok(/position\s*:\s*absolute/.test(closeCss), '关闭键应绝对定位在右上角');
});

test('编辑器:两个标签页的显隐由 CSS 的 data-tab 控制', () => {
    const cssText = String(cssNoComments);
    assert.ok(/\.editor-body\[data-tab="question"\]/.test(cssText), '应有"题目页"显隐规则');
    assert.ok(/\.editor-body\[data-tab="bank"\]/.test(cssText), '应有"设置页"显隐规则');
    assert.ok(/\.editor-body > \.editor-panel \{ display: none/.test(cssText),
        '默认应隐藏所有面板,由标签页决定显示哪一个');
    // 选中态用下划线(不能只靠颜色区分)
    assert.ok(/\.editor-tab:has\(input:checked\)/.test(cssText), '标签选中态应由 :has(input:checked) 表达');
    assert.ok(/border-bottom-color/.test(cssText.match(/\.editor-tab:has\(input:checked\)\s*\{([^}]*)\}/)[1]),
        '选中标签应有下划线标记');
    // 头部收矮(👤 要求省空间):不再有 12px 上下内边距那种大块头
    const head = cssNoComments.match(/\.editor-head\s*\{([^}]*)\}/)[1];
    assert.ok(/min-height\s*:\s*40px/.test(head), '头部内容应为 40px(+ 上下 padding = 整条 44)');
    assert.ok(!/padding\s*:\s*12px 16px/.test(head), '头部不该还留 12px 的上下内边距');
});

test('编辑器:列表 = 复选框 + 序号 + 题干 + 徽章;动作只在选中后出现(👤 2026-09-12)', () => {
    const bank = readFileSync(path.join(root, 'src', 'bank.js'), 'utf8');
    // ① 每行一个**真正的** checkbox(👤 要求:要有复选框)
    assert.ok(/box\.type = 'checkbox'/.test(bank), '列表行应有 checkbox 输入');
    assert.ok(/q-row-check/.test(bank), '复选框要有自己的类(手机档要放大它)');
    // ② **只有复选框能选中**(👤 要求):行是普通 div,行上不挂任何监听
    const rowRegion = bank.slice(bank.indexOf('// 行 = 普通容器'), bank.indexOf('editorQuestionList.appendChild(row)'));
    assert.ok(/const row = document\.createElement\('div'\)/.test(rowRegion), '行应是普通 div(不是 label)');
    // 行**要**绑 click,但只用来"选中这道题并打开编辑卡片",绝不是"勾选"(👤 补充逻辑)
    assert.ok(/box\.addEventListener\('change'/.test(rowRegion), '选中入口只有复选框的 change');
    // ③ 徽章:题型 / 待补 / 缺解析 / AI / 历史(它同时是筛选面板的视觉词典)
    assert.ok(/function rowBadges/.test(bank), '应有行内徽章渲染');
    for (const k of ['q-row-badges', 'q-badge']) assert.ok(bank.includes(k), `缺 ${k} 样式类`);
    // ④ 批量栏:选中才出现;删除有二次确认;删 ≥2 道先存一版
    assert.ok(/editorBulkBar\.classList\.toggle\('hidden', selCount === 0\)/.test(bank),
        '批量栏应"选中才出现"');
    const bulkDel = bank.slice(bank.indexOf('export function editorBulkDelete'));
    assert.ok(/confirm\(/.test(bulkDel.slice(0, 600)), '批量删除必须二次确认');
    assert.ok(/pushBankVersion\(state\.editBankName, '批量删除前'/.test(bulkDel.slice(0, 900)),
        '删 ≥2 道要先存一版(可回退)');
    assert.ok(/targets\.length >= 2/.test(bulkDel.slice(0, 900)), '单删不占版本槽(每库只有 3 个)');
    // ⑤ 单击 = 高亮(只换高亮,不重画!);双击 = 选中并翻开编辑卡片
    assert.ok(/row\.addEventListener\('click'/.test(rowRegion), '行要能单击');
    assert.ok(/row\.addEventListener\('dblclick'/.test(rowRegion), '行要能双击');
    const clickAt = rowRegion.indexOf("row.addEventListener('click'");
    const dblAt = rowRegion.indexOf("row.addEventListener('dblclick'");
    const clickBody = rowRegion.slice(clickAt, dblAt);
    assert.ok(/highlightCurrentRow\(\)/.test(clickBody), '单击应只换高亮');
    assert.ok(!/openQuestionCard/.test(clickBody), '单击**不该**开卡片(那是双击的事)');
    assert.ok(/openQuestionCard\(idx\)/.test(rowRegion.slice(dblAt)), '双击才翻开编辑卡片');
    // ⚠️ 单击里严禁重画列表:节点被换掉,第二下就落到新节点上,dblclick 永远不触发(实测踩过)
    assert.ok(!/renderBankEditor\(\)/.test(clickBody), '单击不许重画列表(否则双击失效)');
    assert.ok(/isRowCheckboxEvent\(e\)/.test(clickBody) && /isRowCheckboxEvent\(e\)/.test(rowRegion.slice(dblAt)),
        '点复选框不算"点题目"(否则勾选会顺手换高亮/掀卡片)');
    // ⑥ 「只看勾选」= 复选框喂给筛选器的范围条件
    assert.ok(/FILTER_GROUPS = \['type', 'status', 'ai', 'marks', 'scope'\]/.test(bank), '筛选分组应含 scope');
    assert.ok(/focusChecked/.test(bank) && /isSelected\(q\)/.test(bank), 'visibleQuestions 应按"是否勾选"再收一遍');
    assert.ok(/afterFilterChange\(group === 'scope'\)/.test(bank), '切「只看勾选」时不许清空勾选集(它就是这条条件的输入)');
    // ⑦ 手机档:复选框与批量按钮都要够得着
    const media = cssNoComments.slice(cssNoComments.indexOf('max-width: 768px'));
    assert.ok(/\.q-row-check/.test(media), '手机档应放大行内复选框');
    assert.ok(/\.bulk-btn/.test(media), '手机档应放大批量栏按钮');
    assert.ok(/\.card-foot \.action-btn/.test(media), '手机档应放大编辑卡片底部的保存/取消');
    assert.ok(!/\.editor-list-del/.test(bank), '旧的行内 ✕ 删除应已删除(它已并入批量删除)');
});

test('编辑器:六个字段整块搬进编辑卡片(题干/题型/答案/选项/解释/解析)', () => {
    const cardStart = html.indexOf('id="question-card-modal"');
    assert.ok(cardStart > -1, '应有编辑卡片 #question-card-modal');
    const card = html.slice(cardStart, html.indexOf('<!-- 答题卡抽屉'));
    const form = card.slice(card.indexOf('id="editor-form"'), card.indexOf('class="card-foot"'));
    for (const id of ['editor-stem', 'editor-type', 'editor-answer', 'editor-options', 'editor-explanation', 'editor-analysis']) {
        assert.ok(form.includes(id), `${id} 应在编辑卡片里`);
    }
    // 全部展开:表单里不得再有任何 details/summary 折叠
    assert.ok(!/<details/.test(form), '表单里不得再有折叠(details)');
    assert.ok(!card.includes('editor-more'), '「题目解释/解析」的折叠壳应已移除');
    // 卡片自己的三段:头部(题号 + 上/下一题 + ✕)/ 主体 / 底部(取消 + 保存)
    const head = card.slice(card.indexOf('class="card-head"'), card.indexOf('class="card-body"'));
    for (const id of ['question-card-prev', 'question-card-next', 'question-card-title', 'question-card-close']) {
        assert.ok(head.includes(id), `卡片头部应有 ${id}`);
    }
    const foot = card.slice(card.indexOf('class="card-foot"'));
    assert.ok(foot.includes('editor-save-btn') && foot.includes('question-card-cancel'), '底部应有保存与取消');
    // 卡片是**二级弹窗**:它从题库编辑器里打开,必须压在编辑器之上(DESIGN §3.8 的 1100 层)
    assert.ok(/question-card-modal/.test(html) && /\n\.edit-card\s*\{/.test(cssNoComments), '卡片要有自己的样式');
    // ⚠️ 容器类名不能叫 .question-card —— 那是错题/收藏卡的类,自带 4px 红条,借来就会在卡片左边长出一道红条
    assert.ok(!/modal-content question-card/.test(html), '编辑卡片容器不得借用 .question-card 这个类名');
    const cardZ = cssNoComments.match(/#question-card-modal\s*\{[^}]*z-index\s*:\s*(\d+)/);
    assert.ok(cardZ && Number(cardZ[1]) >= 1100, '编辑卡片应为二级弹窗(z-index ≥ 1100)');
});

test('编辑器:滚动只发生在主体,头部与底部不被滚走', () => {
    // 手机上的编辑器是"整屏 + 底部常驻动作栏";若 .modal 自己滚(overflow-y:auto),
    // sticky/flex 定位都靠不住 —— 故编辑器弹窗必须 overflow:hidden,由 .editor-body 滚。
    const modalRule = cssNoComments.match(/\.modal#edit-bank-modal\s*\{([^}]*)\}/);
    assert.ok(modalRule, '应有 .modal#edit-bank-modal 规则');
    assert.ok(/overflow\s*:\s*hidden/.test(modalRule[1]), '编辑器弹窗自身不得滚动(否则底部栏会被滚走)');
    const contentRule = cssNoComments.match(/\.modal#edit-bank-modal \.modal-content\s*\{([^}]*)\}/);
    assert.ok(contentRule && /flex-direction\s*:\s*column/.test(contentRule[1]), '弹窗内容应为纵向 flex 三段布局');
    // ⚠️ 取**所有** .editor-body 规则再合并:同一选择器可能出现多条,只看第一条会误判(踩过)
    const bodyRules = [...cssNoComments.matchAll(/\.editor-body\s*\{([^}]*)\}/g)].map(m => m[1]).join(';');
    assert.ok(/overflow-y\s*:\s*auto/.test(bodyRules), '滚动应发生在 .editor-body');
    // 同一条规则里要同时给出"可滚动 + 可压缩",否则 flex 子项不会滚
    assert.ok(/min-height\s*:\s*0/.test(bodyRules) && /flex\s*:\s*1 1 auto/.test(bodyRules),
        '.editor-body 需要 flex:1 1 auto + min-height:0 才能真正滚动');
    // 底栏已取消 → 不再断言它的样式;但要保证头部与标签条不被压缩
    const headRule = cssNoComments.match(/\.editor-head\s*\{([^}]*)\}/);
    assert.ok(headRule && /flex\s*:\s*0 0 auto/.test(headRule[1]), '头部不得被压缩');
});

test('编辑器:手机上可点元素达标(≥44px 触达)', () => {
    const media = cssNoComments.slice(cssNoComments.indexOf('max-width: 768px'));
    const block = media.slice(media.indexOf('.editor-body'));
    for (const sel of ['.editor-option-actions .action-btn', '.editor-nav-row .action-btn',
        '.editor-foot .action-btn', '.editor-head-actions .action-btn', '.admin-btn',
        '.bank-color-swatch', '.editor-close-x']) {
        assert.ok(block.includes(sel), `手机档缺 ${sel} 的触达规则`);
    }
    assert.ok(/min-height\s*:\s*44px/.test(block), '手机档应把触达下限设为 44px');
    // iOS 聚焦自动放大页面的经典原因:输入框字号 <16px
    assert.ok(/font-size\s*:\s*16px/.test(block), '手机档输入框字号应 ≥16px');
    // 复选框单点太苛刻 → label 整行可点
    assert.ok(/#edit-bank-modal \.inline-label/.test(block), '复选框应让 label 整行可点');
});

test('编辑卡片表单:文案在输入框左边,且判断题为 A/B 口径(👤 定调)', () => {
    const card = html.slice(html.indexOf('id="question-card-modal"'), html.indexOf('<!-- 答题卡抽屉'));
    const form = card.slice(card.indexOf('id="editor-form"'), card.indexOf('class="card-foot"'));
    // ① 每个字段 = 「左文案 + 右字段容器」
    const groups = form.match(/<div class="form-group editor-field/g) || [];
    assert.ok(groups.length >= 4, `应至少有 4 个字段组,实际 ${groups.length}`);
    const bodies = form.match(/editor-field-body/g) || [];
    assert.ok(bodies.length >= groups.length, '每个字段都要有右字段容器 editor-field-body');
    // ② 布局靠 CSS 的 flex 实现(标签定宽 → 文案在左)
    const fieldCss = cssNoComments.match(/\.editor-field\s*\{([^}]*)\}/)[1];
    assert.ok(/display\s*:\s*flex/.test(fieldCss), '字段应为 flex(左文案 + 右字段)');
    const labelCss = cssNoComments.match(/\.editor-field > label,\s*\n?\.editor-field > \.form-label\s*\{([^}]*)\}/)[1];
    assert.ok(/width\s*:/.test(labelCss), '左文案应定宽,才能多行对齐');
    // ③ 「选项」文案已删(👤 要求)
    assert.ok(!/>选项</.test(form), '「选项」标题文案应已删除');
    // ④ 判断题按 A/B 口径写,不再写「对/错」
    const note = form.match(/class="meta-note">([^<]+)</)[1];
    assert.ok(/ABD/.test(note), '多选题写法应写明(如 ABD)');
    assert.ok(/A=正确/.test(note) && /B=错误/.test(note),
        '判断题应写明 A=正确、B=错误,实际:' + note);
    assert.ok(!/判断题填「对」/.test(note), '不该再让用户填「对/错」');
});

test('版本记录住在「题库设置」里,且每条都能删(👤 2026-09-11)', () => {
    const bank = readFileSync(path.join(root, 'src', 'bank.js'), 'utf8');
    // ① 库卡手风琴里不得再有版本区(它已移到题库设置)
    const cardRegion = bank.slice(bank.indexOf('export function updateBanksList'), bank.indexOf('export function renderVersionsForBank'));
    assert.ok(!/renderVersionsForBank/.test(cardRegion), '库卡渲染里不该再挂版本面板');
    // ② 版本面板要有删除(👤 反馈的缺口:原来只能存不能删)
    assert.ok(/export function renderVersionsForBank/.test(bank), '应有版本面板渲染');
    // ⚠️ 别在面板源码上切固定字数窗口:面板里后来加了"撤销/重做"一行,窗口一变窄就误判(踩过)
    const panel = bank.slice(bank.indexOf('export function renderVersionsForBank'));
    assert.ok(/version-del/.test(panel), '每条版本都要有删除键');
    assert.ok(/deleteBankVersion/.test(panel), '删除键要调用 deleteBankVersion');
    assert.ok(/confirm\(/.test(panel), '删版本要二次确认');
    // ③ 恢复与删除都按**原数组下标**定位,不是显示顺序(列表是倒序渲染的)
    assert.ok(/map\(\(v, i\) => \(\{ v, i \}\)\)\.reverse\(\)/.test(panel), '倒序渲染时必须保留原下标');
    // ④ 去重只在"真有重复"时才存版本(别让无意义的安全网占满 3 个槽)
    const dedup = bank.slice(bank.indexOf('export function dedupBank'), bank.indexOf('export function editBank'));
    const pushIdx = dedup.indexOf('pushBankVersion');
    const zeroIdx = dedup.indexOf("removed === 0");
    assert.ok(pushIdx > zeroIdx, 'pushBankVersion 必须在"确认有重复"之后(否则空点一次也存版)');
    // ⑤ 设置页里挂载(而不是库卡)
    assert.ok(/#editor-bank-admin|editor-bank-admin/.test(bank), '版本面板应挂在题库设置容器里');
});

test('题库页头部:标题 + 一行三键(导出题库 / ＋ 创建题库 / 🗑 回收站)(👤 2026-09-12)', () => {
    const banksSection = html.slice(html.indexOf('id="banks-section"'), html.indexOf('<!-- 创建题库模态框'));
    // 「上次导入」行(👤 2026-09-13 二改):必须在**库列表之后**,不许再压在第一张卡前面
    const listIdx = banksSection.indexOf('id="banks-list"');
    const infoIdx = banksSection.indexOf('id="last-import-info"');
    assert.ok(infoIdx > listIdx && infoIdx > -1,
        '「上次导入」应排在题库列表**最末尾**(与库卡同列),不许放在列表上方');
    const header = banksSection.slice(banksSection.indexOf('banks-header'), banksSection.indexOf('banks-list'));
    const exportIdx = header.indexOf('export-all-btn');
    const createIdx = header.indexOf('create-bank-btn');
    const recIdx = header.indexOf('recycle-bin');
    assert.ok(exportIdx > -1 && createIdx > -1 && recIdx > -1, '三键都要在题库页头部');
    assert.ok(exportIdx < createIdx && createIdx < recIdx, '顺序应为 导出题库 → ＋ 创建题库 → 🗑 回收站');
    // ① 三键同属一个容器:窄屏整组一起换行,不会被拆散到两行去
    const groupStart = header.indexOf('banks-header-actions');
    assert.ok(groupStart > -1 && groupStart < exportIdx, '三键应包在 .banks-header-actions 里');
    const group = header.slice(groupStart, header.indexOf('</div>', header.lastIndexOf('recycle-list')));
    for (const id of ['export-all-btn', 'create-bank-btn', 'recycle-bin']) {
        assert.ok(group.includes(id), `${id} 应在同一个动作组里`);
    }
    // ② 三键同一套外形(同高/同圆角/同字号),只有创建键是实心的
    const cls = (id) => ((header.match(new RegExp(`id="${id}"[^>]*class="([^"]*)"`)) || [])[1] || '');
    assert.ok(cls('export-all-btn').split(/\s+/).includes('header-tool'), '导出题库应用 .header-tool');
    assert.ok(cls('recycle-toggle').split(/\s+/).includes('header-tool'), '回收站也用同一套 .header-tool');
    assert.ok(cls('create-bank-btn').split(/\s+/).includes('header-cta'), '＋ 创建题库应用 .header-cta');
    const pill = cssNoComments.match(/\n\.banks-header \.header-tool,\n\.banks-header \.header-cta \{([^}]*)\}/);
    assert.ok(pill, '三键应共用同一条外形规则(不各写一份,免得日后走散)');
    assert.ok(/min-height\s*:\s*32px/.test(pill[1]) && /border-radius\s*:\s*999px/.test(pill[1]),
        '三键 = 32px 高的胶囊');
    // ⚠️ 取**最后一条** .header-cta 规则:共用外形规则的第二个选择器那一行也长这样
    //    (`\n.banks-header .header-cta {`),只取第一条会读到共用规则(踩过)
    const ctaRules = [...cssNoComments.matchAll(/\n\.banks-header \.header-cta \{([^}]*)\}/g)].map(m => m[1]);
    const cta = ctaRules[ctaRules.length - 1];
    assert.ok(/background\s*:\s*var\(--c-primary\)/.test(cta), '创建键应是唯一的实心主键');
    const tool = cssNoComments.match(/\n\.banks-header \.header-tool:hover \{([^}]*)\}/)[1];
    assert.ok(/background\s*:\s*var\(--c-info-bg\)/.test(tool), '描边键 hover 才染底色');
    // ③ 靠右靠"标题吃右侧空隙",不靠挂在某个键上的 auto 边距(那会把相邻两键顶开一道缝)
    const h3 = cssNoComments.match(/\n\.banks-header h3 \{([^}]*)\}/);
    assert.ok(h3 && /margin\s*:\s*0 auto 0 0/.test(h3[1]), '标题应 margin-right:auto(整组自然贴右)');
    assert.ok(!/margin-left\s*:\s*auto/.test(cssNoComments.match(/\n\.banks-header-actions \{([^}]*)\}/)[1]),
        '动作组自己不需要 auto 边距');
    // ④ 标签已按 👤 要求改名:不再有「导出全部」这个说法
    assert.ok(header.includes('导出题库'), '按钮文案应是「导出题库」');
    assert.ok(!html.includes('导出全部'), 'index.html 里不该再有「导出全部」');
    const bank = readFileSync(path.join(root, 'src', 'bank.js'), 'utf8');
    assert.ok(!/导出全部/.test(bank), 'bank.js 里不该再有「导出全部」的说法');
    // ⑤ 手机档:三键放大到 40px,标题收一档给它们腾地方
    const media = cssNoComments.slice(cssNoComments.indexOf('max-width: 768px'));
    assert.ok(/\.banks-header \.header-tool,\s*\n\s*\.banks-header \.header-cta \{ min-height: 40px/.test(media),
        '手机档三键应放大到 40px');
    // 横向也要省:内边距/键间距收窄,360px 宽才排得下(见 DESIGN v23 的实测数据)
    assert.ok(/\.banks-header \.header-tool,\s*\n\s*\.banks-header \.header-cta \{ min-height: 40px; padding: 0 9px/.test(media),
        '手机档三键内边距应收到 9px');
    assert.ok(/\.banks-header-actions \{ gap: 5px/.test(media), '手机档键间距应收到 5px');
    assert.ok(/\.banks-header h3 \{ font-size: 15px/.test(media), '手机档标题应收到 15px');
    // ⑥ 导出题库**离开**了题库设置
    const modal = html.slice(html.indexOf('id="edit-bank-modal"'), html.indexOf('id="question-card-modal"'));
    assert.ok(!modal.includes('export-all-btn'), '题库设置里不该还有它');
});

test('题库页:上次导入行在列表末尾 + 手机档库列表不自己滚(👤 2026-09-13)', () => {
    // ① 上次导入行 = 列表**末尾**的一条归档备注(与库卡同列),不再是列表上方的一行
    const section = html.slice(html.indexOf('id="banks-section"'), html.indexOf('<!-- 创建题库模态框'));
    assert.ok(section.indexOf('id="last-import-info"') > section.indexOf('id="banks-list"'),
        '「上次导入」应在库列表之后');
    const rule = cssNoComments.match(/\n\.banks-last-import \{([^}]*)\}/);
    assert.ok(rule, '应有 .banks-last-import 的规则');
    assert.ok(/max-width\s*:\s*var\(--reading-width\)/.test(rule[1]),
        '它要走阅读档宽度 —— 和题库卡同一列(👤:"和题库卡并列")');
    assert.ok(/margin\s*:\s*12px auto 0/.test(rule[1]),
        '它的外边距应只有上边距(排在末尾,不再有"下方 10px"那套列表上行距)');

    // ② 手机档:库列表**不自己滚**(否则页面 + 列表 = 两个滚动区,滑到底会剩一块框下空白 + 底部白条)
    const blocks = [...cssNoComments.matchAll(/@media \(max-width: 768px\) \{([\s\S]*?)\n\}/g)].map(m => m[1]);
    const hit = blocks.some(b => /\.banks-list \{[\s\S]{0,120}?max-height: none;[\s\S]{0,120}?overflow: visible;/.test(b));
    assert.ok(hit, '手机档应有 .banks-list { max-height:none; overflow:visible } —— 让页面当唯一滚动容器');
    // 桌面档保留 600px 内滚(列表长了不该把头部推很远)
    assert.ok(/\n\.banks-list \{\n\s*max-height: 600px;\n\s*overflow-y: auto;\n\}/.test(cssNoComments),
        '桌面档应保留 600px 的内滚');
});

test('回收站:在创建按钮右侧,点开是悬浮菜单(👤 2026-09-12)', () => {
    const banksSection = html.slice(html.indexOf('id="banks-section"'), html.indexOf('<!-- 创建题库模态框'));
    // ① 同一行,且回收站在创建按钮**之后**(右侧)
    const header = banksSection.slice(banksSection.indexOf('banks-header'), banksSection.indexOf('banks-list'));
    const createIdx = header.indexOf('create-bank-btn');
    const recIdx = header.indexOf('recycle-bin');
    assert.ok(createIdx > -1 && recIdx > -1, '创建按钮与回收站都应在题库页头部那一行');
    assert.ok(createIdx < recIdx, '回收站应在「＋ 创建题库」右侧');
    // ② 回收站不再是页面流里的折叠块,而是 details + 悬浮面板
    assert.ok(/class="recycle-pop"/.test(header), '回收站应带 recycle-pop 类');
    assert.ok(/recycle-pop-panel/.test(header), '应有悬浮面板容器');
    // ③ 面板是绝对定位的浮层
    // ⚠️ 不能直接 match(\.recycle-pop-panel\s*\{…\}):它前面紧挨着一个注释块,
    //    注释里的 > 和 : 会被正则先吃到(踩过)。先确认选择器存在,再从它的位置往后取本规则。
    // ⚠️ 用行首锚定 '\n.recycle-pop-panel {':直接 indexOf('.recycle-pop-panel {') 会命中
    //    **嵌套在别的选择器里**的那条(.recycle-pop:not([open]) > .recycle-pop-panel { display:none }),
    //    于是读到的是"面板应该隐藏"而不是布局(踩过第二次)。
    const sel = '\n.recycle-pop-panel {';
    const at = cssNoComments.indexOf(sel);
    assert.ok(at > -1, '缺 .recycle-pop-panel 规则');
    const panel = cssNoComments.slice(at + sel.length, cssNoComments.indexOf('}', at));
    assert.ok(/position\s*:\s*absolute/.test(panel), '面板应绝对定位(悬浮,不占文档流)');
    assert.ok(/z-index\s*:/.test(panel), '面板应有 z-index(压在库卡之上)');
    // ④ 闭合时必须显式隐藏 —— 不能赌 details 的默认行为
    //    (实测本机 chromium 上闭合的 details 仍会渲染 children)
    assert.ok(/\.recycle-pop:not\(\[open\]\)\s*>\s*\.recycle-pop-panel\s*\{[^}]*display\s*:\s*none/.test(cssNoComments),
        '闭合态必须显式 display:none');
    // ⑤ 计数写在独立的 span 里(整条 summary 重写会冲掉图标与结构)
    const bank = readFileSync(path.join(root, 'src', 'bank.js'), 'utf8');
    assert.ok(/recycleCount\.textContent/.test(bank), '计数应只更新 recycle-count 这个 span');
    assert.ok(!/binWrap\.querySelector\('summary'\)\.textContent/.test(bank), '不该再整条重写 summary');
});

test('二级弹窗必须压在一级之上(👤 反馈:编辑器里重命名点不到)', () => {
    // 事故:所有 .modal 同为 z-index:1000,谁在上面只看 DOM 顺序 ——
    // 而「重命名/创建题库/AI 设置」在 HTML 里都排在「题库编辑」之前,
    // 于是从编辑器里点重命名,对话框被编辑器盖住,根本没法操作。
    assert.ok(/z-index\s*:\s*1000/.test(cssNoComments.match(/\n\.modal\s*\{([^}]*)\}/)[1]),
        '一级弹窗应为 1000');
    // 会被"从编辑器里打开"的三个二级弹窗,必须更高
    for (const id of ['rename-bank-modal', 'create-bank-modal', 'ai-settings-modal']) {
        const re = new RegExp(`#${id}[^{]*\\{[^}]*z-index\\s*:\\s*(\\d+)`);
        const m = cssNoComments.match(re);
        assert.ok(m, `#${id} 应有更高的 z-index(它是二级弹窗)`);
        assert.ok(Number(m[1]) > 1000, `#${id} 的 z-index 必须大于一级弹窗,实际 ${m[1]}`);
    }
    // 答题卡抽屉仍要压在所有弹窗之上(它是刷题页那一层的)
    const drawer = cssNoComments.match(/\n\.answer-card-drawer\s*\{([^}]*)\}/)[1];
    const dz = Number((drawer.match(/z-index\s*:\s*(\d+)/) || [])[1]);
    assert.ok(dz > 1100, `答题卡抽屉应压在二级弹窗之上,实际 ${dz}`);
    // 代码里确实存在"编辑器 → 重命名 / AI 设置"这两条嵌套路径(否则这条守卫没意义)
    const bank = readFileSync(path.join(root, 'src', 'bank.js'), 'utf8');
    const editorRegion = bank.slice(bank.indexOf('export function renderBankEditor'), bank.indexOf('export function editorClose'));
    assert.ok(/showRenameModal|bank-rename-btn/.test(bank), '编辑器里仍会打开重命名');
    assert.ok(/openAiSettings\(\)/.test(editorRegion) || /openAiSettings\(\)/.test(bank), '编辑器里仍会打开 AI 设置');
});

test('删库必须当场刷新回收站(👤 反馈:要刷页面才看得到)', () => {
    const bank = readFileSync(path.join(root, 'src', 'bank.js'), 'utf8');
    // ⚠️ 按**下一个函数名**界定范围,不要按注释文本 —— 同一句注释在文件里可能出现多次(踩过)
    const bodyOf = (name) => {
        const at = bank.indexOf(`export function ${name}`);
        const next = bank.indexOf('\nexport function ', at + 2);
        return bank.slice(at, next === -1 ? bank.length : next);
    };
    const del = bodyOf('deleteBank');
    assert.ok(/renderRecycleBin\(\)/.test(del),
        '删除题库后必须调用 renderRecycleBin:回收站就挂在题库页那一行,不刷就停在旧值');
    // 同类操作(恢复)本来就刷新,确认没被改坏
    const restore = bodyOf('restoreRecycled');
    assert.ok(/renderRecycleBin\(\)/.test(restore), '恢复也应刷新回收站');
});

test('答题卡抽屉在 <main> 之外(公理:浮层不受 section 显隐牵连)', () => {
    const mainEnd = html.indexOf('</main>');
    const pos = html.indexOf('id="answer-card-drawer"');
    assert.ok(pos !== -1, '答题卡抽屉不存在');
    // 抽屉是 position:fixed 的浮层:待在 main 内会受祖先滚动/包含块牵连
    assert.ok(pos > mainEnd, '答题卡抽屉必须在 <main> 之外');
    for (const id of ['answer-card-backdrop', 'answer-card-grid', 'answer-card-close']) {
        assert.ok(html.indexOf(`id="${id}"`) > mainEnd, `${id} 必须在 <main> 之外`);
    }
});

test('答题卡入口住在题干上方标签行的最左(进度即入口)', () => {
    // 👤 定调:入口就是进度本身,不得另起一个常驻按钮
    const metaStart = html.indexOf('class="question-tags"');
    const metaEnd = html.indexOf('</div>', metaStart);
    const openPos = html.indexOf('id="answer-card-open"');
    assert.ok(openPos !== -1, '答题卡入口按钮不存在');
    // 👤 定调 2026-09-11:入口从状态栏移到题干上方的标签行(免得被「确认答案」挤到折行)
    assert.ok(openPos > metaStart && openPos < metaEnd, '答题卡入口必须在题干上方的标签行内');
    // 进度数字仍然是那个被显示的元素(别把 #question-number 挪走,刷题进度靠它)
    const openTag = html.slice(openPos, html.indexOf('</button>', openPos));
    assert.ok(openTag.includes('id="question-number"'), '进度 #question-number 必须仍在入口按钮内');
    assert.ok(openTag.includes('aria-haspopup="dialog"'), '入口应有 aria-haspopup 语义');
});

test('答题卡抽屉:遮罩层级必须高于弹窗(否则弹窗里打开会被盖住)', () => {
    const backdrop = cssNoComments.match(/\.answer-card-backdrop\s*\{[^}]*\}/);
    const drawer = cssNoComments.match(/\.answer-card-drawer\s*\{[^}]*\}/);
    assert.ok(backdrop && drawer, '应有遮罩与抽屉的样式规则');
    const zOf = (rule) => Number((rule[0].match(/z-index\s*:\s*(\d+)/) || [])[1]);
    assert.ok(zOf(backdrop) > 1000, `遮罩 z-index 应高于弹窗(1000),实际 ${zOf(backdrop)}`);
    assert.ok(zOf(drawer) > zOf(backdrop), '抽屉必须高于自己的遮罩,否则被遮罩挡住点不到');
    assert.ok(/position\s*:\s*fixed/.test(drawer[0]), '抽屉应 position: fixed 相对视口定位');
});

test('答题卡三态样式齐备,且未答用虚线框(不只靠颜色区分)', () => {
    for (const state of ['correct', 'wrong', 'blank']) {
        const rule = cssNoComments.match(new RegExp(`\\.answer-card-cell\\.${state}\\s*\\{[^}]*\\}`));
        assert.ok(rule, `缺 .answer-card-cell.${state} 样式`);
    }
    const blank = cssNoComments.match(/\.answer-card-cell\.blank\s*\{[^}]*\}/)[0];
    assert.ok(/border-style\s*:\s*dashed/.test(blank), '未答必须用虚线框,不能只靠颜色');
    // 套题交卷前的"已选"态:必须是中性色,绝不能带绿/红(带了就是泄题)
    const picked = cssNoComments.match(/\.answer-card-cell\.picked\s*\{([^}]*)\}/);
    assert.ok(picked, '缺 .answer-card-cell.picked 样式(套题交卷前的已选态)');
    assert.ok(!/--c-success|--c-danger/.test(picked[1]), '已选态不得用绿/红:套题交卷前标对错 = 泄题');
    assert.ok(/::before/.test(cssNoComments.slice(cssNoComments.indexOf('.answer-card-cell.picked'))), '已选态应有独立记号(不能只靠颜色)');
    // 当前题用 outline:改边框会覆盖三态底色(当前题也可能是已答对的题)
    const current = cssNoComments.match(/\.answer-card-cell\.current\s*\{[^}]*\}/);
    assert.ok(current, '缺 .answer-card-cell.current 样式');
    assert.ok(/outline\s*:/.test(current[0]), '当前题应用 outline 而非 border');
    assert.ok(!/border\s*:/.test(current[0].replace(/outline[^;]*;/g, '')), '当前题不得覆盖 border(会吃掉三态底色)');
});

test('手机上题目容器不得被 auto 边距压塌(👤 报的"很窄很突兀")', () => {
    // 事故:.quiz-container 桌面靠 margin-left/right:auto 居中(配 max-width 640)。
    // 手机档把它变成 flex 子项后,**flex 子项的 auto 横向边距会吃掉全部剩余空间**:
    // 元素既不拉伸、又被压到最小内容宽 —— Chromium 实测 390px 手机上容器只剩 82px,
    // 题干与选项全成一条窄柱,且与题干长短无关(每一题都窄)。
    // 判据要求"同一条规则体内同时出现 display:flex 与 margin-left/right:0",避免半修状态。
    const index = buildIndex(String(cssNoComments));
    const mobileContainer = (index.get('#quiz-section.active:has(#quiz-container:not(.hidden)) #quiz-container') || [])
        .filter(h => h.inMedia)
        .find(h => /display\s*:\s*flex/.test(h.body) && !/flex-direction\s*:\s*row/.test(h.body));
    assert.ok(mobileContainer, '手机档应有一条把 #quiz-container 变成 flex 子项的规则');
    assert.ok(/margin-left\s*:\s*0/.test(mobileContainer.body) && /margin-right\s*:\s*0/.test(mobileContainer.body),
        '手机档必须同时清掉 auto 横向边距:否则 flex 子项的 auto 边距会把容器压成窄柱(实测 82px)');
    // 结果页同样是该 flex 容器的子项
    const resultReset = (index.get('#quiz-section.active:has(#quiz-result:not(.hidden)) #quiz-result') || [])
        .find(h => /margin-left\s*:\s*0/.test(h.body));
    assert.ok(resultReset, '手机档结果页也要清掉 auto 边距');
});

test('答题卡样式不得写死像素宽度(宽度走档位令牌)', () => {
    const drawer = cssNoComments.match(/\.answer-card-drawer\s*\{[^}]*\}/)[0];
    assert.ok(!/max-width\s*:\s*\d+px/.test(drawer), '抽屉不得写死 max-width 像素');
    assert.ok(/var\(--pad-x\)/.test(drawer), '抽屉左右内边距应复用 --pad-x(与三页统一内边距一致)');
});

test('导出/导入:多题库分节(👤 2026-09-12:导出别混成一块,导入要自动认出多库)', () => {
    // ① 导出:每个题库前一行分节标题,且**导出与导入共用同一个字符串来源**(bankSectionHeader)
    const bank = readFileSync(path.join(root, 'src', 'bank.js'), 'utf8');
    assert.ok(/bankSectionHeader\(bankName\)/.test(bank), '「导出题库」应逐库写分节标题');
    const parser = readFileSync(path.join(root, 'src', 'parser.js'), 'utf8');
    assert.ok(/export function bankSectionHeader/.test(parser), '分节标题应有单一来源');
    assert.ok(/export function splitBankSections/.test(parser), '导入侧应有分节切分函数');
    // ② 分节标记必须先于 TITLE_RE 判定(否则它会被当成"一道题的标题",各库的题混成一库)
    const secIdx = parser.indexOf('BANK_SECTION_RE');
    assert.ok(secIdx > -1, '应有分节标记正则');
    assert.ok(/splitBankSections/.test(bank) && /state\.previewBanks/.test(bank), '导入入口应用切分结果');
    assert.ok(/previewBankMode/.test(bank), '应有多题库导入方式(分开 / 合并)');
    // ③ 预览里的横幅 + 方式单选 + 「导入到」整行可隐藏
    const modal = html.slice(html.indexOf('id="import-preview-modal"'), html.indexOf('<!-- AI 设置模态框'));
    for (const id of ['preview-multi-banner', 'preview-multi-text', 'preview-target-row', 'preview-overwrite-label']) {
        assert.ok(modal.includes(id), `导入预览应含 ${id}`);
    }
    assert.ok((modal.match(/name="preview-bank-mode"/g) || []).length === 2, '应有两个导入方式单选');
    assert.ok(/value="separate"/.test(modal) && /value="merge"/.test(modal), '两个方式:分开 / 合并');
});
