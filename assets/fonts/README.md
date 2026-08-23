# Fonts

The site used to pull Space Grotesk and JetBrains Mono from
`fonts.googleapis.com`. It doesn't any more, because that made a third-party
request on every page load and handed Google an IP address and a user agent —
while the footer and section 9 of the method page promise "no cross-site
tracking". Section 1 of `assets/css/style.css` carries the full reasoning.

So the two files live here instead. `tests/h1.mjs` fails until they do, and also
fails if any page ever reaches out to a font CDN again.

## What goes in this folder

| File | What it is |
|---|---|
| `space-grotesk-latin.woff` | Space Grotesk, variable 300–700, subset to Latin |
| `jetbrains-mono-latin.woff` | JetBrains Mono, variable 400–500, subset to Latin |
| `OFL.txt` | The SIL Open Font License 1.1, which both are released under |

Both families are OFL-1.1, so redistributing them inside this repository is
allowed. The licence requires that the licence text ships alongside them, which
is what `OFL.txt` is doing here and why h1 checks for it.

## How to replace them

Download the two families from Google Fonts — **Get font** → **Download all** —
and leave the zips anywhere in the project folder. Each zip contains a variable
`.ttf` and an `OFL.txt`.

The `.ttf` files are not what goes here. They're several hundred kilobytes each
because they carry Cyrillic, Greek and Vietnamese glyph sets this site will never
render. They get subset to Latin and repacked, which takes them to roughly a
tenth of that.

The subsetting is deliberately not a script in `tools/`. Everything in there runs
on a plain Node checkout with nothing installed, and this needs Python with
`fonttools` — a build-time dependency that would be the only one in the project.
It runs once per font release, so it is recorded here instead:

```bash
pip install fonttools

# Space Grotesk — its weight axis is already 300-700, so nothing is instanced away.
pyftsubset SpaceGrotesk-VariableFont_wght.ttf \
  --output-file=assets/fonts/space-grotesk-latin.woff --flavor=woff \
  --unicodes=U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD \
  --layout-features='*' --no-hinting --desubroutinize

# JetBrains Mono ships a 100-800 axis; the site uses 400 and 500, so the rest of
# the axis is instanced out before subsetting.
python3 -m fontTools.varLib.instancer \
  JetBrainsMono-VariableFont_wght.ttf wght=400:500 -o /tmp/jbm-trimmed.ttf
pyftsubset /tmp/jbm-trimmed.ttf \
  --output-file=assets/fonts/jetbrains-mono-latin.woff --flavor=woff \
  --unicodes=U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD \
  --layout-features='*' --no-hinting --desubroutinize
```

That unicode range is Latin plus Latin-1 Supplement plus the punctuation and
symbols actually used. Latin-1 is not optional: team names carry accents, and
`Atlético` rendering as `Atl?tico` would be a worse bug than a slow font. The
arrows and the minus sign are in there because the interface uses `→`, `↑`, `↓`
and a real `−` rather than a hyphen.

## Why WOFF and not WOFF2

WOFF2 would be about a quarter smaller and every browser that matters supports
it. Its compression is brotli by definition, and the environment these were cut
in has no brotli available, so WOFF 1.0 — which is plain zlib — is what could
actually be produced and verified here.

That is a build-environment limitation, not a decision about what's best. If
`.woff2` files turn up later, swapping them in means dropping them in this
folder and changing the two `format('woff')` hints in section 1 of the
stylesheet. Nothing else refers to the format.
