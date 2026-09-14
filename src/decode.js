// ==================== 文本编码识别(零依赖纯函数)====================
// 职责:文件字节 → 文本 + 用到的编码。
//
// 为什么需要它:`txt` / `csv` / `md` 这类"纯文本"文件**不一定是 UTF-8** ——
// 记事本、WPS、Excel 在中文 Windows 上另存 csv/txt 默认就是 **GBK**(GB18030 是它的超集)。
// 之前一律按 UTF-8 读,整篇中文变乱码(👤 2026-09-14 记在想法 P1-9 里)。
//
// 判据顺序(**先看文件自己的声明,再严格判断,最后才猜中文编码**):
//   ① **BOM**:文件自己声明的编码优先于任何猜测(UTF-8 / UTF-16LE / UTF-16BE);
//   ② **严格 UTF-8**(`fatal: true`,解不出来会抛):现代文件绝大多数是它;
//   ③ 解不出来才试 **GB18030**(GBK 的超集),并与"宽松 UTF-8"按**乱码分**比较取更好的那个。
//
// ⚠️ 关键取舍:**"解得出来"不等于"猜对了"**。GB18030 几乎能解任何字节序列(双字节全覆盖),
//    所以不能"谁不抛异常用谁",必须打分(替换符 / 控制字符 / 私用区 / 成片拉丁扩展字符都扣分),
//    否则一份 UTF-8 文件会被 GB18030 悄悄解成一堆生僻字。
// 允许:TextDecoder(平台自带)。禁止:document / localStorage / state —— 本模块是纯函数。

const BOMS = [
    { bytes: [0xEF, 0xBB, 0xBF], encoding: 'utf-8', skip: 3 },
    { bytes: [0xFF, 0xFE], encoding: 'utf-16le', skip: 2 },
    { bytes: [0xFE, 0xFF], encoding: 'utf-16be', skip: 2 },
];

function matchBom(bytes) {
    for (const bom of BOMS) {
        if (bytes.length >= bom.skip && bom.bytes.every((b, i) => bytes[i] === b)) return bom;
    }
    return null;
}

function decodeWith(bytes, encoding) {
    return new TextDecoder(encoding).decode(bytes);
}

// 严格解码:能解出来才算"这是 UTF-8",解不出来返回 null
function decodeStrictUTF8(bytes) {
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (e) {
        return null;
    }
}

// 乱码分:越高越像乱码。只用来在候选之间比较,不对外承诺绝对阈值。
export function scoreText(text) {
    if (!text) return 0;
    let bad = 0;
    for (const ch of text) {
        const c = ch.codePointAt(0);
        if (c === 0xFFFD) bad += 20;                                  // 解码失败符
        else if (c === 0) bad += 20;                                  // NUL:二进制或 UTF-16 被当单字节读
        else if (c < 0x09 || (c > 0x0D && c < 0x20)) bad += 10;       // 控制字符(\t \n \r 除外)
        else if (c >= 0xE000 && c <= 0xF8FF) bad += 10;               // 私用区
        else if (c >= 0x0080 && c <= 0x024F) bad += 2;                // 成片拉丁扩展字符:中文文本里通常是错解
    }
    return bad;
}

// 字节 → { text, encoding }。bytes 接受 Uint8Array / ArrayBuffer。
export function decodeTextBytes(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (!bytes.length) return { text: '', encoding: 'utf-8' };

    // ① BOM:文件自己说了算
    const bom = matchBom(bytes);
    if (bom) {
        return { text: decodeWith(bytes.subarray(bom.skip), bom.encoding), encoding: bom.encoding };
    }

    // ② 严格 UTF-8:能解就是它(不再猜)
    const utf8 = decodeStrictUTF8(bytes);
    if (utf8 !== null) {
        // 例外:UTF-16 没带 BOM 时"严格 UTF-8"也能解出来(里面全是 NUL),这时换 UTF-16 试试
        if (utf8.includes('\u0000')) {
            for (const enc of ['utf-16le', 'utf-16be']) {
                const alt = decodeSafe(bytes, enc);
                if (alt !== null && scoreText(alt) < scoreText(utf8)) return { text: alt, encoding: enc };
            }
        }
        return { text: utf8, encoding: 'utf-8' };
    }

    // ③ 严格 UTF-8 解不出来:在"宽松 UTF-8"(带替换符)和 GB18030 之间按分值挑
    const candidates = [];
    const loose = decodeSafe(bytes, 'utf-8');
    if (loose !== null) candidates.push({ text: loose, encoding: 'utf-8' });
    for (const enc of ['gb18030', 'big5']) {
        const t = decodeSafe(bytes, enc);
        if (t !== null) candidates.push({ text: t, encoding: enc });
    }
    if (!candidates.length) return { text: '', encoding: 'unknown' };
    candidates.sort((a, b) => scoreText(a.text) - scoreText(b.text));
    return candidates[0];
}

function decodeSafe(bytes, encoding) {
    try {
        return decodeWith(bytes, encoding);
    } catch (e) {
        return null;
    }
}
