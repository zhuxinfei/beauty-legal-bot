import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const workbookPath = process.env.SOURCE_WORKBOOK || '/Users/zhuxinfei/Downloads/美妆行业新法律法规、违法案例公众号_网站收录 +2026.5.24.xlsx';

function loadWorkbookRows() {
  const script = `
import zipfile, xml.etree.ElementTree as ET, re, json
p=${JSON.stringify(workbookPath)}
ns={'a':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
with zipfile.ZipFile(p) as z:
  shared=[]
  if 'xl/sharedStrings.xml' in z.namelist():
    root=ET.fromstring(z.read('xl/sharedStrings.xml'))
    for si in root.findall('a:si', ns):
      shared.append(''.join(t.text or '' for t in si.findall('.//a:t', ns)))
  sheet=ET.fromstring(z.read('xl/worksheets/sheet1.xml'))
  rows=[]
  for row in sheet.findall('.//a:row', ns):
    cells={}
    for c in row.findall('a:c', ns):
      ref=c.attrib.get('r','')
      m=re.match(r'[A-Z]+', ref)
      if not m: continue
      v=c.find('a:v', ns)
      val=''
      if v is not None:
        val=v.text or ''
        if c.attrib.get('t')=='s': val=shared[int(val)]
      cells[m.group(0)]=val.strip()
    rows.append(cells)
print(json.dumps(rows, ensure_ascii=False))
`;
  return JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8' }));
}

function classifyWorkbookRows(rows) {
  let currentModule = '';
  const seen = new Set();
  return rows.slice(1).flatMap(row => {
    const no = row.A || '';
    const name = row.B || '';
    const url = row.C || '';
    if (!name || !url) return [];
    currentModule = row.D || currentModule;
    const sourceType = url === '微信公众号' || url.includes('公众号') ? 'wechat_public_account' : 'official_site';
    const authorityType = sourceType === 'wechat_public_account'
      ? 'media'
      : (/(政府|药品监督|市场监督|市场监管|知识产权局|商标局|检察院|司法部|人大|海关|网信办)/.test(name) ? 'regulator' : 'industry');
    const key = `${name}|${url}|${currentModule}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{
      id: `xlsx-${String(no).padStart(3, '0')}`,
      name,
      url,
      module: currentModule,
      region: '亚洲',
      country: '中国',
      source_type: sourceType,
      authority_type: authorityType,
      priority: authorityType === 'regulator' ? 'high' : 'medium',
      topics: [currentModule, name],
    }];
  });
}

const globalAuthoritySources = [
  { name: '欧盟委员会化妆品法规', url: 'https://single-market-economy.ec.europa.eu/sectors/cosmetics/cosmetic-products-specific-topics_en', module: '新规及案例动态', region: '欧洲', country: '欧盟', source_type: 'official_site', authority_type: 'regulator', priority: 'high', topics: ['欧盟', '化妆品法规', '禁限用成分', 'SCCS'] },
  { name: '欧盟 SCCS 科学委员会', url: 'https://health.ec.europa.eu/scientific-committees/scientific-committee-consumer-safety-sccs_en', module: '新规及案例动态', region: '欧洲', country: '欧盟', source_type: 'official_site', authority_type: 'regulator', priority: 'high', topics: ['SCCS', '成分安全', '意见稿'] },
  { name: '欧盟 Safety Gate', url: 'https://ec.europa.eu/safety-gate-alerts/screen/webReport', module: '广告合规及处罚案例', region: '欧洲', country: '欧盟', source_type: 'official_site', authority_type: 'regulator', priority: 'high', topics: ['Safety Gate', '召回', '化妆品'] },
  { name: '美国 FDA Cosmetics', url: 'https://www.fda.gov/cosmetics', module: '新规及案例动态', region: '北美洲', country: '美国', source_type: 'official_site', authority_type: 'regulator', priority: 'high', topics: ['MoCRA', 'FDA', '化妆品注册', '不良事件'] },
  { name: '美国 FTC Advertising', url: 'https://www.ftc.gov/news-events/news/press-releases', module: '广告合规及处罚案例', region: '北美洲', country: '美国', source_type: 'official_site', authority_type: 'regulator', priority: 'medium', topics: ['广告', 'FTC', '虚假宣传'] },
  { name: '印度尼西亚 BPOM', url: 'https://www.pom.go.id/', module: '新规及案例动态', region: '亚洲', country: '印尼', source_type: 'official_site', authority_type: 'regulator', priority: 'high', topics: ['BPOM', '清真', '化妆品注册'] },
  { name: '泰国 FDA Cosmetics', url: 'https://www.fda.moph.go.th/', module: '新规及案例动态', region: '亚洲', country: '泰国', source_type: 'official_site', authority_type: 'regulator', priority: 'high', topics: ['泰国', 'FDA', '化妆品'] },
  { name: '越南 DAV 化妆品', url: 'https://dav.gov.vn/', module: '新规及案例动态', region: '亚洲', country: '越南', source_type: 'official_site', authority_type: 'regulator', priority: 'high', topics: ['越南', '化妆品', '注册'] },
  { name: '日本厚生劳动省 化妆品', url: 'https://www.mhlw.go.jp/english/policy/health-medical/pharmaceuticals/index.html', module: '新规及案例动态', region: '亚洲', country: '日本', source_type: 'official_site', authority_type: 'regulator', priority: 'high', topics: ['日本', '化妆品', '医药部外品'] },
  { name: '韩国 MFDS Cosmetics', url: 'https://www.mfds.go.kr/eng/index.do', module: '新规及案例动态', region: '亚洲', country: '韩国', source_type: 'official_site', authority_type: 'regulator', priority: 'high', topics: ['韩国', 'MFDS', '化妆品'] },
  { name: '墨西哥 COFEPRIS', url: 'https://www.gob.mx/cofepris', module: '新规及案例动态', region: '北美洲', country: '墨西哥', source_type: 'official_site', authority_type: 'regulator', priority: 'high', topics: ['墨西哥', 'COFEPRIS', '化妆品'] },
  { name: '意大利卫生部 Cosmetics', url: 'https://www.salute.gov.it/portale/temi/p2_4.jsp?lingua=english&area=cosmetici', module: '新规及案例动态', region: '欧洲', country: '意大利', source_type: 'official_site', authority_type: 'regulator', priority: 'medium', topics: ['意大利', '化妆品', '欧盟'] },
  { name: 'WIPO', url: 'https://www.wipo.int/portal/en/index.html', module: '知识产权动态', region: '全球', country: '全球', source_type: 'official_site', authority_type: 'regulator', priority: 'medium', topics: ['WIPO', '商标', '外观设计'] },
  { name: 'EUIPO', url: 'https://www.euipo.europa.eu/en', module: '知识产权动态', region: '欧洲', country: '欧盟', source_type: 'official_site', authority_type: 'regulator', priority: 'medium', topics: ['EUIPO', '商标', '外观设计'] },
  { name: '美国 CBP', url: 'https://www.cbp.gov/newsroom', module: '进出口动态', region: '北美洲', country: '美国', source_type: 'official_site', authority_type: 'regulator', priority: 'medium', topics: ['进口', '海关', 'CBP'] },
];

const sources = [...classifyWorkbookRows(loadWorkbookRows()), ...globalAuthoritySources];
writeFileSync(new URL('./sources.json', import.meta.url), JSON.stringify({ sources }, null, 2) + '\n');
console.log(`wrote ${sources.length} sources`);
