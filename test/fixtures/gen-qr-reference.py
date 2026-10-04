#!/usr/bin/env python3
"""
生成 QR 交叉验证的参考数据。

用途：
    test/qr-verify.mjs 拿这份数据逐格对比 public/qr.js 的输出，
    确保我们手写的 QR 编码器跟标准实现一致。

依赖：
    pip install qrcode

用法：
    python test/fixtures/gen-qr-reference.py
    # 输出到同目录的 qr-reference.json

⚠️ 测试用例只用「示例地址」，不要放任何真实 IP / token。
"""

import json
import os
import qrcode
from qrcode.util import QRData, MODE_8BIT_BYTE

# 测试用例（覆盖不同长度 / 不同版本）
TESTS = [
    "http://192.168.1.100:3099/?t=abcd1234",
    "HELLO",
    "http://127.0.0.1:3099/?t=test-token-for-integration",
    "http://100.64.99.99:3099/?t=abcdefghijklmnopqrstuvwxyz123456",
    "https://example.com/path?a=1&b=2",
]

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "qr-reference.json")


def main():
    out = {}
    for text in TESTS:
        qr = qrcode.QRCode(
            version=None,
            error_correction=qrcode.constants.ERROR_CORRECT_L,
            box_size=1,
            border=0,
        )
        # 强制 byte 模式（跟我们的 JS 实现一致；Python 默认会做模式优化）
        qr.add_data(QRData(text.encode("utf-8"), mode=MODE_8BIT_BYTE))
        qr.make(fit=True)

        n = len(qr.get_matrix())
        version = (n - 17) // 4

        # 逐个掩码生成矩阵（我们的实现也支持指定掩码，便于逐格对比）
        masks = {}
        for mp in range(8):
            q2 = qrcode.QRCode(
                version=version,
                error_correction=qrcode.constants.ERROR_CORRECT_L,
                box_size=1,
                border=0,
                mask_pattern=mp,
            )
            q2.add_data(QRData(text.encode("utf-8"), mode=MODE_8BIT_BYTE))
            q2.make(fit=False)
            masks[str(mp)] = [[1 if c else 0 for c in row] for row in q2.get_matrix()]

        out[text] = {"version": version, "size": n, "masks": masks}
        print("v%d size=%d  %s" % (version, n, text[:56]))

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f)

    print("\n已写入 " + OUT)


if __name__ == "__main__":
    main()
