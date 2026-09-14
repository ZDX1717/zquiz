// 文本编码识别(0.15.0 想法 P1-9 / GBK)。真实文件:中文 Windows 的记事本、WPS、Excel
// 另存 txt/csv 默认就是 GBK —— 以前一律按 UTF-8 读,整篇乱码。
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { decodeTextBytes, scoreText } from '../src/decode.js';

const enc = new TextEncoder();
const bytes = (...a) => Uint8Array.from(a);
// GBK 字节(用平台的 gb18030 解码器反查得到,已核对:题=CCE2 目=C4BF ：=A3BA 答=B4F0 案=B0B8 等=B5C8 于=D3DA 几=BCB8)
const GBK_QUESTIONS = bytes(0xCC, 0xE2, 0xC4, 0xBF, 0xA3, 0xBA, 0x31, 0x2B, 0x31, 0x20, 0xB5, 0xC8, 0xD3, 0xDA, 0xBC, 0xB8);

test('BOM 优先:文件自己声明的编码不猜', () => {
    const r1 = decodeTextBytes(bytes(0xEF, 0xBB, 0xBF, ...enc.encode('题目：答案')));
    assert.strictEqual(r1.encoding, 'utf-8');
    assert.strictEqual(r1.text, '题目：答案', 'BOM 本身不该出现在文本里');
    const r2 = decodeTextBytes(bytes(0xFF, 0xFE, ...new Uint8Array(Buffer.from('题目：答案', 'utf16le'))));
    assert.strictEqual(r2.encoding, 'utf-16le');
    assert.strictEqual(r2.text, '题目：答案');
});

test('UTF-8 中文(无 BOM):严格解通过就直接用它', () => {
    const r = decodeTextBytes(enc.encode('题目：1+1 等于几\n答案：B'));
    assert.strictEqual(r.encoding, 'utf-8');
    assert.strictEqual(r.text, '题目：1+1 等于几\n答案：B');
});

test('GBK 中文:严格 UTF-8 解不出来 ⇒ 按 GB18030 解对', () => {
    const r = decodeTextBytes(GBK_QUESTIONS);
    assert.strictEqual(r.encoding, 'gb18030');
    assert.strictEqual(r.text, '题目：1+1 等于几');
    assert.strictEqual(scoreText(r.text), 0, '解对了就不该有乱码分');
});

test('关键取舍:UTF-8 文件不许被 GB18030 抢走', () => {
    // GB18030 几乎能解任何字节,所以判据必须是"严格 UTF-8 优先"而不是"谁不抛异常用谁"
    const text = '题目：某公司组织员工游湖，共使用六条游船分三批出发。答案：B';
    const r = decodeTextBytes(enc.encode(text));
    assert.strictEqual(r.encoding, 'utf-8');
    assert.strictEqual(r.text, text);
});

test('纯 ASCII / 空文件 / 二进制垃圾', () => {
    assert.strictEqual(decodeTextBytes(enc.encode('Question: 1+1? A. 1 B. 2')).text, 'Question: 1+1? A. 1 B. 2');
    assert.deepStrictEqual(decodeTextBytes(new Uint8Array(0)), { text: '', encoding: 'utf-8' });
    const junk = decodeTextBytes(bytes(0x00, 0x01, 0x02, 0xFF, 0xFE, 0x80, 0x81, 0x13));
    assert.ok(scoreText(junk.text) > 60, '二进制垃圾的乱码分要高到能被上层拦下,实际 ' + scoreText(junk.text));
});

test('乱码分:替换符/控制字符/NUL 重罚,正常中文 0 分', () => {
    assert.strictEqual(scoreText('正常的中文文本,包含标点。'), 0);
    assert.ok(scoreText('\uFFFD\uFFFD') >= 40);
    assert.ok(scoreText('a\u0000b\u0000') >= 40);
    assert.ok(scoreText('äÞå') > 0, '成片拉丁扩展字符要扣分(错解的典型症状)');
});

test('decode.js 零依赖零 DOM,且用平台自带 TextDecoder(不引任何库)', () => {
    const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'decode.js'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    assert.ok(!/^\s*import\s/m.test(src), '不许 import 任何东西');
    assert.ok(!/\bdocument\b|localStorage/.test(src), '不许碰 DOM 与存储');
    assert.ok(/TextDecoder/.test(src), '用平台自带的 TextDecoder');
    assert.ok(/gb18030/.test(src), '中文文本要试 GB18030(GBK 的超集)');
});
