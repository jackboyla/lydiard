export interface SectionTab<K extends string> {
  key: K;
  label: string;
}

/** Sticky in-page tabs that split a long view into a few short sections. */
export function SectionTabs<K extends string>({
  tabs,
  active,
  onChange,
  ariaLabel,
}: {
  tabs: ReadonlyArray<SectionTab<K>>;
  active: K;
  onChange: (next: K) => void;
  ariaLabel: string;
}) {
  return (
    <div className="section-tabs" role="tablist" aria-label={ariaLabel}>
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          role="tab"
          aria-selected={active === tab.key}
          className={active === tab.key ? 'active' : ''}
          onClick={() => onChange(tab.key)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

/** Reads the initial section from `?tab=`, so a section can be linked directly. */
export function tabFromLocation<K extends string>(tabs: ReadonlyArray<SectionTab<K>>, fallback: K): K {
  const value = new URLSearchParams(window.location.search).get('tab');
  return tabs.find((tab) => tab.key === value)?.key ?? fallback;
}

/** Records the section in the URL without adding a history entry for every tap. */
export function replaceTabInLocation(tab: string) {
  const url = new URL(window.location.href);
  url.searchParams.set('tab', tab);
  window.history.replaceState(window.history.state, '', url);
}
