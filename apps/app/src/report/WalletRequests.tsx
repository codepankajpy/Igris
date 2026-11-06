/**
 * "What the site asked your wallet to do": report.walletRequests (Report
 * 3.0.0), one card per request in request order — what it would allow, to
 * whom, for how long, on which chain — with the backend's flags and its
 * wallet-requests findings, the throwaway wallet's outcome and the evidence
 * item. Every value is the backend's; nothing is re-judged here. Risk flags
 * use the neutral emphasis (never the signal red, which is reserved for "the
 * address reached a tracking/unidentified recipient").
 */
import type {
  EvidenceBundle,
  FindingV3,
  ReportV3,
  WalletRequestSummary,
} from '@igris/core/contracts';
import { NotRecorded, Section, plural, secs, stamp } from '../ui.js';
import { Sev } from './Details.js';
import {
  EMPTY_TEXT,
  KIND_ALLOWS,
  KIND_LABEL,
  OUTCOME_LABEL,
  PHASE_TEXT,
  amountText,
  asksToSign,
  chainText,
  contractText,
  deadlineText,
  findingsOf,
  flags,
  hasRisk,
  recipientRole,
  signInText,
} from './wallet-requests.js';

export function WalletRequestsSection({
  report,
  evidence,
  hostname,
  findings,
  evidenceHref,
}: {
  report: ReportV3;
  evidence: EvidenceBundle;
  hostname: string;
  findings: ReadonlyMap<string, FindingV3>;
  evidenceHref: (id: string) => string;
}) {
  const reqs = report.walletRequests;
  const signing = reqs?.filter((r) => asksToSign(r.kind)).length ?? 0;
  const risky = reqs?.filter((r) => hasRisk(r, findings)).length ?? 0;
  return (
    <Section
      id="wallet-requests"
      title="What the site asked your wallet to do"
      aside={
        reqs === null
          ? 'not recorded'
          : `${plural(reqs.length, 'request')} · ${plural(risky, 'with a risk finding', 'with risk findings')}`
      }
      lede="Every request the page sent to IGRIS’s throwaway wallet, decoded: what it would allow, to whom, for how long and on which chain. The throwaway wallet signs messages and typed data and rejects transactions — the outcome says what it did, not what you should do."
    >
      {reqs === null ? (
        <NotRecorded what="This report does not record what the site asked the wallet: reports made before wallet requests were captured have none, so they are not recorded rather than absent." />
      ) : (
        <>
          {signing === 0 && (
            <p class="panel wr-empty">
              {EMPTY_TEXT}
              {reqs.length > 0 && (
                <span class="muted small">
                  {' '}
                  It only asked to{' '}
                  {[...new Set(reqs.map((r) => KIND_LABEL[r.kind].toLowerCase()))].join(', ')}.
                </span>
              )}
            </p>
          )}
          {reqs.length > 0 && (
            <ol class="wr-list" aria-label="Wallet requests, in the order the site made them">
              {reqs.map((r, i) => (
                <li key={`${i}-${r.evidenceId}`}>
                  <WalletRequestCard
                    r={r}
                    index={i}
                    evidence={evidence}
                    hostname={hostname}
                    walletChain={report.scan.chainId}
                    findings={findingsOf(r, findings)}
                    evidenceHref={evidenceHref}
                  />
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </Section>
  );
}

function WalletRequestCard({
  r,
  index,
  evidence,
  hostname,
  walletChain,
  findings,
  evidenceHref,
}: {
  r: WalletRequestSummary;
  index: number;
  evidence: EvidenceBundle;
  hostname: string;
  walletChain: number;
  findings: FindingV3[];
  evidenceHref: (id: string) => string;
}) {
  const fl = flags(r);
  const risk = findings.some((f) => f.kind === 'risk');
  const item = evidence.items[r.evidenceId];
  const origin = item?.type === 'wallet-request' ? item.origin : null;
  const chain = chainText(r, walletChain, findings);
  const signIn = signInText(r, hostname);
  const contract = contractText(r.verifyingContract);
  const headId = `wr-${index}-h`;
  return (
    <article class={`panel wr-card ${risk ? 'risk' : ''}`} aria-labelledby={headId}>
      <div class="wr-when">
        <span class="mono wr-index">#{index + 1}</span>
        <span class="mono">{r.t === null ? 'not timed' : secs(r.t)}</span>
        <span class="chip">{PHASE_TEXT[r.phase] ?? r.phase}</span>
        <span class={`chip wr-outcome o-${r.outcome}`}>{OUTCOME_LABEL[r.outcome]}</span>
      </div>
      <h3 class="wr-kind" id={headId}>
        {KIND_LABEL[r.kind]}
      </h3>
      <div class="muted small">
        <code>{r.method}</code>
        {r.frame === 'iframe' ? ' · asked from an embedded frame' : ''}
      </div>
      <p class="wr-allows">{KIND_ALLOWS[r.kind]}</p>
      <dl class="kv wr-kv">
        {r.spender !== null && (
          <>
            <dt>{recipientRole(r.kind)}</dt>
            <dd class="mono">{r.spender}</dd>
          </>
        )}
        {r.token !== null && (
          <>
            <dt>Token</dt>
            <dd class="mono">{r.token}</dd>
          </>
        )}
        {(r.amount !== null || r.unlimited) && (
          <>
            <dt>Amount</dt>
            <dd class={r.unlimited ? 'wr-emph' : 'mono'}>{amountText(r)}</dd>
          </>
        )}
        {r.deadline !== null && (
          <>
            <dt>Valid until</dt>
            <dd class={r.longDeadline ? 'wr-emph' : ''}>{deadlineText(r.deadline, stamp)}</dd>
          </>
        )}
        {chain !== null && (
          <>
            <dt>Chain named</dt>
            <dd class={r.chainIdMismatch ? 'wr-emph' : ''}>{chain}</dd>
          </>
        )}
        {signIn !== null && (
          <>
            <dt>Sign-in for</dt>
            <dd class={r.domainMismatch ? 'wr-emph' : ''}>{signIn}</dd>
          </>
        )}
        {contract !== null && (
          <>
            <dt>Verified by</dt>
            <dd class="mono">{contract}</dd>
          </>
        )}
        {origin !== null && (
          <>
            <dt>Asked by</dt>
            <dd class="mono">{origin}</dd>
          </>
        )}
      </dl>
      {fl.length > 0 && (
        <ul class="wr-flags" aria-label="Flags the backend set on this request">
          {fl.map((f) => (
            <li class="wr-flag" key={f.key}>
              {f.text}
            </li>
          ))}
        </ul>
      )}
      {findings.length > 0 && (
        <ul class="wr-findings" aria-label="Findings about this request">
          {findings.map((f) => (
            <li key={f.id}>
              <Sev s={f.severity} />
              <span>{f.title}</span>
              <span class="chip">{f.kind}</span>
            </li>
          ))}
        </ul>
      )}
      <div class="ev-links">
        <a class="chip evidence-link" href={evidenceHref(r.evidenceId)} title={r.evidenceId}>
          Wallet request evidence →
        </a>
      </div>
    </article>
  );
}
