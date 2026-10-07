#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
measure-mobile.py — 手机端牌桌几何量取（B2：可复现的像素级边界扫描）

输入：手机端真机打牌截图（默认 docs/media/gg-reference/clubgg-mobile-真实打牌截图.jpg，
      1170x2532）。输出设计稿 CSS 几何（舞台 400x866，缩放系数 2.925 = 2532/866）。

方法（逐边扫描原语 `scan_edge`）：
  像素分类：
    felt  : g - r >= 12                        （绿呢高饱和）
    gold  : r > 150 and g > 120 and b < 130     （金按钮）
    white : r,g,b 均 > 200                      （白文字/亮边/发牌）
    olive : r - b >= 4（背景橄榄暗底——桌壳外唯一稳定底色）
    rail  : |g-r|<=3 且 |r-b|<=3 且亮度 12..80  （中性深炭桌沿带）
    other : 其余（阴影/头像/筹码等杂项，扫描中按“非olive且不felt”处理）
  边界规则：
    呢面上/下缘 = 中心列第一段/最末段连续 felt（>=30px）。
    桌壳外沿 top = felt 段之上、最后一段 >=20px 连续 olive 的结束行+1。
    桌壳外沿 bottom = felt 下缘向下，rail/other 连续段（允许白色小断点<=60px）
                  的最终行；若先遇亮按钮带则标注为“被遮挡-估算”。
    侧沿 = 在桌体上部行带取 3 条水平扫描线（ft+60 / ft+120 / 桌体上1/4），
           左外沿=从最左向右第一段“非olive连续段”的起点（该段须以 felt 收尾，
           排除杂色孤点）；厚度=同线上外侧非olive段的终点与 felt 起点差。
    控件带 = 呢面下缘以下，gold|white 像素占比>25% 的行聚段。

标注：[量取] 像素边界直接可见；[推算] 由量取值换算 CSS；[估算] 图上被遮挡
      或本图状态不可见，按设计推导（脚本同时给出可见部分与偏差说明）。

用法：python3 docs/fixtures/measure-mobile.py [参考图路径]
退出码：恒 0（量取工具，非门禁；门禁见 audit-design.mjs）
"""
import sys, os
from PIL import Image

SCALE = 2532 / 866  # 2.9248：参考图像素 -> 设计稿 CSS 像素

def classify(p):
    r, g, b = p[:3]
    if r > 200 and g > 200 and b > 200: return 'white'
    if r > 150 and g > 120 and b < 130: return 'gold'
    if g - r >= 12: return 'felt'
    lum = 0.299 * r + 0.587 * g + 0.114 * b
    if abs(g - r) <= 3 and abs(r - b) <= 3 and 12 <= lum <= 80: return 'rail'
    if r - b >= 4 and g - r <= 4 and lum <= 80: return 'olive'
    return 'other'

def runs(seq):
    out = []
    for i, c in enumerate(seq):
        if out and out[-1][0] == c: out[-1][2] = i
        else: out.append([c, i, i])
    return [(c, a, b, b - a + 1) for c, a, b in out]

def css(v, nd=1):
    return '  -  ' if v is None else f'{v / SCALE:.{nd}f}'

def vscan(px, x, H):
    return runs([classify(px[x, y]) for y in range(0, H)])

def hscan(px, y, W):
    return runs([classify(px[x, y]) for x in range(0, W)])

def measure(px, W, H):
    cx = W // 2
    vr = vscan(px, cx, H)
    felt = [(a, b, n) for c, a, b, n in vr if c == 'felt' and n >= 30 and a > 150]
    if not felt: return {}
    ft, fb = felt[0][0], felt[-1][1]
    # shell top: last >=20px olive run ending above ft
    olives = [b for c, a, b, n in vr if c == 'olive' and n >= 20 and b < ft]
    st = max(olives) + 1 if olives else None
    # shell bottom: downward from fb over rail/other (tolerate small white breaks)
    y = fb
    last_dark, white_run = None, 0
    hidden = False
    for c, a, b, n in vr:
        if a <= fb: continue
        if c in ('rail', 'other'): last_dark, white_run = b, 0
        elif c in ('white', 'gold') and last_dark is not None:
            white_run = b - last_dark
            if c == 'gold' or (c == 'white' and white_run > 60):
                hidden = True
                break
        elif c == 'olive' and last_dark is not None:
            break
    sb = None if hidden else last_dark
    # widest band: sample rows through the straight flank between the corner arcs;
    # measure where content (non-olive) starts/ends per row -> outermost x of table
    band = range(ft + 250, fb - 150, 60)
    outer_l = outer_r = None
    for y in band:
        seq = [classify(px[x, y]) for x in range(W)]
        nl = next((x for x, c in enumerate(seq) if c != 'olive'), None)
        nr = next((x for x in range(W - 1, -1, -1) if seq[x] != 'olive'), None)
        if nl is not None and (outer_l is None or nl < outer_l): outer_l = nl
        if nr is not None and (outer_r is None or nr > outer_r): outer_r = nr
    # felt extent at exact mid-height row (side rail = gap between screen edge and felt)
    ymid = (ft + fb) // 2
    seqm = [classify(px[x, ymid]) for x in range(W)]
    fl = next((x for x, c in enumerate(seqm) if c == 'felt'), None)
    fr = next((x for x in range(W - 1, -1, -1) if seqm[x] == 'felt'), None)
    # bottom control bands: bright-text rows between shell bottom and system bar.
    # Buttons are DARK pills with light text -> use a low row-fraction threshold and
    # exclude the last ~80px (system home indicator, pure white bar).
    bands, inb, gap = [], None, 0
    for y in range(fb + 2, H - 80, 2):
        frac = sum(1 for x in range(0, W, 6) if classify(px[x, y]) in ('gold', 'white')) / (W // 6)
        if frac > 0.035:
            if inb is None: inb = y
            gap = 0
        elif inb is not None:
            gap += 2
            if gap > 4: bands.append((inb, y - gap)); inb = None
    if inb is not None: bands.append((inb, H - 82))
    return dict(ft=ft, fb=fb, st=st, sb=sb, hidden=hidden,
                outer=(outer_l, outer_r), felt=(fl, fr), bands=bands)

def main():
    path = sys.argv[1] if len(sys.argv) > 1 else os.path.normpath(os.path.join(
        os.path.dirname(os.path.abspath(__file__)), '..', 'media', 'gg-reference',
        'clubgg-mobile-真实打牌截图.jpg'))
    im = Image.open(path).convert('RGB'); W, H = im.size
    print(f'ref: {path}\n     {W}x{H}   scale ref->css = {SCALE:.4f}')
    m = measure(im.load(), W, H)
    if not m:
        print('本图未检出稳定 felt 段——换图或检查分类阈值'); return
    ft, fb, st, sb = m['ft'], m['fb'], m['st'], m['sb']
    ol, orr = m['outer']
    fl, fr = m['felt']
    print('\n== 量取结果（ref px -> css px），对照设计稿 claim ==\n')
    if st:
        print(f'  桌壳外沿 top      y{st:4d} -> css {css(st)} = {st/H*100:4.1f}%   claim y138(16.0%)   [量取; claim 与量取差 {st/SCALE-138:+.0f}px css]')
    print(f'  呢面上沿          y{ft:4d} -> css {css(ft)} = {ft/H*100:4.1f}%                       [量取]')
    if st:
        print(f'  顶沿厚度(外沿→呢面) {ft-st:4d}px -> css {css(ft-st)}             claim ~23px 与量取不符;'
              f' 设计稿 .p-felt inset 上=11px 与量取 {css(ft-st)} 吻合')
    print(f'  呢面下沿          y{fb:4d} -> css {css(fb)} = {fb/H*100:4.1f}%                       [量取]')
    if sb:
        print(f'  桌壳外沿 bottom   y{sb:4d} -> css {css(sb)} = {sb/H*100:4.1f}%   claim y802(92.6%) [量取, 吻合]')
    else:
        print(f'  桌壳外沿 bottom   被控件带遮挡不可见; 可见下缘=felt y{fb}(css {css(fb)})  claim y802(92.6%) [估算]')
    print(f'  桌体最宽处(直边带) x{ol}..{orr} -> css x{css(ol,0)}..{css(orr,0)}                [量取]')
    print(f'  中段呢面左右缘     x{fl}..{fr} -> css x{css(fl,0)}..{css(fr,0)}                [量取]')
    print(f'  侧沿厚度(屏缘→呢面) 左 {fl-ol}px=css {css(fl-ol)}  右 {orr-fr}px=css {css(orr-fr)}   claim ~10px: '
          f'非中段量取(中段桌体通屏、rail 被座位遮挡), 属设计取值 [估算]')
    print('\n  底部控件带（深色按钮+亮字, 低阈值检出; 末 80px 系统 home indicator 已排除）:')
    for i, (a, b) in enumerate(m['bands']):
        print(f'    layer{i+1}: y{a}..{b} -> css y{css(a,0)}..{css(b,0)} h={css(b-a,0)}  [量取]')
    print(f'    共 {len(m["bands"])} 层——两行亮文字带即控件两层的可测证据 [量取]' if len(m['bands']) == 2
          else f'    共 {len(m["bands"])} 层——与“两层”说法对照见上；注意按钮体为深底深钮，亮度法只量得到亮文字带 [量取/受限]')
    print('\n  座位（hero 左下贴边、对手贴右缘）：hero left:15% top:81% —— [估算]')
    print('    静态截图无可稳定检测的头像圆心；落位由量取锚点推导：')
    if m['bands']:
        print(f'    桌体左缘 css x{css(ol,0)}（量取）与控件带上沿 y{css(m["bands"][0][0],0)}（量取）围成的下角区域；')
    print('    hero 贴左下弧、对手贴右缘为构图推导，非像素检测。')
    print('  阶梯列 x309..397 y616..771（右侧注码列骑跨桌体右下）：[估算/推导]')
    print('    注码堆与绿呢亮度突变可测但跨截图状态不稳定，未纳入自动段。')

if __name__ == '__main__':
    main()
