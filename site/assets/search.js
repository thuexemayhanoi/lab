let IDX=null;
fetch('/lab/assets/search-index.json').then(r=>r.json()).then(d=>IDX=d);
function doSearch(q){
 q=(q||'').toLowerCase().trim();
 const el=document.getElementById('search-results');
 if(!q||!IDX){el.innerHTML='';return;}
 const hits=IDX.filter(x=>(x.t+' '+x.d+' '+x.p+' '+x.l+' '+x.m).toLowerCase().includes(q)).slice(0,10);
 el.innerHTML=hits.length?hits.map(h=>'<li><a href="/lab/'+h.u+'">'+h.t+'</a></li>').join(''):'<li>Không tìm thấy bài đã xuất bản nào.</li>';
}
