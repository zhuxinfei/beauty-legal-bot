import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { isLikelyPortalUrl } from './source-acquisition.js';

const workbookPath = process.env.SOURCE_WORKBOOK || '/Users/zhuxinfei/Downloads/美妆行业新法律法规、违法案例公众号_网站收录 +2026.5.24.xlsx';

const sourceAlternatesByName = {
  '国家药品监督管理局': [
    'https://zwfw.nmpa.gov.cn/web/taskview/11100000MB0341032Y100207205000001',
    'https://zwfw.nmpa.gov.cn/web/taskview/11100000MB0341032Y100017214800001',
    'https://english.nmpa.gov.cn/2025-02/19/c_1073586.htm',
  ],
  '国家市场监督管理总局': [
    'https://www.samr.gov.cn/ggjgs/index.html',
  ],
  '中华人民共和国最高人民检察院': [
    'https://www.spp.gov.cn/spp/zgrmjcyxwfbh/wqxwfbh/index.shtml',
    'https://www.spp.gov.cn/spp/xwfbh/dxal/index.shtml',
  ],
};

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
    const sourceScope = isLikelyPortalUrl(url) ? 'portal' : 'discovery_only';
    return [{
      id: `xlsx-${String(no).padStart(3, '0')}`,
      name,
      url,
      source_scope: sourceScope,
      module: currentModule,
      region: '亚洲',
      country: '中国',
      source_type: sourceType,
      authority_type: authorityType,
      priority: authorityType === 'regulator' ? 'high' : 'medium',
      topics: [currentModule, name],
      ...(sourceAlternatesByName[name] ? { alternate_urls: sourceAlternatesByName[name] } : {}),
    }];
  });
}

const hardFactAuthoritySources = [
  {
    id: 'hardfact-cn-nifdc-cosmetic-pseudomonas-consultation-20260721',
    name: '中检院化妆品微生物标准征求意见',
    url: 'https://www.nifdc.org.cn/directory/web/nifdc/bshff/hzhpbzh/hzhpbzhtzgg/202607211930582131911.html',
    source_scope: 'hard_fact_endpoint',
    module: '新规及案例动态',
    region: '亚洲',
    country: '中国',
    source_type: 'official_site',
    authority_type: 'regulator',
    priority: 'high',
    topics: ['化妆品标准', '征求意见', '铜绿假单胞菌', '耐热大肠菌群'],
  },
  {
    id: 'hardfact-cn-nmpa-cosmetic-safety-technical-methods-20260529',
    name: '国家药监局化妆品安全技术规范检验方法公告',
    url: 'https://www.nmpa.gov.cn/xxgk/ggtg/hzhpggtg/jmhzhptg/20260529150154170.html',
    source_scope: 'hard_fact_endpoint',
    module: '新规及案例动态',
    region: '亚洲',
    country: '中国',
    source_type: 'official_site',
    authority_type: 'regulator',
    priority: 'high',
    topics: ['化妆品安全技术规范', '公告', '检验方法', '国家药监局'],
  },
  {
    id: 'hardfact-cn-nmpa-new-ingredient-registration-20260626',
    name: '国家药监局化妆品新原料注册备案资料管理规定',
    url: 'https://www.nmpa.gov.cn/xxgk/fgwj/xzhgfxwj/20260626114523130.html',
    source_scope: 'hard_fact_endpoint',
    module: '新规及案例动态',
    region: '亚洲',
    country: '中国',
    source_type: 'official_site',
    authority_type: 'regulator',
    priority: 'high',
    topics: ['化妆品新原料', '注册备案', '资料管理规定', '国家药监局'],
  },
  {
    id: 'hardfact-cn-nifdc-new-ingredient-technical-rules-20260626',
    name: '中检院化妆品新原料注册备案资料技术通则',
    url: 'https://www.nifdc.org.cn/nifdc/bshff/hzhpjssp/hzpsptzgg/202606261410392098272.html',
    source_scope: 'hard_fact_endpoint',
    module: '新规及案例动态',
    region: '亚洲',
    country: '中国',
    source_type: 'official_site',
    authority_type: 'regulator',
    priority: 'high',
    topics: ['化妆品新原料', '技术通则', '注册备案', '中检院'],
  },
  {
    id: 'hardfact-cn-nifdc-cosmetic-standards-notices',
    name: '中检院化妆品标准通知公告',
    url: 'https://www.nifdc.org.cn/directory/web/nifdc/bshff/hzhpbzh/hzhpbzhtzgg/index.html',
    source_scope: 'hard_fact_list',
    module: '新规及案例动态',
    region: '亚洲',
    country: '中国',
    source_type: 'official_site',
    authority_type: 'regulator',
    priority: 'high',
    topics: ['化妆品标准', '征求意见', '公告', '国家药监局'],
  },
  {
    id: 'hardfact-cn-fujian-cosmetic-regulatory-updates',
    name: '福建省药监局化妆品监管动态',
    url: 'https://yjj.scjgj.fujian.gov.cn/hzp/jgdt/',
    source_scope: 'hard_fact_list',
    module: '新规及案例动态',
    region: '亚洲',
    country: '中国',
    source_type: 'official_site',
    authority_type: 'regulator',
    priority: 'high',
    topics: ['化妆品监管动态', '国家药监局公告', '通告', '征求意见'],
  },
  {
    id: 'hardfact-us-ftc-ah-media-cosmetic-free-trial-refunds-202607',
    name: 'FTC 化妆品 free trial 退款案',
    url: 'https://www.ftc.gov/enforcement/refunds/ah-media-group-refunds',
    source_scope: 'hard_fact_endpoint',
    module: '广告合规及处罚案例',
    region: '北美洲',
    country: '美国',
    source_type: 'official_site',
    authority_type: 'regulator',
    priority: 'high',
    topics: ['FTC', 'cosmetics', 'free trial', 'refunds', 'negative option'],
  },
  {
    id: 'hardfact-us-fda-morovan-nail-polish-remover-recall-202604',
    name: 'FDA 指甲油卸除剂召回',
    url: 'https://www.fda.gov/safety/recalls-market-withdrawals-safety-alerts/product-recall',
    source_scope: 'hard_fact_endpoint',
    module: '产品质量/召回与安全风险',
    region: '北美洲',
    country: '美国',
    source_type: 'official_site',
    authority_type: 'regulator',
    priority: 'medium',
    topics: ['FDA', 'cosmetics', 'recall', 'methylene chloride', 'chloroform'],
  },
  {
    id: 'hardfact-uk-opss-pr-francoise-bedon-body-lotion-20260709',
    name: '英国 OPSS 祛斑身体乳产品安全报告',
    url: 'https://www.gov.uk/product-safety-alerts-reports-recalls/product-safety-report-pr-francoise-bedon-paris-carotte-lightening-body-lotion-2606-0305',
    source_scope: 'hard_fact_endpoint',
    module: '产品质量/召回与安全风险',
    region: '欧洲',
    country: '英国',
    source_type: 'official_site',
    authority_type: 'regulator',
    priority: 'high',
    topics: ['OPSS', 'cosmetics', 'skin lightening', 'hydroquinone', 'import rejected', 'destruction'],
  },
  {
    id: 'hardfact-uk-opss-beauty-pie-hair-spray-recall-20260601',
    name: '英国 OPSS Beauty Pie 护发喷雾召回',
    url: 'https://www.gov.uk/product-safety-alerts-reports-recalls/product-recall-beauty-pie-super-healthy-hair-magic-smoothing-heat-shield-spray-2604-0174',
    source_scope: 'hard_fact_endpoint',
    module: '产品质量/召回与安全风险',
    region: '欧洲',
    country: '英国',
    source_type: 'official_site',
    authority_type: 'regulator',
    priority: 'high',
    topics: ['OPSS', 'cosmetics', 'recall', 'Beauty Pie', 'Pseudomonas aeruginosa', 'batch 3094A'],
  },
  {
    id: 'hardfact-uk-opss-kids-stuff-foaming-soap-20260626',
    name: '英国 OPSS Kids Stuff 泡沫皂安全通报更新',
    url: 'https://www.gov.uk/product-safety-alerts-reports-recalls/product-safety-report-kids-stuff-crazy-foaming-soap-2603-0273',
    source_scope: 'hard_fact_endpoint',
    module: '产品质量/召回与安全风险',
    region: '欧洲',
    country: '英国',
    source_type: 'official_site',
    authority_type: 'regulator',
    priority: 'medium',
    topics: ['OPSS', 'cosmetics', 'foaming soap', 'burns', 'withdrawal', 'safe disposal'],
  },
];

const globalAuthoritySources = [
  { name: '欧盟委员会化妆品法规', url: 'https://single-market-economy.ec.europa.eu/sectors/cosmetics/cosmetic-products-specific-topics_en', alternate_urls: ['https://single-market-economy.ec.europa.eu/sectors/cosmetics/legislation_en', 'https://eur-lex.europa.eu/legal-content/en/TXT/?uri=CELEX%3A32009R1223'], module: '新规及案例动态', region: '欧洲', country: '欧盟', source_type: 'official_site', authority_type: 'regulator', priority: 'high', topics: ['欧盟', '化妆品法规', '禁限用成分', 'SCCS'] },
  { name: '欧盟 SCCS 科学委员会', url: 'https://health.ec.europa.eu/scientific-committees/scientific-committee-consumer-safety-sccs_en', alternate_urls: ['https://health.ec.europa.eu/scientific-committees/scientific-committee-consumer-safety-sccs/sccs-opinions_en', 'https://health.ec.europa.eu/scientific-committees_en'], module: '新规及案例动态', region: '欧洲', country: '欧盟', source_type: 'official_site', authority_type: 'regulator', priority: 'high', topics: ['SCCS', '成分安全', '意见稿'] },
  { name: '欧盟 Safety Gate', url: 'https://ec.europa.eu/safety-gate-alerts/screen/webReport', module: '广告合规及处罚案例', region: '欧洲', country: '欧盟', source_type: 'official_site', authority_type: 'regulator', priority: 'high', topics: ['Safety Gate', '召回', '化妆品'] },
  { name: '美国 FDA Cosmetics', url: 'https://www.fda.gov/cosmetics', module: '新规及案例动态', region: '北美洲', country: '美国', source_type: 'official_site', authority_type: 'regulator', priority: 'high', topics: ['MoCRA', 'FDA', '化妆品注册', '不良事件'] },
  { name: '美国 FTC Advertising', url: 'https://www.ftc.gov/news-events/news/press-releases', module: '广告合规及处罚案例', region: '北美洲', country: '美国', source_type: 'official_site', authority_type: 'regulator', priority: 'medium', topics: ['广告', 'FTC', '虚假宣传'] },
  { name: '印度尼西亚 BPOM', url: 'https://www.pom.go.id/', alternate_urls: ['https://www.pom.go.id/siaran-pers?page=1', 'https://standar-otskk.pom.go.id/regulasi', 'https://standar-otskk.pom.go.id/publikasi/kategori/siaran-pers', 'https://www.pom.go.id/siaran-pers/bpom-intensifkan-pengawasan-ruang-digital-peredaran-kosmetik-ilegal-jadi-sorotan'], module: '新规及案例动态', region: '亚洲', country: '印尼', source_type: 'official_site', authority_type: 'regulator', priority: 'high', topics: ['BPOM', '清真', '化妆品注册'] },
  { name: '泰国 FDA Cosmetics', url: 'https://www.fda.moph.go.th/', module: '新规及案例动态', region: '亚洲', country: '泰国', source_type: 'official_site', authority_type: 'regulator', priority: 'high', topics: ['泰国', 'FDA', '化妆品'] },
  { name: '越南 DAV 化妆品', url: 'https://dav.gov.vn/', module: '新规及案例动态', region: '亚洲', country: '越南', source_type: 'official_site', authority_type: 'regulator', priority: 'high', topics: ['越南', '化妆品', '注册'] },
  { name: '日本厚生劳动省 化妆品', url: 'https://www.mhlw.go.jp/english/policy/health-medical/pharmaceuticals/index.html', module: '新规及案例动态', region: '亚洲', country: '日本', source_type: 'official_site', authority_type: 'regulator', priority: 'high', topics: ['日本', '化妆品', '医药部外品'] },
  { name: '韩国 MFDS Cosmetics', url: 'https://www.mfds.go.kr/eng/index.do', module: '新规及案例动态', region: '亚洲', country: '韩国', source_type: 'official_site', authority_type: 'regulator', priority: 'high', topics: ['韩国', 'MFDS', '化妆品'] },
  { name: '墨西哥 COFEPRIS', url: 'https://www.gob.mx/cofepris', module: '新规及案例动态', region: '北美洲', country: '墨西哥', source_type: 'official_site', authority_type: 'regulator', priority: 'high', topics: ['墨西哥', 'COFEPRIS', '化妆品'] },
  { name: '意大利卫生部 Cosmetics', url: 'https://www.salute.gov.it/portale/temi/p2_4.jsp?lingua=english&area=cosmetici', module: '新规及案例动态', region: '欧洲', country: '意大利', source_type: 'official_site', authority_type: 'regulator', priority: 'medium', topics: ['意大利', '化妆品', '欧盟'] },
  { name: 'WIPO', url: 'https://www.wipo.int/portal/en/index.html', alternate_urls: ['https://www.wipo.int/news/en/', 'https://www.wipo.int/en/web/newsletters/'], module: '知识产权动态', region: '全球', country: '全球', source_type: 'official_site', authority_type: 'regulator', priority: 'medium', topics: ['WIPO', '商标', '外观设计'] },
  { name: 'EUIPO', url: 'https://www.euipo.europa.eu/en', module: '知识产权动态', region: '欧洲', country: '欧盟', source_type: 'official_site', authority_type: 'regulator', priority: 'medium', topics: ['EUIPO', '商标', '外观设计'] },
  { name: '美国 CBP', url: 'https://www.cbp.gov/newsroom', module: '进出口动态', region: '北美洲', country: '美国', source_type: 'official_site', authority_type: 'regulator', priority: 'medium', topics: ['进口', '海关', 'CBP'] },
];

const sources = [...hardFactAuthoritySources, ...classifyWorkbookRows(loadWorkbookRows()), ...globalAuthoritySources.map(source => ({
  ...source,
  source_scope: isLikelyPortalUrl(source.url) ? 'portal' : 'discovery_only',
}))];
writeFileSync(new URL('./sources.json', import.meta.url), JSON.stringify({ sources }, null, 2) + '\n');
console.log(`wrote ${sources.length} sources`);
