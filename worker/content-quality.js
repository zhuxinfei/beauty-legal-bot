const MODULES = Object.freeze([
  '广告合规及处罚案例',
  '美妆动态',
  '知识产权动态',
  '新规及案例动态',
  '进出口动态',
  '产品质量/召回与安全风险',
]);

const PROMOTIONAL_PATTERNS = [
  /企业供稿/i,
  /全球招展|报名参展|招商|招代理|欢迎合作|欢迎报名/i,
  /双清包税|一站式(?:代办|服务)|包税到门|物流专线/i,
  /新品发布|品牌宣传|重磅上市|开启.*体验|打造.*实力/i,
  /产品推荐|十大.*推荐|品牌实力(?:榜单|推荐)|实测(?:分级)?榜单|盘点.*好物|选购指南/i,
];

const OPINION_PATTERNS = [
  /行业观察|趋势分析|增长逻辑|长期成长路径|重新分配.*增长/i,
  /建议关注|持续关注|可能产生影响|企业应留意|未来竞争/i,
];

const ACTION_PATTERN = /发布|公布|通报|处罚|罚款|召回|下架|查处|判决|裁定|签订|出口|进口|实施|生效|修订|征求意见|备案|注册|清算|要求|禁止|限制|调整|超标|发现|调查|取缔|赔偿|上市/;
const ACTOR_PATTERN = /(?:国家|省|市|县|区)?[\u4e00-\u9fffA-Za-z0-9]{2,}(?:局|委|院|署|海关|法院|公司|集团|企业|品牌|银行|协会|政府|部门|监管机构|NMPA|BPOM|FDA|MFDS|EUIPO|FTC)/i;
const EVIDENCE_PATTERN = /(20\d{2}[年./-]\d{1,2}[月./-]\d{1,2}日?|\d+(?:\.\d+)?\s*(?:万|亿|元|美元|欧元|件|批|吨|天|个|家|%|％)|罚款|处罚|召回|备案|注册|规则|条例|通知|判决|裁定|进出口|征求意见|生效|禁用|限用|抽检|不合格|超标|清算)/i;
const BEAUTY_DOMAIN_PATTERN = /化妆品|美妆|护肤|彩妆|香水|防晒|洗护|牙膏|化妆品原料|香料香精|功效宣称|功效评价|美容仪器|cosmetic|cosmetics|skincare|sunscreen|beauty\s+(?:product|brand|industry)/i;

const CHINA_MARKERS = [
  /中国|中华人民共和国|中国大陆|国内市场|中国市场|在华|对华|输华|中国出口|中国进口/i,
  /国家药监局|国家市场监管总局|海关总署|中国海关|国家知识产权局|中国法院|中国证监会|China\s+NMPA/i,
  /北京|上海|天津|重庆|广州|深圳|杭州|南京|苏州|成都|武汉|西安|厦门|宁波|青岛|郑州|合肥|济南|福州|昆明|沈阳|大连|浙江|江苏|广东|福建|四川|湖北|山东|河北|河南|湖南|安徽|陕西|云南|辽宁|澳门|香港/i,
  /影响在中国市场|影响中国企业|中国企业|中国消费者|中国境内/i,
];

const SHELL_LINE = /^(?:首页|导航|登录|注册|联系我们|搜索|移动版|客户端|分享|打印|字体大小|English|Home|Menu|关闭|上一页|下一页|订阅|欢迎访问)/i;
const NAVIGATION_TITLE = /(?:信息源入口|首页|主页|导航|登录|注册|联系我们|网站地图|搜索结果|welcome\s+to|site\s+map|contact\s+us)/i;

function isPublisherArticleUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    if (/(?:^|\.)news\.google\.com$/i.test(url.hostname)) return false;
    if (!url.pathname || url.pathname === '/' || /\/index(?:\.html?)?$/i.test(url.pathname)) return false;
    return true;
  } catch {
    return false;
  }
}

function textOf(candidate = {}) {
  return String(candidate.article_text || candidate.full_text || candidate.body || candidate.text || candidate.snippet || '').trim();
}

export function substantiveArticleText(candidate = {}, maxParagraphs = 5) {
  const raw = textOf(candidate);
  const paragraphs = raw
    .split(/\n+|(?<=[。！？!?])\s+/)
    .map(value => value.replace(/\s+/g, ' ').trim())
    .filter(value => value.length >= 12 && !SHELL_LINE.test(value));
  return paragraphs.slice(0, maxParagraphs).join(' ');
}

export function inferArticleChinaRelevance(candidate = {}) {
  const evidenceText = `${String(candidate.title || '').trim()} ${substantiveArticleText(candidate, 4)}`.trim();
  const matched = CHINA_MARKERS.filter(pattern => pattern.test(evidenceText)).map(pattern => pattern.source);
  return { relevant: matched.length > 0, evidence_text: evidenceText, matched_markers: matched };
}

export function inferCandidateModule(candidate = {}) {
  const text = `${String(candidate.title || '')} ${substantiveArticleText(candidate, 5)}`;
  if (/商标|专利|著作权|知识产权|侵权|判决|裁定|赔偿/.test(text)) return '知识产权动态';
  if (/进出口|出口|进口|海关|清关|关税|报关|跨境/.test(text)) return '进出口动态';
  if (/召回|抽检|不合格|安全风险|禁用|限用|重金属|菌落|微生物|过敏|超标|下架/.test(text)) return '产品质量/召回与安全风险';
  if (/广告|虚假宣传|功效宣称|直播|处罚|罚款|行政处罚|取缔/.test(text)) return '广告合规及处罚案例';
  if (/法规|条例|通知|征求意见|备案|注册|规则|标准|监管|实施|生效|监管部门/.test(text)) return '新规及案例动态';
  return '美妆动态';
}

export function evaluateEditorialCandidate(candidate = {}) {
  const title = String(candidate.title || '').trim();
  const body = textOf(candidate);
  const text = `${title} ${body}`.trim();
  if (!isPublisherArticleUrl(candidate.url || candidate.source_url)) {
    return { accepted: false, reason: /^https?:\/\/news\.google\.com/i.test(String(candidate.url || candidate.source_url || '')) ? 'non-publisher-url' : 'missing-direct-url' };
  }
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(String(candidate.published_at || ''))) {
    return { accepted: false, reason: 'missing-valid-date' };
  }
  const promotional = PROMOTIONAL_PATTERNS.find(pattern => pattern.test(text));
  if (promotional) return { accepted: false, reason: /物流|双清|包税|代办|服务/.test(promotional.source) ? 'service-promotion' : 'promotional-content' };
  if (NAVIGATION_TITLE.test(title)) {
    return { accepted: false, reason: 'navigation-shell' };
  }
  if (!BEAUTY_DOMAIN_PATTERN.test(text)) return { accepted: false, reason: 'not-beauty-industry' };
  const hasActor = ACTOR_PATTERN.test(text) || /监管部门|法院|海关|公司|集团|品牌|企业/.test(text);
  const hasAction = ACTION_PATTERN.test(text);
  const hasEvidence = EVIDENCE_PATTERN.test(text);
  if (!hasActor || !hasAction || !hasEvidence) return { accepted: false, reason: 'no-concrete-event' };
  if (OPINION_PATTERNS.some(pattern => pattern.test(title)) && !/(处罚|召回|判决|通报|签订|出口|进口|备案|注册|抽检|清算|罚款)/.test(text)) {
    return { accepted: false, reason: 'generic-opinion' };
  }
  return {
    accepted: true,
    tier: 'watch',
    reason: 'concrete-event',
    module: inferCandidateModule(candidate),
    china: inferArticleChinaRelevance(candidate),
    evidence: { actor: hasActor, action: hasAction, concrete: hasEvidence },
  };
}

export function isEditoriallyUsefulCandidate(candidate = {}) {
  return evaluateEditorialCandidate(candidate).accepted === true;
}

export function normalizeEventIdentity(candidate = {}) {
  return String(candidate.event_identity || candidate.title || '')
    .toLowerCase()
    .replace(/[（(]转载[）)]|[（(]改写[）)]|[-|｜].*(?:转载|改写).*$/gi, '')
    .replace(/原标题\s*[:：]/g, '')
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .slice(0, 240);
}

export function evaluateSourceOnlyProof(candidates = [], {
  period = {},
  minItems = 20,
  minChinaItems = 10,
  minModules = 4,
} = {}) {
  const start = String(period.start || '0000-00-00');
  const end = String(period.end || '9999-99-99');
  const seen = new Set();
  const unique = [];
  let duplicates = 0;
  for (const candidate of candidates) {
    const date = String(candidate.published_at || '');
    if (candidate.editorial_status !== 'accepted'
      || candidate.detail_status !== 'hydrated'
      || !/^https?:\/\//i.test(String(candidate.url || ''))
      || !/^20\d{2}-\d{2}-\d{2}$/.test(date)
      || date < start
      || date > end) continue;
    const identity = normalizeEventIdentity(candidate);
    if (!identity || seen.has(identity)) {
      duplicates += 1;
      continue;
    }
    seen.add(identity);
    unique.push(candidate);
  }
  const primaryCount = unique.length;
  const chinaCount = unique.filter(candidate => candidate.china_relevant === true).length;
  const activeModules = new Set(unique.map(candidate => candidate.module).filter(module => MODULES.includes(module)));
  const failureCodes = [];
  if (primaryCount < minItems) failureCodes.push('minimum-items');
  if (chinaCount < minChinaItems) failureCodes.push('minimum-china-items');
  if (activeModules.size < minModules) failureCodes.push('minimum-modules');
  return {
    pass: failureCodes.length === 0,
    primary_count: primaryCount,
    china_count: chinaCount,
    active_module_count: activeModules.size,
    primary_by_module: Object.fromEntries(MODULES.map(module => [module, unique.filter(candidate => candidate.module === module).length]).filter(([, count]) => count > 0)),
    failure_codes: failureCodes,
    duplicates,
    candidates: unique,
  };
}

export function buildSourceOnlyAudit(replay = {}) {
  const period = replay.period || {};
  const sourceCandidates = Array.isArray(replay.candidates) ? replay.candidates : [];
  const items = sourceCandidates.map(candidate => {
    const hydrated = candidate.detail_status === 'hydrated';
    const reviewed = {
      ...candidate,
      article_text: candidate.article_text || candidate.full_text || candidate.snippet_excerpt || candidate.snippet || '',
    };
    if (!hydrated) {
      return { title: candidate.title || '', url: candidate.url || '', detail_status: candidate.detail_status || '', accepted: false, reason: 'not-hydrated' };
    }
    const decision = evaluateEditorialCandidate(reviewed);
    if (!decision.accepted) {
      return { title: candidate.title || '', url: candidate.url || '', detail_status: candidate.detail_status, accepted: false, reason: decision.reason };
    }
    const china = inferArticleChinaRelevance(reviewed);
    return {
      title: candidate.title || '',
      url: candidate.url || '',
      published_at: candidate.published_at || '',
      detail_status: candidate.detail_status,
      accepted: true,
      reason: 'concrete-event',
      editorial_status: 'accepted',
      module: inferCandidateModule(reviewed),
      china_relevant: china.relevant,
    };
  });
  const acceptedCandidates = items.filter(item => item.accepted).map(item => ({
    ...item,
    snippet: item.title,
  }));
  const proof = evaluateSourceOnlyProof(acceptedCandidates, { period });
  const rejectionReasons = {};
  for (const item of items) {
    if (!item.accepted) rejectionReasons[item.reason] = (rejectionReasons[item.reason] || 0) + 1;
  }
  return {
    period,
    counts: {
      input: sourceCandidates.length,
      editorial_accepted: items.filter(item => item.accepted).length,
      editorial_rejected: items.filter(item => !item.accepted).length,
      primary_count: proof.primary_count,
      china_count: proof.china_count,
      active_module_count: proof.active_module_count,
      duplicates: proof.duplicates,
    },
    rejection_reasons: rejectionReasons,
    proof: {
      pass: proof.pass,
      failure_codes: proof.failure_codes,
    },
    items,
  };
}

export { MODULES };
