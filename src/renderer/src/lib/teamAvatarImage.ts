// Turning a picked file into a team member's avatar.
//
// The roster travels through preferences and is read anywhere a member is shown,
// so an avatar is stored as a `data:` URL rather than a path. Full-size photos
// would bloat that file and every read of it, so the picture is drawn onto a
// small square canvas first — centre-cropped, never stretched — and only then
// encoded. The square is then masked to a circle, matching how every avatar is
// shown, so the corners are transparent rather than hiding a visible seam. At
// 128px a PNG stays well under the roster's size cap. PNG (not JPEG) keeps that
// transparency.

/** Diameter of the circle every avatar is stored as. Enough for the largest it is drawn (30px) on a retina screen. */
const AVATAR_PIXELS = 128;
/** Reject a picture this size before decoding, so a huge file cannot stall the page. */
export const MAX_TEAM_AVATAR_SOURCE_BYTES = 12 * 1024 * 1024;

export type TeamAvatarImageErrorCode = "unsupported" | "tooLarge" | "invalid";

export class TeamAvatarImageError extends Error {
	constructor(readonly code: TeamAvatarImageErrorCode) {
		super(code);
	}
}

/**
 * Downscale a picked image file to a circular data URL. Rejects anything the
 * browser cannot decode rather than storing a broken avatar.
 */
export async function fileToAvatarImage(file: File): Promise<string> {
	if (!file.type.startsWith("image/")) throw new TeamAvatarImageError("unsupported");
	if (file.size > MAX_TEAM_AVATAR_SOURCE_BYTES) throw new TeamAvatarImageError("tooLarge");

	let bitmap: ImageBitmap;
	try {
		bitmap = await createImageBitmap(file);
	} catch {
		throw new TeamAvatarImageError("invalid");
	}

	try {
		const canvas = document.createElement("canvas");
		canvas.width = AVATAR_PIXELS;
		canvas.height = AVATAR_PIXELS;
		const context = canvas.getContext("2d");
		if (!context) throw new TeamAvatarImageError("invalid");

		// Everything outside the circle stays transparent, so the stored image is
		// round in its own right, not a square the display just happens to clip.
		context.beginPath();
		context.arc(AVATAR_PIXELS / 2, AVATAR_PIXELS / 2, AVATAR_PIXELS / 2, 0, Math.PI * 2);
		context.closePath();
		context.clip();

		// Centre-crop the shorter side into the square: a portrait or landscape
		// photo keeps its middle instead of being squashed.
		const side = Math.min(bitmap.width, bitmap.height);
		const sx = (bitmap.width - side) / 2;
		const sy = (bitmap.height - side) / 2;
		context.drawImage(bitmap, sx, sy, side, side, 0, 0, AVATAR_PIXELS, AVATAR_PIXELS);

		return canvas.toDataURL("image/png");
	} finally {
		bitmap.close();
	}
}
