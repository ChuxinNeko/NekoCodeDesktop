import type { Seq, StorageWrite } from "../types.ts";
import type { DocumentCommitChange } from "./transaction.ts";

/** Complete table record committed without another publication copy. */
export type TableCommitChange = Extract<
	StorageWrite,
	{ readonly type: "conversation" | "entry" | "task" | "submission" }
>;

export type CommitChange = TableCommitChange | DocumentCommitChange;

/** Every immutable change from one successful Session commit. Change order is unspecified. */
export type CommitPublication = {
	readonly seq: Seq;
	readonly changes: readonly CommitChange[];
};
