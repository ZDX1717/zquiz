// PDF 文本抽取(0.15.0 / P1-2)。
// 全部用 Node 的 zlib 现造合成 PDF —— 不引 pdf.js、不塞二进制 fixture:
// ① 合成件能把"每个分支"精确覆盖到(真实 PDF 反而不好构造边界);
// ② 仓库里不留二进制垃圾;③ 造出来的字节流走的是与真实文件同一条解析路径。
import test from 'node:test';
import assert from 'node:assert';
import zlib from 'node:zlib';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pdfToText, pdfTextGate, parseToUnicodeCMap, bytesToLatin1 } from '../src/pdf.js';

// ---------- 合成 PDF 的小工厂 ----------
// objs: [{ num, dict, stream?, compress? }] —— dict 是 PDF 字典原文(含 << >>)
function buildPdf(objs, { encrypt = false } = {}) {
    const parts = [Buffer.from('%PDF-1.7\n', 'latin1')];
    for (const o of objs) {
        let body = `${o.num} 0 obj\n${o.dict}\n`;
        if (o.stream !== undefined) {
            const raw = typeof o.stream === 'string' ? Buffer.from(o.stream, 'latin1') : Buffer.from(o.stream);
            const data = o.compress ? zlib.deflateSync(raw) : raw;
            body += `stream\n`;
            parts.push(Buffer.from(body, 'latin1'), Buffer.from(data), Buffer.from('\nendstream\nendobj\n', 'latin1'));
            continue;
        }
        parts.push(Buffer.from(body + 'endobj\n', 'latin1'));
    }
    const trailer = encrypt
        ? 'trailer\n<< /Size 99 /Root 1 0 R /Encrypt 98 0 R >>\n%%EOF\n'
        : 'trailer\n<< /Size 99 /Root 1 0 R >>\n%%EOF\n';
    parts.push(Buffer.from(trailer, 'latin1'));
    return Buffer.concat(parts);
}

// Identity-H 中文:码位 = 字符码位(真实 PDF 常见做法),配一张 ToUnicode 映射
function cjkHex(text) {
    let hex = '';
    for (const ch of text) hex += ch.charCodeAt(0).toString(16).padStart(4, '0');
    return hex;
}
function cjkCMap(text) {
    const codes = [...new Set([...text].map(ch => ch.charCodeAt(0)))];
    return `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n1 beginbfchar\n`
        + codes.map(c => `<${c.toString(16).padStart(4, '0')}> <${c.toString(16).padStart(4, '0')}>`).join('\n')
        + `\nendbfchar\nendcmap\nend\n`;
}

// 单页 PDF:content 写明内容流,fontObjs 里放字体对象(可注入 CJK 字体)
function onePagePdf(content, { fontDict = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', fontNum = 5, extraObjs = [], contentFilter = null, compress = false } = {}) {
    const objs = [
        { num: 1, dict: '<< /Type /Catalog /Pages 2 0 R >>' },
        { num: 2, dict: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
        { num: 3, dict: `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 ${fontNum} 0 R >> >> /Contents 4 0 R >> ` },
        {
            num: 4,
            // ⚠️ compress 必须**同时**写 /Filter /FlateDecode:写进文件的是压缩后的字节,
            //    不声明过滤器的话解析器会拿压缩字节当文本(实测表现为"抽出来是空的")
            dict: `<< /Length ${compress ? zlib.deflateSync(Buffer.from(content, 'latin1')).length : Buffer.byteLength(content, 'latin1')}`
                + `${compress ? ' /Filter /FlateDecode' : (contentFilter ? ' /Filter ' + contentFilter : '')} >>`,
            stream: content,
            compress,
        },
        ...extraObjs,
    ];
    if (fontDict) objs.push({ num: fontNum, dict: fontDict });
    return buildPdf(objs);
}

// ---------- 基础:简单字体的 ASCII 文本 ----------
test('ASCII 文本:一行一 Td → 抽出文本,行间有换行', async () => {
    const pdf = onePagePdf('BT /F1 12 Tf 72 720 Td (Question: 1+1?) Tj T* (A. 1) Tj T* (B. 2) Tj ET');
    const { text, gate } = await pdfToText(pdf);
    assert.strictEqual(gate.ok, true, '正常文本应过闸:' + gate.detail);
    assert.ok(text.includes('Question: 1+1?'), '应抽出题干,实际:' + JSON.stringify(text));
    assert.ok(text.includes('A. 1'), '应抽出选项 A');
    assert.ok(text.includes('\n'), '三行之间要有换行');
});

test('字面串的转义与嵌套括号', async () => {
    const pdf = onePagePdf('BT /F1 12 Tf 72 720 Td (a\\(b\\)c \\\\ d) Tj ET');
    const { text } = await pdfToText(pdf);
    assert.ok(text.includes('a(b)c \\ d'), '转义要还原,实际:' + JSON.stringify(text));
});

test('TJ 数组:大负位移算空格,小位移不加', async () => {
    const pdf = onePagePdf('BT /F1 12 Tf 72 720 Td [(Hel) -300 (lo)] TJ T* [(wor) -10 (ld)] TJ ET');
    const { text } = await pdfToText(pdf);
    assert.ok(text.includes('Hel lo'), '大位移应补空格,实际:' + JSON.stringify(text));
    assert.ok(text.includes('world'), '小位移不该乱插空格,实际:' + JSON.stringify(text));
});

test('十六进制串与 WinAnsi 高位字符', async () => {
    const pdf = onePagePdf('BT /F1 12 Tf 72 720 Td <48656C6C6F> Tj ET');
    const { text } = await pdfToText(pdf);
    assert.ok(text.includes('Hello'), 'hex 串要解出来,实际:' + JSON.stringify(text));
});

// ---------- 中文:CID + ToUnicode(这一条决定中文能不能用) ----------
test('Identity-H 中文:靠 ToUnicode 映射出正确汉字', async () => {
    const line1 = '题目：中华人民共和国成立于哪一年';
    const line2 = 'A：1949 年 B：1950 年 答案：A';
    const source = line1 + line2;
    const pdf = onePagePdf(
        `BT /F1 12 Tf 72 720 Td <${cjkHex(line1)}> Tj T* <${cjkHex(line2)}> Tj ET`,
        {
            fontDict: '<< /Type /Font /Subtype /Type0 /BaseFont /SimSun /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>',
            extraObjs: [
                { num: 6, dict: '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /SimSun >>' },
                { num: 7, dict: `<< /Length ${Buffer.byteLength(cjkCMap(source), 'latin1')} >>`, stream: cjkCMap(source) },
            ],
        },
    );
    const { text, gate, stats } = await pdfToText(pdf);
    assert.ok(text.includes('中华人民共和国'), '中文应正确映射,实际:' + JSON.stringify(text));
    assert.ok(text.includes('A：1949'), '第二行也应正确(含全角标点与数字)');
    assert.strictEqual(gate.ok, true, '有映射的中文应过闸:' + gate.detail);
    assert.strictEqual(stats.cidFontsWithoutMap, 0, '这张字体带了 ToUnicode');
});

test('CID 字体没带 ToUnicode → 闸门拦下(乱码不硬导入)', async () => {
    const pdf = onePagePdf(
        `BT /F1 12 Tf 72 720 Td <4E2D6587989876EE> Tj ET`,
        { fontDict: '<< /Type /Font /Subtype /Type0 /BaseFont /SimSun /Encoding /Identity-H /DescendantFonts [6 0 R] >>', extraObjs: [{ num: 6, dict: '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /SimSun >>' }] },
    );
    const { text, gate, stats } = await pdfToText(pdf);
    assert.strictEqual(gate.ok, false, '没映射的 CID 文本必须被拦下');
    assert.strictEqual(gate.reason, 'fontmap');
    assert.ok(stats.cidFontsWithoutMap > 0, '应识别出"CID 字体且无映射"');
    assert.ok(!text.includes('中文'), '不该假装能读出中文');
});

// ---------- 压缩与对象流 ----------
test('FlateDecode 压缩的内容流能解出来', async () => {
    const content = 'BT /F1 12 Tf 72 720 Td (Compressed line) Tj T* (second line) Tj ET';
    const pdf = onePagePdf(content, { compress: true });
    const { text, gate } = await pdfToText(pdf);
    assert.ok(text.includes('Compressed line'), '解压后应有正文,实际:' + JSON.stringify(text));
    assert.ok(text.includes('second line'));
    assert.strictEqual(gate.ok, true);
});

test('ASCIIHexDecode 过滤的内容流', async () => {
    const content = 'BT /F1 12 Tf 72 720 Td (HexFiltered) Tj ET';
    const hex = Buffer.from(content, 'latin1').toString('hex').toUpperCase() + '>';
    const pdf = onePagePdf(hex, { contentFilter: '/ASCIIHexDecode' });
    const { text } = await pdfToText(pdf);
    assert.ok(text.includes('HexFiltered'), '实际:' + JSON.stringify(text));
});

test('对象流(ObjStm):藏在对象流里的页面/字体也能用', async () => {
    // 把 3 号页面对象塞进 ObjStm(现代 PDF 常见),其余照旧
    const content = 'BT /F1 12 Tf 72 720 Td (From ObjStm) Tj ET';
    const pageBody = `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`;
    const inner = `${3} ${0} `;
    const header = '3 0 ';
    const objStmText = header + pageBody;                       // 头部 "3 0 " + 正文
    const objs = [
        { num: 1, dict: '<< /Type /Catalog /Pages 2 0 R >>' },
        { num: 2, dict: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
        { num: 4, dict: `<< /Length ${Buffer.byteLength(content, 'latin1')} >>`, stream: content },
        { num: 5, dict: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' },
        { num: 9, dict: `<< /Type /ObjStm /N 1 /First ${header.length} /Length ${Buffer.byteLength(objStmText, 'latin1')} >>`, stream: objStmText },
    ];
    void inner;
    const pdf = buildPdf(objs);
    const { text } = await pdfToText(pdf);
    assert.ok(text.includes('From ObjStm'), '对象流里的页面对象要能用,实际:' + JSON.stringify(text));
});

// ---------- 拒绝的几种 ----------
test('加密 PDF:明确说"有密码保护",不硬抽', async () => {
    const pdf = buildPdf([
        { num: 1, dict: '<< /Type /Catalog /Pages 2 0 R >>' },
        { num: 2, dict: '<< /Type /Pages /Kids [] /Count 0 >>' },
    ], { encrypt: true });
    await assert.rejects(() => pdfToText(pdf), /密码/);
});

test('不是 PDF 的文件:直接说不是 PDF', async () => {
    await assert.rejects(() => pdfToText(Buffer.from('这不是 PDF,只是一段文字', 'utf8')), /不是 PDF 文件/);
});

test('损坏的 PDF:要么说结构异常,要么抽到空文本被闸门拦下 —— 都不许崩', async () => {
    const broken = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog \n%%EOF\n', 'latin1');
    let result = null;
    try {
        result = await pdfToText(broken);
    } catch (e) {
        assert.ok(/结构异常|密码/.test(e.message), '报错也要是人话,实际:' + e.message);
        return;
    }
    assert.strictEqual(result.gate.ok, false, '抽不到内容就必须被闸门拦下');
});

test('超级小的 PDF(只有零星文字)判为图片版', async () => {
    const pdf = onePagePdf('BT /F1 12 Tf 72 720 Td (Hi) Tj ET');
    const { gate } = await pdfToText(pdf);
    assert.strictEqual(gate.ok, false);
    assert.strictEqual(gate.reason, 'scanned');
});

// ---------- 闸门的三条判据 ----------
test('闸门:空文本 / 高乱码率 / 正常文本', () => {
    assert.strictEqual(pdfTextGate('').reason, 'scanned');
    assert.strictEqual(pdfTextGate('   \n  ').reason, 'scanned');
    assert.strictEqual(pdfTextGate('正常的一段中文文本,用来测试闸门是否放行,长度也够长足够长。').ok, true);
    const garbage = '题目' + '\uFFFD'.repeat(20) + '一二三四五六七八九十';
    assert.strictEqual(pdfTextGate(garbage).reason, 'fontmap', '乱码率高要拦');
    // 结构性判据:CID 字体没映射 + 一个中文都没抽到
    assert.strictEqual(pdfTextGate('This is plain ascii text, long enough to pass length check.', { cidFontsWithoutMap: 1, cjkCount: 0 }).reason, 'fontmap');
});

// ---------- ToUnicode 解析(bfchar / bfrange 两种形式) ----------
test('CMap 解析:bfchar 与两种 bfrange', () => {
    const cmap = `
      1 beginbfchar
      <0003> <0020>
      endbfchar
      2 beginbfrange
      <0020> <0022> <0041>
      <0100> <0101> [<4E2D> <6587>]
      endbfrange`;
    const map = parseToUnicodeCMap(cmap);
    assert.strictEqual(map.get(0x0003), ' ');
    assert.strictEqual(map.get(0x0020), 'A');
    assert.strictEqual(map.get(0x0021), 'B');
    assert.strictEqual(map.get(0x0022), 'C');
    assert.strictEqual(map.get(0x0100), '中');
    assert.strictEqual(map.get(0x0101), '文');
});

// ---------- 端到端:PDF → 文本 → 现有解析管道 ----------
test('真往返:一份中文卷子 PDF → 抽出文本 → parseQuestionsText 出题(答案对)', async () => {
    const quiz = '题目：1+1 等于几\nA：1\nB：2\n答案：B\n题目：中国的首都\nA：上海\nB：北京\n答案：B';
    const lines = quiz.split('\n');
    const content = 'BT /F1 12 Tf 72 720 Td '
        + lines.map((l, i) => `<${cjkHex(l)}> Tj ${i < lines.length - 1 ? 'T* ' : ''}`).join('')
        + 'ET';
    const pdf = onePagePdf(content, {
        fontDict: '<< /Type /Font /Subtype /Type0 /BaseFont /SimSun /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>',
        extraObjs: [
            { num: 6, dict: '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /SimSun >>' },
            { num: 7, dict: `<< /Length ${Buffer.byteLength(cjkCMap(quiz), 'latin1')} >>`, stream: cjkCMap(quiz) },
        ],
        compress: true,
    });
    const { text, gate } = await pdfToText(pdf);
    assert.strictEqual(gate.ok, true, '这份应过闸:' + gate.detail);
    // 走**现有**解析器(不新增第二条导入路径)
    const { parseQuestionsText } = await import('../src/parser.js');
    const questions = parseQuestionsText(text);
    assert.strictEqual(questions.length, 2, '应解析出两道题,实际文本:' + JSON.stringify(text));
    assert.strictEqual(questions[0].answer, 'B');
    assert.ok(questions[1].content.includes('首都'), '第二题题干应正确');
    assert.strictEqual(questions[1].answer, 'B');
});

// ---------- 架构守卫 ----------
test('pdf.js 必须零依赖零 DOM(纯函数,可单测)', () => {
    // ⚠️ 先剥注释:文件头那段"禁止 document / localStorage / state"的说明里就写着这些词,
    //    不剥掉守卫会把自己判红(这个坑在 .card-head 那条守卫上已经踩过一次)
    const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'pdf.js'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    assert.ok(!/^\s*import\s/m.test(src), 'pdf.js 不许 import 任何东西(包括产品模块)');
    assert.ok(!/\bdocument\b/.test(src), 'PDF 解析不许碰 DOM');
    assert.ok(!/localStorage|state\./.test(src), '不许碰存储与全局 state');
    assert.ok(/DecompressionStream/.test(src), '解 FlateDecode 用平台自带的 DecompressionStream(零依赖)');
});

test('bytesToLatin1 按字节保真(不把 PDF 当 UTF-8 解)', () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0xe4, 0xb8, 0xad]);
    const s = bytesToLatin1(bytes);
    assert.strictEqual(s.length, 7, '一个字节 = 一个字符,长度必须守恒');
    assert.strictEqual(s.charCodeAt(4), 0xe4);
});
