#!/usr/bin/env node
/**
 * generate-matrix.js — deterministic 10,000-row candidate matrix generator.
 * Allocations: RENTAL 5000, RESCUE 1000, REPAIR 800, LICENCE 800,
 *              REGISTRATION 600, ELECTRIC 1200, PARTS 600.
 * Guarantees: exactly 10,000 rows; unique article_id, slug, output_path,
 *             canonical, primary_keyword. Deterministic: same input → same CSV.
 */
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'site.json'), 'utf8'));
const BASE = cfg.base_url;

const provinces = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/geography/provinces.json'), 'utf8')).provinces.map(p => p.name);
const localities = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/geography/localities.json'), 'utf8')).localities;
const hubs = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/geography/transport-hubs.json'), 'utf8')).transport_hubs;
const tpois = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/geography/tourism-poi.json'), 'utf8')).tourism_poi;

const slugify = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
const FIELDS = ['article_id','cluster','parent_topic','primary_keyword','secondary_keywords','search_intent','geo_id','geo_level','province','locality','poi','brand','model','vehicle_type','part','use_case','duration','requires_research','requires_official_sources','actual_service_area','cannibalization_group','slug','output_path','canonical','status','research_status','qa_score','repair_attempts','published_date'];
const rows = [];
const byCluster = {};
const seenKw = new Set(), seenSlug = new Set();
function add(r) {
  const kw = r.primary_keyword || r.kw;
  if (!kw) throw new Error('missing kw in ' + JSON.stringify(r).slice(0,80));
  if (seenKw.has(kw)) return false;
  const slug = slugify(kw);
  if (!slug || seenSlug.has(slug)) return false;
  seenKw.add(kw); seenSlug.add(slug);
  const output_path = r._path + slug + '/';
  rows.push({
    article_id: 'A' + String(rows.length + 1).padStart(5, '0'),
    cluster: r.cluster, parent_topic: r.parent_topic, primary_keyword: kw,
    secondary_keywords: r.secondary_keywords || '', search_intent: r.intent || 'informational',
    geo_id: r.geo_id || '', geo_level: r.geo_level || '', province: r.province || '',
    locality: r.locality || '', poi: r.poi || '', brand: r.brand || '', model: r.model || '',
    vehicle_type: r.vehicle_type || '', part: r.part || '', use_case: r.use_case || '',
    duration: r.duration || '', requires_research: r.research || '1', requires_official_sources: r.official || '0',
    actual_service_area: r.area || 'informational_only', cannibalization_group: r.cg,
    slug, output_path, canonical: BASE + output_path,
    status: 'PLANNED', research_status: 'NOT_STARTED', qa_score: '', repair_attempts: '0', published_date: ''
  });
  return true;
}

// ---------- RENTAL (5000) ----------
const HN = 'Hà Nội';
const hnLoc = localities.filter(l => l.province === HN);
const models = [['Honda','Vision'],['Honda','Air Blade'],['Honda','Wave'],['Honda','Winner'],['Yamaha','Sirius'],['Yamaha','Exciter'],['Yamaha','Grande'],['Suzuki','Raider'],['Piaggio','Liberty'],['SYM','Ella']];
const types = ['xe ga','xe số','xe côn tay','xe cào cào'];
const useCases = ['đi phượt','đi du lịch','khách nước ngoài','đi làm','đi dài ngày'];
const durations = ['theo ngày','theo tuần','theo tháng'];
const hnRoutes = ['Tam Đảo','Ninh Bình','Ba Vì','Hạ Long','Tràng An','Đền Hùng','Chùa Hương','Sơn Tây'];
const rentalTargets = [];
provinces.forEach(p => rentalTargets.push({ kw: 'thuê xe máy ' + p, prov: p, path: 'thue-xe-may/', cg: 'CG-rental-loc-' + slugify(p), intent: p === HN ? 'local/commercial' : 'informational', area: p === HN ? 'hanoi_owner_verified' : 'informational_only' }));
hnLoc.forEach(l => rentalTargets.push({ kw: 'thuê xe máy ' + l.name, prov: HN, loc: l.name, path: 'thue-xe-may/', cg: 'CG-rental-loc-' + slugify(l.name), area: 'hanoi_owner_verified', intent: 'local/commercial' }));
hubs.forEach(h => rentalTargets.push({ kw: 'thuê xe máy gần ' + h.name, prov: h.province, poi: h.name, path: 'thue-xe-may/', cg: 'CG-rental-poi-' + slugify(h.name), intent: 'local' }));
tpois.forEach(t => rentalTargets.push({ kw: 'thuê xe máy ' + t.name, prov: t.province, poi: t.name, path: 'thue-xe-may/', cg: 'CG-rental-poi-' + slugify(t.name), intent: 'informational' }));
models.forEach(([b, m]) => { rentalTargets.push({ kw: 'thuê ' + b + ' ' + m + ' Hà Nội', prov: HN, brand: b, model: m, path: 'thue-xe-may/', cg: 'CG-rental-model-' + slugify(m), area: 'hanoi_owner_verified' });
  provinces.forEach(p => { if (p !== HN) rentalTargets.push({ kw: 'giá thuê ' + m + ' ' + p, prov: p, brand: b, model: m, path: 'thue-xe-may/', cg: 'CG-rental-price-' + slugify(m) + '-' + slugify(p) }); }); });
types.forEach(t => { rentalTargets.push({ kw: 'thuê ' + t + ' Hà Nội', prov: HN, vtype: t, path: 'thue-xe-may/', cg: 'CG-rental-type-' + slugify(t), area: 'hanoi_owner_verified' });
  rentalTargets.push({ kw: 'cửa hàng cho thuê ' + t + ' Hà Nội', prov: HN, vtype: t, path: 'thue-xe-may/', cg: 'CG-rental-shop-' + slugify(t), area: 'hanoi_owner_verified' });
  rentalTargets.push({ kw: 'chi phí thuê ' + t + ' Hà Nội', prov: HN, vtype: t, path: 'thue-xe-may/', cg: 'CG-rental-cost-' + slugify(t), area: 'hanoi_owner_verified' }); });
useCases.forEach(u => { rentalTargets.push({ kw: 'thuê xe máy ' + u + ' Hà Nội', prov: HN, use: u, path: 'thue-xe-may/', cg: 'CG-rental-use-' + slugify(u), area: 'hanoi_owner_verified' }); });
durations.forEach(d => { rentalTargets.push({ kw: 'thuê xe máy ' + d.toLowerCase() + ' Hà Nội', prov: HN, dur: d, path: 'thue-xe-may/', cg: 'CG-rental-dur-' + slugify(d), area: 'hanoi_owner_verified' }); });
hnRoutes.forEach(r => rentalTargets.push({ kw: 'thuê xe máy đi ' + r, prov: HN, poi: r, path: 'thue-xe-may/', cg: 'CG-rental-route-' + slugify(r), intent: 'informational' }));
rentalTargets.push({ kw: 'Vision hay Air Blade nên thuê dòng nào', path: 'thue-xe-may/', cg: 'CG-rental-cmp-vision-air-blade', brand: 'Honda', model: 'Vision', intent: 'comparison' });
rentalTargets.push({ kw: 'thuê xe máy cho khách nước ngoài Hà Nội cần giấy tờ gì', prov: HN, path: 'thue-xe-may/', cg: 'CG-rental-foreign', area: 'hanoi_owner_verified' });
['thuê xe máy tự lái Hà Nội','thuê xe máy giao tận nơi Hà Nội','thuê xe máy không cần cọc Hà Nội','thuê xe máy có bao nhiên liệu không','thuê xe máy về quê có được không','thuê xe máy ở Hà Nội mấy tiền một ngày','thuê xe máy đường trường cần chuẩn bị gì','mùa cao điểm thuê xe máy Hà Nội giá tăng không'].forEach(k => rentalTargets.push({ kw: k, prov: HN, path: 'thue-xe-may/', cg: 'CG-rental-x-' + slugify(k), area: 'hanoi_owner_verified' }));
localities.filter(l => l.province !== HN).forEach(l => rentalTargets.push({ kw: 'thuê xe máy ' + l.name + ' có không', prov: l.province, loc: l.name, path: 'thue-xe-may/', cg: 'CG-rental-locq-' + slugify(l.name) }));
// fill remainder with province × use/model variations (distinct intents)
outer: for (const p of provinces) {
  for (const u of useCases) { for (const d of durations) {
    if (rentalTargets.length >= 5000 + 5) { /* extra pool below */ }
  } } }
let pool = [];
provinces.forEach(p => { useCases.forEach(u => pool.push({ kw: 'thuê xe máy ' + p.toLowerCase() + ' ' + u, prov: p, use: u, path: 'thue-xe-may/', cg: 'CG-rental-pu-' + slugify(p) + '-' + slugify(u) }));
  durations.forEach(d => pool.push({ kw: 'thuê xe máy ' + p.toLowerCase() + ' ' + d.toLowerCase(), prov: p, dur: d, path: 'thue-xe-may/', cg: 'CG-rental-pd-' + slugify(p) + '-' + slugify(d) }));
  types.forEach(t => pool.push({ kw: 'thuê ' + t + ' ' + p, prov: p, vtype: t, path: 'thue-xe-may/', cg: 'CG-rental-pt-' + slugify(p) + '-' + slugify(t) }));
  models.forEach(([b, m]) => pool.push({ kw: 'thuê ' + m + ' ' + p, prov: p, brand: b, model: m, path: 'thue-xe-may/', cg: 'CG-rental-pm-' + slugify(p) + '-' + slugify(m) }));
  useCases.forEach(u => durations.forEach(d => pool.push({ kw: 'thuê xe máy ' + p.toLowerCase() + ' ' + u + ' ' + d.toLowerCase(), prov: p, use: u, dur: d, path: 'thue-xe-may/', cg: 'CG-rental-pud-' + slugify(p) + '-' + slugify(u) + '-' + slugify(d) })));
  models.forEach(([b, m]) => useCases.forEach(u => pool.push({ kw: 'thuê ' + m + ' ' + p.toLowerCase() + ' ' + u, prov: p, brand: b, model: m, use: u, path: 'thue-xe-may/', cg: 'CG-rental-pmu-' + slugify(p) + '-' + slugify(m) + '-' + slugify(u) })));
  types.forEach(t => durations.forEach(d => pool.push({ kw: 'thuê ' + t + ' ' + p.toLowerCase() + ' ' + d.toLowerCase(), prov: p, vtype: t, dur: d, path: 'thue-xe-may/', cg: 'CG-rental-ptd-' + slugify(p) + '-' + slugify(t) + '-' + slugify(d) })));
  models.forEach(([b, m]) => durations.forEach(d => pool.push({ kw: 'thuê ' + m + ' ' + p.toLowerCase() + ' ' + d.toLowerCase(), prov: p, brand: b, model: m, dur: d, path: 'thue-xe-may/', cg: 'CG-rental-pmd-' + slugify(p) + '-' + slugify(m) + '-' + slugify(d) })));
  types.forEach(t => useCases.forEach(u => pool.push({ kw: 'thuê ' + t + ' ' + p.toLowerCase() + ' cho ' + u, prov: p, vtype: t, use: u, path: 'thue-xe-may/', cg: 'CG-rental-ptu-' + slugify(p) + '-' + slugify(t) + '-' + slugify(u) }))); });
let ri = 0;
while (rentalTargets.length < 5000 && ri < pool.length) rentalTargets.push(pool[ri++]);
ri = 0; while (ri < pool.length) rentalTargets.push(pool[ri++]);
for (const r of rentalTargets) { if ((byCluster.RENTAL = (byCluster.RENTAL || 0)) >= 5000) break; if (add({ ...r, cluster: 'RENTAL', parent_topic: 'THUÊ XE MÁY', _path: r.path })) byCluster.RENTAL++; }

// ---------- RESCUE (1000) — informational directory/guidance, never fake service ----------
const rescue = [];
provinces.forEach(p => rescue.push({ kw: 'cứu hộ xe máy ' + p, prov: p, path: 'cuu-ho-xe-may/', cg: 'CG-rescue-loc-' + slugify(p), intent: 'emergency/local' }));
localities.forEach(l => rescue.push({ kw: 'cứu hộ xe máy ' + l.name, prov: l.province, loc: l.name, path: 'cuu-ho-xe-may/', cg: 'CG-rescue-res-loc-' + slugify(l.name), intent: 'emergency/local' }));
rescue.push({ kw: 'cứu hộ xe máy', path: 'cuu-ho-xe-may/', cg: 'CG-rescue-info-main' });
rescue.push({ kw: 'cứu hộ xe máy gần đây', path: 'cuu-ho-xe-may/', cg: 'CG-rescue-info-near' });
rescue.push({ kw: 'cứu hộ xe máy miễn phí những trường hợp nào', path: 'cuu-ho-xe-may/', cg: 'CG-rescue-info-free' });
rescue.push({ kw: 'cứu hộ xe máy giá bao nhiêu', path: 'cuu-ho-xe-may/', cg: 'CG-rescue-info-price' });
['cứu hộ xe máy là gì và khi nào cần','cứu hộ xe máy khác sửa xe máy thế nào','cứu hộ xe máy miễn phí dịp lễ có không','kéo xe về gara hay về nhà tốt hơn'].forEach(k => rescue.push({ kw: k, path: 'cuu-ho-xe-may/', cg: 'CG-rescue-x-' + slugify(k) }));
['lốp','ắc quy','hết xăng','cháy máy'].forEach(x => rescue.push({ kw: 'cứu hộ xe máy ' + x, part: x, path: 'cuu-ho-xe-may/', cg: 'CG-rescue-part-' + slugify(x) }));
pool = [];
const rescueConds = ['trên đường cao tốc','ban đêm','mùa mưa','dịp lễ tết','khi mưa lớn'];
['lốp','ắc quy','hết xăng','cháy máy','mất điện','phanh'].forEach(x => provinces.forEach(p => pool.push({ kw: 'cứu hộ xe máy ' + p.toLowerCase() + ' khi ' + x + ' hỏng', prov: p, part: x, path: 'cuu-ho-xe-may/', cg: 'CG-rescue-pp-' + slugify(p) + '-' + slugify(x) })));
provinces.forEach(p => rescueConds.forEach(c => pool.push({ kw: 'cứu hộ xe máy ' + p.toLowerCase() + ' ' + c, prov: p, path: 'cuu-ho-xe-may/', cg: 'CG-rescue-cond-' + slugify(p) + '-' + slugify(c) })));
['lốp','ắc quy','hết xăng','cháy máy','mất điện','phanh'].forEach(x => rescueConds.forEach(c => pool.push({ kw: 'cứu hộ xe máy ' + x + ' ' + c.toLowerCase(), part: x, path: 'cuu-ho-xe-may/', cg: 'CG-rescue-xc-' + slugify(x) + '-' + slugify(c) })));
['số điện thoại','ưu điểm cần kiểm tra','khi nào gọi 115','chi phí kéo xe','thời gian phản hồi','khu vực nội thành'].forEach(x => provinces.forEach(p => pool.push({ kw: 'cứu hộ xe máy ' + p.toLowerCase() + ': ' + x, prov: p, path: 'cuu-ho-xe-may/', cg: 'CG-rescue-as-' + slugify(p) + '-' + slugify(x) })));
localities.forEach(l => ['ưu điểm cần kiểm tra','chi phí tham khảo','phạm vi phục vụ'].forEach(a => pool.push({ kw: 'cứu hộ xe máy ' + l.name + ': ' + a, prov: l.province, loc: l.name, path: 'cuu-ho-xe-may/', cg: 'CG-rescue-la-' + slugify(l.name) + '-' + slugify(a) })));
ri = 0; while (rescue.length < 1000 && ri < pool.length) rescue.push(pool[ri++]);
ri = 0; while (ri < pool.length) rescue.push(pool[ri++]);
for (const r of rescue) { if ((byCluster.RESCUE = (byCluster.RESCUE || 0)) >= 1000) break; if (add({ ...r, cluster: 'RESCUE', parent_topic: 'CỨU HỘ XE MÁY', _path: r.path })) byCluster.RESCUE++; }

// ---------- REPAIR (800) ----------
const repair = [];
['sửa xe máy gần đây','sửa xe máy','bảo dưỡng xe máy định kỳ','sửa xe Honda','xe máy hao xăng','xe máy đề không nổ','xe máy bị giật khi tăng ga','xe máy kêu khi phanh','xe máy yếu máy','thay dầu máy xe ga','thay dầu máy xe số','thay nhông xích đĩa','thay ắc quy xe máy','thay bugi xe máy','vệ sinh chế hòa khí','vệ sinh kim phun','chăm sóc xe máy mới mua','xử lý xe máy ngập nước','xe máy bị rung','sửa chữa hệ thống điện xe máy'].forEach(k => repair.push({ kw: k, path: 'sua-xe-may/', cg: 'CG-repair-info-' + slugify(k) }));
models.forEach(([b, m]) => repair.push({ kw: 'sửa ' + m, brand: b, model: m, path: 'sua-xe-may/', cg: 'CG-repair-model-' + slugify(m) }));
['lốp','ắc quy','phanh','dầu máy','nhông xích','bugi','kim phun','chế hòa khí','đèn','điện','ECU','bộ ly hợp'].forEach(x => repair.push({ kw: 'sửa ' + x + ' xe máy', part: x, path: 'sua-xe-may/', cg: 'CG-repair-part-' + slugify(x) }));
hnLoc.slice(0, 12).forEach(l => repair.push({ kw: 'sửa xe máy ' + l.name, prov: HN, loc: l.name, path: 'sua-xe-may/', cg: 'CG-repair-loc-' + slugify(l.name), intent: 'local' }));
pool = [];
const repairTopics = ['uy tín','gần đây','giá rẻ','tại nhà','nhanh','24/7'];
['lốp','ắc quy','phanh','dầu máy','bugi','kim phun','điện'].forEach(x => provinces.forEach(p => pool.push({ kw: 'sửa ' + x + ' xe máy ' + p.toLowerCase(), prov: p, part: x, path: 'sua-xe-may/', cg: 'CG-repair-pp-' + slugify(p) + '-' + slugify(x) })));
provinces.forEach(p => repairTopics.forEach(c => pool.push({ kw: 'sửa xe máy ' + p.toLowerCase() + ' ' + c, prov: p, path: 'sua-xe-may/', cg: 'CG-repair-prov-' + slugify(p) + '-' + slugify(c) })));
models.forEach(([b, m]) => provinces.forEach(p => pool.push({ kw: 'sửa ' + m + ' ' + p.toLowerCase() + ' ở đâu', prov: p, brand: b, model: m, path: 'sua-xe-may/', cg: 'CG-repair-mp-' + slugify(p) + '-' + slugify(m) })));
ri = 0; while (repair.length < 800 && ri < pool.length) repair.push(pool[ri++]);
ri = 0; while (ri < pool.length) repair.push(pool[ri++]);
for (const r of repair) { if ((byCluster.REPAIR = (byCluster.REPAIR || 0)) >= 800) break; if (add({ ...r, cluster: 'REPAIR', parent_topic: 'SỬA CHỮA XE MÁY', _path: r.path })) byCluster.REPAIR++; }

// ---------- LICENCE (800) — official sources mandatory ----------
const lic = [];
['thi bằng lái xe máy A1','thi bằng lái xe máy','địa điểm thi bằng lái xe máy','thi bằng lái xe A1 online','hồ sơ thi bằng lái xe máy','lệ phí thi bằng lái xe máy A1','quy trình thi bằng lái xe máy','lý thuyết bằng lái xe máy A1','thực hành bằng lái xe máy A1','đổi bằng lái xe máy','cấp lại bằng lái xe máy','bằng lái xe máy bịa phạt thế nào','xe máy điện cần bằng lái gì','bằng A1 chạy được xe bao nhiêu cc','thi bằng lái xe máy ở đâu nhanh nhất'].forEach(k => lic.push({ kw: k, path: 'bang-lai-xe-may/', cg: 'CG-lic-info-' + slugify(k), official: '1' }));
provinces.forEach(p => lic.push({ kw: 'thi bằng lái xe máy ' + p, prov: p, path: 'bang-lai-xe-may/', cg: 'CG-lic-loc-' + slugify(p), official: '1', intent: 'local' }));
provinces.forEach(p => lic.push({ kw: 'địa điểm thi bằng lái xe máy ' + p, prov: p, path: 'bang-lai-xe-may/', cg: 'CG-lic-loc2-' + slugify(p), official: '1', intent: 'local' }));
pool = [];
provinces.forEach(p => ['hồ sơ','lệ phí','quy trình','đổi bằng','lịch thi','học phí','địa điểm','thi lại','kết quả','mẫu đơn'].forEach(c => pool.push({ kw: c + ' thi bằng lái xe máy ' + p.toLowerCase(), prov: p, path: 'bang-lai-xe-may/', cg: 'CG-lic-' + slugify(c) + '-' + slugify(p), official: '1' })));
provinces.forEach(p => pool.push({ kw: 'thi bằng lái xe A1 ' + p, prov: p, path: 'bang-lai-xe-may/', cg: 'CG-lic-a1-' + slugify(p), official: '1' }));
localities.forEach(l => ['hồ sơ','lệ phí','địa điểm thi','quy trình','lịch thi','thời gian nhận bằng'].forEach(c => pool.push({ kw: c + ' thi bằng lái xe máy ' + l.name, prov: l.province, loc: l.name, path: 'bang-lai-xe-may/', cg: 'CG-lic-' + slugify(c) + '-' + slugify(l.name), official: '1' })));
provinces.forEach(p => ['học lái xe máy','trung tâm dạy lái','giao bằng lái xe máy'].forEach(c => pool.push({ kw: c + ' tại ' + p, prov: p, path: 'bang-lai-xe-may/', cg: 'CG-lic-c-' + slugify(c) + '-' + slugify(p), official: '1' })));
provinces.forEach(p => ['bằng A1 chạy xe điện','điều kiện tuổi thi bằng A1','bằng lái A1 hết hạn'].forEach(c => pool.push({ kw: c + ' tại ' + p, prov: p, path: 'bang-lai-xe-may/', cg: 'CG-lic-d-' + slugify(c) + '-' + slugify(p), official: '1' })));
provinces.forEach(p => ['đăng ký học lái','ôn tập lý thuyết','thi thử','sai sót hồ sơ','học phí đào tạo','nhóm xe được phép điều khiển'].forEach(c => pool.push({ kw: c + ' bằng lái xe máy tại ' + p, prov: p, path: 'bang-lai-xe-may/', cg: 'CG-lic-e-' + slugify(c) + '-' + slugify(p), official: '1' })));
localities.forEach(l => ['ôn thi lý thuyết','thi thử thực hành','đổi bằng lái'].forEach(c => pool.push({ kw: c + ' bằng lái xe máy tại ' + l.name, prov: l.province, loc: l.name, path: 'bang-lai-xe-may/', cg: 'CG-lic-f-' + slugify(c) + '-' + slugify(l.name), official: '1' })));
ri = 0; while (ri < pool.length) lic.push(pool[ri++]);
for (const r of lic) { if ((byCluster.LICENCE = (byCluster.LICENCE || 0)) >= 800) break; if (add({ ...r, cluster: 'LICENCE', parent_topic: 'BẰNG LÁI XE MÁY', _path: r.path, official: '1' })) byCluster.LICENCE++; }

// ---------- REGISTRATION (600) — official sources mandatory ----------
const reg = [];
['đăng ký xe máy','đăng ký xe máy online','đăng ký xe máy điện','lệ phí đăng ký xe máy','nộp thuế trước bạ xe máy','biển số xe máy','cấp lại đăng ký xe máy','mất đăng ký xe máy xử lý thế nào','đổi đăng ký xe máy khi chuyển nơi cư trú','sang tên xe máy cũ','đăng ký xe máy cần giấy tờ gì','nơi đăng ký xe máy ở đâu','đăng ký xe máy online qua VNeID','mất biển số xe máy làm lại','biển số xe máy được cấp theo tỉnh nào','đăng ký xe máy mới mua','đăng ký lại xe cũ đã qua sử dụng'].forEach(k => reg.push({ kw: k, path: 'dang-ky-xe-may/', cg: 'CG-reg-info-' + slugify(k), official: '1' }));
provinces.forEach(p => reg.push({ kw: 'đăng ký xe máy ' + p, prov: p, path: 'dang-ky-xe-may/', cg: 'CG-reg-loc-' + slugify(p), official: '1', intent: 'local' }));
pool = [];
provinces.forEach(p => ['hồ sơ','lệ phí','nơi thực hiện','thủ tục online','sang tên','thuế trước bạ','thời hạn','nơi nhận kết quả','mất đăng ký','đổi biển số'].forEach(c => pool.push({ kw: c + ' đăng ký xe máy ' + p.toLowerCase(), prov: p, path: 'dang-ky-xe-may/', cg: 'CG-reg-' + slugify(c) + '-' + slugify(p), official: '1' })));
localities.forEach(l => ['hồ sơ','lệ phí','nơi đăng ký'].forEach(c => pool.push({ kw: c + ' đăng ký xe máy ' + l.name, prov: l.province, loc: l.name, path: 'dang-ky-xe-may/', cg: 'CG-reg-' + slugify(c) + '-' + slugify(l.name), official: '1' })));
provinces.forEach(p => ['tra cứu biển số','đổi giấy đăng ký 5 năm','nơi cấp đăng ký','thủ tục tặng cho xe'].forEach(c => pool.push({ kw: c + ' xe máy tại ' + p, prov: p, path: 'dang-ky-xe-may/', cg: 'CG-reg-b-' + slugify(c) + '-' + slugify(p), official: '1' })));
ri = 0; while (ri < pool.length) reg.push(pool[ri++]);
for (const r of reg) { if ((byCluster.REGISTRATION = (byCluster.REGISTRATION || 0)) >= 600) break; if (add({ ...r, cluster: 'REGISTRATION', parent_topic: 'ĐĂNG KÝ XE MÁY', _path: r.path, official: '1' })) byCluster.REGISTRATION++; }

// ---------- ELECTRIC (1200) ----------
const elecBrands = ['VinFast','Yadea','Dat Bike','Honda','Piaggio','SYM','Israel-basedroller? no'];
const ebrands = [['VinFast','Felis S'],['VinFast','Klara S'],['VinFast','Theon'],['Yadea','like none'],];
const el = [];
['xe máy điện có nên mua không','xe máy điện giá bao nhiêu','xe máy điện nào tốt nhất','xe máy điện chạy được bao xa','xe máy điện sạc bao lâu','xe máy điện có cần bằng lái không','xe máy điện có cần đăng ký không','pin xe máy điện có bền không','trạm sạc xe máy điện ở đâu','chi phí sử dụng xe máy điện','xe máy điện so với xe xăng','mua xe máy điện trả góp','xe máy điện cho người đi làm','xe máy điện cho học sinh sinh viên','bảo hành xe máy điện','xe máy điện bị ngấm nước','xe máy điện hỏng pin sửa ở đâu','thay pin xe máy điện giá bao nhiêu','xe máy điện phanh như thế nào','ưu đãi lệ phí trước bạ xe máy điện'].forEach(k => el.push({ kw: k, path: 'xe-may-dien/', cg: 'CG-el-info-' + slugify(k) }));
const emodels = [['VinFast','Felis S'],['VinFast','Klara S'],['VinFast','Theon S'],['VinFast','Vento S'],['Yadea','S-Lectric'],['Yadea','G5'],['Dat Bike','Weaver'],['Dat Bike','Weaver S'],['Honda','CUV e:'],['Piaggio','Liberty Electric'],['SYM','EV'],['Honda','ICON e:']];
emodels.forEach(([b, m]) => { el.push({ kw: 'xe ' + m + ' có đáng mua không', brand: b, model: m, path: 'xe-may-dien/', cg: 'CG-el-model-' + slugify(m) });
  el.push({ kw: 'giá xe ' + m, brand: b, model: m, path: 'xe-may-dien/', cg: 'CG-el-price-' + slugify(m) });
  el.push({ kw: m + ' chạy được bao xa', brand: b, model: m, path: 'xe-may-dien/', cg: 'CG-el-range-' + slugify(m) });
  el.push({ kw: m + ' so với xe xăng', brand: b, model: m, path: 'xe-may-dien/', cg: 'CG-el-cmp-' + slugify(m) }); });
['pin lithium','pin chì','sạc nhanh','sạc tại nhà','pin tháo rời','động cơ Between hub'].forEach(t => el.push({ kw: t + ' xe máy điện khác nhau thế nào', path: 'xe-may-dien/', cg: 'CG-el-tech-' + slugify(t) }));
pool = [];
const elAspects = ['giá bán','khuyến mãi','trạm sạc','bảo hành','lắp đặt pin','sửa chữa','kiểm định','chạy thử'];
provinces.forEach(p => elAspects.forEach(a => pool.push({ kw: a + ' xe máy điện ' + p.toLowerCase(), prov: p, path: 'xe-may-dien/', cg: 'CG-el-pa-' + slugify(p) + '-' + slugify(a) })));
emodels.forEach(([b, m]) => ['đánh giá','điểm mạnh điểm yếu','nên mua năm nào','sạc pin','thay pin','lỗi thường gặp','thời gian sạc'].forEach(a => pool.push({ kw: a + ' xe ' + m, brand: b, model: m, path: 'xe-may-dien/', cg: 'CG-el-ma-' + slugify(m) + '-' + slugify(a) })));
useCases.forEach(u => models.slice(0, 6).forEach(([b, m]) => pool.push({ kw: 'xe máy điện ' + u + ' có hợp lý không', use: u, path: 'xe-may-dien/', cg: 'CG-el-use-' + slugify(u) })));
emodels.forEach(([b, m]) => provinces.forEach(p => pool.push({ kw: 'giá xe ' + m + ' tại ' + p.toLowerCase(), brand: b, model: m, prov: p, path: 'xe-may-dien/', cg: 'CG-el-gp-' + slugify(m) + '-' + slugify(p) })));
for (let i = 0; i < emodels.length; i++) for (let j = i + 1; j < emodels.length; j++) pool.push({ kw: 'so sánh xe ' + emodels[i][1] + ' và ' + emodels[j][1], brand: emodels[i][0], model: emodels[i][1], path: 'xe-may-dien/', cg: 'CG-el-cmp2-' + slugify(emodels[i][1]) + '-' + slugify(emodels[j][1]) });
['pin tháo rời','công nghệ pin LFP','trạm sạc nhanh','sạc ở nhà trọ','ộpin theo km','thuê xe máy điện'].forEach(a => pool.push({ kw: a + ' — kinh nghiệm thực tế', path: 'xe-may-dien/', cg: 'CG-el-kt-' + slugify(a) }));
emodels.forEach(([b, m]) => ['màu sắc','phụ tùng thay thế','độ pin','đồ trang trí hợp lệ','mua trả góp lãi suất','bảo hiểm'].forEach(a => pool.push({ kw: a + ' xe ' + m + ' cần biết gì', brand: b, model: m, path: 'xe-may-dien/', cg: 'CG-el-as2-' + slugify(m) + '-' + slugify(a) })));
provinces.forEach(p => emodels.slice(0, 8).forEach(([b, m]) => pool.push({ kw: 'xe ' + m + ' có bán tại ' + p.toLowerCase() + ' không', brand: b, model: m, prov: p, path: 'xe-may-dien/', cg: 'CG-el-sale-' + slugify(m) + '-' + slugify(p) })));
provinces.forEach(p => ['lệ phí trước bạ xe máy điện','biển số xe máy điện','bằng lái cho xe máy điện','trạm sạc công cộng','chính sách hỗ trợ xe điện'].forEach(a => pool.push({ kw: a + ' tại ' + p, prov: p, path: 'xe-may-dien/', cg: 'CG-el-pol-' + slugify(p) + '-' + slugify(a) })));
ri = 0; while (el.length < 1200 && ri < pool.length) el.push(pool[ri++]);
ri = 0; while (ri < pool.length) el.push(pool[ri++]);
for (const r of el) { if ((byCluster.ELECTRIC = (byCluster.ELECTRIC || 0)) >= 1200) break; if (add({ ...r, cluster: 'ELECTRIC', parent_topic: 'XE MÁY ĐIỆN', _path: r.path })) byCluster.ELECTRIC++; }

// ---------- PARTS (600) ----------
const parts = ['lốp xe máy','ắc quy xe máy','pin xe máy điện','má phanh','dầu phanh','dầu máy','lọc gió','bugi','nhông','xích','đĩa xe máy','vành xe','lốp không săm','đèn xe máy','gương xe máy','dây ga','dây phanh','ECU xe máy','cốp xe máy','yên xe máy'];
const pt = [];
parts.forEach(x => { pt.push({ kw: x + ' các loại và cách chọn', part: x, path: 'phu-tung/', cg: 'CG-parts-pt-info-' + slugify(x) });
  pt.push({ kw: x + ' giá bao nhiêu', part: x, path: 'phu-tung/', cg: 'CG-parts-pt-price-' + slugify(x) });
  pt.push({ kw: 'thay ' + x + ' sau bao lâu', part: x, path: 'phu-tung/', cg: 'CG-parts-pt-int-' + slugify(x) });
  pt.push({ kw: x + ' chính hãng và hàng thay thế khác nhau thế nào', part: x, path: 'phu-tung/', cg: 'CG-parts-pt-oem-' + slugify(x) }); });
models.slice(0, 8).forEach(([b, m]) => parts.slice(0, 5).forEach(x => pt.push({ kw: x + ' ' + m, part: x, brand: b, model: m, path: 'phu-tung/', cg: 'CG-parts-pm-' + slugify(m) + '-' + slugify(x) })));
pool = [];
types.forEach(t => parts.forEach(x => pool.push({ kw: x + ' cho ' + t, part: x, vtype: t, path: 'phu-tung/', cg: 'CG-parts-t-' + slugify(t) + '-' + slugify(x) })));
models.forEach(([b, m]) => parts.forEach(x => pool.push({ kw: x + ' ' + m + ' giá tốt ở đâu', part: x, brand: b, model: m, path: 'phu-tung/', cg: 'CG-parts-mp-' + slugify(m) + '-' + slugify(x) })));
parts.forEach(x => models.slice(0, 5).forEach(([b, m]) => pool.push({ kw: 'cách chọn ' + x + ' cho ' + m, part: x, brand: b, model: m, path: 'phu-tung/', cg: 'CG-parts-cho-' + slugify(x) + '-' + slugify(m) })));
const problems = ['mòn nhanh','rơi rớt tiếng kêu','không vào nước','chảy dầu','nhảy đèn báo lỗi','giảm hiệu suất','không khớp xe','bảo hành bị từ chối'];
parts.forEach(x => problems.forEach(pr => pool.push({ kw: x + ' bị ' + pr + ' nguyên nhân và cách xử lý', part: x, path: 'phu-tung/', cg: 'CG-parts-pr-' + slugify(x) + '-' + slugify(pr) })));
parts.forEach(x => provinces.slice(0, 10).forEach(p => pool.push({ kw: 'thay ' + x + ' ở ' + p + ' giá bao nhiêu', part: x, prov: p, path: 'phu-tung/', cg: 'CG-parts-geo-' + slugify(x) + '-' + slugify(p) })));
ri = 0; while (pt.length < 600 && ri < pool.length) pt.push(pool[ri++]);
ri = 0; while (ri < pool.length) pt.push(pool[ri++]);
for (const r of pt) { if ((byCluster.PARTS = (byCluster.PARTS || 0)) >= 600) break; if (add({ ...r, cluster: 'PARTS', parent_topic: 'PHỤ TÙNG XE MÁY', _path: r.path })) byCluster.PARTS++; }

// ---------- emit ----------
const byC = {}; rows.forEach(r => byC[r.cluster] = (byC[r.cluster] || 0) + 1);
console.log('COUNTS', JSON.stringify(byC));
if (rows.length !== 10000) { console.error('FATAL: expected 10000, got ' + rows.length); process.exit(1); }
const csv = [FIELDS.join(',')].concat(rows.map(r => FIELDS.map(f => { let v = String(r[f] ?? ''); if (/[",\n]/.test(v)) v = '"' + v.replace(/"/g, '""') + '"'; return v; }).join(','))).join('\n');
fs.writeFileSync(path.join(ROOT, 'data', 'content-matrix.csv'), csv);
console.log('MATRIX WRITTEN: 10000 rows.');
console.log('pilot rows:');
['thuê xe máy Hà Nội','thuê Honda Vision Hà Nội','thuê xe máy gần sân bay quốc tế Nội Bài','Vision hay Air Blade nên thuê dòng nào','cứu hộ xe máy Thủ Đức','bảo dưỡng xe máy định kỳ','thi bằng lái xe máy A1','đăng ký xe máy online','xe máy điện có nên mua không','lốp xe máy các loại và cách chọn'].forEach(k => { const r = rows.find(x => x.primary_keyword === k); console.log('  ' + (r ? r.article_id + ' ' + k : 'MISSING ' + k)); });
