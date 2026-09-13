// PWA manifest + 图标(0.13.0 / P0-1)。
// 为什么值得单开一个文件:图标是**二进制资产**,最典型的回归是"改了图标忘了重新渲染 PNG"
// 或"manifest 里声明的尺寸和文件实际尺寸对不上" —— 这类错误浏览器只会静默降级(装出来的图标糊掉/不显示),
// 在真机上不一定看得出来,所以这里连 PNG 像素都验。
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(root, 'index.html'), 'utf8');
const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.webmanifest'), 'utf8'));
const cssNoCommentsForPwa = readFileSync(path.join(root, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

// 最小 PNG 头/像素解码:只为断言"尺寸对不对、圆角外是不是真透明、Z 是不是白的"
function decodePng(file) {
    const d = readFileSync(file);
    assert.deepStrictEqual([...d.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], file + ' 不是 PNG');
    let p = 8, w = 0, h = 0, ct = 0;
    const idat = [];
    while (p < d.length) {
        const len = d.readUInt32BE(p), type = d.toString('ascii', p + 4, p + 8);
        const body = d.subarray(p + 8, p + 8 + len);
        if (type === 'IHDR') { w = body.readUInt32BE(0); h = body.readUInt32BE(4); ct = body[9]; }
        if (type === 'IDAT') idat.push(body);
        p += 12 + len;
    }
    const raw = inflateSync(Buffer.concat(idat));
    const ch = ct === 6 ? 4 : ct === 2 ? 3 : 1;
    const stride = w * ch;
    const out = Buffer.alloc(h * stride);
    let pos = 0;
    for (let y = 0; y < h; y++) {
        const filter = raw[pos++];
        const line = raw.subarray(pos, pos + stride); pos += stride;
        const cur = out.subarray(y * stride, (y + 1) * stride);
        const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
        for (let i = 0; i < stride; i++) {
            const a = i >= ch ? cur[i - ch] : 0, b = prev[i], c = i >= ch ? prev[i - ch] : 0, x = line[i];
            let v;
            if (filter === 0) v = x; else if (filter === 1) v = x + a; else if (filter === 2) v = x + b;
            else if (filter === 3) v = x + ((a + b) >> 1);
            else { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
            cur[i] = v & 0xff;
        }
    }
    return { w, h, ct, ch, at: (x, y) => [...out.subarray(y * stride + x * ch, y * stride + x * ch + ch)] };
}

test('manifest:字段齐全,且 start_url/scope 是相对路径(子目录部署不白屏)', () => {
    for (const k of ['name', 'short_name', 'start_url', 'scope', 'display', 'theme_color', 'background_color', 'icons']) {
        assert.ok(manifest[k], `manifest 缺 ${k}`);
    }
    assert.strictEqual(manifest.display, 'standalone', '要能全屏打开(无地址栏)');
    assert.strictEqual(manifest.lang, 'zh-CN');
    // ⚠️ 站点在 /zquiz/ 子目录:写死 '/' 或绝对 URL 会 scope 错位 → 装到主屏后白屏
    for (const k of ['start_url', 'scope']) {
        assert.ok(!/^https?:/i.test(manifest[k]) && !manifest[k].startsWith('/'), `${k} 必须是相对路径,实际:${manifest[k]}`);
    }
});

test('manifest 里的每个图标都存在,且 PNG 实际尺寸与声明一致', () => {
    assert.ok(manifest.icons.length >= 3, '至少要有 192 / 512 / maskable 三张');
    const sizes = manifest.icons.filter(i => i.purpose !== 'maskable').map(i => i.sizes);
    assert.ok(sizes.includes('192x192') && sizes.includes('512x512'), '常规图标要有 192 与 512(浏览器安装门槛)');
    assert.ok(manifest.icons.some(i => i.purpose === 'maskable'), '要有 maskable(安卓自适应裁切)');
    for (const icon of manifest.icons) {
        const file = path.join(root, icon.src);
        assert.ok(existsSync(file), `manifest 声明的图标不存在:${icon.src}`);
        const png = decodePng(file);
        assert.strictEqual(`${png.w}x${png.h}`, icon.sizes, `${icon.src} 实际尺寸与声明不符`);
    }
});

test('图标像素:圆角外真透明、Z 是白的、底色是品牌蓝;maskable 与 touch icon 必须不透明', () => {
    const rounded = decodePng(path.join(root, 'icons/icon-512.png'));
    const corner = rounded.at(2, 2);
    assert.strictEqual(corner[3], 0, '圆角外应完全透明(否则安卓/iOS 会看到白角)');
    const bg = rounded.at(120, 256);
    assert.ok(bg[2] > bg[0] + 40, `底色应是蓝的,实际 rgb(${bg.slice(0, 3)})`);
    for (const [x, y, where] of [[256, 174, '上横'], [256, 256, '斜杠'], [256, 338, '下横']]) {
        const p = rounded.at(x, y);
        assert.ok(p[0] > 240 && p[1] > 240 && p[2] > 240, `Z 的${where}应接近纯白,实际 rgba(${p})`);
    }
    // iOS 会把透明底填成黑/白块,所以 touch icon 必须不透明;maskable 由系统裁切,底必须铺满
    for (const f of ['icons/apple-touch-icon-180.png', 'icons/maskable-512.png']) {
        const img = decodePng(path.join(root, f));
        assert.strictEqual(img.ch, 3, `${f} 不应带 alpha 通道`);
        assert.ok(img.at(2, 2)[2] > img.at(2, 2)[0] + 40, `${f} 的角上应是实心底色`);
    }
});

test('index.html:链接 manifest 与图标,并补 iOS 专用 meta 与亮暗两档 theme-color', () => {
    assert.ok(/<link rel="manifest" href="manifest\.webmanifest">/.test(html), '要链接 manifest');
    assert.ok(/<link rel="apple-touch-icon" href="icons\/apple-touch-icon-180\.png">/.test(html), '要链接 apple-touch-icon');
    assert.ok(/rel="icon"[^>]*icons\/icon\.svg/.test(html), '要有 svg favicon');
    for (const m of ['apple-mobile-web-app-capable', 'apple-mobile-web-app-title', 'apple-mobile-web-app-status-bar-style']) {
        assert.ok(html.includes(m), `缺 iOS meta:${m}`);
    }
    const themes = [...html.matchAll(/<meta name="theme-color" content="([^"]+)"([^>]*)>/g)];
    assert.strictEqual(themes.length, 2, 'theme-color 应分亮暗两档');
    assert.ok(themes.every(t => /prefers-color-scheme/.test(t[2])), '两档都要带 media 条件');
});

test('本批的范围边界:不引入 service worker(离线缓存已由 👤 取消,另行设计)', () => {
    const bank = readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    const files = ['src/main.js', 'src/dom.js', 'index.html', 'manifest.webmanifest'];
    for (const f of files) {
        const text = f === 'index.html' || f === 'manifest.webmanifest' ? html : bank;
        assert.ok(!/serviceWorker/.test(text), `${f} 里不该出现 serviceWorker 注册(本批不做离线缓存)`);
    }
    assert.ok(!existsSync(path.join(root, 'sw.js')), '本批不该有 sw.js');
});

test('装到主屏的引导:只在手机档显示,且已装(独立窗口)时自动隐藏', () => {
    assert.ok(/class="install-hint"/.test(html), '题库页底部应有"加到主屏"的引导');
    assert.ok(/添加到主屏幕/.test(html) && /安装应用/.test(html), '要分别给出 iPhone 与安卓的操作路径');
    const hint = cssNoCommentsForPwa.match(/\n\.install-hint \{\n?\s*([^}]*)\}/);
    assert.ok(hint && /display\s*:\s*none/.test(hint[1]), '默认(桌面档)应隐藏 —— 这条引导只对手机有意义');
    const media = cssNoCommentsForPwa.slice(cssNoCommentsForPwa.indexOf('max-width: 768px'));
    assert.ok(/\n\s*\.install-hint \{/.test(cssNoCommentsForPwa.slice(cssNoCommentsForPwa.indexOf('@media (max-width: 768px)'))),
        '手机档要显示出来');
    // 已在独立窗口里跑时,不该还在教用户"怎么装"
    assert.ok(/@media \(display-mode: standalone\) \{\s*\n\s*\.install-hint \{ display: none !important; \}/.test(cssNoCommentsForPwa),
        'display-mode:standalone 下应隐藏');
    const mainJs = readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    assert.ok(/is-standalone/.test(mainJs) && /navigator\.standalone/.test(mainJs),
        '还要兜老 iOS:navigator.standalone 为真时加 is-standalone 类');
    assert.ok(/html\.is-standalone \.install-hint \{ display: none !important; \}/.test(cssNoCommentsForPwa),
        '缺 is-standalone 的隐藏规则');
});
