/**
 * Breach Trends — the aggregate behind the table: when breaches happen (per
 * IST hour of the day, the peak hour emphasised) and where (the cameras with
 * the most). One series each, one brand hue; the peak is picked out by
 * weight, not a second colour.
 *
 * The numbers are the SERVER's, over the same filters as the table
 * (`GET /ai/zone-breaches/trends`). They used to be counted in the browser
 * from the rows it was holding — which, once the table paged on the server,
 * meant a panel describing 25 breaches under a heading that said 500.
 */
import { BarChart3 } from 'lucide-react';
import {
  Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import Panel from '@/core/ui/panel';
import { AXIS, GRID, TIP } from '@/core/ui/chart-theme';

// "breach" takes -es, not -s. The old helper appended a bare "s" and the
// panel read "186 breachs".
const plural = (n, w = 'breach') => `${n.toLocaleString()} ${n === 1 ? w : `${w}es`}`;

const EMPTY_HOURS = Array.from({ length: 24 }, (_, hour) => ({
  hour, label: `${String(hour).padStart(2, '0')}:00`, count: 0,
}));

/**
 * @param {object} p
 * @param {{ hours, peak, topCameras, total }|null} p.data  the server rollup
 * @param {boolean} [p.loading]
 */
export default function BreachTrends({ data, loading = false }) {
  const hours = data?.hours?.length === 24 ? data.hours : EMPTY_HOURS;
  const peak = data?.peak || null;
  const topCameras = data?.topCameras || [];
  const total = Number(data?.total) || 0;
  const hourLabel = (h) => `${String(h).padStart(2, '0')}:00–${String((h + 1) % 24).padStart(2, '0')}:00`;

  return (
    <Panel
      bodyClass="p-4"
      icon={BarChart3}
      right={(
        <span className="text-micro text-fg-subtle">
          {loading && !data ? 'Loading…' : `${plural(total, 'breach')} · IST`}
        </span>
      )}
      title="Breach trends"
    >
      {total === 0 ? (
        <p className="py-8 text-center text-small text-fg-muted">
          {loading && !data ? 'Counting…' : 'No breaches in this range to chart.'}
        </p>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[3fr_2fr]">
          <figure className="min-w-0">
            <figcaption className="mb-2">
              <span className="block text-small font-semibold text-fg">Peak breach hours</span>
              <span className="text-micro text-fg-muted">
                {peak ? <>Busiest: <b className="text-fg-secondary">{hourLabel(peak.hour)}</b> · {plural(peak.count, 'breach')}</> : null}
              </span>
            </figcaption>
            <div className="h-48">
              <ResponsiveContainer height="100%" width="100%">
                <BarChart barCategoryGap={2} data={hours} margin={{ top: 4, right: 4, left: -24, bottom: 0 }}>
                  <CartesianGrid {...GRID} />
                  <XAxis axisLine={false} dataKey="label" interval={2} tick={AXIS} tickLine={false} />
                  <YAxis allowDecimals={false} axisLine={false} tick={AXIS} tickLine={false} />
                  <Tooltip
                    {...TIP}
                    cursor={{ fill: 'var(--surface-muted)' }}
                    formatter={(v) => [plural(v, 'breach'), null]}
                    labelFormatter={(_, p) => (p?.[0] ? hourLabel(p[0].payload.hour) : '')}
                  />
                  <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                    {hours.map((h) => (
                      <Cell fill="var(--brand)" fillOpacity={peak && h.hour === peak.hour ? 1 : 0.45} key={h.hour} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </figure>

          <figure className="min-w-0">
            <figcaption className="mb-2">
              <span className="block text-small font-semibold text-fg">Top violated cameras</span>
              <span className="text-micro text-fg-muted">Breaches per camera</span>
            </figcaption>
            <div style={{ height: Math.max(96, topCameras.length * 30 + 8) }}>
              <ResponsiveContainer height="100%" width="100%">
                <BarChart barCategoryGap={6} data={topCameras} layout="vertical" margin={{ top: 0, right: 28, left: 0, bottom: 0 }}>
                  <XAxis allowDecimals={false} hide type="number" />
                  <YAxis axisLine={false} dataKey="name" tick={AXIS} tickLine={false} type="category" width={120} />
                  <Tooltip {...TIP} cursor={{ fill: 'var(--surface-muted)' }} formatter={(v) => [plural(v, 'breach'), null]} />
                  <Bar dataKey="count" fill="var(--brand)" radius={[0, 4, 4, 0]}>
                    <LabelList dataKey="count" fill="var(--text-secondary)" fontSize={10} position="right" />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </figure>
        </div>
      )}
    </Panel>
  );
}
