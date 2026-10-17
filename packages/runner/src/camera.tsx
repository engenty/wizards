import { Camera, Check, Flashlight, FlashlightOff, SwitchCamera, Video, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { isTouch } from "./device";
import { t } from "./i18n.js";
import { cn, Spinner } from "./ui.js";

/**
 * A photo as small as a reader needs it: phone pictures are several megabytes, which is slow to
 * upload and more than a vision model takes.
 */
export async function shrinkImage(file: File, max = 2400): Promise<File> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < 1_200_000) {
    return file;
  }
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.86));
    return blob && blob.size < file.size
      ? new File([blob], `${file.name.replace(/\.[^.]+$/, "")}.jpg`, { type: "image/jpeg" })
      : file;
  } catch {
    return file;
  }
}

export function stamp(): string {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
}

export type Facing = "environment" | "user";
/** Why there is no picture: the person (or the browser) said no, there is no camera, or it is in use. */
export type CameraError = "denied" | "missing" | "busy";

function cameraError(err: unknown): CameraError {
  const name = (err as DOMException)?.name;
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "missing";
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return "busy";
  }
  return "denied";
}

/** The phone's light, where the camera track has one (Chrome on Android). */
function hasTorch(track: MediaStreamTrack | undefined): boolean {
  const capabilities = track?.getCapabilities?.() as { torch?: boolean } | undefined;
  return Boolean(capabilities?.torch);
}

/**
 * The device's camera as a live picture, for as long as `active`. The browser asks for the
 * camera when this starts — callers open it from the person's tap. With `audio` the microphone
 * is asked for too; a refused microphone still gives a silent picture.
 */
export function useCameraStream(active: boolean, facing: Facing, audio = false) {
  const video = useRef<HTMLVideoElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<CameraError | null>(null);
  const [cameras, setCameras] = useState(1);
  const [torchable, setTorchable] = useState(false);
  const [torch, setTorchOn] = useState(false);

  useEffect(() => {
    if (!active) {
      return;
    }
    let live: MediaStream | null = null;
    let stopped = false;
    setError(null);
    setStream(null);
    setTorchable(false);
    setTorchOn(false);
    const picture = {
      facingMode: { ideal: facing },
      width: { ideal: 2560 },
      height: { ideal: 1440 },
    };
    const start = async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new DOMException("no camera api", "NotAllowedError");
      }
      try {
        live = await navigator.mediaDevices.getUserMedia({ video: picture, audio });
      } catch (err) {
        if (!audio) {
          throw err;
        }
        live = await navigator.mediaDevices.getUserMedia({ video: picture });
      }
      if (stopped) {
        for (const track of live.getTracks()) {
          track.stop();
        }
        return;
      }
      setStream(live);
      const track = live.getVideoTracks()[0];
      // Phones report the torch a moment after the picture starts.
      const readTorch = () => !stopped && setTorchable(hasTorch(track));
      readTorch();
      setTimeout(readTorch, 600);
      const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
      if (!stopped) {
        setCameras(devices.filter((d) => d.kind === "videoinput").length);
      }
    };
    start().catch((err) => !stopped && setError(cameraError(err)));
    return () => {
      stopped = true;
      for (const track of live?.getTracks() ?? []) {
        track.stop();
      }
    };
  }, [active, facing, audio]);

  useEffect(() => {
    if (video.current && stream) {
      video.current.srcObject = stream;
    }
  }, [stream]);

  const setTorch = async (on: boolean) => {
    const track = stream?.getVideoTracks()[0];
    try {
      await track?.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] });
      setTorchOn(on);
    } catch {
      setTorchable(false);
    }
  };
  const mirrored = stream?.getVideoTracks()[0]?.getSettings().facingMode === "user";
  return { video, stream, error, cameras, torchable, torch, setTorch, mirrored };
}

/** The camera or the scanner: the whole screen on a phone, a centred sheet on a desk. */
export function MediaSheet({
  open,
  onClose,
  label,
  children,
}: {
  open: boolean;
  onClose: () => void;
  label: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    if (open && !el.open) {
      el.showModal();
    } else if (!open && el.open) {
      el.close();
    }
  }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} aria-label={label} className="media-sheet">
      {open ? <div className="flex h-full flex-col">{children}</div> : null}
    </dialog>
  );
}

export function SheetButton({
  label,
  onClick,
  active,
  children,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex size-11 shrink-0 items-center justify-center rounded-full transition",
        active ? "bg-white text-black" : "bg-white/12 text-white hover:bg-white/20",
      )}
    >
      {children}
    </button>
  );
}

/** The top row of a media sheet: close, what this is, and the camera's switches. */
export function SheetBar({
  title,
  onClose,
  camera,
  onFlip,
}: {
  title: string;
  onClose: () => void;
  camera: ReturnType<typeof useCameraStream>;
  onFlip: () => void;
}) {
  return (
    <div className="safe-top">
      <div className="flex items-center gap-2 px-3 py-2">
        <SheetButton label={t("common.close")} onClick={onClose}>
          <X className="size-5" />
        </SheetButton>
        <div className="min-w-0 flex-1 truncate text-center font-medium text-[0.9375rem]">
          {title}
        </div>
        {camera.torchable ? (
          <SheetButton
            label={t("camera.torch")}
            active={camera.torch}
            onClick={() => void camera.setTorch(!camera.torch)}
          >
            {camera.torch ? (
              <Flashlight className="size-5" />
            ) : (
              <FlashlightOff className="size-5" />
            )}
          </SheetButton>
        ) : null}
        {camera.stream && (camera.cameras > 1 || isTouch) ? (
          <SheetButton label={t("camera.flip")} onClick={onFlip}>
            <SwitchCamera className="size-5" />
          </SheetButton>
        ) : (
          <span className="size-11" />
        )}
      </div>
    </div>
  );
}

/** The live picture with what to say while there is none: the browser is asking, or it said no. */
export function CameraStage({
  camera,
  asking,
  children,
  actions,
}: {
  camera: ReturnType<typeof useCameraStream>;
  /** One sentence shown while the browser asks for the camera. */
  asking: string;
  children?: ReactNode;
  /** Ways on when there is no camera. */
  actions?: ReactNode;
}) {
  return (
    <div className="relative min-h-0 flex-1 overflow-hidden">
      <video
        ref={camera.video}
        autoPlay
        playsInline
        muted
        className={cn(
          "absolute inset-0 size-full object-contain",
          camera.mirrored && "-scale-x-100",
        )}
      />
      {camera.error ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 bg-black px-8 text-center">
          <p className="max-w-sm text-[0.9375rem] text-white/85 leading-relaxed">
            {t(`camera.${camera.error}` as "camera.denied")}
          </p>
          {actions}
        </div>
      ) : camera.stream ? (
        children
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-8 text-center text-white/75">
          <Spinner />
          <p className="max-w-xs text-[0.875rem] leading-relaxed">{asking}</p>
        </div>
      )}
    </div>
  );
}

const CLIP_SECONDS = 30;

function clipType(): string | undefined {
  if (typeof MediaRecorder === "undefined") {
    return undefined;
  }
  // MP4 plays everywhere a clip may later be opened; WebM is what older Chrome and Firefox record.
  return [
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ].find((type) => MediaRecorder.isTypeSupported(type));
}

/** Whether this browser can record a clip itself; otherwise the phone's camera app does it. */
export const canRecordClips = Boolean(clipType());

/**
 * Takes pictures with the device's camera: one, or several in a row (the pages of a document),
 * and short clips when the field takes video. Front and back camera, and the torch where the
 * device has one.
 */
export function CameraDialog({
  open,
  multiple,
  video: allowVideo,
  onClose,
  onCapture,
  onNative,
}: {
  open: boolean;
  multiple: boolean;
  /** Also record clips of up to half a minute. */
  video?: boolean;
  onClose: () => void;
  onCapture: (file: File) => Promise<void> | void;
  /** Opens the phone's own camera app instead — the way on when the browser has no camera for us. */
  onNative?: () => void;
}) {
  const [facing, setFacing] = useState<Facing>("environment");
  const [mode, setMode] = useState<"photo" | "video">("photo");
  const [taken, setTaken] = useState(0);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState<number | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const camera = useCameraStream(open, facing, mode === "video");

  useEffect(() => {
    if (open) {
      setTaken(0);
      setMode("photo");
      setRecording(null);
    }
  }, [open]);

  const deliver = async (file: File) => {
    setBusy(true);
    try {
      await onCapture(file);
      setTaken((n) => n + 1);
      if (!multiple) {
        onClose();
      }
    } finally {
      setBusy(false);
    }
  };

  const shoot = async () => {
    const el = camera.video.current;
    if (!el?.videoWidth) {
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = el.videoWidth;
    canvas.height = el.videoHeight;
    canvas.getContext("2d")?.drawImage(el, 0, 0);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.9));
    if (blob) {
      await deliver(new File([blob], `foto-${stamp()}.jpg`, { type: "image/jpeg" }));
    }
  };

  const stopClip = () => {
    if (recorder.current?.state === "recording") {
      recorder.current.stop();
    }
  };
  const startClip = () => {
    const type = clipType();
    if (!camera.stream || !type) {
      return;
    }
    const chunks: Blob[] = [];
    const rec = new MediaRecorder(camera.stream, {
      mimeType: type,
      videoBitsPerSecond: 2_500_000,
      audioBitsPerSecond: 96_000,
    });
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      setRecording(null);
      recorder.current = null;
      const mime = type.split(";")[0];
      if (chunks.length) {
        const ext = mime === "video/mp4" ? "mp4" : "webm";
        void deliver(new File(chunks, `video-${stamp()}.${ext}`, { type: mime }));
      }
    };
    recorder.current = rec;
    rec.start(1000);
    setRecording(0);
  };
  // The clock of a running clip; it ends by itself at the limit.
  useEffect(() => {
    if (recording === null) {
      return;
    }
    if (recording >= CLIP_SECONDS) {
      if (recorder.current?.state === "recording") {
        recorder.current.stop();
      }
      return;
    }
    const id = setTimeout(() => setRecording((s) => (s === null ? null : s + 1)), 1000);
    return () => clearTimeout(id);
  }, [recording]);
  // Closing the sheet mid-clip keeps nothing.
  useEffect(() => {
    if (!open && recorder.current) {
      recorder.current.onstop = null;
      recorder.current.stop();
      recorder.current = null;
    }
  }, [open]);

  const clock = (s: number) => `0:${String(s).padStart(2, "0")}`;
  return (
    <MediaSheet open={open} onClose={onClose} label={t("camera.title")}>
      <SheetBar
        title={
          recording !== null
            ? `${clock(recording)} / ${clock(CLIP_SECONDS)}`
            : taken
              ? t("camera.taken", { n: taken })
              : t("camera.title")
        }
        onClose={onClose}
        camera={camera}
        onFlip={() => setFacing((f) => (f === "environment" ? "user" : "environment"))}
      />
      <CameraStage
        camera={camera}
        asking={t("camera.asking")}
        actions={
          <div className="flex flex-col gap-2">
            {onNative ? (
              <SheetAction
                onClick={() => {
                  onClose();
                  onNative();
                }}
              >
                <Camera className="size-4" /> {t(isTouch ? "camera.native" : "camera.pick")}
              </SheetAction>
            ) : null}
            <SheetAction quiet onClick={onClose}>
              {t("common.close")}
            </SheetAction>
          </div>
        }
      />
      <div className={cn("safe-bottom px-4 pt-3", camera.error && "invisible")}>
        {allowVideo && canRecordClips && recording === null ? (
          <div className="mb-3 flex justify-center gap-1 text-[0.8125rem]">
            {(["photo", "video"] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                onClick={() => setMode(m)}
                className={cn(
                  "h-9 rounded-full px-4 font-medium transition",
                  mode === m ? "bg-white text-black" : "text-white/70 hover:text-white",
                )}
              >
                {t(m === "photo" ? "camera.photo" : "camera.video")}
              </button>
            ))}
          </div>
        ) : null}
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
          <span className="text-[0.8125rem] text-white/70 leading-snug">
            {recording !== null
              ? t("camera.recording")
              : mode === "video"
                ? t("camera.clipHint", { s: CLIP_SECONDS })
                : multiple
                  ? t("camera.hintMany")
                  : t("camera.hint")}
          </span>
          <button
            type="button"
            aria-label={
              mode === "photo"
                ? t("camera.shoot")
                : recording === null
                  ? t("camera.record")
                  : t("camera.stop")
            }
            disabled={!camera.stream || busy}
            onClick={() =>
              mode === "photo" ? void shoot() : recording === null ? startClip() : stopClip()
            }
            className="flex size-[72px] items-center justify-center rounded-full border-4 border-white transition active:scale-95 disabled:opacity-40"
          >
            {busy ? (
              <Spinner className="text-white" />
            ) : mode === "photo" ? (
              <span className="size-[54px] rounded-full bg-white" />
            ) : recording === null ? (
              <span className="flex size-[54px] items-center justify-center rounded-full bg-[#e5484d]">
                <Video className="size-6 text-white" />
              </span>
            ) : (
              <span className="size-7 rounded-md bg-[#e5484d]" />
            )}
          </button>
          <div className="flex justify-end">
            {multiple && taken && recording === null ? (
              <SheetAction onClick={onClose}>
                <Check className="size-4" /> {t("camera.done")}
              </SheetAction>
            ) : null}
          </div>
        </div>
      </div>
    </MediaSheet>
  );
}

export function SheetAction({
  onClick,
  quiet,
  children,
}: {
  onClick: () => void;
  quiet?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex h-11 items-center justify-center gap-2 rounded-full px-5 font-medium text-[0.875rem] transition",
        quiet ? "text-white/75 hover:text-white" : "bg-white text-black hover:bg-white/90",
      )}
    >
      {children}
    </button>
  );
}
