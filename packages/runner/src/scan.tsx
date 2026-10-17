import { ImageUp } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  CameraStage,
  type Facing,
  MediaSheet,
  SheetAction,
  SheetBar,
  useCameraStream,
} from "./camera";
import { appCall, appCan } from "./env.js";
import { t } from "./i18n.js";

type Detect = (source: HTMLVideoElement | ImageBitmap) => Promise<string | null>;

interface Reader {
  detect: Detect;
  /** The fallback reads QR codes only; the browser's own detector also reads barcodes. */
  qrOnly: boolean;
}

interface NativeDetector {
  detect(source: ImageBitmapSource): Promise<{ rawValue: string }[]>;
}
interface NativeDetectorClass {
  new (options?: { formats: string[] }): NativeDetector;
  getSupportedFormats(): Promise<string[]>;
}

let reader: Promise<Reader> | null = null;

/**
 * The browser's BarcodeDetector where it exists (Chrome on Android and macOS); elsewhere — iOS,
 * Firefox, Chrome on Windows — a small QR decoder that is only downloaded when first needed.
 */
function codeReader(): Promise<Reader> {
  reader ??= (async () => {
    const Native = (window as unknown as { BarcodeDetector?: NativeDetectorClass }).BarcodeDetector;
    if (Native) {
      try {
        const formats = await Native.getSupportedFormats();
        if (formats.includes("qr_code")) {
          const detector = new Native({ formats });
          return {
            qrOnly: false,
            detect: async (source) => (await detector.detect(source))[0]?.rawValue || null,
          };
        }
      } catch {
        // falls through to the decoder
      }
    }
    const { default: QrScanner } = await import("qr-scanner");
    const engine = QrScanner.createQrEngine();
    return {
      qrOnly: true,
      detect: async (source) => {
        try {
          const found = await QrScanner.scanImage(source, {
            qrEngine: engine,
            returnDetailedScanResult: true,
          });
          return found.data || null;
        } catch {
          return null;
        }
      },
    };
  })();
  return reader;
}

interface ScanProps {
  open: boolean;
  onClose: () => void;
  onResult: (text: string) => void;
}

/** In the mobile app its own scanner reads every common barcode; the page draws nothing. */
function AppScan({ open, onClose, onResult }: ScanProps) {
  const found = useRef(onResult);
  found.current = onResult;
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) {
      return;
    }
    void appCall<string | null>("scan")
      .then((text) => {
        if (text) {
          found.current(text);
        }
      })
      .catch(() => undefined)
      .finally(() => close.current());
  }, [open]);
  return null;
}

/** Reads a QR code or barcode with the camera — or from a photo, when there is no camera. */
export function ScanDialog(props: ScanProps) {
  return appCan("scan") ? <AppScan {...props} /> : <WebScan {...props} />;
}

function WebScan({ open, onClose, onResult }: ScanProps) {
  const [facing, setFacing] = useState<Facing>("environment");
  const [qrOnly, setQrOnly] = useState(false);
  const [miss, setMiss] = useState(false);
  const photo = useRef<HTMLInputElement>(null);
  const camera = useCameraStream(open, facing);
  const found = useRef(onResult);
  found.current = onResult;
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (!open) {
      return;
    }
    setMiss(false);
    void codeReader().then((r) => setQrOnly(r.qrOnly));
  }, [open]);

  useEffect(() => {
    if (!open || !camera.stream) {
      return;
    }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const el = camera.video.current;
      if (!stopped && el && el.readyState >= 2 && el.videoWidth) {
        const text = await (await codeReader()).detect(el).catch(() => null);
        if (text && !stopped) {
          navigator.vibrate?.(60);
          found.current(text);
          close.current();
          return;
        }
      }
      if (!stopped) {
        timer = setTimeout(tick, 200);
      }
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [open, camera.stream, camera.video]);

  const fromPhoto = async (file: File | undefined) => {
    if (!file) {
      return;
    }
    setMiss(false);
    const bitmap = await createImageBitmap(file).catch(() => null);
    const text = bitmap ? await (await codeReader()).detect(bitmap).catch(() => null) : null;
    if (text) {
      onResult(text);
      onClose();
    } else {
      setMiss(true);
    }
  };

  return (
    <MediaSheet open={open} onClose={onClose} label={t("scan.title")}>
      <SheetBar
        title={t("scan.title")}
        onClose={onClose}
        camera={camera}
        onFlip={() => setFacing((f) => (f === "environment" ? "user" : "environment"))}
      />
      <CameraStage
        camera={camera}
        asking={t("scan.asking")}
        actions={
          <div className="flex flex-col gap-2">
            <SheetAction onClick={() => photo.current?.click()}>
              <ImageUp className="size-4" /> {t("scan.fromPhoto")}
            </SheetAction>
            <SheetAction quiet onClick={onClose}>
              {t("scan.typeInstead")}
            </SheetAction>
          </div>
        }
      >
        {/* The frame the code goes into. */}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="aspect-square w-[min(68%,320px)] rounded-3xl border-2 border-white/90 shadow-[0_0_0_100vmax_rgb(0_0_0/0.35)]" />
        </div>
      </CameraStage>
      <div className="safe-bottom flex flex-col items-center gap-3 px-5 pt-3 text-center">
        <p className="text-[0.8125rem] text-white/75 leading-snug">
          {miss ? t("scan.miss") : qrOnly ? t("scan.hintQr") : t("scan.hint")}
        </p>
        {camera.stream ? (
          <SheetAction quiet onClick={() => photo.current?.click()}>
            <ImageUp className="size-4" /> {t("scan.fromPhoto")}
          </SheetAction>
        ) : null}
      </div>
      <input
        ref={photo}
        type="file"
        hidden
        accept="image/*"
        onChange={(e) => {
          void fromPhoto(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </MediaSheet>
  );
}
