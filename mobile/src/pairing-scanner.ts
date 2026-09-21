import { Capacitor } from "@capacitor/core";
import { parseLanPairing, type LanPairingPayload } from "../../src/shared/lan-pairing";

export async function scanPairingCode(): Promise<LanPairingPayload | null> {
	if (!Capacitor.isNativePlatform()) throw new Error("请在 手机 APP 中使用扫码配对，开发预览可使用手动配置");
	let text: string;
	try {
		const { CapacitorBarcodeScanner, CapacitorBarcodeScannerTypeHint, CapacitorBarcodeScannerCameraDirection, CapacitorBarcodeScannerAndroidScanningLibrary } = await import("@capacitor/barcode-scanner");
		const result = await CapacitorBarcodeScanner.scanBarcode({
			hint: CapacitorBarcodeScannerTypeHint.QR_CODE,
			cameraDirection: CapacitorBarcodeScannerCameraDirection.BACK,
			scanInstructions: "对准电脑「设置 → 手机连接」中的二维码",
			cancelButtonAccessibilityLabel: "取消扫码",
			torchButtonOnAccessibilityLabel: "关闭闪光灯",
			torchButtonOffAccessibilityLabel: "开启闪光灯",
			// Decode locally; no Google Play Services or online scanner module is required.
			android: { scanningLibrary: CapacitorBarcodeScannerAndroidScanningLibrary.ZXING },
		});
		text = result.ScanResult;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (/cancel|取消/i.test(message)) return null;
		if (/permission|denied|camera.*access/i.test(message)) throw new Error("无法使用相机，请在系统设置中允许相机权限，或选择手动配置");
		throw new Error("无法启动扫码，请检查相机权限后重试，或选择手动配置");
	}
	return text ? parseLanPairing(text) : null;
}
