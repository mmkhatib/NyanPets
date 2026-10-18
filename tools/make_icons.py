#!/usr/bin/env python3
"""Draws the app icons from the cat's own pixel art (the same sprite the
userscript draws) and writes the iOS and macOS AppIcon sets.

    python3 tools/make_icons.py
"""
import json
import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, 'apps', 'Shared', 'Assets.xcassets')

K, CRUST, FROST, SPR = '#000000', '#fcc98e', '#ff99ff', '#ff3399'
FUR, CHEEK, WHITE = '#999999', '#ff9a9a', '#ffffff'
RAINBOW = ['#ff0000', '#ff9900', '#ffff00', '#33ff00', '#0099ff', '#6633ff']
SPRINKLES = [(10, 5), (13, 8), (16, 5), (20, 5), (9, 11), (12, 13), (15, 11), (11, 8)]
HEAD = [
    '..X.........X..',
    '.XgX.......XgX.',
    '.XggX.....XggX.',
    '.XgggXXXXXgggX.',
    'XgggggggggggggX',
    'XgggggggggggggX',
    'XgggggggggggggX',
    'XgggggggggggggX',
    'XppgggggggggppX',
    'XppgggggggggppX',
    'XgggggggggggggX',
    '.XgggggggggggX.',
    '..XXXXXXXXXXX..',
]
HEAD_PAL = {'X': K, 'g': FUR, 'p': CHEEK}
N = 48  # art pixels across the icon


def art():
    """The icon at one art pixel per pixel, N x N."""
    img = Image.new('RGB', (N, N), '#0b2a6b')
    d = ImageDraw.Draw(img)
    px = lambda x, y, w, h, c: d.rectangle([x, y, x + w - 1, y + h - 1], fill=c)
    # A few stars.
    for x, y in [(5, 6), (40, 5), (30, 9), (8, 40), (42, 38), (22, 43), (3, 24)]:
        px(x, y, 1, 1, WHITE)
        px(x - 1, y, 1, 1, '#8fb3ff'), px(x + 1, y, 1, 1, '#8fb3ff')
        px(x, y - 1, 1, 1, '#8fb3ff'), px(x, y + 1, 1, 1, '#8fb3ff')
    ox, oy = 9, 13  # where the sprite's (0, 0) sits; the body starts at ox + 2
    sx = ox + 2
    # Rainbow trail behind the cat, stepped like the userscript's.
    for seg, x0 in enumerate(range(sx + 8, 0, -8)):
        dy = seg % 2
        for k, c in enumerate(RAINBOW):
            px(max(0, x0 - 8), oy + 1 + k * 3 + dy, x0 - max(0, x0 - 8), 3, c)
    # Tail.
    for k in range(8):
        y = oy + 10 + (1 if k > 3 else 0)
        px(sx + 6 - k, y - 2, 1, 4, K)
        px(sx + 6 - k, y - 1, 1, 2, FUR)
    # Legs.
    for lx in (6, 10, 19, 24):
        px(sx + lx - 1, oy + 16, 4, 4, K)
        px(sx + lx, oy + 16, 2, 3, FUR)
    # Pop-Tart body.
    px(sx + 5, oy + 1, 21, 17, K)
    px(sx + 6, oy + 2, 19, 15, CRUST)
    px(sx + 8, oy + 4, 15, 11, FROST)
    for x, y in [(8, 4), (22, 4), (8, 14), (22, 14)]:
        px(sx + x, oy + y, 1, 1, CRUST)
    for x, y in SPRINKLES:
        px(sx + x, oy + y, 1, 1, SPR)
    # Head, happy eyes and a "w" smile.
    hx, hy = sx + 19, oy + 4
    for j, row in enumerate(HEAD):
        for i, ch in enumerate(row):
            if ch != '.':
                px(hx + i, hy + j, 1, 1, HEAD_PAL[ch])
    for ex in (3, 11):
        px(hx + ex, hy + 6, 2, 2, K)
        px(hx + ex, hy + 6, 1, 1, WHITE)
    px(hx + 7, hy + 8, 1, 1, K)
    for x in (4, 7, 10):
        px(hx + x, hy + 9, 1, 1, K)
    px(hx + 5, hy + 10, 2, 1, K)
    px(hx + 8, hy + 10, 2, 1, K)
    return img


def scaled(size):
    return art().resize((size, size), Image.NEAREST)


def mac_icon(size):
    """macOS style: a rounded square inset from the canvas edge."""
    inset = round(size * 100 / 1024)
    inner = size - 2 * inset
    face = art().resize((inner, inner), Image.NEAREST)
    mask = Image.new('L', (inner, inner), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, inner - 1, inner - 1], radius=round(inner * 0.225), fill=255)
    out = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    out.paste(face, (inset, inset), mask)
    return out


def write_set(name, images, entries):
    folder = os.path.join(ASSETS, name)
    os.makedirs(folder, exist_ok=True)
    for filename, img in images.items():
        img.save(os.path.join(folder, filename))
    with open(os.path.join(folder, 'Contents.json'), 'w') as f:
        json.dump({'images': entries, 'info': {'author': 'xcode', 'version': 1}}, f, indent=2)
        f.write('\n')


def main():
    os.makedirs(ASSETS, exist_ok=True)
    with open(os.path.join(ASSETS, 'Contents.json'), 'w') as f:
        json.dump({'info': {'author': 'xcode', 'version': 1}}, f, indent=2)
        f.write('\n')

    write_set('AppIcon.appiconset', {'icon-ios-1024.png': scaled(1024)}, [
        {'filename': 'icon-ios-1024.png', 'idiom': 'universal', 'platform': 'ios', 'size': '1024x1024'},
    ])

    images, entries = {}, []
    for pt in (16, 32, 128, 256, 512):
        for scale in (1, 2):
            px = pt * scale
            fn = f'icon-mac-{px}.png'
            images.setdefault(fn, mac_icon(px))
            entries.append({'filename': fn, 'idiom': 'mac', 'scale': f'{scale}x', 'size': f'{pt}x{pt}'})
    write_set('MacAppIcon.appiconset', images, entries)

    write_set('AccentColor.colorset', {}, [])
    with open(os.path.join(ASSETS, 'AccentColor.colorset', 'Contents.json'), 'w') as f:
        json.dump({
            'colors': [{'idiom': 'universal', 'color': {'color-space': 'srgb', 'components': {
                'red': '0.682', 'green': '0.243', 'blue': '0.788', 'alpha': '1.000'}}}],
            'info': {'author': 'xcode', 'version': 1},
        }, f, indent=2)
        f.write('\n')


if __name__ == '__main__':
    main()
