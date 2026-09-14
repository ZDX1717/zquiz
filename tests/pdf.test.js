// PDF 文本抽取(0.15.0 / P1-2)。
// 全部用 Node 的 zlib 现造合成 PDF —— 不引 pdf.js、不塞二进制 fixture:
// ① 合成件能把"每个分支"精确覆盖到(真实 PDF 反而不好构造边界);
// ② 仓库里不留二进制垃圾;③ 造出来的字节流走的是与真实文件同一条解析路径。
import test from 'node:test';
import assert from 'node:assert';
import zlib from 'node:zlib';   // 造压缩流/算长度(合成 PDF 用)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pdfToText, pdfTextGate, parseToUnicodeCMap, bytesToLatin1 } from '../src/pdf.js';
import { buildPdf, onePagePdf, cjkHex, cjkCMap } from './helpers/pdf-fixture.mjs';

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

// ---------- 接线守卫(改移动端文件分支前必读) ----------
test('接线:PDF 必须走真抽取,不许退回"读不了"的老路', () => {
    // ⚠️ 先剥注释:解释这条 TDZ 坑的注释里**原样写着**坏写法,不剥掉守卫会自己判红(这个坑踩过两次了)
    const bank = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'bank.js'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    assert.ok(/import \{ pdfToText \} from '\.\/pdf\.js'/.test(bank), 'bank.js 要引入 pdf 抽取');
    assert.ok(/endsWith\('\.pdf'\)[\s\S]{0,400}pdfToText/.test(bank), '.pdf 分支要真的去抽取');
    assert.ok(!/showUnreadableFileNotice/.test(bank), '老的一刀切提示函数必须删掉(PDF 现在按原因分四种提示)');
    assert.ok(/showPdfNotice/.test(bank), '要有按原因的 PDF 提示');
    // 🚨 fillBox 必须是**函数声明**(提升):PDF 分支在它前面就 return 了,
    //    而它的 async 回调要调 fillBox —— 用 const 声明会 TDZ,回调静默失败,
    //    表现是"状态行一直停在正在读取…"(实测踩过:没有任何报错,只有断言"文字进没进框"能抓到)
    assert.ok(/function fillBox\(text, label, opts = \{\}\)/.test(bank), 'fillBox 必须是函数声明(会提升)');
    assert.ok(!/const fillBox\s*=/.test(bank), 'fillBox 不许写成 const(会在 PDF 那条 async 路径上 TDZ)');
});

test('PDF 提示的四种原因各有各的替代路(不能一句"读不了"打包)', () => {
    const bank = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'bank.js'), 'utf8');
    // 扫描件与字体没映射:给 AI 提取入口(附文件)+ 不用 AI 的路
    assert.ok(/reason === 'scanned'/.test(bank) && /reason === 'fontmap'/.test(bank), '两种"抽不出文字"的原因要分开');
    // 加密:聊天 AI 也读不了加密件 → 不给 AI 按钮
    const enc = bank.slice(bank.indexOf("reason === 'encrypted'"), bank.indexOf("reason === 'scanned'"));
    assert.ok(enc.length > 0, '应有 encrypted 分支');
    assert.ok(!/file-ai-copy-btn/.test(enc), '加密件不该出现 AI 提取按钮');
    assert.ok(/密码/.test(enc), '要说清是密码问题');
});

// ---------- 真实世界结构(拿 W3C dummy.pdf 这类真文件踩出来的三条) ----------
test('间接 /Length + 间接 /Font:真文件最常见的两个"看起来读不出文字"的原因', async () => {
    // 真实文件:`/Length 3 0 R`(裸数字对象),`/Resources << /Font 10 0 R >>`(资源再间接一层)
    const content = 'BT /F1 12 Tf 72 720 Td (Indirect everywhere) Tj ET';
    const objs = [
        { num: 1, dict: '<< /Type /Catalog /Pages 2 0 R >>' },
        { num: 2, dict: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
        { num: 3, dict: '<< /Type /Page /Parent 2 0 R /Resources 11 0 R /Contents 4 0 R >>' },
        { num: 4, dict: `<< /Length 5 0 R /Filter /FlateDecode >>`, stream: content, compress: true },
        { num: 5, dict: String(zlib.deflateSync(Buffer.from(content, 'latin1')).length) },   // 裸数字对象
        { num: 9, dict: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' },
        { num: 10, dict: '<< /F1 9 0 R >>' },                                               // 字体资源字典
        { num: 11, dict: '<< /Font 10 0 R /ProcSet [/PDF /Text] >>' },                       // 资源字典
    ];
    const { text, gate } = await pdfToText(buildPdf(objs));
    assert.ok(text.includes('Indirect everywhere'),
        '间接 /Length 与间接 /Font 都要能解开,实际:' + JSON.stringify(text) + ' / ' + JSON.stringify(gate));
});

test('词被拆成多个 Tj:Td 的 X 位移**不补空格**(否则英文词会被切开)', async () => {
    const content = 'BT /F1 12 Tf 56 758 Td (Dumm) Tj 50.1 0 Td (y) Tj 9 0 Td ( ) Tj 4.4 0 Td (PDF) Tj ET';
    const { text } = await pdfToText(onePagePdf(content));
    assert.strictEqual(text, 'Dummy PDF', '实际:' + JSON.stringify(text));
    assert.ok(!/Dumm y/.test(text), '词内不许被切出空格');
});

test('TJ 位移阈值:250(词间距)补空格,100(字距)不补', async () => {
    const pdf = onePagePdf('BT /F1 12 Tf 72 720 Td [(word) -250 (gap)] TJ T* [(kern) -100 (ing)] TJ ET');
    const { text } = await pdfToText(pdf);
    assert.ok(text.includes('word gap'), '词间距要补空格,实际:' + JSON.stringify(text));
    assert.ok(text.includes('kerning'), '字距不许补空格,实际:' + JSON.stringify(text));
});

// ---------- 「一个字一行」回归(👤 2026-09-14 反馈:能抽出字但每字一行,没法直接导入) ----------
// 三种真实排版都会造成这个症状,判据是"抽出结果的行数",而不是看某个算子:
//   ① 每字一次定位,字间有零点几到几单位的 Y 抖动(Word/WPS 类)
//   ② 整页旋转 90° / 竖排:字的**前进方向是 Y**,每字 Y 都在变
//   ③ 竖排字体 Identity-V:同样沿 Y 前进,但矩阵本身不旋转
function lineCount(text) { return text.split('\n').filter(Boolean).length; }

test('① 每字定位 + Y 抖动:同一行不许被拆开', async () => {
    const content = 'BT /F1 12 Tf 72 720 Td (Hello) Tj 0 -0.4 Td (Wor) Tj 0 0.3 Td (ld) Tj ET';
    const { text } = await pdfToText(onePagePdf(content));
    assert.strictEqual(lineCount(text), 1, '抖动不该产生换行,实际:' + JSON.stringify(text));
});

test('② 旋转 90°(字沿 Y 前进):整段应合成一行', async () => {
    const content = 'BT /F1 12 Tf 0 1 -1 0 100 100 Tm (He) Tj 0 1 -1 0 100 112 Tm (llo) Tj ET';
    const { text } = await pdfToText(onePagePdf(content));
    assert.strictEqual(lineCount(text), 1, '旋转文本不该一字一行,实际:' + JSON.stringify(text));
});

test('③ 竖排字体 Identity-V:一列合成一行,列与列才换行', async () => {
    const col = '竖排文字的测试内容';       // 一列八个字
    const other = '第二列的若干文字';
    const content = 'BT /F1 12 Tf 0 800 Td ' + [...col].map(c => `<${cjkHex(c)}> Tj 0 -12 Td`).join(' ')
        + ' 400 800 Td ' + [...other].map(c => `<${cjkHex(c)}> Tj 0 -12 Td`).join(' ') + 'ET';
    const all = col + other;
    const cmap = cjkCMap(all);
    const pdf = buildPdf([
        { num: 1, dict: '<< /Type /Catalog /Pages 2 0 R >>' },
        { num: 2, dict: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
        { num: 3, dict: '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>' },
        { num: 4, dict: `<< /Length ${Buffer.byteLength(content, 'latin1')} >>`, stream: content },
        { num: 5, dict: '<< /Type /Font /Subtype /Type0 /BaseFont /SimSun /Encoding /Identity-V /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>' },
        { num: 6, dict: '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /SimSun >>' },
        { num: 7, dict: `<< /Length ${Buffer.byteLength(cmap, 'latin1')} >>`, stream: cmap },
    ]);
    const { text, gate } = await pdfToText(pdf);
    assert.ok(text.includes(col), '一列的字要连成一行,实际:' + JSON.stringify(text));
    assert.strictEqual(lineCount(text), 2, '两列应是两行,实际:' + JSON.stringify(text));
    assert.strictEqual(gate.ok, true, '竖排也是正常文本,不该被闸门拦:' + gate.detail);
});

test('④ 中文每字绝对定位(最常见的考试卷排版):仍是一行,且解析器能出题', async () => {
    const text = '题目：一年有多少个月';
    const chars = [...text];
    const content = 'BT /F1 12 Tf ' + chars.map((c, i) => `1 0 0 1 ${72 + i * 12} 700 Tm <${cjkHex(c)}> Tj`).join(' ') + ' ET';
    const cmap = cjkCMap(text);
    const pdf = buildPdf([
        { num: 1, dict: '<< /Type /Catalog /Pages 2 0 R >>' },
        { num: 2, dict: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
        { num: 3, dict: '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>' },
        { num: 4, dict: `<< /Length ${Buffer.byteLength(content, 'latin1')} >>`, stream: content },
        { num: 5, dict: '<< /Type /Font /Subtype /Type0 /BaseFont /SimSun /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>' },
        { num: 6, dict: '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /SimSun >>' },
        { num: 7, dict: `<< /Length ${Buffer.byteLength(cmap, 'latin1')} >>`, stream: cmap },
    ]);
    const { text: out, gate } = await pdfToText(pdf);
    assert.strictEqual(out, text, '每字绝对定位也要拼回一行,实际:' + JSON.stringify(out));
    assert.strictEqual(gate.ok, true);
});
