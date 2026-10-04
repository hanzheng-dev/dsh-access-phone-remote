"""生成参考数据（强制 byte mode，禁用 Python 的模式优化）"""
import json
import qrcode
from qrcode.util import QRData, MODE_8BIT_BYTE

TESTS = [
    "http://192.168.1.100:3099/?t=abcd1234",
    "HELLO",
    "http://127.0.0.1:3099/?t=test-token-for-integration",
    "http://<主机Tailscale-IP>:3099/?t=abcdefghijklmnopqrstuvwxyz123456",
    "https://example.com/path?a=1&b=2",
]

out = {}
for text in TESTS:
    qr = qrcode.QRCode(
        version=None,
        error_correction=qrcode.constants.ERROR_CORRECT_L,
        box_size=1,
        border=0,
    )
    # 强制 byte 模式（跟我们的 JS 实现一致）
    qr.add_data(QRData(text.encode("utf-8"), mode=MODE_8BIT_BYTE))
    qr.make(fit=True)

    n = len(qr.get_matrix())
    version = (n - 17) // 4

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
    print(f"v{version} size={n}  {text[:50]}")

with open(r"D:\dsj-open\test\_qr_ref2.json", "w", encoding="utf-8") as f:
    json.dump(out, f)
print("\n已写入 _qr_ref2.json")
