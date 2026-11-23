import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowUp, Lightbulb, Printer } from 'lucide-react';
import clsx from 'clsx';
import { useAuth } from '@/lib/auth';
import { GUIDE, type HelpSection } from '@/help/guide.ar';
import { Button, Card, Checkbox, EmptyState, PageHeader, SearchInput } from '@/components/ui';

const norm = (s: string) => s.replace(/[إأآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').toLowerCase();

export default function Help() {
  const { t } = useTranslation();
  const { canAny } = useAuth();
  const { hash } = useLocation();
  const [q, setQ] = useState('');
  const [showAll, setShowAll] = useState(false);
  const target = hash.slice(1);

  const relevant = (s: HelpSection) => !s.any || canAny(...s.any);
  // A section linked directly (e.g. from the "?" button) is always shown.
  const sections = useMemo(() => {
    const base = GUIDE.filter((s) => showAll || relevant(s) || s.id === target);
    if (!q.trim()) return base;
    const n = norm(q.trim());
    return base
      .map((s) => ({ ...s, topics: s.topics.filter((tp) => norm([s.title, tp.title, tp.text ?? '', ...(tp.steps ?? []), ...(tp.tips ?? [])].join(' ')).includes(n)) }))
      .filter((s) => s.topics.length);
  }, [q, showAll, target]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!target) return;
    const id = setTimeout(() => document.getElementById(target)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
    return () => clearTimeout(id);
  }, [target]);

  const go = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  return (
    <div>
      <PageHeader
        title={t('help.title')}
        subtitle={t('help.subtitle')}
        actions={<Button variant="outline" icon={<Printer className="h-4 w-4" />} onClick={() => window.print()}>{t('help.print')}</Button>}
      />
      <div className="mb-4 flex flex-wrap items-center gap-3 print:hidden">
        <SearchInput value={q} onChange={setQ} placeholder={t('help.search')} className="w-full sm:w-96" delay={150} />
        <Checkbox label={t('help.showAll')} checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
      </div>
      <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
        <aside className="print:hidden">
          <Card className="lg:sticky lg:top-20">
            <p className="mb-2 text-xs font-bold text-ink-muted">{showAll ? t('help.contents') : t('help.forYou')}</p>
            <nav className="space-y-0.5">
              {sections.map((s) => (
                <button key={s.id} onClick={() => go(s.id)} className={clsx('block w-full rounded-lg px-2.5 py-1.5 text-start text-sm hover:bg-primary-50', s.id === target ? 'bg-primary-50 font-semibold text-primary-800' : 'text-ink-soft')}>
                  {s.title}
                </button>
              ))}
            </nav>
          </Card>
        </aside>
        <div className="space-y-4">
          {!sections.length && <Card><EmptyState title={t('help.noResults')} /></Card>}
          {sections.map((s) => (
            <section key={s.id} id={s.id} className="scroll-mt-20">
              <Card className={clsx(s.id === target && 'ring-2 ring-primary-200')}>
                <h2 className="text-lg font-bold text-ink">{s.title}</h2>
                <p className="mb-4 text-sm text-ink-muted">{s.summary}</p>
                <div className="space-y-5">
                  {s.topics.map((tp) => (
                    <div key={tp.title} className="border-s-2 border-primary-200 ps-4" style={{ breakInside: 'avoid' }}>
                      <h3 className="mb-1.5 font-bold text-primary-800">{tp.title}</h3>
                      {tp.text && <p className="text-sm leading-relaxed text-ink-soft">{tp.text}</p>}
                      {tp.steps && (
                        <ol className="space-y-1.5">
                          {tp.steps.map((st, i) => (
                            <li key={i} className="flex gap-2.5 text-sm leading-relaxed text-ink">
                              <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-primary-100 text-[11px] font-bold text-primary-800">{i + 1}</span>
                              <span>{st}</span>
                            </li>
                          ))}
                        </ol>
                      )}
                      {tp.tips && (
                        <div className="mt-2 rounded-xl bg-warning-50 px-3 py-2">
                          {tp.tips.map((tip, i) => (
                            <p key={i} className="flex gap-1.5 text-xs leading-relaxed text-warning-700"><Lightbulb className="mt-0.5 h-3.5 w-3.5 shrink-0" />{tip}</p>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </Card>
            </section>
          ))}
          {sections.length > 2 && (
            <div className="flex justify-center print:hidden">
              <Button variant="ghost" size="sm" icon={<ArrowUp className="h-4 w-4" />} onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>{t('help.backToTop')}</Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
