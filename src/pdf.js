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
            // 去掉流数据尾部的换行(它不属于数据)
            while (streamEnd > streamStart && (latin1[streamEnd - 1] === '\n' || latin1[streamEnd - 1] === '\r')) streamEnd--;
        }
        objects.set(num, { num, dict, streamStart, streamEnd, raw: body });
        re.lastIndex = endIdx === -1 ? latin1.length : endIdx;
    }
    return objects;
}

// 解流:按 /Filter 依次处理。返回 Uint8Array;不支持的类型返回 null(调用方跳过)。
export async function decodeStream(latin1, streamStart, streamEnd, dict) {
    if (streamStart < 0 || streamEnd <= streamStart) return null;
    let data = latin1ToBytes(latin1.slice(streamStart, streamEnd));
    const filters = [];
    const f = dict && dict.Filter;
    if (f) {
        const arr = arrayOf(f);
        if (arr) arr.forEach(x => { const n = nameOf(x); if (n) filters.push(n); });
        else { const n = nameOf(f); if (n) filters.push(n); }
    }
    for (const name of filters) {
        if (name === 'FlateDecode' || name === 'Fl') data = await inflate(data);
        else if (name === 'ASCIIHexDecode' || name === 'AHx') data = asciiHexDecode(data);
        else if (name === 'ASCII85Decode' || name === 'A85') data = ascii85Decode(data);
        else if (name === 'DCTDecode' || name === 'JPXDecode' || name === 'CCITTFaxDecode' || name === 'JBIG2Decode') return null;  // 图片流:不是文本
        else if (name === 'LZWDecode') return null;      // 极罕见,不值得为它写 LZW
        else return null;                                 // 未知过滤器:宁可跳过,不要吐垃圾
    }
    return data;
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
            const dict = dictOf(parsed.value);
            if (dict) extra.set(objNum, { num: objNum, dict, streamStart: -1, streamEnd: -1, raw: body, fromObjStm: true });
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
async function buildFontTable(latin1, objects) {
    const byNum = new Map();                               // objNum -> {isCid, cmap}
    const byName = new Map();                              // 资源名 -> {isCid, cmap}
    const resolve = (v) => {
        const n = refNumOf(v);
        if (n !== null) return objects.get(n) || null;
        return null;
    };
    for (const obj of objects.values()) {
        const d = obj.dict;
        if (!d || nameOf(d.Type) !== 'Font') continue;
        const subtype = nameOf(d.Subtype);
        const isCid = subtype === 'Type0';
        let cmap = null;
        const toUni = resolve(d.ToUnicode);
        if (toUni) {
            const data = await decodeStream(latin1, toUni.streamStart, toUni.streamEnd, toUni.dict).catch(() => null);
            if (data) cmap = parseToUnicodeCMap(bytesToLatin1(data));
        }
        const entry = { isCid, cmap, hasToUnicode: !!cmap, subtype };
        byNum.set(obj.num, entry);
        const base = nameOf(d.BaseFont);
        if (base) byName.set(base, entry);
    }
    // 资源名 -> 字体:遍历所有 /Font << /F1 12 0 R >> 字典
    const linkResources = (resDict) => {
        const fonts = dictOf(resDict && resDict.Font);
        if (!fonts) return;
        for (const key of Object.keys(fonts)) {
            const ref = resolve(fonts[key]);
            if (ref && byNum.has(ref.num)) byName.set(key, byNum.get(ref.num));
        }
    };
    for (const obj of objects.values()) {
        const d = obj.dict;
        if (!d) continue;
        linkResources(dictOf(d.Resources) ? d.Resources : null);
        linkResources(dictOf(d.Resources) ? null : null);
        const res = dictOf(d.Resources);
        if (res) linkResources(res);
    }
    return { byNum, byName };
}

// ---------- 内容流:抽文本 ----------
// 只认文本算子;按 Td/TD/T*/Tm 的 Y 变化断行 —— 足够对付"一行一题"的卷子。
export function extractTextFromContent(content, fontTable = { byName: new Map() }) {
    const out = [];
    let font = null;
    let lastY = null;
    let lastX = null;
    let pendingBreak = false;

    const pushText = (s) => {
        if (!s) return;
        if (pendingBreak) { out.push('\n'); pendingBreak = false; }
        out.push(s);
    };
    const decodeString = (raw) => {
        const f = font;
        if (!f) return raw;                                // 不知道字体:按单字节原样出(latin1)
        if (f.cmap && f.cmap.size) {
            let s = '';
            if (f.isCid) {
                for (let i = 0; i + 1 < raw.length; i += 2) {
                    const code = (raw.charCodeAt(i) << 8) | raw.charCodeAt(i + 1);
                    s += f.cmap.has(code) ? f.cmap.get(code) : '\uFFFD';
                }
                if (raw.length % 2) s += '\uFFFD';
            } else {
                for (let i = 0; i < raw.length; i++) {
                    const code = raw.charCodeAt(i);
                    s += f.cmap.has(code) ? f.cmap.get(code) : '\uFFFD';
                }
            }
            return s;
        }
        if (f.isCid) {
            // CID 字体没带 ToUnicode:抽出来必是乱码,用替换符标记,交给闸门判定
            return '\uFFFD'.repeat(Math.ceil(raw.length / 2));
        }
        return cp1252ToUnicode(raw);
    };

    // 词法:把内容流切成算子与操作数
    const tokens = tokenizeContent(content);
    const operands = [];
    for (const t of tokens) {
        if (t.type !== 'op') { operands.push(t); continue; }
        const last = () => operands[operands.length - 1];
        switch (t.value) {
            case 'Tf': {
                const size = numberOf(last() && last().num !== undefined ? { num: last().num } : null);
                const nameTok = operands[operands.length - 2];
                if (nameTok && nameTok.name) font = fontTable.byName.get(nameTok.name) || null;
                void size;
                break;
            }
            case 'Td':
            case 'TD': {
                const dy = operands.length >= 2 ? operands[operands.length - 1].num : null;
                const dx = operands.length >= 2 ? operands[operands.length - 2].num : null;
                if (typeof dy === 'number' && (lastY === null || Math.abs(dy) > 0.1)) {
                    pendingBreak = true;                        // Y 变了 = 换行
                } else if (typeof dx === 'number' && Math.abs(dx) > 0.1 && out.length) {
                    pushText(' ');                              // 只在 X 上推进 = 词间距
                }
                if (typeof dy === 'number') lastY = dy;
                if (typeof dx === 'number') lastX = dx;
                break;
            }
            case 'T*':
                pendingBreak = true;
                break;
            case 'Tm': {
                const f = operands.length >= 6 ? operands[operands.length - 1].num : null;
                if (typeof f === 'number') {
                    if (lastY === null || Math.abs(f - lastY) > 0.1) pendingBreak = true;
                    lastY = f;
                }
                break;
            }
            case 'Tj':
            case "'":
            case '"': {
                if (t.value !== 'Tj') pendingBreak = true;      // ' 与 " 自带换行
                if (last() && typeof last().str === 'string') pushText(decodeString(last().str));
                break;
            }
            case 'TJ': {
                const arr = arrayOf(last() && last().items ? last().items : null) || (last() && last().items) || [];
                for (const item of arr) {
                    if (typeof item.str === 'string') pushText(decodeString(item.str));
                    else if (typeof item.num === 'number' && item.num < -100) pushText(' ');   // 大负位移 = 空格
                }
                break;
            }
            case 'BT':
                lastY = null; lastX = null; pendingBreak = false;
                break;
            default:
                break;
        }
        operands.length = 0;
    }
    return out.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
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

async function collectContentText(latin1, objects, fontTable) {
    const pages = [...objects.values()].filter(o => nameOf(o.dict.Type) === 'Page');
    const texts = [];
    for (const page of pages) {
        const refs = pageContentsRefs(page.dict, objects);
        const chunks = [];
        for (const n of refs) {
            const obj = objects.get(n);
            if (!obj) continue;
            const data = await decodeStream(latin1, obj.streamStart, obj.streamEnd, obj.dict).catch(() => null);
            if (data) chunks.push(bytesToLatin1(data));
        }
        if (chunks.length) {
            const t = extractTextFromContent(chunks.join('\n'), fontTable);
            if (t) texts.push(t);
        }
    }
    if (texts.length) return { text: texts.join('\n'), pages: pages.length };
    // 没有页面对象(或内容挂在别处):退化成"扫所有像内容流的流"
    const fallback = [];
    for (const obj of objects.values()) {
        if (obj.streamStart < 0) continue;
        const data = await decodeStream(latin1, obj.streamStart, obj.streamEnd, obj.dict).catch(() => null);
        if (!data) continue;
        const text = bytesToLatin1(data);
        if (!/\bBT\b/.test(text) || !/\b(Tj|TJ)\b/.test(text)) continue;
        const t = extractTextFromContent(text, fontTable);
        if (t) fallback.push(t);
    }
    return { text: fallback.join('\n'), pages: pages.length };
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
    await expandObjectStreams(latin1, objects);
    const fontTable = await buildFontTable(latin1, objects);
    const { text, pages } = await collectContentText(latin1, objects, fontTable);

    let cidFontsWithoutMap = 0;
    for (const f of fontTable.byNum.values()) {
        if (f.isCid && !f.hasToUnicode) cidFontsWithoutMap++;
    }
    const cjkCount = (text.match(/[\u3400-\u9FFF\uF900-\uFAFF]/g) || []).length;
    const gate = pdfTextGate(text, { cidFontsWithoutMap, cjkCount });
    return { text, pages, gate, stats: { objects: objects.size, cidFontsWithoutMap, cjkCount } };
}
