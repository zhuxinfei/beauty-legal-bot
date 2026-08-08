import { evaluateEditorialCandidate, evaluateSourceOnlyProof } from './content-quality.js';

const CHINESE_TEXT = /[\u4e00-\u9fff]/;

function selectedCandidate(candidates, item) {
  const needle = String(item.url_contains || '').trim();
  const matches = candidates.filter(candidate => needle && String(candidate.url || '').includes(needle));
  if (matches.length !== 1) {
    throw new Error(`Selection ${needle || '<empty>'} matched ${matches.length} candidates; expected exactly 1`);
  }
  return matches[0];
}

export function buildSelectedSourceProof(hydratedReplay = {}, selection = {}) {
  const sourceCandidates = Array.isArray(hydratedReplay.candidates) ? hydratedReplay.candidates : [];
  const manifestItems = Array.isArray(selection.items) ? selection.items : [];
  const candidates = manifestItems.map(item => {
    const source = selectedCandidate(sourceCandidates, item);
    const candidate = {
      ...source,
      title: item.title_override || source.title,
      module: item.module,
      china_relevant: item.china_relevant === true,
      event_identity: item.event_identity || item.url_contains,
    };
    const decision = evaluateEditorialCandidate(candidate);
    if (!decision.accepted) {
      throw new Error(`Selection ${item.url_contains} failed editorial gate: ${decision.reason}`);
    }
    return { ...candidate, editorial_status: 'accepted' };
  });
  const thresholds = selection.thresholds || {};
  const proof = evaluateSourceOnlyProof(candidates, {
    period: selection.period || {},
    minItems: thresholds.items ?? 20,
    minChinaItems: thresholds.china_items ?? 10,
    minModules: thresholds.modules ?? 4,
  });
  return {
    period: selection.period || {},
    counts: {
      manifest: manifestItems.length,
      accepted: candidates.length,
      rejected: 0,
      primary_count: proof.primary_count,
      china_count: proof.china_count,
      active_module_count: proof.active_module_count,
      duplicates: proof.duplicates,
    },
    proof: {
      pass: proof.pass,
      failure_codes: proof.failure_codes,
      primary_by_module: proof.primary_by_module,
    },
    candidates,
    items: candidates.map(candidate => ({
      title: candidate.title,
      url: candidate.url,
      published_at: candidate.published_at,
      module: candidate.module,
      china_relevant: candidate.china_relevant,
      event_identity: candidate.event_identity,
      full_text_length: String(candidate.article_text || '').length,
      accepted: true,
      reason: 'manual-and-editorial-pass',
    })),
  };
}

function publisherArticleUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return ['http:', 'https:'].includes(url.protocol)
      && !/(?:^|\.)news\.google\.com$/i.test(url.hostname)
      && url.pathname !== '/';
  } catch {
    return false;
  }
}

function requireEditorialRecord(candidate, record) {
  if (!record) throw new Error(`Missing editorial record for ${candidate.event_identity}`);
  for (const field of ['title_zh', 'source_zh', 'summary_zh', 'actor', 'action', 'result', 'follow_up']) {
    if (!CHINESE_TEXT.test(String(record[field] || ''))) {
      throw new Error(`${candidate.event_identity} missing natural Chinese ${field}`);
    }
  }
  const body = String(candidate.article_text || '');
  const quotes = Array.isArray(record.evidence_quotes) ? record.evidence_quotes : [];
  if (quotes.length < 2) throw new Error(`${candidate.event_identity} requires at least two evidence quotes`);
  for (const quote of quotes) {
    if (!body.includes(String(quote))) {
      throw new Error(`${candidate.event_identity} has unsupported evidence quote: ${quote}`);
    }
  }
  const chinaQuotes = Array.isArray(record.china_evidence_quotes) ? record.china_evidence_quotes : [];
  if (candidate.china_relevant && chinaQuotes.length === 0) {
    throw new Error(`${candidate.event_identity} missing China evidence quote`);
  }
  for (const quote of chinaQuotes) {
    if (!`${candidate.title} ${body.slice(0, 3000)}`.includes(String(quote))) {
      throw new Error(`${candidate.event_identity} has unsupported China evidence quote: ${quote}`);
    }
  }
  return { quotes, chinaQuotes };
}

export function buildArtifactAndAudit(sourceProof = {}, editorial = {}, {
  minItems = 20,
  minChinaItems = 10,
  minModules = 4,
} = {}) {
  if (!sourceProof.proof?.pass) throw new Error('Source-only proof must pass before artifact generation');
  const sourceCandidates = Array.isArray(sourceProof.candidates) ? sourceProof.candidates : [];
  const editorialItems = Array.isArray(editorial.items) ? editorial.items : [];
  const sourceIds = new Set(sourceCandidates.map(candidate => candidate.event_identity));
  const editorialIds = new Set(editorialItems.map(item => item.event_identity));
  if (sourceIds.size !== sourceCandidates.length || editorialIds.size !== editorialItems.length) {
    throw new Error('Duplicate event identity in source or editorial records');
  }
  if (sourceIds.size !== editorialIds.size || [...sourceIds].some(id => !editorialIds.has(id))) {
    throw new Error('Editorial records must match the source-only event set exactly');
  }

  const items = sourceCandidates.map(candidate => {
    const record = editorialItems.find(item => item.event_identity === candidate.event_identity);
    const { quotes, chinaQuotes } = requireEditorialRecord(candidate, record);
    if (!publisherArticleUrl(candidate.url)) throw new Error(`${candidate.event_identity} missing publisher article URL`);
    if (!/^20\d{2}-\d{2}-\d{2}$/.test(String(candidate.published_at || ''))) {
      throw new Error(`${candidate.event_identity} missing valid date`);
    }
    if (String(candidate.article_text || '').length < 500) {
      throw new Error(`${candidate.event_identity} missing complete article body`);
    }
    return {
      event_identity: candidate.event_identity,
      module: candidate.module,
      china_relevant: candidate.china_relevant,
      title: record.title_zh,
      source: record.source_zh,
      summary: record.summary_zh,
      published_at: candidate.published_at,
      source_url: candidate.url,
      original_title: candidate.title,
      original_source: candidate.source_name,
      actor: record.actor,
      action: record.action,
      result: record.result,
      evidence_quotes: quotes,
      china_evidence_quotes: chinaQuotes,
      follow_up: record.follow_up,
      tier: 'watch',
      article_text: candidate.article_text,
    };
  }).sort((a, b) => Number(b.china_relevant) - Number(a.china_relevant) || a.published_at.localeCompare(b.published_at));

  const modules = Object.fromEntries([...new Set(items.map(item => item.module))]
    .map(module => [module, items.filter(item => item.module === module)]));
  const counts = {
    items: items.length,
    china_items: items.filter(item => item.china_relevant).length,
    active_modules: Object.keys(modules).length,
    independent_events: new Set(items.map(item => item.event_identity)).size,
  };
  const pass = counts.items >= minItems
    && counts.china_items >= minChinaItems
    && counts.active_modules >= minModules
    && counts.independent_events === counts.items;
  const auditItems = items.map(item => ({
    event_identity: item.event_identity,
    title: item.title,
    source_url: item.source_url,
    module: item.module,
    china_relevant: item.china_relevant,
    checks: {
      publisher_direct_url: publisherArticleUrl(item.source_url),
      valid_date: /^20\d{2}-\d{2}-\d{2}$/.test(item.published_at),
      complete_body: item.article_text.length >= 500,
      concrete_actor_action_result: [item.actor, item.action, item.result].every(value => CHINESE_TEXT.test(value)),
      body_evidence: item.evidence_quotes.length >= 2 && item.evidence_quotes.every(quote => item.article_text.includes(quote)),
      natural_chinese_presentation: [item.title, item.source, item.summary].every(value => CHINESE_TEXT.test(value)),
      china_evidence: !item.china_relevant || (item.china_evidence_quotes.length > 0
        && item.china_evidence_quotes.every(quote => `${item.original_title} ${item.article_text.slice(0, 3000)}`.includes(quote))),
      independent_event: true,
    },
    pass: true,
  }));
  if (!pass || auditItems.some(item => Object.values(item.checks).includes(false))) {
    throw new Error(`Final artifact audit failed: ${JSON.stringify(counts)}`);
  }
  return {
    artifact: {
      artifact_only: true,
      delivery_attempted: false,
      generated_at: editorial.generated_at,
      period: sourceProof.period,
      editorial_priority: 'china-first',
      counts,
      modules,
    },
    audit: {
      artifact_only: true,
      delivery_attempted: false,
      counts,
      proof: { pass, thresholds: { items: minItems, china_items: minChinaItems, modules: minModules } },
      items: auditItems,
    },
  };
}
