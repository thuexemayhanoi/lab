# GEO-LOCAL SEO MODEL

## Geographic database

`data/geography/` — verified geography ONLY. Files:

- `provinces.json` — 34 current top-level units (6 centrally governed cities
  + 28 provinces after the 2025 merger).
- `localities.json` — current local administrative units.
- `legacy-names.json` — 63 commonly-searched former province names mapped to
  their current unit (e.g. Hà Giang→Tuyên Quang, Tiền Giang→Đồng Tháp,
  Kon Tum→Quảng Ngãi; Hòa Bình split between Hà Nội and Phú Thọ — the 63-entry
  list therefore contains Hòa Bình twice, legitimately).
- `transport-hubs.json` — airports, railway and bus stations, ferry terminals.
- `tourism-poi.json` — tourist attractions, old quarters, phượt destinations.
- `important-poi.json` — hospitals, universities, industrial areas, landmarks.

Entity fields: geo_id, name, normalized_name, type, parent_geo_id,
current_status, legacy_name, province, latitude (optional), longitude
(optional), verified_source, last_verified.

Never invent places. If a POI cannot be verified, it does not exist.

## Location-intent model

Target pattern: SERVICE + LOCATION.

Modifiers may be: province, city, district, former district, ward, town,
street, tourist place, station, airport, hospital, bus station, landmark.

Examples: cứu hộ xe máy Thủ Đức · sửa xe Vision Long Biên · thi bằng lái xe máy
Hải Phòng · thuê xe máy phố cổ Hà Nội.

## Geo hubs

`/lab/dia-phuong/<slug>/` hubs are generated only for provinces with PUBLISHED
content (never empty thin hubs). TP.HCM hub slug is `tp-hcm`.

## Anti-doorway rule

Geographic pages must differ in substance, not only in place name: real POIs,
routes, transport access, local procedures/authorities, local questions.
See `docs/ARTICLE-RULES.md`.
