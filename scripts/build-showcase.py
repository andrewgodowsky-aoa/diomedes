import json, pathlib
from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph
from reportlab.lib.styles import ParagraphStyle
from pypdf import PdfReader
root=pathlib.Path('F:/Achilles/diomedes')
output=root/'output/pdf/Diomedes-showcase.pdf'
pdfmetrics.registerFont(TTFont('Segoe','C:/Windows/Fonts/segoeui.ttf'))
pdfmetrics.registerFont(TTFont('SegoeBold','C:/Windows/Fonts/seguisb.ttf'))
ink=HexColor('#172d44'); muted=HexColor('#4d6179'); paper=HexColor('#f5f8fc'); blue=HexColor('#234bce')
c=canvas.Canvas(str(output),pagesize=(1000,760))
c.setTitle('Diomedes Systems | A tour of Diomedes');c.setAuthor('Diomedes Systems')
rows=json.loads((root/'output/showcase/captions.json').read_text())
labels=['Home','Plan','Tasks','Work','Review','History']
def bg():
 c.setFillColor(paper);c.rect(0,0,1000,760,fill=1,stroke=0)
def text(x,y,t,size=14,font='Segoe',color=ink):
 c.setFillColor(color);c.setFont(font,size);c.drawString(x,y,t)
def para(x,y,t,width=900,size=14,color=muted):
 p=Paragraph(t,ParagraphStyle('copy',fontName='Segoe',fontSize=size,leading=size*1.45,textColor=color))
 w,h=p.wrap(width,300);p.drawOn(c,x,y-h);return h
def footer(n):
 text(40,24,'Diomedes Systems / Diomedes desktop preview / Sample project',10,color=muted)
 c.setFont('Segoe',10);c.drawRightString(960,24,str(n))
def shot(row,x,y,w):
 c.drawImage(str(root/'output/showcase/screenshots'/f"{row['id']}.png"),x,y,width=w,height=w*1000/1680,mask='auto')
bg();text(40,704,'Diomedes',48,'SegoeBold');text(42,665,'A place for your plans, tasks, and documents.',21)
para(42,632,'A visual tour of the Windows app. Six real pages, clearer text, and captions that explain what each part does.',800,14)
short=['Pick up your project','Shape a readable plan','See work at a glance','Decide what goes ahead','Review changed files','Return to earlier work']
for i,row in enumerate(rows):
 x=40+(i%3)*316;y=355-(i//3)*252
 shot(row,x,y,288);text(x,y-25,labels[i],17,'SegoeBold');text(x,y-46,short[i],12,color=muted)
text(40,561,'Captured from the app using a sample restaurant project. The demonstration does not use a live AI model.',10,color=muted)
footer(1);c.showPage()
for i,row in enumerate(rows):
 bg();text(40,713,'Diomedes / '+labels[i],13,color=blue);text(40,672,row['title'],30,'SegoeBold')
 para(40,647,row['caption'],910,14)
 shot(row,40,64,920)
 footer(i+2);c.showPage()
bg();text(40,710,'More from Diomedes Systems',34,'SegoeBold')
text(40,662,'Ascension of Ages',24,'SegoeBold')
para(40,637,'A Minecraft adventure built around eight ages of discovery. Quests, technology, magic, and boss encounters form a connected journey, with new tools and challenges opening as you progress.',490,15)
c.drawImage('F:/Achilles/showcase/public/images/ascension-of-ages.jpg',590,435,width=370,height=208,preserveAspectRatio=True,anchor='c')
text(40,521,'Available on CurseForge',13,'SegoeBold',blue)
url='https://www.curseforge.com/minecraft/modpacks/ascension-of-ages'
text(40,491,'Explore Ascension of Ages',14,color=blue);c.linkURL(url,(40,487,235,510),relative=0)
text(590,420,'Image: official CurseForge gallery',10,color=muted)
text(40,372,'RustbucketUE',24,'SegoeBold')
para(40,345,'A space game in development, built in Unreal Engine. Its direction centers on building and flying ships with walkable interiors, an industrial feel, and exploration.',800,15)
para(40,263,'In development. A public game release is not available yet.',800,13)
text(40,184,'Follow the projects. Start a conversation.',20,'SegoeBold')
url='https://github.com/andrewgodowsky-aoa'
text(40,146,'github.com/andrewgodowsky-aoa',15,color=blue);c.linkURL(url,(40,138,380,162),relative=0)
text(40,110,'andrewgodowsky@gmail.com',15,color=blue)
c.linkURL('mailto:andrewgodowsky@gmail.com',(40,102,350,126),relative=0)
footer(8);c.showPage();c.save()
pages=PdfReader(str(output)).pages
assert len(pages)==8
assert all((p.extract_text() or '').strip() for p in pages)
print(f'Created {output}; 8 pages, all captions extractable.')

