import './usageDashboard.css';

import {
  BoltIcon,
  ChartBarIcon,
  ChatBubbleLeftRightIcon,
  CommandLineIcon,
} from '@heroicons/react/24/outline';
import type { DailyTokenUsage, DailyTokenUsageResult } from '@shared/openclaw/usage';
import { type CSSProperties, useState } from 'react';

import { i18nService } from '@/services/i18n';

const categories = [
  { key: 'input', label: 'usageStatsInput', color: '#34b981' },
  { key: 'output', label: 'usageStatsOutput', color: '#a78bfa' },
  { key: 'cacheRead', label: 'usageStatsCacheRead', color: '#60a5fa' },
  { key: 'cacheWrite', label: 'usageStatsCacheWrite', color: '#f5b64c' },
] as const;
const t = (key: string) => i18nService.t(key);
const accent = (color: string) => ({ '--usage-accent': color }) as CSSProperties;

function Ranking({
  title,
  rows,
  color,
  format,
}: {
  title: string;
  rows: { name: string; value: number }[];
  color: string;
  format: (value: number) => string;
}) {
  const sorted = [...rows].sort((a, b) => b.value - a.value);
  const max = Math.max(1, ...sorted.map(row => row.value));
  return (
    <section className="usage-panel" style={accent(color)}>
      <h3 className="usage-heading">{title}</h3>
      <div className="usage-ranking">
        {sorted.length ? (
          sorted.map((row, index) => (
            <div key={`${row.name}-${index}`} className="usage-rank-row">
              <span className="usage-rank-number">{String(index + 1).padStart(2, '0')}</span>
              <div className="min-w-0 flex-1">
                <div className="mb-2 flex items-start justify-between gap-3 text-xs">
                  <span className="break-all">{row.name || t('usageStatsUnknown')}</span>
                  <span className="shrink-0 font-semibold tabular-nums">{format(row.value)}</span>
                </div>
                <div className="usage-track">
                  <div style={{ width: `${(row.value / max) * 100}%` }} />
                </div>
              </div>
            </div>
          ))
        ) : (
          <p className="py-8 text-center text-xs text-secondary">{t('usageStatsEmpty')}</p>
        )}
      </div>
    </section>
  );
}

export default function UsageDashboard({
  daily,
  snapshot,
}: {
  daily: DailyTokenUsage[];
  snapshot: DailyTokenUsageResult;
}) {
  const [stacked, setStacked] = useState(true);
  const [dimension, setDimension] = useState<'byModel' | 'byProvider' | 'byAgent'>('byModel');
  const locale = i18nService.getLanguage() === 'zh' ? 'zh-CN' : 'en-US';
  const number = (value: number) => new Intl.NumberFormat(locale).format(value);
  const compact = (value: number) =>
    new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
  const total = snapshot.totalTokens ?? daily.reduce((sum, row) => sum + row.totalTokens, 0);
  const max = Math.max(1, ...daily.map(row => row.totalTokens));
  const totals = categories.map(category => ({
    ...category,
    value: daily.reduce((sum, row) => sum + row[category.key], 0),
  }));
  const classified = totals.reduce((sum, row) => sum + row.value, 0);
  const inputTotal = totals[0].value + totals[2].value + totals[3].value;
  const cacheRate = inputTotal > 0 ? `${((totals[2].value / inputTotal) * 100).toFixed(1)}%` : '—';
  const activity = snapshot.activity;
  const activeDays = daily.filter(row => row.totalTokens > 0).length;
  const peak = daily.reduce<DailyTokenUsage | undefined>(
    (best, row) => (!best || row.totalTokens > best.totalTokens ? row : best),
    undefined,
  );
  const dateLabel = (date: string) =>
    new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(
      new Date(`${date}T00:00:00`),
    );
  const tooltip = (row: DailyTokenUsage) =>
    `${row.date} · ${number(row.totalTokens)} ${t('usageStatsUnit')}\n${categories.map(category => `${t(category.label)}: ${number(row[category.key])}`).join('\n')}`;
  const metric = (value?: number) => (value === undefined ? '—' : number(value));
  const cards = [
    {
      label: 'usageStatsTotalTokens',
      value: compact(total),
      detail: `${number(total)} ${t('usageStatsUnit')}`,
      icon: ChartBarIcon,
      color: '#60a5fa',
    },
    {
      label: 'usageStatsSessions',
      value: metric(activity?.sessionCount),
      detail: `${t('usageStatsActiveDays')} · ${activeDays} / ${daily.length}`,
      icon: ChatBubbleLeftRightIcon,
      color: '#a78bfa',
    },
    {
      label: 'usageStatsToolCalls',
      value: metric(activity?.toolCalls),
      detail: `${t('usageStatsToolKinds')} · ${metric(activity?.tools.length)}`,
      icon: CommandLineIcon,
      color: '#34b981',
    },
    {
      label: 'usageStatsCacheRate',
      value: cacheRate,
      detail: t('usageStatsCacheRateHint'),
      icon: BoltIcon,
      color: '#f5b64c',
    },
  ];
  return (
    <div className="usage-dashboard">
      <div className="usage-metrics">
        {cards.map(card => (
          <section key={card.label} className="usage-metric" style={accent(card.color)}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-secondary">{t(card.label)}</span>
              <card.icon className="usage-metric-icon" />
            </div>
            <p className="usage-metric-value" title={card.detail}>
              {card.value}
            </p>
            <p className="text-xs text-secondary">{card.detail}</p>
          </section>
        ))}
      </div>
      <section className="usage-panel">
        <div className="usage-section-header">
          <div>
            <h3 className="usage-heading">{t('usageStatsTrend')}</h3>
            <p className="mt-1 text-xs text-secondary">
              {daily.length > 0 &&
                `${dateLabel(daily[0].date)} – ${dateLabel(daily[daily.length - 1].date)}`}{' '}
              · {t('usageStatsUnit')}
            </p>
          </div>
          <div className="usage-segment" aria-label={t('usageStatsTrend')}>
            {[false, true].map(value => (
              <button
                type="button"
                key={String(value)}
                aria-pressed={stacked === value}
                onClick={() => setStacked(value)}
              >
                {t(value ? 'usageStatsByType' : 'usageStatsTotalView')}
              </button>
            ))}
          </div>
        </div>
        <div className="usage-chart" role="group" aria-label={t('usageStatsChartLabel')}>
          <div className="usage-axis" aria-hidden="true">
            <span>{compact(max === 1 && total === 0 ? 0 : max)}</span>
            <span>{compact(max === 1 && total === 0 ? 0 : max / 2)}</span>
            <span>0</span>
          </div>
          <div className="usage-plot">
            <div className="usage-grid" aria-hidden="true">
              <i />
              <i />
              <i />
            </div>
            <div className="usage-bars">
              {daily.map((row, index) => (
                <div className="usage-bar-column" key={row.date}>
                  <div className="usage-bar-slot">
                    <button
                      type="button"
                      className="usage-bar"
                      aria-label={tooltip(row)}
                      title={tooltip(row)}
                      style={{
                        height: `${row.totalTokens > 0 ? Math.max(1, (row.totalTokens / max) * 100) : 0}%`,
                      }}
                    >
                      {stacked ? (
                        categories.map(category => (
                          <span
                            key={category.key}
                            style={{ background: category.color, flex: row[category.key] }}
                          />
                        ))
                      ) : (
                        <span style={{ background: 'var(--justdo-primary)', flex: 1 }} />
                      )}
                    </button>
                  </div>
                  <span className="usage-date">
                    {index % (daily.length > 14 ? 5 : daily.length > 7 ? 2 : 1) === 0 ||
                    index === daily.length - 1
                      ? `${Number(row.date.slice(5, 7))}/${Number(row.date.slice(8))}`
                      : ''}
                  </span>
                </div>
              ))}
            </div>
            {total === 0 && <p className="usage-chart-empty">{t('usageStatsEmpty')}</p>}
          </div>
        </div>
        <div className="usage-composition" aria-label={t('usageStatsComposition')}>
          <div className="usage-composition-track">
            {totals.map(row => (
              <span
                key={row.key}
                style={{
                  background: row.color,
                  width: `${classified ? (row.value / classified) * 100 : 0}%`,
                }}
              />
            ))}
          </div>
          <div className="usage-legend">
            {totals.map(row => (
              <div key={row.key}>
                <span className="usage-dot" style={{ background: row.color }} />
                <span>{t(row.label)}</span>
                <strong title={number(row.value)}>{compact(row.value)}</strong>
                <span>{classified ? ((row.value / classified) * 100).toFixed(1) : '0'}%</span>
              </div>
            ))}
          </div>
        </div>
      </section>
      <section className="usage-panel">
        <div className="usage-section-header">
          <div>
            <h3 className="usage-heading">{t('usageStatsActivityMap')}</h3>
            <p className="mt-1 text-xs text-secondary">{t('usageStatsActivityMapHint')}</p>
          </div>
          <span className="text-xs text-secondary">
            {t('usageStatsActiveDays')} <strong className="text-foreground">{activeDays}</strong>
          </span>
        </div>
        <div className="usage-heatmap">
          {daily.map(row => (
            <div
              key={row.date}
              className="usage-heat-cell"
              tabIndex={0}
              title={tooltip(row)}
              aria-label={tooltip(row)}
              style={
                {
                  '--usage-level': row.totalTokens ? 0.15 + (row.totalTokens / max) * 0.7 : 0,
                } as CSSProperties
              }
            >
              <span>{new Date(`${row.date}T00:00:00`).getDate()}</span>
            </div>
          ))}
        </div>
        <div className="usage-activity-footer">
          <span>
            {t('usageStatsDailyAverage')}{' '}
            <strong>{compact(total / Math.max(1, daily.length))}</strong>
          </span>
          <span>
            {t('usageStatsPeakDay')}{' '}
            <strong>
              {peak && peak.totalTokens > 0
                ? `${dateLabel(peak.date)} · ${compact(peak.totalTokens)}`
                : '—'}
            </strong>
          </span>
          <div className="flex items-center gap-1.5">
            <span>{t('usageStatsLess')}</span>
            {[0, 0.2, 0.45, 0.7, 0.85].map(level => (
              <i
                key={level}
                className="usage-heat-cell"
                style={{ '--usage-level': level } as CSSProperties}
              />
            ))}
            <span>{t('usageStatsMore')}</span>
          </div>
        </div>
      </section>
      {activity && (
        <>
          <div className="usage-secondary-metrics">
            {[
              ['usageStatsUserMessages', number(activity.userMessages)],
              ['usageStatsAssistantMessages', number(activity.assistantMessages)],
              ['usageStatsErrors', number(activity.errors)],
              [
                'usageStatsLatency',
                activity.averageLatencyMs === undefined
                  ? '—'
                  : `${(activity.averageLatencyMs / 1000).toFixed(2)} s`,
              ],
            ].map(([label, value]) => (
              <div key={label}>
                <p className="text-xs text-secondary">{t(label)}</p>
                <p
                  className={`mt-2 text-xl font-semibold tabular-nums ${label === 'usageStatsErrors' && activity.errors > 0 ? 'text-amber-600 dark:text-amber-300' : ''}`}
                >
                  {value}
                </p>
              </div>
            ))}
          </div>
          <div className="usage-section-header">
            <h3 className="usage-heading">{t('usageStatsDistribution')}</h3>
            <div className="usage-segment">
              {(['byModel', 'byProvider', 'byAgent'] as const).map(value => (
                <button
                  type="button"
                  key={value}
                  aria-pressed={dimension === value}
                  onClick={() => setDimension(value)}
                >
                  {t(`usageStats${value}`)}
                </button>
              ))}
            </div>
          </div>
          <div className="usage-rankings">
            <Ranking
              title={`${t(`usageStats${dimension}`)} · ${t('usageStatsUnit')}`}
              rows={activity[dimension].map(row => ({ name: row.name, value: row.totalTokens }))}
              color="#a78bfa"
              format={number}
            />
            <Ranking
              title={t('usageStatsTools')}
              rows={activity.tools.map(row => ({ name: row.name, value: row.count }))}
              color="#34b981"
              format={number}
            />
          </div>
        </>
      )}
      {snapshot.activityError && (
        <p role="status" className="text-xs text-amber-600 dark:text-amber-300">
          {t('usageStatsActivityUnavailable')}
        </p>
      )}
      {snapshot.updatedAt ? (
        <p className="text-right text-xs text-secondary">
          {t('usageStatsUpdatedAt')} · {new Date(snapshot.updatedAt).toLocaleString(locale)}
        </p>
      ) : null}
    </div>
  );
}
