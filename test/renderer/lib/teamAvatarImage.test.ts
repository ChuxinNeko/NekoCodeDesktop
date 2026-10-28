import { describe, expect, test } from "bun:test";
import { avatarCropRect, DEFAULT_AVATAR_CROP, decodeAvatarImage, MAX_TEAM_AVATAR_SOURCE_BYTES, moveAvatarCrop } from "../../../src/renderer/src/lib/teamAvatarImage";

describe("avatar crop geometry", () => {
 test("starts with an undistorted centre crop for landscape and portrait images", () => {
  expect(avatarCropRect(1200, 800, DEFAULT_AVATAR_CROP)).toEqual({ x: 200, y: 0, side: 800 });
  expect(avatarCropRect(800, 1200, DEFAULT_AVATAR_CROP)).toEqual({ x: 0, y: 200, side: 800 });
 });
 test("zoom preserves the chosen centre and clamps to the supported range", () => {
  expect(avatarCropRect(1200, 800, { x: 0.5, y: 0.5, zoom: 2 })).toEqual({ x: 400, y: 200, side: 400 });
  expect(avatarCropRect(1200, 800, { ...DEFAULT_AVATAR_CROP, zoom: 0 })).toEqual({ x: 200, y: 0, side: 800 });
  expect(avatarCropRect(1200, 800, { ...DEFAULT_AVATAR_CROP, zoom: 10 }).side).toBe(200);
 });
 test("drag uses the displayed viewport scale and moves opposite to the source crop", () => {
  const moved = moveAvatarCrop(1200, 800, DEFAULT_AVATAR_CROP, 35, 0, 280);
  expect(avatarCropRect(1200, 800, moved)).toEqual({ x: 100, y: 0, side: 800 });
 });
 test("dragging far beyond an edge never exports blank space, and can move back immediately", () => {
  const edge = moveAvatarCrop(1200, 800, DEFAULT_AVATAR_CROP, 10000, 10000, 280);
  expect(avatarCropRect(1200, 800, edge)).toEqual({ x: 0, y: 0, side: 800 });
  expect(avatarCropRect(1200, 800, moveAvatarCrop(1200, 800, edge, -35, 0, 280)).x).toBe(100);
  for (const [width,height] of [[1200,800],[800,1200],[800,800]]) for (const zoom of [1,2,4]) {
   const moved=moveAvatarCrop(width,height,{...DEFAULT_AVATAR_CROP,zoom},-10000,-10000,280);
   const rect=avatarCropRect(width,height,moved);
   expect(rect.x).toBeGreaterThanOrEqual(0);expect(rect.y).toBeGreaterThanOrEqual(0);
   expect(rect.x+rect.side).toBeLessThanOrEqual(width);expect(rect.y+rect.side).toBeLessThanOrEqual(height);
  }
 });
});
describe("avatar upload validation", () => {
 test("rejects non-images before attempting to decode them", async () => {
  await expect(decodeAvatarImage(new File(["hello"], "notes.txt", {type:"text/plain"}))).rejects.toMatchObject({code:"unsupported"});
 });
 test("rejects oversized uploads before decoding", async () => {
  const file=new File([new Uint8Array(MAX_TEAM_AVATAR_SOURCE_BYTES+1)],"large.png",{type:"image/png"});
  await expect(decodeAvatarImage(file)).rejects.toMatchObject({code:"tooLarge"});
 });
});
