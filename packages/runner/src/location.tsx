import { isLocationValue, type LocationValue } from "@engenty-wizards/shared/definition";
import { ExternalLink, LocateFixed, MapPin, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, runBase } from "./env.js";
import { lang, t } from "./i18n.js";
import { Button, IconButton, Input } from "./ui.js";

/** Good enough for an address; the device keeps refining until then or until it has tried long enough. */
const GOOD_METRES = 25;
const REFINE_MS = 9000;

type Trouble = "denied" | "unavailable" | "timeout";

function trouble(err: GeolocationPositionError): Trouble {
  return err.code === err.PERMISSION_DENIED
    ? "denied"
    : err.code === err.TIMEOUT
      ? "timeout"
      : "unavailable";
}

/**
 * Where the person is: the device's position on their tap, with how exact it is, and an address
 * line they can correct — or type alone, when the device gives no position.
 */
export function LocationField({
  value,
  runId,
  placeholder,
  onChange,
  onBusy,
}: {
  value: unknown;
  runId: string;
  placeholder?: string;
  onChange: (v: LocationValue | undefined) => void;
  onBusy?: (busy: boolean) => void;
}) {
  const place = isLocationValue(value) ? value : null;
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState<Trouble | null>(null);
  const watch = useRef<number | null>(null);
  // The address line is the server's suggestion until the person types in it.
  const typed = useRef(Boolean(place?.label));
  const latest = useRef(place);
  latest.current = place;
  const hasPoint = place?.lat !== undefined && place.lng !== undefined;
  const supported = typeof navigator !== "undefined" && "geolocation" in navigator;

  const stop = () => {
    if (watch.current !== null) {
      navigator.geolocation.clearWatch(watch.current);
      watch.current = null;
    }
    setLocating(false);
    onBusy?.(false);
  };
  useEffect(
    () => () => {
      if (watch.current !== null) {
        navigator.geolocation.clearWatch(watch.current);
      }
    },
    [],
  );

  const name = async (lat: number, lng: number) => {
    try {
      const { label } = await api.post<{ label: string | null }>(`${runBase(runId)}/geocode`, {
        lat,
        lng,
        language: lang,
      });
      const now = latest.current;
      if (label && !typed.current && now?.lat === lat && now.lng === lng) {
        onChange({ ...now, label });
      }
    } catch {
      // the coordinates stand on their own
    }
  };

  const locate = () => {
    setError(null);
    setLocating(true);
    onBusy?.(true);
    const started = Date.now();
    let best = Number.POSITIVE_INFINITY;
    watch.current = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude, accuracy } = pos.coords;
        if (accuracy < best) {
          best = accuracy;
          const lat = Math.round(latitude * 1e6) / 1e6;
          const lng = Math.round(longitude * 1e6) / 1e6;
          const label = typed.current ? latest.current?.label : undefined;
          const next = { lat, lng, accuracy: Math.round(accuracy), ...(label ? { label } : {}) };
          latest.current = next;
          onChange(next);
        }
        if (best <= GOOD_METRES || Date.now() - started > REFINE_MS) {
          stop();
          const now = latest.current;
          if (now?.lat !== undefined && now.lng !== undefined) {
            void name(now.lat, now.lng);
          }
        }
      },
      (err) => {
        stop();
        // A fix already taken stays; only a first try that fails is reported.
        if (best === Number.POSITIVE_INFINITY) {
          setError(trouble(err));
        }
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 10_000 },
    );
  };

  const setLabel = (label: string) => {
    typed.current = label.trim().length > 0;
    const next = { ...(hasPoint ? place : {}), label };
    onChange(hasPoint || label.trim() ? next : undefined);
  };

  return (
    <div className="flex flex-col gap-3">
      {hasPoint ? (
        <div className="flex items-center gap-3 rounded-xl bg-card p-3 ring-1 ring-input">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-moss-tint text-moss">
            <MapPin className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium text-[0.9375rem] tabular-nums">
              {place.lat?.toFixed(5)}, {place.lng?.toFixed(5)}
            </div>
            <div className="flex flex-wrap items-center gap-x-3 text-[0.8125rem] text-ink-3">
              <span>
                {locating
                  ? t("location.refining")
                  : place.accuracy
                    ? t("location.accuracy", { m: place.accuracy })
                    : null}
              </span>
              <a
                href={`https://www.openstreetmap.org/?mlat=${place.lat}&mlon=${place.lng}#map=17/${place.lat}/${place.lng}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 underline-offset-2 hover:text-ink hover:underline coarse:-my-3 coarse:min-h-11 coarse:min-w-11"
              >
                {t("location.map")} <ExternalLink className="size-3" />
              </a>
            </div>
          </div>
          <IconButton
            label={t("location.remove")}
            onClick={() => {
              stop();
              typed.current = false;
              onChange(undefined);
            }}
          >
            <X className="size-4" />
          </IconButton>
        </div>
      ) : supported ? (
        <div>
          <Button
            variant="secondary"
            size="lg"
            busy={locating}
            onClick={locate}
            className="w-full sm:w-auto"
          >
            {locating ? null : <LocateFixed className="size-4" />}
            {locating ? t("location.locating") : t("location.use")}
          </Button>
          {error ? (
            <p className="mt-2 rounded-lg bg-amber-tint px-3 py-2 text-[0.8125rem] text-ink-2 leading-relaxed">
              {t(`location.${error}` as "location.denied")}
            </p>
          ) : (
            <p className="mt-2 text-[0.8125rem] text-ink-3 leading-relaxed">{t("location.why")}</p>
          )}
        </div>
      ) : null}
      <Input
        value={place?.label ?? ""}
        placeholder={placeholder ?? t(hasPoint ? "location.label" : "location.manual")}
        autoComplete="street-address"
        enterKeyHint="done"
        aria-label={t("location.manual")}
        onChange={(e) => setLabel(e.target.value)}
      />
    </div>
  );
}
