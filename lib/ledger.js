/**
 * Durable per-session storage for the request-timing ledger.
 *
 * The records are derived data about one conversation, so they are stored the
 * way the session itself is: one document per session, in the deployment's
 * storage backend, still there after a restart. The domain is declared
 * `per-record` because a session's ledger is bulky, sparse, and individually
 * disposable — the storage layer then scopes its version check per record, and a
 * record it can no longer read is discarded rather than failing the open.
 *
 * Storage is optional. A deployment without it keeps records in memory only,
 * which is exactly what this plugin did before, so nothing here is load-bearing.
 *
 * @module dsh-plugin-model-request-accelerator/ledger
 */

import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import { z } from "zod";

/** One timing row as the panel receives it. Fields this does not know are kept. */
const rowSchema = z
	.object({
		id: z.number(),
		provider: z.string().nullable(),
		model: z.string().nullable(),
		totalMs: z.number().nullable()
	})
	.catchall(z.unknown());

/** One session's ledger: its rows, and when they last changed. */
const recordSchema = z.object({
	updatedAt: z.number(),
	rows: z.array(rowSchema)
});

/** The domain declaration; its name doubles as the backend unit name. */
const spec = defineDomain({
	name: "model_request_timings",
	version: 1,
	layout: "per-record",
	// A row that no longer validates is derived data, not a reason to refuse to
	// open — the storage layer moves its document aside and carries on.
	invalidRecords: "backup-and-skip",
	tables: { sessions: domainTable(recordSchema) }
});

/**
 * Open the timing ledger, or return `undefined` when this deployment has no
 * storage backend or no domain layer.
 * @param storage - the storage hub, when the profile has one.
 * @param log - optional warning sink for an open that fails.
 * @returns the ledger, or `undefined` to run in memory only.
 */
export async function openLedger(storage, log) {
	if (storage === undefined || storage === null) return undefined;
	let facility;
	try {
		facility = storage.domain;
	} catch {
		return undefined;
	}
	if (facility === undefined || facility === null || typeof facility.open !== "function") return undefined;
	let domain;
	let sessions;
	try {
		domain = await facility.open(spec);
		// Tables are resolved by name, not as properties of the handle — and this
		// can throw too, so it belongs inside the guard: an unusable store has to
		// leave the plugin in memory-only mode rather than rejecting into nowhere.
		sessions = domain.table("sessions");
	} catch (error) {
		log?.("model-request-accelerator: no durable timing store; keeping the ledger in memory");
		log?.(error);
		return undefined;
	}
	return {
		/**
		 * The stored rows for one session.
		 * @param sessionId - the session key.
		 * @returns the rows, or an empty array when nothing is stored.
		 */
		read(sessionId) {
			const record = sessions.get(sessionId);
			return record === undefined ? [] : record.rows;
		},
		/**
		 * Store one session's rows.
		 * @param sessionId - the session key.
		 * @param rows - the complete row list for that session.
		 */
		async write(sessionId, rows) {
			await sessions.put(sessionId, { updatedAt: Date.now(), rows });
		},
		/** Release the domain. */
		close() {
			return domain.close();
		}
	};
}
