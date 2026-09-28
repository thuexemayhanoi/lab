let IDX=null,IDX_ERR=false,LASTQ='';
function foldText(s){
 return (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'')
  .replace(/đ/g,'d').replace(/\s+/g,' ').trim();
}
fetch('/lab/assets/search-index.json').then(function(r){
 if(!r.ok)throw new Error('HTTP '+r.status);
 return r.json();
}).then(function(d){
 IDX=d.map(function(x){x._f=foldText([x.t,x.d,x.p,x.l,x.m,x.b,x.v].join(' '));return x;});
 if(LASTQ)doSearch(LASTQ);
}).catch(function(){IDX_ERR=true;});
var CLV={RENTAL:'Thuê xe máy',RESCUE:'Cứu hộ xe máy',REPAIR:'Sửa chữa & bảo dưỡng',LICENCE:'Bằng lái xe máy',REGISTRATION:'Đăng ký xe máy',ELECTRIC:'Xe máy điện',PARTS:'Phụ tùng xe máy'};
function doSearch(raw){
 LASTQ=raw||'';
 var q=foldText(LASTQ);
 var el=document.getElementById('search-results');
 if(!el)return;
 if(IDX_ERR){el.innerHTML='<li class="sr-meta">Không tải được chỉ mục tìm kiếm. Hãy kiểm tra kết nối và tải lại trang.</li>';return;}
 if(!q){el.innerHTML='';return;}
 if(IDX===null){el.innerHTML='<li class="sr-meta">Đang tải chỉ mục tìm kiếm…</li>';return;}
 var hits=IDX.filter(function(x){return x._f.indexOf(q)>-1;}).slice(0,10);
 el.innerHTML=hits.length?hits.map(function(h){return '<li class="sr-card"><span class="article-chip">'+(CLV[h.c]||h.c)+'</span><a class="sr-title" href="/lab/'+h.u+'">'+h.t+'</a><span class="sr-meta">'+(h.p||'')+'</span></li>';}).join(''):'<li class="sr-meta">Không tìm thấy bài đã xuất bản nào.</li>';
}
