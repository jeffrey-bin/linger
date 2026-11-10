"""Export and synchronize the approved Linger identity (Pillow and CairoSVG)."""

from pathlib import Path
from io import BytesIO
import ctypes.util
import json
import shutil
import xml.etree.ElementTree as ET
from PIL import Image, ImageOps

# Apple's Python does not search Homebrew's Cairo library directory.
if not ctypes.util.find_library('cairo') and Path('/opt/homebrew/lib/libcairo.2.dylib').exists():
    find_library = ctypes.util.find_library
    ctypes.util.find_library = lambda name: '/opt/homebrew/lib/libcairo.2.dylib' if name == 'cairo' else find_library(name)
import cairosvg

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[2]
INK = '#141414'
IVORY = '#f6f5f1'
NS = 'http://www.w3.org/2000/svg'
ET.register_namespace('', NS)


def write(name, text):
    path = ROOT / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


def raster(svg, width, height=None):
    png = cairosvg.svg2png(bytestring=svg.encode(), output_width=width, output_height=height)
    return Image.open(BytesIO(png)).convert('RGBA')


def save(name, image):
    path = ROOT / name
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path)


def fit(image, size, fraction=1, background=(0, 0, 0, 0)):
    result = Image.new('RGBA', (size, size), background)
    thumb = ImageOps.contain(image, (round(size*fraction), round(size*fraction)), Image.Resampling.LANCZOS)
    result.alpha_composite(thumb, ((size-thumb.width)//2, (size-thumb.height)//2))
    return result


source = Image.open(ROOT/'source/linger.png').convert('RGBA')
mark = (ROOT/'source/linger.svg').read_text()
dark_word = (ROOT/'source/wordmark.svg').read_text()
horizontal = dark_word.replace('#F6F5F1', '#141414')
word_box = list(map(float, ET.fromstring(dark_word).attrib['viewBox'].split()))
horizontal_width = round(word_box[2] * 72 / word_box[3])
for name, svg in [('logo-mark', mark), ('logo-wordmark', horizontal), ('logo-horizontal', horizontal), ('logo-horizontal-dark', dark_word)]:
    write(name+'.svg', svg)
    save(name+'.png', source if name == 'logo-mark' else raster(svg, 1280))
save('app-icon.png',source)
for size in [16,24,32,48,64,128,256,512,1024]:
    save(f'linux/{size}x{size}/linger.png',fit(source,size))
for size in [16,32,48,64]:
    save(f'web/favicon-{size}.png',fit(source,size))
save('web/favicon.png',fit(source,512))
write('web/favicon.svg',mark)
save('web/apple-touch-icon.png',fit(source,180,background=INK))
for size in [192,512]:
    save(f'web/icon-{size}.png',fit(source,size))
    # The entire tile fits inside the maskable icon's central safe circle.
    save(f'web/icon-maskable-{size}.png',fit(source,size,0.56,INK))
(ROOT/'windows').mkdir(exist_ok=True)
fit(source,256).save(ROOT/'windows/linger.ico',sizes=[(s,s) for s in [16,24,32,48,64,128,256]])
fit(source,64).save(ROOT/'web/favicon.ico',sizes=[(s,s) for s in [16,32,48,64]])
tile=fit(source,1024,0.875)
save('macos/linger.png',tile)
iconset=ROOT/'macos/linger.iconset'
iconset.mkdir(parents=True,exist_ok=True)
for size in [16,32,128,256,512]:
    for scale in [1,2]:
        suffix='@2x' if scale==2 else ''
        tile.resize((size*scale,size*scale),Image.Resampling.LANCZOS).save(iconset/f'icon_{size}x{size}{suffix}.png')
tile.save(ROOT/'macos/linger.icns',format='ICNS')
# Template artwork contains only the L and dot, never the dark app tile.
template_root=ET.fromstring(mark)
for child in list(template_root):
    if child.attrib.get('fill','').lower()==INK:
        template_root.remove(child)
    else:
        child.set('fill','#000000')
# Remove the app tile's outer padding so the menu-bar glyph remains legible.
template_root.set('viewBox', '160 160 704 704')
template=ET.tostring(template_root,encoding='unicode')
write('tray/template.svg',template)
for size in [16,32]:
    save(f'tray/mark-{size}.png',raster(template,size,size))
    save(f'tray/tile-{size}.png',fit(source,size))
manifest={'name':'Linger','short_name':'Linger','icons':[
    {'src':f'icon-{size}.png','sizes':f'{size}x{size}','type':'image/png','purpose':'any'} for size in [192,512]
]+[
    {'src':f'icon-maskable-{size}.png','sizes':f'{size}x{size}','type':'image/png','purpose':'maskable'} for size in [192,512]
]}
write('web/site.webmanifest',json.dumps(manifest,indent=2)+'\n')
for name in ['favicon.svg','favicon.png','favicon.ico','apple-touch-icon.png']:
    shutil.copyfile(ROOT/'web'/name,REPO/'apps/web/public'/name)
resources=REPO/'apps/desktop/resources'
for src,dst in [('app-icon.png','icon.png'),('macos/linger.icns','linger.icns'),('windows/linger.ico','linger.ico')]:
    shutil.copyfile(ROOT/src,resources/dst)
raster(horizontal,horizontal_width,72).save(resources/'logo-horizontal.png')
for size in [16,32]:
    for kind in ['mark','tile']:
        shutil.copyfile(ROOT/f'tray/{kind}-{size}.png',resources/f'tray/{kind}-{size}.png')
preview=Image.new('RGBA',(1200,800),IVORY)
preview.alpha_composite(fit(source,460),(50,50))
preview.alpha_composite(raster(horizontal,600),(550,140))
for i,size in enumerate([16,32,48,64,128]):
    preview.alpha_composite(fit(source,size),(560+i*115,460))
preview.convert('RGB').save(ROOT/'preview.jpg',quality=95)
dark_preview = Image.new('RGBA', (1440, 600), INK)
word_image = raster(dark_word, 1200)
dark_preview.alpha_composite(word_image, (120, (600-word_image.height)//2))
dark_preview.convert('RGB').save(ROOT/'preview-dark.jpg', quality=95)
print('Exported canonical assets and synchronized Web and desktop copies.')
