import { IconButton, Tooltip, CustomTooltipTrigger } from '@capra/core';
import { Git, ArrowUpRightFromSquare, InfoOutlined } from '@capra/icons';
import { criblCommitDeployPath } from '../lib/criblLinks';
import type { GroupProductFilter } from '../lib/types';
import { GROUP_NOUN } from '../lib/productTerms';
import './CommitDeployStatus.css';

interface CommitDeployStatusProps {
  /** Real, uncommitted configuration changes across whatever Worker Group(s) are in scope. */
  pendingCommits: number;
  /** How many in-scope groups have a committed configuration that isn't deployed yet. */
  pendingDeployGroups: number;
  /** The one real Worker Group to send the redirect icon to — `undefined` under "All Worker
   *  Groups" (no single group to name in the URL), which hides the icon rather than guessing one. */
  redirectGroupId: string | undefined;
  /** Which real Cribl URL shape `redirectGroupId` needs — Stream and Edge groups live under
   *  completely different Leader UI path prefixes (see `criblCommitDeployPath`'s own doc comment).
   *  Always the top-left toggle's own current product, since `redirectGroupId` is only ever a
   *  group from that same product-filtered scope. */
  redirectProduct: GroupProductFilter;
}

/**
 * One combined status tag, styled like the Signal Path Route rules' own "Final" tag (a sharp-
 * cornered rectangle with a real border/fill, not a pill) — success/danger instead of accent,
 * since this is a real pending-vs-clean signal. Sized to match the rest of the top bar
 * (`dimension.component.md`, same as `.pill-select`/`.segmented`). Always shown with its real
 * combined count, including at zero (green *is* the "nothing pending" state, not something to
 * hide). The label itself is purely for visibility (`role="status"`, plain `title` hover text, no
 * button semantics) — the real interactive part is the redirect icon nested inside the same box,
 * matching the Signal Path card's own "open in Cribl" icon exactly (same icon, same
 * `Tooltip`+`IconButton`, same `window.open(..., '_blank', 'noopener,noreferrer')`). Reused as-is
 * by every page via `PageHeader.tsx`, which computes the two counts from
 * `state.workerGroups`/`selectedGroupId`.
 */
export function CommitDeployStatus({ pendingCommits, pendingDeployGroups, redirectGroupId, redirectProduct }: CommitDeployStatusProps) {
  const total = pendingCommits + pendingDeployGroups;
  const clean = total === 0;
  const detail = clean
    ? 'No uncommitted configuration changes, and every group is fully deployed.'
    : [
        pendingCommits > 0 ? `${pendingCommits} uncommitted configuration change${pendingCommits === 1 ? '' : 's'}` : undefined,
        pendingDeployGroups > 0
          ? `${pendingDeployGroups} ${GROUP_NOUN[redirectProduct]}${pendingDeployGroups === 1 ? '' : 's'} with committed changes not yet deployed`
          : undefined,
      ]
        .filter(Boolean)
        .join('; ');

  return (
    <div className="commit-deploy-group">
      <Tooltip
        title="For flow accuracy and correct source attribution, please ensure there are no Commit & Deploy items pending. After the changes are deployed, please wait for the data flow to start and refresh the page if the changes are not visible. After changes are applied, use a shorter time window to see only the latest flow related information"
        placement="bottom"
      >
        <CustomTooltipTrigger>
          <button type="button" className="commit-deploy-info" aria-label="Why Commit & Deploy status matters for flow accuracy">
            <InfoOutlined />
          </button>
        </CustomTooltipTrigger>
      </Tooltip>
      <div className={clean ? 'commit-deploy-tag commit-deploy-tag--ok' : 'commit-deploy-tag commit-deploy-tag--pending'}>
        <span className="commit-deploy-label" role="status" title={detail}>
          <Git aria-hidden="true" />
          Pending Commit &amp; Deploy ({total})
        </span>
        {redirectGroupId && (
          <Tooltip title="Review in Cribl" placement="bottom">
            <IconButton
              icon={ArrowUpRightFromSquare}
              aria-label="Review pending commits and deploys in Cribl"
              size="sm"
              variant="tertiary"
              FORCE__className="commit-deploy-redirect"
              onClick={() => window.open(criblCommitDeployPath(redirectGroupId, redirectProduct), '_blank', 'noopener,noreferrer')}
            />
          </Tooltip>
        )}
      </div>
    </div>
  );
}
