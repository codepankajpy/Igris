/**
 * (c) Where the address went: the site on the left, every recipient that
 * received a full or hashed form of the canary address on the right,
 * grouped by the backend's verdict, each with when (first timed request
 * carrying it) and how (where in the request, which encoding).
 */
import type { Recipient, ReportV3 } from '@igris/core/contracts';
import {
  ADDRESS_LABEL,
  VERDICT,
  VERDICT_ORDER,
  VerdictChip,
  addressToTracker,
  classLabel,
  secs,
} from '../ui.js';
import { phases, type Lookup } from '../report/lookup.js';
import { ChartFrame, LegendItem, SrTable } from './common.js';

const GROUP_H = 30;
const ROW_H = 90;
const GAP = 8;

export function AddressFlow({
  report,
  hostname,
  lookup,
}: {
  report: ReportV3;
  hostname: string;
  lookup: Lookup;
}) {
  const received = report.recipients.filter(
    (r) => r.learned.address === 'exact' || r.learned.address === 'hashed',
  );
  const possible = report.recipients.filter((r) => r.learned.address === 'possible');

  if (received.length === 0)
    return (
      <div class="panel flow-none">
        <div class="flow-none-mark" aria-hidden="true" />
        <div>
          <b>No full or hashed form of the wallet address was observed reaching any third party.</b>
          {possible.length > 0 && (
            <p class="muted small" style={{ margin: '6px 0 0' }}>
              A truncated display form (a possible match, ambiguous on its own) reached{' '}
              {possible.map((r) => r.registrableDomain).join(', ')}.
            </p>
          )}
        </div>
      </div>
    );

  // Layout: rows stacked per verdict group; connectors meet each row's middle.
  const groups = VERDICT_ORDER.map((v) => ({
    v,
    rows: received.filter((r) => r.verdict === v),
  })).filter((g) => g.rows.length);
  const placed: Array<{ r: Recipient; y: number }> = [];
  let y = 0;
  for (const g of groups) {
    y += GROUP_H;
    for (const r of g.rows) {
      placed.push({ r, y: y + ROW_H / 2 });
      y += ROW_H + GAP;
    }
  }
  const H = y;
  const mid = H / 2;

  const describe = (r: Recipient) => {
    const t = lookup.firstAddressMs(r);
    const how = lookup.howFor(r);
    return {
      when: `${phases(r.learned.addressPhases)}${t === null ? '' : ` · first at ${secs(t)}`}`,
      how: how.length ? how.join('; ') : 'not in transmitted traffic',
    };
  };

  return (
    <>
      <ChartFrame
        minWidth={620}
        label="Where the address went"
        legend={
          <>
            <LegendItem kind="flow">full address</LegendItem>
            <LegendItem kind="flow-hashed">hashed address</LegendItem>
            <LegendItem kind="flow-signal">to a tracking / unidentified party</LegendItem>
          </>
        }
        caption="Every party that received a full or hashed form of the throwaway wallet address, with when and how."
      >
        <div
          class="flow"
          style={{ height: H }}
          role="img"
          aria-label={`The wallet address reached ${received.length} third ${
            received.length === 1 ? 'party' : 'parties'
          }: ${received
            .map((r) => `${r.registrableDomain} (${VERDICT[r.verdict].label})`)
            .join(', ')}.`}
        >
          <div class="flow-site" style={{ top: mid }}>
            <span class="eyebrow">site</span>
            <b class="mono" title={hostname}>
              {hostname}
            </b>
            <span class="muted small">throwaway wallet</span>
          </div>
          <svg
            class="flow-links"
            viewBox={`0 0 100 ${H}`}
            preserveAspectRatio="none"
            width="100%"
            height={H}
            aria-hidden="true"
          >
            {placed.map(({ r, y: ry }) => (
              <path
                key={`${r.registrableDomain}|${r.class}`}
                d={`M0 ${mid} C 55 ${mid}, 45 ${ry}, 100 ${ry}`}
                vector-effect="non-scaling-stroke"
                class={`flow-link ${r.learned.address === 'hashed' ? 'hashed' : ''} ${
                  addressToTracker(r) ? 'signal' : ''
                }`}
              />
            ))}
          </svg>
          <div class="flow-targets">
            {groups.map((g) => (
              <div key={g.v}>
                <div class={`flow-group v-${g.v}`} style={{ height: GROUP_H }}>
                  <span class="v-mark" aria-hidden="true" />
                  {VERDICT[g.v].label}
                </div>
                {g.rows.map((r) => {
                  const d = describe(r);
                  return (
                    <div
                      key={`${r.registrableDomain}|${r.class}`}
                      class={`flow-target ${addressToTracker(r) ? 'signal' : ''}`}
                      style={{ height: ROW_H, marginBottom: GAP }}
                    >
                      <div class="spread" style={{ gap: 8 }}>
                        <b class="mono flow-domain">{r.registrableDomain}</b>
                        <VerdictChip verdict={r.verdict} />
                      </div>
                      <div class="muted small flow-meta">
                        {classLabel(r.class)} · {ADDRESS_LABEL[r.learned.address].toLowerCase()} ·{' '}
                        {d.when}
                      </div>
                      <div class="mono flow-how" title={d.how}>
                        {d.how}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </ChartFrame>
      <SrTable
        caption="Where the wallet address went"
        head={['Recipient', 'Class', 'Verdict', 'Form', 'When', 'How']}
        rows={received.map((r) => {
          const d = describe(r);
          return [
            r.registrableDomain,
            classLabel(r.class),
            VERDICT[r.verdict].label,
            ADDRESS_LABEL[r.learned.address],
            d.when,
            d.how,
          ];
        })}
      />
      {possible.length > 0 && (
        <p class="muted small" style={{ marginTop: 10 }}>
          Also: a truncated display form (a possible match, ambiguous on its own) reached{' '}
          {possible.map((r) => r.registrableDomain).join(', ')}.
        </p>
      )}
    </>
  );
}
