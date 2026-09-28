#!/usr/bin/env python3
import json

cities = ["Hà Nội","Hải Phòng","Huế","Đà Nẵng","TP.HCM","Cần Thơ"]
provs = ["Lai Châu","Điện Biên","Sơn La","Lạng Sơn","Cao Bằng","Tuyên Quang","Lào Cai","Thái Nguyên",
"Phú Thọ","Bắc Ninh","Hưng Yên","Ninh Bình","Quảng Ninh","Thanh Hóa","Nghệ An","Hà Tĩnh",
"Quảng Bình","Quảng Trị","Quảng Ngãi","Gia Lai","Khánh Hòa","Lâm Đồng","Đồng Nai","Tây Ninh",
"Vĩnh Long","Đồng Tháp","An Giang","Cà Mau"]
assert len(cities)+len(provs)==34

provinces=[{"geo_id":"VN-%03d"%(i+1),"name":n,"normalized_name":n.lower().replace(" ","-"),
"type":"thành phố trực thuộc trung ương" if n in cities else "tỉnh","current_status":"CURRENT",
"legacy_name":None,"province":n,"latitude":None,"longitude":None,
"verified_source":"Nghị quyết của Quốc hội về sắp xếp đơn vị hành chính 2025 (hiệu lực 01/07/2025)",
"last_verified":"2026-09-28"} for i,n in enumerate(cities+provs)]
json.dump({"provinces":provinces},open("data/geography/provinces.json","w"),ensure_ascii=False,indent=1)

m = {
"Hà Giang":"Tuyên Quang","Tuyên Quang":"Tuyên Quang","Cao Bằng":"Cao Bằng","Bắc Kạn":"Thái Nguyên",
"Thái Nguyên":"Thái Nguyên","Lào Cai":"Lào Cai","Yên Bái":"Lào Cai","Điện Biên":"Điện Biên",
"Lai Châu":"Lai Châu","Sơn La":"Sơn La","Lạng Sơn":"Lạng Sơn","Vĩnh Phúc":"Phú Thọ","Phú Thọ":"Phú Thọ",
"Hà Nội":"Hà Nội","Hòa Bình":"Hà Nội","Quảng Ninh":"Quảng Ninh","Bắc Giang":"Bắc Ninh","Bắc Ninh":"Bắc Ninh",
"Hải Phòng":"Hải Phòng","Hải Dương":"Hải Phòng","Hưng Yên":"Hưng Yên","Thái Bình":"Hưng Yên",
"Hà Nam":"Ninh Bình","Nam Định":"Ninh Bình","Ninh Bình":"Ninh Bình","Thanh Hóa":"Thanh Hóa",
"Nghệ An":"Nghệ An","Hà Tĩnh":"Hà Tĩnh","Quảng Bình":"Quảng Bình","Quảng Trị":"Quảng Trị",
"Thừa Thiên Huế":"Huế","Đà Nẵng":"Đà Nẵng","Quảng Nam":"Đà Nẵng","Kon Tum":"Quảng Ngãi",
"Quảng Ngãi":"Quảng Ngãi","Bình Định":"Gia Lai","Gia Lai":"Gia Lai","Phú Yên":"Đắk Lắk","Đắk Lắk":"Đắk Lắk",
"Đắk Nông":"Lâm Đồng","Lâm Đồng":"Lâm Đồng","Ninh Thuận":"Khánh Hòa","Khánh Hòa":"Khánh Hòa",
"Bình Thuận":"Lâm Đồng","TP.HCM":"TP.HCM","Bà Rịa-Vũng Tàu":"TP.HCM","Bình Dương":"TP.HCM",
"Bình Phước":"Đồng Nai","Đồng Nai":"Đồng Nai","Tây Ninh":"Tây Ninh","Long An":"Tây Ninh",
"Tiền Giang":"Đồng Tháp","Bến Tre":"Vĩnh Long","Trà Vinh":"Vĩnh Long","Vĩnh Long":"Vĩnh Long",
"Đồng Tháp":"Đồng Tháp","An Giang":"An Giang","Kiên Giang":"An Giang","Cần Thơ":"Cần Thơ",
"Hậu Giang":"Cần Thơ","Sóc Trăng":"Cần Thơ","Bạc Liêu":"Cà Mau","Cà Mau":"Cà Mau"}
assert len(m)==63, len(m)
leg=[]
for i,(old,new) in enumerate(m.items()):
    leg.append({"geo_id":"LG-%03d"%(i+1),"legacy_name":old,"current_province":new,
    "status":"UNCHANGED" if old==new else ("SPLIT" if old=="Hòa Bình" else "MERGED_INTO"),
    "verified_source":"Nghị quyết sắp xếp đơn vị hành chính 2025","last_verified":"2026-09-28"})
json.dump({"legacy_names":leg},open("data/geography/legacy-names.json","w"),ensure_ascii=False,indent=1)

locs = [("Long Biên","quận cũ","Hà Nội","LEGACY_SEARCH"),("Hoàn Kiếm","quận cũ","Hà Nội","LEGACY_SEARCH"),
("Ba Đình","quận cũ","Hà Nội","LEGACY_SEARCH"),("Đống Đa","quận cũ","Hà Nội","LEGACY_SEARCH"),
("Cầu Giấy","quận cũ","Hà Nội","LEGACY_SEARCH"),("Thanh Xuân","quận cũ","Hà Nội","LEGACY_SEARCH"),
("Hà Đông","quận cũ","Hà Nội","LEGACY_SEARCH"),("Tây Hồ","quận cũ","Hà Nội","LEGACY_SEARCH"),
("Hai Bà Trưng","quận cũ","Hà Nội","LEGACY_SEARCH"),("Đông Anh","huyện cũ","Hà Nội","LEGACY_SEARCH"),
("Gia Lâm","huyện cũ","Hà Nội","LEGACY_SEARCH"),("Sóc Sơn","huyện cũ","Hà Nội","LEGACY_SEARCH"),
("Mê Linh","huyện cũ","Hà Nội","LEGACY_SEARCH"),("Thường Tín","huyện cũ","Hà Nội","LEGACY_SEARCH"),
("Thanh Trì","huyện cũ","Hà Nội","LEGACY_SEARCH"),("Thanh Oai","huyện cũ","Hà Nội","LEGACY_SEARCH"),
("Sơn Tây","thị xã cũ","Hà Nội","LEGACY_SEARCH"),
("Quận 1","quận cũ","TP.HCM","LEGACY_SEARCH"),("Quận 3","quận cũ","TP.HCM","LEGACY_SEARCH"),
("Quận 5","quận cũ","TP.HCM","LEGACY_SEARCH"),("Quận 7","quận cũ","TP.HCM","LEGACY_SEARCH"),
("Quận 10","quận cũ","TP.HCM","LEGACY_SEARCH"),("Tân Bình","quận cũ","TP.HCM","LEGACY_SEARCH"),
("Bình Thạnh","quận cũ","TP.HCM","LEGACY_SEARCH"),("Gò Vấp","quận cũ","TP.HCM","LEGACY_SEARCH"),
("Thủ Đức","thành phố cũ","TP.HCM","LEGACY_SEARCH"),("Bình Chánh","huyện cũ","TP.HCM","LEGACY_SEARCH"),
("Củ Chi","huyện cũ","TP.HCM","LEGACY_SEARCH"),("Nhà Bè","huyện cũ","TP.HCM","LEGACY_SEARCH"),
("Hải Châu","quận cũ","Đà Nẵng","LEGACY_SEARCH"),("Sơn Trà","quận cũ","Đà Nẵng","LEGACY_SEARCH"),
("Ngũ Hành Sơn","quận cũ","Đà Nẵng","LEGACY_SEARCH"),("Cẩm Lệ","quận cũ","Đà Nẵng","LEGACY_SEARCH"),
("Phú Hòa","quận cũ","Huế","LEGACY_SEARCH"),("Hương Thủy","thị xã cũ","Huế","LEGACY_SEARCH"),
("Lê Chân","quận cũ","Hải Phòng","LEGACY_SEARCH"),("Ngô Quyền","quận cũ","Hải Phòng","LEGACY_SEARCH"),
("Đồ Sơn","quận cũ","Hải Phòng","LEGACY_SEARCH"),
("Nghi Sơn","thị xã","Thanh Hóa","LEGACY_SEARCH"),("Kỳ Anh","thị xã","Hà Tĩnh","LEGACY_SEARCH"),
("Nha Trang","thành phố","Khánh Hòa","CURRENT"),("Phan Rang","thành phố","Khánh Hòa","LEGACY_SEARCH"),
("Đà Lạt","thành phố","Lâm Đồng","CURRENT"),("Tam Kỳ","thành phố cũ","Quảng Ngãi","LEGACY_SEARCH"),
("Vinh","thành phố","Nghệ An","CURRENT"),("Buôn Ma Thuột","thành phố","Đắk Lắk","CURRENT"),
("Pleiku","thành phố","Gia Lai","CURRENT"),("Quy Nhơn","thành phố cũ","Gia Lai","LEGACY_SEARCH"),
("Tuy Hòa","thành phố cũ","Đắk Lắk","LEGACY_SEARCH"),
("Biên Hòa","thành phố cũ","Đồng Nai","LEGACY_SEARCH"),("Thủ Dầu Một","thành phố cũ","TP.HCM","LEGACY_SEARCH"),
("Dĩ An","thành phố cũ","TP.HCM","LEGACY_SEARCH"),("Vũng Tàu","thành phố cũ","TP.HCM","LEGACY_SEARCH"),
("Rạch Giá","thành phố","An Giang","CURRENT"),("Long Xuyên","thành phố","An Giang","CURRENT"),
("Cà Mau","thành phố","Cà Mau","CURRENT"),("Cao Lãnh","thành phố","Đồng Tháp","CURRENT"),
("Mỹ Tho","thành phố cũ","Đồng Tháp","LEGACY_SEARCH"),("Bến Tre","thành phố cũ","Vĩnh Long","LEGACY_SEARCH"),
("Trà Vinh","thành phố cũ","Vĩnh Long","LEGACY_SEARCH"),("Sóc Trăng","thành phố cũ","Cần Thơ","LEGACY_SEARCH"),
("Hà Tiên","thành phố cũ","An Giang","LEGACY_SEARCH"),
("Hà Giang (thị xã cũ)","thị xã cũ","Tuyên Quang","LEGACY_SEARCH"),("Yên Bái (thành phố cũ)","thành phố cũ","Lào Cai","LEGACY_SEARCH"),
("Việt Trì","thành phố","Phú Thọ","CURRENT"),("Bắc Ninh (thành phố)","thành phố","Bắc Ninh","CURRENT"),
("Hạ Long","thành phố","Quảng Ninh","CURRENT"),("Cẩm Phả","thành phố","Quảng Ninh","CURRENT"),
("Thái Nguyên (thành phố)","thành phố","Thái Nguyên","CURRENT"),("Hải Dương (thành phố cũ)","thành phố cũ","Hải Phòng","LEGACY_SEARCH"),
("Vị Thanh","thành phố cũ","Cần Thơ","LEGACY_SEARCH"),("Bạc Liêu (thành phố cũ)","thành phố cũ","Cà Mau","LEGACY_SEARCH"),
("Đồng Hới","thành phố","Quảng Bình","CURRENT"),("Đông Hà","thành phố","Quảng Trị","CURRENT"),
("Điện Biên Phủ","thành phố","Điện Biên","CURRENT"),("Sơn La (thành phố)","thành phố","Sơn La","CURRENT"),
("Lạng Sơn (thành phố)","thành phố","Lạng Sơn","CURRENT"),("Cao Bằng (thị xã)","thị xã","Cao Bằng","CURRENT"),
("Tuyên Quang (thành phố)","thành phố","Tuyên Quang","CURRENT"),("Lào Cai (thành phố)","thành phố","Lào Cai","CURRENT"),
("Uông Bí","thành phố","Quảng Ninh","CURRENT"),("Tân Uyên","thành phố cũ","TP.HCM","LEGACY_SEARCH"),
("Đại Từ","huyện cũ","Thái Nguyên","LEGACY_SEARCH"),("Phổ Yên","thành phố cũ","Thái Nguyên","LEGACY_SEARCH"),
("Ninh Hòa","thành phố cũ","Khánh Hòa","LEGACY_SEARCH"),("Tân Phú","quận cũ","TP.HCM","LEGACY_SEARCH"),
("Thuận Hóa","quận cũ","Huế","LEGACY_SEARCH")]
l=[{"geo_id":"LC-%03d"%(i+1),"name":n,"normalized_name":n.lower().replace(" ","-"),"type":t,
"parent_geo_id":None,"current_status":st,"legacy_name":n if st=="LEGACY_SEARCH" else None,
"province":p,"latitude":None,"longitude":None,
"verified_source":"Sắp xếp đơn vị hành chính 2025 — tên cũ vẫn được tìm kiếm phổ biến","last_verified":"2026-09-28"} for i,(n,t,p,st) in enumerate(locs)]
json.dump({"localities":l},open("data/geography/localities.json","w"),ensure_ascii=False,indent=1)

hubs=[("Sân bay quốc tế Nội Bài","airport","Hà Nội",21.221,105.509),("Sân bay quốc tế Tân Sơn Nhất","airport","TP.HCM",10.819,106.655),
("Sân bay quốc tế Đà Nẵng","airport","Đà Nẵng",15.822,108.269),("Sân bay quốc tế Cát Bi","airport","Hải Phòng",20.819,106.725),
("Sân bay quốc tế Cam Ranh","airport","Khánh Hòa",12.003,109.220),("Sân bay quốc tế Phú Quốc","airport","An Giang",10.170,103.993),
("Ga Hà Nội","railway","Hà Nội",21.028,105.852),("Ga Sài Gòn","railway","TP.HCM",10.780,106.698),
("Ga Đà Nẵng","railway","Đà Nẵng",16.068,108.218),("Ga Huế","railway","Huế",16.464,107.594),
("Bến xe Mỹ Đình","bus","Hà Nội",21.028,105.772),("Bến xe Giáp Bát","bus","Hà Nội",20.961,105.870),
("Bến xe Nước Ngầm","bus","Hà Nội",20.938,105.806),("Bến xe Miền Đông (cũ)","bus","TP.HCM",10.790,106.698),
("Bến xe Miền Tây","bus","TP.HCM",10.777,106.575),("Bến xe An Sương","bus","TP.HCM",10.844,106.576),
("Bến xe Trung tâm Đà Nẵng","bus","Đà Nẵng",16.065,108.216),("Bến xe nước Rồng","bus","An Giang",10.359,104.639),
("Bến xe Cà Mau","bus","Cà Mau",9.177,105.151),("Cảng Hòn Gai / Bến tàu Hạ Long","boat","Quảng Ninh",20.972,107.020)]
h=[{"geo_id":"HB-%03d"%(i+1),"name":n,"normalized_name":n.lower().replace(" ","-").replace("–","-"),"type":t,
"parent_geo_id":None,"current_status":"CURRENT","legacy_name":None,"province":p,"latitude":la,"longitude":lo,
"verified_source":"Thông tin giao thông công khai — tọa độ tham khảo","last_verified":"2026-09-28"} for i,(n,t,p,la,lo) in enumerate(hubs)]
json.dump({"transport_hubs":h},open("data/geography/transport-hubs.json","w"),ensure_ascii=False,indent=1)

tpois=[("Phố cổ Hà Nội","Hà Nội"),("Hồ Hoàn Kiếm","Hà Nội"),("Hồ Tây","Hà Nội"),
("Tam Đảo","Phú Thọ"),("Ba Vì","Hà Nội"),("Chùa Hương","Hà Nội"),
("Cố đô Hoa Lư","Ninh Bình"),("Tràng An","Ninh Bình"),("Tam Cốc – Bích Động","Ninh Bình"),
("Vịnh Hạ Long","Quảng Ninh"),("Yên Tử","Quảng Ninh"),("Sa Pa","Lào Cai"),
("Cố đô Huế","Huế"),("Bà Nà Hills","Đà Nẵng"),("Cù Lao Chàm","Quảng Ngãi"),
("Biển Nha Trang","Khánh Hòa"),("Đà Lạt","Lâm Đồng"),("Thác Datanla","Lâm Đồng"),
("Đảo Phú Quốc","An Giang"),("Mũi Né","Lâm Đồng"),("Cần Giờ","TP.HCM"),
("Côn Đảo","TP.HCM"),("Đèo Hải Vân","Huế / Đà Nẵng"),("Chùa Tây Thiên","Phú Thọ"),("Đền Hùng","Phú Thọ")]
t=[{"geo_id":"TP-%03d"%(i+1),"name":n,"normalized_name":n.lower().replace(" ","-").replace("–","-"),
"type":"tourist_attraction","parent_geo_id":None,"current_status":"CURRENT","legacy_name":None,
"province":p,"latitude":None,"longitude":None,
"verified_source":"Điểm du lịch được công nhận — tên gọi theo thông tin du lịch chính thống","last_verified":"2026-09-28"} for i,(n,p) in enumerate(tpois)]
json.dump({"tourism_poi":t},open("data/geography/tourism-poi.json","w"),ensure_ascii=False,indent=1)

pois=[("Bệnh viện Chợ Rẫy","hospital","TP.HCM"),("Bệnh viện Bạch Mai","hospital","Hà Nội"),
("Bệnh viện Việt Đức","hospital","Hà Nội"),("Bệnh viện K","hospital","Hà Nội"),
("Bệnh viện Nhi Trung ương","hospital","Hà Nội"),("Bệnh viện 103","hospital","Hà Nội"),
("Bệnh viện Đà Nẵng","hospital","Đà Nẵng"),("Bệnh viện Trung ương Huế","hospital","Huế"),
("Bệnh viện Cần Thơ","hospital","Cần Thơ"),
("Học viện Công nghệ Bưu chính Viễn thông","university","Hà Nội"),
("Đại học Bách khoa Hà Nội","university","Hà Nội"),
("Đại học Quốc gia Hà Nội (khu vực Hoà Lạc)","university","Hà Nội"),
("Đại học Kinh tế Quốc dân","university","Hà Nội"),
("Đại học Ngoại thương","university","Hà Nội"),
("Đại học Quốc gia TP.HCM","university","TP.HCM"),
("Đại học Bách khoa TP.HCM","university","TP.HCM"),
("Đại học Đà Nẵng","university","Đà Nẵng"),
("Khu công nghiệp Bắc Thăng Long","industrial","Hà Nội"),
("Khu công nghiệp VSIP","industrial","Bắc Ninh")]
ii=[{"geo_id":"IP-%03d"%(i+1),"name":n,"normalized_name":n.lower().replace(" ","-").replace("–","-"),
"type":tp,"parent_geo_id":None,"current_status":"CURRENT","legacy_name":None,"province":p,
"latitude":None,"longitude":None,"verified_source":"Thông tin công khai","last_verified":"2026-09-28"} for i,(n,tp,p) in enumerate(pois)]
json.dump({"important_poi":ii},open("data/geography/important-poi.json","w"),ensure_ascii=False,indent=1)
print("OK geo:",len(provinces),len(leg),len(l),len(h),len(t),len(ii))
