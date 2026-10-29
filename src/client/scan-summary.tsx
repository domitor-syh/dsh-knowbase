import * as React from 'react'
import type { ScanReport } from '../core/service.ts'
import { uiLanguage } from './ui-locale.ts'
import { useCitationText } from './citation-locale.ts'

/** Read-only presentation of the service's last committed scan snapshot. */
export function ScanSummary({ report }: { report?: ScanReport }): React.ReactElement {
  const t = useCitationText()
  const counts = report === undefined ? [] : [
    [t('scanScanned'), report.scanned], [t('scanAdded'), report.added],
    [t('scanReused'), report.reused], [t('scanChanged'), report.changed],
    [t('scanDeleted'), report.deleted], [t('scanRebuilt'), report.rebuilt],
    [t('scanSkipped'), report.skipped], [t('scanUnsearchable'), report.unsearchable],
  ] as const
  return <section className="kb-scan-summary" data-kb-scan-report aria-label={t('scanTitle')}>
    <strong>{t('scanTitle')}</strong>
    {report === undefined ? <p>{t('scanNone')}</p> : <>
      <p style={{ margin: '6px 0', color: 'var(--dsw-alias-label-secondary)' }}>
        {report.mode === 'force' ? t('scanForce') : t('scanIncremental')} · {t('scanTime')}: {new Date(report.completedAt).toLocaleString(uiLanguage() === 'en' ? 'en-US' : 'zh-CN')} · {t('scanDuration')}: {Math.round(report.elapsedMs)} ms
      </p>
      <dl style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 18px', margin: '8px 0' }}>
        {counts.map(([label, value]) => <div key={label} style={{ display: 'flex', gap: 6 }}>
          <dt style={{ color: 'var(--dsw-alias-label-secondary)' }}>{label}</dt><dd style={{ margin: 0 }}>{value}</dd>
        </div>)}
      </dl>
      <p style={{ margin: '6px 0', color: 'var(--dsw-alias-label-secondary)' }}>{t('scanHelp')}</p>
    </>}
    <p style={{ margin: '6px 0 0', color: 'var(--dsw-alias-label-secondary)' }}>{t('scanRuntime')}</p>
  </section>
}
