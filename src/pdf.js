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
        // 竖排字体:PDF 用 `/Encoding /Identity-V`(或任何以 -V 结尾的编码名)声明"沿 Y 前进"。
        // 这类字体里每个字都是一次 `Td 0 -字号`,只按 Y 变化断行会得到"一个字一行"。
        const encName = nameOf(d.Encoding);
        const vertical = !!encName && /-V$/.test(encName);
        const entry = { isCid, cmap, hasToUnicode: !!cmap, subtype, vertical };
        byNum.set(obj.num, entry);
        const base = nameOf(d.BaseFont);
        if (base) byName.set(base, entry);
    }
    // 资源名 -> 字体:遍历所有 /Font << /F1 12 0 R >> 字典
    const linkResources = (resDict) => {
        // ⚠️ 真实文件里 /Font 常是**间接引用**(`/Font 10 0 R` → `<< /F1 9 0 R >>`),
        //    只认内联字典的话字体表永远是空的 → 中文全成乱码/读不出
        const fonts = dictOfResolved(resDict && resDict.Font, objects);
        if (!fonts) return;
        for (const key of Object.keys(fonts)) {
            const ref = resolve(fonts[key]);
            if (ref && byNum.has(ref.num)) byName.set(key, byNum.get(ref.num));
        }
    };
    for (const obj of objects.values()) {
        const d = obj.dict;
        if (!d) continue;
        const res = dictOfResolved(d.Resources, objects);   // /Resources 也可能是个引用
        if (res) linkResources(res);
    }
    return { byNum, byName };
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
export function extractTextFromContent(content, fontTable = { byName: new Map() }) {
    const runs = [];
    let tm = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };   // 文本矩阵
    let tlm = { e: 0, f: 0 };                            // 行矩阵(Td/TD/T* 相对它移动)
    let leading = 0;                                     // TL
    let size = 12;                                       // 未声明 Tf 时的保守默认
    let font = null;
    let forced = false;                                  // 下一个片段是否强制另起一行(T* / ' / ")

    const pushRun = (text) => {
        if (!text) return;
        runs.push({ text, a: tm.a, b: tm.b, e: tm.e, f: tm.f, size, forced, vertical: !!(font && font.vertical) });
        forced = false;
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
                if (last() && typeof last().str === 'string') pushRun(decodeString(last().str));
                break;
            case "'":
                forced = true;
                tlNextLine();
                if (last() && typeof last().str === 'string') pushRun(decodeString(last().str));
                break;
            case '"':
                forced = true;
                tlNextLine();
                if (last() && typeof last().str === 'string') pushRun(decodeString(last().str));
                break;
            case 'TJ': {
                const arr = (last() && last().items) || [];
                for (const item of arr) {
                    if (typeof item.str === 'string') pushRun(decodeString(item.str));
                    // TJ 位移单位是 1/1000 em:词间距 250~330、字距 ≤150 → 阈值 200
                    else if (typeof item.num === 'number' && item.num < -200) pushRun(' ');
                }
                break;
            }
            default:
                break;
        }
        operands.length = 0;
    }
    return runsToText(runs);
}

// 片段 → 文本:按"垂直于前进方向的坐标"分行,行内按前进方向排序
function runsToText(runs) {
    const lines = [];
    let cur = null;
    for (const r of runs) {
        const len = Math.hypot(r.a, r.b) || 1;
        const dx = r.a / len;
        const dy = r.b / len;
        // 横排:一行 = 同一个 Y,行内按 X 排;
        // 竖排字体(Identity-V):一行(一列)= 同一个 X,列内自上而下按 Y 排。
        const lineCoord = r.vertical ? r.e : (r.e * -dy + r.f * dx);
        const orderCoord = r.vertical ? -r.f : (r.e * dx + r.f * dy);
        const tol = Math.max(2, Math.abs(r.size) * 0.5);    // 半个字高以内都算同一行(容抖动)
        const turned = cur && (Math.abs(dx - cur.dx) > 0.2 || Math.abs(dy - cur.dy) > 0.2);
        if (!cur || r.forced || turned || cur.vertical !== r.vertical || Math.abs(lineCoord - cur.lineCoord) > tol) {
            cur = { lineCoord, dx, dy, vertical: r.vertical, parts: [] };
            lines.push(cur);
        }
        cur.parts.push({ orderCoord, text: r.text });
    }
    return lines
        .map(l => l.parts.sort((x, y) => x.orderCoord - y.orderCoord).map(p => p.text).join(''))
        .join('\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
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
    refineStreamBounds(latin1, objects);            // 间接 /Length 要等对象齐了才算得出
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
