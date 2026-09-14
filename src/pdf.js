// ==================== PDF 文本抽取(零依赖)====================
// 职责:PDF 文件字节 -> 纯文本 + 质量判定,供导入管道复用 parser。
// 允许:DecompressionStream / Blob / Response 等浏览器原生 API(docx.js 同一套路)。
// 禁止:document / localStorage / state / parser —— 本模块必须是**纯函数**,可单测。
//
// 为什么自研而不引 pdf.js:项目铁律是零依赖零构建(见 继续开发Zquiz.md 第三节)。
// 我们只需要"文字版 PDF 的文本",不需要渲染、不需要矢量图形、不需要精确排版:
//   ① 不看 xref(它最常损坏) —— 直接扫 `N G obj … endobj`;
//   ② 解 FlateDecode 用平台自带 DecompressionStream(zlib 流 = 'deflate');
//   ③ 内容流里只认文本算子(Tj / TJ / ' / "),按 Td/TD/T*/Tm 的 Y 变化断行;
//   ④ 编码靠字体自己的 ToUnicode CMap(中文 CID 字体**没有它就必然是乱码**)。
// 抽不准的情况(扫描件 / 字体没带映射)不硬编 —— 交给 pdfGate 判定后回退到人工两条路。
//
// ⚠️ 与 docx.js 的分工:docx 是结构化的 XML,PDF 是一堆字节流。这里所有函数都是
//    "字节进、文本出",不碰 DOM,也不依赖调用方的任何状态。

const PDF_MAGIC = '%PDF-';
const MAX_BYTES = 64 * 1024 * 1024;      // 防御:超大文件直接拒(手机内存有限)
const MAX_OBJECTS = 200000;              // 防御:畸形文件别把扫描拖成死循环

// ---------- 基础工具 ----------

// 字节 -> latin1 字符串。**不能用 TextDecoder**:PDF 的字节不是 UTF-8,
// 我们要的是"一个字节 = 一个码位"的可索引视图,解析完再按各自编码还原。
export function bytesToLatin1(bytes) {
    let out = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return out;
}

function latin1ToBytes(str) {
    const bytes = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i) & 0xff;
    return bytes;
}

// PDF 里的十六进制串 / CMap 目标串:4 个 hex 位 = 一个 UTF-16 码元
function hexToUnicode(hex) {
    let out = '';
    for (let i = 0; i + 3 < hex.length; i += 4) {
        out += String.fromCharCode(parseInt(hex.substr(i, 4), 16));
    }
    return out;
}

// ---------- 轻量 PDF 对象解析 ----------
// 只实现我们真正要用的类型:名字 / 数字 / 字符串 / 数组 / 字典 / 间接引用。
// 用**手写递归下降**而不是正则:字典与数组会嵌套,正则一定会把边界切错。

const WHITESPACE = new Set(['\x00', '\t', '\n', '\f', '\r', ' ']);

function skipWs(s, i) {
    while (i < s.length) {
        const c = s[i];
        if (WHITESPACE.has(c)) { i++; continue; }
        if (c === '%') {                                  // 注释到行尾
            while (i < s.length && s[i] !== '\n' && s[i] !== '\r') i++;
            continue;
        }
        break;
    }
    return i;
}

function readName(s, i) {
    i++;                                                  // 跳过 '/'
    let name = '';
    while (i < s.length && !WHITESPACE.has(s[i]) && !'()<>[]{}/%'.includes(s[i])) name += s[i++];
    return { value: { name }, pos: i };
}

function readLiteralString(s, i) {
    i++;                                                  // 跳过 '('
    let depth = 1;
    const out = [];
    while (i < s.length) {
        const c = s[i++];
        if (c === '\\') {
            const n = s[i++];
            if (n === 'n') out.push('\n');
            else if (n === 'r') out.push('\r');
            else if (n === 't') out.push('\t');
            else if (n === 'b') out.push('\b');
            else if (n === 'f') out.push('\f');
            else if (n === '\n') { /* 续行:反斜杠+换行 = 什么都不加 */ }
            else if (n >= '0' && n <= '7') {               // 八进制(最多三位)
                let oct = n;
                while (oct.length < 3 && s[i] >= '0' && s[i] <= '7') oct += s[i++];
                out.push(String.fromCharCode(parseInt(oct, 8) & 0xff));
            }
            else if (n !== undefined) out.push(n);
            continue;
        }
        if (c === '(') { depth++; out.push(c); continue; }
        if (c === ')') { depth--; if (depth === 0) break; out.push(c); continue; }
        out.push(c);
    }
    return { value: { str: out.join('') }, pos: i };
}

function readHexString(s, i) {
    i++;                                                  // 跳过 '<'
    let hex = '';
    while (i < s.length && s[i] !== '>') {
        const c = s[i++];
        if (/[0-9a-fA-F]/.test(c)) hex += c;
    }
    if (hex.length % 2) hex += '0';
    return { value: { str: hexToLatin1(hex) }, pos: i + 1 };
}

function hexToLatin1(hex) {
    let out = '';
    for (let i = 0; i + 1 < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
    return out;
}

function readNumber(s, i) {
    let raw = '';
    while (i < s.length && /[+\-.0-9]/.test(s[i])) raw += s[i++];
    return { value: { num: parseFloat(raw) }, pos: i };
}

// 递归下降:返回 { value, pos }。value 形如
//   { name } | { num } | { str } | { ref:{num,gen} } | [..] | { dict:{...} } | true/false/null
export function parsePdfValue(s, start = 0) {
    let i = skipWs(s, start);
    if (i >= s.length) return { value: null, pos: i };
    const c = s[i];
    if (c === '/') return readName(s, i);
    if (c === '(') return readLiteralString(s, i);
    if (c === '<') {
        if (s[i + 1] === '<') {                           // 字典
            i = skipWs(s, i + 2);
            const dict = {};
            while (i < s.length && !(s[i] === '>' && s[i + 1] === '>')) {
                if (s[i] === '/') {
                    const k = readName(s, i);
                    const v = parsePdfValue(s, k.pos);
                    dict[k.value.name] = v.value;
                    i = v.pos;
                } else {
                    i = skipWs(s, i + 1);                     // 畸形内容:跳过继续
                }
            }
            return { value: { dict }, pos: i + 2 };
        }
        return readHexString(s, i);
    }
    if (c === '[') {
        i = skipWs(s, i + 1);
        const arr = [];
        while (i < s.length && s[i] !== ']') {
            const v = parsePdfValue(s, i);
            arr.push(v.value);
            if (v.pos <= i) { i++; continue; }             // 防御:不前进就手动前进
            i = skipWs(s, v.pos);
        }
        return { value: arr, pos: i + 1 };
    }
    if (/[+\-.0-9]/.test(c)) {
        const n = readNumber(s, i);
        // `12 0 R` = 间接引用(数字 + 数字 + R)
        if (Number.isInteger(n.value.num)) {
            const save = i;
            let j = skipWs(s, n.pos);
            if (/[0-9]/.test(s[j] || '')) {
                const gen = readNumber(s, j);
                const k = skipWs(s, gen.pos);
                if (s[k] === 'R') {
                    return { value: { ref: { num: n.value.num, gen: gen.value.num } }, pos: k + 1 };
                }
            }
            return { value: n.value, pos: save === i ? n.pos : n.pos };
        }
        return { value: n.value, pos: n.pos };
    }
    if (s.startsWith('true', i)) return { value: true, pos: i + 4 };
    if (s.startsWith('false', i)) return { value: false, pos: i + 5 };
    if (s.startsWith('null', i)) return { value: null, pos: i + 4 };
    return { value: null, pos: i + 1 };                    // 认不出来的:跳过一个字符
}

// 取字典里的键(名字值 -> 'FlateDecode')
function nameOf(v) {
    return v && typeof v === 'object' && typeof v.name === 'string' ? v.name : null;
}
function numberOf(v) {
    return v && typeof v === 'object' && typeof v.num === 'number' ? v.num : null;
}
function dictOf(v) {
    return v && typeof v === 'object' && v.dict ? v.dict : null;
}
function arrayOf(v) {
    return Array.isArray(v) ? v : null;
}
function refNumOf(v) {
    return v && typeof v === 'object' && v.ref ? v.ref.num : null;
}

// ---------- 对象扫描(不看 xref) ----------

// 扫描 `N G obj … endobj`;返回 Map<objNum, {num, dict, streamStart, streamEnd, raw}>
// ⚠️ 不看 xref 表是**故意**的:真实世界的坏 PDF 十有八九坏在 xref,
//    而对象本身通常还在文件里,按关键字扫反而更耐用。
export function scanObjects(latin1) {
    const objects = new Map();
    const re = /(\d{1,7})\s+(\d{1,5})\s+obj\b/g;
    let m;
    let count = 0;
    while ((m = re.exec(latin1)) !== null) {
        if (++count > MAX_OBJECTS) break;
        const num = parseInt(m[1], 10);
        const bodyStart = m.index + m[0].length;
        const endIdx = latin1.indexOf('endobj', bodyStart);
        const bodyEnd = endIdx === -1 ? latin1.length : endIdx;
        const body = latin1.slice(bodyStart, bodyEnd);

        // 流对象:字典后面紧跟 `stream`
        let streamStart = -1;
        const sMatch = /(^|[\s>])stream(\r\n|\r|\n)/.exec(body);
        let dictText = body;
        if (sMatch) {
            dictText = body.slice(0, sMatch.index + (sMatch[1] ? 1 : 0));
            streamStart = bodyStart + sMatch.index + sMatch[0].length;
        }
        const parsed = parsePdfValue(dictText, 0);
        const dict = dictOf(parsed.value) || {};
        let streamEnd = -1;
        if (streamStart >= 0) {
            // /Length 先信,但要**验证**:按它切完之后紧跟的应该是 endstream。
            // 不验证的话,一个写小的 /Length 会把流截断(实测:ToUnicode 表被切掉一半 → 中文全成乱码),
            // 而写大的 /Length 又会让流里混进后面的对象。验证不过就退回"扫 endstream"。
            const declared = numberOf(dict.Length);
            if (declared !== null && declared > 0 && streamStart + declared <= latin1.length
                && /^[\r\n]*endstream/.test(latin1.slice(streamStart + declared, streamStart + declared + 16))) {
                streamEnd = streamStart + declared;
            } else {
                const e = latin1.indexOf('endstream', streamStart);
                streamEnd = e === -1 ? bodyEnd : e;
            }
            // 🚨 这里**绝对不能**剪掉"尾部换行":流数据的最后一个字节本身可能就是 0x0A
            //    (zlib 校验和末字节经常正好是 0x0A)。曾经在这里剪过 —— 实测把一份正常 PDF 的
            //    ToUnicode 表剪短一个字节,inflate 报 "unexpected end of file",于是那几个字
            //    全变成 Latin-1 乱码(👤 看到的"内容乱套"里就有这一层的贡献)。
            //    真要处理"endstream 前的换行",交给 decodeStream 的多种切法去试。
        }
        // ⚠️ 除 dict 外还要留 value:PDF 里 `12 0 obj 133 endobj` 这种"裸数字对象"到处都是
        //    (`/Length 3 0 R` 就指向它),只留 dict 的话间接长度永远解析不出来
        objects.set(num, { num, value: parsed.value, dict, streamStart, streamEnd, raw: body });
        re.lastIndex = endIdx === -1 ? latin1.length : endIdx;
    }
    return objects;
}

// 扫描期只能处理**直接数字**的 /Length;间接的(`/Length 3 0 R`)要等所有对象都扫完再回头精修。
// 真实文件里间接长度非常常见(实测 W3C 的 dummy.pdf 就是),不修的话流会多切/少切几个字节,
// zlib 直接报错 → 表现成"这份 PDF 读不出文字"。
function resolveNumber(v, objects) {
    const direct = numberOf(v);
    if (direct !== null) return direct;
    const n = refNumOf(v);
    if (n === null) return null;
    const target = objects.get(n);
    return target ? numberOf(target.value) : null;
}

export function refineStreamBounds(latin1, objects) {
    let fixed = 0;
    for (const obj of objects.values()) {
        if (obj.streamStart < 0) continue;
        if (numberOf(obj.dict.Length) !== null) continue;      // 直接数字:扫描期已定
        const len = resolveNumber(obj.dict.Length, objects);
        if (len === null || len <= 0) continue;
        const end = obj.streamStart + len;
        if (end <= latin1.length && /^[\r\n]*endstream/.test(latin1.slice(end, end + 16))) {
            obj.streamEnd = end;
            fixed++;
        }
    }
    return fixed;
}

// 解流:按 /Filter 依次处理。返回 Uint8Array;不支持的类型返回 null(调用方跳过)。
export async function decodeStream(latin1, streamStart, streamEnd, dict) {
    if (streamStart < 0 || streamEnd <= streamStart) return null;
    const raw = latin1.slice(streamStart, streamEnd);
    const filters = [];
    const f = dict && dict.Filter;
    if (f) {
        const arr = arrayOf(f);
        if (arr) arr.forEach(x => { const n = nameOf(x); if (n) filters.push(n); });
        else { const n = nameOf(f); if (n) filters.push(n); }
    }
    // 对不认识的过滤器直接放弃 —— 宁可少抽,不要吐垃圾
    if (filters.some(n => !['FlateDecode', 'Fl', 'ASCIIHexDecode', 'AHx', 'ASCII85Decode', 'A85'].includes(n))) return null;

    // 🚨 两种切法都试:按 endstream 兜底时,数据尾部的 0x0A **可能本身就是数据**
    //    (zlib 校验和正好以 0x0A 结尾),把它当"endstream 前的换行"切掉会让解压直接失败 ——
    //    真实文件上实测踩到过。所以先按原样解,失败再试去掉尾部换行的版本。
    const variants = [raw];
    const trimmed = raw.replace(/[\r\n]+$/, '');
    if (trimmed !== raw) variants.push(trimmed);
    // 再补一种:按字典里的 /Length 原样切(用来兜住"扫描兜底把流切短/切长"的情况)
    if (dict) {
        const declared = numberOf(dict.Length);
        if (declared !== null && declared > 0 && declared !== raw.length && streamStart + declared <= latin1.length) {
            variants.push(latin1.slice(streamStart, streamStart + declared));
        }
    }
    for (const candidate of variants) {
        try {
            let data = latin1ToBytes(candidate);
            for (const name of filters) {
                if (name === 'FlateDecode' || name === 'Fl') data = await inflate(data);
                else if (name === 'ASCIIHexDecode' || name === 'AHx') data = asciiHexDecode(data);
                else if (name === 'ASCII85Decode' || name === 'A85') data = ascii85Decode(data);
            }
            return data;
        } catch (e) { /* 换下一种切法 */ }
    }
    return null;
}

// 字典值可能是间接引用(`/Font 10 0 R`),要能解一层
function dictOfResolved(v, objects) {
    const n = refNumOf(v);
    if (n !== null) {
        const o = objects.get(n);
        return o ? (o.dict || dictOf(o.value)) : null;
    }
    return dictOf(v);
}

async function inflate(bytes) {
    const DS = globalThis.DecompressionStream;
    if (typeof DS !== 'function') throw new Error('当前环境不支持解压 PDF 数据流');
    const run = async (format) => {
        const stream = new Blob([bytes]).stream().pipeThrough(new DS(format));
        return new Uint8Array(await new Response(stream).arrayBuffer());
    };
    try {
        return await run('deflate');                       // PDF 的 FlateDecode 是 zlib 包装
    } catch (e) {
        return await run('deflate-raw');                   // 少数工具吐裸 deflate
    }
}

function asciiHexDecode(bytes) {
    const s = bytesToLatin1(bytes);
    let hex = '';
    for (const c of s) {
        if (c === '>') break;
        if (/[0-9a-fA-F]/.test(c)) hex += c;
    }
    if (hex.length % 2) hex += '0';
    return latin1ToBytes(hexToLatin1(hex));
}

function ascii85Decode(bytes) {
    const s = bytesToLatin1(bytes).replace(/\s/g, '');
    const out = [];
    let i = s.startsWith('<~') ? 2 : 0;
    while (i < s.length) {
        if (s[i] === '~' && s[i + 1] === '>') break;
        if (s[i] === 'z') { out.push(0, 0, 0, 0); i++; continue; }
        const group = [];
        while (group.length < 5 && i < s.length && s[i] !== '~' && !/\s/.test(s[i])) {
            const c = s.charCodeAt(i++);
            if (c < 33 || c > 117) break;
            group.push(c - 33);
        }
        if (!group.length) break;
        const pad = 5 - group.length;
        for (let k = 0; k < pad; k++) group.push(84);
        let value = 0;
        for (const g of group) value = value * 85 + g;
        const b = [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
        for (let k = 0; k < 4 - pad; k++) out.push(b[k]);
    }
    return new Uint8Array(out);
}

// ---------- 对象流(ObjStm):现代的 PDF 常把字典/数组藏在这里 ----------
// /Type /ObjStm + /N 个数 + /First 头部长;头部的 N 对 (objnum offset) 之后才是对象正文。
export async function expandObjectStreams(latin1, objects) {
    const extra = new Map();
    for (const obj of objects.values()) {
        if (nameOf(obj.dict.Type) !== 'ObjStm') continue;
        const data = await decodeStream(latin1, obj.streamStart, obj.streamEnd, obj.dict).catch(() => null);
        if (!data) continue;
        const text = bytesToLatin1(data);
        const n = numberOf(obj.dict.N) || 0;
        const first = numberOf(obj.dict.First) || 0;
        const header = text.slice(0, first).trim().split(/\s+/).map(Number);
        for (let i = 0; i < n; i++) {
            const objNum = header[i * 2];
            const offset = header[i * 2 + 1];
            if (!Number.isFinite(objNum) || !Number.isFinite(offset)) break;
            const from = first + offset;
            const to = i + 1 < n ? first + header[(i + 1) * 2 + 1] : text.length;
            const body = text.slice(from, to);
            const parsed = parsePdfValue(body, 0);
            extra.set(objNum, { num: objNum, value: parsed.value, dict: dictOf(parsed.value) || {}, streamStart: -1, streamEnd: -1, raw: body, fromObjStm: true });
        }
    }
    for (const [k, v] of extra) if (!objects.has(k)) objects.set(k, v);
    return extra;
}

// ---------- ToUnicode CMap:中文能不能读出来全靠它 ----------

// 解析 bfchar / bfrange。返回 Map<码位, 字符串>
export function parseToUnicodeCMap(text) {
    const map = new Map();
    const bfcharRe = /beginbfchar([\s\S]*?)endbfchar/g;
    let m;
    while ((m = bfcharRe.exec(text)) !== null) {
        const pairRe = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g;
        let p;
        while ((p = pairRe.exec(m[1])) !== null) {
            map.set(parseInt(p[1], 16), hexToUnicode(p[2]));
        }
    }
    const bfrangeRe = /beginbfrange([\s\S]*?)endbfrange/g;
    while ((m = bfrangeRe.exec(text)) !== null) {
        const body = m[1];
        // 形式一:<lo> <hi> <dst>
        const simpleRe = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g;
        let s;
        while ((s = simpleRe.exec(body)) !== null) {
            const lo = parseInt(s[1], 16), hi = parseInt(s[2], 16);
            const base = hexToUnicode(s[3]);
            for (let code = lo; code <= hi && code - lo < 65536; code++) {
                const last = base.charCodeAt(base.length - 1);
                map.set(code, base.slice(0, -1) + String.fromCharCode(last + (code - lo)));
            }
        }
        // 形式二:<lo> <hi> [<d1> <d2> …]
        const arrRe = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*\[([\s\S]*?)\]/g;
        let a;
        while ((a = arrRe.exec(body)) !== null) {
            const lo = parseInt(a[1], 16);
            const items = a[3].match(/<[0-9a-fA-F]+>/g) || [];
            items.forEach((item, idx) => map.set(lo + idx, hexToUnicode(item.slice(1, -1))));
        }
    }
    return map;
}

// ---------- 字体表:资源名 -> { isCid, cmap } ----------
// 字形宽度:用来算"这段字排完占多宽"。
// 🚨 为什么必须要宽度:两栏排版的卷子(选项 A|B 并排、C|D 并排)在 PDF 里就是同一行的
//    两段文字,不知道前一段占多宽就**判断不出中间那道空隙**,于是 "A.xxx B.yyy" 会粘成
//    "A.xxxB.yyy" —— 解析器只能认出两个选项(👤 的真文件就是这样)。有 /Widths / /W 就用真实值,
//    没有才退回按字符估算。
function widthsOf(d, objects) {
    const widths = new Map();                 // code -> em(1 = 一个字宽)
    let defaultEm = null;
    const arr = arrayOf(d.Widths);
    const first = numberOf(d.FirstChar);
    if (arr && first !== null) {
        arr.forEach((w, i) => {
            const v = numberOf(w);
            if (v !== null) widths.set(first + i, v / 1000);
        });
    }
    const desc = dictOfResolved(d.FontDescriptor, objects);
    const missing = desc ? numberOf(desc.MissingWidth) : null;
    if (missing !== null) defaultEm = missing / 1000;
    // Type3:宽度在字形空间,要乘 /FontMatrix 的 x 缩放(常见 .001)
    if (nameOf(d.Subtype) === 'Type3') {
        const fm = arrayOf(d.FontMatrix);
        const sx = (fm && numberOf(fm[0])) || 0.001;
        for (const [k, v] of widths) widths.set(k, v * (sx / 0.001));
    }
    // CID(Type0):宽度在后代字体的 /W 里;/DW 是默认(通常 1000)
    if (nameOf(d.Subtype) === 'Type0') {
        const descFonts = arrayOf(d.DescendantFonts) || [];
        const desc0 = dictOfResolved(descFonts[0], objects);
        const dw = desc0 ? numberOf(desc0.DW) : null;
        if (dw !== null) defaultEm = dw / 1000;
        const wArr = arrayOf(desc0 && desc0.W);
        if (wArr) {
            for (let i = 0; i < wArr.length;) {
                const c1 = numberOf(wArr[i]);
                if (c1 === null) { i++; continue; }
                const next = wArr[i + 1];
                const list = arrayOf(next);
                if (list) {
                    list.forEach((w, k) => { const v = numberOf(w); if (v !== null) widths.set(c1 + k, v / 1000); });
                    i += 2;
                } else {
                    const c2 = numberOf(next);
                    const w = numberOf(wArr[i + 2]);
                    if (c2 !== null && w !== null) {
                        for (let c = c1; c <= c2 && c - c1 < 65536; c++) widths.set(c, w / 1000);
                        i += 3;
                    } else i++;
                }
            }
        }
    }
    return { widths, defaultEm };
}

// 粗略估算(没有 /Widths 时):CJK/全角 1 em,其余 0.5 em
function estimateEm(ch) {
    const c = ch.codePointAt(0);
    if (c >= 0x1100 && (c <= 0x115F || (c >= 0x2E80 && c <= 0xA4CF) || (c >= 0xAC00 && c <= 0xD7A3)
        || (c >= 0xF900 && c <= 0xFAFF) || (c >= 0xFE30 && c <= 0xFE6F) || (c >= 0xFF00 && c <= 0xFF60)
        || (c >= 0xFFE0 && c <= 0xFFE6))) return 1;
    return 0.5;
}

// 字体条目按**对象号**解析一次(ToUnicode 解析有成本,别每页重来)
export async function buildFontEntries(latin1, objects) {
    const byNum = new Map();
    for (const obj of objects.values()) {
        const d = obj.dict;
        if (!d || nameOf(d.Type) !== 'Font') continue;
        const subtype = nameOf(d.Subtype);
        const isCid = subtype === 'Type0';
        let cmap = null;
        const toUniRef = refNumOf(d.ToUnicode);
        const toUni = toUniRef !== null ? objects.get(toUniRef) : null;
        if (toUni) {
            const data = await decodeStream(latin1, toUni.streamStart, toUni.streamEnd, toUni.dict).catch(() => null);
            if (data) cmap = parseToUnicodeCMap(bytesToLatin1(data));
        }
        // 竖排字体:PDF 用 `/Encoding /Identity-V`(或任何以 -V 结尾的编码名)声明"沿 Y 前进"。
        // 这类字体里每个字都是一次 `Td 0 -字号`,只按 Y 变化断行会得到"一个字一行"。
        const encName = nameOf(d.Encoding);
        const vertical = !!encName && /-V$/.test(encName);
        byNum.set(obj.num, { isCid, cmap, hasToUnicode: !!cmap, subtype, vertical, ...widthsOf(d, objects) });
    }
    return byNum;
}

// 把某一页的 /Resources 里 `/Font << /F1 12 0 R >>` 链接成"资源名 → 字体条目"。
// 🚨 必须**按页**建:同一份文件里不同页可以把 `/F1` 指到不同字体,用一张全局表的话
//    后读到的那份会覆盖前面 —— 表现就是"某些页的文字整段乱码"(👤 报的"内容乱套")。
export function linkPageFonts(resDict, objects, entries, out = new Map()) {
    // ⚠️ 真实文件里 /Font 常是间接引用(`/Font 10 0 R` → `<< /F1 9 0 R >>`)
    const fonts = dictOfResolved(resDict && resDict.Font, objects);
    if (!fonts) return out;
    for (const key of Object.keys(fonts)) {
        const n = refNumOf(fonts[key]);
        if (n !== null && entries.has(n)) out.set(key, entries.get(n));
    }
    return out;
}

// 页面的 /Resources 可以**继承**自祖先后代(页自己没有就往上找 /Parent)
export function inheritedResources(pageObj, objects) {
    let cur = pageObj;
    for (let depth = 0; cur && depth < 32; depth++) {
        const res = dictOfResolved(cur.dict.Resources, objects);
        if (res) return res;
        const parentNum = refNumOf(cur.dict.Parent);
        cur = parentNum !== null ? objects.get(parentNum) : null;
    }
    return null;
}

// 页面顺序:按页树 /Kids 走,而不是"对象在文件里的顺序"
// 🚨 文件里对象的物理顺序与阅读顺序**无关**,直接按对象号遍历会把页序打乱(👤 报的"内容乱套")。
export function pageOrder(objects) {
    const order = [];
    const seen = new Set();
    const walk = (num, depth) => {
        if (num === null || num === undefined || seen.has(num) || depth > 32) return;
        seen.add(num);
        const o = objects.get(num);
        if (!o || !o.dict) return;
        if (nameOf(o.dict.Type) === 'Page') { order.push(num); return; }
        for (const kid of arrayOf(o.dict.Kids) || []) walk(refNumOf(kid), depth + 1);
    };
    const catalog = [...objects.values()].find(o => nameOf(o.dict.Type) === 'Catalog');
    if (catalog) walk(refNumOf(catalog.dict.Pages), 0);
    // 兜底:页树里没走到的 Page(结构损坏)按对象号追加 —— 宁可顺序差,不能丢页
    const rest = [...objects.values()]
        .filter(o => nameOf(o.dict.Type) === 'Page' && !seen.has(o.num))
        .map(o => o.num)
        .sort((a, b) => a - b);
    return order.concat(rest);
}

// ---------- 图形状态(CTM) ----------
// 🚨 这一节是"内容乱套"的真解:很多转换工具会给**每个字**套一层
//    `q … cm(平移=这个字在页面上的位置) … BT/Tm/Td/Tj … Q`,
//    真正的位置在 cm 里,文本矩阵里的 Td 反而只是字内部的小偏移。
//    不跟踪 cm 的话,整页的字都会塌到同一两个"Y 值"上 —— 表现就是"内容直接乱套"。
const IDENTITY_MAT = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

function mulMat(m, n) {                       // m 之后接 n:m × n
    return {
        a: m.a * n.a + m.b * n.c,
        b: m.a * n.b + m.b * n.d,
        c: m.c * n.a + m.d * n.c,
        d: m.c * n.b + m.d * n.d,
        e: m.e * n.a + m.f * n.c + n.e,
        f: m.e * n.b + m.f * n.d + n.f,
    };
}
function applyMat(m, x, y) {                  // 点:含平移
    return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
}
function applyVec(m, x, y) {                  // 向量:不含平移
    return { x: m.a * x + m.c * y, y: m.b * x + m.d * y };
}

// ---------- 内容流:抽文本 ----------
// 🚨 这里**不能**"看到 Y 变了就换行" —— 真实 PDF 的排版方式五花八门:
//   · 每个字一次 `Td`/`Tm` 定位(Word/WPS 类),字与字之间有 0.5~2 单位的抖动;
//   · 竖排 / 整页旋转 90° 的扫描件,字的**前进方向是 Y**,每字 Y 都变;
//   · 真正换行时又是整个文本矩阵平移。
//   所以先按算子收集**文本片段(run)**,带上它的起点与**前进方向**(来自文本矩阵 a,b),
//   再按"垂直于前进方向的坐标 = 哪一行"分组。这样上面三种排版都能归成正确的行。
//   ⚠️ 空格**只认**文本里的空格字符与 TJ 位移:没有 /Widths 就算不出片段之间的真实间隙,
//      按起点距离补空格会把英文词切开(实测 "Dummy" → "Dumm y")。
export function collectRuns(content, fontTable = { byName: new Map() }) {
    const runs = [];
    let ctm = IDENTITY_MAT;                              // 当前图形状态矩阵
    const ctmStack = [];
    let tm = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };   // 文本矩阵
    let tlm = { e: 0, f: 0 };                            // 行矩阵(Td/TD/T* 相对它移动)
    let leading = 0;                                     // TL
    let size = 12;                                       // 未声明 Tf 时的保守默认
    let font = null;
    let forced = false;                                  // 下一个片段是否强制另起一行(T* / ' / ")
    let pendingTjGap = false;                            // TJ 里刚出现一个大位移

    // 交互过的一行文字宽度(em):有 /Widths 用真实值,没有才按字符估算
    const emWidthOf = (raw) => {
        const f = font;
        let em = 0;
        if (f && f.widths) {
            if (f.isCid) {
                for (let i = 0; i + 1 < raw.length; i += 2) {
                    const code = (raw.charCodeAt(i) << 8) | raw.charCodeAt(i + 1);
                    em += f.widths.has(code) ? f.widths.get(code) : (f.defaultEm !== null ? f.defaultEm : 0.5);
                }
                if (raw.length % 2) em += 0.5;
            } else {
                for (let i = 0; i < raw.length; i++) {
                    const code = raw.charCodeAt(i);
                    em += f.widths.has(code) ? f.widths.get(code) : (f.defaultEm !== null ? f.defaultEm : estimateEm(String.fromCharCode(code)));
                }
            }
            return em;
        }
        for (const ch of raw) em += estimateEm(ch);
        return em;
    };
    const pushRun = (text, advanceEm = null) => {
        if (!text) return;
        // 设备坐标 = CTM × 文本矩阵;前进方向与"换行方向"都取设备空间的向量
        const scale = Math.hypot(tm.a, tm.b) || 1;       // 文本矩阵自身的缩放(通常 1)
        const origin = applyMat(ctm, tm.e, tm.f);
        const adv = applyVec(ctm, tm.a / scale, tm.b / scale);
        const down = applyVec(ctm, tm.c / scale, tm.d / scale);
        const advLen = Math.hypot(adv.x, adv.y) || 1;
        const advX = adv.x / advLen;
        const advY = adv.y / advLen;
        let sx = -down.x, sy = -down.y;
        const sl = Math.hypot(sx, sy);
        if (sl < 1e-6) { sx = 0; sy = -1; } else { sx /= sl; sy /= sl; }
        const effSize = size * scale * advLen;           // 折算成设备尺寸
        const em = advanceEm === null ? emWidthOf(text) : advanceEm;
        const measured = !!(font && font.widths && (font.widths.size || font.defaultEm !== null));
        const along = origin.x * advX + origin.y * advY;
        const stack = origin.x * sx + origin.y * sy;
        runs.push({
            text,
            x: origin.x, y: origin.y,
            advX, advY,
            stackCoord: stack,                           // 沿"换行方向":横排=第几行,竖排=列内次序
            alongCoord: along,                           // 沿"前进方向":横排=行内次序,竖排=第几列
            advEnd: along + em * effSize,                // 这段字排完,笔走到哪
            measured,                                    // 宽度是真实 /Widths 还是估算
            tjGap: pendingTjGap,                         // 紧跟在 TJ 大位移后面(那是明确的空隙)
            size: effSize,
            forced,
            vertical: !!(font && font.vertical),
        });
        forced = false;
        pendingTjGap = false;
        // 笔前进(文本空间):Tj 之后的位置 = 之前 + 宽度 × 字号
        const walk = em * size;
        tm.e += walk * tm.a;
        tm.f += walk * tm.b;
    };
    const tlNextLine = () => { tlm.f -= leading; tm.e = tlm.e; tm.f = tlm.f; };

    const decodeString = (raw) => {
        const f = font;
        if (!f) return raw;                                // 不知道字体:按单字节原样出(latin1)
        if (f.cmap && f.cmap.size) {
            let out = '';
            if (f.isCid) {
                for (let i = 0; i + 1 < raw.length; i += 2) {
                    const code = (raw.charCodeAt(i) << 8) | raw.charCodeAt(i + 1);
                    out += f.cmap.has(code) ? f.cmap.get(code) : '\uFFFD';
                }
                if (raw.length % 2) out += '\uFFFD';
            } else {
                for (let i = 0; i < raw.length; i++) {
                    const code = raw.charCodeAt(i);
                    out += f.cmap.has(code) ? f.cmap.get(code) : '\uFFFD';
                }
            }
            return out;
        }
        if (f.isCid) {
            // CID 字体没带 ToUnicode:抽出来必是乱码,用替换符标记,交给闸门判定
            return '\uFFFD'.repeat(Math.ceil(raw.length / 2));
        }
        return cp1252ToUnicode(raw);
    };

    const tokens = tokenizeContent(content);
    const operands = [];
    for (const t of tokens) {
        if (t.type !== 'op') { operands.push(t); continue; }
        const last = () => operands[operands.length - 1];
        const numAt = (i) => {
            const v = operands[operands.length - 1 - i];
            return v && typeof v.num === 'number' ? v.num : null;
        };
        switch (t.value) {
            case 'q':
                ctmStack.push(ctm);
                break;
            case 'Q':
                ctm = ctmStack.length ? ctmStack.pop() : IDENTITY_MAT;
                break;
            case 'cm': {
                const f = numAt(0), e = numAt(1), d = numAt(2), c = numAt(3), b = numAt(4), a = numAt(5);
                if ([a, b, c, d, e, f].every(v => typeof v === 'number')) ctm = mulMat({ a, b, c, d, e, f }, ctm);
                break;
            }
            case 'BT':
                tm = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
                tlm = { e: 0, f: 0 };
                break;
            case 'Tf': {
                const sizeNum = numAt(0);
                const nameTok = operands[operands.length - 2];
                if (typeof sizeNum === 'number' && sizeNum > 0) size = sizeNum;
                if (nameTok && nameTok.name) font = fontTable.byName.get(nameTok.name) || null;
                break;
            }
            case 'TL': {
                const v = numAt(0);
                if (typeof v === 'number') leading = v;
                break;
            }
            case 'Td':
            case 'TD': {
                const ty = numAt(0);
                const tx = numAt(1);
                if (typeof tx === 'number') tlm.e += tx;
                if (typeof ty === 'number') tlm.f += ty;
                if (t.value === 'TD' && typeof ty === 'number') leading = -ty;
                tm.e = tlm.e; tm.f = tlm.f;
                break;
            }
            case 'T*':
                forced = true;
                tlNextLine();
                break;
            case 'Tm': {
                const f = numAt(0), e = numAt(1), d = numAt(2), c = numAt(3), b = numAt(4), a = numAt(5);
                if ([a, b, c, d, e, f].every(v => typeof v === 'number')) {
                    tm = { a, b, c, d, e, f };
                    tlm = { e, f };
                }
                break;
            }
            case 'Tj':
                if (last() && typeof last().str === 'string') pushRun(decodeString(last().str), emWidthOf(last().str));
                break;
            case "'":
                forced = true;
                tlNextLine();
                if (last() && typeof last().str === 'string') pushRun(decodeString(last().str), emWidthOf(last().str));
                break;
            case '"':
                forced = true;
                tlNextLine();
                if (last() && typeof last().str === 'string') pushRun(decodeString(last().str), emWidthOf(last().str));
                break;
            case 'TJ': {
                const arr = (last() && last().items) || [];
                for (const item of arr) {
                    if (typeof item.str === 'string') pushRun(decodeString(item.str), emWidthOf(item.str));
                    // TJ 的数字是 1/1000 em 的位移:推进笔,由"空隙判据"决定要不要补空格
                    // (阈值 -200 那种做法太糙:它既不知道前一段有多宽,也不知道后面从哪开始)
                    else if (typeof item.num === 'number') {
                        const walk = -(item.num / 1000) * size;
                        tm.e += walk * tm.a;
                        tm.f += walk * tm.b;
                        // 250 以上才算"词间距"(字距一般 ≤150);给它一个标记,后面按 true 补空格
                        if (item.num < -200) pendingTjGap = true;
                    }
                }
                break;
            }
            default:
                break;
        }
        operands.length = 0;
    }
    return runs;
}

export function extractTextFromContent(content, fontTable = { byName: new Map() }) {
    return runsToText(collectRuns(content, fontTable));
}

// 片段 → 文本:按"垂直于前进方向的坐标"分行,行内按前进方向排序
function runsToText(runs) {
    const lines = [];
    let cur = null;
    for (const r of runs) {
        // 分组轴:横排看"第几行"(stackCoord),竖排看"第几列"(alongCoord)
        const key = r.vertical ? r.alongCoord : r.stackCoord;
        const tol = Math.max(0.5, Math.abs(r.size) * 0.35);
        const turned = cur && (Math.abs(r.advX - cur.advX) > 0.2 || Math.abs(r.advY - cur.advY) > 0.2);
        if (!cur || r.forced || turned || cur.vertical !== r.vertical
            || Math.abs(key - (cur.vertical ? cur.alongCoord : cur.stackCoord)) > tol) {
            cur = { alongCoord: r.alongCoord, stackCoord: r.stackCoord, advX: r.advX, advY: r.advY, vertical: r.vertical, parts: [] };
            lines.push(cur);
        }
        cur.parts.push(r);
    }
    // 行内次序:横排按前进方向,竖排按自上而下
    for (const l of lines) {
        l.parts.sort((a, b) => (l.vertical ? a.stackCoord - b.stackCoord : a.alongCoord - b.alongCoord));
    }
    // 行与行:按分组轴升序(横排 = 自上而下;竖排 = 从左到右)
    lines.sort((a, b) => (a.vertical ? a.alongCoord - b.alongCoord : a.stackCoord - b.stackCoord));

    // 行内空隙补空格(两栏选项 / 表格单元格靠它分开)。
    // ⚠️ 只在**真实宽度**之间补(没 /Widths 时估出来的宽度会把英文词切开),或者空隙本身就来自 TJ 位移。
    const SEP_EM = 0.2;
    const out = [];
    for (const l of lines) {
        let line = '';
        let prev = null;
        for (const r of l.parts) {
            if (!l.vertical && prev) {
                const gap = r.alongCoord - prev.advEnd;
                const known = (prev.measured && r.measured) || r.tjGap;
                if (known && gap > SEP_EM * Math.max(prev.size, r.size)
                    && !/\s$/.test(line) && !/^\s/.test(r.text)) line += ' ';
            }
            line += r.text;
            prev = r;
        }
        out.push(line);
    }
    return out.join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// 内容流词法:只切出我们关心的东西(字符串 / 数字 / 名字 / 数组 / 算子)
function tokenizeContent(s) {
    const tokens = [];
    const stack = [];                                      // 数组嵌套
    let i = 0;
    const pushOperand = (tok) => {
        if (stack.length) stack[stack.length - 1].push(tok);
        else tokens.push(tok);
    };
    while (i < s.length) {
        const c = s[i];
        if (c === '%') { while (i < s.length && s[i] !== '\n') i++; continue; }
        if (WHITESPACE.has(c)) { i++; continue; }
        if (c === '(') {
            const r = readLiteralString(s, i);
            pushOperand({ type: 'str', str: r.value.str });
            i = r.pos;
            continue;
        }
        if (c === '<' && s[i + 1] !== '<') {
            const r = readHexString(s, i);
            pushOperand({ type: 'str', str: r.value.str });
            i = r.pos;
            continue;
        }
        if (c === '<' && s[i + 1] === '<') { i += 2; continue; }
        if (c === '>' && s[i + 1] === '>') { i += 2; continue; }
        if (c === '[') {
            const items = [];
            // ⚠️ 顺序要紧:先把数组**本身**放进外层,再把它压栈 ——
            //    反了的话数组会把自己装进自己(实测表现为 TJ 数组恒为空、整段文本抽不出来)
            pushOperand({ type: 'arr', items });
            stack.push(items);
            i++;
            continue;
        }
        if (c === ']') { stack.pop(); i++; continue; }
        if (c === '/') {
            const r = readName(s, i);
            pushOperand({ type: 'name', name: r.value.name });
            i = r.pos;
            continue;
        }
        if (/[+\-.0-9]/.test(c)) {
            let j = i;
            while (j < s.length && /[+\-.0-9]/.test(s[j])) j++;
            if (j > i) {
                pushOperand({ type: 'num', num: parseFloat(s.slice(i, j)) });
                i = j;
                continue;
            }
        }
        let j = i;
        while (j < s.length && !WHITESPACE.has(s[j]) && !'()<>[]{}/%'.includes(s[j])) j++;
        if (j > i) {
            tokens.push({ type: 'op', value: s.slice(i, j) });
            i = j;
            continue;
        }
        i++;
    }
    return tokens;
}

// Windows-1252 的 0x80~0x9F 段与 ASCII 之外的常见缺口
const CP1252_HIGH = {
    0x80: '\u20AC', 0x82: '\u201A', 0x83: '\u0192', 0x84: '\u201E', 0x85: '\u2026', 0x86: '\u2020',
    0x87: '\u2021', 0x88: '\u02C6', 0x89: '\u2030', 0x8A: '\u0160', 0x8B: '\u2039', 0x8C: '\u0152',
    0x8E: '\u017D', 0x91: '\u2018', 0x92: '\u2019', 0x93: '\u201C', 0x94: '\u201D', 0x95: '\u2022',
    0x96: '\u2013', 0x97: '\u2014', 0x98: '\u02DC', 0x99: '\u2122', 0x9A: '\u0161', 0x9B: '\u203A',
    0x9C: '\u0153', 0x9E: '\u017E', 0x9F: '\u0178',
};
function cp1252ToUnicode(raw) {
    let s = '';
    for (let i = 0; i < raw.length; i++) {
        const code = raw.charCodeAt(i);
        if (code >= 0x80 && code <= 0x9F) s += CP1252_HIGH[code] || '\uFFFD';
        else s += String.fromCharCode(code);
    }
    return s;
}

// ---------- 页面与流 ----------
function pageContentsRefs(pageDict, objects) {
    const c = pageDict && pageDict.Contents;
    if (!c) return [];
    const arr = arrayOf(c);
    const list = arr || [c];
    return list.map(x => refNumOf(x)).filter(n => n !== null && objects.has(n));
}

async function collectContentText(latin1, objects, fontEntries, globalFonts) {
    const texts = [];
    const pageNums = pageOrder(objects);
    for (const pageNum of pageNums) {
        const page = objects.get(pageNum);
        if (!page) continue;
        // 这一页自己的资源 → 自己的字体表;拿不到就退回"全局按名链接"的兜底表
        const pageFonts = linkPageFonts(inheritedResources(page, objects), objects, fontEntries);
        const table = { byName: pageFonts.size ? pageFonts : globalFonts };
        const chunks = [];
        for (const n of pageContentsRefs(page.dict, objects)) {
            const obj = objects.get(n);
            if (!obj) continue;
            const data = await decodeStream(latin1, obj.streamStart, obj.streamEnd, obj.dict).catch(() => null);
            if (data) chunks.push(bytesToLatin1(data));
        }
        if (chunks.length) {
            const t = extractTextFromContent(chunks.join('\n'), table);
            if (t) texts.push(t);
        }
    }
    if (texts.length) return { text: texts.join('\n'), pages: pageNums.length };

    // 没有页面对象(或内容挂在别处):退化成"扫所有像内容流的流"
    const fallback = [];
    for (const obj of objects.values()) {
        if (obj.streamStart < 0) continue;
        const data = await decodeStream(latin1, obj.streamStart, obj.streamEnd, obj.dict).catch(() => null);
        if (!data) continue;
        const text = bytesToLatin1(data);
        if (!/\bBT\b/.test(text) || !/\b(Tj|TJ)\b/.test(text)) continue;
        const t = extractTextFromContent(text, { byName: globalFonts });
        if (t) fallback.push(t);
    }
    return { text: fallback.join('\n'), pages: pageNums.length };
}

// ---------- 质量闸门 ----------
// 这一条决定成败:抽不准就**不硬导入**(宁可让用户去用 AI/复制那条路),
// 因为"半对半错的题目"比"什么都没有"更害人 —— 用户得逐题核对才发现。
// ⚠️ 判据**顺序**要紧:
//   ① 先看乱码率(有文本才谈得上乱码);
//   ② 再看结构:用了 CID 字体却没映射 → 必是乱码,这一条比比例更硬(短文本也能判);
//   ③ 最后才看"字太少" —— 它是"几乎没抽到东西"的兜底,阈值要低:
//      一份只有一道小题的 PDF 也就几十个字,阈值定高了会把**正常小文件**误杀成"扫描件"。
export function pdfTextGate(text, stats = {}) {
    const chars = (text || '').replace(/\s/g, '').length;
    if (chars > 0) {
        const bad = (text.match(/[\uFFFD\u0000-\u0008\u000B\u000C\u000E-\u001F]/g) || []).length;
        const pua = (text.match(/[\uE000-\uF8FF]/g) || []).length;
        const ratio = (bad + pua) / chars;
        if (ratio > 0.03) {
            return { ok: false, reason: 'fontmap', detail: `抽出的文字里约 ${Math.round(ratio * 100)}% 是乱码/私有区字符(字体没带 Unicode 映射)` };
        }
    }
    // 结构判据:用了 CID 字体却没有一张带中文的映射表 —— 典型的"中文抽成乱码"
    if (stats.cidFontsWithoutMap > 0 && stats.cjkCount === 0) {
        return { ok: false, reason: 'fontmap', detail: '这份 PDF 用的是 CID 字体却没带 ToUnicode 映射,中文抽出来必是乱码' };
    }
    if (chars === 0) {
        return { ok: false, reason: 'scanned', detail: '没抽到任何文字,基本可以确定是扫描件或图片版 PDF' };
    }
    if (chars < 8) {
        return { ok: false, reason: 'scanned', detail: `只抽到 ${chars} 个字符 —— 这份 PDF 里几乎没有可复制的文字(多半是图片版)` };
    }
    return { ok: true, reason: '', detail: '' };
}

// ---------- 对外入口 ----------
export async function pdfToText(arrayBuffer) {
    const bytes = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
    if (bytes.length > MAX_BYTES) throw new Error('PDF 太大(超过 64MB),手机可能读不动');
    const latin1 = bytesToLatin1(bytes);
    if (!latin1.startsWith(PDF_MAGIC)) throw new Error('这不是 PDF 文件');
    // 加密:trailer 在文件末尾(线性化 PDF 头部还有一份),所以在头尾各找一次
    const head = latin1.slice(0, 4096);
    const tail = latin1.slice(Math.max(0, latin1.length - 8192));
    if (/\/Encrypt\b/.test(tail) || /\/Encrypt\b/.test(head)) {
        throw new Error('这份 PDF 有密码保护,先解锁或另存为无密码版本');
    }
    const objects = scanObjects(latin1);
    if (!objects.size) throw new Error('PDF 结构异常,没找到任何内容对象');
    refineStreamBounds(latin1, objects);            // 间接 /Length 要等对象齐了才算得出
    await expandObjectStreams(latin1, objects);
    const fontEntries = await buildFontEntries(latin1, objects);
    // 全局兜底表:只给"页面结构损坏、拿不到 Resources"的情况用
    const globalFonts = new Map();
    for (const obj of objects.values()) {
        const base = obj.dict && nameOf(obj.dict.BaseFont);
        if (base && fontEntries.has(obj.num)) globalFonts.set(base, fontEntries.get(obj.num));
    }
    for (const obj of objects.values()) linkPageFonts(obj.dict && obj.dict.Resources, objects, fontEntries, globalFonts);
    const { text, pages } = await collectContentText(latin1, objects, fontEntries, globalFonts);

    let cidFontsWithoutMap = 0;
    for (const f of fontEntries.values()) {
        if (f.isCid && !f.hasToUnicode) cidFontsWithoutMap++;
    }
    const cjkCount = (text.match(/[\u3400-\u9FFF\uF900-\uFAFF]/g) || []).length;
    const gate = pdfTextGate(text, { cidFontsWithoutMap, cjkCount });
    return { text, pages, gate, stats: { objects: objects.size, cidFontsWithoutMap, cjkCount } };
}
