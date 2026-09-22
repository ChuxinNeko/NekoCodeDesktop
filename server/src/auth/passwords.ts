/**
 * Password storage.
 *
 * Argon2id through Bun's built-in, rather than bcrypt: it is memory-hard, so a
 * GPU farm gains far less against it, and it needs no native module to install.
 * The cost parameters are Bun's defaults, which target roughly the OWASP
 * recommendation.
 */

/** Long enough to matter, short enough that a passphrase still fits. */
export const MIN_PASSWORD_LENGTH = 8;
/**
 * Argon2 will happily hash a megabyte and spend the CPU doing it, which is a
 * free denial of service for anyone who can reach the register endpoint.
 */
export const MAX_PASSWORD_LENGTH = 256;

export function passwordProblem(password: string): string | null {
	if (password.length < MIN_PASSWORD_LENGTH) return `密码至少需要 ${String(MIN_PASSWORD_LENGTH)} 位`;
	if (password.length > MAX_PASSWORD_LENGTH) return "密码过长";
	// Not a character-class policy: length is what actually helps, and forcing
	// symbols mostly produces `Password1!`.
	if (/^\d+$/.test(password)) return "密码不能全是数字";
	return null;
}

export function hashPassword(password: string): Promise<string> {
	return Bun.password.hash(password, { algorithm: "argon2id" });
}

/**
 * Check a password against a stored hash.
 *
 * Never throws: a malformed hash in the database would otherwise turn a wrong
 * password into a 500 and tell an attacker which accounts are corrupt.
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
	try {
		return await Bun.password.verify(password, hash);
	} catch {
		return false;
	}
}
