// 合成 PDF 的小工厂(vm 测试与 pdf 单测共用)。
// 为什么现造而不塞 fixture:① 能精确构造边界(没有 ToUnicode 的 CID 字体、写小的 /Length…)
// ② 仓库不留二进制垃圾;③ 造出来的字节走的是与真实文件同一条解析路径。
import zlib from 'node:zlib';

// ---------- 合成 PDF 的小工厂 ----------
// objs: [{ num, dict, stream?, compress? }] —— dict 是 PDF 字典原文(含 << >>)
export function buildPdf(objs, { encrypt = false } = {}) {
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
export function cjkHex(text) {
    let hex = '';
    for (const ch of text) hex += ch.charCodeAt(0).toString(16).padStart(4, '0');
    return hex;
}
export function cjkCMap(text) {
    const codes = [...new Set([...text].map(ch => ch.charCodeAt(0)))];
    return `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n1 beginbfchar\n`
        + codes.map(c => `<${c.toString(16).padStart(4, '0')}> <${c.toString(16).padStart(4, '0')}>`).join('\n')
        + `\nendbfchar\nendcmap\nend\n`;
}

// 单页 PDF:content 写明内容流,fontObjs 里放字体对象(可注入 CJK 字体)
export function onePagePdf(content, { fontDict = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', fontNum = 5, extraObjs = [], contentFilter = null, compress = false } = {}) {
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

