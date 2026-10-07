#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
make-compare.py — 参考端 vs 设计稿 并排对比图（docs/fixtures/gg-replication-compare/）
用法: python3 docs/fixtures/make-compare.py
输出: 6 张 JPEG q85, 桌面画布 1150x423 / 手机 1150x1238，左=参考图(cover 裁切) 右=新截图(fit)。
映射按 cmp 文件名语义选定（旧合成器随 /tmp 丢失；参考侧选择为重建推导，已在此文件固化可改）：
  cmp-s1-preflop      <- gg-desktop-现金桌.png           | s1
  cmp-s3-flop-fx      <- gg-desktop-下注动画.png          | s3
  cmp-s10-acting      <- gg-desktop-对手思考的计时场景.png | s10
  cmp-s13-phone       <- clubgg-mobile-真实打牌截图.jpg    | s13
  cmp-s17-split-options <- gg-poker-准备第二次跑马样式.png  | s17
  cmp-s18-run-twice   <- gg-desktop-两次跑马样式.png       | s18
"""
import os, io
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
REFD = os.path.normpath(os.path.join(HERE, '..', 'media', 'gg-reference'))
SHOTD = os.path.join(HERE, 'gg-replication-screenshots')
OUTD = os.path.join(HERE, 'gg-replication-compare')

PAIRS = [
    ('cmp-s1-preflop.jpg',        'gg-desktop-现金桌.png',            's1.jpg',  (1150, 423)),
    ('cmp-s3-flop-fx.jpg',        'gg-desktop-下注动画.png',           's3.jpg',  (1150, 423)),
    ('cmp-s10-acting.jpg',        'gg-desktop-对手思考的计时场景.png',  's10.jpg', (1150, 423)),
    ('cmp-s13-phone.jpg',         'clubgg-mobile-真实打牌截图.jpg',     's13.jpg', (1150, 1238)),
    ('cmp-s17-split-options.jpg', 'gg-poker-准备第二次跑马样式.png',    's17.jpg', (1150, 423)),
    ('cmp-s18-run-twice.jpg',     'gg-desktop-两次跑马样式.png',        's18.jpg', (1150, 423)),
]

def cover(im, w, h):
    r = max(w / im.width, h / im.height)
    im = im.resize((int(im.width * r + .5), int(im.height * r + .5)), Image.LANCZOS)
    x = (im.width - w) // 2; y = (im.height - h) // 2
    return im.crop((x, y, x + w, y + h))

def fit(im, w, h):
    r = min(w / im.width, h / im.height)
    return im.resize((int(im.width * r + .5), int(im.height * r + .5)), Image.LANCZOS)

def main():
    os.makedirs(OUTD, exist_ok=True)
    for oldf in os.listdir(OUTD):  # 清旧并排（旧 mock 侧含已清除的专有字样）
        if oldf.endswith('.jpg'): os.remove(os.path.join(OUTD, oldf))
    for name, reff, shotf, (W, H) in PAIRS:
        half = W // 2
        canvas = Image.new('RGB', (W, H), (16, 14, 12))
        ref = Image.open(os.path.join(REFD, reff)).convert('RGB')
        canvas.paste(cover(ref, half, H), (0, 0))
        mock = Image.open(os.path.join(SHOTD, shotf)).convert('RGB')
        fm = fit(mock, W - half, H)
        canvas.paste(fm, (half + ((W - half) - fm.width) // 2, (H - fm.height) // 2))
        canvas.save(os.path.join(OUTD, name), 'JPEG', quality=85)
        print('wrote', name)

if __name__ == '__main__':
    main()
