"""Render the unedited timed CLI capture with Pillow and FFmpeg (no network)."""
import json
import math
import pathlib
import subprocess
from PIL import Image, ImageDraw, ImageFont

HERE = pathlib.Path(__file__).resolve().parent
recording = json.loads((HERE / 'recording.json').read_text())
WIDTH, HEIGHT, FPS = 1920, 1080, 30
mono = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf', 30)
bold = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf', 30)
title = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 48)
small = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 23)
base = Image.new('RGB', (WIDTH, HEIGHT), '#0a101c')
d = ImageDraw.Draw(base)
d.text((100, 55), 'CarryForward', font=title, fill='#f0f5ff')
d.text((530, 77), 'Keep the work moving.', font=small, fill='#95a9c6')
d.text((1420, 78), 'ISOLATED DEMO', font=small, fill='#8197b5')
d.rounded_rectangle((80, 150, 1840, 1020), radius=22, fill='#111b2b', outline='#2b3b52', width=2)
for x, color in [(119, '#ff6b70'), (147, '#e9bf65'), (175, '#5dd3a0')]:
    d.ellipse((x, 177, x+13, 190), fill=color)
d.text((790, 168), 'carryforward  /  terminal', font=small, fill='#8296b2')
d.line((82, 211, 1838, 211), fill='#2b3b52', width=2)

def frame(t):
    im = base.copy()
    draw = ImageDraw.Draw(im)
    text = ''.join(e['text'] for e in recording['events'] if e['t'] <= t)
    y = 236
    for line in text.splitlines():
        if not line:
            y += 14
            continue
        color, font = '#d9e3f2', mono
        if line.startswith('$'):
            color = '#f0f5ff'
        elif line.startswith('Codex'):
            color, font = '#9dbbff', bold
        elif line.startswith('CarryForward:'):
            color = '#f5ca83' if 'quota' in line else '#75dfc3'
        elif line.startswith('✓'):
            color = '#8de0bb'
        elif line.startswith('Context'):
            color = '#9dbbff'
        assert draw.textlength(line, font=font) < 1640
        draw.text((125, y), line, font=font, fill=color)
        y += 39
    assert y < 1010, y
    return im

encoder = subprocess.Popen(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{WIDTH}x{HEIGHT}', '-r', str(FPS), '-i', '-', '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', str(HERE / 'carryforward-demo.mp4')], stdin=subprocess.PIPE)
for i in range(math.ceil(recording['duration'] * FPS)):
    encoder.stdin.write(frame(i / FPS).tobytes())
encoder.stdin.close()
assert encoder.wait() == 0
subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', str(HERE / 'carryforward-demo.mp4'), '-filter_complex', 'fps=12,scale=1280:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a', '-loop', '0', str(HERE / 'carryforward-demo.gif')], check=True)
# A contact sheet for review, including the complete final frame.
times = [2.9, 4.3, 6.7, recording['duration'] - 0.1]
sheet = Image.new('RGB', (1920, 1080))
for i, t in enumerate(times):
    sheet.paste(frame(t).resize((960, 540)), ((i % 2) * 960, (i // 2) * 540))
sheet.save('/tmp/carryforward-demo-review.png')
print('Rendered MP4, GIF, and /tmp/carryforward-demo-review.png')
