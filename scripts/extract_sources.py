#!/usr/bin/env python3
import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import urlparse

NS = {
    "main": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "rel": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "pkg_rel": "http://schemas.openxmlformats.org/package/2006/relationships",
}

REPORT_MODULES = {
    "新规/修订/废止/生效提醒",
    "广告合规及处罚案例",
    "美妆行业动态",
    "知识产权动态",
    "进出口/跨境电商动态",
}

MODULE_RULES = [
    ("广告", "广告合规及处罚案例"),
    ("虚假宣传", "广告合规及处罚案例"),
    ("处罚", "广告合规及处罚案例"),
    ("市监", "广告合规及处罚案例"),
    ("市场监督", "广告合规及处罚案例"),
    ("知识产权", "知识产权动态"),
    ("商标", "知识产权动态"),
    ("专利", "知识产权动态"),
    ("海关", "进出口/跨境电商动态"),
    ("进出口", "进出口/跨境电商动态"),
    ("跨境", "进出口/跨境电商动态"),
    ("进口", "进出口/跨境电商动态"),
    ("药品监督", "新规/修订/废止/生效提醒"),
    ("药监", "新规/修订/废止/生效提醒"),
    ("NMPA", "新规/修订/废止/生效提醒"),
    ("法规", "新规/修订/废止/生效提醒"),
    ("监管", "新规/修订/废止/生效提醒"),
    ("检察", "广告合规及处罚案例"),
    ("法院", "广告合规及处罚案例"),
    ("化妆品", "美妆行业动态"),
    ("美妆", "美妆行业动态"),
]

CATEGORY_MODULE_MAP = {
    "新规及案例动态": "新规/修订/废止/生效提醒",
    "新规/修订/废止": "新规/修订/废止/生效提醒",
    "法规": "新规/修订/废止/生效提醒",
    "案例": "广告合规及处罚案例",
    "美妆动态": "美妆行业动态",
    "进出口动态": "进出口/跨境电商动态",
}

REGION_RULES = [
    ("中国", "亚洲", "中国"),
    ("国家", "亚洲", "中国"),
    ("上海", "亚洲", "中国"),
    ("杭州", "亚洲", "中国"),
    ("北京", "亚洲", "中国"),
    ("广州", "亚洲", "中国"),
    ("浙江", "亚洲", "中国"),
    ("广东", "亚洲", "中国"),
    ("海关", "亚洲", "中国"),
    ("FDA", "北美", "美国"),
    ("欧盟", "欧洲", "欧盟"),
    ("EU", "欧洲", "欧盟"),
    ("ECHA", "欧洲", "欧盟"),
    ("SCCS", "欧洲", "欧盟"),
    ("BPOM", "亚洲", "印尼"),
    ("印尼", "亚洲", "印尼"),
    ("泰国", "亚洲", "泰国"),
    ("越南", "亚洲", "越南"),
    ("菲律宾", "亚洲", "菲律宾"),
    ("马来西亚", "亚洲", "马来西亚"),
    ("AICIS", "大洋洲", "澳大利亚"),
    ("澳大利亚", "大洋洲", "澳大利亚"),
    ("新西兰", "大洋洲", "新西兰"),
    ("墨西哥", "北美", "墨西哥"),
    ("意大利", "欧洲", "意大利"),
]

TOPIC_RULES = [
    ("化妆品", "化妆品"),
    ("美妆", "美妆"),
    ("药监", "药监"),
    ("药品监督", "药监"),
    ("广告", "广告合规"),
    ("市场监督", "行政处罚"),
    ("市监", "行政处罚"),
    ("海关", "进出口"),
    ("进出口", "进出口"),
    ("跨境", "跨境电商"),
    ("知识产权", "知识产权"),
    ("法院", "判决案例"),
    ("检察", "执法案例"),
    ("FDA", "海外监管"),
    ("BPOM", "海外监管"),
    ("AICIS", "海外监管"),
    ("ECHA", "海外监管"),
    ("SCCS", "海外监管"),
]

OFFICIAL_KEYWORDS = [
    "gov", "政府", "国家", "药监", "药品监督", "市场监督", "海关", "法院", "检察",
    "FDA", "BPOM", "AICIS", "ECHA", "SCCS", "欧盟", "commission", "europa", "official",
]

URL_SOURCE_TYPES = [
    ("微信公众号", "wechat_public_account"),
    ("公众号", "wechat_public_account"),
    ("微信", "wechat_public_account"),
    ("mp.weixin.qq.com", "wechat_public_account"),
    ("weixin.qq.com", "wechat_public_account"),
    ("rss", "rss"),
    ("atom", "rss"),
    ("feed", "rss"),
]


def load_shared_strings(zf):
    if "xl/sharedStrings.xml" not in zf.namelist():
        return []
    root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
    strings = []
    for si in root.findall("main:si", NS):
        text_parts = []
        for node in si.iter():
            if node.tag.endswith("}t") and node.text:
                text_parts.append(node.text)
        strings.append("".join(text_parts))
    return strings


def first_sheet_path(zf):
    workbook = ET.fromstring(zf.read("xl/workbook.xml"))
    first_sheet = workbook.find("main:sheets/main:sheet", NS)
    if first_sheet is None:
        raise ValueError("workbook has no worksheet")
    rel_id = first_sheet.attrib.get(f"{{{NS['rel']}}}id")
    if not rel_id:
        return "xl/worksheets/sheet1.xml"

    rels = ET.fromstring(zf.read("xl/_rels/workbook.xml.rels"))
    for rel in rels.findall("pkg_rel:Relationship", NS):
        if rel.attrib.get("Id") == rel_id:
            target = rel.attrib["Target"]
            return f"xl/{target}" if not target.startswith("/") else target.lstrip("/")
    return "xl/worksheets/sheet1.xml"


def column_name(cell_ref):
    return re.sub(r"\d+", "", cell_ref or "")


def cell_value(cell, shared_strings):
    cell_type = cell.attrib.get("t")
    if cell_type == "inlineStr":
        return "".join(t.text or "" for t in cell.findall(".//main:t", NS)).strip()

    value = cell.find("main:v", NS)
    if value is None or value.text is None:
        return ""

    raw = value.text.strip()
    if cell_type == "s":
        try:
            return shared_strings[int(raw)].strip()
        except (ValueError, IndexError):
            return ""
    return raw


def read_first_sheet_rows(xlsx_path):
    with zipfile.ZipFile(xlsx_path) as zf:
        shared_strings = load_shared_strings(zf)
        sheet_root = ET.fromstring(zf.read(first_sheet_path(zf)))
        rows = []
        for row in sheet_root.findall(".//main:sheetData/main:row", NS):
            values = {}
            for cell in row.findall("main:c", NS):
                values[column_name(cell.attrib.get("r"))] = cell_value(cell, shared_strings)
            if any(values.values()):
                rows.append(values)
        return rows


def clean_url(url):
    text = str(url or "").strip()
    if not text:
        return ""
    if text.startswith("www."):
        return f"https://{text}"
    return text


def normalize_text(*parts):
    return " ".join(str(part or "") for part in parts).upper()


def normalize_module(module):
    text = str(module or "").strip()
    if not text:
        return ""
    if text in REPORT_MODULES:
        return text
    if text in CATEGORY_MODULE_MAP:
        return CATEGORY_MODULE_MAP[text]
    for keyword, mapped in MODULE_RULES:
        if keyword.upper() in text.upper():
            return mapped
    return ""


def classify_module(name, url, raw_category):
    category_module = normalize_module(raw_category)
    if category_module:
        return category_module
    text = normalize_text(name, url)
    for keyword, module in MODULE_RULES:
        if keyword.upper() in text:
            return module
    return "美妆行业动态"


def classify_region(name, url):
    text = normalize_text(name, url)
    parsed = urlparse(url)
    host = parsed.netloc.lower()
    if host.endswith(".cn"):
        return "亚洲", "中国"
    if ".gov.cn" in host:
        return "亚洲", "中国"
    if ".go.th" in host or "thai" in host:
        return "亚洲", "泰国"
    if ".gov.vn" in host or "vietnam" in host:
        return "亚洲", "越南"
    if ".gov.ph" in host or "philippines" in host:
        return "亚洲", "菲律宾"
    if ".gov.my" in host or "malaysia" in host:
        return "亚洲", "马来西亚"
    if ".gov.au" in host:
        return "大洋洲", "澳大利亚"
    for keyword, region, country in REGION_RULES:
        if keyword.upper() in text:
            return region, country
    return "全球", "未分类"


def classify_source_type(name, url):
    text = f"{name or ''} {url or ''}"
    lower = text.lower()
    for keyword, source_type in URL_SOURCE_TYPES:
        if keyword.lower() in lower:
            return source_type
    if str(url or "").startswith("http"):
        authority_type = classify_authority(name, url)
        return "official_site" if authority_type == "regulator" else "industry_site"
    return "manual_link" if str(url or "").strip() else "industry_site"


def classify_authority(name, url):
    text = normalize_text(name, url)
    return "regulator" if any(keyword.upper() in text for keyword in OFFICIAL_KEYWORDS) else "industry"


def classify_priority(authority_type, module, source_type):
    if authority_type == "regulator" or source_type == "official_site":
        return "high"
    if source_type == "wechat_public_account":
        return "low"
    if module in {"新规/修订/废止/生效提醒", "广告合规及处罚案例", "进出口/跨境电商动态"}:
        return "medium"
    return "low"


def classify_topics(name, url, module, country):
    text = normalize_text(name, url, module, country)
    topics = []
    for keyword, topic in TOPIC_RULES:
        if keyword.upper() in text and topic not in topics:
            topics.append(topic)
    if module != "uncategorized" and module not in topics:
        topics.append(module)
    if country not in {"", "未分类"} and country not in topics:
        topics.append(country)
    return topics or ["美妆法务"]


def slugify(value, index):
    host = urlparse(value).netloc.lower().replace("www.", "")
    base = host or f"source-{index}"
    slug = re.sub(r"[^a-z0-9]+", "-", base).strip("-")
    return f"src-{index:03d}-{slug or 'source'}"


def source_from_row(row, index):
    name = str(row.get("B", "")).strip()
    url = clean_url(row.get("C", ""))
    raw_category = row.get("D", "")
    module = classify_module(name, url, raw_category)
    region, country = classify_region(name, url)
    source_type = classify_source_type(name, url)
    authority_type = classify_authority(name, url)
    priority = classify_priority(authority_type, module, source_type)
    return {
        "id": slugify(url or name, index),
        "name": name,
        "url": url,
        "module": module,
        "region": region,
        "country": country,
        "source_type": source_type,
        "authority_type": authority_type,
        "priority": priority,
        "topics": classify_topics(name, url, module, country),
    }


def extract_sources(xlsx_path):
    rows = read_first_sheet_rows(xlsx_path)
    data_rows = []
    for row in rows:
        if str(row.get("A", "")).strip() == "序号":
            continue
        if str(row.get("B", "")).strip() and str(row.get("C", "")).strip():
            data_rows.append(row)
    return [source_from_row(row, index) for index, row in enumerate(data_rows, start=1)]


def main():
    if len(sys.argv) != 3:
        print("Usage: extract_sources.py INPUT.xlsx OUTPUT.json", file=sys.stderr)
        sys.exit(2)

    input_path = Path(sys.argv[1])
    output_path = Path(sys.argv[2])
    sources = extract_sources(input_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps({"sources": sources}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {len(sources)} sources to {output_path}")


if __name__ == "__main__":
    main()
