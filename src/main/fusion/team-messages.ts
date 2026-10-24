import type { TeamMember } from "../../shared/team";
import type { TeamWorkspaceStore } from "../team-workspace-store";

/** A model turn can contain many messages. Only the currently streaming bubble changes. */
export class TeamMessages {
	private current?: { id: string; text: string };
	private last?: string;
	constructor(private readonly store: TeamWorkspaceStore, private readonly roomId: string, private readonly member: TeamMember, private readonly workId: string) {}
	delta(text: string): void {
		if (!text) return;
		if (!this.current) {
			const id = this.store.post({ roomId: this.roomId, memberId: this.member.id, name: this.member.name, kind: "message", text, workId: this.workId, status: "streaming" });
			this.current = { id, text };
		} else {
			this.current.text += text;
			this.store.updatePost(this.current.id, this.current.text, "streaming");
		}
	}
	message(text: string, interrupted = false): void {
		if (this.current) {
			this.store.updatePost(this.current.id, text || this.current.text, interrupted ? "failed" : "done");
			this.last = text || this.current.text;
			this.current = undefined;
		} else if (text.trim()) {
			this.store.post({ roomId: this.roomId, memberId: this.member.id, name: this.member.name, kind: "message", text, workId: this.workId, status: interrupted ? "failed" : "done" });
			this.last = text;
		}
	}
	finish(text: string): void {
		if (this.current || (text.trim() && text !== this.last)) this.message(text);
	}
	fail(): void {
		if (this.current) this.store.updatePost(this.current.id, this.current.text, "failed");
		this.current = undefined;
	}
}
