// menu.js — tiny vanilla interactions: dropdowns, drawer (focus trap + scroll lock),
// active nav, reading progress, back-to-top. No frameworks. Canonical source:
// scripts/site/menu.js — build-site.js copies this verbatim into /lab/assets/menu.js.
(function(){
'use strict';
var groups=[].slice.call(document.querySelectorAll('.nav-group'));
function closeGroup(g){g.classList.remove('open');var b=g.querySelector('.nav-drop');if(b)b.setAttribute('aria-expanded','false');}
function toggleGroup(g){
 var open=!g.classList.contains('open');
 groups.forEach(closeGroup);
 if(open){g.classList.add('open');var b=g.querySelector('.nav-drop');if(b)b.setAttribute('aria-expanded','true');}
}
groups.forEach(function(g){
 var btn=g.querySelector('.nav-drop');
 if(!btn)return;
 btn.addEventListener('click',function(e){e.stopPropagation();toggleGroup(g);});
 btn.addEventListener('keydown',function(e){
  if(e.key==='ArrowDown'||e.key==='Enter'||e.key===' '){e.preventDefault();toggleGroup(g);
   if(g.classList.contains('open')){var f=g.querySelector('.dd-link');if(f)f.focus();}}});
 g.addEventListener('mouseenter',function(){if(window.matchMedia('(hover:hover) and (pointer:fine)').matches){
  groups.forEach(closeGroup);g.classList.add('open');btn.setAttribute('aria-expanded','true');}});
 g.addEventListener('mouseleave',function(){if(window.matchMedia('(hover:hover) and (pointer:fine)').matches)closeGroup(g);});
 [].forEach.call(g.querySelectorAll('.dd-link'),function(a){
  a.addEventListener('keydown',function(e){if(e.key==='Escape'){closeGroup(g);btn.focus();}});
 });
});
document.addEventListener('click',function(e){groups.forEach(function(g){if(!g.contains(e.target))closeGroup(g);});});
document.addEventListener('keydown',function(e){if(e.key==='Escape')groups.forEach(closeGroup);});
// mobile drawer: ESC / overlay / X close + keyboard focus trap (aria-modal dialog)
var toggle=document.querySelector('.menu-toggle'),drawer=document.getElementById('drawer');
function drawerFocusables(){
 if(!drawer)return[];
 return [].filter.call(drawer.querySelectorAll('a[href],button:not([disabled])'),function(el){return el.offsetParent!==null;});
}
function trapDrawerTab(e){
 var f=drawerFocusables();
 if(!f.length)return;
 var first=f[0],last=f[f.length-1];
 if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}
 else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}
}
function setDrawer(open){
 if(!drawer)return;
 drawer.hidden=!open;
 if(toggle)toggle.setAttribute('aria-expanded',String(open));
 document.body.classList[open?'add':'remove']('drawer-open');
 if(open){
  var c=drawer.querySelector('.drawer-close');if(c)c.focus();
  drawer.addEventListener('keydown',trapDrawerTab);
 }
 else{
  drawer.removeEventListener('keydown',trapDrawerTab);
  if(toggle)toggle.focus();
 }
}
if(toggle&&drawer){
 toggle.addEventListener('click',function(){setDrawer(drawer.hidden);});
 var close=drawer.querySelector('.drawer-close');
 if(close)close.addEventListener('click',function(){setDrawer(false);});
 drawer.addEventListener('click',function(e){if(e.target===drawer)setDrawer(false);});
 document.addEventListener('keydown',function(e){if(e.key==='Escape'&&!drawer.hidden)setDrawer(false);});
}
// active nav state from current path (aria-current + accent highlight)
(function(){
 var path=location.pathname.replace(/index.html$/,'');
 [].forEach.call(document.querySelectorAll('a.nav-link,a.dd-link,a.dr-link'),function(el){
  var href=el.getAttribute('href');
  if(!href||href.indexOf('/lab/')!==0)return;
  if(href==='/lab/#q')return;
  if(href==='/lab/'){if(path==='/lab/'||path==='/lab'){el.classList.add('active');el.setAttribute('aria-current','page');}return;}
  var seg=href.split('/').filter(Boolean).slice(1).join('/');
  if(seg&&('/lab/'+seg+'/')===path){el.classList.add('active');el.setAttribute('aria-current','page');}
  else if(seg&&path.indexOf('/lab/'+seg+'/')===0){el.classList.add('active');}
 });
 // highlight hub dropdown + drawer group containing the active child
 var active=document.querySelector('.dd-link.active');
 if(active){var g=active.closest('.nav-group');if(g){var b=g.querySelector('.nav-drop');if(b)b.classList.add('active');}}
})();
// reading progress bar (article pages)
(function(){
 var bar=document.createElement('div');bar.className='progress';bar.setAttribute('aria-hidden','true');
 var hasArticle=document.querySelector('.wrap.article, main article');
 if(!hasArticle)return;
 document.body.appendChild(bar);
 var raf=null;
 function update(){
  var h=document.documentElement;
  var max=h.scrollHeight-h.clientHeight;
  bar.style.width=(max>0?(h.scrollTop/max)*100:0)+'%';
  raf=null;
 }
 window.addEventListener('scroll',function(){if(!raf)raf=requestAnimationFrame(update);},{passive:true});
 window.addEventListener('resize',function(){if(!raf)raf=requestAnimationFrame(update);},{passive:true});
 update();
})();
// back to top
(function(){
 var btn=document.getElementById('to-top');
 if(btn)btn.addEventListener('click',function(){
  if(window.matchMedia('(prefers-reduced-motion: reduce)').matches)window.scrollTo(0,0);
  else window.scrollTo({top:0,behavior:'smooth'});});
})();
})();
