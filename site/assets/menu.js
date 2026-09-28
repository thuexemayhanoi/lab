// menu.js — tiny vanilla menu interactions (dropdowns + mobile drawer). No frameworks.
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
   if(g.classList.contains('open')){var f=g.querySelector('.dd-link');if(f)f.focus();}}
 });
 // hover-intent open for fine pointers (click still works for touch/keyboard)
 g.addEventListener('mouseenter',function(){if(window.matchMedia('(hover:hover) and (pointer:fine)').matches){
  groups.forEach(closeGroup);g.classList.add('open');btn.setAttribute('aria-expanded','true');}});
 g.addEventListener('mouseleave',function(){if(window.matchMedia('(hover:hover) and (pointer:fine)').matches)closeGroup(g);});
 g.querySelectorAll('.dd-link').forEach(function(a){
  a.addEventListener('keydown',function(e){if(e.key==='Escape'){closeGroup(g);btn.focus();}});
 });
});
document.addEventListener('click',function(e){groups.forEach(function(g){if(!g.contains(e.target))closeGroup(g);});});
document.addEventListener('keydown',function(e){if(e.key==='Escape')groups.forEach(closeGroup);});
// mobile drawer
var toggle=document.querySelector('.menu-toggle'),drawer=document.getElementById('drawer');
function setDrawer(open){
 if(!drawer)return;
 if(open){drawer.hidden=false;drawer.setAttribute('aria-hidden','false');}
 else{drawer.hidden=true;drawer.setAttribute('aria-hidden','true');}
 if(toggle)toggle.setAttribute('aria-expanded',String(open));
 if(open){var c=drawer.querySelector('.drawer-close');if(c)c.focus();}
 else if(toggle)toggle.focus();
}
if(toggle&&drawer){
 toggle.addEventListener('click',function(){setDrawer(drawer.hidden);});
 var close=drawer.querySelector('.drawer-close');
 if(close)close.addEventListener('click',function(){setDrawer(false);});
 drawer.addEventListener('click',function(e){if(e.target===drawer)setDrawer(false);});
 document.addEventListener('keydown',function(e){if(e.key==='Escape'&&!drawer.hidden)setDrawer(false);});
}
// deep link to homepage search
if(location.pathname==='/lab/'&&location.hash==='#q'){
 var q=document.getElementById('q');if(q){q.focus();}
}
})();