"use client";

import { useEffect, useRef } from "react";

import { cn } from "~/lib/utils";

type OtpInputProps = {
	value: string;
	onChange: (value: string) => void;
	length?: number;
	disabled?: boolean;
	/** Shows the destructive ring while true. */
	invalid?: boolean;
	/** Bump this number to replay the shake animation for a new failure. */
	invalidNonce?: number;
	autoFocus?: boolean;
	onComplete?: (value: string) => void;
	"aria-label"?: string;
};

// Digit-box verification input in the style of ObsidianUI's OTP Input. Unlike
// the source component it is fully controlled and correctness is decided by
// the caller (the backend verifies the code), so instead of `correctOTP` it
// takes `invalid`/`invalidNonce` for the error ring and shake.
function OtpInput({
	value,
	onChange,
	length = 6,
	disabled = false,
	invalid = false,
	invalidNonce = 0,
	autoFocus = false,
	onComplete,
	"aria-label": ariaLabel,
}: OtpInputProps) {
	const inputs = useRef<Array<HTMLInputElement | null>>([]);
	// Entrance animation plays only for the first mount; later remounts of the
	// digit row (a bumped `invalidNonce` key replaying the shake) skip it.
	const entered = useRef(false);

	useEffect(() => {
		entered.current = true;
	}, []);

	useEffect(() => {
		if (autoFocus) inputs.current[0]?.focus();
	}, [autoFocus]);

	useEffect(() => {
		if (invalidNonce > 0) inputs.current[0]?.focus();
	}, [invalidNonce]);

	const digits = Array.from({ length }, (_, index) => value[index] ?? "");

	const emit = (next: string[]) => {
		const joined = next.join("");
		onChange(joined);
		if (joined.length === length) onComplete?.(joined);
	};

	const enterDigits = (raw: string, index: number) => {
		const enteredDigits = raw.replace(/\D/g, "").slice(0, length - index);
		const next = digits.slice();
		if (!enteredDigits) {
			next[index] = "";
		} else {
			enteredDigits.split("").forEach((digit, offset) => {
				next[index + offset] = digit;
			});
		}
		emit(next);
		if (enteredDigits) {
			inputs.current[Math.min(index + enteredDigits.length, length - 1)]?.focus();
		}
	};

	return (
		<div aria-label={ariaLabel} className="flex items-center justify-center" role="group">
			<div
				key={invalidNonce}
				className={cn("flex items-center justify-center gap-2", invalid && "motion-safe:animate-otp-shake")}
			>
				{digits.map((digit, index) => (
					<div
						key={index}
						style={entered.current ? undefined : { animationDelay: `${index * 40}ms` }}
						className={cn(
							"h-11 w-9 overflow-hidden rounded-lg bg-muted ring-2 ring-transparent transition-shadow",
							"focus-within:ring-ring",
							!entered.current && "motion-safe:animate-otp-enter",
							invalid && "ring-destructive",
							disabled && "opacity-50",
						)}
					>
						<input
							ref={(input) => {
								inputs.current[index] = input;
							}}
							aria-invalid={invalid || undefined}
							aria-label={`Digit ${index + 1} of ${length}`}
							autoComplete={index === 0 ? "one-time-code" : "off"}
							className="h-full w-full border-none bg-transparent text-center font-mono text-base text-foreground outline-none"
							disabled={disabled}
							inputMode="numeric"
							pattern="[0-9]*"
							value={digit}
							onChange={(event) => enterDigits(event.target.value, index)}
							onFocus={(event) => event.target.select()}
							onKeyDown={(event) => {
								if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
									event.preventDefault();
									const offset = event.key === "ArrowLeft" ? -1 : 1;
									inputs.current[Math.max(0, Math.min(length - 1, index + offset))]?.focus();
								} else if (event.key === "Backspace") {
									event.preventDefault();
									const target = digits[index] ? index : Math.max(0, index - 1);
									const next = digits.slice();
									next[target] = "";
									emit(next);
									inputs.current[target]?.focus();
								}
							}}
							onPaste={(event) => {
								event.preventDefault();
								enterDigits(event.clipboardData.getData("text"), index);
							}}
						/>
					</div>
				))}
			</div>
		</div>
	);
}

export { OtpInput, type OtpInputProps };
