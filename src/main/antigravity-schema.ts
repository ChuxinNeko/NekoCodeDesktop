/** Port of CLIProxyAPI internal/util/gemini_schema.go for function schemas. */
type Schema = Record<string, unknown>;
const object = (value: unknown): value is Schema => typeof value === "object" && value !== null && !Array.isArray(value);
const constraints = ["minLength", "maxLength", "exclusiveMinimum", "exclusiveMaximum", "pattern", "minItems", "maxItems", "uniqueItems", "contains", "format", "default", "examples", "minimum", "maximum", "multipleOf"];
const unsupported = new Set([...constraints, "$schema", "$defs", "definitions", "const", "$ref", "$id", "id", "additionalProperties", "$anchor", "$vocabulary", "$dynamicRef", "$dynamicAnchor", "propertyNames", "patternProperties", "if", "then", "else", "$comment", "enumDescriptions", "enumTitles", "prefill", "deprecated", "encrypted", "not"]);
function hint(node: Schema, text: string): void {
	const description = typeof node.description === "string" ? node.description : "";
	if (description === text || description.startsWith(`${text} (`) || description.includes(`(${text})`)) return;
	node.description = description ? `${description} (${text})` : text;
}
function mergeMissing(target: Schema, source: Schema): void {
	for (const [key, value] of Object.entries(source)) {
		if (!Object.hasOwn(target, key)) target[key] = structuredClone(value);
		else if (object(target[key]) && object(value)) mergeMissing(target[key], value);
	}
}

/** Only accepts a schema, never a request or tool argument object. */
export function cleanAntigravityToolSchema(input: unknown, placeholder: boolean): Schema {
	if (!object(input)) throw new Error("Antigravity requires an object tool schema");
	const root = structuredClone(input);
	const visit = (value: unknown, active: Set<string>, depth: number): Schema => {
		if (depth > 64) throw new Error("Antigravity tool schema is too deeply nested");
		let node: Schema = object(value) ? structuredClone(value) : {};
		if (typeof node.$ref === "string") {
			const ref = node.$ref;
			let target: unknown = root;
			if (ref.startsWith("#/")) {
				for (const part of ref.slice(2).split("/").map((v) => v.replace(/~1/g, "/").replace(/~0/g, "~"))) {
					target = object(target) && Object.hasOwn(target, part) ? target[part] : undefined;
				}
			} else target = undefined;
			delete node.$ref;
			if (object(target) && !active.has(ref)) {
				const next = new Set(active).add(ref);
				node = { ...visit(target, next, depth + 1), ...node };
			} else {
				if (object(target)) for (const key of ["type", "nullable", "description"]) if (!(key in node) && key in target) node[key] = target[key];
				hint(node, `See: ${ref.split("/").at(-1)?.replace(/~1/g, "/").replace(/~0/g, "~")}`);
			}
		}
		// MCP schemas sometimes supply a bare property map.
		if (Object.keys(node).length > 0 && Object.entries(node).every(([key, val]) => !unsupported.has(key) && !["type", "properties", "items", "required", "description", "enum", "allOf", "anyOf", "oneOf", "nullable", "title"].includes(key) && !key.startsWith("x-") && object(val))) {
			node = { type: "object", properties: node };
		}
		if (Object.hasOwn(node, "const")) node.enum = [node.const];
		if (Array.isArray(node.enum)) {
			const values = node.enum.map((v) => v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
			if (values.length > 0 && values.length <= 10) hint(node, `Allowed: ${values.join(", ")}`);
			delete node.enum;
		}
		if (node.additionalProperties === false) hint(node, "No extra properties allowed");
		for (const key of constraints) if (key in node) hint(node, `${key}: ${typeof node[key] === "object" ? JSON.stringify(node[key]) : String(node[key])}`);
		if ("not" in node) hint(node, `not: ${JSON.stringify(node.not)}`);
		for (const key of ["then", "else"]) {
			if (object(node[key]) && object(node[key].properties)) {
				node.properties ??= {};
				if (object(node.properties)) for (const [name, schema] of Object.entries(node[key].properties)) if (!Object.hasOwn(node.properties, name)) node.properties[name] = schema;
			}
		}
		if (Array.isArray(node.allOf)) {
			for (const branch of node.allOf) {
				const cleaned = visit(branch, active, depth + 1);
				if (Array.isArray(cleaned.required)) node.required = [...new Set([...(Array.isArray(node.required) ? node.required : []), ...cleaned.required])];
				delete cleaned.required;
				mergeMissing(node, cleaned);
			}
			delete node.allOf;
		}
		for (const key of ["anyOf", "oneOf"]) {
			if (!Array.isArray(node[key]) || node[key].length === 0) continue;
			const branches = node[key].map((v) => visit(v, active, depth + 1));
			const nullable = branches.some((v) => v.type === "null");
			if (object(node.properties)) {
				for (const branch of branches) if (object(branch.properties)) mergeMissing(node.properties, branch.properties);
				delete node[key];
			} else {
				const score = (v: Schema) => v.type === "object" || v.properties ? 3 : v.type === "array" || v.items ? 2 : v.type && v.type !== "null" ? 1 : 0;
				const selected = branches.reduce((best, v) => score(v) > score(best) ? v : best);
				if (typeof node.description === "string") selected.description = selected.description ? `${node.description}\n${selected.description}` : node.description;
				node = selected;
				const types = branches.map((v) => v.type || (v.properties ? "object" : v.items ? "array" : "")).filter(Boolean);
				if (types.length > 1) hint(node, `Accepts: ${types.join(" | ")}`);
			}
			if (nullable && node.type !== "null") node.nullable = true;
		}
		if (Array.isArray(node.type)) {
			const types = node.type.filter((v) => typeof v === "string" && v !== "null");
			const nullable = node.type.includes("null");
			node.type = types[0] ?? "string";
			if (types.length > 1) hint(node, `Accepts: ${types.join(" | ")}`);
			if (nullable) { node.nullable = true; hint(node, "(nullable)"); }
		}
		const promoted: string[] = [];
		if (object(node.properties)) {
			node.type ??= "object";
			const properties: Schema = Object.create(null);
			for (const [name, prop] of Object.entries(node.properties)) {
				if (object(prop) && prop.required === true) promoted.push(name);
				properties[name] = visit(prop, active, depth + 1);
			}
			node.properties = properties;
		}
		if (node.type === "array") node.items = visit(node.items ?? { type: "string" }, active, depth + 1);
		for (const key of Object.keys(node)) if (unsupported.has(key) || key.startsWith("x-") || (key === "title" && !placeholder)) delete node[key];
		const required = [...new Set([...(Array.isArray(node.required) ? node.required : []), ...promoted])].filter((key) => typeof key === "string" && object(node.properties) && Object.hasOwn(node.properties, key));
		if (required.length) node.required = required; else delete node.required;
		if (placeholder && node.type === "object") {
			if (!object(node.properties) || !Object.keys(node.properties).length) {
				node.properties = { reason: { type: "string", description: "Brief explanation of why you are calling this tool" } };
				node.required = ["reason"];
			} else if (!required.length) {
				node.properties._ ??= { type: "boolean" }; node.required = ["_"];
			}
		}
		return node;
	};
	return visit(root, new Set(), 0);
}

/**
 * Remove only schema fields synthesized for VALIDATED mode before PI validates
 * arguments. Keep original/user-defined `_` and `reason` properties. The raw
 * provider arguments remain in replay metadata, preserving signed wire history.
 */
export function restoreAntigravityToolArguments(input: Record<string, unknown>, schema: unknown, placeholder: boolean): Record<string, unknown> {
	const args = structuredClone(input);
	if (!placeholder) return args;
	const wireSchema = cleanAntigravityToolSchema(schema, true);
	const originalSchema = cleanAntigravityToolSchema(schema, false);
	const visit = (value: unknown, wire: Schema, original: Schema): void => {
		if (Array.isArray(value)) {
			if (object(wire.items)) for (const item of value) visit(item, wire.items, object(original.items) ? original.items : {});
			return;
		}
		if (!object(value) || !object(wire.properties)) return;
		const properties = object(original.properties) ? original.properties : {};
		for (const [key, property] of Object.entries(wire.properties)) {
			if (!Object.hasOwn(value, key) || !object(property)) continue;
			if (!Object.hasOwn(properties, key) && ((key === "_" && property.type === "boolean") ||
				(key === "reason" && property.type === "string" && property.description === "Brief explanation of why you are calling this tool"))) {
				delete value[key];
			} else visit(value[key], property, object(properties[key]) ? properties[key] : {});
		}
	};
	visit(args, wireSchema, originalSchema);
	return args;
}
