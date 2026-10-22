import { Dialog } from "@base-ui/react/dialog";
import { defineComponent, useIsStreaming, useStateField } from "@openuidev/react-lang";
import { openuiLibrary as applicationLibrary, openuiChatLibrary } from "@openuidev/react-ui";
import { z } from "zod/v4";
import { useTranslation } from "../i18n";
import { useOpenLink } from "./webSources";
import { openuiWebUrl } from "./openuiActions";

const card = applicationLibrary.components.Card!;
const CardView = card.component;
const chatCard = openuiChatLibrary.components.Card!;

// Official application Card flex arguments, plus the sources array used as the
// second argument by previously saved chat cards.
export const openuiCard = defineComponent({
	name: "Card",
	description: card.description + " For old chat cards the second argument may also be a sources array.",
	props: card.props.extend({ variant: z.union([card.props.shape.variant, chatCard.props.shape.sources]) }),
	component: function CompatibleCard({ props, renderNode }) {
		const open = useOpenLink();
		const sources = Array.isArray(props.variant) ? props.variant as Array<{ title: string; url?: string }> : [];
		return <>
			<CardView props={{ ...props, variant: Array.isArray(props.variant) ? "card" : props.variant }} renderNode={renderNode} />
			{sources.length ? <ul className="flex flex-wrap gap-2 text-xs">{sources.map((source, index) => {
				const url = openuiWebUrl(source.url);
				return <li key={index}>{url ? <button type="button" className="text-primary underline" onClick={() => open(url)}>{source.title}</button> : source.title}</li>;
			})}</ul> : null}
		</>;
	},
});

const modal = applicationLibrary.components.Modal!;
export const openuiModal = defineComponent({
	name: modal.name,
	props: modal.props,
	description: modal.description,
	component: function ApplicationModal({ props, renderNode }) {
		const { t } = useTranslation();
		const field = useStateField("open", props.open);
		const streaming = useIsStreaming();
		return <Dialog.Root open={!streaming && (field.value === true || field.value === "true")} onOpenChange={value => field.setValue(value)}>
			<Dialog.Portal>
				<Dialog.Backdrop className="fixed inset-0 z-[90] bg-black/40" />
				<Dialog.Popup className="openui-response fixed left-1/2 top-1/2 z-[91] max-h-[85dvh] w-[min(48rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-xl border border-border bg-background p-4 text-foreground shadow-xl outline-none">
					<div className="mb-4 flex items-center justify-between gap-3">
						<Dialog.Title className="font-semibold">{props.title}</Dialog.Title>
						<Dialog.Close className="rounded px-2 py-1 text-sm" aria-label={t("common.close")}>×</Dialog.Close>
					</div>
					{renderNode(props.children)}
				</Dialog.Popup>
			</Dialog.Portal>
		</Dialog.Root>;
	},
});
