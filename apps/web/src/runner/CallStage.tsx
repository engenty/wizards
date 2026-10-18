import type { RunView } from "@engenty/wizards-shared/run";
import { Mic, MicOff, PhoneOff, SwitchCamera, Video, VideoOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Mascot } from "../brand";
import { t } from "../lib/i18n";
import { cn, Spinner } from "../ui";
import type { useLiveVoice } from "./live-voice";

/**
 * The call: the person and the engenty on the call, what either said, and the call's
 * controls. As a video call the two are tiles and the last lines are captions; as a live audio
 * conversation the engenty stands alone and the whole transcript scrolls under it, the camera
 * joining as a tile when it is switched on. Before joining it waits for the tap that lets the
 * browser ask for the microphone and the camera; the chat beside it is the screen the wizard
 * draws on.
 */

type Voice = ReturnType<typeof useLiveVoice>;

const isTouch = typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;

function Timer({ since }: { since: number | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!since) {
      return;
    }
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  if (!since) {
    return null;
  }
  const s = Math.max(0, Math.floor((now - since) / 1000));
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return (
    <span className="font-mono text-[0.8125rem] text-white/60 tabular-nums">
      {mm}:{ss}
    </span>
  );
}

function Control({
  label,
  on,
  danger,
  busy,
  onClick,
  children,
}: {
  label: string;
  on?: boolean;
  danger?: boolean;
  busy?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={on}
      disabled={busy}
      onClick={onClick}
      className={cn(
        "flex size-12 items-center justify-center rounded-full transition disabled:opacity-50",
        danger
          ? "bg-rose text-white hover:brightness-110"
          : on === false
            ? "bg-white text-neutral-900 hover:bg-white/90"
            : "bg-white/15 text-white hover:bg-white/25",
      )}
    >
      {busy ? <Spinner className="size-5" /> : children}
    </button>
  );
}

/** Everything said so far, the newest at the bottom and in view. */
function Transcript({ voice }: { voice: Voice }) {
  const end = useRef<HTMLDivElement>(null);
  const { captions } = voice;
  useEffect(() => {
    if (captions.length) {
      end.current?.scrollIntoView({ block: "end" });
    }
  }, [captions]);
  if (!captions.length) {
    return null;
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 sm:px-5">
      <ol className="mx-auto flex max-w-[720px] flex-col gap-2 py-2">
        {captions.map((c) => (
          <li
            key={c.id}
            className={cn(
              "text-[0.9375rem] leading-snug",
              c.who === "bot" ? "text-white/95" : "text-right text-white/50",
            )}
          >
            {c.text}
          </li>
        ))}
        <div ref={end} />
      </ol>
    </div>
  );
}

export function CallStage({
  voice,
  view,
  video,
  className,
}: {
  voice: Voice;
  view: RunView | null;
  /** A video call: the camera goes on with the call and the two are tiles. Else a live audio conversation. */
  video: boolean;
  className?: string;
}) {
  const live = voice.state === "live";
  const connecting = voice.state === "connecting";
  const [since, setSince] = useState<number | null>(null);
  const [left, setLeft] = useState(false);
  useEffect(() => {
    setSince(live ? Date.now() : null);
  }, [live]);
  const join = async () => {
    setLeft(false);
    await voice.start();
    if (video) {
      await voice.startCamera();
    }
  };
  const leave = () => {
    voice.stop();
    setLeft(true);
  };
  // The person's tile is there for a video call, and for an audio one once the camera is on.
  const tiles = video || voice.camera;
  const bot = [...voice.captions].reverse().find((c) => c.who === "bot");
  const me = [...voice.captions].reverse().find((c) => c.who === "me");
  const status = voice.speaking
    ? t("talk.speaking")
    : voice.listening
      ? t("talk.listening")
      : live
        ? t("talk.live")
        : connecting
          ? t("talk.connecting")
          : left
            ? t("video.ended")
            : "";
  return (
    <section
      className={cn(
        "relative flex min-h-0 flex-col bg-neutral-950 text-white",
        "safe-top",
        className,
      )}
    >
      {/* Who is on the call, and for how long. */}
      <div className="flex h-14 shrink-0 items-center gap-3 px-4 sm:px-5">
        <div className="min-w-0 flex-1 truncate font-display font-semibold text-[1rem] tracking-tight">
          {view?.wizard.title ?? ""}
        </div>
        {status ? (
          <span className="flex items-center gap-1.5 text-[0.8125rem] text-white/70">
            {live ? (
              <span
                className={cn(
                  "size-2 rounded-full",
                  voice.speaking ? "animate-pulse-dot bg-emerald-400" : "bg-rose",
                )}
              />
            ) : null}
            {status}
          </span>
        ) : null}
        <Timer since={since} />
      </div>

      {/* The two on the call; alone, the engenty. */}
      <div
        className={cn(
          "grid min-h-0 gap-2 px-3 pb-2 sm:px-4",
          tiles ? "flex-1 grid-cols-1 sm:grid-cols-2" : "shrink-0 grid-cols-1",
          !tiles && live && voice.captions.length ? "h-[38%]" : !tiles ? "flex-1" : "",
        )}
      >
        <div
          className={cn(
            "relative min-h-0 overflow-hidden rounded-2xl bg-neutral-900",
            !tiles && "hidden",
          )}
        >
          <video
            ref={voice.video}
            muted
            playsInline
            autoPlay
            className={cn(
              "absolute inset-0 h-full w-full object-cover",
              voice.facing === "user" && "-scale-x-100",
              voice.camera ? "block" : "hidden",
            )}
          />
          {!voice.camera ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-white/50">
              <VideoOff className="size-8" />
              <span className="text-[0.8125rem]">{t("video.cameraOff")}</span>
            </div>
          ) : null}
          <span className="absolute bottom-2 left-3 rounded-md bg-black/50 px-2 py-0.5 text-[0.75rem]">
            {t("video.you")}
            {voice.muted ? <MicOff className="ml-1.5 inline size-3" /> : null}
          </span>
        </div>
        <div
          className={cn(
            "relative flex min-h-0 items-center justify-center overflow-hidden rounded-2xl transition-shadow",
            tiles ? "bg-neutral-900" : "bg-transparent",
            tiles && voice.speaking && "ring-2 ring-emerald-400/70",
          )}
        >
          {/* Alone, the engenty breathes while it speaks and glows while it listens. */}
          <div
            className={cn(
              "rounded-full transition-shadow duration-500",
              !tiles && voice.listening && "shadow-[0_0_80px_20px_rgba(244,63,94,0.25)]",
              !tiles && voice.speaking && "shadow-[0_0_80px_20px_rgba(52,211,153,0.3)]",
              voice.speaking && "animate-breathe",
            )}
          >
            <Mascot
              kind={view?.wizard.avatar ?? "round"}
              size={tiles ? 140 : 200}
              fluffy
              interactive={false}
            />
          </div>
          {tiles ? (
            <span className="absolute bottom-2 left-3 max-w-[85%] truncate rounded-md bg-black/50 px-2 py-0.5 text-[0.75rem]">
              {view?.wizard.title ?? ""}
            </span>
          ) : null}
        </div>
      </div>

      {/* What was said: the whole transcript under the engenty, the last lines under the tiles. */}
      {live && !tiles ? (
        <Transcript voice={voice} />
      ) : live && (bot || me) ? (
        <div className="shrink-0 px-4 pb-2 sm:px-5">
          <div className="mx-auto max-w-[720px] space-y-1 text-center">
            {me ? <p className="line-clamp-1 text-[0.8125rem] text-white/50">{me.text}</p> : null}
            {bot ? (
              <p className="line-clamp-3 text-[0.9375rem] text-white/95 leading-snug">{bot.text}</p>
            ) : null}
          </div>
        </div>
      ) : null}

      {voice.error ? (
        <p className="shrink-0 px-5 pb-2 text-center text-[0.8125rem] text-rose">{voice.error}</p>
      ) : null}

      {/* The call's controls; before the call, the way in. */}
      <div className="flex shrink-0 items-center justify-center gap-3 px-4 pt-1 pb-4">
        {live ? (
          <>
            <Control
              label={t(voice.muted ? "video.unmute" : "video.mute")}
              on={!voice.muted}
              onClick={voice.toggleMute}
            >
              {voice.muted ? <MicOff className="size-5" /> : <Mic className="size-5" />}
            </Control>
            <Control
              label={t(voice.camera ? "talk.cameraOff" : "talk.camera")}
              on={voice.camera}
              onClick={() => (voice.camera ? voice.stopCamera() : void voice.startCamera())}
            >
              {voice.camera ? <Video className="size-5" /> : <VideoOff className="size-5" />}
            </Control>
            {voice.camera && isTouch ? (
              <Control label={t("video.flip")} onClick={() => void voice.flipCamera()}>
                <SwitchCamera className="size-5" />
              </Control>
            ) : null}
            <Control label={t("video.leave")} danger onClick={leave}>
              <PhoneOff className="size-5" />
            </Control>
          </>
        ) : (
          <div className="flex flex-col items-center gap-2">
            <button
              type="button"
              disabled={connecting || !view?.talk}
              onClick={() => void join()}
              className="flex h-12 items-center gap-2 rounded-full bg-emerald-500 px-6 font-medium text-[0.9375rem] text-white transition hover:brightness-110 disabled:opacity-50"
            >
              {connecting ? (
                <Spinner className="size-4" />
              ) : video ? (
                <Video className="size-5" />
              ) : (
                <Mic className="size-5" />
              )}
              {t(left ? "video.rejoin" : video ? "video.join" : "talk.start")}
            </button>
            {!left && !voice.error ? (
              <p className="max-w-sm text-center text-[0.75rem] text-white/50">
                {t(video ? "video.hint" : "talk.joinHint")}
              </p>
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}
