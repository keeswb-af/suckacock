#!/usr/bin/env python3
"""Draw the home-screen icon (a tilted orange price sticker with a % sign)."""
import pathlib
from PIL import Image, ImageDraw, ImageFont

OUT = pathlib.Path(__file__).resolve().parent / "dist"
OUT.mkdir(exist_ok=True)

def draw(size):
    s = size * 4
    img = Image.new("RGB", (s, s), (31, 92, 69))
    d = ImageDraw.Draw(img)
    pad = int(s * 0.14)
    sticker = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    sd = ImageDraw.Draw(sticker)
    sd.ellipse([pad, pad, s - pad, s - pad], fill=(242, 84, 27, 255))
    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", int(s * 0.38))
    except OSError:
        font = ImageFont.load_default()
    sd.text((s / 2, s / 2), "%", font=font, fill=(255, 255, 255, 255), anchor="mm")
    sticker = sticker.rotate(12, resample=Image.BICUBIC)
    img.paste(sticker, (0, 0), sticker)
    return img.resize((size, size), Image.LANCZOS)

for n in (180, 512):
    draw(n).save(OUT / f"icon-{n}.png")
print("icons written")
