import { useEffect, useMemo } from "react";
import { defineComponent, parseStructuredRules, useFormValidation, useIsStreaming, useStateField } from "@openuidev/react-lang";
import { openuiChatLibrary } from "@openuidev/react-ui";

const upstream = openuiChatLibrary.components.Select!;

// Preserve the official Lang signature and form state contract, but use a native
// select. Generated reply cards do not need a document-wide modal, scroll lock,
// or continuously positioned portal just to choose a field value.
export const openuiNativeSelect = defineComponent({
	name: upstream.name,
	description: upstream.description,
	props: upstream.props,
	component: function NativeSelect({ props }) {
		const streaming = useIsStreaming();
		const validation = useFormValidation();
		const field = useStateField(props.name, props.value);
		const rules = useMemo(() => parseStructuredRules(props.rules), [props.rules]);
		const hasRules = rules.length > 0;
		const items = (props.items ?? []) as Array<{ props?: { value: string; label?: string } }>;

		useEffect(() => {
			if (streaming || !hasRules || !validation) return;
			validation.registerField(field.name, rules, () => field.value);
			return () => validation.unregisterField(field.name);
		}, [field.name, field.value, validation, hasRules, streaming, rules]);

		return <select
			id={field.name}
			name={field.name}
			className="openui-native-select"
			data-size={props.size ?? "medium"}
			value={String(field.value ?? "")}
			disabled={streaming}
			aria-invalid={!!validation?.errors[field.name]}
			onChange={event => {
				const value = event.currentTarget.value;
				field.setValue(value);
				if (hasRules) validation?.validateField(field.name, value, rules);
			}}
		>
			<option value="" disabled hidden>{props.placeholder || "Select…"}</option>
			{items.filter(item => item?.props?.value).map((item, index) =>
				<option key={index} value={item.props!.value}>{item.props!.label || item.props!.value}</option>)}
		</select>;
	},
});
