import { existsSync, lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { AppMainHost, AppResourceParticipant } from '@app-plugin/sdk/main';
import { parseCoworkSessionKey } from '../../runtime-services/contracts/session-key';

interface FlowResource {
  sessionId: string;
  unresolved: boolean;
}
/** Read only closed metadata projections from this plugin's own store, including while disabled. */
function readResources(host: AppMainHost): FlowResource[] {
  const file = path.join(host.getNativeStateDirectory(), 'flows.sqlite');
  if (!existsSync(file)) return [];
  if (lstatSync(file).isSymbolicLink() || realpathSync(file) !== file)
    throw new Error('appPluginUnavailable');
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = database
      .prepare(
        `SELECT parent_key,
      json_extract(payload, '$.status') AS state,
      (json_type(payload, '$.nodes') IS NOT 'array' OR
      EXISTS(SELECT 1 FROM json_each(json_extract(flows.payload, '$.nodes'))
        WHERE COALESCE(json_extract(value, '$.status'), '') NOT IN ('done','failed','cancelled')
          OR ((json_extract(value, '$.runId') IS NOT NULL OR json_extract(value, '$.intendedRunId') IS NOT NULL)
            AND json_extract(value, '$.cleanupSettled') IS NOT 1)) OR
      EXISTS(SELECT 1 FROM batch_items WHERE flow_id=flows.id AND
        (COALESCE(json_extract(payload, '$.status'), '') NOT IN ('done','failed','cancelled') OR
        ((json_extract(payload, '$.runId') IS NOT NULL OR json_extract(payload, '$.intendedRunId') IS NOT NULL)
          AND json_extract(payload, '$.cleanupSettled') IS NOT 1))) OR
      EXISTS(SELECT 1 FROM execution_leases WHERE flow_id=flows.id)) AS unresolved
      FROM flows`,
      )
      .all();
    return rows.flatMap(row => {
      if (typeof row.parent_key !== 'string' || typeof row.state !== 'string')
        throw new Error('appPluginUnavailable');
      const sessionId =
        host.getSessions().getSessionByNativeKey(row.parent_key)?.id ??
        parseCoworkSessionKey(row.parent_key)?.sessionId;
      if (!sessionId) return [];
      return [
        {
          sessionId,
          unresolved: !['completed', 'cancelled'].includes(row.state) || row.unresolved !== 0,
        },
      ];
    });
  } finally {
    database.close();
  }
}
export function workflowResources(host: AppMainHost): AppResourceParticipant {
  const deleting = new Map<string, number>();
  return {
    protectedResources: () => [...new Set(readResources(host).map(resource => resource.sessionId))],
    adoptResources: previous => {
      const recognized = new Set(readResources(host).map(resource => resource.sessionId));
      return previous.resourceIds.every(id => recognized.has(id));
    },
    expandResources: ids => [...ids],
    acquireDeletion: ids => {
      ids.forEach(id => deleting.set(id, (deleting.get(id) ?? 0) + 1));
      let released = false;
      return () => {
        if (released) return;
        released = true;
        ids.forEach(id => {
          const count = deleting.get(id)! - 1;
          if (count) deleting.set(id, count);
          else deleting.delete(id);
        });
      };
    },
    isDeleting: id => deleting.has(id),
    isManaged: () => false,
    prepareDelete: async ids => {
      for (const id of ids) {
        const state = await host.getExecution().getSessionRuntimeStatus(id, {
          includeSubagents: true,
          forceRefresh: true,
          fullScan: true,
        });
        if (!state.known || state.running) throw new Error('swarmWorkflowDeleteUnresolved');
      }
      if (
        readResources(host).some(
          resource => ids.includes(resource.sessionId) && resource.unresolved,
        )
      )
        throw new Error('swarmWorkflowDeleteUnresolved');
    },
    deleteManaged: async () => false,
  };
}
