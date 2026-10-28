// Turning a picked file into a team member's avatar.
//
// The roster travels through preferences and is read anywhere a member is shown,
// so an avatar is stored as a `data:` URL rather than a path. Full-size photos
// would bloat that file and every read of it, so the picture is drawn onto a
// small square canvas first — cropped to the selected region, never stretched — and only then
// encoded. The square is then masked to a circle, matching how every avatar is
// shown, so the corners are transparent rather than hiding a visible seam. At
// 128px a PNG stays well under the roster's size cap. PNG (not JPEG) keeps that
// transparency.

/** Diameter of the circle every avatar is stored as. Enough for the largest it is drawn (60px) on a retina screen. */
const AVATAR_PIXELS = 128;
/** Reject a picture this size before decoding, so a huge file cannot stall the page. */
export const MAX_TEAM_AVATAR_SOURCE_BYTES = 12 * 1024 * 1024;

export type TeamAvatarImageErrorCode = "unsupported" | "tooLarge" | "invalid";

export class TeamAvatarImageError extends Error {
	constructor(readonly code: TeamAvatarImageErrorCode) {
		super(code);
	}
}

export interface AvatarCrop { x: number; y: number; zoom: number }
export const DEFAULT_AVATAR_CROP: AvatarCrop = { x: 0.5, y: 0.5, zoom: 1 };
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Source-pixel rectangle shared by the preview and the saved PNG. */
export function avatarCropRect(width: number, height: number, crop: AvatarCrop) {
	const side = Math.min(width, height) / clamp(crop.zoom, 1, 4);
	return { x: clamp(crop.x * width - side / 2, 0, width - side), y: clamp(crop.y * height - side / 2, 0, height - side), side };
}

/** Dragging moves the picture, so the source rectangle moves in the opposite direction. */
export function moveAvatarCrop(width: number, height: number, crop: AvatarCrop, dx: number, dy: number, viewport: number): AvatarCrop {
	const rect = avatarCropRect(width, height, crop);
	const x = clamp(rect.x - dx * rect.side / viewport, 0, width - rect.side);
	const y = clamp(rect.y - dy * rect.side / viewport, 0, height - rect.side);
	return { x: (x + rect.side / 2) / width, y: (y + rect.side / 2) / height, zoom: crop.zoom };
}

/** Caller owns the decoded bitmap and must close it when the editor is dismissed. */
export async function decodeAvatarImage(file: File): Promise<ImageBitmap> {
	if (!file.type.startsWith("image/")) throw new TeamAvatarImageError("unsupported");
	if (file.size > MAX_TEAM_AVATAR_SOURCE_BYTES) throw new TeamAvatarImageError("tooLarge");
	try {
		const bitmap = await createImageBitmap(file);
		if (bitmap.width > 0 && bitmap.height > 0) return bitmap;
		bitmap.close();
		throw new Error("Empty image");
	} catch {
		throw new TeamAvatarImageError("invalid");
	}
}

export function avatarImageFromBitmap(bitmap: ImageBitmap, crop: AvatarCrop = DEFAULT_AVATAR_CROP): string {
	const canvas = document.createElement("canvas");
	canvas.width = AVATAR_PIXELS;
	canvas.height = AVATAR_PIXELS;
	const context = canvas.getContext("2d");
	if (!context) throw new TeamAvatarImageError("invalid");
	context.beginPath();
	context.arc(AVATAR_PIXELS / 2, AVATAR_PIXELS / 2, AVATAR_PIXELS / 2, 0, Math.PI * 2);
	context.closePath();
	context.clip();
	const rect = avatarCropRect(bitmap.width, bitmap.height, crop);
	context.imageSmoothingQuality = "high";
	context.drawImage(bitmap, rect.x, rect.y, rect.side, rect.side, 0, 0, AVATAR_PIXELS, AVATAR_PIXELS);
	return canvas.toDataURL("image/png");
}

/** Retains the centre-crop helper for callers without a crop editor. */
export async function fileToAvatarImage(file: File): Promise<string> {
	const bitmap = await decodeAvatarImage(file);
	try { return avatarImageFromBitmap(bitmap); }
	finally { bitmap.close(); }
}
