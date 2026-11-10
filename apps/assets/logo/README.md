# Linger product logo

The approved identity is an ivory L and amber dot on a dark rounded tile.
`source/linger.png` is the exact 1024 × 1024 image supplied by the product owner.
`source/linger.svg` is its three-color path tracing. No generative edits are used.
The primary wordmark in `source/wordmark.png` is also supplied by the owner.
Its L symbol is the first letter of the word, followed directly by `inger`.
`source/wordmark.svg` traces that lettering without substituting a font.

## Assets and consumers

- `logo-mark.*` and `app-icon.png`: the approved tile; PNG preserves the input pixels.
- `logo-horizontal.*`, `logo-wordmark.*`: the unified primary wordmark.
- `logo-horizontal-dark.svg`: light lettering for dark documentation headers.
- `windows/linger.ico`: 16, 24, 32, 48, 64, 128 and 256 pixel images.
- `macos/linger.icns` and `macos/linger.iconset`: a padded app tile up to 1024 pixels.
- `linux/<size>x<size>/linger.png`: square icons from 16 through 1024 pixels.
- `web/`: SVG, PNG and ICO favicons, Apple touch icon, ordinary and maskable web app icons.
- `tray/`: black L-and-dot template shapes on transparency and full-color tiles, at 16 and 32 pixels.
- `preview.jpg`: brand lockup and small-size preview.

`apps/web/public` holds the four public favicon/touch-icon copies. `BrandMark`
uses the same favicon SVG on the login screen, navigation and error surfaces.
Connector logos and agent avatars are separate identities and stay unchanged.

`apps/desktop/resources` holds the app icon, native icon bundles, header lockup
and tray copies. macOS uses only the template alpha; Windows and Linux use the
color tile. Status badges remain a runtime overlay. The template has no app-tile
background, so macOS can tint it correctly on either menu-bar appearance.

The root README uses the horizontal SVG. The `lev9-docs` repository consumes
copies of `logo-horizontal.svg`, `logo-horizontal-dark.svg` and `web/favicon.svg`
as `logo/light.svg`, `logo/dark.svg` and `favicon.svg` respectively.

## Regeneration

Install Pillow and CairoSVG, with the Cairo shared library available, then run:

```sh
python3 apps/assets/logo/export.py
```

The exporter derives every size from the checked-in source assets and also
synchronizes Web and desktop copies. No image-generation service, font install,
Node dependency or macOS icon tool is required. The traced SVG wordmark avoids
host font substitution. After changing the sources, copy the three documentation
assets into `lev9-docs` in the same branding update.

`web/site.webmanifest` contains icon entries only. Merge them into the app's
manifest rather than treating this fragment as an installable application.
