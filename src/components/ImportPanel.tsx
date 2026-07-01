import { AlertTriangle, CheckCircle2, FileText, Link2, RefreshCw, Trash2, Upload } from 'lucide-react';
import type { ImportedTrainingData } from '../data/importActivities';
import type { StravaStatus } from '../data/stravaApi';

interface ImportPanelProps {
  importedTraining: ImportedTrainingData | null;
  importError: string;
  stravaStatus: StravaStatus | null;
  isSyncingStrava: boolean;
  onImportClick: () => void;
  onConnectStrava: () => void;
  onSyncStrava: () => void;
  onDisconnectStrava: () => void;
  onClear: () => void;
}

export function ImportPanel({
  importedTraining,
  importError,
  stravaStatus,
  isSyncingStrava,
  onImportClick,
  onConnectStrava,
  onSyncStrava,
  onDisconnectStrava,
  onClear,
}: ImportPanelProps) {
  const usingImportedData = Boolean(importedTraining);
  const canUseStrava = Boolean(stravaStatus?.configured);
  const isConnected = Boolean(stravaStatus?.connected);

  return (
    <section className={`import-panel ${usingImportedData ? 'ready' : 'sample'}`} aria-labelledby="import-heading">
      <div className="import-copy">
        <span className="panel-title">
          {usingImportedData ? <CheckCircle2 size={18} aria-hidden="true" /> : <FileText size={18} aria-hidden="true" />}
          <span>Training data</span>
        </span>
        <h2 id="import-heading">{usingImportedData ? importedTraining?.fileName : 'Sample data loaded'}</h2>
        <dl>
          <div>
            <dt>Runs</dt>
            <dd>{importedTraining?.runCount ?? '18 sample weeks'}</dd>
          </div>
          <div>
            <dt>Weeks</dt>
            <dd>{importedTraining?.weekCount ?? 'Demo'}</dd>
          </div>
          <div>
            <dt>Range</dt>
            <dd>{importedTraining?.dateRangeLabel ?? 'Synthetic'}</dd>
          </div>
        </dl>
        {importError ? (
          <p className="import-error" role="alert">
            <AlertTriangle size={16} aria-hidden="true" />
            {importError}
          </p>
        ) : null}
        {importedTraining?.warnings.length ? (
          <p className="import-warning">{importedTraining.warnings[0]}</p>
        ) : null}
        {!canUseStrava ? (
          <p className="import-warning">Add Strava credentials to `.env` and run `npm run server` to enable login.</p>
        ) : isConnected ? (
          <p className="import-warning">Strava connected{stravaStatus?.athlete?.firstname ? ` as ${stravaStatus.athlete.firstname}` : ''}.</p>
        ) : null}
      </div>

      <div className="import-actions">
        {isConnected ? (
          <button className="primary-action" type="button" onClick={onSyncStrava} disabled={isSyncingStrava}>
            <RefreshCw size={18} aria-hidden="true" />
            {isSyncingStrava ? 'Syncing' : 'Sync Strava'}
          </button>
        ) : (
          <button className="primary-action" type="button" onClick={onConnectStrava} disabled={!canUseStrava}>
            <Link2 size={18} aria-hidden="true" />
            Connect Strava
          </button>
        )}
        <button className="primary-action" type="button" onClick={onImportClick}>
          <Upload size={18} aria-hidden="true" />
          Import CSV
        </button>
        {usingImportedData ? (
          <button className="secondary-action" type="button" onClick={onClear}>
            <Trash2 size={18} aria-hidden="true" />
            Use sample
          </button>
        ) : null}
        {isConnected ? (
          <button className="secondary-action" type="button" onClick={onDisconnectStrava}>
            <Trash2 size={18} aria-hidden="true" />
            Disconnect
          </button>
        ) : null}
      </div>
    </section>
  );
}
